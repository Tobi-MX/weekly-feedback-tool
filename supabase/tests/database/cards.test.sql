-- pgTAP tests for feedback cards: the cards and card_authors shape, CHECKs,
-- guards and cascades, RLS and grants, the four card RPCs, the collecting
-- stage check, removed members, and leak resistance.
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension and the cards_test helper schema. The seed user is never
-- used as a fixture.
--
-- Fixtures: owner and facilitator A, members B and D, non-member C.
-- Project P is owned by A with B and D joined; project Q is owned by C with A
-- joined (so A has cards in another project), and B and D are never in Q.
-- Project R is A's alone and holds service_role fixtures and cascade cases.
--
-- Cycles: P0 (P, closed after A writes a card), P1 (P, the main cycle),
-- Q1 (Q), and R1/R2 (R).

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(326);

-- ---------------------------------------------------------------------------
-- Test-only helper: runs a statement and returns its error as JSON (code,
-- message, detail, hint), or 'ok'. It is security invoker, so the statement
-- runs as the calling role with the calling session's JWT claims.
-- ---------------------------------------------------------------------------
create schema cards_test;
create function cards_test.err(stmt text)
returns text
language plpgsql
security invoker
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  execute stmt;
  return 'ok';
exception
  when others then
    get stacked diagnostics
      v_state = returned_sqlstate,
      v_message = message_text,
      v_detail = pg_exception_detail,
      v_hint = pg_exception_hint;
    return json_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint)::text;
