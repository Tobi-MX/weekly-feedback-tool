-- pgTAP tests for get_cycle_board: its shape, what each caller sees before
-- and after reveal, author names and is_mine, anonymous and caller parity,
-- the time- and author-free order (#69), removed members and deleted
-- authors, who may call it, its hardening, and that it adds no table access.
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension and the board_test helper schema. The seed user is
-- never used as a fixture.
--
-- Fixtures: owner and facilitator A, members B, D, and E, non-member C.
-- Project P is owned by A with B, D, and E joined (C joins and is removed
-- again, so C is both a non-member and a removed member of P); project Q is
-- owned by C, and none of A, B, D, or E is ever in Q.
--
-- Cycles: P0 (P, closed early from collecting), P1 (P, the main cycle taken
-- through every status), P2 (P, revealed with zero cards), and Q1 (Q). Cards
-- are created through create_card as each user; only the ordering fixtures
-- are inserted as postgres, with chosen ids and timestamps.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(220);

-- ---------------------------------------------------------------------------
-- Test-only helpers. board, err, and the card RPC helpers are security
-- invoker: they run as the calling role (authenticated) and switch only the
-- JWT claims, so every get_cycle_board call goes through the same grants as a
-- client. problems and all_ids are security definer so they can read the
-- tables the board is checked against.
-- ---------------------------------------------------------------------------
create schema board_test;

create table board_test.ids (label text primary key, id uuid not null);
create table board_test.snaps (label text primary key, body jsonb not null);

insert into board_test.ids (label, id)
values
  ('A', '15000000-0000-4000-8000-000000000001'),
  ('B', '15000000-0000-4000-8000-000000000002'),
  ('C', '15000000-0000-4000-8000-000000000003'),
  ('D', '15000000-0000-4000-8000-000000000004'),
  ('E', '15000000-0000-4000-8000-000000000005'),
  ('P', '25000000-0000-4000-8000-000000000001'),
  ('Q', '25000000-0000-4000-8000-000000000002'),
  ('P0', '35000000-0000-4000-8000-000000000001'),
  ('P1', '35000000-0000-4000-8000-000000000002'),
  ('P2', '35000000-0000-4000-8000-000000000003'),
  ('Q1', '35000000-0000-4000-8000-000000000004'),
  -- Ordering fixtures: the ids, not the times, decide the order.
  ('A1', '1b150000-0000-4000-8000-000000000001'),
  ('B1', '2b150000-0000-4000-8000-000000000002'),
  ('A2', '3b150000-0000-4000-8000-000000000003'),
  ('A4', '4b150000-0000-4000-8000-000000000004'),
  ('B2', '5b150000-0000-4000-8000-000000000005'),
  ('A3', '6b150000-0000-4000-8000-000000000006');

-- The id stored under a label (a user, project, cycle, or card).
create function board_test.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from board_test.ids i where i.label = p_label;
$$;

-- Signs in as the labelled user, or with no sub when the label is null.
create function board_test.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', board_test.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- The caller's board for a labelled cycle.
create function board_test.board(p_user text, p_cycle text)
returns jsonb
language plpgsql
as $$
begin
  perform board_test.become(p_user);
  return public.get_cycle_board(board_test.id(p_cycle));
end;
$$;

-- The full error (code, message, detail, hint) of the caller's call, or "ok".
create function board_test.err(p_user text, p_cycle uuid)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform board_test.become(p_user);
  perform public.get_cycle_board(p_cycle);
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

-- create_card as the user; the card text is its label, and its id is stored.
create function board_test.add_card(p_user text, p_cycle text, p_category text, p_label text, p_anonymous boolean)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform board_test.become(p_user);
  select c.id into strict new_id
    from public.create_card(board_test.id(p_cycle), p_category, p_label, p_anonymous) c;
  insert into board_test.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

-- update_card as the user.
create function board_test.edit_card(p_user text, p_label text, p_text text, p_anonymous boolean)
returns void
language plpgsql
as $$
begin
  perform board_test.become(p_user);
  perform 1 from public.update_card(board_test.id(p_label), p_text, p_anonymous);
end;
$$;

-- delete_card as the user.
create function board_test.remove_card(p_user text, p_label text)
returns void
language plpgsql
as $$
begin
  perform board_test.become(p_user);
  perform public.delete_card(board_test.id(p_label));
end;
$$;

-- The card object with the labelled id in a response, or null.
create function board_test.card(p_resp jsonb, p_label text)
returns jsonb
language sql
stable
as $$
  select c from jsonb_array_elements(p_resp -> 'cards') c where c ->> 'card_id' = board_test.id(p_label)::text;
$$;

-- The 1-based position of the labelled card in a response, or null.
create function board_test.pos(p_resp jsonb, p_label text)
returns integer
language sql
stable
as $$
  select o::int from jsonb_array_elements(p_resp -> 'cards') with ordinality e(c, o) where c ->> 'card_id' = board_test.id(p_label)::text;
$$;

-- The card ids of a response, in response order.
create function board_test.card_ids(p_resp jsonb)
returns uuid[]
language sql
immutable
as $$
  select coalesce(array_agg((c ->> 'card_id')::uuid order by o), '{}') from jsonb_array_elements(p_resp -> 'cards') with ordinality e(c, o);
$$;

-- The sorted key set of a jsonb object.
create function board_test.keys(p_obj jsonb)
returns text[]
language sql
immutable
as $$
  select array_agg(k order by k) from jsonb_object_keys(p_obj) k;
$$;

-- The anonymous card objects of a response, in response order.
create function board_test.anon_cards(p_resp jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(c order by o), '[]') from jsonb_array_elements(p_resp -> 'cards') with ordinality e(c, o) where (c ->> 'is_anonymous')::boolean;
$$;

-- The response with is_mine removed from every card.
create function board_test.strip_mine(p_resp jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_set(
    p_resp,
    '{cards}',
    (select coalesce(jsonb_agg(c - 'is_mine' order by o), '[]') from jsonb_array_elements(p_resp -> 'cards') with ordinality e(c, o))
  );
$$;

-- Every forbidden key found at any depth of a response.
create function board_test.forbidden(p_resp jsonb)
returns text[]
language sql
immutable
as $$
  select array_agg(distinct k order by k)
  from jsonb_path_query(p_resp, 'strict $.**') v(j)
  cross join lateral jsonb_object_keys(case when jsonb_typeof(v.j) = 'object' then v.j else '{}'::jsonb end) k
  where k in ('created_at', 'updated_at', 'author_id', 'user_id', 'email', 'avatar_url', 'revealed_at');
$$;

-- Every card id of a cycle in the expected board order, read as postgres.
create function board_test.all_ids(p_cycle text)
returns uuid[]
language sql
stable
security definer
as $$
  select coalesce(array_agg(c.id order by array_position(array['start', 'stop', 'continue'], c.category), c.id), '{}')
  from public.cards c
  where c.cycle_id = board_test.id(p_cycle);
$$;

-- Every rule a member's response must meet, as a list of the broken ones.
-- Empty means the response is right for this caller and this cycle state.
create function board_test.problems(p_user text, p_cycle text, p_resp jsonb)
returns text[]
language plpgsql
security definer
as $$
declare
  result text[] := '{}';
  uid uuid := board_test.id(p_user);
  cyc uuid := board_test.id(p_cycle);
  revealed boolean;
  status_row record;
  returned uuid[];
  expected uuid[];
begin
  if board_test.keys(p_resp) is distinct from array['cards', 'clusters', 'cycle_id', 'is_revealed', 'status'] then
    result := result || 'top-level keys'::text;
  end if;
  if jsonb_typeof(p_resp -> 'cards') is distinct from 'array' then
    return result || 'cards is not an array'::text;
  end if;
  if p_resp -> 'cycle_id' is distinct from to_jsonb(cyc) then
    result := result || 'cycle_id'::text;
  end if;
  if p_resp -> 'status' is distinct from (select to_jsonb(fc.status) from public.feedback_cycles fc where fc.id = cyc) then
    result := result || 'status'::text;
  end if;

  select fc.revealed_at is not null into revealed from public.feedback_cycles fc where fc.id = cyc;

  perform board_test.become(p_user);
  select s.* into strict status_row from public.get_cycle_status(cyc) s;
  if p_resp -> 'is_revealed' is distinct from to_jsonb(status_row.is_revealed)
     or p_resp -> 'is_revealed' is distinct from to_jsonb(revealed) then
    result := result || 'is_revealed'::text;
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_resp -> 'cards') c
    where jsonb_typeof(c) <> 'object'
       or c -> 'is_anonymous' not in ('true'::jsonb, 'false'::jsonb)
       or ((c ->> 'is_anonymous')::boolean and board_test.keys(c) is distinct from array['card_id', 'category', 'is_anonymous', 'text'])
       or (not (c ->> 'is_anonymous')::boolean and board_test.keys(c) is distinct from array['author_display_name', 'card_id', 'category', 'is_anonymous', 'is_mine', 'text'])
  ) then
    result := result || 'card keys'::text;
  end if;

  if board_test.forbidden(p_resp) is not null then
    result := result || 'forbidden key'::text;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_resp -> 'cards') c
    left join public.cards x on x.id = (c ->> 'card_id')::uuid
    where x.id is null
       or x.cycle_id <> cyc
       or c -> 'category' is distinct from to_jsonb(x.category)
       or c -> 'text' is distinct from to_jsonb(x.text)
       or c -> 'is_anonymous' is distinct from to_jsonb(x.is_anonymous)
  ) then
    result := result || 'card values'::text;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_resp -> 'cards') c
    join public.cards x on x.id = (c ->> 'card_id')::uuid
    left join public.card_authors ca on ca.card_id = x.id
    left join public.profiles p on p.id = ca.author_id
    where not x.is_anonymous
      and (c -> 'is_mine' is distinct from to_jsonb(coalesce(ca.author_id = uid, false))
           or c -> 'author_display_name' is distinct from coalesce(to_jsonb(p.display_name), 'null'::jsonb))
  ) then
    result := result || 'is_mine or author name'::text;
  end if;

  returned := board_test.card_ids(p_resp);
  select coalesce(array_agg(x.id order by array_position(array['start', 'stop', 'continue'], x.category), x.id), '{}')
    into expected
    from public.cards x
   where x.id = any(returned);
  if returned is distinct from expected or cardinality(returned) <> (select count(distinct r) from unnest(returned) r) then
    result := result || 'order'::text;
  end if;

  if revealed then
    if returned is distinct from board_test.all_ids(p_cycle) then
      result := result || 'not every card of the cycle'::text;
    end if;
    if cardinality(returned) is distinct from status_row.card_count
       or cardinality(returned) <> (select count(*) from public.cards x where x.cycle_id = cyc) then
      result := result || 'count is not card_count'::text;
    end if;
  else
    select coalesce(array_agg(m.id order by m.id), '{}') into expected from public.get_my_cards(cyc) m;
    if (select coalesce(array_agg(r order by r), '{}') from unnest(returned) r) is distinct from expected then
      result := result || 'not exactly get_my_cards'::text;
    end if;
    if cardinality(returned) is distinct from status_row.my_card_count then
      result := result || 'count is not my_card_count'::text;
    end if;
  end if;

  return result;
