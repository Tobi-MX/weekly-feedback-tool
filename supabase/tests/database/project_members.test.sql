-- pgTAP tests for project membership, invite links, the facilitator role, the
-- widened projects select policy, and the six membership RPCs.
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension itself. The seed user is never used as a fixture.
--
-- Fixtures: owner A, member B, non-member C, and two more joiners D and E.
-- Project P is owned by A; project Q is owned by C, so B is never in Q.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(275);

-- ---------------------------------------------------------------------------
-- Fixtures: inserting auth.users rows fires private.handle_new_user(), and
-- inserting projects fires the owner-membership trigger.
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'fixture-a@example.com', '{"display_name":"Alice"}'),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'fixture-b@example.com', '{"display_name":"Bob"}'),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'fixture-c@example.com', '{"display_name":"Cara"}'),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'fixture-d@example.com', '{"display_name":"Dana"}'),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'fixture-e@example.com', '{"display_name":"Eve"}');

insert into public.projects (id, name, owner_id, created_at, updated_at)
values
  ('20000000-0000-4000-8000-000000000001', 'Project P', '10000000-0000-4000-8000-000000000001', '2026-10-01 10:00:00+00', '2026-10-01 10:00:00+00'),
  ('20000000-0000-4000-8000-000000000002', 'Project Q', '10000000-0000-4000-8000-000000000003', '2026-10-02 10:00:00+00', '2026-10-02 10:00:00+00');

