-- pgTAP tests for get_cycle_status: its seven-column aggregate shape, the
-- counts, every cycle status, removed members and deleted users, who may call
-- it, its hardening, and that it adds no table access.
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension and the cycle_status_test helper schema. The seed user
-- is never used as a fixture.
--
-- Fixtures: owner and facilitator A, members B, D, and E, non-member C.
-- Project P is owned by A with B, D, and E joined; project Q is owned by C,
-- and none of A, B, D, or E is ever in Q.
--
-- Cycles: P0 (P, closed early from collecting), P1 (P, the main cycle taken
-- through every status), and Q1 (Q). Cards are created through create_card as
-- each user. Statuses are reached as postgres through #10's allowed
-- transitions; #14 will set revealed_at through start_retrospective.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(172);

-- ---------------------------------------------------------------------------
-- Test-only helpers. All are security invoker: they run as the calling role
-- (authenticated) and switch only the JWT claims, so every get_cycle_status,
-- get_my_cards, and card RPC call goes through the same grants as a client.
-- ---------------------------------------------------------------------------
create schema cycle_status_test;

create table cycle_status_test.ids (label text primary key, id uuid not null);
create table cycle_status_test.snaps (label text primary key, row_json jsonb not null);

insert into cycle_status_test.ids (label, id)
values
  ('A', '13000000-0000-4000-8000-000000000001'),
  ('B', '13000000-0000-4000-8000-000000000002'),
  ('C', '13000000-0000-4000-8000-000000000003'),
  ('D', '13000000-0000-4000-8000-000000000004'),
  ('E', '13000000-0000-4000-8000-000000000005'),
  ('P', '23000000-0000-4000-8000-000000000001'),
  ('Q', '23000000-0000-4000-8000-000000000002'),
  ('P0', '33000000-0000-4000-8000-000000000001'),
  ('P1', '33000000-0000-4000-8000-000000000002'),
  ('Q1', '33000000-0000-4000-8000-000000000003');

-- The id stored under a label (a user, project, cycle, or card).
create function cycle_status_test.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from cycle_status_test.ids i where i.label = p_label;
$$;

-- Signs in as the labelled user, or with no sub when the label is null.
create function cycle_status_test.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', cycle_status_test.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- The caller's single status row as jsonb (fails unless exactly one row).
create function cycle_status_test.st(p_user text, p_cycle uuid)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform cycle_status_test.become(p_user);
  select to_jsonb(s) into strict result from public.get_cycle_status(p_cycle) s;
  return result;
end;
$$;

-- The number of rows get_cycle_status returns to the caller.
create function cycle_status_test.row_count(p_user text, p_cycle uuid)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  perform cycle_status_test.become(p_user);
  select count(*)::int into n from public.get_cycle_status(p_cycle);
  return n;
end;
$$;

-- The full error (code, message, detail, hint) of the caller's call, or "ok".
create function cycle_status_test.err(p_user text, p_cycle uuid)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform cycle_status_test.become(p_user);
  perform 1 from public.get_cycle_status(p_cycle);
  return to_jsonb('ok'::text);
exception
  when others then
    get stacked diagnostics
      v_state = returned_sqlstate,
      v_message = message_text,
      v_detail = pg_exception_detail,
      v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

-- The number of rows get_my_cards returns to the caller.
create function cycle_status_test.my_cards(p_user text, p_cycle uuid)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  perform cycle_status_test.become(p_user);
  select count(*)::int into n from public.get_my_cards(p_cycle);
  return n;
end;
$$;

-- True when the caller's my_card_count equals their get_my_cards row count.
create function cycle_status_test.mine_matches(p_user text, p_cycle text)
returns boolean
language sql
as $$
  select (cycle_status_test.st(p_user, cycle_status_test.id(p_cycle)) ->> 'my_card_count')::int
         = cycle_status_test.my_cards(p_user, cycle_status_test.id(p_cycle));
$$;

-- create_card as the user; the card text is its label, and its id is stored.
create function cycle_status_test.add_card(p_user text, p_cycle text, p_label text, p_anonymous boolean)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform cycle_status_test.become(p_user);
  select c.id into strict new_id
    from public.create_card(cycle_status_test.id(p_cycle), 'start', p_label, p_anonymous) c;
  insert into cycle_status_test.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

-- update_card as the user, keeping the text and setting is_anonymous.
create function cycle_status_test.set_anonymous(p_user text, p_label text, p_anonymous boolean)
returns boolean
language plpgsql
as $$
declare
  result boolean;
begin
  perform cycle_status_test.become(p_user);
  select c.is_anonymous into strict result
    from public.update_card(cycle_status_test.id(p_label), p_label, p_anonymous) c;
  return result;
end;
$$;

-- delete_card as the user.
create function cycle_status_test.remove_card(p_user text, p_label text)
returns void
language plpgsql
as $$
begin
  perform cycle_status_test.become(p_user);
  perform public.delete_card(cycle_status_test.id(p_label));