end;
$$;

-- The error every denied caller gets.
create function board_test.denied()
returns jsonb
language sql
immutable
as $$
  select '{"code":"42501","message":"not_project_member","detail":"","hint":""}'::jsonb;
$$;

-- Every denied case for a cycle, as a list of the ones that were not denied
-- exactly. C is both a non-member and a removed member of P.
create function board_test.denials(p_cycle text)
returns text[]
language plpgsql
as $$
declare
  result text[] := '{}';
begin
  if board_test.err(null, board_test.id(p_cycle)) is distinct from board_test.denied() then
    result := result || 'null auth.uid()'::text;
  end if;
  if board_test.err('A', null) is distinct from board_test.denied() then
    result := result || 'null cycle id'::text;
  end if;
  if board_test.err('A', gen_random_uuid()) is distinct from board_test.denied() then
    result := result || 'random uuid'::text;
  end if;
  if board_test.err('A', board_test.id('B in P0')) is distinct from board_test.denied() then
    result := result || 'card id as cycle id'::text;
  end if;
  if board_test.err('C', board_test.id(p_cycle)) is distinct from board_test.denied() then
    result := result || 'non-member and removed member C'::text;
  end if;
  if board_test.err('B', board_test.id('Q1')) is distinct from board_test.denied() then
    result := result || 'member B on project Q'::text;
  end if;
  return result;
end;
$$;

-- Stores a response under a label, and reads it back.
create function board_test.snap(p_label text, p_body jsonb)
returns void
language sql
as $$
  insert into board_test.snaps (label, body) values (p_label, p_body)
  on conflict (label) do update set body = excluded.body;
$$;

create function board_test.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.body from board_test.snaps s where s.label = p_label;
$$;