-- ---------------------------------------------------------------------------
-- project_members shape.
-- ---------------------------------------------------------------------------
select has_table('public', 'project_members', 'project_members table exists');
select columns_are('public', 'project_members', array['project_id', 'user_id', 'role', 'created_at', 'updated_at'], 'project_members has exactly the five expected columns');
select col_type_is('public', 'project_members', 'project_id', 'uuid', 'project_id is uuid');
select col_type_is('public', 'project_members', 'user_id', 'uuid', 'user_id is uuid');
select col_type_is('public', 'project_members', 'role', 'text', 'role is text');
select col_type_is('public', 'project_members', 'created_at', 'timestamp with time zone', 'created_at is timestamptz');
select col_type_is('public', 'project_members', 'updated_at', 'timestamp with time zone', 'updated_at is timestamptz');
select col_not_null('public', 'project_members', 'project_id', 'project_id is not null');
select col_not_null('public', 'project_members', 'user_id', 'user_id is not null');
select col_not_null('public', 'project_members', 'role', 'role is not null');
select col_not_null('public', 'project_members', 'created_at', 'created_at is not null');
select col_not_null('public', 'project_members', 'updated_at', 'updated_at is not null');
select col_hasnt_default('public', 'project_members', 'role', 'role has no default');
select matches((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.project_members'::regclass and a.attname = 'created_at'), 'now\(\)', 'created_at defaults to now()');
select matches((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.project_members'::regclass and a.attname = 'updated_at'), 'now\(\)', 'updated_at defaults to now()');
select col_is_pk('public', 'project_members', array['project_id', 'user_id'], 'the primary key is (project_id, user_id)');
select throws_ok($$ insert into public.project_members (project_id, user_id, role) values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'member') $$, '23505'::char(5), NULL, 'a duplicate membership row is rejected');

select is((select confrelid::regclass::text from pg_constraint where conrelid = 'public.project_members'::regclass and conname = 'project_members_project_id_fkey'), 'projects', 'project_id references public.projects');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.project_members'::regclass and conname = 'project_members_project_id_fkey'), 'c', 'the project_id foreign key is ON DELETE CASCADE');
select is((select confrelid::regclass::text from pg_constraint where conrelid = 'public.project_members'::regclass and conname = 'project_members_user_id_fkey'), 'auth.users', 'user_id references auth.users');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.project_members'::regclass and conname = 'project_members_user_id_fkey'), 'c', 'the user_id foreign key is ON DELETE CASCADE');
select is((select count(*)::int from pg_constraint where conrelid = 'public.project_members'::regclass and contype = 'f'), 2, 'project_members has exactly two foreign keys');

select is((select contype::text from pg_constraint where conrelid = 'public.project_members'::regclass and conname = 'project_members_role_check'), 'c', 'the named role CHECK constraint exists');
select throws_ok($$ insert into public.project_members (project_id, user_id, role) values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', 'owner') $$, '23514'::char(5), NULL, 'role owner is rejected');
select throws_ok($$ insert into public.project_members (project_id, user_id, role) values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', 'admin') $$, '23514'::char(5), NULL, 'role admin is rejected');
select throws_ok($$ insert into public.project_members (project_id, user_id, role) values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', '') $$, '23514'::char(5), NULL, 'an empty role is rejected');
select throws_ok($$ insert into public.project_members (project_id, user_id, role) values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', 'Facilitator') $$, '23514'::char(5), NULL, 'role Facilitator (wrong case) is rejected');

select is(to_regclass('public.project_members_one_facilitator_idx')::text, 'project_members_one_facilitator_idx', 'project_members_one_facilitator_idx exists');
select ok((select indisunique from pg_index where indexrelid = 'public.project_members_one_facilitator_idx'::regclass), 'the facilitator index is unique');
select matches(pg_get_indexdef('public.project_members_one_facilitator_idx'::regclass), '\(project_id\) WHERE \(role = ''facilitator''::text\)', 'the facilitator index is on (project_id) where role = facilitator');
select throws_ok($$ insert into public.project_members (project_id, user_id, role) values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', 'facilitator') $$, '23505'::char(5), NULL, 'a second facilitator for the same project is rejected');
select is(to_regclass('public.project_members_user_idx')::text, 'project_members_user_idx', 'project_members_user_idx exists');
select matches(pg_get_indexdef('public.project_members_user_idx'::regclass), 'ON public\.project_members USING btree \(user_id\)$', 'project_members_user_idx is on (user_id)');

select trigger_is('public', 'project_members', 'project_members_set_updated_at', 'private', 'set_updated_at', 'the updated_at trigger reuses private.set_updated_at');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.project_members'::regclass and tgname = 'project_members_set_updated_at'), 19, 'the updated_at trigger is BEFORE UPDATE FOR EACH ROW');
select is((select count(*)::int from pg_proc where proname = 'set_updated_at'), 1, 'no second updated-at helper was created');

-- ---------------------------------------------------------------------------
-- Owner membership trigger.
-- ---------------------------------------------------------------------------
select trigger_is('public', 'projects', 'projects_add_owner_member', 'private', 'add_project_owner_member', 'the owner-membership trigger exists on projects');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.projects'::regclass and tgname = 'projects_add_owner_member'), 5, 'the owner-membership trigger is AFTER INSERT FOR EACH ROW');

set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ insert into public.projects (name, owner_id) values ('Created By A', '10000000-0000-4000-8000-000000000001') returning id $$, 'user A can create a project as authenticated');
reset role;
select is((select count(*)::int from public.project_members m join public.projects p on p.id = m.project_id where p.name = 'Created By A'), 1, 'creating a project as A produces exactly one membership row');
select is((select m.user_id from public.project_members m join public.projects p on p.id = m.project_id where p.name = 'Created By A'), '10000000-0000-4000-8000-000000000001'::uuid, 'the membership row belongs to A');
select is((select m.role from public.project_members m join public.projects p on p.id = m.project_id where p.name = 'Created By A'), 'facilitator', 'the owner starts as facilitator');
select is((select count(*)::int from public.projects p where (select count(*) from public.project_members m where m.project_id = p.id and m.role = 'facilitator') <> 1 or not exists (select 1 from public.project_members m where m.project_id = p.id and m.user_id = p.owner_id)), 0, 'invariant after create: every project has exactly one facilitator and an owner membership row');

-- ---------------------------------------------------------------------------
-- Backfill: the migration statement adds the owner of a project created
-- before this task, joined at the project's created_at, idempotently.
-- ---------------------------------------------------------------------------
alter table public.projects disable trigger projects_add_owner_member;
insert into public.projects (id, name, owner_id, created_at, updated_at)
values ('20000000-0000-4000-8000-000000000003', 'Backfilled', '10000000-0000-4000-8000-000000000001', '2025-01-01 00:00:00+00', '2025-01-01 00:00:00+00');
alter table public.projects enable trigger projects_add_owner_member;
select is((select count(*)::int from public.project_members where project_id = '20000000-0000-4000-8000-000000000003'), 0, 'with the trigger disabled the project has no membership row');
insert into public.project_members (project_id, user_id, role, created_at, updated_at)
select p.id, p.owner_id, 'facilitator', p.created_at, p.created_at
from public.projects p
on conflict do nothing;
select is((select role from public.project_members where project_id = '20000000-0000-4000-8000-000000000003' and user_id = '10000000-0000-4000-8000-000000000001'), 'facilitator', 'the backfill makes the owner facilitator');
select is((select created_at from public.project_members where project_id = '20000000-0000-4000-8000-000000000003' and user_id = '10000000-0000-4000-8000-000000000001'), '2025-01-01 00:00:00+00'::timestamptz, 'the backfilled row is joined at the project created_at');
insert into public.project_members (project_id, user_id, role, created_at, updated_at)
select p.id, p.owner_id, 'facilitator', p.created_at, p.created_at
from public.projects p
on conflict do nothing;
select is((select count(*)::int from public.project_members where project_id = '20000000-0000-4000-8000-000000000003'), 1, 'running the backfill twice adds no row');
select matches((select pg_get_triggerdef(oid) from pg_trigger where tgname = 'projects_add_owner_member'), 'AFTER INSERT ON public\.projects', 'the trigger is re-enabled on projects');
select is((select tgenabled::text from pg_trigger where tgname = 'projects_add_owner_member'), 'O', 'the owner-membership trigger is enabled');

-- ---------------------------------------------------------------------------
-- RLS, policy, and grants on project_members.
-- ---------------------------------------------------------------------------
select is((select relrowsecurity from pg_class where oid = 'public.project_members'::regclass), true, 'RLS is enabled on project_members');
select policies_are('public', 'project_members', array['project_members_select_member'], 'exactly one policy exists on project_members');
select policy_cmd_is('public', 'project_members', 'project_members_select_member', 'SELECT', 'the policy is FOR SELECT');
select policy_roles_are('public', 'project_members', 'project_members_select_member', array['authenticated'], 'the policy targets authenticated only');
select is((select qual from pg_policies where schemaname = 'public' and tablename = 'project_members' and policyname = 'project_members_select_member'), 'private.is_project_member(project_id)', 'the policy uses private.is_project_member(project_id)');
select is((select with_check from pg_policies where schemaname = 'public' and tablename = 'project_members' and policyname = 'project_members_select_member'), null, 'the policy has no WITH CHECK');

select is(has_table_privilege('authenticated', 'public.project_members', 'SELECT'), true, 'authenticated has table-level SELECT');
select is(has_table_privilege('authenticated', 'public.project_members', 'INSERT'), false, 'authenticated has no INSERT');
select is(has_table_privilege('authenticated', 'public.project_members', 'UPDATE'), false, 'authenticated has no UPDATE');
select is(has_table_privilege('authenticated', 'public.project_members', 'DELETE'), false, 'authenticated has no DELETE');
select is(has_table_privilege('authenticated', 'public.project_members', 'TRUNCATE'), false, 'authenticated has no TRUNCATE');
select is(has_table_privilege('authenticated', 'public.project_members', 'REFERENCES'), false, 'authenticated has no REFERENCES');
select is(has_table_privilege('authenticated', 'public.project_members', 'TRIGGER'), false, 'authenticated has no TRIGGER');
select is(has_table_privilege('authenticated', 'public.project_members', 'MAINTAIN'), false, 'authenticated has no MAINTAIN');
select is(has_any_column_privilege('authenticated', 'public.project_members', 'INSERT'), false, 'authenticated has no column INSERT');
select is(has_any_column_privilege('authenticated', 'public.project_members', 'UPDATE'), false, 'authenticated has no column UPDATE');
select is(has_any_column_privilege('anon', 'public.project_members', 'SELECT'), false, 'anon has no SELECT');
select is(has_any_column_privilege('anon', 'public.project_members', 'INSERT'), false, 'anon has no INSERT');
select is(has_any_column_privilege('anon', 'public.project_members', 'UPDATE'), false, 'anon has no UPDATE');
select is(has_table_privilege('anon', 'public.project_members', 'DELETE'), false, 'anon has no DELETE');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_class c left join lateral aclexplode(c.relacl) a on true where c.oid = 'public.project_members'::regclass), 0, 'PUBLIC has no table privilege on project_members');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_attribute att left join lateral aclexplode(att.attacl) a on true where att.attrelid = 'public.project_members'::regclass and att.attnum > 0 and not att.attisdropped), 0, 'PUBLIC has no column privilege on project_members');
select is(has_table_privilege('service_role', 'public.project_members', 'SELECT'), true, 'service_role has SELECT');
select is(has_table_privilege('service_role', 'public.project_members', 'INSERT'), true, 'service_role has INSERT');
select is(has_table_privilege('service_role', 'public.project_members', 'UPDATE'), true, 'service_role has UPDATE');
select is(has_table_privilege('service_role', 'public.project_members', 'DELETE'), true, 'service_role has DELETE');

-- ---------------------------------------------------------------------------
-- Private helpers.
-- ---------------------------------------------------------------------------
select is(has_schema_privilege('authenticated', 'private', 'USAGE'), true, 'authenticated has USAGE on private');
select is(has_schema_privilege('anon', 'private', 'USAGE'), false, 'anon has no USAGE on private');
select is((select prosecdef from pg_proc where oid = 'private.is_project_member(uuid)'::regprocedure), true, 'is_project_member is security definer');
select is((select provolatile::text from pg_proc where oid = 'private.is_project_member(uuid)'::regprocedure), 's', 'is_project_member is stable');
select is((select proconfig from pg_proc where oid = 'private.is_project_member(uuid)'::regprocedure), array['search_path=""']::text[], 'is_project_member fixes search_path');
select matches((select prosrc from pg_proc where oid = 'private.is_project_member(uuid)'::regprocedure), 'public\.project_members', 'is_project_member schema-qualifies project_members');
select matches((select prosrc from pg_proc where oid = 'private.is_project_member(uuid)'::regprocedure), 'user_id = \(select auth\.uid\(\)\)', 'is_project_member checks user_id = (select auth.uid())');
select is((select prosecdef from pg_proc where oid = 'private.is_project_facilitator(uuid)'::regprocedure), true, 'is_project_facilitator is security definer');
select is((select provolatile::text from pg_proc where oid = 'private.is_project_facilitator(uuid)'::regprocedure), 's', 'is_project_facilitator is stable');
select is((select proconfig from pg_proc where oid = 'private.is_project_facilitator(uuid)'::regprocedure), array['search_path=""']::text[], 'is_project_facilitator fixes search_path');
select is(has_function_privilege('authenticated', 'private.is_project_member(uuid)', 'EXECUTE'), true, 'authenticated can execute is_project_member');
select is(has_function_privilege('authenticated', 'private.is_project_facilitator(uuid)', 'EXECUTE'), true, 'authenticated can execute is_project_facilitator');
select is(has_function_privilege('anon', 'private.is_project_member(uuid)', 'EXECUTE'), false, 'anon cannot execute is_project_member');
select is(has_function_privilege('anon', 'private.is_project_facilitator(uuid)', 'EXECUTE'), false, 'anon cannot execute is_project_facilitator');
select is(has_function_privilege('authenticated', 'private.set_updated_at()', 'EXECUTE'), false, 'authenticated still cannot execute set_updated_at');
select is(has_function_privilege('authenticated', 'private.handle_new_user()', 'EXECUTE'), false, 'authenticated still cannot execute handle_new_user');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'EXECUTE')), 2, 'authenticated can execute exactly two private functions');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace left join lateral aclexplode(p.proacl) a on true where n.nspname = 'private'), 0, 'PUBLIC can execute no private function');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(private.is_project_member('20000000-0000-4000-8000-000000000001'), true, 'is_project_member is true for the owner');
select is(private.is_project_facilitator('20000000-0000-4000-8000-000000000001'), true, 'is_project_facilitator is true for the owner while facilitator');
select is(private.is_project_member('20000000-0000-4000-8000-000000000002'), false, 'is_project_member is false for a project A is not in');
reset role;

