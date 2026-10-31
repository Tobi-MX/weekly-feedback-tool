-- pgTAP tests for the projects table, ownership rules, RLS, grants, triggers,
-- and direct PostgREST-style access.
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension itself. The seed user is never used as a fixture.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(135);

-- ---------------------------------------------------------------------------
-- Fixtures: inserting auth.users rows fires private.handle_new_user().
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'fixture-a@example.com', '{"display_name":"Alice"}'),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'fixture-b@example.com', '{"display_name":"Bob"}');

insert into public.projects (id, name, owner_id, created_at, updated_at)
values
  ('20000000-0000-4000-8000-000000000001', 'Alpha', '10000000-0000-4000-8000-000000000001', '2026-10-01 10:00:00+00', '2026-10-01 10:00:00+00'),
  ('20000000-0000-4000-8000-000000000002', 'Past', '10000000-0000-4000-8000-000000000001', '2000-01-02 00:00:00+00', '2000-01-01 00:00:00+00'),
  ('30000000-0000-4000-8000-000000000001', 'Beta', '10000000-0000-4000-8000-000000000002', '2026-10-02 10:00:00+00', '2026-10-02 10:00:00+00');

-- ---------------------------------------------------------------------------
-- Table shape, primary key, foreign key, nullability, and defaults.
-- ---------------------------------------------------------------------------
select has_table('public', 'projects', 'projects table exists');
select columns_are('public', 'projects', array['id', 'name', 'owner_id', 'created_at', 'updated_at'], 'projects has exactly the five expected columns');
select col_type_is('public', 'projects', 'id', 'uuid', 'id is uuid');
select col_type_is('public', 'projects', 'name', 'text', 'name is text');
select col_type_is('public', 'projects', 'owner_id', 'uuid', 'owner_id is uuid');
select col_type_is('public', 'projects', 'created_at', 'timestamp with time zone', 'created_at is timestamptz');
select col_type_is('public', 'projects', 'updated_at', 'timestamp with time zone', 'updated_at is timestamptz');
select col_is_pk('public', 'projects', 'id', 'id is the primary key');
select col_not_null('public', 'projects', 'id', 'id is not null');
select col_has_default('public', 'projects', 'id', 'id has a default');
select matches((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.projects'::regclass and a.attname = 'id'), 'gen_random_uuid\(\)', 'id defaults to gen_random_uuid()');
select col_not_null('public', 'projects', 'name', 'name is not null');
select col_hasnt_default('public', 'projects', 'name', 'name has no default');
select col_not_null('public', 'projects', 'owner_id', 'owner_id is not null');
select col_hasnt_default('public', 'projects', 'owner_id', 'owner_id has no default');
select col_not_null('public', 'projects', 'created_at', 'created_at is not null');
select col_has_default('public', 'projects', 'created_at', 'created_at has a default');
select matches((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.projects'::regclass and a.attname = 'created_at'), 'now\(\)', 'created_at defaults to now()');
select col_not_null('public', 'projects', 'updated_at', 'updated_at is not null');
select col_has_default('public', 'projects', 'updated_at', 'updated_at has a default');
select matches((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.projects'::regclass and a.attname = 'updated_at'), 'now\(\)', 'updated_at defaults to now()');
select is((select confrelid::regclass::text from pg_constraint where conrelid = 'public.projects'::regclass and contype = 'f'), 'auth.users', 'owner_id references auth.users');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.projects'::regclass and contype = 'f'), 'r', 'the owner_id foreign key is ON DELETE RESTRICT');
select is((select a.attname from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1] where c.conrelid = 'public.projects'::regclass and c.contype = 'f'), 'owner_id', 'the foreign key is on owner_id');

-- ---------------------------------------------------------------------------
-- The list index exists with the expected name and column order.
-- ---------------------------------------------------------------------------
select is(to_regclass('public.projects_owner_created_idx')::text, 'projects_owner_created_idx', 'projects_owner_created_idx exists');
select is((select indrelid::regclass::text from pg_index where indexrelid = 'public.projects_owner_created_idx'::regclass), 'projects', 'the index is on projects');
select matches(pg_get_indexdef('public.projects_owner_created_idx'::regclass), '\(owner_id, created_at DESC\)', 'the index columns are (owner_id, created_at DESC) in order');

-- ---------------------------------------------------------------------------
-- Exactly one updated_at trigger, calling the shared helper from #4.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_trigger where tgrelid = 'public.projects'::regclass and not tgisinternal), 1, 'projects has exactly one trigger');
select trigger_is('public', 'projects', 'projects_set_updated_at', 'private', 'set_updated_at', 'the projects trigger calls private.set_updated_at');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.projects'::regclass and tgname = 'projects_set_updated_at'), 19, 'the projects trigger is BEFORE UPDATE FOR EACH ROW');
select is((select count(*)::int from pg_proc where proname = 'set_updated_at'), 1, 'the migration does not create a second updated-at helper');

-- ---------------------------------------------------------------------------
-- Updating a project advances updated_at but never changes created_at.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ update public.projects set name = 'Past Updated' where id = '20000000-0000-4000-8000-000000000002' $$, 'an owner can update the project name');
reset role;
select is((select created_at from public.projects where id = '20000000-0000-4000-8000-000000000002'), '2000-01-02 00:00:00+00'::timestamptz, 'created_at never changes on update');
select ok((select updated_at > '2000-01-01 00:00:00+00'::timestamptz from public.projects where id = '20000000-0000-4000-8000-000000000002'), 'updated_at advances past a known past value without the client sending it');
select ok((select updated_at > created_at from public.projects where id = '20000000-0000-4000-8000-000000000002'), 'updated_at is later than created_at after the update');

-- ---------------------------------------------------------------------------
-- name CHECK: ASCII-whitespace trimming, character length, no uniqueness.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ update public.projects set name = '' where id = '20000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'empty name is rejected');
select throws_ok($$ update public.projects set name = '   ' where id = '20000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'whitespace-only name is rejected');
select throws_ok($$ update public.projects set name = E'\t' where id = '20000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'tab-only name is rejected');
select throws_ok($$ update public.projects set name = E'\n' where id = '20000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'newline-only name is rejected');
select throws_ok($$ update public.projects set name = E'\r' where id = '20000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'carriage-return-only name is rejected');
select throws_ok($$ update public.projects set name = ' Team' where id = '20000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'leading space is rejected');
select throws_ok($$ update public.projects set name = 'Team ' where id = '20000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'trailing space is rejected');
select throws_ok($$ update public.projects set name = E'\tTeam' where id = '20000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'leading tab is rejected');
select throws_ok($$ update public.projects set name = E'Team\n' where id = '20000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'trailing newline is rejected');
select lives_ok($$ update public.projects set name = 'A' where id = '20000000-0000-4000-8000-000000000001' $$, 'one character is accepted');
reset role;
select is((select name from public.projects where id = '20000000-0000-4000-8000-000000000001'), 'A', 'the one-character name is stored unchanged');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok('update public.projects set name = ' || quote_literal(repeat('b', 100)) || ' where id = ''20000000-0000-4000-8000-000000000001''', 'exactly 100 ASCII characters are accepted');
reset role;
select is((select name from public.projects where id = '20000000-0000-4000-8000-000000000001'), repeat('b', 100), 'the 100-ASCII-character name is stored unchanged');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok('update public.projects set name = ' || quote_literal(repeat('é', 100)) || ' where id = ''20000000-0000-4000-8000-000000000001''', 'exactly 100 multibyte characters are accepted');
reset role;
select is((select name from public.projects where id = '20000000-0000-4000-8000-000000000001'), repeat('é', 100), 'the 100-multibyte-character name is stored unchanged');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ update public.projects set name = 'Internal  spaces' where id = '20000000-0000-4000-8000-000000000001' $$, 'internal spaces are accepted');
reset role;
select is((select name from public.projects where id = '20000000-0000-4000-8000-000000000001'), 'Internal  spaces', 'internal spaces are stored unchanged');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ update public.projects set name = E'Tab\tinside' where id = '20000000-0000-4000-8000-000000000001' $$, 'an internal tab is accepted');
reset role;
select is((select name from public.projects where id = '20000000-0000-4000-8000-000000000001'), E'Tab\tinside', 'an internal tab is stored unchanged');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ update public.projects set name = E'Line\nBreak' where id = '20000000-0000-4000-8000-000000000001' $$, 'an internal newline is accepted');
reset role;
select is((select name from public.projects where id = '20000000-0000-4000-8000-000000000001'), E'Line\nBreak', 'an internal newline is stored unchanged');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok('update public.projects set name = ' || quote_literal(repeat('c', 101)) || ' where id = ''20000000-0000-4000-8000-000000000001''', '23514'::char(5), NULL, '101 ASCII characters are rejected');
select throws_ok('update public.projects set name = ' || quote_literal(repeat('é', 101)) || ' where id = ''20000000-0000-4000-8000-000000000001''', '23514'::char(5), NULL, '101 multibyte characters are rejected');
reset role;

select is((select count(*)::int from pg_constraint where conrelid = 'public.projects'::regclass and contype = 'u'), 0, 'there is no unique constraint on projects');
insert into public.projects (id, name, owner_id)
values
  ('20000000-0000-4000-8000-000000000003', 'Duplicate', '10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000004', 'Duplicate', '10000000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.projects where owner_id = '10000000-0000-4000-8000-000000000001' and name = 'Duplicate'), 2, 'two same-name projects for one owner are stored');
select is((select count(distinct id)::int from public.projects where owner_id = '10000000-0000-4000-8000-000000000001' and name = 'Duplicate'), 2, 'the two same-name projects have different ids');

-- ---------------------------------------------------------------------------
-- RLS is enabled and exactly three policies exist.
-- ---------------------------------------------------------------------------
select is((select relrowsecurity from pg_class where oid = 'public.projects'::regclass), true, 'RLS is enabled on projects');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'projects'), 3, 'exactly three policies exist on projects');
select policies_are('public', 'projects', array['projects_insert_own', 'projects_select_own', 'projects_update_own'], 'the three expected policies exist');
select policy_cmd_is('public', 'projects', 'projects_select_own', 'SELECT', 'the select policy is FOR SELECT');
select policy_roles_are('public', 'projects', 'projects_select_own', array['authenticated'], 'the select policy targets authenticated');
select matches((select qual from pg_policies where schemaname = 'public' and tablename = 'projects' and policyname = 'projects_select_own'), 'owner_id = \( SELECT auth\.uid\(\)', 'the select policy uses owner_id = (select auth.uid())');
select is((select with_check from pg_policies where schemaname = 'public' and tablename = 'projects' and policyname = 'projects_select_own'), null, 'the select policy has no WITH CHECK');
select policy_cmd_is('public', 'projects', 'projects_insert_own', 'INSERT', 'the insert policy is FOR INSERT');
select policy_roles_are('public', 'projects', 'projects_insert_own', array['authenticated'], 'the insert policy targets authenticated');
select matches((select with_check from pg_policies where schemaname = 'public' and tablename = 'projects' and policyname = 'projects_insert_own'), 'owner_id = \( SELECT auth\.uid\(\)', 'the insert policy WITH CHECK uses owner_id = (select auth.uid())');
select is((select qual from pg_policies where schemaname = 'public' and tablename = 'projects' and policyname = 'projects_insert_own'), null, 'the insert policy has no USING');
select policy_cmd_is('public', 'projects', 'projects_update_own', 'UPDATE', 'the update policy is FOR UPDATE');
select policy_roles_are('public', 'projects', 'projects_update_own', array['authenticated'], 'the update policy targets authenticated');
select matches((select qual from pg_policies where schemaname = 'public' and tablename = 'projects' and policyname = 'projects_update_own'), 'owner_id = \( SELECT auth\.uid\(\)', 'the update policy USING uses owner_id = (select auth.uid())');
select matches((select with_check from pg_policies where schemaname = 'public' and tablename = 'projects' and policyname = 'projects_update_own'), 'owner_id = \( SELECT auth\.uid\(\)', 'the update policy WITH CHECK uses owner_id = (select auth.uid())');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'projects' and roles && array['anon', 'public']::name[]), 0, 'no policy targets anon or PUBLIC');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'projects' and cmd in ('DELETE', 'ALL')), 0, 'there is no DELETE policy');

-- ---------------------------------------------------------------------------
-- Grants: authenticated gets SELECT plus narrow column INSERT/UPDATE.
-- ---------------------------------------------------------------------------
select is(has_table_privilege('authenticated', 'public.projects', 'SELECT'), true, 'authenticated has table-level SELECT');
select is(has_table_privilege('authenticated', 'public.projects', 'INSERT'), false, 'authenticated has no table-level INSERT');
select is(has_table_privilege('authenticated', 'public.projects', 'UPDATE'), false, 'authenticated has no table-level UPDATE');
select is(has_table_privilege('authenticated', 'public.projects', 'DELETE'), false, 'authenticated has no DELETE');
select is(has_table_privilege('authenticated', 'public.projects', 'TRUNCATE'), false, 'authenticated has no TRUNCATE');
select is(has_table_privilege('authenticated', 'public.projects', 'REFERENCES'), false, 'authenticated has no REFERENCES');
select is(has_table_privilege('authenticated', 'public.projects', 'TRIGGER'), false, 'authenticated has no TRIGGER');
select is(has_table_privilege('authenticated', 'public.projects', 'MAINTAIN'), false, 'authenticated has no MAINTAIN');
select is(has_column_privilege('authenticated', 'public.projects', 'name', 'INSERT'), true, 'authenticated can insert name');
select is(has_column_privilege('authenticated', 'public.projects', 'owner_id', 'INSERT'), true, 'authenticated can insert owner_id');
select is(has_column_privilege('authenticated', 'public.projects', 'id', 'INSERT'), false, 'authenticated cannot insert id');
select is(has_column_privilege('authenticated', 'public.projects', 'created_at', 'INSERT'), false, 'authenticated cannot insert created_at');
select is(has_column_privilege('authenticated', 'public.projects', 'updated_at', 'INSERT'), false, 'authenticated cannot insert updated_at');
select is(has_column_privilege('authenticated', 'public.projects', 'name', 'UPDATE'), true, 'authenticated can update name');
select is(has_column_privilege('authenticated', 'public.projects', 'id', 'UPDATE'), false, 'authenticated cannot update id');
select is(has_column_privilege('authenticated', 'public.projects', 'owner_id', 'UPDATE'), false, 'authenticated cannot update owner_id');
select is(has_column_privilege('authenticated', 'public.projects', 'created_at', 'UPDATE'), false, 'authenticated cannot update created_at');
select is(has_column_privilege('authenticated', 'public.projects', 'updated_at', 'UPDATE'), false, 'authenticated cannot update updated_at');
select is(has_table_privilege('service_role', 'public.projects', 'SELECT'), true, 'service_role has SELECT');
select is(has_table_privilege('service_role', 'public.projects', 'INSERT'), true, 'service_role has INSERT');
select is(has_table_privilege('service_role', 'public.projects', 'UPDATE'), true, 'service_role has UPDATE');
select is(has_table_privilege('service_role', 'public.projects', 'DELETE'), true, 'service_role has DELETE');
select is(has_table_privilege('anon', 'public.projects', 'SELECT'), false, 'anon has no SELECT');
select is(has_table_privilege('anon', 'public.projects', 'INSERT'), false, 'anon has no INSERT');
select is(has_table_privilege('anon', 'public.projects', 'UPDATE'), false, 'anon has no UPDATE');
select is(has_table_privilege('anon', 'public.projects', 'DELETE'), false, 'anon has no DELETE');
select is(has_column_privilege('anon', 'public.projects', 'name', 'SELECT'), false, 'anon has no column SELECT');
select is(has_column_privilege('anon', 'public.projects', 'name', 'INSERT'), false, 'anon has no column INSERT');
select is(has_column_privilege('anon', 'public.projects', 'name', 'UPDATE'), false, 'anon has no column UPDATE');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_class c left join lateral aclexplode(c.relacl) a on true where c.oid = 'public.projects'::regclass), 0, 'PUBLIC has no table privilege on projects');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_attribute att left join lateral aclexplode(att.attacl) a on true where att.attrelid = 'public.projects'::regclass and att.attnum > 0 and not att.attisdropped), 0, 'PUBLIC has no column privilege on projects');