end;
$$;
grant usage on schema cards_test to anon, authenticated;
grant execute on function cards_test.err(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures.
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-000000000000', '12000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'cards-a@example.com', '{"display_name":"Alice"}'),
  ('00000000-0000-0000-0000-000000000000', '12000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'cards-b@example.com', '{"display_name":"Bob"}'),
  ('00000000-0000-0000-0000-000000000000', '12000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'cards-c@example.com', '{"display_name":"Cara"}'),
  ('00000000-0000-0000-0000-000000000000', '12000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'cards-d@example.com', '{"display_name":"Dan"}');

insert into public.projects (id, name, owner_id)
values
  ('22000000-0000-4000-8000-000000000001', 'Project P', '12000000-0000-4000-8000-000000000001'),
  ('22000000-0000-4000-8000-000000000002', 'Project Q', '12000000-0000-4000-8000-000000000003'),
  ('22000000-0000-4000-8000-000000000003', 'Project R', '12000000-0000-4000-8000-000000000001');

insert into public.project_members (project_id, user_id, role)
values
  ('22000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000002', 'member'),
  ('22000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000004', 'member'),
  ('22000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-000000000001', 'member');

insert into public.feedback_cycles (id, project_id, title, week_start)
values
  ('32000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P earlier', '2026-10-19'),
  ('32000000-0000-4000-8000-000000000003', '22000000-0000-4000-8000-000000000002', 'Q week', '2026-10-26'),
  ('32000000-0000-4000-8000-000000000004', '22000000-0000-4000-8000-000000000003', 'R week', '2026-10-26');

-- ---------------------------------------------------------------------------
-- cards shape.
-- ---------------------------------------------------------------------------
select has_table('public', 'cards', 'cards table exists');
select columns_are('public', 'cards', array['id', 'cycle_id', 'category', 'text', 'is_anonymous', 'created_at', 'updated_at'], 'cards has exactly the seven expected columns');
select col_type_is('public', 'cards', 'id', 'uuid', 'id is uuid');
select col_type_is('public', 'cards', 'cycle_id', 'uuid', 'cycle_id is uuid');
select col_type_is('public', 'cards', 'category', 'text', 'category is text');
select col_type_is('public', 'cards', 'text', 'text', 'text is text');
select col_type_is('public', 'cards', 'is_anonymous', 'boolean', 'is_anonymous is boolean');
select col_type_is('public', 'cards', 'created_at', 'timestamp with time zone', 'created_at is timestamptz');
select col_type_is('public', 'cards', 'updated_at', 'timestamp with time zone', 'updated_at is timestamptz');
select col_is_pk('public', 'cards', 'id', 'id is the primary key');
select col_not_null('public', 'cards', 'cycle_id', 'cycle_id is not null');
select col_not_null('public', 'cards', 'category', 'category is not null');
select col_not_null('public', 'cards', 'text', 'text is not null');
select col_not_null('public', 'cards', 'is_anonymous', 'is_anonymous is not null');
select col_not_null('public', 'cards', 'created_at', 'created_at is not null');
select col_not_null('public', 'cards', 'updated_at', 'updated_at is not null');
select col_hasnt_default('public', 'cards', 'category', 'category has no default');
select col_hasnt_default('public', 'cards', 'text', 'text has no default');
select col_default_is('public', 'cards', 'is_anonymous', 'false', 'is_anonymous defaults to false');
select matches((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.cards'::regclass and a.attname = 'id'), '^gen_random_uuid\(\)$', 'id defaults to gen_random_uuid()');
select matches((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.cards'::regclass and a.attname = 'created_at'), '^now\(\)$', 'created_at defaults to now()');
select matches((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'public.cards'::regclass and a.attname = 'updated_at'), '^now\(\)$', 'updated_at defaults to now()');
select hasnt_column('public', 'cards', 'author_id', 'cards has no author_id column');
select hasnt_column('public', 'cards', 'user_id', 'cards has no user_id column');
select hasnt_column('public', 'cards', 'created_by', 'cards has no created_by column');
select is((select count(*)::int from pg_constraint where conrelid = 'public.cards'::regclass and contype = 'f'), 1, 'cards has exactly one foreign key');
select is((select confrelid::regclass::text from pg_constraint where conrelid = 'public.cards'::regclass and conname = 'cards_cycle_id_fkey'), 'feedback_cycles', 'cards_cycle_id_fkey references public.feedback_cycles');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.cards'::regclass and conname = 'cards_cycle_id_fkey'), 'c', 'cards_cycle_id_fkey is ON DELETE CASCADE');
select fk_ok('public', 'cards', 'cycle_id', 'public', 'feedback_cycles', 'id', 'cards.cycle_id references feedback_cycles.id');
select is(to_regclass('public.cards_cycle_id_idx')::text, 'cards_cycle_id_idx', 'cards_cycle_id_idx exists');
select matches(pg_get_indexdef('public.cards_cycle_id_idx'::regclass), 'ON public\.cards USING btree \(cycle_id\)$', 'cards_cycle_id_idx is on (cycle_id)');

-- ---------------------------------------------------------------------------
-- card_authors shape.
-- ---------------------------------------------------------------------------
select has_table('public', 'card_authors', 'card_authors table exists');
select columns_are('public', 'card_authors', array['card_id', 'author_id'], 'card_authors has exactly card_id and author_id');
select col_type_is('public', 'card_authors', 'card_id', 'uuid', 'card_id is uuid');
select col_type_is('public', 'card_authors', 'author_id', 'uuid', 'author_id is uuid');
select col_is_pk('public', 'card_authors', 'card_id', 'card_id is the primary key');
select col_not_null('public', 'card_authors', 'author_id', 'author_id is not null');
select is((select count(*)::int from pg_attribute where attrelid = 'public.card_authors'::regclass and attnum > 0 and not attisdropped and atttypid in ('timestamptz'::regtype, 'timestamp'::regtype, 'date'::regtype)), 0, 'card_authors has no timestamp columns');
select is((select count(*)::int from pg_constraint where conrelid = 'public.card_authors'::regclass and contype = 'f'), 2, 'card_authors has exactly two foreign keys');
select is((select confrelid::regclass::text from pg_constraint where conrelid = 'public.card_authors'::regclass and conname = 'card_authors_card_id_fkey'), 'cards', 'card_authors_card_id_fkey references public.cards');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.card_authors'::regclass and conname = 'card_authors_card_id_fkey'), 'c', 'card_authors_card_id_fkey is ON DELETE CASCADE');
select is((select confrelid::regclass::text from pg_constraint where conrelid = 'public.card_authors'::regclass and conname = 'card_authors_author_id_fkey'), 'auth.users', 'card_authors_author_id_fkey references auth.users');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.card_authors'::regclass and conname = 'card_authors_author_id_fkey'), 'c', 'card_authors_author_id_fkey is ON DELETE CASCADE');
select is(to_regclass('public.card_authors_author_id_idx')::text, 'card_authors_author_id_idx', 'card_authors_author_id_idx exists');
select matches(pg_get_indexdef('public.card_authors_author_id_idx'::regclass), 'ON public\.card_authors USING btree \(author_id\)$', 'card_authors_author_id_idx is on (author_id)');

-- ---------------------------------------------------------------------------
-- Named CHECKs, as service_role (the only role with a write grant).
-- ---------------------------------------------------------------------------
select is((select contype::text from pg_constraint where conrelid = 'public.cards'::regclass and conname = 'cards_category_check'), 'c', 'the named category CHECK exists');
select is((select contype::text from pg_constraint where conrelid = 'public.cards'::regclass and conname = 'cards_text_check'), 'c', 'the named text CHECK exists');

set local role service_role;
select throws_ok($$ insert into public.cards (cycle_id, category, text) values ('32000000-0000-4000-8000-000000000004', 'Start', 'x') $$, '23514'::char(5), NULL, 'category Start (wrong case) is rejected');
select throws_ok($$ insert into public.cards (cycle_id, category, text) values ('32000000-0000-4000-8000-000000000004', '', 'x') $$, '23514'::char(5), NULL, 'an empty category is rejected');
select throws_ok($$ insert into public.cards (cycle_id, category, text) values ('32000000-0000-4000-8000-000000000004', 'keep', 'x') $$, '23514'::char(5), NULL, 'category keep is rejected');
select lives_ok($$ insert into public.cards (cycle_id, category, text) values ('32000000-0000-4000-8000-000000000004', 'start', 'x'), ('32000000-0000-4000-8000-000000000004', 'stop', 'x'), ('32000000-0000-4000-8000-000000000004', 'continue', 'x') $$, 'start, stop, and continue are accepted');
select throws_ok($$ insert into public.cards (cycle_id, category, text) values ('32000000-0000-4000-8000-000000000004', 'start', '') $$, '23514'::char(5), NULL, 'an empty text is rejected');
select throws_ok($$ insert into public.cards (cycle_id, category, text) values ('32000000-0000-4000-8000-000000000004', 'start', ' x') $$, '23514'::char(5), NULL, 'a text with a leading space is rejected');
select throws_ok($$ insert into public.cards (cycle_id, category, text) values ('32000000-0000-4000-8000-000000000004', 'start', E'x\n') $$, '23514'::char(5), NULL, 'a text with a trailing newline is rejected');
select throws_ok(format('insert into public.cards (cycle_id, category, text) values (%L, %L, %L)', '32000000-0000-4000-8000-000000000004', 'start', repeat('x', 501)), '23514'::char(5), NULL, 'a 501-character text is rejected');
select lives_ok(format('insert into public.cards (cycle_id, category, text) values (%L, %L, %L)', '32000000-0000-4000-8000-000000000004', 'start', repeat('x', 500)), 'a 500-character text is accepted');
select lives_ok(format('insert into public.cards (cycle_id, category, text) values (%L, %L, %L)', '32000000-0000-4000-8000-000000000004', 'start', repeat('é', 500)), 'a text of 500 two-byte characters is accepted');
select lives_ok(format('insert into public.cards (cycle_id, category, text) values (%L, %L, %L)', '32000000-0000-4000-8000-000000000004', 'start', repeat('😀', 500)), 'a text of 500 emoji is accepted');
select throws_ok(format('insert into public.cards (cycle_id, category, text) values (%L, %L, %L)', '32000000-0000-4000-8000-000000000004', 'start', repeat('é', 501)), '23514'::char(5), NULL, 'a text of 501 two-byte characters is rejected');
select lives_ok($$ insert into public.cards (cycle_id, category, text) values ('32000000-0000-4000-8000-000000000004', 'start', E'Line one\nLine two') $$, 'a text with an interior newline is accepted');
reset role;

-- ---------------------------------------------------------------------------
-- updated_at trigger and the cards guard. The fixture card has past
-- timestamps so the change is visible inside this transaction.
-- ---------------------------------------------------------------------------
select trigger_is('public', 'cards', 'cards_set_updated_at', 'private', 'set_updated_at', 'the updated_at trigger reuses private.set_updated_at');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.cards'::regclass and tgname = 'cards_set_updated_at'), 19, 'the updated_at trigger is BEFORE UPDATE FOR EACH ROW');
select trigger_is('public', 'cards', 'cards_guard_update', 'private', 'guard_card_update', 'the cards guard trigger exists');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.cards'::regclass and tgname = 'cards_guard_update'), 19, 'the cards guard is BEFORE UPDATE FOR EACH ROW');

set local role service_role;
insert into public.cards (id, cycle_id, category, text, created_at, updated_at)
values ('42000000-0000-4000-8000-000000000002', '32000000-0000-4000-8000-000000000004', 'stop', 'Old card', '2026-01-05 09:00:00+00', '2026-01-05 09:00:00+00');
select lives_ok($$ update public.cards set text = 'Edited card', is_anonymous = true where id = '42000000-0000-4000-8000-000000000002' $$, 'service_role can edit text and is_anonymous');
select throws_ok($$ update public.cards set id = gen_random_uuid() where id = '42000000-0000-4000-8000-000000000002' $$, 'P0001'::char(5), 'card_immutable_column', 'id cannot change');
select throws_ok($$ update public.cards set cycle_id = '32000000-0000-4000-8000-000000000001' where id = '42000000-0000-4000-8000-000000000002' $$, 'P0001'::char(5), 'card_immutable_column', 'cycle_id cannot change');
select throws_ok($$ update public.cards set category = 'start' where id = '42000000-0000-4000-8000-000000000002' $$, 'P0001'::char(5), 'card_immutable_column', 'category cannot change');
select throws_ok($$ update public.cards set created_at = now() where id = '42000000-0000-4000-8000-000000000002' $$, 'P0001'::char(5), 'card_immutable_column', 'created_at cannot change');
reset role;
select throws_ok($$ update public.cards set category = 'continue' where id = '42000000-0000-4000-8000-000000000002' $$, 'P0001'::char(5), 'card_immutable_column', 'the cards guard also applies to the postgres role');
select is((select updated_at from public.cards where id = '42000000-0000-4000-8000-000000000002'), now(), 'an edit advances updated_at');
select is((select created_at from public.cards where id = '42000000-0000-4000-8000-000000000002'), '2026-01-05 09:00:00+00'::timestamptz, 'an edit leaves created_at unchanged');

-- ---------------------------------------------------------------------------
-- card_authors guard.
-- ---------------------------------------------------------------------------
select trigger_is('public', 'card_authors', 'card_authors_guard_update', 'private', 'guard_card_author_update', 'the card_authors guard trigger exists');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.card_authors'::regclass and tgname = 'card_authors_guard_update'), 19, 'the card_authors guard is BEFORE UPDATE FOR EACH ROW');
set local role service_role;
insert into public.card_authors (card_id, author_id) values ('42000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-000000000001');
select throws_ok($$ update public.card_authors set author_id = '12000000-0000-4000-8000-000000000002' where card_id = '42000000-0000-4000-8000-000000000002' $$, 'P0001'::char(5), 'card_author_immutable', 'service_role cannot reassign authorship');
select throws_ok($$ update public.card_authors set card_id = card_id where card_id = '42000000-0000-4000-8000-000000000002' $$, 'P0001'::char(5), 'card_author_immutable', 'service_role cannot update a card_authors row even without a change');
reset role;
select throws_ok($$ update public.card_authors set author_id = '12000000-0000-4000-8000-000000000003' where card_id = '42000000-0000-4000-8000-000000000002' $$, 'P0001'::char(5), 'card_author_immutable', 'the postgres role cannot reassign authorship');
select is((select author_id from public.card_authors where card_id = '42000000-0000-4000-8000-000000000002'), '12000000-0000-4000-8000-000000000001'::uuid, 'authorship is unchanged after the rejected updates');

-- Private helpers stay unreachable from client roles.
select is(has_function_privilege('authenticated', 'private.guard_card_update()', 'EXECUTE'), false, 'authenticated cannot execute guard_card_update');
select is(has_function_privilege('anon', 'private.guard_card_update()', 'EXECUTE'), false, 'anon cannot execute guard_card_update');
select is(has_function_privilege('authenticated', 'private.guard_card_author_update()', 'EXECUTE'), false, 'authenticated cannot execute guard_card_author_update');
select is(has_function_privilege('anon', 'private.guard_card_author_update()', 'EXECUTE'), false, 'anon cannot execute guard_card_author_update');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid in ('private.guard_card_update()'::regprocedure, 'private.guard_card_author_update()'::regprocedure)), 0, 'PUBLIC cannot execute either guard');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'EXECUTE')), 2, 'authenticated can still execute exactly two private functions');

-- ---------------------------------------------------------------------------
-- RLS, policies, grants, and Realtime.
-- ---------------------------------------------------------------------------
select is((select relrowsecurity from pg_class where oid = 'public.cards'::regclass), true, 'RLS is enabled on cards');
select is((select relrowsecurity from pg_class where oid = 'public.card_authors'::regclass), true, 'RLS is enabled on card_authors');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'cards'), 0, 'cards has no policy');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'card_authors'), 0, 'card_authors has no policy');