-- ---------------------------------------------------------------------------
-- project_invites shape and privileges.
-- ---------------------------------------------------------------------------
select has_table('public', 'project_invites', 'project_invites table exists');
select columns_are('public', 'project_invites', array['project_id', 'token', 'created_by', 'created_at', 'expires_at', 'revoked_at'], 'project_invites has exactly the expected columns');
select col_is_pk('public', 'project_invites', 'project_id', 'project_id is the primary key (one invite per project)');
select col_not_null('public', 'project_invites', 'token', 'token is not null');
select col_type_is('public', 'project_invites', 'token', 'text', 'token is text');
select col_is_unique('public', 'project_invites', 'token', 'token is unique');
select col_not_null('public', 'project_invites', 'created_by', 'created_by is not null');
select col_not_null('public', 'project_invites', 'created_at', 'created_at is not null');
select col_not_null('public', 'project_invites', 'expires_at', 'expires_at is not null');
select col_type_is('public', 'project_invites', 'expires_at', 'timestamp with time zone', 'expires_at is timestamptz');
select col_is_null('public', 'project_invites', 'revoked_at', 'revoked_at is nullable');
select col_type_is('public', 'project_invites', 'revoked_at', 'timestamp with time zone', 'revoked_at is timestamptz');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.project_invites'::regclass and contype = 'f' and confrelid = 'public.projects'::regclass), 'c', 'project_id references projects ON DELETE CASCADE');
select is((select count(*)::int from pg_constraint where conrelid = 'public.project_invites'::regclass and contype = 'f' and confrelid = 'auth.users'::regclass), 1, 'created_by references auth.users');
select is((select relrowsecurity from pg_class where oid = 'public.project_invites'::regclass), true, 'RLS is enabled on project_invites');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'project_invites'), 0, 'project_invites has no policies');
select is(has_any_column_privilege('authenticated', 'public.project_invites', 'SELECT'), false, 'authenticated has no SELECT on project_invites');
select is(has_any_column_privilege('authenticated', 'public.project_invites', 'INSERT'), false, 'authenticated has no INSERT on project_invites');
select is(has_any_column_privilege('authenticated', 'public.project_invites', 'UPDATE'), false, 'authenticated has no UPDATE on project_invites');
select is(has_table_privilege('authenticated', 'public.project_invites', 'DELETE'), false, 'authenticated has no DELETE on project_invites');
select is(has_any_column_privilege('anon', 'public.project_invites', 'SELECT'), false, 'anon has no SELECT on project_invites');
select is(has_any_column_privilege('anon', 'public.project_invites', 'INSERT'), false, 'anon has no INSERT on project_invites');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_class c left join lateral aclexplode(c.relacl) a on true where c.oid = 'public.project_invites'::regclass), 0, 'PUBLIC has no privilege on project_invites');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ select * from public.project_invites $$, '42501'::char(5), NULL, 'a direct select of project_invites as the owner is permission denied');
reset role;