grant usage on schema board_test to authenticated;
grant select, insert, update on all tables in schema board_test to authenticated;
grant execute on all functions in schema board_test to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures. Inserting auth.users rows fires private.handle_new_user(), and
-- inserting projects fires the owner-membership trigger (owner = facilitator).
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-000000000000', '15000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'board-a@example.com', '{"display_name":"Alice"}'),
  ('00000000-0000-0000-0000-000000000000', '15000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'board-b@example.com', '{"display_name":"Bob"}'),
  ('00000000-0000-0000-0000-000000000000', '15000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'board-c@example.com', '{"display_name":"Cara"}'),
  ('00000000-0000-0000-0000-000000000000', '15000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'board-d@example.com', '{"display_name":"Dan"}'),
  ('00000000-0000-0000-0000-000000000000', '15000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'board-e@example.com', '{"display_name":"Eve"}');

insert into public.projects (id, name, owner_id)
values
  ('25000000-0000-4000-8000-000000000001', 'Project P', '15000000-0000-4000-8000-000000000001'),
  ('25000000-0000-4000-8000-000000000002', 'Project Q', '15000000-0000-4000-8000-000000000003');

-- C joins P and is removed again, so C is a removed member of P from here on.
insert into public.project_members (project_id, user_id, role)
values
  ('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000002', 'member'),
  ('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000003', 'member'),
  ('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000004', 'member'),
  ('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000005', 'member');
delete from public.project_members where project_id = '25000000-0000-4000-8000-000000000001' and user_id = '15000000-0000-4000-8000-000000000003';

insert into public.feedback_cycles (id, project_id, title, week_start)
values
  ('35000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000001', 'P earlier', '2026-10-12'),
  ('35000000-0000-4000-8000-000000000004', '25000000-0000-4000-8000-000000000002', 'Q week', '2026-10-26');

-- ---------------------------------------------------------------------------
-- Shape.
-- ---------------------------------------------------------------------------
select has_function('public', 'get_cycle_board', array['uuid'], 'get_cycle_board(uuid) exists');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_cycle_board'), 1, 'get_cycle_board has exactly one overload');
select is(pg_get_function_identity_arguments('public.get_cycle_board(uuid)'::regprocedure), 'p_cycle_id uuid', 'get_cycle_board takes only the cycle id');
select is(pg_get_function_result('public.get_cycle_board(uuid)'::regprocedure), 'jsonb', 'get_cycle_board returns jsonb');

-- ---------------------------------------------------------------------------
-- The function body: data scope, side channels, and RPC hardening.
-- ---------------------------------------------------------------------------
select is((select prosrc ~* '(votes|voting_closed_at)' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), false, 'the body does not mention votes or voting_closed_at');
select is((select prosrc ~ 'revealed_at' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), true, 'the body decides on revealed_at');
select is((select prosrc ~* 'created_at' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), false, 'the body does not mention created_at');
select is((select prosrc ~* 'updated_at' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), false, 'the body does not mention updated_at');
select is((select prosrc ~* 'is_project_facilitator' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), false, 'the body has no facilitator branch');
select is((select prosrc ~* 'owner_id' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), false, 'the body has no owner branch');
select is((select prosrc ~* 'email' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), false, 'the body does not mention email');
select is((select prosrc ~* 'avatar_url' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), false, 'the body does not mention avatar_url');
select is((select prosrc ~* 'pg_sleep' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), false, 'the body does not call pg_sleep');
select is((select prosrc ~* 'execute' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), false, 'the body uses no dynamic SQL');
select is((select prosrc ~* '\mloop\M' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), false, 'the body has no loop: the cards come from one set-based query');
select is((select prosrc ~* 'jsonb_agg\(' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), true, 'the cards are built with jsonb_agg');
select is((select prosecdef from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), true, 'get_cycle_board is security definer');
select is((select provolatile::text from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), 's', 'get_cycle_board is stable');
select is((select proconfig from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), array['search_path=""']::text[], 'get_cycle_board fixes search_path to empty');
select is((select prosrc ~ '\(select auth\.uid\(\)\) is null' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), true, 'get_cycle_board checks (select auth.uid()) inside the function');
select is((select prosrc ~ 'private\.is_project_member\(cycle_project\)' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), true, 'get_cycle_board uses private.is_project_member');
select is((select prosrc ~* 'raise\s+(notice|log|info|debug|warning)' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), false, 'get_cycle_board raises no notice, log, info, debug, or warning');
select is(
  (select array_agg(distinct m.msg[1]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'message\s*=\s*''([^'']*)''', 'g') as m(msg) where p.oid = 'public.get_cycle_board(uuid)'::regprocedure),
  array['not_project_member'],
  'the only error message is not_project_member'
);
select is(
  (select (select count(*) from regexp_matches(p.prosrc, '\mraise\M', 'gi'))::int from pg_proc p where p.oid = 'public.get_cycle_board(uuid)'::regprocedure),
  (select (select count(*) from regexp_matches(p.prosrc, 'raise exception using errcode = ''42501'', message = ''not_project_member'';', 'g'))::int from pg_proc p where p.oid = 'public.get_cycle_board(uuid)'::regprocedure),
  'every raise is 42501 not_project_member with no detail or hint'
);
select is((select prosrc ~* '(detail|hint)\s*=' from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), false, 'no raise sets a detail or hint');
select is(has_function_privilege('anon', 'public.get_cycle_board(uuid)', 'EXECUTE'), false, 'anon cannot execute get_cycle_board');
select is(has_function_privilege('authenticated', 'public.get_cycle_board(uuid)', 'EXECUTE'), true, 'authenticated can execute get_cycle_board');
select is(has_function_privilege('service_role', 'public.get_cycle_board(uuid)', 'EXECUTE'), false, 'service_role is not granted get_cycle_board');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.get_cycle_board(uuid)'::regprocedure), 0, 'PUBLIC cannot execute get_cycle_board');
select is(
  (select array_agg(r.rolname::text order by r.rolname) from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid = a.grantee where p.oid = 'public.get_cycle_board(uuid)'::regprocedure and a.grantee <> p.proowner),
  array['authenticated'],
  'execute on get_cycle_board is granted only to authenticated'
);
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and (has_function_privilege('anon', p.oid, 'EXECUTE') or (has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.proname not in ('is_project_member', 'is_project_facilitator')))),
  null,
  'no new private helper is executable by anon or authenticated'
);
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.prosrc ~ 'card_authors'), 0, 'no private helper reads card_authors');

-- ---------------------------------------------------------------------------
-- The migration adds no table access on cards, card_authors,
-- project_members, or profiles.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'cards'), 0, 'cards still has no policy');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'card_authors'), 0, 'card_authors still has no policy');
select is((select array_agg(policyname::text order by policyname) from pg_policies where schemaname = 'public' and tablename = 'profiles'), array['profiles_select_own', 'profiles_update_own'], 'profiles keeps exactly its own-row policies');
select is((select array_agg(policyname::text order by policyname) from pg_policies where schemaname = 'public' and tablename = 'project_members'), array['project_members_select_member'], 'project_members keeps only its select policy');
select is(
  (select array_agg(r || ':' || t || ':' || p order by r, t, p) from unnest(array['anon', 'authenticated']) r cross join unnest(array['public.cards', 'public.card_authors', 'public.project_members', 'public.profiles']) t cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege(r, t, p)),
  array['authenticated:public.profiles:SELECT', 'authenticated:public.project_members:SELECT'],
  'anon and authenticated have no new table privilege on the four tables'
);
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('cards', 'card_authors', 'project_members', 'profiles')), 0, 'none of the four tables is in the supabase_realtime publication');
select is((select count(*)::int from pg_depend d join pg_rewrite r on r.oid = d.objid where d.classid = 'pg_rewrite'::regclass and d.refobjid in ('public.cards'::regclass, 'public.card_authors'::regclass, 'public.profiles'::regclass)), 0, 'no view reads cards, card_authors, or profiles');

-- ---------------------------------------------------------------------------
-- P0: closed early from collecting, so never revealed.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(
  board_test.board('A', 'P0'),
  jsonb_build_object('cycle_id', board_test.id('P0'), 'status', 'collecting', 'is_revealed', false, 'cards', '[]'::jsonb, 'clusters', '[]'::jsonb),
  'P0 collecting with no cards: A gets exactly the five keys, cards = [] and clusters = []'
);
select isnt(board_test.add_card('B', 'P0', 'start', 'B in P0', false), null, 'B adds an attributed card in P0');
select is(
  board_test.board('B', 'P0') -> 'cards',
  jsonb_build_array(jsonb_build_object('card_id', board_test.id('B in P0'), 'category', 'start', 'text', 'B in P0', 'is_anonymous', false, 'is_mine', true, 'author_display_name', 'Bob')),
  'P0 collecting: B gets their own card with is_mine and their own name'
);
select is(board_test.board('A', 'P0') -> 'cards', '[]'::jsonb, 'P0 collecting: owner and facilitator A does not get B''s card');

set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select * from public.close_cycle('35000000-0000-4000-8000-000000000001') $$, 'A closes P0 early from collecting');