select is((select array_agg(p order by p) from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p where has_table_privilege('anon', 'public.cards', p)), null, 'anon has no table privilege on cards');
select is((select array_agg(p order by p) from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p where has_table_privilege('authenticated', 'public.cards', p)), null, 'authenticated has no table privilege on cards');
select is((select array_agg(p order by p) from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p where has_table_privilege('anon', 'public.card_authors', p)), null, 'anon has no table privilege on card_authors');
select is((select array_agg(p order by p) from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p where has_table_privilege('authenticated', 'public.card_authors', p)), null, 'authenticated has no table privilege on card_authors');
select is((select array_agg(r || ':' || t || ':' || p) from unnest(array['anon', 'authenticated']) r cross join unnest(array['public.cards', 'public.card_authors']) t cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p where has_any_column_privilege(r, t, p)), null, 'anon and authenticated have no column privilege on either table');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_class c left join lateral aclexplode(c.relacl) a on true where c.oid in ('public.cards'::regclass, 'public.card_authors'::regclass)), 0, 'PUBLIC has no table privilege on either table');
select is((select count(*)::int from pg_attribute att cross join lateral aclexplode(att.attacl) a where att.attrelid in ('public.cards'::regclass, 'public.card_authors'::regclass) and att.attnum > 0 and not att.attisdropped), 0, 'no role holds a column-level privilege on either table');
select is((select count(*)::int from information_schema.column_privileges where table_schema = 'public' and table_name in ('cards', 'card_authors') and grantee in ('anon', 'authenticated', 'PUBLIC')), 0, 'information_schema.column_privileges has no row for anon, authenticated, or PUBLIC');
select is((select array_agg(p order by p) from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p where has_table_privilege('service_role', 'public.cards', p)), array['DELETE', 'INSERT', 'SELECT', 'UPDATE'], 'service_role has SELECT, INSERT, UPDATE, and DELETE on cards');
select is((select array_agg(p order by p) from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p where has_table_privilege('service_role', 'public.card_authors', p)), array['DELETE', 'INSERT', 'SELECT', 'UPDATE'], 'service_role has SELECT, INSERT, UPDATE, and DELETE on card_authors');

select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('cards', 'card_authors')), 0, 'neither table is in the supabase_realtime publication');

-- Only the four RPCs and #13's aggregate get_cycle_status read card_authors.
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc ~ 'card_authors'), array['create_card', 'delete_card', 'get_cycle_status', 'get_my_cards', 'update_card'], 'only the four card RPCs and get_cycle_status in public mention card_authors');
select is((select count(*)::int from pg_depend d join pg_rewrite r on r.oid = d.objid where d.classid = 'pg_rewrite'::regclass and d.refobjid = 'public.card_authors'::regclass), 0, 'no view reads card_authors');

-- ---------------------------------------------------------------------------
-- RPC signatures and hardening.
-- ---------------------------------------------------------------------------
select is(pg_get_function_identity_arguments('public.create_card(uuid, text, text, boolean)'::regprocedure), 'p_cycle_id uuid, p_category text, p_text text, p_is_anonymous boolean', 'create_card takes the cycle, category, text, and anonymity');
select is(pg_get_function_arguments('public.create_card(uuid, text, text, boolean)'::regprocedure), 'p_cycle_id uuid, p_category text, p_text text, p_is_anonymous boolean DEFAULT false', 'p_is_anonymous defaults to false');
select is(pg_get_function_result('public.create_card(uuid, text, text, boolean)'::regprocedure), 'TABLE(id uuid, cycle_id uuid, category text, text text, is_anonymous boolean, created_at timestamp with time zone, updated_at timestamp with time zone)', 'create_card returns exactly the seven card columns');
select is(pg_get_function_identity_arguments('public.update_card(uuid, text, boolean)'::regprocedure), 'p_card_id uuid, p_text text, p_is_anonymous boolean', 'update_card takes no category or cycle parameter');
select is(pg_get_function_result('public.update_card(uuid, text, boolean)'::regprocedure), 'TABLE(id uuid, cycle_id uuid, category text, text text, is_anonymous boolean, created_at timestamp with time zone, updated_at timestamp with time zone)', 'update_card returns the same seven columns as create_card');
select is(pg_get_function_identity_arguments('public.delete_card(uuid)'::regprocedure), 'p_card_id uuid', 'delete_card takes only the card id');
select is(pg_get_function_result('public.delete_card(uuid)'::regprocedure), 'void', 'delete_card returns void');
select is(pg_get_function_identity_arguments('public.get_my_cards(uuid)'::regprocedure), 'p_cycle_id uuid', 'get_my_cards takes only the cycle id');
select is(pg_get_function_result('public.get_my_cards(uuid)'::regprocedure), 'TABLE(id uuid, category text, text text, is_anonymous boolean, created_at timestamp with time zone, updated_at timestamp with time zone)', 'get_my_cards returns exactly the six card columns');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_card', 'update_card', 'delete_card', 'get_my_cards') and pg_get_function_result(p.oid) ~* '(author_id|user_id|email|display_name)'), 0, 'no card RPC result contains author_id, user_id, email, or display_name');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_card', 'update_card', 'delete_card', 'get_my_cards') and pg_get_function_identity_arguments(p.oid) ~* 'user|author'), 0, 'no card RPC takes a user id parameter');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_card', 'update_card', 'delete_card', 'get_my_cards')), 4, 'each card RPC has exactly one overload');

select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_card', 'update_card', 'delete_card', 'get_my_cards') and p.prosecdef), array['create_card', 'delete_card', 'get_my_cards', 'update_card'], 'all four card RPCs are security definer');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_card', 'update_card', 'delete_card', 'get_my_cards') and p.proconfig = array['search_path=""']::text[]), array['create_card', 'delete_card', 'get_my_cards', 'update_card'], 'all four card RPCs fix search_path to empty');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_card', 'update_card', 'delete_card', 'get_my_cards') and p.prosrc ~ '\mexecute\M'), null, 'no card RPC uses dynamic SQL');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_card', 'update_card', 'delete_card', 'get_my_cards') and p.prosrc ~ '\(select auth\.uid\(\)\) is null'), array['create_card', 'delete_card', 'get_my_cards', 'update_card'], 'all four card RPCs check (select auth.uid()) inside the function');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_card', 'update_card', 'delete_card', 'get_my_cards') and p.prosrc ~ 'private\.is_project_member\(cycle_project\)'), array['create_card', 'delete_card', 'get_my_cards', 'update_card'], 'all four card RPCs use private.is_project_member');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_card', 'update_card', 'delete_card', 'get_my_cards') and p.prosrc ~ 'project_members'), null, 'no card RPC adds a membership query of its own');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_card', 'update_card', 'delete_card', 'get_my_cards') and p.prosrc ~* 'raise\s+(notice|log|info|debug|warning)'), null, 'no card RPC raises a notice, log, info, debug, or warning');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_card', 'update_card', 'delete_card', 'get_my_cards') and p.prosrc ~* 'is_project_facilitator'), null, 'no card RPC applies a facilitator check');

select is(has_function_privilege('anon', 'public.create_card(uuid, text, text, boolean)', 'EXECUTE'), false, 'anon cannot execute create_card');
select is(has_function_privilege('authenticated', 'public.create_card(uuid, text, text, boolean)', 'EXECUTE'), true, 'authenticated can execute create_card');
select is(has_function_privilege('anon', 'public.update_card(uuid, text, boolean)', 'EXECUTE'), false, 'anon cannot execute update_card');
select is(has_function_privilege('authenticated', 'public.update_card(uuid, text, boolean)', 'EXECUTE'), true, 'authenticated can execute update_card');
select is(has_function_privilege('anon', 'public.delete_card(uuid)', 'EXECUTE'), false, 'anon cannot execute delete_card');
select is(has_function_privilege('authenticated', 'public.delete_card(uuid)', 'EXECUTE'), true, 'authenticated can execute delete_card');
select is(has_function_privilege('anon', 'public.get_my_cards(uuid)', 'EXECUTE'), false, 'anon cannot execute get_my_cards');
select is(has_function_privilege('authenticated', 'public.get_my_cards(uuid)', 'EXECUTE'), true, 'authenticated can execute get_my_cards');
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace left join lateral aclexplode(p.proacl) a on true where n.nspname = 'public' and p.proname in ('create_card', 'update_card', 'delete_card', 'get_my_cards')), 0, 'PUBLIC cannot execute any card RPC');