-- ---------------------------------------------------------------------------
-- Invite RPCs as the owner: none, create, rotate, revoke.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is_empty($$ select * from public.get_project_invite('20000000-0000-4000-8000-000000000001') $$, 'get_project_invite returns no row before an invite exists');
do $$ begin perform set_config('test.token1', (select token from public.create_project_invite('20000000-0000-4000-8000-000000000001')), true); end $$;
select matches(current_setting('test.token1'), '^[0-9a-f]{64}$', 'the token is 64 lowercase hex characters');
select results_eq($$ select token, expires_at, status from public.get_project_invite('20000000-0000-4000-8000-000000000001') $$, format('values (%L::text, now() + interval ''7 days'', ''active''::text)', current_setting('test.token1')), 'get_project_invite returns the token, a 7-day expiry, and active');
do $$ begin perform set_config('test.token2', (select token from public.create_project_invite('20000000-0000-4000-8000-000000000001')), true); end $$;
select matches(current_setting('test.token2'), '^[0-9a-f]{64}$', 'the rotated token is 64 lowercase hex characters');
select isnt(current_setting('test.token2'), current_setting('test.token1'), 'two rotations produce different tokens');
select is((select token from public.get_project_invite('20000000-0000-4000-8000-000000000001')), current_setting('test.token2'), 'the invite now carries the rotated token');
reset role;
select is((select count(*)::int from public.project_invites where project_id = '20000000-0000-4000-8000-000000000001'), 1, 'rotation keeps one invite row per project');
select matches((select prosrc from pg_proc where oid = 'public.create_project_invite(uuid)'::regprocedure), 'extensions\.gen_random_bytes\(32\)', 'tokens come from 32 bytes of extensions.gen_random_bytes');