end;
$$;

-- The expected row.
create function cycle_status_test.ex(
  p_cycle text,
  p_status text,
  p_revealed boolean,
  p_members integer,
  p_submitted integer,
  p_mine integer,
  p_cards integer
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'cycle_id', cycle_status_test.id(p_cycle),
    'status', p_status,
    'is_revealed', p_revealed,
    'member_count', p_members,
    'submitted_member_count', p_submitted,
    'my_card_count', p_mine,
    'card_count', p_cards
  );
$$;

-- Stores the caller's current row under a label, and reads it back.
create function cycle_status_test.snap(p_label text, p_user text, p_cycle text)
returns void
language sql
as $$
  insert into cycle_status_test.snaps (label, row_json)
  values (p_label, cycle_status_test.st(p_user, cycle_status_test.id(p_cycle)))
  on conflict (label) do update set row_json = excluded.row_json;
$$;

create function cycle_status_test.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.row_json from cycle_status_test.snaps s where s.label = p_label;
$$;

grant usage on schema cycle_status_test to authenticated;
grant select, insert, update on all tables in schema cycle_status_test to authenticated;
grant execute on all functions in schema cycle_status_test to authenticated;

-- The error every denied caller gets.
create function cycle_status_test.denied()
returns jsonb
language sql
immutable
as $$
  select '{"code":"42501","message":"not_project_member","detail":"","hint":""}'::jsonb;