-- Concurrency: each write RPC locks the cycle row FOR SHARE before the status check.
select matches((select prosrc from pg_proc where oid = 'public.create_card(uuid, text, text, boolean)'::regprocedure), 'where fc\.id = p_cycle_id\s+for share', 'create_card locks the cycle row for share');
select ok((select strpos(prosrc, 'for share') < strpos(prosrc, 'cycle_not_collecting') from pg_proc where oid = 'public.create_card(uuid, text, text, boolean)'::regprocedure), 'create_card takes the lock before the status check');
select matches((select prosrc from pg_proc where oid = 'public.update_card(uuid, text, boolean)'::regprocedure), 'where fc\.id = card_cycle\s+for share', 'update_card locks the cycle row for share');
select ok((select strpos(prosrc, 'for share') < strpos(prosrc, 'cycle_not_collecting') from pg_proc where oid = 'public.update_card(uuid, text, boolean)'::regprocedure), 'update_card takes the lock before the status check');
select matches((select prosrc from pg_proc where oid = 'public.delete_card(uuid)'::regprocedure), 'where fc\.id = card_cycle\s+for share', 'delete_card locks the cycle row for share');
select ok((select strpos(prosrc, 'for share') < strpos(prosrc, 'cycle_not_collecting') from pg_proc where oid = 'public.delete_card(uuid)'::regprocedure), 'delete_card takes the lock before the status check');

-- Every message is a stable code, and every raise has a fixed errcode and a
-- coded message with no format arguments, detail, or hint.
select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral regexp_matches(p.prosrc, 'message\s*=\s*''([^'']*)''', 'g') as m(msg)
    where (n.nspname, p.proname) in (('public', 'create_card'), ('public', 'update_card'), ('public', 'delete_card'), ('public', 'get_my_cards'), ('private', 'guard_card_update'), ('private', 'guard_card_author_update'))
      and m.msg[1] not in ('not_project_member', 'cycle_not_collecting', 'invalid_card_category', 'invalid_card_text', 'invalid_card_anonymity', 'card_not_found', 'card_immutable_column', 'card_author_immutable')),
  0,
  'no card RPC or guard raises a message outside the stable codes'
);
select is(
  (select sum((select count(*) from regexp_matches(p.prosrc, '\mraise\M', 'gi')))::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname, p.proname) in (('public', 'create_card'), ('public', 'update_card'), ('public', 'delete_card'), ('public', 'get_my_cards'), ('private', 'guard_card_update'), ('private', 'guard_card_author_update'))),
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''[0-9A-Z]{5}'', message = ''[a-z_]+'';', 'g') as m
    where (n.nspname, p.proname) in (('public', 'create_card'), ('public', 'update_card'), ('public', 'delete_card'), ('public', 'get_my_cards'), ('private', 'guard_card_update'), ('private', 'guard_card_author_update'))),
  'every raise uses a fixed errcode and only a coded message'
);

-- ---------------------------------------------------------------------------
-- Cycle P0: A writes a card, then P0 is closed so P1 can open.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000001', 'start', 'A in P0') $$, 'A writes a card in P0');
reset role;
update public.feedback_cycles set status = 'closed', closed_at = now() where id = '32000000-0000-4000-8000-000000000001';
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('32000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000001', 'P week', '2026-10-26');
-- A card of A's with past timestamps, written as postgres, for the ordering
-- and no-op update cases.
insert into public.cards (id, cycle_id, category, text, created_at, updated_at)
values ('42000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000002', 'continue', 'A old card', '2026-01-05 09:00:00+00', '2026-01-05 09:00:00+00');
insert into public.card_authors (card_id, author_id)
values ('42000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------
-- create_card: checks run in order and leave nothing behind.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'x') $$, '42501'::char(5), 'not_project_member', 'create_card with a null auth.uid() raises not_project_member');
select throws_ok($$ select * from public.update_card('42000000-0000-4000-8000-000000000001', 'x', false) $$, '42501'::char(5), 'not_project_member', 'update_card with a null auth.uid() raises not_project_member');
select throws_ok($$ select public.delete_card('42000000-0000-4000-8000-000000000001') $$, '42501'::char(5), 'not_project_member', 'delete_card with a null auth.uid() raises not_project_member');
select throws_ok($$ select * from public.get_my_cards('32000000-0000-4000-8000-000000000002') $$, '42501'::char(5), 'not_project_member', 'get_my_cards with a null auth.uid() raises not_project_member');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'x') $$, '42501'::char(5), 'not_project_member', 'non-member C gets not_project_member from create_card');
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'Start', '', null) $$, '42501'::char(5), 'not_project_member', 'non-member C with invalid input still gets not_project_member');
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000001', 'start', 'x') $$, '42501'::char(5), 'not_project_member', 'non-member C on a closed cycle still gets not_project_member');
select throws_ok($$ select * from public.get_my_cards('32000000-0000-4000-8000-000000000002') $$, '42501'::char(5), 'not_project_member', 'non-member C gets not_project_member from get_my_cards');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000099', 'start', 'x') $$, '42501'::char(5), 'not_project_member', 'an unknown cycle id gets not_project_member');
select throws_ok($$ select * from public.create_card(null, 'start', 'x') $$, '42501'::char(5), 'not_project_member', 'a null cycle id gets not_project_member');
select throws_ok($$ select * from public.get_my_cards('32000000-0000-4000-8000-000000000099') $$, '42501'::char(5), 'not_project_member', 'get_my_cards on an unknown cycle gets not_project_member');
select throws_ok($$ select * from public.get_my_cards(null) $$, '42501'::char(5), 'not_project_member', 'get_my_cards on a null cycle gets not_project_member');
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000001', 'Start', '', null) $$, 'P0001'::char(5), 'cycle_not_collecting', 'the cycle status is checked before the input');
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', null, 'x') $$, 'P0001'::char(5), 'invalid_card_category', 'a null category is rejected');
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'Start', 'x') $$, 'P0001'::char(5), 'invalid_card_category', 'category Start is rejected');
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'keep', 'x') $$, 'P0001'::char(5), 'invalid_card_category', 'category keep is rejected');
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', ' start', 'x') $$, 'P0001'::char(5), 'invalid_card_category', 'a padded category is rejected');
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'Start', '', null) $$, 'P0001'::char(5), 'invalid_card_category', 'the category is checked before the text');
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', null) $$, 'P0001'::char(5), 'invalid_card_text', 'a null text is rejected');
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', '') $$, 'P0001'::char(5), 'invalid_card_text', 'an empty text is rejected');
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', E' \t\n\r ') $$, 'P0001'::char(5), 'invalid_card_text', 'a whitespace-only text is rejected');
select throws_ok(format('select * from public.create_card(%L, %L, %L)', '32000000-0000-4000-8000-000000000002', 'start', repeat('x', 501)), 'P0001'::char(5), 'invalid_card_text', 'a 501-character text is rejected');
select throws_ok(format('select * from public.create_card(%L, %L, %L)', '32000000-0000-4000-8000-000000000002', 'start', repeat('é', 501)), 'P0001'::char(5), 'invalid_card_text', 'a text of 501 two-byte characters is rejected');
select throws_ok(format('select * from public.create_card(%L, %L, %L)', '32000000-0000-4000-8000-000000000002', 'start', '  ' || repeat('x', 501) || E'\n'), 'P0001'::char(5), 'invalid_card_text', 'a text over 500 characters after trimming is rejected');
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', '', null) $$, 'P0001'::char(5), 'invalid_card_text', 'the text is checked before the anonymity');
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'x', null) $$, 'P0001'::char(5), 'invalid_card_anonymity', 'a null is_anonymous is rejected');
reset role;
select is((select count(*)::int from public.cards where cycle_id = '32000000-0000-4000-8000-000000000002'), 1, 'no rejected create_card left a card in P1');
select is((select count(*)::int from public.card_authors ca join public.cards c on c.id = ca.card_id where c.cycle_id = '32000000-0000-4000-8000-000000000002'), 1, 'no rejected create_card left a card_authors row in P1');