-- ---------------------------------------------------------------------------
-- Joining with the active token.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}';
select results_eq(format('select project_id, project_name, already_member from public.join_project(%L)', current_setting('test.token2')), $$ values ('20000000-0000-4000-8000-000000000001'::uuid, 'Project P'::text, false) $$, 'B joins P with the active token as a new member');
reset role;
select is((select role from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000002'), 'member', 'B joined as member');
select is((select count(*)::int from public.projects p where (select count(*) from public.project_members m where m.project_id = p.id and m.role = 'facilitator') <> 1 or not exists (select 1 from public.project_members m where m.project_id = p.id and m.user_id = p.owner_id)), 0, 'invariant after join: every project has exactly one facilitator and an owner membership row');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated"}';
select results_eq(format('select already_member from public.join_project(%L)', current_setting('test.token2')), $$ values (false) $$, 'D can join with the same reusable link');
reset role;
select is((select count(*)::int from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and user_id in ('10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000004') and role = 'member'), 2, 'each joiner gets exactly one member row');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}';
select results_eq(format('select already_member from public.join_project(%L)', current_setting('test.token2')), $$ values (true) $$, 'B joining again reports already_member');
reset role;
select is((select count(*)::int from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000002'), 1, 'joining again adds no row');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select results_eq(format('select already_member from public.join_project(%L)', current_setting('test.token2')), $$ values (true) $$, 'the owner joining reports already_member');
reset role;
select is((select role from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000001'), 'facilitator', 'joining does not change the owner facilitator role');
select matches((select prosrc from pg_proc where oid = 'public.join_project(text)'::regprocedure), 'do nothing', 'join_project uses on conflict do nothing for concurrent joins');

-- ---------------------------------------------------------------------------
-- Invalid and expired tokens. The token is checked before membership.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(format('select * from public.join_project(%L)', current_setting('test.token1')), 'P0001'::char(5), 'invite_invalid', 'the old token fails after rotation');
select throws_ok($$ select * from public.join_project(repeat('a', 64)) $$, 'P0001'::char(5), 'invite_invalid', 'an unknown token is invalid');
select throws_ok($$ select * from public.join_project('') $$, 'P0001'::char(5), 'invite_invalid', 'an empty token is invalid');
select throws_ok($$ select * from public.join_project(null) $$, 'P0001'::char(5), 'invite_invalid', 'a null token is invalid');
select throws_ok($$ select * from public.join_project('not-a-token') $$, 'P0001'::char(5), 'invite_invalid', 'a malformed token is invalid');
select throws_ok(format('select * from public.join_project(%L)', upper(current_setting('test.token2'))), 'P0001'::char(5), 'invite_invalid', 'an uppercase token is invalid');
select throws_ok(format('select * from public.join_project(%L)', current_setting('test.token2') || 'a'), 'P0001'::char(5), 'invite_invalid', 'a 65-character token is invalid');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(format('select * from public.join_project(%L)', current_setting('test.token1')), 'P0001'::char(5), 'invite_invalid', 'a member gets the same invite_invalid for the old token');
reset role;

-- Expiry uses the database clock.
update public.project_invites set expires_at = now() - interval '1 second' where project_id = '20000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(format('select * from public.join_project(%L)', current_setting('test.token2')), 'P0001'::char(5), 'invite_expired', 'an expired token raises invite_expired for a non-member');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(format('select * from public.join_project(%L)', current_setting('test.token2')), 'P0001'::char(5), 'invite_expired', 'an expired token raises invite_expired for a member');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select status from public.get_project_invite('20000000-0000-4000-8000-000000000001')), 'expired', 'get_project_invite reports expired');
do $$ begin perform set_config('test.token3', (select token from public.create_project_invite('20000000-0000-4000-8000-000000000001')), true); end $$;
select is((select status from public.get_project_invite('20000000-0000-4000-8000-000000000001')), 'active', 'rotating an expired invite makes it active');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000005","role":"authenticated"}';
select results_eq(format('select already_member from public.join_project(%L)', current_setting('test.token3')), $$ values (false) $$, 'the new token joins after rotating an expired link');
reset role;
select is((select count(*)::int from public.projects p where (select count(*) from public.project_members m where m.project_id = p.id and m.role = 'facilitator') <> 1 or not exists (select 1 from public.project_members m where m.project_id = p.id and m.user_id = p.owner_id)), 0, 'invariant after join after rotation: every project has exactly one facilitator and an owner membership row');

-- Revoke: twice succeeds and keeps the first revoked_at.
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select public.revoke_project_invite('20000000-0000-4000-8000-000000000001') $$, 'the owner can revoke the invite');
reset role;
update public.project_invites set revoked_at = '2026-01-01 00:00:00+00' where project_id = '20000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select public.revoke_project_invite('20000000-0000-4000-8000-000000000001') $$, 'revoking twice succeeds');
reset role;
select is((select revoked_at from public.project_invites where project_id = '20000000-0000-4000-8000-000000000001'), '2026-01-01 00:00:00+00'::timestamptz, 'revoking twice keeps the first revoked_at');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select status from public.get_project_invite('20000000-0000-4000-8000-000000000001')), 'revoked', 'get_project_invite reports revoked');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(format('select * from public.join_project(%L)', current_setting('test.token3')), 'P0001'::char(5), 'invite_invalid', 'a revoked token is invalid');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin perform set_config('test.token4', (select token from public.create_project_invite('20000000-0000-4000-8000-000000000001')), true); end $$;
select results_eq($$ select status from public.get_project_invite('20000000-0000-4000-8000-000000000001') $$, $$ values ('active'::text) $$, 'creating a new link clears revoked_at');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(format('select * from public.join_project(%L)', current_setting('test.token3')), 'P0001'::char(5), 'invite_invalid', 'the revoked token stays invalid after rotation');
reset role;

-- Unauthenticated callers cannot join.
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok(format('select * from public.join_project(%L)', current_setting('test.token4')), '42501'::char(5), NULL, 'a call with a null auth.uid() raises 42501');
reset role;
set local role anon;
select throws_ok(format('select * from public.join_project(%L)', current_setting('test.token4')), '42501'::char(5), NULL, 'anon cannot execute join_project');
reset role;

-- ---------------------------------------------------------------------------
-- Owner-only invite RPCs: non-owners get not_project_owner.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$ select * from public.create_project_invite('20000000-0000-4000-8000-000000000001') $$, '42501'::char(5), 'not_project_owner', 'a member cannot create an invite');
select throws_ok($$ select * from public.get_project_invite('20000000-0000-4000-8000-000000000001') $$, '42501'::char(5), 'not_project_owner', 'a member cannot read the invite');
select throws_ok($$ select public.revoke_project_invite('20000000-0000-4000-8000-000000000001') $$, '42501'::char(5), 'not_project_owner', 'a member cannot revoke the invite');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$ select * from public.create_project_invite('20000000-0000-4000-8000-000000000001') $$, '42501'::char(5), 'not_project_owner', 'a non-member cannot create an invite');
select throws_ok($$ select * from public.get_project_invite('20000000-0000-4000-8000-000000000001') $$, '42501'::char(5), 'not_project_owner', 'a non-member cannot read the invite');
select throws_ok($$ select public.revoke_project_invite('20000000-0000-4000-8000-000000000001') $$, '42501'::char(5), 'not_project_owner', 'a non-member cannot revoke the invite');
select throws_ok($$ select * from public.create_project_invite('20000000-0000-4000-8000-000000000099') $$, '42501'::char(5), 'not_project_owner', 'an unknown project id gets the same error on create');
select throws_ok($$ select * from public.get_project_invite('20000000-0000-4000-8000-000000000099') $$, '42501'::char(5), 'not_project_owner', 'an unknown project id gets the same error on get');
select throws_ok($$ select public.revoke_project_invite('20000000-0000-4000-8000-000000000099') $$, '42501'::char(5), 'not_project_owner', 'an unknown project id gets the same error on revoke');
reset role;

