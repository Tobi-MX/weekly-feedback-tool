-- pgTAP tests for weekly feedback cycles: the table shape, its CHECKs and
-- indexes, the transition and immutability guard, RLS and grants, and the
-- create_cycle and close_cycle RPCs.
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension itself. The seed user is never used as a fixture.
--
-- Fixtures: owner and facilitator A, member B, non-member C.
-- Project P is owned by A with B joined; project Q is owned by C, so B is
-- never in Q. Projects R, S, and T are A's and hold service_role fixtures.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(220);

-- ---------------------------------------------------------------------------
-- Fixtures. Inserting auth.users rows fires private.handle_new_user(), and
-- inserting projects fires the owner-membership trigger (owner = facilitator).
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'cycles-a@example.com', '{"display_name":"Alice"}'),
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'cycles-b@example.com', '{"display_name":"Bob"}'),
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'cycles-c@example.com', '{"display_name":"Cara"}');

insert into public.projects (id, name, owner_id)
values
  ('21000000-0000-4000-8000-000000000001', 'Project P', '11000000-0000-4000-8000-000000000001'),
  ('21000000-0000-4000-8000-000000000002', 'Project Q', '11000000-0000-4000-8000-000000000003'),
  ('21000000-0000-4000-8000-000000000003', 'Project R', '11000000-0000-4000-8000-000000000001'),
  ('21000000-0000-4000-8000-000000000004', 'Project S', '11000000-0000-4000-8000-000000000001'),
  ('21000000-0000-4000-8000-000000000005', 'Project T', '11000000-0000-4000-8000-000000000001');

insert into public.project_members (project_id, user_id, role)
values ('21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002', 'member');

-- ---------------------------------------------------------------------------
-- feedback_cycles shape.
-- ---------------------------------------------------------------------------
select has_table('public', 'feedback_cycles', 'feedback_cycles table exists');
select columns_are('public', 'feedback_cycles', array['id', 'project_id', 'title', 'week_start', 'status', 'created_by', 'created_at', 'updated_at', 'revealed_at', 'voting_closed_at', 'closed_at'], 'feedback_cycles has exactly the eleven expected columns');
select col_type_is('public', 'feedback_cycles', 'id', 'uuid', 'id is uuid');
select col_type_is('public', 'feedback_cycles', 'project_id', 'uuid', 'project_id is uuid');
select col_type_is('public', 'feedback_cycles', 'title', 'text', 'title is text');
select col_type_is('public', 'feedback_cycles', 'week_start', 'date', 'week_start is date');
select col_type_is('public', 'feedback_cycles', 'status', 'text', 'status is text');
select col_type_is('public', 'feedback_cycles', 'created_by', 'uuid', 'created_by is uuid');
select col_type_is('public', 'feedback_cycles', 'created_at', 'timestamp with time zone', 'created_at is timestamptz');
select col_type_is('public', 'feedback_cycles', 'updated_at', 'timestamp with time zone', 'updated_at is timestamptz');
select col_type_is('public', 'feedback_cycles', 'revealed_at', 'timestamp with time zone', 'revealed_at is timestamptz');
select col_type_is('public', 'feedback_cycles', 'voting_closed_at', 'timestamp with time zone', 'voting_closed_at is timestamptz');
select col_type_is('public', 'feedback_cycles', 'closed_at', 'timestamp with time zone', 'closed_at is timestamptz');
select col_is_pk('public', 'feedback_cycles', 'id', 'id is the primary key');
select col_not_null('public', 'feedback_cycles', 'project_id', 'project_id is not null');
select col_not_null('public', 'feedback_cycles', 'title', 'title is not null');
select col_not_null('public', 'feedback_cycles', 'week_start', 'week_start is not null');
select col_not_null('public', 'feedback_cycles', 'status', 'status is not null');
select col_not_null('public', 'feedback_cycles', 'created_at', 'created_at is not null');
select col_not_null('public', 'feedback_cycles', 'updated_at', 'updated_at is not null');
select col_is_null('public', 'feedback_cycles', 'created_by', 'created_by is nullable');
select col_is_null('public', 'feedback_cycles', 'revealed_at', 'revealed_at is nullable');
select col_is_null('public', 'feedback_cycles', 'voting_closed_at', 'voting_closed_at is nullable');
select col_is_null('public', 'feedback_cycles', 'closed_at', 'closed_at is nullable');
select col_default_is('public', 'feedback_cycles', 'status', 'collecting', 'status defaults to collecting');
select matches((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.feedback_cycles'::regclass and a.attname = 'id'), 'gen_random_uuid\(\)', 'id defaults to gen_random_uuid()');
select matches((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.feedback_cycles'::regclass and a.attname = 'created_at'), 'now\(\)', 'created_at defaults to now()');
select matches((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.feedback_cycles'::regclass and a.attname = 'updated_at'), 'now\(\)', 'updated_at defaults to now()');

select is((select confrelid::regclass::text from pg_constraint where conrelid = 'public.feedback_cycles'::regclass and conname = 'feedback_cycles_project_id_fkey'), 'projects', 'project_id references public.projects');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.feedback_cycles'::regclass and conname = 'feedback_cycles_project_id_fkey'), 'c', 'the project_id foreign key is ON DELETE CASCADE');
select is((select confrelid::regclass::text from pg_constraint where conrelid = 'public.feedback_cycles'::regclass and conname = 'feedback_cycles_created_by_fkey'), 'auth.users', 'created_by references auth.users');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.feedback_cycles'::regclass and conname = 'feedback_cycles_created_by_fkey'), 'n', 'the created_by foreign key is ON DELETE SET NULL');
select is((select count(*)::int from pg_constraint where conrelid = 'public.feedback_cycles'::regclass and contype = 'f'), 2, 'feedback_cycles has exactly two foreign keys');

-- ---------------------------------------------------------------------------
-- Named CHECK constraints. Fixture rows go in as service_role, the only role
-- with a write grant.
-- ---------------------------------------------------------------------------
select is((select contype::text from pg_constraint where conrelid = 'public.feedback_cycles'::regclass and conname = 'feedback_cycles_status_check'), 'c', 'the named status CHECK exists');
select is((select contype::text from pg_constraint where conrelid = 'public.feedback_cycles'::regclass and conname = 'feedback_cycles_title_check'), 'c', 'the named title CHECK exists');
select is((select contype::text from pg_constraint where conrelid = 'public.feedback_cycles'::regclass and conname = 'feedback_cycles_week_start_monday_check'), 'c', 'the named week_start Monday CHECK exists');
select is((select contype::text from pg_constraint where conrelid = 'public.feedback_cycles'::regclass and conname = 'feedback_cycles_closed_at_check'), 'c', 'the named closed_at CHECK exists');
select is((select contype::text from pg_constraint where conrelid = 'public.feedback_cycles'::regclass and conname = 'feedback_cycles_revealed_at_check'), 'c', 'the named revealed_at CHECK exists');

set local role service_role;
select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start, status) values ('21000000-0000-4000-8000-000000000003', 'T', '2026-10-26', 'open') $$, '23514'::char(5), NULL, 'status open is rejected');
select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start, status) values ('21000000-0000-4000-8000-000000000003', 'T', '2026-10-26', '') $$, '23514'::char(5), NULL, 'an empty status is rejected');
select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start, status) values ('21000000-0000-4000-8000-000000000003', 'T', '2026-10-26', 'Collecting') $$, '23514'::char(5), NULL, 'status Collecting (wrong case) is rejected');

