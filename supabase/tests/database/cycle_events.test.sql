-- pgTAP tests for cycle_events, the revealed_at rules on feedback_cycles, the
-- stage-change trigger, start_retrospective, and the close_cycle events (#68).
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension and the cycle_events_test helper schema. The seed user
-- is never used as a fixture.
--
-- Fixtures: owner and facilitator A, members B and D, non-member C. Project P
-- is owned by A with B and D joined; project Q is owned by C, and none of A,
-- B, or D is ever in Q.
--
-- Cycles. Q1-Q5 (Q) are moved through every allowed transition as postgres.
-- P1 (P) is the main cycle: cards from A, B, and D, D removed, then started
-- by A and taken through cluster, vote, discuss, and closed. P2 is started
-- with zero cards, P3 is closed straight from collecting, P5 and P6 are
-- closed from cluster and vote, and P4 is started by B after A transferred
-- the facilitator role. P has at most one open cycle at a time.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(241);

-- ---------------------------------------------------------------------------
-- Test-only helpers. The ones that call RPCs are security invoker: they run
-- as the calling role (authenticated) and switch only the JWT claims. The
-- read-back helpers (state, events, last_event, cards_md5) are security
-- definer so they see every row whatever the caller.
-- ---------------------------------------------------------------------------
create schema cycle_events_test;

create table cycle_events_test.ids (label text primary key, id uuid not null);
create table cycle_events_test.snaps (label text primary key, row_json jsonb not null);

insert into cycle_events_test.ids (label, id)
values
  ('A', '14000000-0000-4000-8000-000000000001'),
  ('B', '14000000-0000-4000-8000-000000000002'),
  ('C', '14000000-0000-4000-8000-000000000003'),
  ('D', '14000000-0000-4000-8000-000000000004'),
  ('P', '24000000-0000-4000-8000-000000000001'),
  ('Q', '24000000-0000-4000-8000-000000000002'),
  ('P1', '34000000-0000-4000-8000-000000000001'),
  ('P2', '34000000-0000-4000-8000-000000000002'),
  ('P3', '34000000-0000-4000-8000-000000000003'),
  ('P4', '34000000-0000-4000-8000-000000000004'),
  ('P5', '34000000-0000-4000-8000-000000000005'),
  ('P6', '34000000-0000-4000-8000-000000000006'),
  ('Q1', '34000000-0000-4000-8000-000000000011'),
  ('Q2', '34000000-0000-4000-8000-000000000012'),
  ('Q3', '34000000-0000-4000-8000-000000000013'),
  ('Q4', '34000000-0000-4000-8000-000000000014'),
  ('Q5', '34000000-0000-4000-8000-000000000015');

-- The id stored under a label (a user, project, cycle, or card).
create function cycle_events_test.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from cycle_events_test.ids i where i.label = p_label;
$$;

-- Signs in as the labelled user, or with no sub when the label is null (so
-- auth.uid() is null, as for postgres or service_role).
create function cycle_events_test.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', cycle_events_test.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- start_retrospective as the user; its single row as jsonb.
create function cycle_events_test.start(p_user text, p_cycle uuid)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform cycle_events_test.become(p_user);
  select to_jsonb(s) into strict result from public.start_retrospective(p_cycle) s;
  return result;
end;
$$;

-- close_cycle as the user.
create function cycle_events_test.close(p_user text, p_cycle uuid)
returns void
language plpgsql
as $$
begin
  perform cycle_events_test.become(p_user);
  perform 1 from public.close_cycle(p_cycle);
end;
$$;

-- The full error of start_retrospective (code, message, detail, hint), or
-- "ok". A failed call is rolled back with its subtransaction.
create function cycle_events_test.start_err(p_user text, p_cycle uuid)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform cycle_events_test.become(p_user);
  perform 1 from public.start_retrospective(p_cycle);
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

-- The full error of get_cycle_status, or "ok".
create function cycle_events_test.status_err(p_user text, p_cycle uuid)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
begin
  perform cycle_events_test.become(p_user);
  perform 1 from public.get_cycle_status(p_cycle);
  return to_jsonb('ok'::text);
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
    return jsonb_build_object('code', v_state, 'message', v_message);
end;
$$;

-- The caller's get_cycle_status row as jsonb.
create function cycle_events_test.st(p_user text, p_cycle uuid)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform cycle_events_test.become(p_user);
  select to_jsonb(s) into strict result from public.get_cycle_status(p_cycle) s;
  return result;
end;
$$;

-- The number of cycle_events rows the caller can select for a cycle.
create function cycle_events_test.visible_events(p_user text, p_cycle uuid)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  perform cycle_events_test.become(p_user);
  select count(*)::int into n from public.cycle_events e where e.cycle_id = p_cycle;
  return n;
end;
$$;

-- The number of rows get_my_cards returns to the caller.
create function cycle_events_test.my_cards(p_user text, p_cycle uuid)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  perform cycle_events_test.become(p_user);
  select count(*)::int into n from public.get_my_cards(p_cycle);
  return n;
end;
$$;

-- create_card as the user; the card text is its label, and its id is stored.
create function cycle_events_test.add_card(p_user text, p_cycle text, p_label text, p_anonymous boolean)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform cycle_events_test.become(p_user);
  select c.id into strict new_id
    from public.create_card(cycle_events_test.id(p_cycle), 'start', p_label, p_anonymous) c;
  insert into cycle_events_test.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

-- A card RPC as the user: the error message, or "ok".
create function cycle_events_test.card_err(p_user text, p_op text, p_cycle text, p_card text)
returns text
language plpgsql
as $$
declare
  v_message text;
begin
  perform cycle_events_test.become(p_user);
  if p_op = 'create' then
    perform 1 from public.create_card(cycle_events_test.id(p_cycle), 'stop', 'Late card', false);
  elsif p_op = 'update' then
    perform 1 from public.update_card(cycle_events_test.id(p_card), 'Edited after reveal', true);
  else
    perform public.delete_card(cycle_events_test.id(p_card));
  end if;
  return 'ok';
exception
  when others then
    get stacked diagnostics v_message = message_text;
    return v_message;
end;
$$;

-- status, revealed_at, and the event count of a cycle, read as postgres.
create function cycle_events_test.state(p_cycle uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', (select fc.status from public.feedback_cycles fc where fc.id = p_cycle),
    'revealed_at', (select fc.revealed_at from public.feedback_cycles fc where fc.id = p_cycle),
    'events', (select count(*) from public.cycle_events e where e.cycle_id = p_cycle)
  );
$$;

-- The number of events of a cycle, read as postgres.
create function cycle_events_test.events(p_cycle uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.cycle_events e where e.cycle_id = p_cycle;
$$;

-- The cycle's events as "from>to:actor" in insert order, read as postgres.
create function cycle_events_test.event_list(p_cycle uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    array_agg(
      e.from_status || '>' || e.to_status || ':' || coalesce(
        (select i.label from cycle_events_test.ids i where i.id = e.actor_id and i.label in ('A', 'B', 'C', 'D')),
        'null'
      )
      order by e.created_at, e.ctid
    ),
    '{}'::text[]
  )
  from public.cycle_events e
  where e.cycle_id = p_cycle;
$$;

-- The newest event of a cycle as jsonb, read as postgres.
create function cycle_events_test.last_event(p_cycle uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(e)
  from public.cycle_events e
  where e.cycle_id = p_cycle
  order by e.created_at desc, e.ctid desc
  limit 1;
$$;

-- An md5 of every cards and card_authors row, read as postgres.
create function cycle_events_test.cards_md5()
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

-- The number of cards rows of a cycle, read as postgres.
create function cycle_events_test.card_rows(p_cycle uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.cards c where c.cycle_id = p_cycle;
$$;

-- Stores a value under a label, and reads it back.
create function cycle_events_test.snap(p_label text, p_value jsonb)
returns void
language sql
as $$
  insert into cycle_events_test.snaps (label, row_json)
  values (p_label, p_value)
  on conflict (label) do update set row_json = excluded.row_json;
$$;

create function cycle_events_test.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.row_json from cycle_events_test.snaps s where s.label = p_label;
$$;

-- The error a denied caller gets, with empty detail and hint.
create function cycle_events_test.denied(p_message text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'code', case when p_message = 'cycle_not_collecting' then 'P0001' else '42501' end,
    'message', p_message,
    'detail', '',
    'hint', ''
  );
$$;

grant usage on schema cycle_events_test to authenticated;
grant select, insert, update on all tables in schema cycle_events_test to authenticated;
grant execute on all functions in schema cycle_events_test to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures. Inserting auth.users rows fires private.handle_new_user(), and
-- inserting projects fires the owner-membership trigger (owner = facilitator).
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-000000000000', '14000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'events-a@example.com', '{"display_name":"Alice"}'),
  ('00000000-0000-0000-0000-000000000000', '14000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'events-b@example.com', '{"display_name":"Bob"}'),
  ('00000000-0000-0000-0000-000000000000', '14000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'events-c@example.com', '{"display_name":"Cara"}'),
  ('00000000-0000-0000-0000-000000000000', '14000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'events-d@example.com', '{"display_name":"Dan"}');

insert into public.projects (id, name, owner_id)
values
  ('24000000-0000-4000-8000-000000000001', 'Project P', '14000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000002', 'Project Q', '14000000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('24000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000002', 'member'),
  ('24000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000004', 'member');

insert into public.feedback_cycles (id, project_id, title, week_start)
values
  ('34000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', 'P main', '2026-10-26'),
  ('34000000-0000-4000-8000-000000000011', '24000000-0000-4000-8000-000000000002', 'Q one', '2026-10-26');

-- ---------------------------------------------------------------------------
-- cycle_events shape.
-- ---------------------------------------------------------------------------
select has_table('public', 'cycle_events', 'cycle_events table exists');
select columns_are('public', 'cycle_events', array['id', 'cycle_id', 'type', 'from_status', 'to_status', 'actor_id', 'payload', 'created_at'], 'cycle_events has exactly the eight expected columns');
select col_type_is('public', 'cycle_events', 'id', 'uuid', 'id is uuid');
select col_type_is('public', 'cycle_events', 'cycle_id', 'uuid', 'cycle_id is uuid');
select col_type_is('public', 'cycle_events', 'type', 'text', 'type is text');
select col_type_is('public', 'cycle_events', 'from_status', 'text', 'from_status is text');
select col_type_is('public', 'cycle_events', 'to_status', 'text', 'to_status is text');
select col_type_is('public', 'cycle_events', 'actor_id', 'uuid', 'actor_id is uuid');
select col_type_is('public', 'cycle_events', 'payload', 'jsonb', 'payload is jsonb');
select col_type_is('public', 'cycle_events', 'created_at', 'timestamp with time zone', 'created_at is timestamptz');
select col_is_pk('public', 'cycle_events', 'id', 'id is the primary key');
select col_default_is('public', 'cycle_events', 'id', 'gen_random_uuid()', 'id defaults to gen_random_uuid()');
select col_not_null('public', 'cycle_events', 'cycle_id', 'cycle_id is not null');
select col_not_null('public', 'cycle_events', 'type', 'type is not null');
select col_not_null('public', 'cycle_events', 'from_status', 'from_status is not null');
select col_not_null('public', 'cycle_events', 'to_status', 'to_status is not null');
select col_is_null('public', 'cycle_events', 'actor_id', 'actor_id is nullable');
select col_not_null('public', 'cycle_events', 'payload', 'payload is not null');
select col_default_is('public', 'cycle_events', 'payload', '{}'::jsonb, 'payload defaults to {}');
select col_not_null('public', 'cycle_events', 'created_at', 'created_at is not null');
select col_default_is('public', 'cycle_events', 'created_at', 'now()', 'created_at defaults to now()');

select is((select count(*)::int from pg_constraint where conrelid = 'public.cycle_events'::regclass and contype = 'f'), 2, 'cycle_events has exactly two foreign keys');
select fk_ok('public', 'cycle_events', 'cycle_id', 'public', 'feedback_cycles', 'id', 'cycle_id references feedback_cycles(id)');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.cycle_events'::regclass and conname = 'cycle_events_cycle_id_fkey'), 'c', 'cycle_events_cycle_id_fkey is ON DELETE CASCADE');
select fk_ok('public', 'cycle_events', 'actor_id', 'auth', 'users', 'id', 'actor_id references auth.users(id)');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.cycle_events'::regclass and conname = 'cycle_events_actor_id_fkey'), 'n', 'cycle_events_actor_id_fkey is ON DELETE SET NULL');

select is((select contype::text from pg_constraint where conrelid = 'public.cycle_events'::regclass and conname = 'cycle_events_type_check'), 'c', 'the named type CHECK exists');
select is((select count(*)::int from pg_constraint where conrelid = 'public.cycle_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'from_status' and pg_get_constraintdef(oid) ~ 'collecting'), 1, 'a CHECK limits from_status to the cycle statuses');
select is((select count(*)::int from pg_constraint where conrelid = 'public.cycle_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'to_status' and pg_get_constraintdef(oid) ~ 'collecting'), 1, 'a CHECK limits to_status to the cycle statuses');
select is((select count(*)::int from pg_constraint where conrelid = 'public.cycle_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'jsonb_typeof\(payload\) = ''object'''), 1, 'a CHECK requires payload to be a JSON object');

select lives_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values ('34000000-0000-4000-8000-000000000011', 'stage_changed', 'collecting', 'reveal') $$, 'postgres can insert a valid event');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values ('34000000-0000-4000-8000-000000000011', 'voting_closed', 'vote', 'discuss') $$, '23514'::char(5), NULL, 'an unknown type is rejected');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values ('34000000-0000-4000-8000-000000000011', 'stage_changed', 'open', 'reveal') $$, '23514'::char(5), NULL, 'an unknown from_status is rejected');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values ('34000000-0000-4000-8000-000000000011', 'stage_changed', 'collecting', 'Reveal') $$, '23514'::char(5), NULL, 'an unknown to_status is rejected');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status, payload) values ('34000000-0000-4000-8000-000000000011', 'stage_changed', 'collecting', 'reveal', '[]') $$, '23514'::char(5), NULL, 'an array payload is rejected');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status, payload) values ('34000000-0000-4000-8000-000000000011', 'stage_changed', 'collecting', 'reveal', '"x"') $$, '23514'::char(5), NULL, 'a string payload is rejected');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values ('34000000-0000-4000-8000-0000000000ff', 'stage_changed', 'collecting', 'reveal') $$, '23503'::char(5), NULL, 'an unknown cycle_id is rejected');
-- Remove the hand-made event so Q1 starts with none.
delete from public.cycle_events where cycle_id = '34000000-0000-4000-8000-000000000011';

select is(to_regclass('public.cycle_events_cycle_created_idx')::text, 'cycle_events_cycle_created_idx', 'cycle_events_cycle_created_idx exists');
select matches(pg_get_indexdef('public.cycle_events_cycle_created_idx'::regclass), 'ON public\.cycle_events USING btree \(cycle_id, created_at\)$', 'the index is on (cycle_id, created_at)');

-- The migration header states the event contract.
select ok(
  (select count(*) from supabase_migrations.schema_migrations m where m.statements::text ~ 'create table public\.cycle_events' and m.statements::text ~ 'No column and no payload ever carries card text, a card id, a card or' and m.statements::text ~ 'per-member data' and m.statements::text ~ 'vote data') = 1,
  'the migration header states the event contract'
);

-- ---------------------------------------------------------------------------
-- RLS, policies, and grants.
-- ---------------------------------------------------------------------------
select is((select relrowsecurity from pg_class where oid = 'public.cycle_events'::regclass), true, 'RLS is enabled on cycle_events');
select is((select array_agg(policyname::text) from pg_policies where schemaname = 'public' and tablename = 'cycle_events'), array['cycle_events_select_member'], 'the only policy is cycle_events_select_member');
select is((select cmd::text from pg_policies where schemaname = 'public' and tablename = 'cycle_events' and policyname = 'cycle_events_select_member'), 'SELECT', 'the policy is for SELECT');
select is((select roles::text[] from pg_policies where schemaname = 'public' and tablename = 'cycle_events' and policyname = 'cycle_events_select_member'), array['authenticated'], 'the policy applies to authenticated only');
select ok((select qual from pg_policies where schemaname = 'public' and tablename = 'cycle_events' and policyname = 'cycle_events_select_member') ~ 'is_project_member', 'the policy checks project membership');

select is(has_table_privilege('authenticated', 'public.cycle_events', 'SELECT'), true, 'authenticated has SELECT');
select is(has_table_privilege('authenticated', 'public.cycle_events', 'INSERT'), false, 'authenticated has no INSERT');
select is(has_table_privilege('authenticated', 'public.cycle_events', 'UPDATE'), false, 'authenticated has no UPDATE');
select is(has_table_privilege('authenticated', 'public.cycle_events', 'DELETE'), false, 'authenticated has no DELETE');
select is(has_table_privilege('authenticated', 'public.cycle_events', 'TRUNCATE'), false, 'authenticated has no TRUNCATE');
select is(has_table_privilege('authenticated', 'public.cycle_events', 'REFERENCES'), false, 'authenticated has no REFERENCES');
select is(has_table_privilege('authenticated', 'public.cycle_events', 'TRIGGER'), false, 'authenticated has no TRIGGER');
select is(
  (select array_agg(p) from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p where has_table_privilege('anon', 'public.cycle_events', p)),
  null,
  'anon has no privilege on cycle_events'
);
select is((select (count(*) filter (where a.grantee = 0))::int from pg_class c left join lateral aclexplode(c.relacl) a on true where c.oid = 'public.cycle_events'::regclass), 0, 'PUBLIC has no privilege on cycle_events');
select is(
  (select array_agg(p order by p) from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege('service_role', 'public.cycle_events', p)),
  array['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  'service_role has exactly SELECT, INSERT, UPDATE, and DELETE'
);

-- ---------------------------------------------------------------------------
-- Realtime publication.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cycle_events'), 1, 'cycle_events is in supabase_realtime');
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('cards', 'card_authors', 'feedback_cycles')), 0, 'cards, card_authors, and feedback_cycles are not in supabase_realtime');
select is((select puballtables from pg_publication where pubname = 'supabase_realtime'), false, 'supabase_realtime is not FOR ALL TABLES');
select is((select relreplident::text from pg_class where oid = 'public.cycle_events'::regclass), 'd', 'cycle_events keeps replica identity DEFAULT');

-- ---------------------------------------------------------------------------
-- The revealed_at rules on feedback_cycles.
-- ---------------------------------------------------------------------------
select is((select contype::text from pg_constraint where conrelid = 'public.feedback_cycles'::regclass and conname = 'feedback_cycles_revealed_status_check'), 'c', 'feedback_cycles_revealed_status_check exists');
select matches((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.feedback_cycles'::regclass and conname = 'feedback_cycles_revealed_status_check'), 'reveal.*cluster.*vote.*discuss.*revealed_at IS NOT NULL', 'the CHECK requires revealed_at in reveal, cluster, vote, and discuss');
select trigger_is('public', 'feedback_cycles', 'feedback_cycles_guard_reveal', 'private', 'guard_feedback_cycle_reveal', 'the reveal guard trigger exists');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.feedback_cycles'::regclass and tgname = 'feedback_cycles_guard_reveal'), 19, 'the reveal guard is BEFORE UPDATE FOR EACH ROW');
select is(has_function_privilege('authenticated', 'private.guard_feedback_cycle_reveal()', 'EXECUTE'), false, 'authenticated cannot execute the reveal guard');

-- Q1 through every stage, as postgres with no auth.uid().
select cycle_events_test.become(null);
select throws_ok($$ update public.feedback_cycles set revealed_at = now() where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_immutable_column', 'revealed_at cannot be set on a collecting row');
select throws_ok($$ update public.feedback_cycles set status = 'reveal' where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_immutable_column', 'collecting -> reveal without revealed_at is rejected');
select throws_ok($$ update public.feedback_cycles set status = 'cluster', revealed_at = now() where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'invalid_status_transition', 'collecting -> cluster is still #10''s invalid_status_transition');
select is(cycle_events_test.events(cycle_events_test.id('Q1')), 0, 'rejected updates add no event');
select lives_ok($$ update public.feedback_cycles set title = 'Q one renamed' where id = '34000000-0000-4000-8000-000000000011' $$, 'a title change succeeds');
select is(cycle_events_test.events(cycle_events_test.id('Q1')), 0, 'an update that leaves status unchanged adds no event');

select lives_ok($$ update public.feedback_cycles set status = 'reveal', revealed_at = now() - interval '1 hour' where id = '34000000-0000-4000-8000-000000000011' $$, 'collecting -> reveal with revealed_at succeeds');
select is(cycle_events_test.event_list(cycle_events_test.id('Q1')), array['collecting>reveal:null'], 'collecting -> reveal adds one event with a null actor');
select cycle_events_test.snap('Q1 revealed_at', to_jsonb((select revealed_at from public.feedback_cycles where id = '34000000-0000-4000-8000-000000000011')));
select throws_ok($$ update public.feedback_cycles set revealed_at = null where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_immutable_column', 'reveal: revealed_at cannot be cleared');
select throws_ok($$ update public.feedback_cycles set revealed_at = now() where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_immutable_column', 'reveal: revealed_at cannot be moved');
select throws_ok($$ update public.feedback_cycles set status = 'collecting', revealed_at = null where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'invalid_status_transition', 'reveal -> collecting is still #10''s invalid_status_transition');

select lives_ok($$ update public.feedback_cycles set status = 'cluster' where id = '34000000-0000-4000-8000-000000000011' $$, 'reveal -> cluster succeeds');
select throws_ok($$ update public.feedback_cycles set revealed_at = null where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_immutable_column', 'cluster: revealed_at cannot be cleared');
select throws_ok($$ update public.feedback_cycles set status = 'vote', revealed_at = now() where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_immutable_column', 'cluster -> vote cannot move revealed_at');
select lives_ok($$ update public.feedback_cycles set status = 'vote' where id = '34000000-0000-4000-8000-000000000011' $$, 'cluster -> vote succeeds');
select throws_ok($$ update public.feedback_cycles set revealed_at = null where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_immutable_column', 'vote: revealed_at cannot be cleared');
select throws_ok($$ update public.feedback_cycles set revealed_at = now() where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_immutable_column', 'vote: revealed_at cannot be moved');
select lives_ok($$ update public.feedback_cycles set status = 'discuss', voting_closed_at = now() where id = '34000000-0000-4000-8000-000000000011' $$, 'vote -> discuss succeeds');
select throws_ok($$ update public.feedback_cycles set revealed_at = null where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_immutable_column', 'discuss: revealed_at cannot be cleared');
select throws_ok($$ update public.feedback_cycles set revealed_at = now() where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_immutable_column', 'discuss: revealed_at cannot be moved');
select throws_ok($$ update public.feedback_cycles set status = 'closed', closed_at = now(), revealed_at = null where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_immutable_column', 'discuss -> closed cannot clear revealed_at');
select lives_ok($$ update public.feedback_cycles set status = 'closed', closed_at = now() where id = '34000000-0000-4000-8000-000000000011' $$, 'discuss -> closed succeeds');
select throws_ok($$ update public.feedback_cycles set revealed_at = null where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_immutable_column', 'closed: revealed_at cannot be cleared');
select throws_ok($$ update public.feedback_cycles set revealed_at = now() where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_immutable_column', 'closed: revealed_at cannot be moved');
select is(to_jsonb((select revealed_at from public.feedback_cycles where id = '34000000-0000-4000-8000-000000000011')), cycle_events_test.snapped('Q1 revealed_at'), 'Q1 keeps the revealed_at it was revealed with');
select is(
  cycle_events_test.event_list(cycle_events_test.id('Q1')),
  array['collecting>reveal:null', 'reveal>cluster:null', 'cluster>vote:null', 'vote>discuss:null', 'discuss>closed:null'],
  'each allowed transition adds exactly one event, in order, with a null actor'
);
select is((select count(*)::int from public.cycle_events where cycle_id = '34000000-0000-4000-8000-000000000011' and (type <> 'stage_changed' or payload <> '{}'::jsonb)), 0, 'every Q1 event is stage_changed with payload {}');
select throws_ok($$ update public.feedback_cycles set status = 'discuss', closed_at = null where id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'invalid_status_transition', 'closed -> discuss is rejected');
select is(cycle_events_test.events(cycle_events_test.id('Q1')), 5, 'a rejected transition from closed adds no event');

-- Q2: collecting -> closed, never revealed.
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('34000000-0000-4000-8000-000000000012', '24000000-0000-4000-8000-000000000002', 'Q two', '2026-10-26');
select throws_ok($$ update public.feedback_cycles set status = 'closed', closed_at = now(), revealed_at = now() where id = '34000000-0000-4000-8000-000000000012' $$, 'P0001'::char(5), 'cycle_immutable_column', 'collecting -> closed cannot set revealed_at');
select lives_ok($$ update public.feedback_cycles set status = 'closed', closed_at = now() where id = '34000000-0000-4000-8000-000000000012' $$, 'collecting -> closed succeeds');
select is(cycle_events_test.event_list(cycle_events_test.id('Q2')), array['collecting>closed:null'], 'collecting -> closed adds one event');
select throws_ok($$ update public.feedback_cycles set revealed_at = now() where id = '34000000-0000-4000-8000-000000000012' $$, 'P0001'::char(5), 'cycle_immutable_column', 'an early-closed cycle cannot get a revealed_at');
select is((select revealed_at from public.feedback_cycles where id = '34000000-0000-4000-8000-000000000012'), null, 'the early-closed cycle keeps revealed_at null');

-- Q3, Q4, Q5: reveal, cluster, and vote -> closed.
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('34000000-0000-4000-8000-000000000013', '24000000-0000-4000-8000-000000000002', 'Q three', '2026-10-26');
update public.feedback_cycles set status = 'reveal', revealed_at = now() where id = '34000000-0000-4000-8000-000000000013';
update public.feedback_cycles set status = 'closed', closed_at = now() where id = '34000000-0000-4000-8000-000000000013';
select is(cycle_events_test.event_list(cycle_events_test.id('Q3')), array['collecting>reveal:null', 'reveal>closed:null'], 'reveal -> closed adds one event');

insert into public.feedback_cycles (id, project_id, title, week_start)
values ('34000000-0000-4000-8000-000000000014', '24000000-0000-4000-8000-000000000002', 'Q four', '2026-10-26');
update public.feedback_cycles set status = 'reveal', revealed_at = now() where id = '34000000-0000-4000-8000-000000000014';
update public.feedback_cycles set status = 'cluster' where id = '34000000-0000-4000-8000-000000000014';
update public.feedback_cycles set status = 'closed', closed_at = now() where id = '34000000-0000-4000-8000-000000000014';
select is(cycle_events_test.event_list(cycle_events_test.id('Q4')), array['collecting>reveal:null', 'reveal>cluster:null', 'cluster>closed:null'], 'cluster -> closed adds one event');

insert into public.feedback_cycles (id, project_id, title, week_start)
values ('34000000-0000-4000-8000-000000000015', '24000000-0000-4000-8000-000000000002', 'Q five', '2026-10-26');
update public.feedback_cycles set status = 'reveal', revealed_at = now() where id = '34000000-0000-4000-8000-000000000015';
update public.feedback_cycles set status = 'cluster' where id = '34000000-0000-4000-8000-000000000015';
update public.feedback_cycles set status = 'vote' where id = '34000000-0000-4000-8000-000000000015';
update public.feedback_cycles set status = 'closed', closed_at = now() where id = '34000000-0000-4000-8000-000000000015';
select is(cycle_events_test.event_list(cycle_events_test.id('Q5')), array['collecting>reveal:null', 'reveal>cluster:null', 'cluster>vote:null', 'vote>closed:null'], 'vote -> closed adds one event');

-- ---------------------------------------------------------------------------
-- The cycle_events immutability guard.
-- ---------------------------------------------------------------------------
select trigger_is('public', 'cycle_events', 'cycle_events_guard_update', 'private', 'guard_cycle_event_update', 'the cycle_events guard trigger exists');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.cycle_events'::regclass and tgname = 'cycle_events_guard_update'), 19, 'the cycle_events guard is BEFORE UPDATE FOR EACH ROW');
select throws_ok($$ update public.cycle_events set payload = '{"x":1}' where cycle_id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_event_immutable', 'postgres cannot change an event payload');
select throws_ok($$ update public.cycle_events set to_status = 'closed' where cycle_id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_event_immutable', 'postgres cannot change an event status');
select throws_ok($$ update public.cycle_events set actor_id = null where cycle_id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_event_immutable', 'postgres cannot rewrite even an unchanged actor');
select throws_ok($$ update public.cycle_events set created_at = now() where cycle_id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_event_immutable', 'postgres cannot move created_at');
set local role service_role;
select throws_ok($$ update public.cycle_events set payload = '{}' where cycle_id = '34000000-0000-4000-8000-000000000011' $$, 'P0001'::char(5), 'cycle_event_immutable', 'service_role cannot update an event');
reset role;

-- ---------------------------------------------------------------------------
-- The stage-change trigger.
-- ---------------------------------------------------------------------------
select trigger_is('public', 'feedback_cycles', 'feedback_cycles_record_stage_change', 'private', 'record_cycle_stage_change', 'the stage-change trigger exists');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.feedback_cycles'::regclass and tgname = 'feedback_cycles_record_stage_change'), 17, 'the stage-change trigger is AFTER UPDATE FOR EACH ROW');
select is(
  (select array_agg(a.attname::text) from pg_trigger t join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr) where t.tgrelid = 'public.feedback_cycles'::regclass and t.tgname = 'feedback_cycles_record_stage_change'),
  array['status'],
  'the stage-change trigger is UPDATE OF status'
);
select matches(pg_get_triggerdef((select oid from pg_trigger where tgrelid = 'public.feedback_cycles'::regclass and tgname = 'feedback_cycles_record_stage_change')), 'WHEN \(\(old\.status IS DISTINCT FROM new\.status\)\)', 'the stage-change trigger fires only when the status changes');
select is((select n.nspname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = 'record_cycle_stage_change'), 'private', 'the trigger function is in private');
select is((select prosecdef from pg_proc where oid = 'private.record_cycle_stage_change()'::regprocedure), true, 'the trigger function is security definer');
select is((select proconfig from pg_proc where oid = 'private.record_cycle_stage_change()'::regprocedure), array['search_path=""']::text[], 'the trigger function fixes search_path to empty');
select is(has_function_privilege('anon', 'private.record_cycle_stage_change()', 'EXECUTE'), false, 'anon cannot execute the trigger function');
select is(has_function_privilege('authenticated', 'private.record_cycle_stage_change()', 'EXECUTE'), false, 'authenticated cannot execute the trigger function');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'private.record_cycle_stage_change()'::regprocedure), 0, 'PUBLIC cannot execute the trigger function');
select matches((select prosrc from pg_proc where oid = 'private.record_cycle_stage_change()'::regprocedure), '''stage_changed'', old\.status, new\.status, \(select auth\.uid\(\)\), ''\{\}''', 'the trigger records stage_changed, old and new status, auth.uid(), and {}');
select is(has_function_privilege('authenticated', 'private.guard_cycle_event_update()', 'EXECUTE'), false, 'authenticated cannot execute the cycle_events guard');

-- No forbidden table in either function.
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p where p.oid in ('private.record_cycle_stage_change()'::regprocedure, 'public.start_retrospective(uuid)'::regprocedure) and p.prosrc ~ '(cards|card_authors|is_anonymous|profiles)'),
  null,
  'neither the trigger function nor start_retrospective mentions cards, card_authors, is_anonymous, or profiles'
);
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc ~ 'card_authors'), array['create_card', 'delete_card', 'get_cycle_status', 'get_my_cards', 'update_card'], 'still only the four card RPCs and get_cycle_status in public mention card_authors');

-- ---------------------------------------------------------------------------
-- P1: cards while collecting. Card writes add no event.
-- ---------------------------------------------------------------------------
set local role authenticated;
select cycle_events_test.add_card('A', 'P1', 'A attributed', false);
select cycle_events_test.add_card('B', 'P1', 'B anonymous', true);
select cycle_events_test.add_card('B', 'P1', 'B attributed', false);
select cycle_events_test.add_card('D', 'P1', 'D anonymous', true);
select is(cycle_events_test.events(cycle_events_test.id('P1')), 0, 'create_card adds no event');
select cycle_events_test.add_card('B', 'P1', 'B extra', false);
select is(cycle_events_test.card_err('B', 'update', 'P1', 'B extra'), 'ok', 'B updates a card while collecting');
select is(cycle_events_test.events(cycle_events_test.id('P1')), 0, 'update_card adds no event');
select is(cycle_events_test.card_err('B', 'delete', 'P1', 'B extra'), 'ok', 'B deletes a card while collecting');
select is(cycle_events_test.events(cycle_events_test.id('P1')), 0, 'delete_card adds no event');
reset role;

-- ---------------------------------------------------------------------------
-- start_retrospective: shape and hardening.
-- ---------------------------------------------------------------------------
select has_function('public', 'start_retrospective', array['uuid'], 'start_retrospective(uuid) exists');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'start_retrospective'), 1, 'start_retrospective has exactly one overload');
select is(pg_get_function_identity_arguments('public.start_retrospective(uuid)'::regprocedure), 'p_cycle_id uuid', 'start_retrospective takes only the cycle id');
select is(pg_get_function_result('public.start_retrospective(uuid)'::regprocedure), 'TABLE(id uuid, status text, revealed_at timestamp with time zone)', 'start_retrospective returns id, status, and revealed_at');
select is((select prosecdef from pg_proc where oid = 'public.start_retrospective(uuid)'::regprocedure), true, 'start_retrospective is security definer');
select is((select provolatile::text from pg_proc where oid = 'public.start_retrospective(uuid)'::regprocedure), 'v', 'start_retrospective is volatile');
select is((select proconfig from pg_proc where oid = 'public.start_retrospective(uuid)'::regprocedure), array['search_path=""']::text[], 'start_retrospective fixes search_path to empty');
select is((select prosrc ~ '\mexecute\M' from pg_proc where oid = 'public.start_retrospective(uuid)'::regprocedure), false, 'start_retrospective uses no dynamic SQL');
select is((select prosrc ~ '\(select auth\.uid\(\)\) is null' from pg_proc where oid = 'public.start_retrospective(uuid)'::regprocedure), true, 'start_retrospective checks (select auth.uid())');
select is((select prosrc ~ 'private\.is_project_member\(cycle_project\)' from pg_proc where oid = 'public.start_retrospective(uuid)'::regprocedure), true, 'start_retrospective uses private.is_project_member');
select is((select prosrc ~ 'private\.is_project_facilitator\(cycle_project\)' from pg_proc where oid = 'public.start_retrospective(uuid)'::regprocedure), true, 'start_retrospective uses private.is_project_facilitator');
select is((select prosrc ~ '(^|[^.\w])(feedback_cycles|projects)\M' from pg_proc where oid = 'public.start_retrospective(uuid)'::regprocedure), false, 'start_retrospective schema-qualifies every table');
select ok(
  (select
     strpos(prosrc, 'from public.projects p where p.id = cycle_project for share') > 0
     and strpos(prosrc, 'from public.projects p where p.id = cycle_project for share') < strpos(prosrc, 'if not private.is_project_facilitator(cycle_project)')
     and strpos(prosrc, 'if not private.is_project_facilitator(cycle_project)') < strpos(prosrc, 'for update;')
     and strpos(prosrc, 'for update;') < strpos(prosrc, 'if cycle_status = ''collecting''')
   from pg_proc where oid = 'public.start_retrospective(uuid)'::regprocedure),
  'the projects row is locked FOR SHARE before the facilitator check, and the cycle FOR UPDATE before the status check'
);
select is((select prosrc ~* 'raise\s+(notice|log|info|debug|warning)' from pg_proc where oid = 'public.start_retrospective(uuid)'::regprocedure), false, 'start_retrospective raises no notice, log, info, debug, or warning');
select is(
  (select array_agg(distinct m.msg[1] order by m.msg[1]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'message\s*=\s*''([^'']*)''', 'g') as m(msg) where p.oid = 'public.start_retrospective(uuid)'::regprocedure),
  array['cycle_not_collecting', 'not_project_facilitator', 'not_project_member'],
  'the only error messages are not_project_member, not_project_facilitator, and cycle_not_collecting'
);
select is(
  (select (select count(*) from regexp_matches(p.prosrc, '\mraise\M', 'gi'))::int from pg_proc p where p.oid = 'public.start_retrospective(uuid)'::regprocedure),
  (select (select count(*) from regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''(not_project_member|not_project_facilitator|cycle_not_collecting)'';', 'g'))::int from pg_proc p where p.oid = 'public.start_retrospective(uuid)'::regprocedure),
  'every raise is a bare errcode and message with no detail or hint'
);
select is(has_function_privilege('anon', 'public.start_retrospective(uuid)', 'EXECUTE'), false, 'anon cannot execute start_retrospective');
select is(has_function_privilege('authenticated', 'public.start_retrospective(uuid)', 'EXECUTE'), true, 'authenticated can execute start_retrospective');
select is(has_function_privilege('service_role', 'public.start_retrospective(uuid)', 'EXECUTE'), false, 'service_role is not granted start_retrospective');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.start_retrospective(uuid)'::regprocedure), 0, 'PUBLIC cannot execute start_retrospective');

-- ---------------------------------------------------------------------------
-- start_retrospective: who may call it. Nothing changes on any refusal.
-- ---------------------------------------------------------------------------
select cycle_events_test.snap('P1 before', cycle_events_test.state(cycle_events_test.id('P1')));
set local role authenticated;
select is(cycle_events_test.start_err('B', cycle_events_test.id('P1')), cycle_events_test.denied('not_project_facilitator'), 'ordinary member B gets not_project_facilitator');
select is(cycle_events_test.start_err(null, cycle_events_test.id('P1')), cycle_events_test.denied('not_project_member'), 'a null auth.uid() gets not_project_member');
select is(cycle_events_test.start_err('A', null), cycle_events_test.denied('not_project_member'), 'a null cycle id gets not_project_member');
select is(cycle_events_test.start_err('A', '34000000-0000-4000-8000-0000000000ff'), cycle_events_test.denied('not_project_member'), 'an unknown cycle id gets not_project_member');
select is(cycle_events_test.start_err('C', cycle_events_test.id('P1')), cycle_events_test.denied('not_project_member'), 'non-member C gets not_project_member');
select is(cycle_events_test.start_err('C', cycle_events_test.id('P1')), cycle_events_test.start_err('C', gen_random_uuid()), 'an existing cycle and a random UUID give non-member C the same error');
select is(cycle_events_test.start_err('A', cycle_events_test.id('Q1')), cycle_events_test.denied('not_project_member'), 'A, a member of another project, gets not_project_member for a Q cycle');
reset role;
select is(cycle_events_test.state(cycle_events_test.id('P1')), cycle_events_test.snapped('P1 before'), 'after every refusal P1''s status, revealed_at, and event count are unchanged');
select is(cycle_events_test.state(cycle_events_test.id('P1')) ->> 'status', 'collecting', 'P1 is still collecting');

-- The status update and the event are one transaction.
alter table public.cycle_events add constraint cycle_events_test_block check (to_status <> 'reveal') not valid;
set local role authenticated;
select is(cycle_events_test.start_err('A', cycle_events_test.id('P1')) ->> 'code', '23514', 'when the event insert fails, start_retrospective fails');
reset role;
select is(cycle_events_test.state(cycle_events_test.id('P1')), cycle_events_test.snapped('P1 before'), 'when the event insert fails, P1 stays collecting with no event');
alter table public.cycle_events drop constraint cycle_events_test_block;

-- ---------------------------------------------------------------------------
-- D is removed (no removal UI until #49), then A starts P1.
-- ---------------------------------------------------------------------------
delete from public.project_members where project_id = '24000000-0000-4000-8000-000000000001' and user_id = '14000000-0000-4000-8000-000000000004';
select cycle_events_test.snap('cards before start', to_jsonb(cycle_events_test.cards_md5()));

set local role authenticated;
select cycle_events_test.snap('P1 start', cycle_events_test.start('A', cycle_events_test.id('P1')));
reset role;
select is((select array_agg(k order by k) from jsonb_object_keys(cycle_events_test.snapped('P1 start')) k), array['id', 'revealed_at', 'status'], 'the result has exactly id, status, and revealed_at');
select is(cycle_events_test.snapped('P1 start') ->> 'id', cycle_events_test.id('P1')::text, 'the result names P1');
select is(cycle_events_test.snapped('P1 start') ->> 'status', 'reveal', 'the result status is reveal');
select isnt(cycle_events_test.snapped('P1 start') -> 'revealed_at', 'null'::jsonb, 'the result revealed_at is set');
select is((select status from public.feedback_cycles where id = '34000000-0000-4000-8000-000000000001'), 'reveal', 'P1 is now reveal');
select is(to_jsonb((select revealed_at from public.feedback_cycles where id = '34000000-0000-4000-8000-000000000001')), cycle_events_test.snapped('P1 start') -> 'revealed_at', 'P1 has the returned revealed_at');
select is(cycle_events_test.event_list(cycle_events_test.id('P1')), array['collecting>reveal:A'], 'P1 has exactly one collecting -> reveal event by A');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(cycle_events_test.last_event(cycle_events_test.id('P1'))) k),
  array['actor_id', 'created_at', 'cycle_id', 'from_status', 'id', 'payload', 'to_status', 'type'],
  'the event row has exactly its eight columns'
);
select is(cycle_events_test.last_event(cycle_events_test.id('P1')) -> 'payload', '{}'::jsonb, 'the event payload is {}');
select is(cycle_events_test.last_event(cycle_events_test.id('P1')) ->> 'type', 'stage_changed', 'the event type is stage_changed');
select is(to_jsonb(cycle_events_test.cards_md5()), cycle_events_test.snapped('cards before start'), 'starting changes no cards or card_authors row');

set local role authenticated;
select is((cycle_events_test.st('A', cycle_events_test.id('P1')) ->> 'is_revealed')::boolean, true, 'get_cycle_status: is_revealed is true');
select is((cycle_events_test.st('A', cycle_events_test.id('P1')) ->> 'card_count')::int, 4, 'get_cycle_status: card_count counts every card, anonymous, attributed, and the removed member''s');
select is((cycle_events_test.st('A', cycle_events_test.id('P1')) ->> 'card_count')::int, cycle_events_test.card_rows(cycle_events_test.id('P1')), 'get_cycle_status: card_count equals the number of the cycle''s cards');
select is((cycle_events_test.st('A', cycle_events_test.id('P1')) ->> 'member_count')::int, 2, 'removed member D is not counted as a member');
select is((cycle_events_test.st('A', cycle_events_test.id('P1')) ->> 'submitted_member_count')::int, 2, 'removed member D is not counted as submitted');
select is(cycle_events_test.visible_events('B', cycle_events_test.id('P1')), 1, 'member B selects the one P1 event');
select is(cycle_events_test.visible_events('A', cycle_events_test.id('P1')), 1, 'facilitator A selects the one P1 event');
select is(cycle_events_test.visible_events('C', cycle_events_test.id('P1')), 0, 'non-member C selects no P1 event');
select is(cycle_events_test.visible_events('D', cycle_events_test.id('P1')), 0, 'removed member D selects no P1 event');
select is(cycle_events_test.visible_events('A', cycle_events_test.id('Q1')), 0, 'A selects no event of another project');
select is(cycle_events_test.start_err('D', cycle_events_test.id('P1')), cycle_events_test.denied('not_project_member'), 'removed member D gets not_project_member from start_retrospective');
select is(cycle_events_test.status_err('D', cycle_events_test.id('P1')), jsonb_build_object('code', '42501', 'message', 'not_project_member'), 'removed member D gets not_project_member from get_cycle_status');
reset role;
set local role anon;
select throws_ok($$ select count(*) from public.cycle_events $$, '42501'::char(5), NULL, 'anon cannot select cycle_events');
reset role;

-- A repeated start is a no-op that returns the same row.
set local role authenticated;
select is(cycle_events_test.start('A', cycle_events_test.id('P1')), cycle_events_test.snapped('P1 start'), 'a second start returns the same id, status, and revealed_at');
reset role;
select is(cycle_events_test.events(cycle_events_test.id('P1')), 1, 'a second start adds no event');

-- After the reveal no card can be added, edited, or deleted.
set local role authenticated;
select is(cycle_events_test.card_err('A', 'create', 'P1', null), 'cycle_not_collecting', 'after reveal create_card fails with cycle_not_collecting');
select is(cycle_events_test.card_err('A', 'update', 'P1', 'A attributed'), 'cycle_not_collecting', 'after reveal update_card fails with cycle_not_collecting');
select is(cycle_events_test.card_err('B', 'delete', 'P1', 'B anonymous'), 'cycle_not_collecting', 'after reveal delete_card fails with cycle_not_collecting');
select is(cycle_events_test.my_cards('A', cycle_events_test.id('P1')), 1, 'get_my_cards still returns A''s card');
select is(cycle_events_test.my_cards('B', cycle_events_test.id('P1')), 2, 'get_my_cards still returns B''s two cards');
reset role;
select is(to_jsonb(cycle_events_test.cards_md5()), cycle_events_test.snapped('cards before start'), 'the failed card writes changed nothing');

-- Anonymity after reveal: no table access on cards or card_authors.
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('cards', 'card_authors')), 0, 'after reveal cards and card_authors still have no policy');
select is(has_table_privilege('authenticated', 'public.cards', 'SELECT'), false, 'after reveal authenticated still cannot select cards');
select is(has_table_privilege('authenticated', 'public.card_authors', 'SELECT'), false, 'after reveal authenticated still cannot select card_authors');
select is((select count(*)::int from pg_depend d join pg_rewrite r on r.oid = d.objid where d.classid = 'pg_rewrite'::regclass and d.refobjid in ('public.cards'::regclass, 'public.card_authors'::regclass, 'public.profiles'::regclass)), 0, 'no view reads cards, card_authors, or profiles');
set local role authenticated;
select cycle_events_test.become('A');
select throws_ok($$ select count(*) from public.cards $$, '42501'::char(5), NULL, 'after reveal facilitator A cannot select cards');
select throws_ok($$ select count(*) from public.card_authors $$, '42501'::char(5), NULL, 'after reveal facilitator A cannot select card_authors');
select cycle_events_test.become('B');
select throws_ok($$ select count(*) from public.cards $$, '42501'::char(5), NULL, 'after reveal member B cannot select cards');
reset role;

-- ---------------------------------------------------------------------------
-- Later stages and closed: start fails, nothing changes.
-- ---------------------------------------------------------------------------
select cycle_events_test.become(null);
update public.feedback_cycles set status = 'cluster' where id = '34000000-0000-4000-8000-000000000001';
select cycle_events_test.snap('P1 cluster', cycle_events_test.state(cycle_events_test.id('P1')));
set local role authenticated;
select is(cycle_events_test.start_err('A', cycle_events_test.id('P1')), cycle_events_test.denied('cycle_not_collecting'), 'cluster: start fails with cycle_not_collecting');
reset role;
select is(cycle_events_test.state(cycle_events_test.id('P1')), cycle_events_test.snapped('P1 cluster'), 'cluster: status, revealed_at, and event count are unchanged');

select cycle_events_test.become(null);
update public.feedback_cycles set status = 'vote' where id = '34000000-0000-4000-8000-000000000001';
select cycle_events_test.snap('P1 vote', cycle_events_test.state(cycle_events_test.id('P1')));
set local role authenticated;
select is(cycle_events_test.start_err('A', cycle_events_test.id('P1')), cycle_events_test.denied('cycle_not_collecting'), 'vote: start fails with cycle_not_collecting');
reset role;
select is(cycle_events_test.state(cycle_events_test.id('P1')), cycle_events_test.snapped('P1 vote'), 'vote: status, revealed_at, and event count are unchanged');

select cycle_events_test.become(null);
update public.feedback_cycles set status = 'discuss', voting_closed_at = now() where id = '34000000-0000-4000-8000-000000000001';
select cycle_events_test.snap('P1 discuss', cycle_events_test.state(cycle_events_test.id('P1')));
set local role authenticated;
select is(cycle_events_test.start_err('A', cycle_events_test.id('P1')), cycle_events_test.denied('cycle_not_collecting'), 'discuss: start fails with cycle_not_collecting');
reset role;
select is(cycle_events_test.state(cycle_events_test.id('P1')), cycle_events_test.snapped('P1 discuss'), 'discuss: status, revealed_at, and event count are unchanged');

-- close_cycle from discuss (#68): one event by the facilitator, then none.
set local role authenticated;
select lives_ok($$ select cycle_events_test.close('A', '34000000-0000-4000-8000-000000000001') $$, 'A closes P1 from discuss');
reset role;
select is(
  cycle_events_test.event_list(cycle_events_test.id('P1')),
  array['collecting>reveal:A', 'reveal>cluster:null', 'cluster>vote:null', 'vote>discuss:null', 'discuss>closed:A'],
  'P1 has one event per stage change; close_cycle adds discuss -> closed by A'
);
set local role authenticated;
select lives_ok($$ select cycle_events_test.close('A', '34000000-0000-4000-8000-000000000001') $$, 'a second close_cycle succeeds');
reset role;
select is(cycle_events_test.events(cycle_events_test.id('P1')), 5, 'a second close_cycle adds no event');
select cycle_events_test.snap('P1 closed', cycle_events_test.state(cycle_events_test.id('P1')));
set local role authenticated;
select is(cycle_events_test.start_err('A', cycle_events_test.id('P1')), cycle_events_test.denied('cycle_not_collecting'), 'closed after reveal: start fails with cycle_not_collecting');
reset role;
select is(cycle_events_test.state(cycle_events_test.id('P1')), cycle_events_test.snapped('P1 closed'), 'closed after reveal: nothing changes');

-- ---------------------------------------------------------------------------
-- P2: zero cards and zero submitters, then closed from reveal.
-- ---------------------------------------------------------------------------
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('34000000-0000-4000-8000-000000000002', '24000000-0000-4000-8000-000000000001', 'P two', '2026-10-26');
set local role authenticated;
select is(cycle_events_test.start('A', cycle_events_test.id('P2')) ->> 'status', 'reveal', 'start succeeds with zero cards');
select is((cycle_events_test.st('B', cycle_events_test.id('P2')) ->> 'is_revealed')::boolean, true, 'zero cards: is_revealed is true');
select is((cycle_events_test.st('B', cycle_events_test.id('P2')) ->> 'card_count')::int, 0, 'zero cards: card_count is 0');
select is((cycle_events_test.st('B', cycle_events_test.id('P2')) ->> 'submitted_member_count')::int, 0, 'zero cards: no one submitted');
select lives_ok($$ select cycle_events_test.close('A', '34000000-0000-4000-8000-000000000002') $$, 'A closes P2 from reveal');
reset role;
select is(cycle_events_test.event_list(cycle_events_test.id('P2')), array['collecting>reveal:A', 'reveal>closed:A'], 'P2 has collecting -> reveal then reveal -> closed, both by A');

-- ---------------------------------------------------------------------------
-- P3: closed straight from collecting, never revealed.
-- ---------------------------------------------------------------------------
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('34000000-0000-4000-8000-000000000003', '24000000-0000-4000-8000-000000000001', 'P three', '2026-10-26');
set local role authenticated;
select cycle_events_test.add_card('B', 'P3', 'B early', true);
select lives_ok($$ select cycle_events_test.close('A', '34000000-0000-4000-8000-000000000003') $$, 'A closes P3 from collecting');
reset role;
select is(cycle_events_test.event_list(cycle_events_test.id('P3')), array['collecting>closed:A'], 'P3 has one collecting -> closed event by A');
select cycle_events_test.snap('P3 closed', cycle_events_test.state(cycle_events_test.id('P3')));
set local role authenticated;
select is(cycle_events_test.start_err('A', cycle_events_test.id('P3')), cycle_events_test.denied('cycle_not_collecting'), 'closed from collecting: start fails with cycle_not_collecting');
select is(cycle_events_test.st('B', cycle_events_test.id('P3')) -> 'card_count', 'null'::jsonb, 'closed from collecting: card_count stays null');
select is((cycle_events_test.st('B', cycle_events_test.id('P3')) ->> 'is_revealed')::boolean, false, 'closed from collecting: is_revealed stays false');
reset role;
select is(cycle_events_test.state(cycle_events_test.id('P3')), cycle_events_test.snapped('P3 closed'), 'closed from collecting: nothing changes');
select is(cycle_events_test.state(cycle_events_test.id('P3')) -> 'revealed_at', 'null'::jsonb, 'the early-closed cycle keeps revealed_at null');

-- ---------------------------------------------------------------------------
-- P5 and P6: close_cycle from cluster and from vote.
-- ---------------------------------------------------------------------------
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('34000000-0000-4000-8000-000000000005', '24000000-0000-4000-8000-000000000001', 'P five', '2026-10-26');
set local role authenticated;
select is(cycle_events_test.start('A', cycle_events_test.id('P5')) ->> 'status', 'reveal', 'A starts P5');
reset role;
select cycle_events_test.become(null);
update public.feedback_cycles set status = 'cluster' where id = '34000000-0000-4000-8000-000000000005';
set local role authenticated;
select lives_ok($$ select cycle_events_test.close('A', '34000000-0000-4000-8000-000000000005') $$, 'A closes P5 from cluster');
reset role;
select is(cycle_events_test.event_list(cycle_events_test.id('P5')), array['collecting>reveal:A', 'reveal>cluster:null', 'cluster>closed:A'], 'close_cycle from cluster adds one event by A');

insert into public.feedback_cycles (id, project_id, title, week_start)
values ('34000000-0000-4000-8000-000000000006', '24000000-0000-4000-8000-000000000001', 'P six', '2026-10-26');
set local role authenticated;
select is(cycle_events_test.start('A', cycle_events_test.id('P6')) ->> 'status', 'reveal', 'A starts P6');
reset role;
select cycle_events_test.become(null);
update public.feedback_cycles set status = 'cluster' where id = '34000000-0000-4000-8000-000000000006';
update public.feedback_cycles set status = 'vote' where id = '34000000-0000-4000-8000-000000000006';
set local role authenticated;
select lives_ok($$ select cycle_events_test.close('A', '34000000-0000-4000-8000-000000000006') $$, 'A closes P6 from vote');
select lives_ok($$ select cycle_events_test.close('A', '34000000-0000-4000-8000-000000000006') $$, 'a second close of P6 succeeds');
reset role;
select is(cycle_events_test.event_list(cycle_events_test.id('P6')), array['collecting>reveal:A', 'reveal>cluster:null', 'cluster>vote:null', 'vote>closed:A'], 'close_cycle from vote adds one event by A, and a second close adds none');

-- ---------------------------------------------------------------------------
-- P4: after transfer_facilitator, the owner is refused and B succeeds.
-- ---------------------------------------------------------------------------
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('34000000-0000-4000-8000-000000000004', '24000000-0000-4000-8000-000000000001', 'P four', '2026-10-26');
set local role authenticated;
select cycle_events_test.become('A');
select lives_ok($$ select public.transfer_facilitator('24000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000002') $$, 'owner A transfers the facilitator role to B');
select is(cycle_events_test.start_err('A', cycle_events_test.id('P4')), cycle_events_test.denied('not_project_facilitator'), 'owner A, no longer the facilitator, gets not_project_facilitator');
reset role;
select is(cycle_events_test.state(cycle_events_test.id('P4')) ->> 'status', 'collecting', 'P4 is still collecting after A''s refusal');
set local role authenticated;
select is(cycle_events_test.start('B', cycle_events_test.id('P4')) ->> 'status', 'reveal', 'facilitator B starts P4');
select lives_ok($$ select cycle_events_test.close('B', '34000000-0000-4000-8000-000000000004') $$, 'facilitator B closes P4');
reset role;
select is(cycle_events_test.event_list(cycle_events_test.id('P4')), array['collecting>reveal:B', 'reveal>closed:B'], 'P4''s events name B as the actor');

-- ---------------------------------------------------------------------------
-- Deletes: cascades from the cycle and the project; a deleted actor is
-- forgotten, not deleted.
-- ---------------------------------------------------------------------------
insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id)
values ('34000000-0000-4000-8000-000000000003', 'stage_changed', 'collecting', 'closed', '14000000-0000-4000-8000-000000000004');
select is(cycle_events_test.events(cycle_events_test.id('P3')), 2, 'P3 has an extra event naming D');
delete from auth.users where id = '14000000-0000-4000-8000-000000000004';
select is(cycle_events_test.events(cycle_events_test.id('P3')), 2, 'deleting the actor''s auth user keeps the event');
select is((select count(*)::int from public.cycle_events where cycle_id = '34000000-0000-4000-8000-000000000003' and actor_id is null), 1, 'the deleted actor''s event now has a null actor_id');

delete from public.feedback_cycles where id = '34000000-0000-4000-8000-000000000012';
select is(cycle_events_test.events(cycle_events_test.id('Q2')), 0, 'deleting a cycle deletes its events');
select is((select count(*)::int from public.cycle_events e join public.feedback_cycles fc on fc.id = e.cycle_id where fc.project_id = '24000000-0000-4000-8000-000000000002'), 14, 'Q''s other cycles still have their events');
delete from public.projects where id = '24000000-0000-4000-8000-000000000002';
select is((select count(*)::int from public.cycle_events where cycle_id in ('34000000-0000-4000-8000-000000000011', '34000000-0000-4000-8000-000000000013', '34000000-0000-4000-8000-000000000014', '34000000-0000-4000-8000-000000000015')), 0, 'deleting a project deletes its cycles'' events');

select * from finish();
rollback;
