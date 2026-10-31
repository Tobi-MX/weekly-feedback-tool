-- pgTAP tests for the profiles table, RLS, grants, triggers, and access rules.
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension itself. The seed user is never used as a fixture.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(141);

-- ---------------------------------------------------------------------------
-- Fixtures: inserting auth.users rows fires private.handle_new_user().
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'fixture-a@example.com', '{"display_name":"Alice"}'),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'fixture-b@example.com', '{"display_name":"Bob"}'),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'fixture-c@example.com', '{"display_name":"Cara"}'),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'fixture-d@example.com', '{"display_name":"Dana"}');

-- ---------------------------------------------------------------------------
-- Private schema and helper functions.
-- ---------------------------------------------------------------------------
select has_schema('private', 'private schema exists');
select is(has_schema_privilege('anon', 'private', 'USAGE'), false, 'anon has no USAGE on the private schema');
-- #8 grants authenticated USAGE on private so RLS policies can call the two
-- membership helpers; every other private function stays non-executable.
select is(has_schema_privilege('authenticated', 'private', 'USAGE'), true, 'authenticated has USAGE on the private schema (granted by #8 for the membership helpers)');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_namespace n left join lateral aclexplode(n.nspacl) a on true where n.nspname = 'private'), 0, 'PUBLIC has no privilege on the private schema');

select has_function('private', 'set_updated_at', 'private.set_updated_at() exists');
select is((select prorettype = 'trigger'::regtype from pg_proc where oid = 'private.set_updated_at()'::regprocedure), true, 'set_updated_at returns trigger');
select is((select proconfig from pg_proc where oid = 'private.set_updated_at()'::regprocedure), array['search_path=""']::text[], 'set_updated_at fixes search_path');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'private.set_updated_at()'::regprocedure), 'postgres', 'set_updated_at is owned by postgres');
select doesnt_match((select prosrc from pg_proc where oid = 'private.set_updated_at()'::regprocedure), 'public\.profiles', 'set_updated_at is generic and does not reference profiles');
select is(has_function_privilege('anon', 'private.set_updated_at()', 'EXECUTE'), false, 'anon cannot execute set_updated_at');
select is(has_function_privilege('authenticated', 'private.set_updated_at()', 'EXECUTE'), false, 'authenticated cannot execute set_updated_at');

select has_function('private', 'handle_new_user', 'private.handle_new_user() exists');
select is((select prosecdef from pg_proc where oid = 'private.handle_new_user()'::regprocedure), true, 'handle_new_user is security definer');
select is((select proconfig from pg_proc where oid = 'private.handle_new_user()'::regprocedure), array['search_path=""']::text[], 'handle_new_user fixes search_path');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'private.handle_new_user()'::regprocedure), 'postgres', 'handle_new_user is owned by postgres');
select is((select prorettype = 'trigger'::regtype from pg_proc where oid = 'private.handle_new_user()'::regprocedure), true, 'handle_new_user returns trigger');
select matches((select prosrc from pg_proc where oid = 'private.handle_new_user()'::regprocedure), 'insert into public\.profiles', 'handle_new_user schema-qualifies public.profiles');
select doesnt_match((select prosrc from pg_proc where oid = 'private.handle_new_user()'::regprocedure), '\mexecute\M', 'handle_new_user contains no dynamic SQL');
select is(has_function_privilege('anon', 'private.handle_new_user()', 'EXECUTE'), false, 'anon cannot execute handle_new_user');
select is(has_function_privilege('authenticated', 'private.handle_new_user()', 'EXECUTE'), false, 'authenticated cannot execute handle_new_user');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'private.handle_new_user()'::regprocedure), 0, 'PUBLIC has no EXECUTE on handle_new_user');