select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start) values ('21000000-0000-4000-8000-000000000003', '', '2026-10-26') $$, '23514'::char(5), NULL, 'an empty title is rejected');
select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start) values ('21000000-0000-4000-8000-000000000003', '  x', '2026-10-26') $$, '23514'::char(5), NULL, 'a title with leading spaces is rejected');
select throws_ok(format('insert into public.feedback_cycles (project_id, title, week_start) values (%L, %L, %L)', '21000000-0000-4000-8000-000000000003', repeat('x', 101), '2026-10-26'), '23514'::char(5), NULL, 'a 101-character title is rejected');
select lives_ok(format('insert into public.feedback_cycles (project_id, title, week_start, status, closed_at) values (%L, %L, %L, %L, now())', '21000000-0000-4000-8000-000000000003', repeat('x', 100), '2026-10-26', 'closed'), 'a 100-character title is accepted');

select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start) values ('21000000-0000-4000-8000-000000000003', 'Sunday', '2026-10-25') $$, '23514'::char(5), NULL, 'a Sunday week_start is rejected');
select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start) values ('21000000-0000-4000-8000-000000000003', 'Tuesday', '2026-10-27') $$, '23514'::char(5), NULL, 'a Tuesday week_start is rejected');

select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start, status) values ('21000000-0000-4000-8000-000000000003', 'No closed_at', '2026-10-26', 'closed') $$, '23514'::char(5), NULL, 'a closed cycle without closed_at is rejected');
select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start, closed_at) values ('21000000-0000-4000-8000-000000000003', 'Open with closed_at', '2026-10-26', now()) $$, '23514'::char(5), NULL, 'an open cycle with closed_at is rejected');
select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start, revealed_at) values ('21000000-0000-4000-8000-000000000003', 'Collecting revealed', '2026-10-26', now()) $$, '23514'::char(5), NULL, 'a collecting cycle with revealed_at is rejected');
select lives_ok($$ insert into public.feedback_cycles (project_id, title, week_start, status, closed_at) values ('21000000-0000-4000-8000-000000000003', 'Closed without reveal', '2026-10-26', 'closed', now()) $$, 'a closed cycle without revealed_at is accepted (ended early)');
reset role;

-- ---------------------------------------------------------------------------
-- Indexes: one open cycle per project, and the project-page list.
-- ---------------------------------------------------------------------------
select is(to_regclass('public.feedback_cycles_one_open_idx')::text, 'feedback_cycles_one_open_idx', 'feedback_cycles_one_open_idx exists');
select ok((select indisunique from pg_index where indexrelid = 'public.feedback_cycles_one_open_idx'::regclass), 'the open-cycle index is unique');
select matches(pg_get_indexdef('public.feedback_cycles_one_open_idx'::regclass), '\(project_id\) WHERE \(status <> ''closed''::text\)', 'the open-cycle index is on (project_id) where status <> closed');
select is(to_regclass('public.feedback_cycles_project_created_idx')::text, 'feedback_cycles_project_created_idx', 'feedback_cycles_project_created_idx exists');
select matches(pg_get_indexdef('public.feedback_cycles_project_created_idx'::regclass), 'ON public\.feedback_cycles USING btree \(project_id, created_at DESC\)$', 'the list index is on (project_id, created_at desc)');