select is(board_test.problems('A', 'P0', board_test.board('A', 'P0')), '{}'::text[], 'P0 closed early: A''s board meets every rule');
select is(board_test.problems('B', 'P0', board_test.board('B', 'P0')), '{}'::text[], 'P0 closed early: B''s board meets every rule');
select is(board_test.problems('D', 'P0', board_test.board('D', 'P0')), '{}'::text[], 'P0 closed early: D''s board meets every rule');
select is(board_test.problems('E', 'P0', board_test.board('E', 'P0')), '{}'::text[], 'P0 closed early: E''s board meets every rule');
select is(board_test.board('A', 'P0') - 'cards', jsonb_build_object('cycle_id', board_test.id('P0'), 'status', 'closed', 'is_revealed', false, 'clusters', '[]'::jsonb), 'P0 closed early: status closed, is_revealed false');
select is(jsonb_array_length(board_test.board('B', 'P0') -> 'cards'), 1, 'P0 closed early: B gets one card');
select is(board_test.card_ids(board_test.board('B', 'P0')), array[board_test.id('B in P0')], 'P0 closed early: B''s one card is their own');
select is(board_test.board('A', 'P0') -> 'cards', '[]'::jsonb, 'P0 closed early: A gets []');
select is(board_test.board('D', 'P0') -> 'cards', '[]'::jsonb, 'P0 closed early: D gets []');
select is(board_test.board('E', 'P0') -> 'cards', '[]'::jsonb, 'P0 closed early: E gets []');
select is(board_test.denials('P0'), '{}'::text[], 'P0 closed early: every denied case gets exactly not_project_member');
reset role;

-- P1 opens once P0 is closed.
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('35000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000001', 'P week', '2026-10-26');

-- ---------------------------------------------------------------------------
-- P1 collecting.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(board_test.board('A', 'P1') -> 'cards', '[]'::jsonb, 'P1 empty: A gets []');
select is(jsonb_typeof(board_test.board('B', 'P1') -> 'cards'), 'array', 'P1 empty: cards is an array, not null');
select is(board_test.problems('B', 'P1', board_test.board('B', 'P1')), '{}'::text[], 'P1 empty: B''s board meets every rule');

select isnt(board_test.add_card('A', 'P1', 'start', 'A start attr', false), null, 'A adds an attributed start card');
select isnt(board_test.add_card('A', 'P1', 'stop', 'A stop anon', true), null, 'A adds an anonymous stop card');
select isnt(board_test.add_card('A', 'P1', 'continue', 'A continue attr', false), null, 'A adds an attributed continue card');
select isnt(board_test.add_card('B', 'P1', 'start', 'B start attr', false), null, 'B adds an attributed start card');
select isnt(board_test.add_card('B', 'P1', 'start', 'B start anon', true), null, 'B adds an anonymous start card');
select isnt(board_test.add_card('B', 'P1', 'continue', 'B continue anon', true), null, 'B adds an anonymous continue card');
select isnt(board_test.add_card('D', 'P1', 'stop', 'D stop attr', false), null, 'D adds an attributed stop card');
select isnt(board_test.add_card('D', 'P1', 'start', 'D start anon', true), null, 'D adds an anonymous start card');
select is(board_test.board('E', 'P1') -> 'cards', '[]'::jsonb, 'P1: E, with no cards yet, gets []');
select isnt(board_test.add_card('E', 'P1', 'continue', 'E continue attr', false), null, 'E adds an attributed continue card');
select isnt(board_test.add_card('E', 'P1', 'stop', 'E stop anon', true), null, 'E adds an anonymous stop card');
select isnt(board_test.add_card('C', 'Q1', 'start', 'C in Q1', false), null, 'C adds a card in Q1');
reset role;

-- Ordering fixtures, inserted as postgres with chosen ids and times. A1 and
-- A2 are A's, written one minute apart; B1 is B's, written later. A3, B2,
-- and A4 swap the ids around: A3 is A's earliest but has the highest id.
insert into public.cards (id, cycle_id, category, text, is_anonymous, created_at, updated_at)
values
  ('1b150000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000002', 'start', 'order A1', true, '2026-10-26 09:00+00', '2026-10-26 09:00+00'),
  ('2b150000-0000-4000-8000-000000000002', '35000000-0000-4000-8000-000000000002', 'start', 'order B1', false, '2026-10-26 11:00+00', '2026-10-26 11:00+00'),
  ('3b150000-0000-4000-8000-000000000003', '35000000-0000-4000-8000-000000000002', 'start', 'order A2', true, '2026-10-26 09:01+00', '2026-10-26 09:01+00'),
  ('6b150000-0000-4000-8000-000000000006', '35000000-0000-4000-8000-000000000002', 'start', 'order A3', true, '2026-10-27 09:00+00', '2026-10-27 09:00+00'),
  ('5b150000-0000-4000-8000-000000000005', '35000000-0000-4000-8000-000000000002', 'start', 'order B2', false, '2026-10-27 11:00+00', '2026-10-27 11:00+00'),
  ('4b150000-0000-4000-8000-000000000004', '35000000-0000-4000-8000-000000000002', 'start', 'order A4', true, '2026-10-27 09:01+00', '2026-10-27 09:01+00');