-- ---------------------------------------------------------------------------
-- Table shape, primary key, foreign key, nullability, and defaults.
-- ---------------------------------------------------------------------------
select has_table('public', 'profiles', 'profiles table exists');
select columns_are('public', 'profiles', array['id', 'display_name', 'avatar_url', 'created_at', 'updated_at'], 'profiles has exactly the five expected columns');
select col_type_is('public', 'profiles', 'id', 'uuid', 'id is uuid');
select col_type_is('public', 'profiles', 'display_name', 'text', 'display_name is text');
select col_type_is('public', 'profiles', 'avatar_url', 'text', 'avatar_url is text');
select col_type_is('public', 'profiles', 'created_at', 'timestamp with time zone', 'created_at is timestamptz');
select col_type_is('public', 'profiles', 'updated_at', 'timestamp with time zone', 'updated_at is timestamptz');
select col_is_pk('public', 'profiles', 'id', 'id is the primary key');
select col_not_null('public', 'profiles', 'id', 'id is not null');
select col_hasnt_default('public', 'profiles', 'id', 'id has no default');
select col_not_null('public', 'profiles', 'display_name', 'display_name is not null');
select col_hasnt_default('public', 'profiles', 'display_name', 'display_name has no default');
select col_is_null('public', 'profiles', 'avatar_url', 'avatar_url is nullable');
select col_hasnt_default('public', 'profiles', 'avatar_url', 'avatar_url has no default');
select col_not_null('public', 'profiles', 'created_at', 'created_at is not null');
select col_has_default('public', 'profiles', 'created_at', 'created_at has a default');
select col_not_null('public', 'profiles', 'updated_at', 'updated_at is not null');
select col_has_default('public', 'profiles', 'updated_at', 'updated_at has a default');
select matches((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.profiles'::regclass and a.attname = 'created_at'), 'now\(\)', 'created_at defaults to now()');
select matches((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.profiles'::regclass and a.attname = 'updated_at'), 'now\(\)', 'updated_at defaults to now()');
select is((select confrelid::regclass::text from pg_constraint where conrelid = 'public.profiles'::regclass and contype = 'f'), 'auth.users', 'profiles.id references auth.users');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.profiles'::regclass and contype = 'f'), 'c', 'profiles foreign key is ON DELETE CASCADE');

-- ---------------------------------------------------------------------------
-- display_name CHECK: ASCII-whitespace trimming and character length.
-- ---------------------------------------------------------------------------
select throws_ok($$ update public.profiles set display_name = '' where id = '10000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'empty display_name is rejected');
select throws_ok($$ update public.profiles set display_name = '   ' where id = '10000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'whitespace-only display_name is rejected');
select throws_ok($$ update public.profiles set display_name = E'\t' where id = '10000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'tab-only display_name is rejected');
select throws_ok($$ update public.profiles set display_name = E'\n' where id = '10000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'newline-only display_name is rejected');
select throws_ok($$ update public.profiles set display_name = E'\r' where id = '10000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'carriage-return-only display_name is rejected');
select throws_ok($$ update public.profiles set display_name = ' Alice' where id = '10000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'leading space is rejected');
select throws_ok($$ update public.profiles set display_name = 'Alice ' where id = '10000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'trailing space is rejected');
select throws_ok($$ update public.profiles set display_name = E'\tAlice' where id = '10000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'leading tab is rejected');
select throws_ok($$ update public.profiles set display_name = E'Alice\t' where id = '10000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'trailing tab is rejected');
select throws_ok($$ update public.profiles set display_name = E'\nAlice' where id = '10000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'leading newline is rejected');
select throws_ok($$ update public.profiles set display_name = E'Alice\n' where id = '10000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'trailing newline is rejected');
select throws_ok($$ update public.profiles set display_name = E'\rAlice' where id = '10000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'leading carriage return is rejected');
select throws_ok($$ update public.profiles set display_name = E'Alice\r' where id = '10000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'trailing carriage return is rejected');
select throws_ok('update public.profiles set display_name = ' || quote_literal(repeat('a', 101)) || ' where id = ''10000000-0000-4000-8000-000000000001''', '23514'::char(5), NULL, '101 ASCII characters are rejected');
select throws_ok('update public.profiles set display_name = ' || quote_literal(repeat('é', 101)) || ' where id = ''10000000-0000-4000-8000-000000000001''', '23514'::char(5), NULL, '101 multibyte characters are rejected');
select lives_ok($$ update public.profiles set display_name = 'A' where id = '10000000-0000-4000-8000-000000000001' $$, 'one character is accepted');
select lives_ok($$ update public.profiles set display_name = 'Internal  spaces' where id = '10000000-0000-4000-8000-000000000001' $$, 'internal spaces are accepted');
select lives_ok($$ update public.profiles set display_name = E'Tab\tinside' where id = '10000000-0000-4000-8000-000000000001' $$, 'an internal tab is accepted');
select lives_ok($$ update public.profiles set display_name = E'Line\nBreak' where id = '10000000-0000-4000-8000-000000000001' $$, 'an internal newline is accepted');
select lives_ok($$ update public.profiles set display_name = 'Müller 日本' where id = '10000000-0000-4000-8000-000000000001' $$, 'multibyte display names are accepted');
select lives_ok('update public.profiles set display_name = ' || quote_literal(repeat('b', 100)) || ' where id = ''10000000-0000-4000-8000-000000000001''', 'exactly 100 ASCII characters are accepted');
select lives_ok('update public.profiles set display_name = ' || quote_literal(repeat('é', 100)) || ' where id = ''10000000-0000-4000-8000-000000000001''', 'exactly 100 multibyte characters are accepted');
update public.profiles set display_name = 'Alice' where id = '10000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- RLS is enabled and exactly two policies exist.
-- ---------------------------------------------------------------------------
select is((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), true, 'RLS is enabled on profiles');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'profiles'), 2, 'exactly two policies exist on profiles');
select policies_are('public', 'profiles', array['profiles_select_own', 'profiles_update_own'], 'the two expected policies exist');
select policy_cmd_is('public', 'profiles', 'profiles_select_own', 'SELECT', 'the select policy is FOR SELECT');
select policy_roles_are('public', 'profiles', 'profiles_select_own', array['authenticated'], 'the select policy targets authenticated');
select policy_cmd_is('public', 'profiles', 'profiles_update_own', 'UPDATE', 'the update policy is FOR UPDATE');
select policy_roles_are('public', 'profiles', 'profiles_update_own', array['authenticated'], 'the update policy targets authenticated');
select matches((select qual from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_select_own'), 'id = auth\.uid\(\)', 'the select policy uses id = auth.uid()');
select matches((select qual from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_update_own'), 'id = auth\.uid\(\)', 'the update policy USING uses id = auth.uid()');
select matches((select with_check from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_update_own'), 'id = auth\.uid\(\)', 'the update policy WITH CHECK uses id = auth.uid()');
select is((select with_check from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_select_own'), null, 'the select policy has no WITH CHECK');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'profiles' and roles && array['anon', 'public']::name[]), 0, 'no policy targets anon or PUBLIC');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'profiles' and cmd in ('INSERT', 'DELETE', 'ALL')), 0, 'there is no INSERT or DELETE policy');

-- ---------------------------------------------------------------------------
-- Grants: authenticated gets only SELECT and column-level UPDATE.
-- ---------------------------------------------------------------------------
select is(has_table_privilege('authenticated', 'public.profiles', 'SELECT'), true, 'authenticated has table-level SELECT');
select is(has_table_privilege('authenticated', 'public.profiles', 'UPDATE'), false, 'authenticated has no table-level UPDATE');
select is(has_table_privilege('authenticated', 'public.profiles', 'INSERT'), false, 'authenticated has no INSERT');
select is(has_table_privilege('authenticated', 'public.profiles', 'DELETE'), false, 'authenticated has no DELETE');
select is(has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE'), false, 'authenticated has no TRUNCATE');
select is(has_table_privilege('authenticated', 'public.profiles', 'REFERENCES'), false, 'authenticated has no REFERENCES');
select is(has_table_privilege('authenticated', 'public.profiles', 'TRIGGER'), false, 'authenticated has no TRIGGER');
select is(has_table_privilege('authenticated', 'public.profiles', 'MAINTAIN'), false, 'authenticated has no MAINTAIN');
select is(has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE'), true, 'authenticated can update display_name');
select is(has_column_privilege('authenticated', 'public.profiles', 'avatar_url', 'UPDATE'), true, 'authenticated can update avatar_url');
select is(has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE'), false, 'authenticated cannot update id');
select is(has_column_privilege('authenticated', 'public.profiles', 'created_at', 'UPDATE'), false, 'authenticated cannot update created_at');
select is(has_column_privilege('authenticated', 'public.profiles', 'updated_at', 'UPDATE'), false, 'authenticated cannot update updated_at');
select is(has_table_privilege('anon', 'public.profiles', 'SELECT'), false, 'anon has no SELECT');
select is(has_table_privilege('anon', 'public.profiles', 'INSERT'), false, 'anon has no INSERT');
select is(has_table_privilege('anon', 'public.profiles', 'UPDATE'), false, 'anon has no UPDATE');
select is(has_table_privilege('anon', 'public.profiles', 'DELETE'), false, 'anon has no DELETE');
select is(has_column_privilege('anon', 'public.profiles', 'display_name', 'SELECT'), false, 'anon has no column SELECT');
select is(has_column_privilege('anon', 'public.profiles', 'display_name', 'UPDATE'), false, 'anon has no column UPDATE');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_class c left join lateral aclexplode(c.relacl) a on true where c.oid = 'public.profiles'::regclass), 0, 'PUBLIC has no table privilege on profiles');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_attribute att left join lateral aclexplode(att.attacl) a on true where att.attrelid = 'public.profiles'::regclass and att.attnum > 0 and not att.attisdropped), 0, 'PUBLIC has no column privilege on profiles');
select is(has_table_privilege('service_role', 'public.profiles', 'SELECT'), true, 'service_role has SELECT');
select is(has_table_privilege('service_role', 'public.profiles', 'INSERT'), true, 'service_role has INSERT');
select is(has_table_privilege('service_role', 'public.profiles', 'UPDATE'), true, 'service_role has UPDATE');
select is(has_table_privilege('service_role', 'public.profiles', 'DELETE'), true, 'service_role has DELETE');

-- ---------------------------------------------------------------------------
-- Triggers: signup on auth.users, updated_at on profiles.
-- ---------------------------------------------------------------------------
select has_trigger('auth', 'users', 'on_auth_user_created', 'the signup trigger exists on auth.users');
select trigger_is('auth', 'users', 'on_auth_user_created', 'private', 'handle_new_user', 'the signup trigger calls private.handle_new_user');
select is((select count(*)::int from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal), 1, 'this migration adds exactly one trigger on auth.users');
select is((select tgtype::int from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created'), 5, 'the signup trigger is AFTER INSERT FOR EACH ROW');
select is((select tgenabled::text from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created'), 'O', 'the signup trigger is enabled');
select is((select count(*)::int from pg_trigger where tgrelid = 'public.profiles'::regclass and not tgisinternal), 1, 'profiles has exactly one trigger');
select trigger_is('public', 'profiles', 'profiles_set_updated_at', 'private', 'set_updated_at', 'the profiles trigger calls private.set_updated_at');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'profiles_set_updated_at'), 19, 'the profiles trigger is BEFORE UPDATE FOR EACH ROW');

-- ---------------------------------------------------------------------------
-- Access behaviour as an authenticated user and as anon.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select count(*)::int from public.profiles), 1, 'an authenticated user sees exactly their own profile row');
select is((select id from public.profiles), '10000000-0000-4000-8000-000000000001'::uuid, 'the visible row is the caller id');
select is((select display_name from public.profiles), 'Alice', 'the visible row is the caller profile');
select is((select count(*)::int from public.profiles where id = '10000000-0000-4000-8000-000000000002'), 0, 'another user profile is RLS-filtered to zero rows, not an error');
select lives_ok($$ select * from public.profiles where id = '10000000-0000-4000-8000-000000000002' $$, 'selecting another user row does not raise');
select throws_ok($$ insert into public.profiles (id, display_name) values ('30000000-0000-4000-8000-000000000001', 'Intruder') $$, '42501'::char(5), NULL, 'authenticated INSERT is permission denied');
select throws_ok($$ delete from public.profiles where id = '10000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'authenticated DELETE is permission denied');
select throws_ok($$ update public.profiles set id = '30000000-0000-4000-8000-000000000002' where id = '10000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'authenticated UPDATE of id is permission denied');
select throws_ok($$ update public.profiles set created_at = now() where id = '10000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'authenticated UPDATE of created_at is permission denied');
select throws_ok($$ update public.profiles set updated_at = now() where id = '10000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'authenticated UPDATE of updated_at is permission denied');
select is_empty($$ update public.profiles set display_name = 'Hacked' where id = '10000000-0000-4000-8000-000000000002' returning id $$, 'updating another user affects zero rows');
reset role;
select is((select display_name from public.profiles where id = '10000000-0000-4000-8000-000000000002'), 'Bob', 'another user profile is unchanged after the zero-row update');

set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ update public.profiles set display_name = 'Alice Updated' where id = '10000000-0000-4000-8000-000000000001' $$, 'a user can update their own display_name');
select lives_ok($$ update public.profiles set avatar_url = 'https://example.com/alice.png' where id = '10000000-0000-4000-8000-000000000001' $$, 'a user can update their own avatar_url');
select lives_ok($$ update public.profiles set avatar_url = null where id = '10000000-0000-4000-8000-000000000001' $$, 'a user can clear their own avatar_url');
reset role;
select is((select display_name from public.profiles where id = '10000000-0000-4000-8000-000000000001'), 'Alice Updated', 'the allowed update persisted');
select is((select avatar_url from public.profiles where id = '10000000-0000-4000-8000-000000000001'), null, 'the cleared avatar_url persisted as null');

set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ update public.profiles set display_name = ' Bad' where id = '10000000-0000-4000-8000-000000000001' $$, '23514'::char(5), NULL, 'an invalid own display_name fails the check constraint');
reset role;
select is((select display_name from public.profiles where id = '10000000-0000-4000-8000-000000000001'), 'Alice Updated', 'the failed update left the row unchanged');

set local role anon;
select throws_ok($$ select * from public.profiles $$, '42501'::char(5), NULL, 'anon SELECT fails with permission denied, not an empty result');
select throws_ok($$ update public.profiles set display_name = 'Anon' where id = '10000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'anon UPDATE is permission denied');
reset role;

-- ---------------------------------------------------------------------------
-- updated_at is database-generated and created_at never changes.
-- ---------------------------------------------------------------------------
delete from public.profiles where id = '10000000-0000-4000-8000-000000000004';
select is((select count(*)::int from auth.users where id = '10000000-0000-4000-8000-000000000004'), 1, 'deleting a profile does not delete the auth user');
insert into public.profiles (id, display_name, created_at, updated_at)
values ('10000000-0000-4000-8000-000000000004', 'Dana', '2000-01-02 00:00:00+00', '2000-01-01 00:00:00+00');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated"}';
select lives_ok($$ update public.profiles set display_name = 'Dana Updated' where id = '10000000-0000-4000-8000-000000000004' $$, 'a user can update their own display_name with a past updated_at');
reset role;
select is((select display_name from public.profiles where id = '10000000-0000-4000-8000-000000000004'), 'Dana Updated', 'the update persisted');
select is((select created_at from public.profiles where id = '10000000-0000-4000-8000-000000000004'), '2000-01-02 00:00:00+00'::timestamptz, 'created_at never changes on update');
select ok((select updated_at > '2000-01-01 00:00:00+00'::timestamptz from public.profiles where id = '10000000-0000-4000-8000-000000000004'), 'updated_at advances past a known past value without the client sending it');
select ok((select updated_at > created_at from public.profiles where id = '10000000-0000-4000-8000-000000000004'), 'updated_at is later than created_at after the update');

-- ---------------------------------------------------------------------------
-- Cascade deletion from auth.users.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.profiles where id = '10000000-0000-4000-8000-000000000003'), 1, 'the fixture profile exists before the auth user is deleted');
delete from auth.users where id = '10000000-0000-4000-8000-000000000003';
select is((select count(*)::int from auth.users where id = '10000000-0000-4000-8000-000000000003'), 0, 'the auth user is deleted');
select is((select count(*)::int from public.profiles where id = '10000000-0000-4000-8000-000000000003'), 0, 'deleting the auth user cascades to its profile');

select * from finish();
rollback;