set local role service_role;
select lives_ok($$ insert into public.feedback_cycles (id, project_id, title, week_start) values ('31000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000003', 'R first', '2026-10-26') $$, 'service_role can insert an open cycle');
select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start) values ('21000000-0000-4000-8000-000000000003', 'R second', '2026-11-02') $$, '23505'::char(5), NULL, 'a second open cycle for the same project is rejected');
select lives_ok($$ insert into public.feedback_cycles (id, project_id, title, week_start, created_at, updated_at) values ('31000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000005', 'T open', '2026-10-26', '2026-01-05 09:00:00+00', '2026-01-05 09:00:00+00') $$, 'an open cycle for a different project is accepted');
-- Several cycles may share a week_start once the first is closed.
select lives_ok($$ update public.feedback_cycles set status = 'closed', closed_at = now() where id = '31000000-0000-4000-8000-000000000001' $$, 'the open R cycle can be closed early');
select lives_ok($$ insert into public.feedback_cycles (project_id, title, week_start) values ('21000000-0000-4000-8000-000000000003', 'R again', '2026-10-26') $$, 'a second collecting cycle for the same week is accepted after closing the first');
reset role;
select is((select count(*)::int from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000003' and week_start = '2026-10-26'), 4, 'project R holds four cycles for the same week');
select is((select count(*)::int from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000003' and status <> 'closed'), 1, 'project R has exactly one open cycle');

-- ---------------------------------------------------------------------------
-- updated_at trigger. The fixture row starts with past timestamps so the
-- change is visible inside this single transaction.
-- ---------------------------------------------------------------------------
select trigger_is('public', 'feedback_cycles', 'feedback_cycles_set_updated_at', 'private', 'set_updated_at', 'the updated_at trigger reuses private.set_updated_at');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.feedback_cycles'::regclass and tgname = 'feedback_cycles_set_updated_at'), 19, 'the updated_at trigger is BEFORE UPDATE FOR EACH ROW');
select is((select count(*)::int from pg_proc where proname = 'set_updated_at'), 1, 'no second updated-at helper was created');
set local role service_role;
select lives_ok($$ update public.feedback_cycles set status = 'closed', closed_at = now() where id = '31000000-0000-4000-8000-000000000002' $$, 'service_role can close the T cycle');
reset role;
select is((select updated_at from public.feedback_cycles where id = '31000000-0000-4000-8000-000000000002'), now(), 'closing a cycle advances updated_at');
select is((select created_at from public.feedback_cycles where id = '31000000-0000-4000-8000-000000000002'), '2026-01-05 09:00:00+00'::timestamptz, 'closing a cycle leaves created_at unchanged');

-- ---------------------------------------------------------------------------
-- Transition and immutability guard, as service_role and as postgres.
-- ---------------------------------------------------------------------------
select trigger_is('public', 'feedback_cycles', 'feedback_cycles_guard_update', 'private', 'guard_feedback_cycle_update', 'the guard trigger exists');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.feedback_cycles'::regclass and tgname = 'feedback_cycles_guard_update'), 19, 'the guard trigger is BEFORE UPDATE FOR EACH ROW');
select is((select proconfig from pg_proc where oid = 'private.guard_feedback_cycle_update()'::regprocedure), array['search_path=""']::text[], 'the guard fixes search_path to empty');
select is(has_function_privilege('authenticated', 'private.guard_feedback_cycle_update()', 'EXECUTE'), false, 'authenticated cannot execute the guard function');
select is(has_function_privilege('anon', 'private.guard_feedback_cycle_update()', 'EXECUTE'), false, 'anon cannot execute the guard function');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'private.guard_feedback_cycle_update()'::regprocedure), 0, 'PUBLIC cannot execute the guard function');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'EXECUTE')), 2, 'authenticated can still execute exactly two private functions');

set local role service_role;
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('31000000-0000-4000-8000-000000000003', '21000000-0000-4000-8000-000000000004', 'S cycle', '2026-10-26');
select throws_ok($$ update public.feedback_cycles set status = 'cluster' where id = '31000000-0000-4000-8000-000000000003' $$, 'P0001'::char(5), 'invalid_status_transition', 'collecting -> cluster is rejected');
select throws_ok($$ update public.feedback_cycles set status = 'vote' where id = '31000000-0000-4000-8000-000000000003' $$, 'P0001'::char(5), 'invalid_status_transition', 'collecting -> vote is rejected');
select lives_ok($$ update public.feedback_cycles set status = 'reveal', revealed_at = now() where id = '31000000-0000-4000-8000-000000000003' $$, 'collecting -> reveal succeeds');
select throws_ok($$ update public.feedback_cycles set status = 'collecting', revealed_at = null where id = '31000000-0000-4000-8000-000000000003' $$, 'P0001'::char(5), 'invalid_status_transition', 'reveal -> collecting is rejected');
select lives_ok($$ update public.feedback_cycles set status = 'cluster' where id = '31000000-0000-4000-8000-000000000003' $$, 'reveal -> cluster succeeds');
select lives_ok($$ update public.feedback_cycles set status = 'vote' where id = '31000000-0000-4000-8000-000000000003' $$, 'cluster -> vote succeeds');
select throws_ok($$ update public.feedback_cycles set status = 'reveal' where id = '31000000-0000-4000-8000-000000000003' $$, 'P0001'::char(5), 'invalid_status_transition', 'vote -> reveal is rejected');
select lives_ok($$ update public.feedback_cycles set status = 'discuss', voting_closed_at = now() where id = '31000000-0000-4000-8000-000000000003' $$, 'vote -> discuss succeeds');
select throws_ok($$ update public.feedback_cycles set status = 'vote' where id = '31000000-0000-4000-8000-000000000003' $$, 'P0001'::char(5), 'invalid_status_transition', 'discuss -> vote is rejected');
select lives_ok($$ update public.feedback_cycles set status = 'closed', closed_at = now() where id = '31000000-0000-4000-8000-000000000003' $$, 'discuss -> closed succeeds');
select throws_ok($$ update public.feedback_cycles set status = 'collecting', closed_at = null where id = '31000000-0000-4000-8000-000000000003' $$, 'P0001'::char(5), 'invalid_status_transition', 'closed -> collecting is rejected');
select throws_ok($$ update public.feedback_cycles set status = 'discuss', closed_at = null where id = '31000000-0000-4000-8000-000000000003' $$, 'P0001'::char(5), 'invalid_status_transition', 'closed -> discuss is rejected');