$$;
grant execute on function cycle_status_test.denied() to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures. Inserting auth.users rows fires private.handle_new_user(), and
-- inserting projects fires the owner-membership trigger (owner = facilitator).
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-000000000000', '13000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'status-a@example.com', '{"display_name":"Alice"}'),
  ('00000000-0000-0000-0000-000000000000', '13000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'status-b@example.com', '{"display_name":"Bob"}'),
  ('00000000-0000-0000-0000-000000000000', '13000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'status-c@example.com', '{"display_name":"Cara"}'),
  ('00000000-0000-0000-0000-000000000000', '13000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'status-d@example.com', '{"display_name":"Dan"}'),
  ('00000000-0000-0000-0000-000000000000', '13000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'status-e@example.com', '{"display_name":"Eve"}');

insert into public.projects (id, name, owner_id)
values
  ('23000000-0000-4000-8000-000000000001', 'Project P', '13000000-0000-4000-8000-000000000001'),
  ('23000000-0000-4000-8000-000000000002', 'Project Q', '13000000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('23000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000002', 'member'),
  ('23000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000004', 'member'),
  ('23000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000005', 'member');

insert into public.feedback_cycles (id, project_id, title, week_start)
values
  ('33000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', 'P earlier', '2026-10-19'),
  ('33000000-0000-4000-8000-000000000003', '23000000-0000-4000-8000-000000000002', 'Q week', '2026-10-26');

-- ---------------------------------------------------------------------------
-- Shape.
-- ---------------------------------------------------------------------------
select has_function('public', 'get_cycle_status', array['uuid'], 'get_cycle_status(uuid) exists');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_cycle_status'), 1, 'get_cycle_status has exactly one overload');
select is(pg_get_function_identity_arguments('public.get_cycle_status(uuid)'::regprocedure), 'p_cycle_id uuid', 'get_cycle_status takes only the cycle id');
select is(pg_get_function_result('public.get_cycle_status(uuid)'::regprocedure), 'TABLE(cycle_id uuid, status text, is_revealed boolean, member_count integer, submitted_member_count integer, my_card_count integer, card_count integer)', 'get_cycle_status returns exactly the seven aggregate columns');
select is(
  (select array_agg(a.name order by a.ord) from pg_proc p cross join lateral unnest(p.proargnames, p.proargmodes) with ordinality as a(name, mode, ord) where p.oid = 'public.get_cycle_status(uuid)'::regprocedure and a.mode = 't'),
  array['cycle_id', 'status', 'is_revealed', 'member_count', 'submitted_member_count', 'my_card_count', 'card_count']::text[],
  'the result columns are exactly the seven names, in order'
);
select is(
  (select array_agg(a.name) from pg_proc p cross join lateral unnest(p.proargnames, p.proargmodes) as a(name, mode) where p.oid = 'public.get_cycle_status(uuid)'::regprocedure and a.mode = 't' and (a.name in ('author_id', 'user_id', 'email', 'display_name', 'card_id', 'text', 'is_anonymous', 'category') or a.name ~ '_at$')),
  null,
  'no result column is author_id, user_id, email, display_name, card_id, text, is_anonymous, category, or ends in _at'
);
select is(pg_get_function_result('public.get_cycle_status(uuid)'::regprocedure) ~* '(author_id|user_id|email|display_name|card_id|is_anonymous|category|_at )', false, 'the result type mentions none of the forbidden names');

-- ---------------------------------------------------------------------------
-- The function body never reads anonymity, category, or profiles.
-- ---------------------------------------------------------------------------
select is((select prosrc ~* 'is_anonymous' from pg_proc where oid = 'public.get_cycle_status(uuid)'::regprocedure), false, 'the body does not mention is_anonymous');
select is((select prosrc ~* 'category' from pg_proc where oid = 'public.get_cycle_status(uuid)'::regprocedure), false, 'the body does not mention category');
select is((select prosrc ~* 'profiles' from pg_proc where oid = 'public.get_cycle_status(uuid)'::regprocedure), false, 'the body does not mention profiles');

-- ---------------------------------------------------------------------------
-- RPC hardening.
-- ---------------------------------------------------------------------------
select is((select prosecdef from pg_proc where oid = 'public.get_cycle_status(uuid)'::regprocedure), true, 'get_cycle_status is security definer');
select is((select provolatile::text from pg_proc where oid = 'public.get_cycle_status(uuid)'::regprocedure), 's', 'get_cycle_status is stable');
select is((select proconfig from pg_proc where oid = 'public.get_cycle_status(uuid)'::regprocedure), array['search_path=""']::text[], 'get_cycle_status fixes search_path to empty');
select is((select prosrc ~ '\mexecute\M' from pg_proc where oid = 'public.get_cycle_status(uuid)'::regprocedure), false, 'get_cycle_status uses no dynamic SQL');
select is((select prosrc ~ '\(select auth\.uid\(\)\) is null' from pg_proc where oid = 'public.get_cycle_status(uuid)'::regprocedure), true, 'get_cycle_status checks (select auth.uid()) inside the function');
select is((select prosrc ~ 'private\.is_project_member\(cycle_project\)' from pg_proc where oid = 'public.get_cycle_status(uuid)'::regprocedure), true, 'get_cycle_status uses private.is_project_member');
select is((select prosrc ~* 'raise\s+(notice|log|info|debug|warning)' from pg_proc where oid = 'public.get_cycle_status(uuid)'::regprocedure), false, 'get_cycle_status raises no notice, log, info, debug, or warning');
select is(
  (select array_agg(distinct m.msg[1]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'message\s*=\s*''([^'']*)''', 'g') as m(msg) where p.oid = 'public.get_cycle_status(uuid)'::regprocedure),
  array['not_project_member'],
  'the only error message is not_project_member'
);
select is(
  (select (select count(*) from regexp_matches(p.prosrc, '\mraise\M', 'gi'))::int from pg_proc p where p.oid = 'public.get_cycle_status(uuid)'::regprocedure),
  (select (select count(*) from regexp_matches(p.prosrc, 'raise exception using errcode = ''42501'', message = ''not_project_member'';', 'g'))::int from pg_proc p where p.oid = 'public.get_cycle_status(uuid)'::regprocedure),
  'every raise is 42501 not_project_member with no detail or hint'
);
select is((select prosrc ~* '(detail|hint)\s*=' from pg_proc where oid = 'public.get_cycle_status(uuid)'::regprocedure), false, 'no raise sets a detail or hint');
select is(has_function_privilege('anon', 'public.get_cycle_status(uuid)', 'EXECUTE'), false, 'anon cannot execute get_cycle_status');
select is(has_function_privilege('authenticated', 'public.get_cycle_status(uuid)', 'EXECUTE'), true, 'authenticated can execute get_cycle_status');
select is(has_function_privilege('service_role', 'public.get_cycle_status(uuid)', 'EXECUTE'), false, 'service_role is not granted get_cycle_status');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.get_cycle_status(uuid)'::regprocedure), 0, 'PUBLIC cannot execute get_cycle_status');
select is(
  (select array_agg(r.rolname::text order by r.rolname) from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid = a.grantee where p.oid = 'public.get_cycle_status(uuid)'::regprocedure and a.grantee <> p.proowner),
  array['authenticated'],
  'execute on get_cycle_status is granted only to authenticated'
);
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and (has_function_privilege('anon', p.oid, 'EXECUTE') or (has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.proname not in ('is_project_member', 'is_project_facilitator')))),
  null,
  'no new private helper is executable by anon or authenticated'
);
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.prosrc ~ 'get_cycle_status|card_authors'), 0, 'no private helper reads card_authors for the status');

-- ---------------------------------------------------------------------------
-- The migration adds no table access on cards, card_authors,
-- project_members, or profiles.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'cards'), 0, 'cards still has no policy');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'card_authors'), 0, 'card_authors still has no policy');
select is((select array_agg(policyname::text order by policyname) from pg_policies where schemaname = 'public' and tablename = 'project_members'), array['project_members_select_member'], 'project_members keeps only its select policy');
select is((select array_agg(policyname::text order by policyname) from pg_policies where schemaname = 'public' and tablename = 'profiles'), array['profiles_select_own', 'profiles_update_own'], 'profiles keeps only its own-row policies');
select is(
  (select array_agg(r || ':' || t || ':' || p order by r, t, p) from unnest(array['anon', 'authenticated']) r cross join unnest(array['public.cards', 'public.card_authors', 'public.project_members', 'public.profiles']) t cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege(r, t, p)),
  array['authenticated:public.profiles:SELECT', 'authenticated:public.project_members:SELECT'],
  'anon and authenticated have no new table privilege on the four tables'
);
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('cards', 'card_authors', 'project_members', 'profiles')), 0, 'none of the four tables is in the supabase_realtime publication');
select is((select count(*)::int from pg_depend d join pg_rewrite r on r.oid = d.objid where d.classid = 'pg_rewrite'::regclass and d.refobjid in ('public.cards'::regclass, 'public.card_authors'::regclass)), 0, 'no view reads cards or card_authors');