insert into public.card_authors (card_id, author_id)
values
  ('1b150000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001'),
  ('2b150000-0000-4000-8000-000000000002', '15000000-0000-4000-8000-000000000002'),
  ('3b150000-0000-4000-8000-000000000003', '15000000-0000-4000-8000-000000000001'),
  ('6b150000-0000-4000-8000-000000000006', '15000000-0000-4000-8000-000000000001'),
  ('5b150000-0000-4000-8000-000000000005', '15000000-0000-4000-8000-000000000002'),
  ('4b150000-0000-4000-8000-000000000004', '15000000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.cards where cycle_id = '35000000-0000-4000-8000-000000000002'), 16, 'P1 holds sixteen cards');

set local role authenticated;
select is(board_test.problems('A', 'P1', board_test.board('A', 'P1')), '{}'::text[], 'collecting: A''s board meets every rule (own cards only, get_my_cards ids, my_card_count, order)');
select is(board_test.problems('B', 'P1', board_test.board('B', 'P1')), '{}'::text[], 'collecting: B''s board meets every rule');
select is(board_test.problems('D', 'P1', board_test.board('D', 'P1')), '{}'::text[], 'collecting: D''s board meets every rule');
select is(board_test.problems('E', 'P1', board_test.board('E', 'P1')), '{}'::text[], 'collecting: E''s board meets every rule');
select is(jsonb_array_length(board_test.board('A', 'P1') -> 'cards'), 7, 'collecting: A gets their seven cards');
select is(jsonb_array_length(board_test.board('B', 'P1') -> 'cards'), 5, 'collecting: B gets their five cards');
select is(jsonb_array_length(board_test.board('D', 'P1') -> 'cards'), 2, 'collecting: D gets their two cards');
select is(board_test.board('A', 'P1') -> 'is_revealed', 'false'::jsonb, 'collecting: is_revealed is false');
select is(
  board_test.card(board_test.board('B', 'P1'), 'B start attr'),
  jsonb_build_object('card_id', board_test.id('B start attr'), 'category', 'start', 'text', 'B start attr', 'is_anonymous', false, 'is_mine', true, 'author_display_name', 'Bob'),
  'collecting: B''s attributed card has is_mine true and B''s own name'
);
select is(
  board_test.card(board_test.board('B', 'P1'), 'B start anon'),
  jsonb_build_object('card_id', board_test.id('B start anon'), 'category', 'start', 'text', 'B start anon', 'is_anonymous', true),
  'collecting: B''s anonymous card has the four keys only'
);
select is(board_test.card(board_test.board('A', 'P1'), 'B start attr'), null, 'collecting: owner and facilitator A does not get B''s card');
select is(board_test.card(board_test.board('A', 'P1'), 'D start anon'), null, 'collecting: owner and facilitator A does not get D''s anonymous card');
select is(board_test.card(board_test.board('B', 'P1'), 'A start attr'), null, 'collecting: B does not get A''s card');
select ok(board_test.pos(board_test.board('A', 'P1'), 'A1') < board_test.pos(board_test.board('A', 'P1'), 'A2'), 'collecting: A''s own cards follow the ids too');

-- update_card and delete_card show on the next call.
select isnt(board_test.add_card('B', 'P1', 'stop', 'B temp', false), null, 'B adds a temporary attributed card');
select is(board_test.card(board_test.board('B', 'P1'), 'B temp') ->> 'text', 'B temp', 'B''s new card is on the next call');
select lives_ok($$ select board_test.edit_card('B', 'B temp', 'B temp edited', false) $$, 'B edits the card''s text');
select is(board_test.card(board_test.board('B', 'P1'), 'B temp') ->> 'text', 'B temp edited', 'the next call returns the current text');
select lives_ok($$ select board_test.edit_card('B', 'B temp', 'B temp edited', true) $$, 'B makes the card anonymous');
select is(
  board_test.card(board_test.board('B', 'P1'), 'B temp'),
  jsonb_build_object('card_id', board_test.id('B temp'), 'category', 'stop', 'text', 'B temp edited', 'is_anonymous', true),
  'attributed turned anonymous loses is_mine and author_display_name'
);
select lives_ok($$ select board_test.edit_card('B', 'B temp', 'B temp edited', false) $$, 'B makes the card attributed again');
select is(
  board_test.card(board_test.board('B', 'P1'), 'B temp'),
  jsonb_build_object('card_id', board_test.id('B temp'), 'category', 'stop', 'text', 'B temp edited', 'is_anonymous', false, 'is_mine', true, 'author_display_name', 'Bob'),
  'anonymous turned attributed gains is_mine and author_display_name'
);
select lives_ok($$ select board_test.remove_card('B', 'B temp') $$, 'B deletes the card');
select is(board_test.card(board_test.board('B', 'P1'), 'B temp'), null, 'the deleted card is gone on the next call');
select is(board_test.problems('B', 'P1', board_test.board('B', 'P1')), '{}'::text[], 'collecting: B''s board meets every rule after the edits');
select is(board_test.denials('P1'), '{}'::text[], 'collecting: every denied case gets exactly not_project_member');

-- The checker itself catches broken responses.
select ok('not exactly get_my_cards' = any(board_test.problems('A', 'P1', board_test.board('B', 'P1'))), 'checker: B''s cards in A''s pre-reveal board are flagged');
select ok('forbidden key' = any(board_test.problems('A', 'P1', jsonb_set(board_test.board('A', 'P1'), '{cards,0,created_at}', '"2026-10-26"')))
  and 'card keys' = any(board_test.problems('A', 'P1', jsonb_set(board_test.board('A', 'P1'), '{cards,0,created_at}', '"2026-10-26"'))), 'checker: a card with created_at is flagged');
select ok('card keys' = any(board_test.problems('A', 'P1', board_test.strip_mine(board_test.board('A', 'P1')))), 'checker: an attributed card without is_mine is flagged');
select ok('order' = any(board_test.problems('A', 'P1', jsonb_set(board_test.board('A', 'P1'), '{cards}', (select jsonb_agg(c order by o desc) from jsonb_array_elements(board_test.board('A', 'P1') -> 'cards') with ordinality e(c, o))))), 'checker: a reversed order is flagged');
select ok('is_mine or author name' = any(board_test.problems('B', 'P1', board_test.board('A', 'P1'))), 'checker: A''s is_mine values in B''s response are flagged');

-- ---------------------------------------------------------------------------
-- reveal, through #14's start_retrospective.
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select * from public.start_retrospective('35000000-0000-4000-8000-000000000002') $$, 'A starts the retrospective on P1');

select is(board_test.problems('A', 'P1', board_test.board('A', 'P1')), '{}'::text[], 'reveal: A''s board meets every rule (every card, card_count, order)');
select is(board_test.problems('B', 'P1', board_test.board('B', 'P1')), '{}'::text[], 'reveal: B''s board meets every rule');
select is(board_test.problems('D', 'P1', board_test.board('D', 'P1')), '{}'::text[], 'reveal: D''s board meets every rule');
select is(board_test.problems('E', 'P1', board_test.board('E', 'P1')), '{}'::text[], 'reveal: E''s board meets every rule');
select is(board_test.board('B', 'P1') - 'cards', jsonb_build_object('cycle_id', board_test.id('P1'), 'status', 'reveal', 'is_revealed', true, 'clusters', '[]'::jsonb), 'reveal: status reveal, is_revealed true');
select is(jsonb_array_length(board_test.board('B', 'P1') -> 'cards'), 16, 'reveal: B gets all sixteen cards');
select is(board_test.card_ids(board_test.board('D', 'P1')), board_test.all_ids('P1'), 'reveal: D''s ids are exactly the cycle''s cards in category, then id order');
select is(board_test.forbidden(board_test.board('E', 'P1')), null, 'reveal: no created_at, updated_at, author_id, user_id, email, avatar_url, or revealed_at at any depth');

-- Author names and is_mine.
select is(
  board_test.card(board_test.board('A', 'P1'), 'B start attr'),
  jsonb_build_object('card_id', board_test.id('B start attr'), 'category', 'start', 'text', 'B start attr', 'is_anonymous', false, 'is_mine', false, 'author_display_name', 'Bob'),
  'reveal: A sees B''s attributed card with B''s name and is_mine false'
);
select is(board_test.card(board_test.board('B', 'P1'), 'B start attr') -> 'is_mine', 'true'::jsonb, 'reveal: B sees is_mine true on their own attributed card');
select is(
  board_test.card(board_test.board('B', 'P1'), 'B start anon'),
  jsonb_build_object('card_id', board_test.id('B start anon'), 'category', 'start', 'text', 'B start anon', 'is_anonymous', true),
  'reveal: B''s own anonymous card is not marked for B'
);
select is(
  (select array_agg(c ->> 'text' order by c ->> 'text') from jsonb_array_elements(board_test.board('A', 'P1') -> 'cards') c where (c ->> 'is_mine')::boolean),
  array['A continue attr', 'A start attr'],
  'reveal: is_mine is true exactly on A''s own attributed cards'
);
select is(
  (select array_agg(c ->> 'text' order by c ->> 'text') from jsonb_array_elements(board_test.board('B', 'P1') -> 'cards') c where (c ->> 'is_mine')::boolean),
  array['B start attr', 'order B1', 'order B2'],
  'reveal: is_mine is true exactly on B''s own attributed cards'
);
reset role;