-- ---------------------------------------------------------------------------
-- Member reads: RLS on project_members and projects, the members RPC.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*)::int from public.project_members where project_id = '20000000-0000-4000-8000-000000000001'), 4, 'member B sees every member row of P');
select is((select count(*)::int from public.project_members where project_id = '20000000-0000-4000-8000-000000000002'), 0, 'member B sees zero rows of a project B is not in');
select is((select count(*)::int from public.projects where id = '20000000-0000-4000-8000-000000000001'), 1, 'member B can select project P');
select is_empty($$ update public.projects set name = 'Renamed By B' where id = '20000000-0000-4000-8000-000000000001' returning id $$, 'member B updating P affects zero rows');
select throws_ok($$ delete from public.projects where id = '20000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'member B deleting P is permission denied');
select is((select count(*)::int from public.profiles where id = '10000000-0000-4000-8000-000000000001'), 0, 'member B still cannot select A profile directly');
select results_eq(
  $$ select user_id, display_name, role, is_owner, is_me from public.get_project_members('20000000-0000-4000-8000-000000000001') $$,
  $$ values
    ('10000000-0000-4000-8000-000000000001'::uuid, 'Alice'::text, 'facilitator'::text, true, false),
    ('10000000-0000-4000-8000-000000000002'::uuid, 'Bob'::text, 'member'::text, false, true),
    ('10000000-0000-4000-8000-000000000004'::uuid, 'Dana'::text, 'member'::text, false, false),
    ('10000000-0000-4000-8000-000000000005'::uuid, 'Eve'::text, 'member'::text, false, false) $$,
  'get_project_members returns every member with name, role, owner, and me flags ordered by joined_at then user_id'
);
select throws_ok($$ insert into public.project_members (project_id, user_id, role) values ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'member') $$, '42501'::char(5), NULL, 'a member cannot insert a membership row directly');
select throws_ok($$ update public.project_members set role = 'facilitator' where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000002' $$, '42501'::char(5), NULL, 'a member cannot promote themselves directly');
select throws_ok($$ delete from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'a member cannot delete a membership row directly');
reset role;
select is((select name from public.projects where id = '20000000-0000-4000-8000-000000000001'), 'Project P', 'the project name is unchanged after member B update');
select is((select pg_get_function_result('public.get_project_members(uuid)'::regprocedure)), 'TABLE(user_id uuid, display_name text, role text, is_owner boolean, is_me boolean, joined_at timestamp with time zone)', 'get_project_members returns no email, avatar, or other auth field');

set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ insert into public.project_members (project_id, user_id, role) values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 'member') $$, '42501'::char(5), NULL, 'the owner cannot insert a membership row directly');
select throws_ok($$ update public.project_members set role = 'member' where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000001' $$, '42501'::char(5), NULL, 'the owner cannot update a role directly');
select throws_ok($$ delete from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000002' $$, '42501'::char(5), NULL, 'the owner cannot delete a membership row directly');
select ok((select g.joined_at = m.created_at from public.get_project_members('20000000-0000-4000-8000-000000000001') g join public.project_members m on m.project_id = '20000000-0000-4000-8000-000000000001' and m.user_id = g.user_id where g.user_id = '10000000-0000-4000-8000-000000000004'), 'joined_at is the membership created_at');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is((select count(*)::int from public.project_members where project_id = '20000000-0000-4000-8000-000000000001'), 0, 'non-member C sees zero member rows of P');
select lives_ok($$ select * from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' $$, 'selecting P members as C does not raise');
select is((select count(*)::int from public.projects where id = '20000000-0000-4000-8000-000000000001'), 0, 'non-member C sees zero rows of P');
select lives_ok($$ select * from public.projects where id = '20000000-0000-4000-8000-000000000001' $$, 'selecting P as C does not raise');
select throws_ok($$ select * from public.get_project_members('20000000-0000-4000-8000-000000000001') $$, '42501'::char(5), 'not_project_member', 'a non-member cannot list members');
select throws_ok($$ select * from public.get_project_members('20000000-0000-4000-8000-000000000099') $$, '42501'::char(5), 'not_project_member', 'an unknown project id gets the same not_project_member error');
reset role;

-- ---------------------------------------------------------------------------
-- Facilitator transfer.
-- ---------------------------------------------------------------------------
update public.project_members set created_at = '2026-10-05 00:00:00+00', updated_at = '2026-10-05 00:00:00+00' where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$ select public.transfer_facilitator('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002') $$, '42501'::char(5), 'not_project_owner', 'a member cannot take the facilitator role');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$ select public.transfer_facilitator('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003') $$, '42501'::char(5), 'not_project_owner', 'a non-member cannot transfer the facilitator role');
select throws_ok($$ select public.transfer_facilitator('20000000-0000-4000-8000-000000000099', '10000000-0000-4000-8000-000000000003') $$, '42501'::char(5), 'not_project_owner', 'an unknown project id gets not_project_owner on transfer');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ select public.transfer_facilitator('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003') $$, 'P0001'::char(5), 'target_not_member', 'transferring to a non-member raises target_not_member');
select throws_ok($$ select public.transfer_facilitator('20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000099') $$, 'P0001'::char(5), 'target_not_member', 'transferring to an unknown user raises target_not_member');
select lives_ok($$ select public.transfer_facilitator('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002') $$, 'the owner can transfer the facilitator role to B');
reset role;
select is((select role from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000002'), 'facilitator', 'B is now the facilitator');
select is((select role from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000001'), 'member', 'the owner is now a member');
select is((select count(*)::int from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and role = 'facilitator'), 1, 'exactly one facilitator after the transfer');
select ok((select updated_at > '2026-10-05 00:00:00+00'::timestamptz from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000002'), 'changing a role advances updated_at');
select is((select created_at from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000002'), '2026-10-05 00:00:00+00'::timestamptz, 'changing a role leaves created_at unchanged');
select is((select count(*)::int from public.projects p where (select count(*) from public.project_members m where m.project_id = p.id and m.role = 'facilitator') <> 1 or not exists (select 1 from public.project_members m where m.project_id = p.id and m.user_id = p.owner_id)), 0, 'invariant after transfer to B: every project has exactly one facilitator and an owner membership row');

set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(private.is_project_facilitator('20000000-0000-4000-8000-000000000001'), true, 'is_project_facilitator is true for B');
select throws_ok($$ select * from public.create_project_invite('20000000-0000-4000-8000-000000000001') $$, '42501'::char(5), 'not_project_owner', 'a non-owner facilitator cannot create an invite');
select throws_ok($$ select * from public.get_project_invite('20000000-0000-4000-8000-000000000001') $$, '42501'::char(5), 'not_project_owner', 'a non-owner facilitator cannot read the invite');
select throws_ok($$ select public.revoke_project_invite('20000000-0000-4000-8000-000000000001') $$, '42501'::char(5), 'not_project_owner', 'a non-owner facilitator cannot revoke the invite');
select throws_ok($$ select public.transfer_facilitator('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004') $$, '42501'::char(5), 'not_project_owner', 'a non-owner facilitator cannot transfer the role');
select results_eq(format('select already_member from public.join_project(%L)', current_setting('test.token4')), $$ values (true) $$, 'the facilitator joining reports already_member');
reset role;
select is((select role from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000002'), 'facilitator', 'joining does not change the facilitator role');

set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(private.is_project_facilitator('20000000-0000-4000-8000-000000000001'), false, 'is_project_facilitator is false for the owner after transferring');
select is((select status from public.get_project_invite('20000000-0000-4000-8000-000000000001')), 'active', 'the owner as member can still read the invite');
select lives_ok($$ select public.transfer_facilitator('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002') $$, 'transferring to the current facilitator is a no-op');
reset role;
select is((select count(*)::int from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and role = 'facilitator'), 1, 'still exactly one facilitator after the no-op');
select is((select count(*)::int from public.projects p where (select count(*) from public.project_members m where m.project_id = p.id and m.role = 'facilitator') <> 1 or not exists (select 1 from public.project_members m where m.project_id = p.id and m.user_id = p.owner_id)), 0, 'invariant after no-op transfer: every project has exactly one facilitator and an owner membership row');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select public.transfer_facilitator('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001') $$, 'the owner can take the facilitator role back');
reset role;
select is((select role from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000001'), 'facilitator', 'the owner is facilitator again');
select is((select role from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000002'), 'member', 'B is a member again');
select is((select count(*)::int from public.projects p where (select count(*) from public.project_members m where m.project_id = p.id and m.role = 'facilitator') <> 1 or not exists (select 1 from public.project_members m where m.project_id = p.id and m.user_id = p.owner_id)), 0, 'invariant after transfer back: every project has exactly one facilitator and an owner membership row');
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select public.transfer_facilitator('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002') $$, 'the owner transfers to B again');
reset role;
select is((select count(*)::int from public.projects p where (select count(*) from public.project_members m where m.project_id = p.id and m.role = 'facilitator') <> 1 or not exists (select 1 from public.project_members m where m.project_id = p.id and m.user_id = p.owner_id)), 0, 'invariant after second transfer: every project has exactly one facilitator and an owner membership row');

-- ---------------------------------------------------------------------------
-- Last facilitator: deleting the facilitator's auth user restores the owner.
-- The operator deletes auth users through the Auth admin API; locally the
-- migration role stands in for it because service_role has no DELETE on
-- auth.users.
-- ---------------------------------------------------------------------------
select is(has_table_privilege('service_role', 'auth.users', 'DELETE'), false, 'service_role cannot delete auth.users directly (the Auth admin API does)');
delete from auth.users where id = '10000000-0000-4000-8000-000000000002';
select is((select count(*)::int from public.project_members where user_id = '10000000-0000-4000-8000-000000000002'), 0, 'the cascade removed B membership');
select is((select role from public.project_members where project_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000001'), 'facilitator', 'the owner becomes facilitator when the facilitator row is deleted');
select is((select count(*)::int from public.projects p where (select count(*) from public.project_members m where m.project_id = p.id and m.role = 'facilitator') <> 1 or not exists (select 1 from public.project_members m where m.project_id = p.id and m.user_id = p.owner_id)), 0, 'invariant after facilitator deletion: every project has exactly one facilitator and an owner membership row');

-- Deleting a whole project cascades its members and invite without error.
set local role service_role;
select lives_ok($$ delete from public.projects where id = '20000000-0000-4000-8000-000000000001' $$, 'service_role can delete a project with members');
reset role;
select is((select count(*)::int from public.project_members where project_id = '20000000-0000-4000-8000-000000000001'), 0, 'deleting the project removes its membership rows');
select is((select count(*)::int from public.project_invites where project_id = '20000000-0000-4000-8000-000000000001'), 0, 'deleting the project removes its invite');
select is((select count(*)::int from public.projects p where (select count(*) from public.project_members m where m.project_id = p.id and m.role = 'facilitator') <> 1 or not exists (select 1 from public.project_members m where m.project_id = p.id and m.user_id = p.owner_id)), 0, 'invariant after project deletion: every project has exactly one facilitator and an owner membership row');

-- ---------------------------------------------------------------------------
-- RPC hardening.
-- ---------------------------------------------------------------------------
select is((select prosecdef from pg_proc where oid = 'public.create_project_invite(uuid)'::regprocedure), true, 'create_project_invite is security definer');
select is((select proconfig from pg_proc where oid = 'public.create_project_invite(uuid)'::regprocedure), array['search_path=""']::text[], 'create_project_invite fixes search_path to empty');
select doesnt_match((select prosrc from pg_proc where oid = 'public.create_project_invite(uuid)'::regprocedure), '\mexecute\M', 'create_project_invite uses no dynamic SQL');
select matches((select prosrc from pg_proc where oid = 'public.create_project_invite(uuid)'::regprocedure), 'private\.assert_project_owner\(p_project_id\)', 'create_project_invite checks ownership via (select auth.uid()) inside the function');
select is(has_function_privilege('anon', 'public.create_project_invite(uuid)', 'EXECUTE'), false, 'anon cannot execute create_project_invite');
select is(has_function_privilege('authenticated', 'public.create_project_invite(uuid)', 'EXECUTE'), true, 'authenticated can execute create_project_invite');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.create_project_invite(uuid)'::regprocedure), 0, 'PUBLIC cannot execute create_project_invite');
select is((select prosecdef from pg_proc where oid = 'public.get_project_invite(uuid)'::regprocedure), true, 'get_project_invite is security definer');
select is((select proconfig from pg_proc where oid = 'public.get_project_invite(uuid)'::regprocedure), array['search_path=""']::text[], 'get_project_invite fixes search_path to empty');
select doesnt_match((select prosrc from pg_proc where oid = 'public.get_project_invite(uuid)'::regprocedure), '\mexecute\M', 'get_project_invite uses no dynamic SQL');
select matches((select prosrc from pg_proc where oid = 'public.get_project_invite(uuid)'::regprocedure), 'private\.assert_project_owner\(p_project_id\)', 'get_project_invite checks ownership via (select auth.uid()) inside the function');
select is(has_function_privilege('anon', 'public.get_project_invite(uuid)', 'EXECUTE'), false, 'anon cannot execute get_project_invite');
select is(has_function_privilege('authenticated', 'public.get_project_invite(uuid)', 'EXECUTE'), true, 'authenticated can execute get_project_invite');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.get_project_invite(uuid)'::regprocedure), 0, 'PUBLIC cannot execute get_project_invite');
select is((select prosecdef from pg_proc where oid = 'public.revoke_project_invite(uuid)'::regprocedure), true, 'revoke_project_invite is security definer');
select is((select proconfig from pg_proc where oid = 'public.revoke_project_invite(uuid)'::regprocedure), array['search_path=""']::text[], 'revoke_project_invite fixes search_path to empty');
select doesnt_match((select prosrc from pg_proc where oid = 'public.revoke_project_invite(uuid)'::regprocedure), '\mexecute\M', 'revoke_project_invite uses no dynamic SQL');
select matches((select prosrc from pg_proc where oid = 'public.revoke_project_invite(uuid)'::regprocedure), 'private\.assert_project_owner\(p_project_id\)', 'revoke_project_invite checks ownership via (select auth.uid()) inside the function');
select is(has_function_privilege('anon', 'public.revoke_project_invite(uuid)', 'EXECUTE'), false, 'anon cannot execute revoke_project_invite');
select is(has_function_privilege('authenticated', 'public.revoke_project_invite(uuid)', 'EXECUTE'), true, 'authenticated can execute revoke_project_invite');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.revoke_project_invite(uuid)'::regprocedure), 0, 'PUBLIC cannot execute revoke_project_invite');
select is((select prosecdef from pg_proc where oid = 'public.join_project(text)'::regprocedure), true, 'join_project is security definer');
select is((select proconfig from pg_proc where oid = 'public.join_project(text)'::regprocedure), array['search_path=""']::text[], 'join_project fixes search_path to empty');
select doesnt_match((select prosrc from pg_proc where oid = 'public.join_project(text)'::regprocedure), '\mexecute\M', 'join_project uses no dynamic SQL');
select matches((select prosrc from pg_proc where oid = 'public.join_project(text)'::regprocedure), '\(select auth\.uid\(\)\)', 'join_project checks (select auth.uid()) inside the function');
select is(has_function_privilege('anon', 'public.join_project(text)', 'EXECUTE'), false, 'anon cannot execute join_project');
select is(has_function_privilege('authenticated', 'public.join_project(text)', 'EXECUTE'), true, 'authenticated can execute join_project');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.join_project(text)'::regprocedure), 0, 'PUBLIC cannot execute join_project');
select is((select prosecdef from pg_proc where oid = 'public.get_project_members(uuid)'::regprocedure), true, 'get_project_members is security definer');
select is((select proconfig from pg_proc where oid = 'public.get_project_members(uuid)'::regprocedure), array['search_path=""']::text[], 'get_project_members fixes search_path to empty');
select doesnt_match((select prosrc from pg_proc where oid = 'public.get_project_members(uuid)'::regprocedure), '\mexecute\M', 'get_project_members uses no dynamic SQL');
select matches((select prosrc from pg_proc where oid = 'public.get_project_members(uuid)'::regprocedure), '\(select auth\.uid\(\)\)', 'get_project_members checks (select auth.uid()) inside the function');
select is(has_function_privilege('anon', 'public.get_project_members(uuid)', 'EXECUTE'), false, 'anon cannot execute get_project_members');
select is(has_function_privilege('authenticated', 'public.get_project_members(uuid)', 'EXECUTE'), true, 'authenticated can execute get_project_members');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.get_project_members(uuid)'::regprocedure), 0, 'PUBLIC cannot execute get_project_members');
select is((select prosecdef from pg_proc where oid = 'public.transfer_facilitator(uuid, uuid)'::regprocedure), true, 'transfer_facilitator is security definer');
select is((select proconfig from pg_proc where oid = 'public.transfer_facilitator(uuid, uuid)'::regprocedure), array['search_path=""']::text[], 'transfer_facilitator fixes search_path to empty');
select doesnt_match((select prosrc from pg_proc where oid = 'public.transfer_facilitator(uuid, uuid)'::regprocedure), '\mexecute\M', 'transfer_facilitator uses no dynamic SQL');
select matches((select prosrc from pg_proc where oid = 'public.transfer_facilitator(uuid, uuid)'::regprocedure), 'private\.assert_project_owner\(p_project_id\)', 'transfer_facilitator checks ownership via (select auth.uid()) inside the function');
select is(has_function_privilege('anon', 'public.transfer_facilitator(uuid, uuid)', 'EXECUTE'), false, 'anon cannot execute transfer_facilitator');
select is(has_function_privilege('authenticated', 'public.transfer_facilitator(uuid, uuid)', 'EXECUTE'), true, 'authenticated can execute transfer_facilitator');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.transfer_facilitator(uuid, uuid)'::regprocedure), 0, 'PUBLIC cannot execute transfer_facilitator');
select matches((select prosrc from pg_proc where oid = 'private.assert_project_owner(uuid)'::regprocedure), 'owner_id = \(select auth\.uid\(\)\)', 'the owner check compares owner_id to (select auth.uid())');
select is((select prosecdef from pg_proc where oid = 'private.assert_project_owner(uuid)'::regprocedure), true, 'assert_project_owner is security definer');
select is((select proconfig from pg_proc where oid = 'private.assert_project_owner(uuid)'::regprocedure), array['search_path=""']::text[], 'assert_project_owner fixes search_path to empty');

select * from finish();
rollback;