insert into public.feedback_cycles (id, project_id, title, week_start)
values ('31000000-0000-4000-8000-000000000004', '21000000-0000-4000-8000-000000000004', 'S early', '2026-10-26');
select lives_ok($$ update public.feedback_cycles set status = 'closed', closed_at = now() where id = '31000000-0000-4000-8000-000000000004' $$, 'collecting -> closed (end early) succeeds');

insert into public.feedback_cycles (id, project_id, title, week_start)
values ('31000000-0000-4000-8000-000000000005', '21000000-0000-4000-8000-000000000004', 'S immutable', '2026-10-26');
select throws_ok($$ update public.feedback_cycles set id = gen_random_uuid() where id = '31000000-0000-4000-8000-000000000005' $$, 'P0001'::char(5), 'cycle_immutable_column', 'id cannot change');
select throws_ok($$ update public.feedback_cycles set project_id = '21000000-0000-4000-8000-000000000003' where id = '31000000-0000-4000-8000-000000000005' $$, 'P0001'::char(5), 'cycle_immutable_column', 'project_id cannot change');
select throws_ok($$ update public.feedback_cycles set week_start = '2026-11-02' where id = '31000000-0000-4000-8000-000000000005' $$, 'P0001'::char(5), 'cycle_immutable_column', 'week_start cannot change');
select throws_ok($$ update public.feedback_cycles set created_by = '11000000-0000-4000-8000-000000000002' where id = '31000000-0000-4000-8000-000000000005' $$, 'P0001'::char(5), 'cycle_immutable_column', 'created_by cannot change');
select throws_ok($$ update public.feedback_cycles set created_at = now() - interval '1 day' where id = '31000000-0000-4000-8000-000000000005' $$, 'P0001'::char(5), 'cycle_immutable_column', 'created_at cannot change');
select lives_ok($$ update public.feedback_cycles set updated_at = now() where id = '31000000-0000-4000-8000-000000000005' $$, 'an update that changes no status passes the guard');
reset role;
select is((select status from public.feedback_cycles where id = '31000000-0000-4000-8000-000000000003'), 'closed', 'the S cycle is closed after its full path');
select throws_ok($$ update public.feedback_cycles set status = 'collecting', closed_at = null where id = '31000000-0000-4000-8000-000000000003' $$, 'P0001'::char(5), 'invalid_status_transition', 'the guard also applies to the postgres role');

-- ---------------------------------------------------------------------------
-- RLS, policy, and grants.
-- ---------------------------------------------------------------------------
select is((select relrowsecurity from pg_class where oid = 'public.feedback_cycles'::regclass), true, 'RLS is enabled on feedback_cycles');
select policies_are('public', 'feedback_cycles', array['feedback_cycles_select_member'], 'exactly one policy exists on feedback_cycles');
select policy_cmd_is('public', 'feedback_cycles', 'feedback_cycles_select_member', 'SELECT', 'the policy is FOR SELECT');
select policy_roles_are('public', 'feedback_cycles', 'feedback_cycles_select_member', array['authenticated'], 'the policy targets authenticated only');
select is((select qual from pg_policies where schemaname = 'public' and tablename = 'feedback_cycles' and policyname = 'feedback_cycles_select_member'), 'private.is_project_member(project_id)', 'the policy uses private.is_project_member(project_id)');
select is((select with_check from pg_policies where schemaname = 'public' and tablename = 'feedback_cycles' and policyname = 'feedback_cycles_select_member'), null, 'the policy has no WITH CHECK');