-- A member who wrote no attributed card: C joins P for a moment.
insert into public.project_members (project_id, user_id, role)
values ('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000003', 'member');
set local role authenticated;
select is(board_test.problems('C', 'P1', board_test.board('C', 'P1')), '{}'::text[], 'reveal: C, joined after reveal with no cards, gets every card');
select is(
  (select count(*)::int from jsonb_array_elements(board_test.board('C', 'P1') -> 'cards') c where c -> 'is_mine' <> 'false'::jsonb),
  0,
  'reveal: for a caller with no attributed card every is_mine is false'
);
reset role;
delete from public.project_members where project_id = '25000000-0000-4000-8000-000000000001' and user_id = '15000000-0000-4000-8000-000000000003';

-- A display name change shows on the next call.
update public.profiles set display_name = 'Robert' where id = '15000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(board_test.card(board_test.board('D', 'P1'), 'B start attr') ->> 'author_display_name', 'Robert', 'reveal: B''s new display name shows on the next call');
select is(board_test.problems('A', 'P1', board_test.board('A', 'P1')), '{}'::text[], 'reveal: A''s board still meets every rule after the rename');

-- Anonymous parity and caller parity.
select ok(jsonb_array_length(board_test.anon_cards(board_test.board('A', 'P1'))) = 9, 'reveal: the board has nine anonymous cards');
select is(board_test.anon_cards(board_test.board('B', 'P1')), board_test.anon_cards(board_test.board('A', 'P1')), 'reveal: anonymous cards are equal for author B and owner-facilitator A');
select is(board_test.anon_cards(board_test.board('D', 'P1')), board_test.anon_cards(board_test.board('A', 'P1')), 'reveal: anonymous cards are equal for D and A');
select is(board_test.anon_cards(board_test.board('E', 'P1')), board_test.anon_cards(board_test.board('B', 'P1')), 'reveal: anonymous cards are equal for E and B');
select is(board_test.card(board_test.board('D', 'P1'), 'D start anon'), board_test.card(board_test.board('A', 'P1'), 'D start anon'), 'reveal: D''s anonymous card is the same for its author and the facilitator');
select is(board_test.strip_mine(board_test.board('A', 'P1')), board_test.strip_mine(board_test.board('B', 'P1')), 'reveal: A and B get the same response apart from is_mine');
select is(board_test.strip_mine(board_test.board('D', 'P1')), board_test.strip_mine(board_test.board('B', 'P1')), 'reveal: D and B get the same response apart from is_mine');
select is(board_test.strip_mine(board_test.board('E', 'P1')), board_test.strip_mine(board_test.board('A', 'P1')), 'reveal: E and A get the same response apart from is_mine');

-- Order: category, then card_id; never time or author.
select is(board_test.card_ids(board_test.board('A', 'P1')), board_test.all_ids('P1'), 'reveal: the order is category (start, stop, continue), then card_id');
select is(
  (select array_agg(distinct c ->> 'category') from jsonb_array_elements(board_test.board('A', 'P1') -> 'cards') c),
  array['continue', 'start', 'stop'],
  'reveal: the board holds cards of all three categories'
);
select ok(
  board_test.pos(board_test.board('A', 'P1'), 'A1') < board_test.pos(board_test.board('A', 'P1'), 'B1')
  and board_test.pos(board_test.board('A', 'P1'), 'B1') < board_test.pos(board_test.board('A', 'P1'), 'A2'),
  'reveal: A1 (09:00), B1 (11:00), A2 (09:01) come back as A1, B1, A2'
);
select ok(board_test.pos(board_test.board('B', 'P1'), 'A2') - board_test.pos(board_test.board('B', 'P1'), 'A1') > 1, 'reveal: A''s two consecutive cards A1 and A2 are not adjacent');
select ok(
  board_test.pos(board_test.board('A', 'P1'), 'A4') < board_test.pos(board_test.board('A', 'P1'), 'B2')
  and board_test.pos(board_test.board('A', 'P1'), 'B2') < board_test.pos(board_test.board('A', 'P1'), 'A3'),
  'reveal: with the ids swapped (A3 earliest, highest id) the order follows the ids: A4, B2, A3'
);
reset role;
select isnt(
  board_test.all_ids('P1'),
  (select array_agg(x.id order by array_position(array['start', 'stop', 'continue'], x.category), x.created_at, x.id) from public.cards x where x.cycle_id = '35000000-0000-4000-8000-000000000002'),
  'reveal: the board order is not the creation order'
);
set local role authenticated;
select is(board_test.board('B', 'P1'), board_test.board('B', 'P1'), 'reveal: two calls in a row return the same response and order');
select is(board_test.card_ids(board_test.board('E', 'P1')), board_test.card_ids(board_test.board('A', 'P1')), 'reveal: E and A get the same order');
select is(board_test.denials('P1'), '{}'::text[], 'reveal: every denied case gets exactly not_project_member');
select lives_ok($$ select board_test.snap('reveal A', board_test.board('A', 'P1')), board_test.snap('reveal B', board_test.board('B', 'P1')) $$, 'snapshot A''s and B''s boards at reveal');
reset role;

-- ---------------------------------------------------------------------------
-- cluster, vote, and discuss, reached as postgres through the allowed
-- transitions. Everything but status is unchanged from reveal.
-- ---------------------------------------------------------------------------
update public.feedback_cycles set status = 'cluster' where id = '35000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(board_test.problems('A', 'P1', board_test.board('A', 'P1')), '{}'::text[], 'cluster: A''s board meets every rule');
select is(board_test.problems('B', 'P1', board_test.board('B', 'P1')), '{}'::text[], 'cluster: B''s board meets every rule');
select is(board_test.problems('D', 'P1', board_test.board('D', 'P1')), '{}'::text[], 'cluster: D''s board meets every rule');
select is(board_test.problems('E', 'P1', board_test.board('E', 'P1')), '{}'::text[], 'cluster: E''s board meets every rule');
select is(board_test.board('A', 'P1') ->> 'status', 'cluster', 'cluster: status is cluster');
select is(board_test.board('A', 'P1') - 'status', board_test.snapped('reveal A') - 'status', 'cluster: A''s board is otherwise unchanged from reveal');
select is(board_test.board('B', 'P1') - 'status', board_test.snapped('reveal B') - 'status', 'cluster: B''s board is otherwise unchanged from reveal');
select ok(board_test.anon_cards(board_test.board('B', 'P1')) = board_test.anon_cards(board_test.board('A', 'P1')) and board_test.anon_cards(board_test.board('D', 'P1')) = board_test.anon_cards(board_test.board('A', 'P1')) and board_test.anon_cards(board_test.board('E', 'P1')) = board_test.anon_cards(board_test.board('A', 'P1')), 'cluster: anonymous cards are equal for A, B, D, and E');
select ok(board_test.strip_mine(board_test.board('B', 'P1')) = board_test.strip_mine(board_test.board('A', 'P1')) and board_test.strip_mine(board_test.board('D', 'P1')) = board_test.strip_mine(board_test.board('A', 'P1')) and board_test.strip_mine(board_test.board('E', 'P1')) = board_test.strip_mine(board_test.board('A', 'P1')), 'cluster: A, B, D, and E get the same response apart from is_mine');
select is(board_test.denials('P1'), '{}'::text[], 'cluster: every denied case gets exactly not_project_member');
reset role;