-- Successful creates.
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select results_eq(
  $$ select cycle_id, category, text, is_anonymous, created_at = updated_at from public.create_card('32000000-0000-4000-8000-000000000002', 'start', E'  \tKeep standups short\n\r') $$,
  $$ values ('32000000-0000-4000-8000-000000000002'::uuid, 'start'::text, 'Keep standups short'::text, false, true) $$,
  'B creates a card with three arguments: trimmed text, attributed by default'
);
select results_eq(
  $$ select text, is_anonymous from public.create_card('32000000-0000-4000-8000-000000000002', 'stop', E'Line one\nLine two', true) $$,
  $$ values (E'Line one\nLine two'::text, true) $$,
  'B creates an anonymous card and the interior newline is kept'
);
select lives_ok(format('select * from public.create_card(%L, %L, %L)', '32000000-0000-4000-8000-000000000002', 'continue', repeat('x', 500)), 'a 500-character text is accepted');
select lives_ok(format('select * from public.create_card(%L, %L, %L)', '32000000-0000-4000-8000-000000000002', 'continue', '  ' || repeat('é', 500) || E'\n'), 'a padded text of 500 two-byte characters is accepted');
select lives_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'Same text') $$, 'B creates a card');
select lives_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'Same text') $$, 'B creates a second card with identical text in the same category');
select lives_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'stop', 'Anonymous to edit', true) $$, 'B creates an anonymous card to edit');
reset role;
select is((select count(*)::int from public.cards where cycle_id = '32000000-0000-4000-8000-000000000002' and text = 'Same text'), 2, 'both identical-text cards are stored');
select is((select count(*)::int from public.cards c join public.card_authors ca on ca.card_id = c.id where c.cycle_id = '32000000-0000-4000-8000-000000000002' and ca.author_id = '12000000-0000-4000-8000-000000000002'), 7, 'B has seven cards in P1, all owned by B');
select is((select count(*)::int from public.cards where cycle_id = '32000000-0000-4000-8000-000000000002' and created_at = now() and updated_at = now()), 7, 'timestamps are set by the database');
select is((select count(*)::int from public.cards where cycle_id = '32000000-0000-4000-8000-000000000002' and uuid_extract_version(id) = 4), 8, 'card ids are random v4 UUIDs');

do $$ begin
  perform set_config('test.b_attr', (select c.id::text from public.cards c where c.cycle_id = '32000000-0000-4000-8000-000000000002' and c.text = 'Keep standups short'), true);
  perform set_config('test.b_anon', (select c.id::text from public.cards c where c.cycle_id = '32000000-0000-4000-8000-000000000002' and c.text = 'Anonymous to edit'), true);
  perform set_config('test.b_multi', (select c.id::text from public.cards c where c.cycle_id = '32000000-0000-4000-8000-000000000002' and c.text = E'Line one\nLine two'), true);
end $$;

-- The facilitator and owner A, member D, and C (in Q) all write cards.
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'A attributed') $$, 'facilitator and owner A creates an attributed card');
select lives_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'stop', 'A anonymous', true) $$, 'A creates an anonymous card');
select lives_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000003', 'start', 'A in Q') $$, 'A creates a card in project Q, where A is a member');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000004","role":"authenticated"}';
select lives_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'continue', 'D card') $$, 'member D creates a card');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000003","role":"authenticated"}';
select lives_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000003', 'stop', 'C in Q') $$, 'C creates a card in their own project Q');
reset role;

do $$ begin
  perform set_config('test.d_card', (select c.id::text from public.cards c where c.text = 'D card'), true);
  perform set_config('test.b_ids', (select string_agg(c.id::text, ',' order by c.created_at, c.id) from public.cards c join public.card_authors ca on ca.card_id = c.id where c.cycle_id = '32000000-0000-4000-8000-000000000002' and ca.author_id = '12000000-0000-4000-8000-000000000002'), true);
  perform set_config('test.a_ids', (select string_agg(c.id::text, ',' order by c.created_at, c.id) from public.cards c join public.card_authors ca on ca.card_id = c.id where c.cycle_id = '32000000-0000-4000-8000-000000000002' and ca.author_id = '12000000-0000-4000-8000-000000000001'), true);
end $$;

select is((select author_id from public.card_authors where card_id = current_setting('test.d_card')::uuid), '12000000-0000-4000-8000-000000000004'::uuid, 'create_card records the caller as author');
select is((select count(*)::int from public.cards c where c.cycle_id in ('32000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000002', '32000000-0000-4000-8000-000000000003') and (select count(*) from public.card_authors ca where ca.card_id = c.id) <> 1), 0, 'after create, every card in P0, P1, and Q1 has exactly one card_authors row');

-- ---------------------------------------------------------------------------
-- get_my_cards: each caller gets only their own cards.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select string_agg(g.id::text, ',') from public.get_my_cards('32000000-0000-4000-8000-000000000002') g), current_setting('test.b_ids'), 'B gets exactly their own P1 cards, ordered by created_at then id');
select is((select count(*)::int from public.get_my_cards('32000000-0000-4000-8000-000000000002') g where g.is_anonymous), 2, 'B gets their anonymous cards too');
select is_empty($$ select * from public.get_my_cards('32000000-0000-4000-8000-000000000001') $$, 'B, with no cards in P0, gets zero rows');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select string_agg(g.id::text, ',') from public.get_my_cards('32000000-0000-4000-8000-000000000002') g), current_setting('test.a_ids'), 'facilitator A gets exactly their own P1 cards');
select is((select g.id from public.get_my_cards('32000000-0000-4000-8000-000000000002') g limit 1), '42000000-0000-4000-8000-000000000001'::uuid, 'the oldest card comes first');
select is((select count(*)::int from public.get_my_cards('32000000-0000-4000-8000-000000000002') g where g.id = any(string_to_array(current_setting('test.b_ids'), ',')::uuid[]) or g.id = current_setting('test.d_card')::uuid), 0, 'the facilitator result has none of B''s or D''s cards');
select is((select count(*)::int from public.get_my_cards('32000000-0000-4000-8000-000000000002') g where g.text in ('A in P0', 'A in Q')), 0, 'A''s P1 result has no card from another cycle or another project');
select results_eq($$ select text, is_anonymous from public.get_my_cards('32000000-0000-4000-8000-000000000001') $$, $$ values ('A in P0'::text, false) $$, 'A still reads their card in the closed cycle P0');
select results_eq($$ select text from public.get_my_cards('32000000-0000-4000-8000-000000000003') $$, $$ values ('A in Q'::text) $$, 'A gets only their own card in Q1');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000003","role":"authenticated"}';
select results_eq($$ select text from public.get_my_cards('32000000-0000-4000-8000-000000000003') $$, $$ values ('C in Q'::text) $$, 'facilitator C gets only their own card in Q1, not A''s');
reset role;