-- ---------------------------------------------------------------------------
-- P0: a cycle closed early from collecting is never revealed.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(cycle_status_test.st('B', cycle_status_test.id('P0')), cycle_status_test.ex('P0', 'collecting', false, 4, 0, 0, null), 'P0 collecting with no cards: 4 members, none submitted, no total');
select isnt(cycle_status_test.add_card('B', 'P0', 'B in P0', false), null, 'B adds a card in P0');
select isnt(cycle_status_test.add_card('D', 'P0', 'D in P0', true), null, 'D adds an anonymous card in P0');
select is(cycle_status_test.st('A', cycle_status_test.id('P0')), cycle_status_test.ex('P0', 'collecting', false, 4, 2, 0, null), 'P0 collecting: A sees 2 of 4 submitted, 0 own cards, no total');

set local request.jwt.claims = '{"sub":"13000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select * from public.close_cycle('33000000-0000-4000-8000-000000000001') $$, 'A closes P0 early from collecting');

select is(cycle_status_test.st('A', cycle_status_test.id('P0')), cycle_status_test.ex('P0', 'closed', false, 4, 2, 0, null), 'P0 closed early: A gets closed, not revealed, no total');
select is(cycle_status_test.st('B', cycle_status_test.id('P0')), cycle_status_test.ex('P0', 'closed', false, 4, 2, 1, null), 'P0 closed early: B gets closed, not revealed, no total');
select is(cycle_status_test.st('D', cycle_status_test.id('P0')), cycle_status_test.ex('P0', 'closed', false, 4, 2, 1, null), 'P0 closed early: D gets closed, not revealed, no total');
select ok(cycle_status_test.mine_matches('A', 'P0') and cycle_status_test.mine_matches('B', 'P0') and cycle_status_test.mine_matches('D', 'P0') and cycle_status_test.mine_matches('E', 'P0'), 'P0 closed: my_card_count equals get_my_cards for A, B, D, and E');
select is(cycle_status_test.err('C', cycle_status_test.id('P0')), cycle_status_test.denied(), 'P0 closed: non-member C gets not_project_member');
reset role;

-- P1 opens once P0 is closed.
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('33000000-0000-4000-8000-000000000002', '23000000-0000-4000-8000-000000000001', 'P week', '2026-10-26');

-- ---------------------------------------------------------------------------
-- P1 collecting: an empty cycle, then counts.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(cycle_status_test.row_count('A', cycle_status_test.id('P1')), 1, 'an empty cycle returns exactly one row to A');
select is(cycle_status_test.row_count('B', cycle_status_test.id('P1')), 1, 'an empty cycle returns exactly one row to B');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 0, 0, null), 'P1 empty: A (owner and facilitator) gets 0 of 4 and no total');
select is(cycle_status_test.st('B', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 0, 0, null), 'P1 empty: B gets 0 of 4 and no total');
select is(cycle_status_test.st('D', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 0, 0, null), 'P1 empty: D gets 0 of 4 and no total');
select is(cycle_status_test.st('E', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 0, 0, null), 'P1 empty: E gets 0 of 4 and no total');

-- Cards in another project are never counted.
select isnt(cycle_status_test.add_card('C', 'Q1', 'C in Q1 one', false), null, 'C adds a card in Q1');
select isnt(cycle_status_test.add_card('C', 'Q1', 'C in Q1 two', true), null, 'C adds a second card in Q1');
select isnt(cycle_status_test.add_card('C', 'Q1', 'C in Q1 three', false), null, 'C adds a third card in Q1');
select is(cycle_status_test.st('C', cycle_status_test.id('Q1')), cycle_status_test.ex('Q1', 'collecting', false, 1, 1, 3, null), 'Q1: C sees only Q''s member and cards');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 0, 0, null), 'Q1''s cards and P0''s cards are not counted in P1');

select isnt(cycle_status_test.add_card('E', 'P1', 'E one', false), null, 'E adds an attributed card');

