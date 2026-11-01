-- pgTAP tests for advance_stage (#16): the facilitator's one-step stage
-- control on the board.
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension and the advance_test helper schema. The seed user is
-- never used as a fixture.
--
-- Fixtures: owner and facilitator A, members B and D, non-member C. Project P
-- is owned by A with B and D joined; project Q is owned by C, and none of A,
-- B, or D is ever in Q.
--
-- Cycles. P1 (P) is the main cycle: attributed and anonymous cards from A, B,
-- and D, started by A, advanced to cluster and vote, moved to discuss as
-- postgres, then closed. P2 is closed straight from collecting. P3 is started
-- by A, used for the one-transaction check, and advanced by B after A
-- transferred the facilitator role. Q1 (Q) is C's. P has at most one open
-- cycle at a time.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(146);

-- ---------------------------------------------------------------------------
-- Test-only helpers. The ones that call RPCs are security invoker: they run
-- as the calling role (authenticated) and switch only the JWT claims. The
-- read-back helpers (state, events, event_list, last_event, cards_md5) are
-- security definer so they see every row whatever the caller.
-- ---------------------------------------------------------------------------
create schema advance_test;

create table advance_test.ids (label text primary key, id uuid not null);
create table advance_test.snaps (label text primary key, row_json jsonb not null);

insert into advance_test.ids (label, id)
values
  ('A', '16000000-0000-4000-8000-000000000001'),
  ('B', '16000000-0000-4000-8000-000000000002'),
  ('C', '16000000-0000-4000-8000-000000000003'),
  ('D', '16000000-0000-4000-8000-000000000004'),
  ('P', '26000000-0000-4000-8000-000000000001'),
  ('Q', '26000000-0000-4000-8000-000000000002'),
  ('P1', '36000000-0000-4000-8000-000000000001'),
  ('P2', '36000000-0000-4000-8000-000000000002'),
  ('P3', '36000000-0000-4000-8000-000000000003'),
  ('Q1', '36000000-0000-4000-8000-000000000011');

-- The id stored under a label (a user, project, cycle, or card).
create function advance_test.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from advance_test.ids i where i.label = p_label;
$$;

-- Signs in as the labelled user, or with no sub when the label is null (so
-- auth.uid() is null).
create function advance_test.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', advance_test.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- advance_stage as the user; its rows as a jsonb array.
create function advance_test.adv(p_user text, p_cycle uuid, p_from text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform advance_test.become(p_user);
  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into result from public.advance_stage(p_cycle, p_from) s;
  return result;
end;
$$;

-- The full error of advance_stage (code, message, detail, hint), or "ok". A
-- failed call is rolled back with its subtransaction.
create function advance_test.adv_err(p_user text, p_cycle uuid, p_from text)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform advance_test.become(p_user);
  perform 1 from public.advance_stage(p_cycle, p_from);
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

-- Calls advance_stage once per argument, ignoring errors, and returns the
-- cycle's status afterwards (read as postgres).
create function advance_test.try_all(p_user text, p_cycle uuid, p_froms text[])
returns text
language plpgsql
as $$
declare
  v_from text;
begin
  foreach v_from in array p_froms loop
    perform advance_test.adv_err(p_user, p_cycle, v_from);
  end loop;
  return advance_test.state(p_cycle) ->> 'status';
end;
$$;

-- start_retrospective as the user.
create function advance_test.start(p_user text, p_cycle uuid)
returns void
language plpgsql
as $$
begin
  perform advance_test.become(p_user);
  perform 1 from public.start_retrospective(p_cycle);
end;
$$;

-- close_cycle as the user.
create function advance_test.close(p_user text, p_cycle uuid)
returns void
language plpgsql
as $$
begin
  perform advance_test.become(p_user);
  perform 1 from public.close_cycle(p_cycle);
end;
$$;

-- transfer_facilitator as the user.
create function advance_test.transfer(p_user text, p_project uuid, p_to uuid)
returns void
language plpgsql
as $$
begin
  perform advance_test.become(p_user);
  perform public.transfer_facilitator(p_project, p_to);
end;
$$;

-- get_cycle_board as the user.
create function advance_test.board(p_user text, p_cycle uuid)
returns jsonb
language plpgsql
as $$
begin
  perform advance_test.become(p_user);
  return public.get_cycle_board(p_cycle);
end;
$$;

-- create_card as the user; the card text is its label, and its id is stored.
create function advance_test.add_card(p_user text, p_cycle text, p_category text, p_label text, p_anonymous boolean)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform advance_test.become(p_user);
  select c.id into strict new_id
    from public.create_card(advance_test.id(p_cycle), p_category, p_label, p_anonymous) c;
  insert into advance_test.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

-- status, revealed_at, voting_closed_at, and the event count of a cycle,
-- read as postgres.
create function advance_test.state(p_cycle uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', (select fc.status from public.feedback_cycles fc where fc.id = p_cycle),
    'revealed_at', (select fc.revealed_at from public.feedback_cycles fc where fc.id = p_cycle),
    'voting_closed_at', (select fc.voting_closed_at from public.feedback_cycles fc where fc.id = p_cycle),
    'events', (select count(*) from public.cycle_events e where e.cycle_id = p_cycle)
  );
$$;

-- The cycle's events as "from>to:actor" in stage order, read as postgres.
-- Every event in this transaction has the same created_at, and a cycle's
-- stages only move forward, so from_status orders them.
create function advance_test.event_list(p_cycle uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    array_agg(
      e.from_status || '>' || e.to_status || ':' || coalesce(
        (select i.label from advance_test.ids i where i.id = e.actor_id and i.label in ('A', 'B', 'C', 'D')),
        'null'
      )
      order by e.created_at, array_position(array['collecting', 'reveal', 'cluster', 'vote', 'discuss', 'closed'], e.from_status)
    ),
    '{}'::text[]
  )
  from public.cycle_events e
  where e.cycle_id = p_cycle;
$$;

-- The latest event of a cycle (by stage) as jsonb, read as postgres.
create function advance_test.last_event(p_cycle uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(e)
  from public.cycle_events e
  where e.cycle_id = p_cycle
  order by e.created_at desc, array_position(array['collecting', 'reveal', 'cluster', 'vote', 'discuss', 'closed'], e.from_status) desc
  limit 1;
$$;

-- An md5 of every cards and card_authors row, read as postgres.
create function advance_test.cards_md5()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(
    coalesce((select string_agg(to_jsonb(c)::text, '|' order by c.id) from public.cards c), '')
    || '#'
    || coalesce((select string_agg(to_jsonb(ca)::text, '|' order by ca.card_id) from public.card_authors ca), '')
  );
$$;

-- Stores a value under a label, and reads it back.
create function advance_test.snap(p_label text, p_value jsonb)
returns void
language sql
as $$
  insert into advance_test.snaps (label, row_json)
  values (p_label, p_value)
  on conflict (label) do update set row_json = excluded.row_json;
$$;

create function advance_test.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.row_json from advance_test.snaps s where s.label = p_label;
$$;

-- The error a refused call gets, with empty detail and hint.
create function advance_test.denied(p_message text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'code', case when p_message in ('invalid_stage_transition', 'stage_out_of_date') then 'P0001' else '42501' end,
    'message', p_message,
    'detail', '',
    'hint', ''
  );
$$;

-- The one result row advance_stage returns for a cycle and a status.
create function advance_test.row_of(p_cycle text, p_status text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_array(jsonb_build_object('id', advance_test.id(p_cycle), 'status', p_status));
$$;

grant usage on schema advance_test to authenticated;
grant select, insert, update on all tables in schema advance_test to authenticated;
grant execute on all functions in schema advance_test to authenticated;

-- Every p_from_status the board can never use.
create function advance_test.bad_froms()
returns text[]
language sql
immutable
as $$
  select array[null, '', 'collecting', 'vote', 'discuss', 'closed', 'Reveal', 'bogus']::text[];
$$;

grant execute on function advance_test.bad_froms() to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures. Inserting auth.users rows fires private.handle_new_user(), and
-- inserting projects fires the owner-membership trigger (owner = facilitator).
-- The token columns are empty strings, as the Auth server writes them.
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', '16000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'advance-a@example.com', '{"display_name":"Alice"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '16000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'advance-b@example.com', '{"display_name":"Bob"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '16000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'advance-c@example.com', '{"display_name":"Cara"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '16000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'advance-d@example.com', '{"display_name":"Dan"}', '', '', '', '');

insert into public.projects (id, name, owner_id)
values
  ('26000000-0000-4000-8000-000000000001', 'Project P', '16000000-0000-4000-8000-000000000001'),
  ('26000000-0000-4000-8000-000000000002', 'Project Q', '16000000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('26000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000002', 'member'),
  ('26000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000004', 'member');

insert into public.feedback_cycles (id, project_id, title, week_start)
values
  ('36000000-0000-4000-8000-000000000001', '26000000-0000-4000-8000-000000000001', 'P main', '2026-10-26'),
  ('36000000-0000-4000-8000-000000000011', '26000000-0000-4000-8000-000000000002', 'Q one', '2026-10-26');

-- ---------------------------------------------------------------------------
-- advance_stage: shape and hardening.
-- ---------------------------------------------------------------------------
select has_function('public', 'advance_stage', array['uuid', 'text'], 'advance_stage(uuid, text) exists');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'advance_stage'), 1, 'advance_stage has exactly one overload');
select is(pg_get_function_identity_arguments('public.advance_stage(uuid, text)'::regprocedure), 'p_cycle_id uuid, p_from_status text', 'advance_stage takes the cycle id and the from-status');
select is(pg_get_function_result('public.advance_stage(uuid, text)'::regprocedure), 'TABLE(id uuid, status text)', 'advance_stage returns id and status');
select is((select prosecdef from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), true, 'advance_stage is security definer');
select is((select provolatile::text from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), 'v', 'advance_stage is volatile');
select is((select proconfig from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), array['search_path=""']::text[], 'advance_stage fixes search_path to empty');
select is((select prosrc ~ '\(select auth\.uid\(\)\) is null' from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), true, 'advance_stage checks (select auth.uid())');
select is((select prosrc ~ 'private\.is_project_member\(cycle_project\)' from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), true, 'advance_stage uses private.is_project_member');
select is((select prosrc ~ 'private\.is_project_facilitator\(cycle_project\)' from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), true, 'advance_stage uses private.is_project_facilitator');
select is((select prosrc ~ '(^|[^.\w])(feedback_cycles|projects)\M' from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), false, 'advance_stage schema-qualifies every table');
select ok(
  (select
     strpos(prosrc, 'from public.projects p where p.id = cycle_project for share') > 0
     and strpos(prosrc, 'from public.projects p where p.id = cycle_project for share') < strpos(prosrc, 'if not private.is_project_facilitator(cycle_project)')
     and strpos(prosrc, 'if not private.is_project_facilitator(cycle_project)') < strpos(prosrc, 'for update;')
     and strpos(prosrc, 'for update;') < strpos(prosrc, 'if cycle_status = p_from_status')
   from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure),
  'the projects row is locked FOR SHARE before the facilitator check, and the cycle FOR UPDATE before the status comparison'
);
select is((select prosrc ~ 'from public\.feedback_cycles fc\s+where fc\.id = p_cycle_id\s+for update;' from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), true, 'the FOR UPDATE lock is on public.feedback_cycles');
select is((select prosrc ~* 'cycle_events' from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), false, 'advance_stage source does not mention cycle_events');
select is((select prosrc ~* 'insert' from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), false, 'advance_stage source contains no insert');
select is((select prosrc ~* 'revealed_at' from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), false, 'advance_stage source does not mention revealed_at');
select is((select prosrc ~* 'voting_closed_at' from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), false, 'advance_stage source does not mention voting_closed_at');
select is((select prosrc ~* 'cards' from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), false, 'advance_stage source does not mention cards');
select is((select prosrc ~* 'card_authors' from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), false, 'advance_stage source does not mention card_authors');
select is((select prosrc ~* 'profiles' from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), false, 'advance_stage source does not mention profiles');
select is((select prosrc ~* 'execute' from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), false, 'advance_stage uses no dynamic SQL (no execute)');
select is((select prosrc ~* 'raise\s+(notice|log|info|debug|warning)' from pg_proc where oid = 'public.advance_stage(uuid, text)'::regprocedure), false, 'advance_stage raises no notice, log, info, debug, or warning');
select is(
  (select array_agg(distinct m.msg[1] order by m.msg[1]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'message\s*=\s*''([^'']*)''', 'g') as m(msg) where p.oid = 'public.advance_stage(uuid, text)'::regprocedure),
  array['invalid_stage_transition', 'not_project_facilitator', 'not_project_member', 'stage_out_of_date'],
  'the only error messages are not_project_member, not_project_facilitator, invalid_stage_transition, and stage_out_of_date'
);
select is(
  (select (select count(*) from regexp_matches(p.prosrc, '\mraise\M', 'gi'))::int from pg_proc p where p.oid = 'public.advance_stage(uuid, text)'::regprocedure),
  (select (select count(*) from regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''(not_project_member|not_project_facilitator|invalid_stage_transition|stage_out_of_date)'';', 'g'))::int from pg_proc p where p.oid = 'public.advance_stage(uuid, text)'::regprocedure),
  'every raise is a bare errcode and message with no detail or hint'
);
select is(has_function_privilege('anon', 'public.advance_stage(uuid, text)', 'EXECUTE'), false, 'anon cannot execute advance_stage');
select is(has_function_privilege('authenticated', 'public.advance_stage(uuid, text)', 'EXECUTE'), true, 'authenticated can execute advance_stage');
select is(has_function_privilege('service_role', 'public.advance_stage(uuid, text)', 'EXECUTE'), false, 'service_role is not granted advance_stage');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.advance_stage(uuid, text)'::regprocedure), 0, 'PUBLIC cannot execute advance_stage');

-- The migration adds no access on the protected tables.
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'card_authors'), 0, 'card_authors still has no policy');
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('cards', 'card_authors', 'profiles', 'feedback_cycles')), 0, 'cards, card_authors, profiles, and feedback_cycles are not in supabase_realtime');