select is(has_table_privilege('authenticated', 'public.feedback_cycles', 'SELECT'), true, 'authenticated has table-level SELECT');
select is(has_table_privilege('authenticated', 'public.feedback_cycles', 'INSERT'), false, 'authenticated has no INSERT');
select is(has_table_privilege('authenticated', 'public.feedback_cycles', 'UPDATE'), false, 'authenticated has no UPDATE');
select is(has_table_privilege('authenticated', 'public.feedback_cycles', 'DELETE'), false, 'authenticated has no DELETE');
select is(has_table_privilege('authenticated', 'public.feedback_cycles', 'TRUNCATE'), false, 'authenticated has no TRUNCATE');
select is(has_table_privilege('authenticated', 'public.feedback_cycles', 'REFERENCES'), false, 'authenticated has no REFERENCES');
select is(has_table_privilege('authenticated', 'public.feedback_cycles', 'TRIGGER'), false, 'authenticated has no TRIGGER');
select is(has_table_privilege('authenticated', 'public.feedback_cycles', 'MAINTAIN'), false, 'authenticated has no MAINTAIN');
select is(has_any_column_privilege('authenticated', 'public.feedback_cycles', 'INSERT'), false, 'authenticated has no column INSERT');
select is(has_any_column_privilege('authenticated', 'public.feedback_cycles', 'UPDATE'), false, 'authenticated has no column UPDATE');
select is(has_any_column_privilege('anon', 'public.feedback_cycles', 'SELECT'), false, 'anon has no SELECT');
select is(has_any_column_privilege('anon', 'public.feedback_cycles', 'INSERT'), false, 'anon has no INSERT');
select is(has_any_column_privilege('anon', 'public.feedback_cycles', 'UPDATE'), false, 'anon has no UPDATE');
select is(has_any_column_privilege('anon', 'public.feedback_cycles', 'REFERENCES'), false, 'anon has no REFERENCES');
select is(has_table_privilege('anon', 'public.feedback_cycles', 'DELETE'), false, 'anon has no DELETE');
select is(has_table_privilege('anon', 'public.feedback_cycles', 'TRUNCATE'), false, 'anon has no TRUNCATE');
select is(has_table_privilege('anon', 'public.feedback_cycles', 'TRIGGER'), false, 'anon has no TRIGGER');
select is(has_table_privilege('anon', 'public.feedback_cycles', 'MAINTAIN'), false, 'anon has no MAINTAIN');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_class c left join lateral aclexplode(c.relacl) a on true where c.oid = 'public.feedback_cycles'::regclass), 0, 'PUBLIC has no table privilege on feedback_cycles');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_attribute att left join lateral aclexplode(att.attacl) a on true where att.attrelid = 'public.feedback_cycles'::regclass and att.attnum > 0 and not att.attisdropped), 0, 'PUBLIC has no column privilege on feedback_cycles');
select is((select count(*)::int from pg_attribute att cross join lateral aclexplode(att.attacl) a where att.attrelid = 'public.feedback_cycles'::regclass and att.attnum > 0 and not att.attisdropped), 0, 'no role holds a column-level privilege on feedback_cycles');
select is(has_table_privilege('service_role', 'public.feedback_cycles', 'SELECT'), true, 'service_role has SELECT');
select is(has_table_privilege('service_role', 'public.feedback_cycles', 'INSERT'), true, 'service_role has INSERT');
select is(has_table_privilege('service_role', 'public.feedback_cycles', 'UPDATE'), true, 'service_role has UPDATE');
select is(has_table_privilege('service_role', 'public.feedback_cycles', 'DELETE'), true, 'service_role has DELETE');