-- ---------------------------------------------------------------------------
-- update_card.
-- ---------------------------------------------------------------------------
do $$ begin perform set_config('test.b_attr_updated', (select updated_at::text from public.cards where id = current_setting('test.b_attr')::uuid), true); end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$ select * from public.update_card(null, 'x', false) $$, 'P0001'::char(5), 'card_not_found', 'a null card id gets card_not_found');
select throws_ok($$ select * from public.update_card('42000000-0000-4000-8000-000000000099', 'x', false) $$, 'P0001'::char(5), 'card_not_found', 'an unknown card id gets card_not_found');
select throws_ok($$ select * from public.update_card('42000000-0000-4000-8000-000000000001', 'x', false) $$, 'P0001'::char(5), 'card_not_found', 'B gets card_not_found on A''s card');
select throws_ok(format('select * from public.update_card(%L, %L, false)', current_setting('test.b_attr'), ''), 'P0001'::char(5), 'invalid_card_text', 'an empty text is rejected');
select throws_ok(format('select * from public.update_card(%L, %L, false)', current_setting('test.b_attr'), E' \t\n\r'), 'P0001'::char(5), 'invalid_card_text', 'a whitespace-only text is rejected');
select throws_ok(format('select * from public.update_card(%L, %L, false)', current_setting('test.b_attr'), repeat('x', 501)), 'P0001'::char(5), 'invalid_card_text', 'a 501-character text is rejected');
select throws_ok(format('select * from public.update_card(%L, null, null)', current_setting('test.b_attr')), 'P0001'::char(5), 'invalid_card_text', 'the text is checked before the anonymity');
select throws_ok(format('select * from public.update_card(%L, %L, null)', current_setting('test.b_attr'), 'Fine'), 'P0001'::char(5), 'invalid_card_anonymity', 'a null is_anonymous is rejected');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(format('select * from public.update_card(%L, %L, true)', current_setting('test.b_attr'), 'Taken'), 'P0001'::char(5), 'card_not_found', 'facilitator and owner A gets card_not_found on B''s attributed card');
select throws_ok(format('select * from public.update_card(%L, %L, false)', current_setting('test.b_anon'), 'Taken'), 'P0001'::char(5), 'card_not_found', 'A gets card_not_found on B''s anonymous card');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok(format('select * from public.update_card(%L, %L, false)', current_setting('test.b_attr'), 'Taken'), 'P0001'::char(5), 'card_not_found', 'member D gets card_not_found on B''s card');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(format('select * from public.update_card(%L, %L, false)', current_setting('test.b_attr'), 'Taken'), 'P0001'::char(5), 'card_not_found', 'non-member C gets card_not_found on B''s card');
reset role;
select results_eq(
  format('select text, is_anonymous, updated_at from public.cards where id = %L', current_setting('test.b_attr')),
  format('values (%L::text, false, %L::timestamptz)', 'Keep standups short', current_setting('test.b_attr_updated')),
  'B''s card is unchanged after every rejected update'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select results_eq(
  format('select id, cycle_id, category, text, is_anonymous from public.update_card(%L, %L, true)', current_setting('test.b_attr'), E'  Keep standups to 15 minutes\n'),
  format('values (%L::uuid, %L::uuid, %L::text, %L::text, true)', current_setting('test.b_attr'), '32000000-0000-4000-8000-000000000002', 'start', 'Keep standups to 15 minutes'),
  'B edits the text (trimmed) and switches attributed to anonymous'
);
select results_eq(
  format('select text, is_anonymous from public.update_card(%L, %L, false)', current_setting('test.b_attr'), 'Keep standups to 15 minutes'),
  $$ values ('Keep standups to 15 minutes'::text, false) $$,
  'B switches anonymous back to attributed'
);
select results_eq(
  format('select text, is_anonymous from public.update_card(%L, %L, true)', current_setting('test.b_anon'), 'Still anonymous'),
  $$ values ('Still anonymous'::text, true) $$,
  'B edits an anonymous card and keeps it anonymous'
);
reset role;
select is((select category from public.cards where id = current_setting('test.b_attr')::uuid), 'start', 'update_card leaves the category unchanged');

-- No-op updates on A's past-timestamp card keep updated_at.
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated"}';
select results_eq(
  $$ select text, is_anonymous, updated_at from public.update_card('42000000-0000-4000-8000-000000000001', E' A old card\t', false) $$,
  $$ values ('A old card'::text, false, '2026-01-05 09:00:00+00'::timestamptz) $$,
  'an update that changes nothing returns the current row'
);
reset role;
select is((select updated_at from public.cards where id = '42000000-0000-4000-8000-000000000001'), '2026-01-05 09:00:00+00'::timestamptz, 'a no-op update keeps updated_at');
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated"}';
select results_eq(
  $$ select is_anonymous, updated_at, created_at from public.update_card('42000000-0000-4000-8000-000000000001', 'A old card', true) $$,
  $$ values (true, now(), '2026-01-05 09:00:00+00'::timestamptz) $$,
  'changing only is_anonymous advances updated_at and keeps created_at'
);
reset role;
select is((select count(*)::int from public.cards c where c.cycle_id = '32000000-0000-4000-8000-000000000002' and (select count(*) from public.card_authors ca where ca.card_id = c.id) <> 1), 0, 'after update, every P1 card still has exactly one card_authors row');

-- ---------------------------------------------------------------------------
-- delete_card.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(format('select public.delete_card(%L)', current_setting('test.b_multi')), 'P0001'::char(5), 'card_not_found', 'facilitator and owner A gets card_not_found deleting B''s card');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok(format('select public.delete_card(%L)', current_setting('test.b_multi')), 'P0001'::char(5), 'card_not_found', 'member D gets card_not_found deleting B''s card');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(format('select public.delete_card(%L)', current_setting('test.b_multi')), 'P0001'::char(5), 'card_not_found', 'non-member C gets card_not_found deleting B''s card');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$ select public.delete_card(null) $$, 'P0001'::char(5), 'card_not_found', 'deleting a null card id gets card_not_found');
select throws_ok($$ select public.delete_card('42000000-0000-4000-8000-000000000099') $$, 'P0001'::char(5), 'card_not_found', 'deleting an unknown card id gets card_not_found');
reset role;
select is((select count(*)::int from public.cards where id = current_setting('test.b_multi')::uuid), 1, 'B''s card survives every rejected delete');

set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select public.delete_card(current_setting('test.b_multi')::uuid)::text), '', 'B deletes their own card and gets nothing back');
select throws_ok(format('select public.delete_card(%L)', current_setting('test.b_multi')), 'P0001'::char(5), 'card_not_found', 'deleting the same card again gets card_not_found');
select is((select count(*)::int from public.get_my_cards('32000000-0000-4000-8000-000000000002') g where g.id = current_setting('test.b_multi')::uuid), 0, 'the deleted card is gone from get_my_cards');
reset role;
select is((select count(*)::int from public.cards where id = current_setting('test.b_multi')::uuid), 0, 'the card row is deleted');
select is((select count(*)::int from public.card_authors where card_id = current_setting('test.b_multi')::uuid), 0, 'its card_authors row goes with it');
select is((select count(*)::int from public.cards c where c.cycle_id = '32000000-0000-4000-8000-000000000002' and (select count(*) from public.card_authors ca where ca.card_id = c.id) <> 1), 0, 'after delete, every P1 card still has exactly one card_authors row');

-- ---------------------------------------------------------------------------
-- Leak resistance: a card someone else wrote looks exactly like a card that
-- does not exist, and no error carries a detail, a hint, or an id.
-- ---------------------------------------------------------------------------
do $$ begin perform set_config('test.not_found', json_build_object('code', 'P0001', 'message', 'card_not_found', 'detail', '', 'hint', '')::text, true); end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(cards_test.err(format('select * from public.update_card(%L, %L, false)', gen_random_uuid(), 'x')), current_setting('test.not_found'), 'update_card on an unknown id: P0001 card_not_found, no detail, no hint');
select is(cards_test.err(format('select * from public.update_card(%L, %L, false)', current_setting('test.b_attr'), 'x')), cards_test.err(format('select * from public.update_card(%L, %L, false)', gen_random_uuid(), 'x')), 'facilitator and owner A: update_card on B''s attributed card matches an unknown id');
select is(cards_test.err(format('select * from public.update_card(%L, %L, false)', current_setting('test.b_anon'), 'x')), current_setting('test.not_found'), 'facilitator and owner A: update_card on B''s anonymous card matches an unknown id');
select is(cards_test.err(format('select public.delete_card(%L)', current_setting('test.b_attr'))), cards_test.err(format('select public.delete_card(%L)', gen_random_uuid())), 'facilitator and owner A: delete_card on B''s attributed card matches an unknown id');
select is(cards_test.err(format('select public.delete_card(%L)', current_setting('test.b_anon'))), current_setting('test.not_found'), 'facilitator and owner A: delete_card on B''s anonymous card matches an unknown id');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000004","role":"authenticated"}';
select is(cards_test.err(format('select * from public.update_card(%L, %L, false)', current_setting('test.b_attr'), 'x')), current_setting('test.not_found'), 'member D: update_card on B''s attributed card matches an unknown id');
select is(cards_test.err(format('select * from public.update_card(%L, %L, false)', current_setting('test.b_anon'), 'x')), current_setting('test.not_found'), 'member D: update_card on B''s anonymous card matches an unknown id');
select is(cards_test.err(format('select public.delete_card(%L)', current_setting('test.b_attr'))), current_setting('test.not_found'), 'member D: delete_card on B''s attributed card matches an unknown id');
select is(cards_test.err(format('select public.delete_card(%L)', current_setting('test.b_anon'))), current_setting('test.not_found'), 'member D: delete_card on B''s anonymous card matches an unknown id');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(cards_test.err(format('select * from public.update_card(%L, %L, false)', current_setting('test.b_attr'), 'x')), current_setting('test.not_found'), 'non-member C: update_card on B''s card matches an unknown id');
select is(cards_test.err(format('select public.delete_card(%L)', current_setting('test.b_anon'))), current_setting('test.not_found'), 'non-member C: delete_card on B''s card matches an unknown id');
select is(cards_test.err($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'x') $$), json_build_object('code', '42501', 'message', 'not_project_member', 'detail', '', 'hint', '')::text, 'not_project_member carries no detail or hint');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(cards_test.err($$ select * from public.create_card('32000000-0000-4000-8000-000000000001', 'start', 'secret text') $$), json_build_object('code', 'P0001', 'message', 'cycle_not_collecting', 'detail', '', 'hint', '')::text, 'cycle_not_collecting carries no detail or hint');
select is(cards_test.err($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'Start', 'secret text') $$), json_build_object('code', 'P0001', 'message', 'invalid_card_category', 'detail', '', 'hint', '')::text, 'invalid_card_category carries no detail or hint');
select is(cards_test.err(format('select * from public.create_card(%L, %L, %L)', '32000000-0000-4000-8000-000000000002', 'start', repeat('secret ', 80))), json_build_object('code', 'P0001', 'message', 'invalid_card_text', 'detail', '', 'hint', '')::text, 'invalid_card_text carries no detail or hint');
select is(cards_test.err($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'secret text', null) $$), json_build_object('code', 'P0001', 'message', 'invalid_card_anonymity', 'detail', '', 'hint', '')::text, 'invalid_card_anonymity carries no detail or hint');
reset role;