-- Scenario 1: B's two cards are both anonymous.
select isnt(cycle_status_test.add_card('B', 'P1', 'B anon one', true), null, 'B adds an anonymous card');
select isnt(cycle_status_test.add_card('B', 'P1', 'B anon two', true), null, 'B adds a second anonymous card');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 2, 0, null), 'A sees 2 of 4 submitted and no total');
select is(cycle_status_test.st('B', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 2, 2, null), 'B sees 2 own cards and no total');
select lives_ok($$ select cycle_status_test.snap('anon A', 'A', 'P1'), cycle_status_test.snap('anon B', 'B', 'P1'), cycle_status_test.snap('anon E', 'E', 'P1') $$, 'snapshot the rows with B''s anonymous cards');

select lives_ok($$ select cycle_status_test.remove_card('B', 'B anon one'), cycle_status_test.remove_card('B', 'B anon two') $$, 'B deletes both cards');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 1, 0, null), 'after B deletes their last card, submitted goes down to 1');

-- Scenario 2: D's two cards are both attributed.
select isnt(cycle_status_test.add_card('D', 'P1', 'D one', false), null, 'D adds an attributed card');
select isnt(cycle_status_test.add_card('D', 'P1', 'D two', false), null, 'D adds a second attributed card');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.snapped('anon A'), 'A''s row with D''s two attributed cards equals A''s row with B''s two anonymous cards');
select is(cycle_status_test.st('E', cycle_status_test.id('P1')), cycle_status_test.snapped('anon E'), 'E''s row is the same in both scenarios');
select is(cycle_status_test.st('D', cycle_status_test.id('P1')), cycle_status_test.snapped('anon B'), 'all-attributed D gets the same row as all-anonymous B');

-- A member with five cards counts once.
select isnt(cycle_status_test.add_card('B', 'P1', 'B one', true), null, 'B adds card one of five');
select isnt(cycle_status_test.add_card('B', 'P1', 'B two', false), null, 'B adds card two of five');
select isnt(cycle_status_test.add_card('B', 'P1', 'B three', true), null, 'B adds card three of five');
select isnt(cycle_status_test.add_card('B', 'P1', 'B four', false), null, 'B adds card four of five');
select isnt(cycle_status_test.add_card('B', 'P1', 'B five', true), null, 'B adds card five of five');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 3, 0, null), 'B with five cards counts once: 3 of 4');
select is(cycle_status_test.st('B', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 3, 5, null), 'B sees 5 own cards in P1 (not P0''s) and no total');
select is(cycle_status_test.st('D', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 3, 2, null), 'D sees 2 own cards and no total');
select is(cycle_status_test.st('E', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 3, 1, null), 'E sees 1 own card and no total');

-- Switching anonymity with update_card changes nothing for anyone.
select lives_ok($$ select cycle_status_test.snap('pre A', 'A', 'P1'), cycle_status_test.snap('pre B', 'B', 'P1'), cycle_status_test.snap('pre D', 'D', 'P1'), cycle_status_test.snap('pre E', 'E', 'P1') $$, 'snapshot every caller before switching anonymity');
select is(cycle_status_test.set_anonymous('D', 'D one', true), true, 'D switches an attributed card to anonymous');
select is(cycle_status_test.set_anonymous('B', 'B one', false), false, 'B switches an anonymous card to attributed');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.snapped('pre A'), 'after the switch A''s row is unchanged');
select is(cycle_status_test.st('B', cycle_status_test.id('P1')), cycle_status_test.snapped('pre B'), 'after the switch B''s row is unchanged');
select is(cycle_status_test.st('D', cycle_status_test.id('P1')), cycle_status_test.snapped('pre D'), 'after the switch D''s row is unchanged');
select is(cycle_status_test.st('E', cycle_status_test.id('P1')), cycle_status_test.snapped('pre E'), 'after the switch E''s row is unchanged');
select is(cycle_status_test.set_anonymous('D', 'D one', false), false, 'D switches the card back to attributed');
select is(cycle_status_test.set_anonymous('B', 'B one', true), true, 'B switches the card back to anonymous');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.snapped('pre A'), 'after switching back A''s row is unchanged');
select is(cycle_status_test.st('B', cycle_status_test.id('P1')), cycle_status_test.snapped('pre B'), 'after switching back B''s row is unchanged');
select is(cycle_status_test.st('D', cycle_status_test.id('P1')), cycle_status_test.snapped('pre D'), 'after switching back D''s row is unchanged');
select is(cycle_status_test.st('E', cycle_status_test.id('P1')), cycle_status_test.snapped('pre E'), 'after switching back E''s row is unchanged');

-- Deleting the last card and adding one again.
select lives_ok($$ select cycle_status_test.remove_card('E', 'E one') $$, 'E deletes their only card');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 2, 0, null), 'after E deletes their last card, submitted goes down by one');
select is(cycle_status_test.st('E', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 2, 0, null), 'E sees 0 own cards');
select isnt(cycle_status_test.add_card('E', 'P1', 'E two', true), null, 'E adds a card again');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 3, 0, null), 'after E adds a card again, submitted goes back up');

select ok(cycle_status_test.mine_matches('A', 'P1') and cycle_status_test.mine_matches('B', 'P1') and cycle_status_test.mine_matches('D', 'P1') and cycle_status_test.mine_matches('E', 'P1'), 'collecting: my_card_count equals get_my_cards for A, B, D, and E');