-- ---------------------------------------------------------------------------
-- create_cycle: the checks run in order and raise stable codes.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', 'Week', date_trunc('week', current_date)::date) $$, '42501'::char(5), 'not_project_member', 'create_cycle with a null auth.uid() raises not_project_member');
select throws_ok($$ select * from public.close_cycle('31000000-0000-4000-8000-000000000001') $$, '42501'::char(5), 'not_project_member', 'close_cycle with a null auth.uid() raises not_project_member');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', 'Week', date_trunc('week', current_date)::date) $$, '42501'::char(5), 'not_project_member', 'a non-member gets not_project_member');
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', '', null) $$, '42501'::char(5), 'not_project_member', 'a non-member with invalid input still gets not_project_member');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000099', 'Week', date_trunc('week', current_date)::date) $$, '42501'::char(5), 'not_project_member', 'an unknown project id gets not_project_member');
select throws_ok($$ select * from public.create_cycle(null, 'Week', date_trunc('week', current_date)::date) $$, '42501'::char(5), 'not_project_member', 'a null project id gets not_project_member');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', 'Week', date_trunc('week', current_date)::date) $$, '42501'::char(5), 'not_project_facilitator', 'a member who is not the facilitator gets not_project_facilitator');
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', '', null) $$, '42501'::char(5), 'not_project_facilitator', 'a member with invalid input still gets not_project_facilitator');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', null, date_trunc('week', current_date)::date) $$, 'P0001'::char(5), 'invalid_cycle_title', 'a null title is rejected');
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', '', date_trunc('week', current_date)::date) $$, 'P0001'::char(5), 'invalid_cycle_title', 'an empty title is rejected');
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', E' \t\n\r ', date_trunc('week', current_date)::date) $$, 'P0001'::char(5), 'invalid_cycle_title', 'a whitespace-only title is rejected');
select throws_ok(format('select * from public.create_cycle(%L, %L, date_trunc(''week'', current_date)::date)', '21000000-0000-4000-8000-000000000001', repeat('x', 101)), 'P0001'::char(5), 'invalid_cycle_title', 'a 101-character title is rejected');
select throws_ok(format('select * from public.create_cycle(%L, %L, date_trunc(''week'', current_date)::date)', '21000000-0000-4000-8000-000000000001', '  ' || repeat('x', 101) || '  '), 'P0001'::char(5), 'invalid_cycle_title', 'a title over 100 characters after trimming is rejected');
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', '', null) $$, 'P0001'::char(5), 'invalid_cycle_title', 'the title is checked before the week');
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', 'Week', null) $$, 'P0001'::char(5), 'invalid_week_start', 'a null week_start is rejected');
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', 'Week', date_trunc('week', current_date)::date - 1) $$, 'P0001'::char(5), 'invalid_week_start', 'a Sunday week_start is rejected');
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', 'Week', date_trunc('week', current_date)::date + 1) $$, 'P0001'::char(5), 'invalid_week_start', 'a Tuesday week_start is rejected');
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', 'Week', date_trunc('week', current_date)::date + 35) $$, 'P0001'::char(5), 'invalid_week_start', 'a Monday more than 28 days ahead is rejected');
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', 'Week', date_trunc('week', current_date)::date - 35) $$, 'P0001'::char(5), 'invalid_week_start', 'a Monday more than 28 days back is rejected');
select is((select count(*)::int from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000001'), 0, 'no rejected call created a cycle');

select results_eq(
  $$ select title, week_start, status, project_id from public.create_cycle('21000000-0000-4000-8000-000000000001', E'  Week one\t\n', date_trunc('week', current_date)::date - 7) $$,
  $$ values ('Week one'::text, date_trunc('week', current_date)::date - 7, 'collecting'::text, '21000000-0000-4000-8000-000000000001'::uuid) $$,
  'the facilitator creates a collecting cycle for last week with the title trimmed'
);
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', 'Week two', date_trunc('week', current_date)::date) $$, 'P0001'::char(5), 'cycle_already_open', 'a second create_cycle while one is open raises cycle_already_open');
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', 'Week two', date_trunc('week', current_date)::date + 1) $$, 'P0001'::char(5), 'invalid_week_start', 'the week is checked before the open cycle');
reset role;
select is((select count(*)::int from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000001' and status <> 'closed'), 1, 'project P has exactly one open cycle');
select is((select created_by from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000001'), '11000000-0000-4000-8000-000000000001'::uuid, 'created_by is the caller');
select is((select created_at from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000001'), now(), 'created_at is set by the database');
select is((select revealed_at from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000001'), null, 'revealed_at starts null');
select is(pg_get_function_result('public.create_cycle(uuid, text, date)'::regprocedure), 'TABLE(id uuid, project_id uuid, title text, week_start date, status text, created_at timestamp with time zone)', 'create_cycle returns id, project_id, title, week_start, status, and created_at');
select is(pg_get_function_identity_arguments('public.create_cycle(uuid, text, date)'::regprocedure), 'p_project_id uuid, p_title text, p_week_start date', 'create_cycle takes only the project, title, and week');
select matches((select prosrc from pg_proc where oid = 'public.create_cycle(uuid, text, date)'::regprocedure), 'from public\.projects p where p\.id = p_project_id for update', 'create_cycle locks the project row');
select matches((select prosrc from pg_proc where oid = 'public.create_cycle(uuid, text, date)'::regprocedure), 'when unique_violation then\s+raise exception using errcode = ''P0001'', message = ''cycle_already_open''', 'create_cycle re-raises a unique violation as cycle_already_open');
select ok((select strpos(prosrc, 'for update') < strpos(prosrc, 'cycle_already_open') from pg_proc where oid = 'public.create_cycle(uuid, text, date)'::regprocedure), 'the project lock comes before the open-cycle check');

do $$ begin perform set_config('test.cycle_p1', (select id::text from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000001'), true); end $$;

-- ---------------------------------------------------------------------------
-- Member reads and direct writes through RLS.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000003","role":"authenticated"}';
select lives_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000002', 'Q week', date_trunc('week', current_date)::date) $$, 'C, the facilitator of Q, creates a cycle in Q');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*)::int from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000001'), 1, 'member B reads every cycle of P');
select is((select count(*)::int from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000002'), 0, 'member B reads no cycle of Q');
select is((select count(*)::int from public.feedback_cycles), 1, 'member B reads only the cycles of their projects');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is_empty($$ select * from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000001' $$, 'non-member C reads no cycle of P by project_id');
select is_empty(format('select * from public.feedback_cycles where id = %L', current_setting('test.cycle_p1')), 'non-member C reads no cycle of P by id');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start) values ('21000000-0000-4000-8000-000000000005', 'Direct', '2026-10-26') $$, '42501'::char(5), NULL, 'the facilitator cannot insert a cycle directly');
select throws_ok(format('update public.feedback_cycles set status = %L, closed_at = now() where id = %L', 'closed', current_setting('test.cycle_p1')), '42501'::char(5), NULL, 'the facilitator cannot update status directly');
select throws_ok(format('delete from public.feedback_cycles where id = %L', current_setting('test.cycle_p1')), '42501'::char(5), NULL, 'the facilitator cannot delete a cycle directly');
reset role;
select is((select status from public.feedback_cycles where id = current_setting('test.cycle_p1')::uuid), 'collecting', 'the P cycle is unchanged after the rejected direct writes');

-- ---------------------------------------------------------------------------
-- close_cycle.
-- ---------------------------------------------------------------------------
do $$ begin perform set_config('test.cycle_p1_updated', (select updated_at::text from public.feedback_cycles where id = current_setting('test.cycle_p1')::uuid), true); end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(format('select * from public.close_cycle(%L)', current_setting('test.cycle_p1')), '42501'::char(5), 'not_project_member', 'a non-member gets not_project_member on close_cycle');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ select * from public.close_cycle('31000000-0000-4000-8000-000000000099') $$, '42501'::char(5), 'not_project_member', 'an unknown cycle id gets not_project_member');
select throws_ok($$ select * from public.close_cycle(null) $$, '42501'::char(5), 'not_project_member', 'a null cycle id gets not_project_member');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(format('select * from public.close_cycle(%L)', current_setting('test.cycle_p1')), '42501'::char(5), 'not_project_facilitator', 'a member gets not_project_facilitator on close_cycle');
reset role;
select results_eq(
  format('select status, closed_at, updated_at from public.feedback_cycles where id = %L', current_setting('test.cycle_p1')),
  format('values (%L::text, null::timestamptz, %L::timestamptz)', 'collecting', current_setting('test.cycle_p1_updated')),
  'the cycle is unchanged after every rejected close'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated"}';
select results_eq(
  format('select id, status, closed_at from public.close_cycle(%L)', current_setting('test.cycle_p1')),
  format('values (%L::uuid, ''closed''::text, now())', current_setting('test.cycle_p1')),
  'the facilitator closes the cycle and gets id, status, and closed_at'
);
reset role;
select is((select closed_at from public.feedback_cycles where id = current_setting('test.cycle_p1')::uuid), now(), 'close_cycle stores closed_at = now()');
select is(pg_get_function_result('public.close_cycle(uuid)'::regprocedure), 'TABLE(id uuid, status text, closed_at timestamp with time zone)', 'close_cycle returns id, status, and closed_at');

-- An already closed cycle is a no-op that returns its existing closed_at.
-- The fixture has past timestamps so any write would be visible.
insert into public.feedback_cycles (id, project_id, title, week_start, status, created_at, updated_at, closed_at)
values ('31000000-0000-4000-8000-000000000006', '21000000-0000-4000-8000-000000000005', 'T closed', '2026-01-05', 'closed', '2026-01-05 09:00:00+00', '2026-01-06 09:00:00+00', '2026-01-06 09:00:00+00');
set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated"}';
select results_eq(
  $$ select id, status, closed_at from public.close_cycle('31000000-0000-4000-8000-000000000006') $$,
  $$ values ('31000000-0000-4000-8000-000000000006'::uuid, 'closed'::text, '2026-01-06 09:00:00+00'::timestamptz) $$,
  'closing a closed cycle returns its existing closed_at'
);
reset role;
select results_eq(
  $$ select closed_at, updated_at from public.feedback_cycles where id = '31000000-0000-4000-8000-000000000006' $$,
  $$ values ('2026-01-06 09:00:00+00'::timestamptz, '2026-01-06 09:00:00+00'::timestamptz) $$,
  'closing a closed cycle changes neither closed_at nor updated_at'
);

-- After closing, the facilitator can start the next cycle.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', 'Week two', date_trunc('week', current_date)::date) $$, 'after close_cycle the facilitator creates a new cycle');
do $$ begin perform set_config('test.cycle_p2', (select id::text from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000001' and status <> 'closed'), true); end $$;
reset role;
select is((select count(*)::int from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000001'), 2, 'project P now holds two cycles');

-- ---------------------------------------------------------------------------
-- Control follows the current facilitator role, not ownership or creator.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select public.transfer_facilitator('21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002') $$, 'owner A transfers the facilitator role to B');
select throws_ok(format('select * from public.close_cycle(%L)', current_setting('test.cycle_p2')), '42501'::char(5), 'not_project_facilitator', 'A (still owner) cannot close the cycle A created');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000002","role":"authenticated"}';
select lives_ok(format('select * from public.close_cycle(%L)', current_setting('test.cycle_p2')), 'B, the new facilitator, closes the cycle A created');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', 'Week three', date_trunc('week', current_date)::date) $$, '42501'::char(5), 'not_project_facilitator', 'A (still owner) cannot create a cycle after the transfer');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000002","role":"authenticated"}';
select lives_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', 'Week three', date_trunc('week', current_date)::date + 7) $$, 'B creates the next cycle for next week');
reset role;
select is((select created_by from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000001' and status <> 'closed'), '11000000-0000-4000-8000-000000000002'::uuid, 'the new cycle records B as its creator');
select is((select created_by from public.feedback_cycles where id = current_setting('test.cycle_p2')::uuid), '11000000-0000-4000-8000-000000000001'::uuid, 'the cycle B closed still records A as its creator');

-- ---------------------------------------------------------------------------
-- RPC hardening.
-- ---------------------------------------------------------------------------
select is((select prosecdef from pg_proc where oid = 'public.create_cycle(uuid, text, date)'::regprocedure), true, 'create_cycle is security definer');
select is((select proconfig from pg_proc where oid = 'public.create_cycle(uuid, text, date)'::regprocedure), array['search_path=""']::text[], 'create_cycle fixes search_path to empty');
select doesnt_match((select prosrc from pg_proc where oid = 'public.create_cycle(uuid, text, date)'::regprocedure), '\mexecute\M', 'create_cycle uses no dynamic SQL');
select matches((select prosrc from pg_proc where oid = 'public.create_cycle(uuid, text, date)'::regprocedure), '\(select auth\.uid\(\)\) is null', 'create_cycle checks (select auth.uid()) inside the function');
select matches((select prosrc from pg_proc where oid = 'public.create_cycle(uuid, text, date)'::regprocedure), 'private\.is_project_member\(p_project_id\)', 'create_cycle uses private.is_project_member');
select matches((select prosrc from pg_proc where oid = 'public.create_cycle(uuid, text, date)'::regprocedure), 'private\.is_project_facilitator\(p_project_id\)', 'create_cycle uses private.is_project_facilitator');
select doesnt_match((select prosrc from pg_proc where oid = 'public.create_cycle(uuid, text, date)'::regprocedure), 'project_members', 'create_cycle adds no role query of its own');
select is(has_function_privilege('anon', 'public.create_cycle(uuid, text, date)', 'EXECUTE'), false, 'anon cannot execute create_cycle');
select is(has_function_privilege('authenticated', 'public.create_cycle(uuid, text, date)', 'EXECUTE'), true, 'authenticated can execute create_cycle');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.create_cycle(uuid, text, date)'::regprocedure), 0, 'PUBLIC cannot execute create_cycle');

select is((select prosecdef from pg_proc where oid = 'public.close_cycle(uuid)'::regprocedure), true, 'close_cycle is security definer');
select is((select proconfig from pg_proc where oid = 'public.close_cycle(uuid)'::regprocedure), array['search_path=""']::text[], 'close_cycle fixes search_path to empty');
select doesnt_match((select prosrc from pg_proc where oid = 'public.close_cycle(uuid)'::regprocedure), '\mexecute\M', 'close_cycle uses no dynamic SQL');
select matches((select prosrc from pg_proc where oid = 'public.close_cycle(uuid)'::regprocedure), '\(select auth\.uid\(\)\) is null', 'close_cycle checks (select auth.uid()) inside the function');
select matches((select prosrc from pg_proc where oid = 'public.close_cycle(uuid)'::regprocedure), 'private\.is_project_member\(cycle_project\)', 'close_cycle uses private.is_project_member');
select matches((select prosrc from pg_proc where oid = 'public.close_cycle(uuid)'::regprocedure), 'private\.is_project_facilitator\(cycle_project\)', 'close_cycle uses private.is_project_facilitator');
select matches((select prosrc from pg_proc where oid = 'public.close_cycle(uuid)'::regprocedure), 'where fc\.id = p_cycle_id\s+for update', 'close_cycle locks the cycle row');
select doesnt_match((select prosrc from pg_proc where oid = 'public.close_cycle(uuid)'::regprocedure), 'project_members', 'close_cycle adds no role query of its own');
select is(has_function_privilege('anon', 'public.close_cycle(uuid)', 'EXECUTE'), false, 'anon cannot execute close_cycle');
select is(has_function_privilege('authenticated', 'public.close_cycle(uuid)', 'EXECUTE'), true, 'authenticated can execute close_cycle');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.close_cycle(uuid)'::regprocedure), 0, 'PUBLIC cannot execute close_cycle');

set local role anon;
select throws_ok($$ select * from public.create_cycle('21000000-0000-4000-8000-000000000001', 'Week', date_trunc('week', current_date)::date) $$, '42501'::char(5), NULL, 'anon cannot call create_cycle');
select throws_ok($$ select * from public.feedback_cycles $$, '42501'::char(5), NULL, 'anon cannot select feedback_cycles');
reset role;

-- Every message raised by the RPCs and the guard is one of the seven stable
-- codes, and every raise sets an explicit message (no ids or titles).
select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral regexp_matches(p.prosrc, 'message\s*=\s*''([^'']*)''', 'g') as m(msg)
    where (n.nspname, p.proname) in (('public', 'create_cycle'), ('public', 'close_cycle'), ('private', 'guard_feedback_cycle_update'))
      and m.msg[1] not in ('not_project_member', 'not_project_facilitator', 'invalid_cycle_title', 'invalid_week_start', 'cycle_already_open', 'invalid_status_transition', 'cycle_immutable_column')),
  0,
  'no RPC or guard raises a message outside the seven stable codes'
);
select is(
  (select sum((select count(*) from regexp_matches(p.prosrc, '\mraise\M', 'gi')))::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname, p.proname) in (('public', 'create_cycle'), ('public', 'close_cycle'), ('private', 'guard_feedback_cycle_update'))),
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''[0-9A-Z]{5}'', message = ''[a-z_]+''', 'g') as m
    where (n.nspname, p.proname) in (('public', 'create_cycle'), ('public', 'close_cycle'), ('private', 'guard_feedback_cycle_update'))),
  'every raise uses a fixed errcode and a coded message with no format arguments'
);

-- Deleting a project removes its cycles; deleting a creator keeps the cycle.
select lives_ok($$ delete from public.projects where id = '21000000-0000-4000-8000-000000000003' $$, 'a project with cycles can be deleted');
select is((select count(*)::int from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000003'), 0, 'deleting the project removes its cycles');
-- created_by may become null only through the ON DELETE SET NULL action,
-- that is once its auth user is gone.
set local role service_role;
select throws_ok(format('update public.feedback_cycles set created_by = null where id = %L', current_setting('test.cycle_p2')), 'P0001'::char(5), 'cycle_immutable_column', 'created_by cannot be cleared while its user exists');
reset role;
select lives_ok($$ delete from auth.users where id = '11000000-0000-4000-8000-000000000002' $$, 'an auth user who created a cycle can be deleted');
select is((select count(*)::int from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000001'), 3, 'deleting the creator keeps every cycle');
select is((select count(*)::int from public.feedback_cycles where project_id = '21000000-0000-4000-8000-000000000001' and created_by is null), 1, 'the deleted creator is forgotten (created_by set null)');

select * from finish();
rollback;