-- ---------------------------------------------------------------------------
-- P1 collecting: cards through create_card, then the board cannot reveal.
-- ---------------------------------------------------------------------------
set local role authenticated;
select advance_test.add_card('A', 'P1', 'start', 'A start attributed', false);
select advance_test.add_card('A', 'P1', 'stop', 'A stop anonymous', true);
select advance_test.add_card('B', 'P1', 'continue', 'B continue anonymous', true);
select advance_test.add_card('B', 'P1', 'start', 'B start attributed', false);
select advance_test.add_card('D', 'P1', 'stop', 'D stop attributed', false);
select advance_test.add_card('D', 'P1', 'continue', 'D continue anonymous', true);
reset role;

select advance_test.snap('P1 collecting', advance_test.state(advance_test.id('P1')));
set local role authenticated;
select is(advance_test.adv_err('A', advance_test.id('P1'), 'reveal'), advance_test.denied('stage_out_of_date'), '''reveal'' on a collecting cycle gets stage_out_of_date');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'cluster'), advance_test.denied('stage_out_of_date'), '''cluster'' on a collecting cycle gets stage_out_of_date');
select is(advance_test.adv_err('A', advance_test.id('P1'), null), advance_test.denied('invalid_stage_transition'), 'collecting: null gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), ''), advance_test.denied('invalid_stage_transition'), 'collecting: '''' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'collecting'), advance_test.denied('invalid_stage_transition'), 'collecting: ''collecting'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'vote'), advance_test.denied('invalid_stage_transition'), 'collecting: ''vote'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'discuss'), advance_test.denied('invalid_stage_transition'), 'collecting: ''discuss'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'closed'), advance_test.denied('invalid_stage_transition'), 'collecting: ''closed'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'Reveal'), advance_test.denied('invalid_stage_transition'), 'collecting: ''Reveal'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'bogus'), advance_test.denied('invalid_stage_transition'), 'collecting: ''bogus'' gets invalid_stage_transition');
reset role;
select is(advance_test.state(advance_test.id('P1')), advance_test.snapped('P1 collecting'), 'collecting: status and event count are unchanged after every refusal');
select is(advance_test.state(advance_test.id('P1')) ->> 'status', 'collecting', 'P1 is still collecting');

-- ---------------------------------------------------------------------------
-- A starts P1 through start_retrospective.
-- ---------------------------------------------------------------------------
set local role authenticated;
select advance_test.start('A', advance_test.id('P1'));
reset role;
select is(advance_test.event_list(advance_test.id('P1')), array['collecting>reveal:A'], 'P1 is revealed with one event');
select advance_test.snap('P1 reveal', advance_test.state(advance_test.id('P1')));
select advance_test.snap('cards before', to_jsonb(advance_test.cards_md5()));
set local role authenticated;
select advance_test.snap('board A before', advance_test.board('A', advance_test.id('P1')));
select advance_test.snap('board B before', advance_test.board('B', advance_test.id('P1')));
select advance_test.snap('board D before', advance_test.board('D', advance_test.id('P1')));
reset role;
select is(jsonb_array_length(advance_test.snapped('board B before') -> 'cards'), 6, 'B''s board has all six cards before the advance');

-- ---------------------------------------------------------------------------
-- Who may call it. P1 is in reveal; nothing changes on any refusal.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(advance_test.adv_err('B', advance_test.id('P1'), 'reveal'), advance_test.denied('not_project_facilitator'), 'ordinary member B gets not_project_facilitator');
select is(advance_test.adv_err('D', advance_test.id('P1'), 'reveal'), advance_test.denied('not_project_facilitator'), 'ordinary member D gets not_project_facilitator');
select is(advance_test.adv_err(null, advance_test.id('P1'), 'reveal'), advance_test.denied('not_project_member'), 'a null auth.uid() gets not_project_member');
select is(advance_test.adv_err('A', null, 'reveal'), advance_test.denied('not_project_member'), 'a null cycle id gets not_project_member');
select is(advance_test.adv_err('A', gen_random_uuid(), 'reveal'), advance_test.denied('not_project_member'), 'a random cycle id gets not_project_member');
select is(advance_test.adv_err('C', advance_test.id('P1'), 'reveal'), advance_test.denied('not_project_member'), 'non-member C gets not_project_member');
select is(advance_test.adv_err('C', advance_test.id('P1'), 'reveal'), advance_test.adv_err('C', gen_random_uuid(), 'reveal'), 'an existing cycle and a random UUID give non-member C the same error');
select is(advance_test.adv_err('A', advance_test.id('Q1'), 'reveal'), advance_test.denied('not_project_member'), 'A, a member of another project, gets not_project_member for a Q cycle');
select is(advance_test.adv_err('A', advance_test.id('Q1'), 'reveal'), advance_test.adv_err('A', gen_random_uuid(), 'reveal'), 'a Q cycle and a random UUID give A the same error');
-- Authorization is checked before the from-status.
select is(advance_test.adv_err('C', advance_test.id('P1'), 'bogus'), advance_test.denied('not_project_member'), 'non-member C with ''bogus'' gets not_project_member');
select is(advance_test.adv_err(null, advance_test.id('P1'), 'bogus'), advance_test.denied('not_project_member'), 'a null auth.uid() with ''bogus'' gets not_project_member');
select is(advance_test.adv_err('B', advance_test.id('P1'), 'bogus'), advance_test.denied('not_project_facilitator'), 'member B with ''bogus'' gets not_project_facilitator');
select is(advance_test.adv_err('B', advance_test.id('P1'), null), advance_test.denied('not_project_facilitator'), 'member B with null gets not_project_facilitator');
reset role;
select is(advance_test.state(advance_test.id('P1')), advance_test.snapped('P1 reveal'), 'after every refusal P1''s status and event count are unchanged');

-- ---------------------------------------------------------------------------
-- P1 reveal: every argument the board can never use, and 'cluster'.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(advance_test.adv_err('A', advance_test.id('P1'), null), advance_test.denied('invalid_stage_transition'), 'reveal: null gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), ''), advance_test.denied('invalid_stage_transition'), 'reveal: '''' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'collecting'), advance_test.denied('invalid_stage_transition'), 'reveal: ''collecting'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'vote'), advance_test.denied('invalid_stage_transition'), 'reveal: ''vote'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'discuss'), advance_test.denied('invalid_stage_transition'), 'reveal: ''discuss'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'closed'), advance_test.denied('invalid_stage_transition'), 'reveal: ''closed'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'Reveal'), advance_test.denied('invalid_stage_transition'), 'reveal: ''Reveal'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'bogus'), advance_test.denied('invalid_stage_transition'), 'reveal: ''bogus'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'cluster'), advance_test.denied('stage_out_of_date'), '''cluster'' on a reveal cycle gets stage_out_of_date');
select is(advance_test.try_all('A', advance_test.id('P1'), advance_test.bad_froms() || array['cluster']), 'reveal', 'no argument but ''reveal'' moves a reveal cycle (none moves it to vote, discuss, or closed)');
reset role;
select is(advance_test.state(advance_test.id('P1')), advance_test.snapped('P1 reveal'), 'reveal: status and event count are unchanged after every refusal');

-- ---------------------------------------------------------------------------
-- reveal -> cluster.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(advance_test.adv('A', advance_test.id('P1'), 'reveal'), advance_test.row_of('P1', 'cluster'), 'A advances P1 from reveal: one row (P1, cluster)');
reset role;
select is(advance_test.state(advance_test.id('P1')) ->> 'status', 'cluster', 'P1 is now cluster');
select is(advance_test.state(advance_test.id('P1')) -> 'revealed_at', advance_test.snapped('P1 reveal') -> 'revealed_at', 'revealed_at is unchanged');
select is((advance_test.state(advance_test.id('P1')) ->> 'events')::int, (advance_test.snapped('P1 reveal') ->> 'events')::int + 1, 'exactly one new event');
select is(advance_test.event_list(advance_test.id('P1')), array['collecting>reveal:A', 'reveal>cluster:A'], 'the new event is reveal -> cluster by A');
select is(advance_test.last_event(advance_test.id('P1')) ->> 'type', 'stage_changed', 'the new event type is stage_changed');
select is(advance_test.last_event(advance_test.id('P1')) ->> 'actor_id', advance_test.id('A')::text, 'the new event actor is the caller');
select is(advance_test.last_event(advance_test.id('P1')) -> 'payload', '{}'::jsonb, 'the new event payload is {}');
select is(to_jsonb(advance_test.cards_md5()), advance_test.snapped('cards before'), 'reveal -> cluster changes no cards or card_authors row');
set local role authenticated;
select is(advance_test.board('A', advance_test.id('P1')) - 'status', advance_test.snapped('board A before') - 'status', 'A''s board is unchanged apart from status');
select is(advance_test.board('B', advance_test.id('P1')) - 'status', advance_test.snapped('board B before') - 'status', 'B''s board is unchanged apart from status');
select is(advance_test.board('D', advance_test.id('P1')) - 'status', advance_test.snapped('board D before') - 'status', 'D''s board is unchanged apart from status');
select is(advance_test.board('B', advance_test.id('P1')) ->> 'status', 'cluster', 'B''s board reports cluster');
reset role;

-- Idempotent repeat on cluster.
select advance_test.snap('P1 cluster', advance_test.state(advance_test.id('P1')));
set local role authenticated;
select is(advance_test.adv('A', advance_test.id('P1'), 'reveal'), advance_test.row_of('P1', 'cluster'), 'a repeated ''reveal'' on a cluster cycle returns (P1, cluster)');
reset role;
select is(advance_test.state(advance_test.id('P1')), advance_test.snapped('P1 cluster'), 'the repeat changes nothing and adds no event');

-- P1 cluster: every argument the board can never use.
set local role authenticated;
select is(advance_test.adv_err('A', advance_test.id('P1'), null), advance_test.denied('invalid_stage_transition'), 'cluster: null gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), ''), advance_test.denied('invalid_stage_transition'), 'cluster: '''' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'collecting'), advance_test.denied('invalid_stage_transition'), 'cluster: ''collecting'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'vote'), advance_test.denied('invalid_stage_transition'), 'cluster: ''vote'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'discuss'), advance_test.denied('invalid_stage_transition'), 'cluster: ''discuss'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'closed'), advance_test.denied('invalid_stage_transition'), 'cluster: ''closed'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'Reveal'), advance_test.denied('invalid_stage_transition'), 'cluster: ''Reveal'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'bogus'), advance_test.denied('invalid_stage_transition'), 'cluster: ''bogus'' gets invalid_stage_transition');
select is(advance_test.try_all('A', advance_test.id('P1'), advance_test.bad_froms() || array['reveal']), 'cluster', 'no argument but ''cluster'' moves a cluster cycle (none moves it to discuss or closed)');
reset role;
select is(advance_test.state(advance_test.id('P1')), advance_test.snapped('P1 cluster'), 'cluster: status and event count are unchanged after every refusal');

-- ---------------------------------------------------------------------------
-- cluster -> vote.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(advance_test.adv('A', advance_test.id('P1'), 'cluster'), advance_test.row_of('P1', 'vote'), 'A advances P1 from cluster: one row (P1, vote)');
reset role;
select is(advance_test.state(advance_test.id('P1')) ->> 'status', 'vote', 'P1 is now vote');
select is(advance_test.state(advance_test.id('P1')) -> 'voting_closed_at', 'null'::jsonb, 'voting_closed_at is still null');
select is(advance_test.state(advance_test.id('P1')) -> 'revealed_at', advance_test.snapped('P1 reveal') -> 'revealed_at', 'revealed_at is still unchanged');
select is((advance_test.state(advance_test.id('P1')) ->> 'events')::int, (advance_test.snapped('P1 cluster') ->> 'events')::int + 1, 'exactly one new event');
select is(advance_test.event_list(advance_test.id('P1')), array['collecting>reveal:A', 'reveal>cluster:A', 'cluster>vote:A'], 'the new event is cluster -> vote by A');
select is(advance_test.last_event(advance_test.id('P1')) -> 'payload', '{}'::jsonb, 'the new event payload is {}');
select is(to_jsonb(advance_test.cards_md5()), advance_test.snapped('cards before'), 'cluster -> vote changes no cards or card_authors row');
set local role authenticated;
select is(advance_test.board('A', advance_test.id('P1')) - 'status', advance_test.snapped('board A before') - 'status', 'A''s board is still unchanged apart from status');
select is(advance_test.board('B', advance_test.id('P1')) - 'status', advance_test.snapped('board B before') - 'status', 'B''s board is still unchanged apart from status');
select is(advance_test.board('D', advance_test.id('P1')) - 'status', advance_test.snapped('board D before') - 'status', 'D''s board is still unchanged apart from status');
reset role;

-- Idempotent repeat on vote, and 'reveal' is out of date.
select advance_test.snap('P1 vote', advance_test.state(advance_test.id('P1')));
set local role authenticated;
select is(advance_test.adv('A', advance_test.id('P1'), 'cluster'), advance_test.row_of('P1', 'vote'), 'a repeated ''cluster'' on a vote cycle returns (P1, vote)');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'reveal'), advance_test.denied('stage_out_of_date'), '''reveal'' on a vote cycle gets stage_out_of_date');
select is(advance_test.adv_err('A', advance_test.id('P1'), null), advance_test.denied('invalid_stage_transition'), 'vote: null gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), ''), advance_test.denied('invalid_stage_transition'), 'vote: '''' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'collecting'), advance_test.denied('invalid_stage_transition'), 'vote: ''collecting'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'vote'), advance_test.denied('invalid_stage_transition'), 'vote: ''vote'' gets invalid_stage_transition (advance_stage refuses vote)');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'discuss'), advance_test.denied('invalid_stage_transition'), 'vote: ''discuss'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'closed'), advance_test.denied('invalid_stage_transition'), 'vote: ''closed'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'Reveal'), advance_test.denied('invalid_stage_transition'), 'vote: ''Reveal'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'bogus'), advance_test.denied('invalid_stage_transition'), 'vote: ''bogus'' gets invalid_stage_transition');
select is(advance_test.try_all('A', advance_test.id('P1'), advance_test.bad_froms() || array['reveal', 'cluster']), 'vote', 'no argument moves a vote cycle to discuss or closed');
reset role;
select is(advance_test.state(advance_test.id('P1')), advance_test.snapped('P1 vote'), 'vote: the repeat and every refusal change nothing and add no event');

-- ---------------------------------------------------------------------------
-- P1 discuss (reached as postgres, since close_voting is #24).
-- ---------------------------------------------------------------------------
update public.feedback_cycles set status = 'discuss' where id = '36000000-0000-4000-8000-000000000001';
select advance_test.snap('P1 discuss', advance_test.state(advance_test.id('P1')));
set local role authenticated;
select is(advance_test.adv_err('A', advance_test.id('P1'), 'reveal'), advance_test.denied('stage_out_of_date'), '''reveal'' on a discuss cycle gets stage_out_of_date');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'cluster'), advance_test.denied('stage_out_of_date'), '''cluster'' on a discuss cycle gets stage_out_of_date');
select is(advance_test.adv_err('A', advance_test.id('P1'), null), advance_test.denied('invalid_stage_transition'), 'discuss: null gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), ''), advance_test.denied('invalid_stage_transition'), 'discuss: '''' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'collecting'), advance_test.denied('invalid_stage_transition'), 'discuss: ''collecting'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'vote'), advance_test.denied('invalid_stage_transition'), 'discuss: ''vote'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'discuss'), advance_test.denied('invalid_stage_transition'), 'discuss: ''discuss'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'closed'), advance_test.denied('invalid_stage_transition'), 'discuss: ''closed'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'Reveal'), advance_test.denied('invalid_stage_transition'), 'discuss: ''Reveal'' gets invalid_stage_transition');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'bogus'), advance_test.denied('invalid_stage_transition'), 'discuss: ''bogus'' gets invalid_stage_transition');
select is(advance_test.try_all('A', advance_test.id('P1'), advance_test.bad_froms() || array['reveal', 'cluster']), 'discuss', 'no argument moves a discuss cycle to closed');
reset role;
select is(advance_test.state(advance_test.id('P1')), advance_test.snapped('P1 discuss'), 'discuss: every refusal changes nothing and adds no event');

-- ---------------------------------------------------------------------------
-- P1 closed after reveal.
-- ---------------------------------------------------------------------------
set local role authenticated;
select advance_test.close('A', advance_test.id('P1'));
reset role;
select advance_test.snap('P1 closed', advance_test.state(advance_test.id('P1')));
select is(advance_test.snapped('P1 closed') ->> 'status', 'closed', 'P1 is closed');
set local role authenticated;
select is(advance_test.adv_err('A', advance_test.id('P1'), 'reveal'), advance_test.denied('stage_out_of_date'), '''reveal'' on a cycle closed after reveal gets stage_out_of_date');
select is(advance_test.adv_err('A', advance_test.id('P1'), 'cluster'), advance_test.denied('stage_out_of_date'), '''cluster'' on a cycle closed after reveal gets stage_out_of_date');
reset role;
select is(advance_test.state(advance_test.id('P1')), advance_test.snapped('P1 closed'), 'closed after reveal: status and event count are unchanged');

-- ---------------------------------------------------------------------------
-- P2 closed straight from collecting: revealed_at stays null.
-- ---------------------------------------------------------------------------
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('36000000-0000-4000-8000-000000000002', '26000000-0000-4000-8000-000000000001', 'P early close', '2026-11-02');
set local role authenticated;
select advance_test.close('A', advance_test.id('P2'));
reset role;
select advance_test.snap('P2 closed', advance_test.state(advance_test.id('P2')));
select is(advance_test.snapped('P2 closed') -> 'revealed_at', 'null'::jsonb, 'P2, closed from collecting, has no revealed_at');
set local role authenticated;
select is(advance_test.adv_err('A', advance_test.id('P2'), 'reveal'), advance_test.denied('stage_out_of_date'), '''reveal'' on a cycle closed from collecting gets stage_out_of_date');
select is(advance_test.adv_err('A', advance_test.id('P2'), 'cluster'), advance_test.denied('stage_out_of_date'), '''cluster'' on a cycle closed from collecting gets stage_out_of_date');
reset role;
select is(advance_test.state(advance_test.id('P2')), advance_test.snapped('P2 closed'), 'closed from collecting: status, revealed_at, and event count are unchanged');

-- ---------------------------------------------------------------------------
-- P3: the update and the event are one transaction.
-- ---------------------------------------------------------------------------
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('36000000-0000-4000-8000-000000000003', '26000000-0000-4000-8000-000000000001', 'P third', '2026-11-09');
set local role authenticated;
select advance_test.add_card('B', 'P3', 'start', 'B P3 anonymous', true);
select advance_test.start('A', advance_test.id('P3'));
reset role;
select advance_test.snap('P3 reveal', advance_test.state(advance_test.id('P3')));

alter table public.cycle_events add constraint advance_test_block check (to_status <> 'cluster') not valid;
set local role authenticated;
select is(advance_test.adv_err('A', advance_test.id('P3'), 'reveal') ->> 'code', '23514', 'when the event insert fails, advance_stage fails');
reset role;
select is(advance_test.state(advance_test.id('P3')), advance_test.snapped('P3 reveal'), 'when the event insert fails, P3 stays reveal with no new event');
alter table public.cycle_events drop constraint advance_test_block;

-- ---------------------------------------------------------------------------
-- P3: after transfer_facilitator from A to B, the owner has no right.
-- ---------------------------------------------------------------------------
set local role authenticated;
select advance_test.transfer('A', advance_test.id('P'), advance_test.id('B'));
select is(advance_test.adv_err('A', advance_test.id('P3'), 'reveal'), advance_test.denied('not_project_facilitator'), 'after the transfer, owner A gets not_project_facilitator');
reset role;
select is(advance_test.state(advance_test.id('P3')), advance_test.snapped('P3 reveal'), 'A''s refused call changes nothing');
set local role authenticated;
select is(advance_test.adv('B', advance_test.id('P3'), 'reveal'), advance_test.row_of('P3', 'cluster'), 'the new facilitator B advances P3 to cluster');
reset role;
select is(advance_test.event_list(advance_test.id('P3')), array['collecting>reveal:A', 'reveal>cluster:B'], 'P3''s new event is reveal -> cluster by B');

-- ---------------------------------------------------------------------------
-- Q1 is untouched by everything above.
-- ---------------------------------------------------------------------------
select is(advance_test.state(advance_test.id('Q1')) ->> 'status', 'collecting', 'Q1 is still collecting');
select is((advance_test.state(advance_test.id('Q1')) ->> 'events')::int, 0, 'Q1 has no event');
set local role authenticated;
select is(advance_test.adv_err('C', advance_test.id('Q1'), 'reveal'), advance_test.denied('stage_out_of_date'), 'C, Q''s facilitator, gets stage_out_of_date for ''reveal'' on collecting Q1');
reset role;

select * from finish();

rollback;