-- Same row for the owner-facilitator and members, apart from my_card_count.
select is(cycle_status_test.st('A', cycle_status_test.id('P1')) - 'my_card_count', cycle_status_test.st('B', cycle_status_test.id('P1')) - 'my_card_count', 'collecting: the owner-facilitator A and member B get the same row apart from my_card_count');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')) - 'my_card_count', cycle_status_test.st('D', cycle_status_test.id('P1')) - 'my_card_count', 'collecting: A and member D get the same row apart from my_card_count');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')) - 'my_card_count', cycle_status_test.st('E', cycle_status_test.id('P1')) - 'my_card_count', 'collecting: A and member E get the same row apart from my_card_count');

-- ---------------------------------------------------------------------------
-- Who may call it, while collecting.
-- ---------------------------------------------------------------------------
select is(cycle_status_test.err(null, cycle_status_test.id('P1')), cycle_status_test.denied(), 'collecting: a null auth.uid() gets not_project_member');
select is(cycle_status_test.err('A', null), cycle_status_test.denied(), 'a null p_cycle_id gets not_project_member');
select is(cycle_status_test.err('A', '33000000-0000-4000-8000-0000000000ff'), cycle_status_test.denied(), 'an unknown p_cycle_id gets not_project_member');
select is(cycle_status_test.err('C', cycle_status_test.id('P1')), cycle_status_test.denied(), 'collecting: non-member C gets not_project_member');
select is(cycle_status_test.err('C', cycle_status_test.id('P1')), cycle_status_test.err('C', gen_random_uuid()), 'C gets the same error for an existing cycle and a random UUID');
select is(cycle_status_test.err('B', cycle_status_test.id('Q1')), cycle_status_test.denied(), 'B, a member of a different project, gets not_project_member for Q1');
select is(cycle_status_test.err('A', cycle_status_test.id('Q1')), cycle_status_test.err('A', gen_random_uuid()), 'A gets the same error for Q1 and a random UUID');
reset role;

set local role anon;
select throws_ok($$ select * from public.get_cycle_status('33000000-0000-4000-8000-000000000002') $$, '42501'::char(5), NULL, 'anon cannot call get_cycle_status');
reset role;

-- ---------------------------------------------------------------------------
-- A member who joins mid-cycle is counted on the next call.
-- ---------------------------------------------------------------------------
insert into public.project_members (project_id, user_id, role)
values ('23000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000003', 'member');
set local role authenticated;
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 5, 3, 0, null), 'C joins mid-cycle: member_count is 5 on the next call');
select is(cycle_status_test.st('C', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 5, 3, 0, null), 'C, now a member, gets the same row with 0 own cards (Q1''s cards are not counted)');
reset role;
delete from public.project_members where project_id = '23000000-0000-4000-8000-000000000001' and user_id = '13000000-0000-4000-8000-000000000003';
set local role authenticated;
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 3, 0, null), 'C leaves again: member_count is back to 4');
select is(cycle_status_test.err('C', cycle_status_test.id('P1')), cycle_status_test.denied(), 'C, removed again, gets not_project_member');
reset role;

-- ---------------------------------------------------------------------------
-- Removed member D (two cards).
-- ---------------------------------------------------------------------------
delete from public.project_members where project_id = '23000000-0000-4000-8000-000000000001' and user_id = '13000000-0000-4000-8000-000000000004';
set local role authenticated;
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 3, 2, 0, null), 'D removed: A''s member and submitted counts each drop by one');
select is(cycle_status_test.st('B', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 3, 2, 5, null), 'D removed: B''s member and submitted counts each drop by one');
select is(cycle_status_test.st('E', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 3, 2, 1, null), 'D removed: E''s member and submitted counts each drop by one');
select is(cycle_status_test.err('D', cycle_status_test.id('P1')), cycle_status_test.denied(), 'removed member D gets not_project_member');
select is(cycle_status_test.err('D', cycle_status_test.id('P0')), cycle_status_test.denied(), 'removed member D gets not_project_member for the closed P0 too');
reset role;

insert into public.project_members (project_id, user_id, role)
values ('23000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000004', 'member');
set local role authenticated;
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 3, 0, null), 'D added back counts as submitted again');
select is(cycle_status_test.st('D', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 4, 3, 2, null), 'D added back sees their two kept cards');
reset role;

delete from public.project_members where project_id = '23000000-0000-4000-8000-000000000001' and user_id = '13000000-0000-4000-8000-000000000004';
set local role authenticated;
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 3, 2, 0, null), 'D removed again: 2 of 3');
reset role;