update public.feedback_cycles set status = 'vote' where id = '35000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(board_test.problems('A', 'P1', board_test.board('A', 'P1')), '{}'::text[], 'vote: A''s board meets every rule');
select is(board_test.problems('B', 'P1', board_test.board('B', 'P1')), '{}'::text[], 'vote: B''s board meets every rule');
select is(board_test.problems('D', 'P1', board_test.board('D', 'P1')), '{}'::text[], 'vote: D''s board meets every rule');
select is(board_test.problems('E', 'P1', board_test.board('E', 'P1')), '{}'::text[], 'vote: E''s board meets every rule');
select is(board_test.board('A', 'P1') ->> 'status', 'vote', 'vote: status is vote');
select is(board_test.board('A', 'P1') - 'status', board_test.snapped('reveal A') - 'status', 'vote: A''s board is otherwise unchanged from reveal');
select is(board_test.board('B', 'P1') - 'status', board_test.snapped('reveal B') - 'status', 'vote: B''s board is otherwise unchanged from reveal');
select ok(board_test.anon_cards(board_test.board('B', 'P1')) = board_test.anon_cards(board_test.board('A', 'P1')) and board_test.anon_cards(board_test.board('D', 'P1')) = board_test.anon_cards(board_test.board('A', 'P1')) and board_test.anon_cards(board_test.board('E', 'P1')) = board_test.anon_cards(board_test.board('A', 'P1')), 'vote: anonymous cards are equal for A, B, D, and E');
select ok(board_test.strip_mine(board_test.board('B', 'P1')) = board_test.strip_mine(board_test.board('A', 'P1')) and board_test.strip_mine(board_test.board('D', 'P1')) = board_test.strip_mine(board_test.board('A', 'P1')) and board_test.strip_mine(board_test.board('E', 'P1')) = board_test.strip_mine(board_test.board('A', 'P1')), 'vote: A, B, D, and E get the same response apart from is_mine');
select is(board_test.denials('P1'), '{}'::text[], 'vote: every denied case gets exactly not_project_member');
reset role;

update public.feedback_cycles set status = 'discuss' where id = '35000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(board_test.problems('A', 'P1', board_test.board('A', 'P1')), '{}'::text[], 'discuss: A''s board meets every rule');
select is(board_test.problems('B', 'P1', board_test.board('B', 'P1')), '{}'::text[], 'discuss: B''s board meets every rule');
select is(board_test.problems('D', 'P1', board_test.board('D', 'P1')), '{}'::text[], 'discuss: D''s board meets every rule');
select is(board_test.problems('E', 'P1', board_test.board('E', 'P1')), '{}'::text[], 'discuss: E''s board meets every rule');
select is(board_test.board('A', 'P1') ->> 'status', 'discuss', 'discuss: status is discuss');
select is(board_test.board('A', 'P1') - 'status', board_test.snapped('reveal A') - 'status', 'discuss: A''s board is otherwise unchanged from reveal');
select is(board_test.board('B', 'P1') - 'status', board_test.snapped('reveal B') - 'status', 'discuss: B''s board is otherwise unchanged from reveal');
select ok(board_test.anon_cards(board_test.board('B', 'P1')) = board_test.anon_cards(board_test.board('A', 'P1')) and board_test.anon_cards(board_test.board('D', 'P1')) = board_test.anon_cards(board_test.board('A', 'P1')) and board_test.anon_cards(board_test.board('E', 'P1')) = board_test.anon_cards(board_test.board('A', 'P1')), 'discuss: anonymous cards are equal for A, B, D, and E');
select ok(board_test.strip_mine(board_test.board('B', 'P1')) = board_test.strip_mine(board_test.board('A', 'P1')) and board_test.strip_mine(board_test.board('D', 'P1')) = board_test.strip_mine(board_test.board('A', 'P1')) and board_test.strip_mine(board_test.board('E', 'P1')) = board_test.strip_mine(board_test.board('A', 'P1')), 'discuss: A, B, D, and E get the same response apart from is_mine');
select is(board_test.denials('P1'), '{}'::text[], 'discuss: every denied case gets exactly not_project_member');
reset role;

-- ---------------------------------------------------------------------------
-- Removed member D (one attributed and one anonymous card), after reveal.
-- ---------------------------------------------------------------------------
delete from public.project_members where project_id = '25000000-0000-4000-8000-000000000001' and user_id = '15000000-0000-4000-8000-000000000004';
set local role authenticated;
select is(
  board_test.card(board_test.board('A', 'P1'), 'D stop attr'),
  jsonb_build_object('card_id', board_test.id('D stop attr'), 'category', 'stop', 'text', 'D stop attr', 'is_anonymous', false, 'is_mine', false, 'author_display_name', 'Dan'),
  'D removed: A still gets D''s attributed card with D''s name and is_mine false'
);
select is(board_test.card(board_test.board('B', 'P1'), 'D stop attr') -> 'author_display_name', '"Dan"'::jsonb, 'D removed: B still gets D''s name');
select is(board_test.card(board_test.board('E', 'P1'), 'D start anon'), board_test.card(board_test.snapped('reveal A'), 'D start anon'), 'D removed: D''s anonymous card is unchanged');
select is(board_test.problems('A', 'P1', board_test.board('A', 'P1')), '{}'::text[], 'D removed: A''s board meets every rule (the count still equals card_count)');
select is(board_test.problems('B', 'P1', board_test.board('B', 'P1')), '{}'::text[], 'D removed: B''s board meets every rule');
select is(board_test.problems('E', 'P1', board_test.board('E', 'P1')), '{}'::text[], 'D removed: E''s board meets every rule');
select is(board_test.err('D', board_test.id('P1')), board_test.denied(), 'D removed: D''s own call gets not_project_member');
select is(board_test.err('D', board_test.id('P0')), board_test.denied(), 'D removed: D gets not_project_member for P0 too');
reset role;

insert into public.project_members (project_id, user_id, role)
values ('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000004', 'member');
set local role authenticated;
select is(board_test.card(board_test.board('D', 'P1'), 'D stop attr') -> 'is_mine', 'true'::jsonb, 'D added back: D''s attributed card has is_mine true for D');
select is(board_test.card(board_test.board('A', 'P1'), 'D stop attr') -> 'is_mine', 'false'::jsonb, 'D added back: is_mine stays false for A');
select is(board_test.card(board_test.board('D', 'P1'), 'D start anon'), board_test.card(board_test.snapped('reveal A'), 'D start anon'), 'D added back: D''s anonymous card is unchanged, even for D');
select is(board_test.problems('D', 'P1', board_test.board('D', 'P1')), '{}'::text[], 'D added back: D''s board meets every rule');
reset role;