-- ---------------------------------------------------------------------------
-- Direct table access fails for every client role, the author included.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ select * from public.cards $$, '42501'::char(5), NULL, 'facilitator and owner A cannot select cards');
select throws_ok($$ insert into public.cards (cycle_id, category, text) values ('32000000-0000-4000-8000-000000000002', 'start', 'Direct') $$, '42501'::char(5), NULL, 'A cannot insert cards');
select throws_ok(format('update public.cards set text = %L where id = %L', 'Direct', current_setting('test.b_attr')), '42501'::char(5), NULL, 'A cannot update cards');
select throws_ok(format('delete from public.cards where id = %L', current_setting('test.b_attr')), '42501'::char(5), NULL, 'A cannot delete cards');
select throws_ok($$ select * from public.card_authors $$, '42501'::char(5), NULL, 'A cannot select card_authors');
select throws_ok(format('insert into public.card_authors (card_id, author_id) values (%L, %L)', current_setting('test.b_multi'), '12000000-0000-4000-8000-000000000001'), '42501'::char(5), NULL, 'A cannot insert card_authors');
select throws_ok(format('update public.card_authors set author_id = %L where card_id = %L', '12000000-0000-4000-8000-000000000001', current_setting('test.b_attr')), '42501'::char(5), NULL, 'A cannot update card_authors');
select throws_ok(format('delete from public.card_authors where card_id = %L', current_setting('test.b_attr')), '42501'::char(5), NULL, 'A cannot delete card_authors');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(format('select * from public.cards where id = %L', current_setting('test.b_attr')), '42501'::char(5), NULL, 'author B cannot select their own card');
select throws_ok($$ insert into public.cards (cycle_id, category, text) values ('32000000-0000-4000-8000-000000000002', 'start', 'Direct') $$, '42501'::char(5), NULL, 'B cannot insert cards');
select throws_ok(format('update public.cards set text = %L where id = %L', 'Direct', current_setting('test.b_attr')), '42501'::char(5), NULL, 'B cannot update their own card directly');
select throws_ok(format('delete from public.cards where id = %L', current_setting('test.b_attr')), '42501'::char(5), NULL, 'B cannot delete their own card directly');
select throws_ok(format('select * from public.card_authors where card_id = %L', current_setting('test.b_attr')), '42501'::char(5), NULL, 'B cannot select their own card_authors row');
select throws_ok(format('insert into public.card_authors (card_id, author_id) values (%L, %L)', current_setting('test.b_multi'), '12000000-0000-4000-8000-000000000002'), '42501'::char(5), NULL, 'B cannot insert card_authors');
select throws_ok(format('update public.card_authors set author_id = %L where card_id = %L', '12000000-0000-4000-8000-000000000002', current_setting('test.b_attr')), '42501'::char(5), NULL, 'B cannot update card_authors');
select throws_ok(format('delete from public.card_authors where card_id = %L', current_setting('test.b_attr')), '42501'::char(5), NULL, 'B cannot delete their own card_authors row');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$ select * from public.cards $$, '42501'::char(5), NULL, 'non-member C cannot select cards');
select throws_ok($$ insert into public.cards (cycle_id, category, text) values ('32000000-0000-4000-8000-000000000002', 'start', 'Direct') $$, '42501'::char(5), NULL, 'C cannot insert cards');
select throws_ok(format('update public.cards set text = %L where id = %L', 'Direct', current_setting('test.b_attr')), '42501'::char(5), NULL, 'C cannot update cards');
select throws_ok(format('delete from public.cards where id = %L', current_setting('test.b_attr')), '42501'::char(5), NULL, 'C cannot delete cards');
select throws_ok($$ select * from public.card_authors $$, '42501'::char(5), NULL, 'C cannot select card_authors');
select throws_ok(format('insert into public.card_authors (card_id, author_id) values (%L, %L)', current_setting('test.b_multi'), '12000000-0000-4000-8000-000000000003'), '42501'::char(5), NULL, 'C cannot insert card_authors');
select throws_ok(format('update public.card_authors set author_id = %L where card_id = %L', '12000000-0000-4000-8000-000000000003', current_setting('test.b_attr')), '42501'::char(5), NULL, 'C cannot update card_authors');
select throws_ok(format('delete from public.card_authors where card_id = %L', current_setting('test.b_attr')), '42501'::char(5), NULL, 'C cannot delete card_authors');
reset role;

set local role anon;
select throws_ok($$ select * from public.cards $$, '42501'::char(5), NULL, 'anon cannot select cards');
select throws_ok($$ select * from public.card_authors $$, '42501'::char(5), NULL, 'anon cannot select card_authors');
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'x') $$, '42501'::char(5), NULL, 'anon cannot call create_card');
select throws_ok(format('select * from public.update_card(%L, %L, false)', current_setting('test.b_attr'), 'x'), '42501'::char(5), NULL, 'anon cannot call update_card');
select throws_ok(format('select public.delete_card(%L)', current_setting('test.b_attr')), '42501'::char(5), NULL, 'anon cannot call delete_card');
select throws_ok($$ select * from public.get_my_cards('32000000-0000-4000-8000-000000000002') $$, '42501'::char(5), NULL, 'anon cannot call get_my_cards');
reset role;

-- ---------------------------------------------------------------------------
-- A removed member keeps their cards but loses every card right.
-- ---------------------------------------------------------------------------
delete from public.project_members
 where project_id = '22000000-0000-4000-8000-000000000001'
   and user_id = '12000000-0000-4000-8000-000000000004';

set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'After removal') $$, '42501'::char(5), 'not_project_member', 'removed member D cannot create a card');
select throws_ok(format('select * from public.update_card(%L, %L, false)', current_setting('test.d_card'), 'Edited after removal'), '42501'::char(5), 'not_project_member', 'removed member D cannot edit their card');
select throws_ok(format('select public.delete_card(%L)', current_setting('test.d_card')), '42501'::char(5), 'not_project_member', 'removed member D cannot delete their card');
select throws_ok($$ select * from public.get_my_cards('32000000-0000-4000-8000-000000000002') $$, '42501'::char(5), 'not_project_member', 'removed member D cannot list their cards');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(format('select * from public.update_card(%L, %L, false)', current_setting('test.d_card'), 'Taken'), 'P0001'::char(5), 'card_not_found', 'facilitator and owner A cannot edit the removed member''s card');
select throws_ok(format('select public.delete_card(%L)', current_setting('test.d_card')), 'P0001'::char(5), 'card_not_found', 'A cannot delete the removed member''s card');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(format('select * from public.update_card(%L, %L, false)', current_setting('test.d_card'), 'Taken'), 'P0001'::char(5), 'card_not_found', 'member B cannot edit the removed member''s card');
select throws_ok(format('select public.delete_card(%L)', current_setting('test.d_card')), 'P0001'::char(5), 'card_not_found', 'B cannot delete the removed member''s card');
reset role;
select results_eq(
  format('select c.cycle_id, c.text, ca.author_id from public.cards c join public.card_authors ca on ca.card_id = c.id where c.id = %L', current_setting('test.d_card')),
  $$ values ('32000000-0000-4000-8000-000000000002'::uuid, 'D card'::text, '12000000-0000-4000-8000-000000000004'::uuid) $$,
  'the removed member''s card stays in the cycle with its authorship row'
);

-- ---------------------------------------------------------------------------
-- Cards are read-only once the cycle leaves collecting. P1 walks through
-- every later status as postgres, through #10's allowed transitions.
-- ---------------------------------------------------------------------------
do $$ begin
  perform set_config('test.p1_count', (select count(*)::text from public.cards where cycle_id = '32000000-0000-4000-8000-000000000002'), true);
  perform set_config('test.b_snapshot', (select text || '|' || is_anonymous::text from public.cards where id = current_setting('test.b_attr')::uuid), true);
  perform set_config('test.b_count', (select count(*)::text from public.card_authors ca join public.cards c on c.id = ca.card_id where c.cycle_id = '32000000-0000-4000-8000-000000000002' and ca.author_id = '12000000-0000-4000-8000-000000000002'), true);
end $$;

update public.feedback_cycles set status = 'reveal', revealed_at = now() where id = '32000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'Late') $$, 'P0001'::char(5), 'cycle_not_collecting', 'reveal: create_card fails with cycle_not_collecting');
select throws_ok(format('select * from public.update_card(%L, %L, true)', current_setting('test.b_attr'), 'Late edit'), 'P0001'::char(5), 'cycle_not_collecting', 'reveal: update_card fails with cycle_not_collecting');
select throws_ok(format('select public.delete_card(%L)', current_setting('test.b_attr')), 'P0001'::char(5), 'cycle_not_collecting', 'reveal: delete_card fails with cycle_not_collecting');
select is((select count(*)::text from public.get_my_cards('32000000-0000-4000-8000-000000000002')), current_setting('test.b_count'), 'reveal: get_my_cards still returns the author''s cards');
reset role;
select is((select count(*)::text from public.cards where cycle_id = '32000000-0000-4000-8000-000000000002'), current_setting('test.p1_count'), 'reveal: the card count is unchanged');
select is((select text || '|' || is_anonymous::text from public.cards where id = current_setting('test.b_attr')::uuid), current_setting('test.b_snapshot'), 'reveal: text and is_anonymous are unchanged');