-- ---------------------------------------------------------------------------
-- Deleted auth user E (one card). The service_role key deletes users through
-- the Auth admin API (as supabase_auth_admin); SQL service_role has no DELETE
-- on auth.users, so the delete runs as postgres, as in cards.test.sql.
-- ---------------------------------------------------------------------------
select lives_ok($$ delete from auth.users where id = '13000000-0000-4000-8000-000000000005' $$, 'auth user E is deleted');
select is((select count(*)::int from public.cards where id = cycle_status_test.id('E two')), 1, 'E''s card is kept');
select is((select count(*)::int from public.card_authors where card_id = cycle_status_test.id('E two')), 0, 'E''s card has no author');
set local role authenticated;
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 2, 1, 0, null), 'E deleted: E is in neither member_count nor submitted_member_count');
select is(cycle_status_test.st('B', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'collecting', false, 2, 1, 5, null), 'E deleted: B sees 1 of 2');
select is(cycle_status_test.err('E', cycle_status_test.id('P1')), cycle_status_test.denied(), 'a deleted user''s id gets not_project_member');
reset role;

-- P1 holds B's five, D's two, and E's one authorless card.
select is((select count(*)::int from public.cards where cycle_id = '33000000-0000-4000-8000-000000000002'), 8, 'P1 holds eight cards');