-- ---------------------------------------------------------------------------
-- Direct access as user B: A's rows are invisible and untouchable.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*)::int from public.projects where owner_id = '10000000-0000-4000-8000-000000000001'), 0, 'user B sees zero rows belonging to user A');
select lives_ok($$ select * from public.projects where id = '20000000-0000-4000-8000-000000000001' $$, 'selecting user A project as B does not raise');
select is_empty($$ update public.projects set name = 'Hacked' where id = '20000000-0000-4000-8000-000000000001' returning id $$, 'updating user A project as B affects zero rows');
select throws_ok($$ insert into public.projects (name, owner_id) values ('Intruder', '10000000-0000-4000-8000-000000000001') $$, '42501'::char(5), NULL, 'inserting with user A owner_id as B is denied by the policy');
select throws_ok($$ delete from public.projects where id = '20000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'deleting user A project as B is permission denied');
reset role;
select is((select name from public.projects where id = '20000000-0000-4000-8000-000000000001'), E'Line\nBreak', 'user A row is unchanged after the zero-row update');

-- ---------------------------------------------------------------------------
-- Direct access as user A: own insert, select, and update succeed.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ insert into public.projects (name, owner_id) values ('Owned', '10000000-0000-4000-8000-000000000001') returning id $$, 'user A can insert a project as themselves');
select is((select count(*)::int from public.projects where owner_id = '10000000-0000-4000-8000-000000000001' and name = 'Owned'), 1, 'user A can select the inserted project');
select lives_ok($$ update public.projects set name = 'Owned Updated' where owner_id = '10000000-0000-4000-8000-000000000001' and name = 'Owned' $$, 'user A can update their own project name');
reset role;
select is((select count(*)::int from public.projects where owner_id = '10000000-0000-4000-8000-000000000001' and name = 'Owned Updated'), 1, 'the owner update persisted');