update public.feedback_cycles set status = 'cluster' where id = '32000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'Late') $$, 'P0001'::char(5), 'cycle_not_collecting', 'cluster: create_card fails with cycle_not_collecting');
select throws_ok(format('select * from public.update_card(%L, %L, true)', current_setting('test.b_attr'), 'Late edit'), 'P0001'::char(5), 'cycle_not_collecting', 'cluster: update_card fails with cycle_not_collecting');
select throws_ok(format('select public.delete_card(%L)', current_setting('test.b_attr')), 'P0001'::char(5), 'cycle_not_collecting', 'cluster: delete_card fails with cycle_not_collecting');
select is((select count(*)::text from public.get_my_cards('32000000-0000-4000-8000-000000000002')), current_setting('test.b_count'), 'cluster: get_my_cards still returns the author''s cards');
reset role;
select is((select count(*)::text from public.cards where cycle_id = '32000000-0000-4000-8000-000000000002'), current_setting('test.p1_count'), 'cluster: the card count is unchanged');
select is((select text || '|' || is_anonymous::text from public.cards where id = current_setting('test.b_attr')::uuid), current_setting('test.b_snapshot'), 'cluster: text and is_anonymous are unchanged');

update public.feedback_cycles set status = 'vote' where id = '32000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'Late') $$, 'P0001'::char(5), 'cycle_not_collecting', 'vote: create_card fails with cycle_not_collecting');
select throws_ok(format('select * from public.update_card(%L, %L, true)', current_setting('test.b_attr'), 'Late edit'), 'P0001'::char(5), 'cycle_not_collecting', 'vote: update_card fails with cycle_not_collecting');
select throws_ok(format('select public.delete_card(%L)', current_setting('test.b_attr')), 'P0001'::char(5), 'cycle_not_collecting', 'vote: delete_card fails with cycle_not_collecting');
select is((select count(*)::text from public.get_my_cards('32000000-0000-4000-8000-000000000002')), current_setting('test.b_count'), 'vote: get_my_cards still returns the author''s cards');
reset role;
select is((select count(*)::text from public.cards where cycle_id = '32000000-0000-4000-8000-000000000002'), current_setting('test.p1_count'), 'vote: the card count is unchanged');
select is((select text || '|' || is_anonymous::text from public.cards where id = current_setting('test.b_attr')::uuid), current_setting('test.b_snapshot'), 'vote: text and is_anonymous are unchanged');

update public.feedback_cycles set status = 'discuss', voting_closed_at = now() where id = '32000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'Late') $$, 'P0001'::char(5), 'cycle_not_collecting', 'discuss: create_card fails with cycle_not_collecting');
select throws_ok(format('select * from public.update_card(%L, %L, true)', current_setting('test.b_attr'), 'Late edit'), 'P0001'::char(5), 'cycle_not_collecting', 'discuss: update_card fails with cycle_not_collecting');
select throws_ok(format('select public.delete_card(%L)', current_setting('test.b_attr')), 'P0001'::char(5), 'cycle_not_collecting', 'discuss: delete_card fails with cycle_not_collecting');
select is((select count(*)::text from public.get_my_cards('32000000-0000-4000-8000-000000000002')), current_setting('test.b_count'), 'discuss: get_my_cards still returns the author''s cards');
reset role;
select is((select count(*)::text from public.cards where cycle_id = '32000000-0000-4000-8000-000000000002'), current_setting('test.p1_count'), 'discuss: the card count is unchanged');
select is((select text || '|' || is_anonymous::text from public.cards where id = current_setting('test.b_attr')::uuid), current_setting('test.b_snapshot'), 'discuss: text and is_anonymous are unchanged');

update public.feedback_cycles set status = 'closed', closed_at = now() where id = '32000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$ select * from public.create_card('32000000-0000-4000-8000-000000000002', 'start', 'Late') $$, 'P0001'::char(5), 'cycle_not_collecting', 'closed: create_card fails with cycle_not_collecting');
select throws_ok(format('select * from public.update_card(%L, %L, true)', current_setting('test.b_attr'), 'Late edit'), 'P0001'::char(5), 'cycle_not_collecting', 'closed: update_card fails with cycle_not_collecting');
select throws_ok(format('select public.delete_card(%L)', current_setting('test.b_attr')), 'P0001'::char(5), 'cycle_not_collecting', 'closed: delete_card fails with cycle_not_collecting');
select is((select count(*)::text from public.get_my_cards('32000000-0000-4000-8000-000000000002')), current_setting('test.b_count'), 'closed: get_my_cards still returns the author''s cards');
reset role;
select is((select count(*)::text from public.cards where cycle_id = '32000000-0000-4000-8000-000000000002'), current_setting('test.p1_count'), 'closed: the card count is unchanged');
select is((select text || '|' || is_anonymous::text from public.cards where id = current_setting('test.b_attr')::uuid), current_setting('test.b_snapshot'), 'closed: text and is_anonymous are unchanged');

-- ---------------------------------------------------------------------------
-- Cascades: deleting a cycle or a project removes cards and authorship.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin
  perform set_config('test.r1_ids', (select string_agg(c.id::text, ',') from (select id from public.create_card('32000000-0000-4000-8000-000000000004', 'start', 'R1 one') union all select id from public.create_card('32000000-0000-4000-8000-000000000004', 'stop', 'R1 two', true)) c), true);
end $$;
reset role;
select is((select count(*)::int from public.card_authors where card_id = any(string_to_array(current_setting('test.r1_ids'), ',')::uuid[])), 2, 'A has two authored cards in R1');
set local role service_role;
select lives_ok($$ delete from public.feedback_cycles where id = '32000000-0000-4000-8000-000000000004' $$, 'service_role deletes cycle R1');
reset role;
select is((select count(*)::int from public.cards where cycle_id = '32000000-0000-4000-8000-000000000004'), 0, 'deleting a cycle deletes its cards');
select is((select count(*)::int from public.card_authors where card_id = any(string_to_array(current_setting('test.r1_ids'), ',')::uuid[])), 0, 'deleting a cycle deletes its card_authors rows');

insert into public.feedback_cycles (id, project_id, title, week_start)
values ('32000000-0000-4000-8000-000000000005', '22000000-0000-4000-8000-000000000003', 'R again', '2026-10-26');
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin
  perform set_config('test.r2_id', (select id::text from public.create_card('32000000-0000-4000-8000-000000000005', 'continue', 'R2 card')), true);
end $$;
reset role;
select lives_ok($$ delete from public.projects where id = '22000000-0000-4000-8000-000000000003' $$, 'project R can be deleted');
select is((select count(*)::int from public.cards where id = current_setting('test.r2_id')::uuid), 0, 'deleting the project deletes its cards');
select is((select count(*)::int from public.card_authors where card_id = current_setting('test.r2_id')::uuid), 0, 'deleting the project deletes their card_authors rows');

-- ---------------------------------------------------------------------------
-- Deleting an auth user forgets authorship but keeps the cards. The
-- service_role key deletes users through the Auth admin API; here the delete
-- runs as postgres, as in feedback_cycles.test.sql.
-- ---------------------------------------------------------------------------
do $$ begin
  perform set_config('test.b_all', (select string_agg(ca.card_id::text, ',') from public.card_authors ca where ca.author_id = '12000000-0000-4000-8000-000000000002'), true);
end $$;
select lives_ok($$ delete from auth.users where id = '12000000-0000-4000-8000-000000000002' $$, 'auth user B can be deleted');
select is((select count(*)::int from public.card_authors where author_id = '12000000-0000-4000-8000-000000000002'), 0, 'deleting the user deletes their card_authors rows');
select is((select count(*)::text from public.cards where id = any(string_to_array(current_setting('test.b_all'), ',')::uuid[])), current_setting('test.b_count'), 'deleting the user keeps their cards');
select is((select count(*)::int from public.card_authors where card_id = any(string_to_array(current_setting('test.b_all'), ',')::uuid[])), 0, 'the kept cards have no author');
set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(format('select * from public.update_card(%L, %L, false)', current_setting('test.b_attr'), 'Taken'), 'P0001'::char(5), 'card_not_found', 'nobody can edit a card whose author was deleted');
select throws_ok(format('select public.delete_card(%L)', current_setting('test.b_attr')), 'P0001'::char(5), 'card_not_found', 'nobody can delete a card whose author was deleted');
reset role;

select * from finish();
rollback;