-- ---------------------------------------------------------------------------
-- reveal (revealed_at set, as #14 will do).
-- ---------------------------------------------------------------------------
update public.feedback_cycles set status = 'reveal', revealed_at = now() where id = '33000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(cycle_status_test.st('A', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'reveal', true, 2, 1, 0, 8), 'reveal: A gets is_revealed and the total, including removed D''s and deleted E''s cards');
select is(cycle_status_test.st('B', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'reveal', true, 2, 1, 5, 8), 'reveal: B gets is_revealed and the total');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')) - 'my_card_count', cycle_status_test.st('B', cycle_status_test.id('P1')) - 'my_card_count', 'reveal: the owner-facilitator A and member B get the same row apart from my_card_count');
select ok(cycle_status_test.mine_matches('A', 'P1') and cycle_status_test.mine_matches('B', 'P1'), 'reveal: my_card_count equals get_my_cards for A and B');
select lives_ok($$ select cycle_status_test.snap('reveal A', 'A', 'P1'), cycle_status_test.snap('reveal B', 'B', 'P1') $$, 'snapshot A and B at reveal');
select is(cycle_status_test.err(null, cycle_status_test.id('P1')), cycle_status_test.denied(), 'reveal: a null auth.uid() gets not_project_member');
select is(cycle_status_test.err('C', cycle_status_test.id('P1')), cycle_status_test.denied(), 'reveal: non-member C gets not_project_member');
select is(cycle_status_test.err('D', cycle_status_test.id('P1')), cycle_status_test.denied(), 'reveal: removed member D gets not_project_member');
select is(cycle_status_test.err('B', cycle_status_test.id('Q1')), cycle_status_test.denied(), 'reveal: B gets not_project_member for Q1');
reset role;

-- ---------------------------------------------------------------------------
-- cluster, vote, discuss, and closed after reveal.
-- ---------------------------------------------------------------------------
update public.feedback_cycles set status = 'cluster' where id = '33000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(cycle_status_test.st('A', cycle_status_test.id('P1')) ->> 'status', 'cluster', 'cluster: status is cluster');
select is((cycle_status_test.st('A', cycle_status_test.id('P1')) ->> 'is_revealed')::boolean, true, 'cluster: is_revealed is true');
select is((cycle_status_test.st('A', cycle_status_test.id('P1')) ->> 'card_count')::int, 8, 'cluster: card_count is the total');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')) - 'status', cycle_status_test.snapped('reveal A') - 'status', 'cluster: A''s other columns are unchanged from reveal');
select is(cycle_status_test.st('B', cycle_status_test.id('P1')) - 'status', cycle_status_test.snapped('reveal B') - 'status', 'cluster: B''s other columns are unchanged from reveal');
select ok(cycle_status_test.mine_matches('A', 'P1') and cycle_status_test.mine_matches('B', 'P1'), 'cluster: my_card_count equals get_my_cards for A and B');
reset role;

update public.feedback_cycles set status = 'vote' where id = '33000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(cycle_status_test.st('A', cycle_status_test.id('P1')) ->> 'status', 'vote', 'vote: status is vote');
select is((cycle_status_test.st('A', cycle_status_test.id('P1')) ->> 'is_revealed')::boolean, true, 'vote: is_revealed is true');
select is((cycle_status_test.st('A', cycle_status_test.id('P1')) ->> 'card_count')::int, 8, 'vote: card_count is the total');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')) - 'status', cycle_status_test.snapped('reveal A') - 'status', 'vote: A''s other columns are unchanged from reveal');
select is(cycle_status_test.st('B', cycle_status_test.id('P1')) - 'status', cycle_status_test.snapped('reveal B') - 'status', 'vote: B''s other columns are unchanged from reveal');
select ok(cycle_status_test.mine_matches('A', 'P1') and cycle_status_test.mine_matches('B', 'P1'), 'vote: my_card_count equals get_my_cards for A and B');
reset role;

update public.feedback_cycles set status = 'discuss' where id = '33000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(cycle_status_test.st('A', cycle_status_test.id('P1')) ->> 'status', 'discuss', 'discuss: status is discuss');
select is((cycle_status_test.st('A', cycle_status_test.id('P1')) ->> 'is_revealed')::boolean, true, 'discuss: is_revealed is true');
select is((cycle_status_test.st('A', cycle_status_test.id('P1')) ->> 'card_count')::int, 8, 'discuss: card_count is the total');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')) - 'status', cycle_status_test.snapped('reveal A') - 'status', 'discuss: A''s other columns are unchanged from reveal');
select is(cycle_status_test.st('B', cycle_status_test.id('P1')) - 'status', cycle_status_test.snapped('reveal B') - 'status', 'discuss: B''s other columns are unchanged from reveal');
select ok(cycle_status_test.mine_matches('A', 'P1') and cycle_status_test.mine_matches('B', 'P1'), 'discuss: my_card_count equals get_my_cards for A and B');
reset role;

update public.feedback_cycles set status = 'closed', closed_at = now() where id = '33000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(cycle_status_test.st('A', cycle_status_test.id('P1')) ->> 'status', 'closed', 'closed after reveal: status is closed');
select is((cycle_status_test.st('A', cycle_status_test.id('P1')) ->> 'is_revealed')::boolean, true, 'closed after reveal: is_revealed is true');
select is((cycle_status_test.st('A', cycle_status_test.id('P1')) ->> 'card_count')::int, 8, 'closed after reveal: card_count is the total');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')) - 'status', cycle_status_test.snapped('reveal A') - 'status', 'closed after reveal: A''s other columns are unchanged from reveal');
select is(cycle_status_test.st('B', cycle_status_test.id('P1')) - 'status', cycle_status_test.snapped('reveal B') - 'status', 'closed after reveal: B''s other columns are unchanged from reveal');
select ok(cycle_status_test.mine_matches('A', 'P1') and cycle_status_test.mine_matches('B', 'P1'), 'closed after reveal: my_card_count equals get_my_cards for A and B');
select is(cycle_status_test.err(null, cycle_status_test.id('P1')), cycle_status_test.denied(), 'closed: a null auth.uid() gets not_project_member');
select is(cycle_status_test.err('C', cycle_status_test.id('P1')), cycle_status_test.denied(), 'closed: non-member C gets not_project_member');
select is(cycle_status_test.err('D', cycle_status_test.id('P1')), cycle_status_test.denied(), 'closed: removed member D gets not_project_member');
select is(cycle_status_test.err('B', cycle_status_test.id('Q1')), cycle_status_test.denied(), 'closed: B gets not_project_member for Q1');
select is(cycle_status_test.st('A', cycle_status_test.id('P0')), cycle_status_test.ex('P0', 'closed', false, 2, 1, 0, null), 'P0, closed early, still has no total');
reset role;

-- ---------------------------------------------------------------------------
-- After transfer_facilitator: the owner is no longer the facilitator.
-- ---------------------------------------------------------------------------
insert into public.project_members (project_id, user_id, role)
values ('23000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000004', 'member');
set local role authenticated;
set local request.jwt.claims = '{"sub":"13000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select public.transfer_facilitator('23000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000002') $$, 'owner A transfers the facilitator role to B');
reset role;
select is((select role from public.project_members where project_id = '23000000-0000-4000-8000-000000000001' and user_id = '13000000-0000-4000-8000-000000000002'), 'facilitator', 'B is now the facilitator');
select is((select role from public.project_members where project_id = '23000000-0000-4000-8000-000000000001' and user_id = '13000000-0000-4000-8000-000000000001'), 'member', 'owner A is now a member');
set local role authenticated;
select is(cycle_status_test.st('B', cycle_status_test.id('P1')), cycle_status_test.ex('P1', 'closed', true, 3, 2, 5, 8), 'after transfer: facilitator B gets D back as submitted and the total');
select is(cycle_status_test.st('A', cycle_status_test.id('P1')) - 'my_card_count', cycle_status_test.st('B', cycle_status_test.id('P1')) - 'my_card_count', 'after transfer: owner A and facilitator B get the same row apart from my_card_count');
select is(cycle_status_test.st('D', cycle_status_test.id('P1')) - 'my_card_count', cycle_status_test.st('B', cycle_status_test.id('P1')) - 'my_card_count', 'after transfer: member D and facilitator B get the same row apart from my_card_count');
select is((cycle_status_test.st('D', cycle_status_test.id('P1')) ->> 'my_card_count')::int, 2, 'after transfer: D''s own count is 2');
select is(cycle_status_test.st('A', cycle_status_test.id('P0')) - 'my_card_count', cycle_status_test.st('B', cycle_status_test.id('P0')) - 'my_card_count', 'after transfer: owner A and facilitator B get the same P0 row apart from my_card_count');
reset role;

select * from finish();
rollback;