-- ---------------------------------------------------------------------------
-- Database-owned columns are not writable by authenticated.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ insert into public.projects (id, name, owner_id) values ('40000000-0000-4000-8000-000000000001', 'Client Id', '10000000-0000-4000-8000-000000000001') $$, '42501'::char(5), NULL, 'inserting an explicit id is permission denied');
select throws_ok($$ insert into public.projects (name, owner_id, created_at) values ('Client Created', '10000000-0000-4000-8000-000000000001', now()) $$, '42501'::char(5), NULL, 'inserting created_at is permission denied');
select throws_ok($$ insert into public.projects (name, owner_id, updated_at) values ('Client Updated', '10000000-0000-4000-8000-000000000001', now()) $$, '42501'::char(5), NULL, 'inserting updated_at is permission denied');
select throws_ok($$ update public.projects set id = '40000000-0000-4000-8000-000000000002' where id = '20000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'updating id is permission denied');
select throws_ok($$ update public.projects set owner_id = '10000000-0000-4000-8000-000000000002' where id = '20000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'updating owner_id is permission denied');
select throws_ok($$ update public.projects set created_at = now() where id = '20000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'updating created_at is permission denied');
select throws_ok($$ update public.projects set updated_at = now() where id = '20000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'updating updated_at is permission denied');
reset role;

-- ---------------------------------------------------------------------------
-- anon has no access at all.
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok($$ select * from public.projects $$, '42501'::char(5), NULL, 'anon SELECT fails with permission denied, not an empty result');
select throws_ok($$ insert into public.projects (name, owner_id) values ('Anon', '10000000-0000-4000-8000-000000000001') $$, '42501'::char(5), NULL, 'anon INSERT is permission denied');
select throws_ok($$ update public.projects set name = 'Anon' where id = '20000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'anon UPDATE is permission denied');
select throws_ok($$ delete from public.projects where id = '20000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'anon DELETE is permission denied');
reset role;

-- ---------------------------------------------------------------------------
-- Deleting an auth user who owns a project is restricted.
-- ---------------------------------------------------------------------------
select throws_ok($$ delete from auth.users where id = '10000000-0000-4000-8000-000000000001' $$, '23503'::char(5), NULL, 'deleting an auth user who owns a project fails with a foreign-key violation');
select is((select count(*)::int from auth.users where id = '10000000-0000-4000-8000-000000000001'), 1, 'the auth user still exists after the restricted delete');
select is((select count(*)::int from public.projects where id = '20000000-0000-4000-8000-000000000001'), 1, 'the project still exists after the restricted delete');

-- ---------------------------------------------------------------------------
-- No RPC or view was added for projects.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_project', 'list_projects', 'get_project')), 0, 'no public project RPC exists');
select is((select count(*)::int from pg_views where schemaname = 'public' and definition ilike '%projects%'), 0, 'no public view references projects');

select * from finish();
rollback;