-- ---------------------------------------------------------------------------
-- Deleted auth user E (one attributed and one anonymous card), after reveal.
-- The service_role key deletes users through the Auth admin API (as
-- supabase_auth_admin); SQL service_role has no DELETE on auth.users, so the
-- delete runs as postgres, as in cards.test.sql and cycle_status.test.sql.
-- ---------------------------------------------------------------------------
select lives_ok($$ delete from auth.users where id = '15000000-0000-4000-8000-000000000005' $$, 'auth user E is deleted');
select is((select count(*)::int from public.card_authors where card_id in (board_test.id('E continue attr'), board_test.id('E stop anon'))), 0, 'E''s cards have no author');
set local role authenticated;
select is(
  board_test.card(board_test.board('A', 'P1'), 'E continue attr'),
  jsonb_build_object('card_id', board_test.id('E continue attr'), 'category', 'continue', 'text', 'E continue attr', 'is_anonymous', false, 'is_mine', false, 'author_display_name', null),
  'E deleted: A gets E''s attributed card with is_mine false and a null name'
);
select is(board_test.card(board_test.board('B', 'P1'), 'E continue attr') -> 'author_display_name', 'null'::jsonb, 'E deleted: B gets a JSON null name');
select is(board_test.card(board_test.board('D', 'P1'), 'E stop anon'), board_test.card(board_test.snapped('reveal A'), 'E stop anon'), 'E deleted: E''s anonymous card is unchanged');
select is(board_test.problems('A', 'P1', board_test.board('A', 'P1')), '{}'::text[], 'E deleted: A''s board meets every rule (the count still equals card_count)');
select is(board_test.problems('B', 'P1', board_test.board('B', 'P1')), '{}'::text[], 'E deleted: B''s board meets every rule');
select is(board_test.problems('D', 'P1', board_test.board('D', 'P1')), '{}'::text[], 'E deleted: D''s board meets every rule');
select is(jsonb_array_length(board_test.board('D', 'P1') -> 'cards'), 16, 'E deleted: every member still gets all sixteen cards');
select is(board_test.err('E', board_test.id('P1')), board_test.denied(), 'E deleted: a deleted user''s id gets not_project_member');
select lives_ok($$ select board_test.snap('discuss A', board_test.board('A', 'P1')), board_test.snap('discuss B', board_test.board('B', 'P1')) $$, 'snapshot A''s and B''s boards in discuss');
reset role;

-- ---------------------------------------------------------------------------
-- closed after reveal.
-- ---------------------------------------------------------------------------
update public.feedback_cycles set status = 'closed', closed_at = now() where id = '35000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(board_test.problems('A', 'P1', board_test.board('A', 'P1')), '{}'::text[], 'closed after reveal: A''s board meets every rule');
select is(board_test.problems('B', 'P1', board_test.board('B', 'P1')), '{}'::text[], 'closed after reveal: B''s board meets every rule');
select is(board_test.problems('D', 'P1', board_test.board('D', 'P1')), '{}'::text[], 'closed after reveal: D''s board meets every rule');
select is(board_test.board('A', 'P1') - 'cards', jsonb_build_object('cycle_id', board_test.id('P1'), 'status', 'closed', 'is_revealed', true, 'clusters', '[]'::jsonb), 'closed after reveal: status closed, is_revealed true');
select is(board_test.board('A', 'P1') - 'status', board_test.snapped('discuss A') - 'status', 'closed after reveal: A''s board is otherwise unchanged');
select is(board_test.board('B', 'P1') - 'status', board_test.snapped('discuss B') - 'status', 'closed after reveal: B''s board is otherwise unchanged');
select ok(board_test.anon_cards(board_test.board('B', 'P1')) = board_test.anon_cards(board_test.board('A', 'P1')) and board_test.anon_cards(board_test.board('D', 'P1')) = board_test.anon_cards(board_test.board('A', 'P1')), 'closed after reveal: anonymous cards are equal for A, B, and D');
select ok(board_test.strip_mine(board_test.board('B', 'P1')) = board_test.strip_mine(board_test.board('A', 'P1')) and board_test.strip_mine(board_test.board('D', 'P1')) = board_test.strip_mine(board_test.board('A', 'P1')), 'closed after reveal: A, B, and D get the same response apart from is_mine');
select is(board_test.denials('P1'), '{}'::text[], 'closed after reveal: every denied case gets exactly not_project_member');
select is(board_test.problems('B', 'P0', board_test.board('B', 'P0')), '{}'::text[], 'P0, closed early, still shows B only their own card');
select is(board_test.board('A', 'P0') -> 'cards', '[]'::jsonb, 'P0, closed early, still shows A nothing');
reset role;

-- ---------------------------------------------------------------------------
-- After transfer_facilitator: the owner is no longer the facilitator.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select public.transfer_facilitator('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000002') $$, 'owner A transfers the facilitator role to B');
reset role;
select is((select role from public.project_members where project_id = '25000000-0000-4000-8000-000000000001' and user_id = '15000000-0000-4000-8000-000000000002'), 'facilitator', 'B is now the facilitator');
set local role authenticated;
select is(board_test.strip_mine(board_test.board('A', 'P1')), board_test.strip_mine(board_test.board('B', 'P1')), 'after transfer: owner A and facilitator B get the same response apart from is_mine');
select is(board_test.strip_mine(board_test.board('D', 'P1')), board_test.strip_mine(board_test.board('B', 'P1')), 'after transfer: member D and facilitator B get the same response apart from is_mine');
select is(board_test.anon_cards(board_test.board('B', 'P1')), board_test.anon_cards(board_test.board('D', 'P1')), 'after transfer: anonymous cards are equal for facilitator B and member D');
select is(board_test.problems('B', 'P1', board_test.board('B', 'P1')), '{}'::text[], 'after transfer: facilitator B''s board meets every rule');
reset role;

-- ---------------------------------------------------------------------------
-- P2: a revealed cycle with zero cards.
-- ---------------------------------------------------------------------------
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('35000000-0000-4000-8000-000000000003', '25000000-0000-4000-8000-000000000001', 'P empty week', '2026-11-02');
set local role authenticated;
select is(board_test.board('A', 'P2'), jsonb_build_object('cycle_id', board_test.id('P2'), 'status', 'collecting', 'is_revealed', false, 'cards', '[]'::jsonb, 'clusters', '[]'::jsonb), 'P2 collecting: cards = [] and clusters = []');
set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000002","role":"authenticated"}';
select lives_ok($$ select * from public.start_retrospective('35000000-0000-4000-8000-000000000003') $$, 'facilitator B starts the retrospective on P2');
select is(board_test.board('A', 'P2'), jsonb_build_object('cycle_id', board_test.id('P2'), 'status', 'reveal', 'is_revealed', true, 'cards', '[]'::jsonb, 'clusters', '[]'::jsonb), 'P2 revealed with zero cards: A gets cards = [] and clusters = []');
select is(board_test.board('D', 'P2') -> 'cards', '[]'::jsonb, 'P2 revealed with zero cards: D gets cards = []');
select is(board_test.problems('B', 'P2', board_test.board('B', 'P2')), '{}'::text[], 'P2 revealed with zero cards: B''s board meets every rule');
select is(board_test.denials('P2'), '{}'::text[], 'P2: every denied case gets exactly not_project_member');

-- ---------------------------------------------------------------------------
-- Q1: another project's cards never appear in P, and P's never in Q.
-- ---------------------------------------------------------------------------
select is(board_test.problems('C', 'Q1', board_test.board('C', 'Q1')), '{}'::text[], 'Q1: C''s board meets every rule');
select is(board_test.card_ids(board_test.board('C', 'Q1')), array[board_test.id('C in Q1')], 'Q1: C gets only their own Q1 card');
select is(board_test.card(board_test.board('A', 'P1'), 'C in Q1'), null, 'P1: A never gets Q1''s card');
select is(board_test.card(board_test.board('A', 'P1'), 'B in P0'), null, 'P1: A never gets P0''s card');
select is(board_test.card(board_test.board('B', 'P1'), 'B in P0'), null, 'P1: B never gets their own P0 card on P1''s board');
select is(board_test.err('A', board_test.id('Q1')), board_test.denied(), 'Q1: A gets not_project_member');
reset role;

select * from finish();
rollback;
