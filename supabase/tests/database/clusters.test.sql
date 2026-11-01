-- pgTAP tests for manual clusters (#17): the clusters and cluster_cards
-- tables, their RLS and grants, create_cluster, rename_cluster, and
-- delete_cluster (hardening and behaviour), the clusters_changed events, and
-- get_cycle_board's clusters key.
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension and the cluster_test helper schema. The seed user is
-- never used as a fixture.
--
-- Fixtures: owner and facilitator A, members B and D, non-member C. Project P
-- is owned by A with B and D joined; project Q is owned by C, and none of A,
-- B, or D is ever in Q.
--
-- Cycles. P0 (P) gets a card, a cluster inserted as postgres while
-- collecting, and is then closed from collecting. P1 (P) is the main cycle:
-- cards from A, B, and D through create_card (attributed and anonymous),
-- revealed through start_retrospective, moved to cluster and vote through
-- advance_stage, to discuss as postgres, and closed through close_cycle. Q1
-- (Q) is C's. P has at most one open cycle at a time.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(211);

-- ---------------------------------------------------------------------------
-- Test-only helpers. The ones that call RPCs are security invoker: they run
-- as the calling role (authenticated) and switch only the JWT claims. The
-- read-back helpers are security definer so they see every row whatever the
-- caller.
-- ---------------------------------------------------------------------------
create schema cluster_test;

create table cluster_test.ids (label text primary key, id uuid not null);
create table cluster_test.snaps (label text primary key, body jsonb);
-- Event ids already looked at; new_events reports only the others.
create table cluster_test.seen (id uuid primary key);

insert into cluster_test.ids (label, id)
values
  ('A', '17000000-0000-4000-8000-000000000001'),
  ('B', '17000000-0000-4000-8000-000000000002'),
  ('C', '17000000-0000-4000-8000-000000000003'),
  ('D', '17000000-0000-4000-8000-000000000004'),
  ('P', '27000000-0000-4000-8000-000000000001'),
  ('Q', '27000000-0000-4000-8000-000000000002'),
  ('P0', '37000000-0000-4000-8000-000000000001'),
  ('P1', '37000000-0000-4000-8000-000000000002'),
  ('Q1', '37000000-0000-4000-8000-000000000011'),
  -- Clusters inserted as postgres. The board fixtures' ids are out of
  -- sort_order on purpose.
  ('P0 cluster', '47000000-0000-4000-8000-000000000001'),
  ('Q1 cluster', '47000000-0000-4000-8000-000000000002'),
  ('Early', '47000000-0000-4000-8000-000000000003'),
  ('AI one', '47000000-0000-4000-8000-000000000004'),
  ('AI two', '47000000-0000-4000-8000-000000000005'),
  ('Third', '1c170000-0000-4000-8000-000000000001'),
  ('First', '3a170000-0000-4000-8000-000000000002'),
  ('Second', '2b170000-0000-4000-8000-000000000003');

-- The id stored under a label (a user, project, cycle, card, or cluster).
create function cluster_test.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from cluster_test.ids i where i.label = p_label;
$$;

-- Signs in as the labelled user, or with no sub when the label is null (so
-- auth.uid() is null).
create function cluster_test.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', cluster_test.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- The full error (code, message, detail, hint) of a failed call, as a
-- json object built from the stacked diagnostics.
create function cluster_test.err_of(p_state text, p_message text, p_detail text, p_hint text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('code', p_state, 'message', p_message, 'detail', p_detail, 'hint', p_hint);
$$;

-- The error a refused call gets, with empty detail and hint.
create function cluster_test.e(p_message text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'code', case when p_message = 'not_project_member' then '42501' else 'P0001' end,
    'message', p_message,
    'detail', '',
    'hint', ''
  );
$$;

-- create_cluster as the user; its rows as a jsonb array. When p_label is
-- given, the new cluster's id is stored under it.
create function cluster_test.mk(p_user text, p_cycle uuid, p_name text, p_label text default null)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform cluster_test.become(p_user);
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into result from public.create_cluster(p_cycle, p_name) r;
  if p_label is not null then
    insert into cluster_test.ids (label, id) values (p_label, (result -> 0 ->> 'cluster_id')::uuid);
  end if;
  return result;
end;
$$;

-- The error of create_cluster as the user, or "ok".
create function cluster_test.mk_err(p_user text, p_cycle uuid, p_name text)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform cluster_test.become(p_user);
  perform 1 from public.create_cluster(p_cycle, p_name);
  return to_jsonb('ok'::text);
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return cluster_test.err_of(v_state, v_message, v_detail, v_hint);
end;
$$;

-- rename_cluster as the user; its rows as a jsonb array.
create function cluster_test.ren(p_user text, p_cluster uuid, p_name text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform cluster_test.become(p_user);
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into result from public.rename_cluster(p_cluster, p_name) r;
  return result;
end;
$$;

-- The error of rename_cluster as the user, or "ok".
create function cluster_test.ren_err(p_user text, p_cluster uuid, p_name text)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform cluster_test.become(p_user);
  perform 1 from public.rename_cluster(p_cluster, p_name);
  return to_jsonb('ok'::text);
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return cluster_test.err_of(v_state, v_message, v_detail, v_hint);
end;
$$;

-- delete_cluster as the user: "ok", or its error.
create function cluster_test.del(p_user text, p_cluster uuid)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform cluster_test.become(p_user);
  perform public.delete_cluster(p_cluster);
  return to_jsonb('ok'::text);
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return cluster_test.err_of(v_state, v_message, v_detail, v_hint);
end;
$$;

-- Creates "Bulk n" clusters as the user until the cycle holds p_total.
create function cluster_test.fill(p_user text, p_cycle uuid, p_total integer)
returns integer
language plpgsql
as $$
declare
  n integer := 0;
begin
  while cluster_test.cluster_count(p_cycle) < p_total loop
    n := n + 1;
    perform cluster_test.mk(p_user, p_cycle, 'Bulk ' || n);
  end loop;
  return cluster_test.cluster_count(p_cycle);
end;
$$;

-- create_card as the user; the card text is its label, and its id is stored.
create function cluster_test.add_card(p_user text, p_cycle text, p_category text, p_label text, p_anonymous boolean)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform cluster_test.become(p_user);
  select c.id into strict new_id
    from public.create_card(cluster_test.id(p_cycle), p_category, p_label, p_anonymous) c;
  insert into cluster_test.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

-- start_retrospective, advance_stage, and close_cycle as the user.
create function cluster_test.start(p_user text, p_cycle uuid)
returns void
language plpgsql
as $$
begin
  perform cluster_test.become(p_user);
  perform 1 from public.start_retrospective(p_cycle);
end;
$$;

create function cluster_test.advance(p_user text, p_cycle uuid, p_from text)
returns void
language plpgsql
as $$
begin
  perform cluster_test.become(p_user);
  perform 1 from public.advance_stage(p_cycle, p_from);
end;
$$;

create function cluster_test.close(p_user text, p_cycle uuid)
returns void
language plpgsql
as $$
begin
  perform cluster_test.become(p_user);
  perform 1 from public.close_cycle(p_cycle);
end;
$$;

-- get_cycle_board as the user.
create function cluster_test.board(p_user text, p_cycle uuid)
returns jsonb
language plpgsql
as $$
begin
  perform cluster_test.become(p_user);
  return public.get_cycle_board(p_cycle);
end;
$$;

-- The sorted key set of a jsonb object.
create function cluster_test.keys(p_obj jsonb)
returns text[]
language sql
immutable
as $$
  select array_agg(k order by k) from jsonb_object_keys(p_obj) k;
$$;

-- Every forbidden key found at any depth of a response.
create function cluster_test.forbidden(p_resp jsonb)
returns text[]
language sql
immutable
as $$
  select array_agg(distinct k order by k)
  from jsonb_path_query(p_resp, 'strict $.**') v(j)
  cross join lateral jsonb_object_keys(case when jsonb_typeof(v.j) = 'object' then v.j else '{}'::jsonb end) k
  where k in ('created_at', 'updated_at', 'sort_order', 'actor_id', 'author_id', 'user_id', 'email');
$$;

-- The anonymous card objects of a response, in response order.
create function cluster_test.anon_cards(p_resp jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(c order by o), '[]') from jsonb_array_elements(p_resp -> 'cards') with ordinality e(c, o) where (c ->> 'is_anonymous')::boolean;
$$;

-- The cluster names of a response, in response order.
create function cluster_test.names(p_resp jsonb)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(c ->> 'name' order by o), '{}') from jsonb_array_elements(p_resp -> 'clusters') with ordinality e(c, o);
$$;

-- The card_ids of the named cluster in a response.
create function cluster_test.card_ids_of(p_resp jsonb, p_name text)
returns uuid[]
language sql
immutable
as $$
  select coalesce(array_agg(x::uuid order by o), '{}')
  from jsonb_array_elements(p_resp -> 'clusters') c
  cross join lateral jsonb_array_elements_text(c -> 'card_ids') with ordinality e(x, o)
  where c ->> 'name' = p_name;
$$;

-- A clusters row as jsonb, read as postgres.
create function cluster_test.row_of(p_cluster uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(cl) from public.clusters cl where cl.id = p_cluster;
$$;

-- The number of clusters of a cycle, read as postgres.
create function cluster_test.cluster_count(p_cycle uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.clusters cl where cl.cycle_id = p_cycle;
$$;

-- An md5 of every clusters and cluster_cards row of a cycle, read as postgres.
create function cluster_test.state(p_cycle uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(
    coalesce((select string_agg(to_jsonb(cl)::text, '|' order by cl.id) from public.clusters cl where cl.cycle_id = p_cycle), '')
    || '#'
    || coalesce((select string_agg(to_jsonb(cc)::text, '|' order by cc.card_id) from public.cluster_cards cc where cc.cycle_id = p_cycle), '')
  );
$$;

-- An md5 of every cards row, read as postgres.
create function cluster_test.cards_md5()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(coalesce((select string_agg(to_jsonb(c)::text, '|' order by c.id) from public.cards c), ''));
$$;

-- Marks every current event as seen.
create function cluster_test.mark()
returns void
language sql
security definer
set search_path = ''
as $$
  insert into cluster_test.seen (id)
  select e.id from public.cycle_events e
  on conflict do nothing;
$$;

-- The unseen events of a cycle, without id, cycle_id, and created_at.
create function cluster_test.new_events(p_cycle uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(to_jsonb(e) - 'id' - 'cycle_id' - 'created_at' order by e.type),
    '[]'::jsonb
  )
  from public.cycle_events e
  where e.cycle_id = p_cycle
    and not exists (select 1 from cluster_test.seen s where s.id = e.id);
$$;

-- The number of unseen events of every other cycle.
create function cluster_test.new_other_events(p_cycle uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int
  from public.cycle_events e
  where e.cycle_id <> p_cycle
    and not exists (select 1 from cluster_test.seen s where s.id = e.id);
$$;

-- The one event a cluster write records in a cycle of the given status.
create function cluster_test.one_event(p_status text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_array(jsonb_build_object(
    'type', 'clusters_changed',
    'from_status', p_status,
    'to_status', p_status,
    'actor_id', null,
    'payload', '{}'::jsonb
  ));
$$;

-- Stores a value under a label, and reads it back.
create function cluster_test.snap(p_label text, p_body jsonb)
returns void
language sql
as $$
  insert into cluster_test.snaps (label, body) values (p_label, p_body)
  on conflict (label) do update set body = excluded.body;
$$;

create function cluster_test.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.body from cluster_test.snaps s where s.label = p_label;
$$;

-- Every wrong-stage case for a cycle and one of its clusters: each RPC must
-- fail with cycle_not_clustering. Returns the cases that did not.
create function cluster_test.wrong_stage(p_cycle uuid, p_cluster uuid)
returns text[]
language plpgsql
as $$
declare
  result text[] := '{}';
begin
  if cluster_test.mk_err('B', p_cycle, 'Late cluster') is distinct from cluster_test.e('cycle_not_clustering') then
    result := result || 'create'::text;
  end if;
  if cluster_test.ren_err('B', p_cluster, 'Late name') is distinct from cluster_test.e('cycle_not_clustering') then
    result := result || 'rename'::text;
  end if;
  if cluster_test.del('B', p_cluster) is distinct from cluster_test.e('cycle_not_clustering') then
    result := result || 'delete'::text;
  end if;
  return result;
end;
$$;

grant usage on schema cluster_test to authenticated;
grant select, insert, update on all tables in schema cluster_test to authenticated;
grant execute on all functions in schema cluster_test to authenticated;

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
  ('00000000-0000-0000-0000-000000000000', '17000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'cluster-a@example.com', '{"display_name":"Alice"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '17000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'cluster-b@example.com', '{"display_name":"Bob"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '17000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'cluster-c@example.com', '{"display_name":"Cara"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '17000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'cluster-d@example.com', '{"display_name":"Dan"}', '', '', '', '');

insert into public.projects (id, name, owner_id)
values
  ('27000000-0000-4000-8000-000000000001', 'Project P', '17000000-0000-4000-8000-000000000001'),
  ('27000000-0000-4000-8000-000000000002', 'Project Q', '17000000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('27000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-000000000002', 'member'),
  ('27000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-000000000004', 'member');

insert into public.feedback_cycles (id, project_id, title, week_start)
values
  ('37000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000001', 'P early close', '2026-10-12'),
  ('37000000-0000-4000-8000-000000000011', '27000000-0000-4000-8000-000000000002', 'Q one', '2026-10-26');

insert into public.clusters (id, cycle_id, name, sort_order)
values ('47000000-0000-4000-8000-000000000002', '37000000-0000-4000-8000-000000000011', 'Q cluster', 1);

-- ---------------------------------------------------------------------------
-- Tables: columns, constraints, guards, and cascades.
-- ---------------------------------------------------------------------------
select columns_are('public', 'clusters', array['id', 'cycle_id', 'name', 'source', 'sort_order', 'created_at', 'updated_at'], 'clusters has exactly the seven expected columns');
select columns_are('public', 'cluster_cards', array['cycle_id', 'cluster_id', 'card_id', 'sort_order'], 'cluster_cards has exactly the four expected columns');
select is(
  (select array_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable || ':' || coalesce(c.column_default, '') order by c.ordinal_position) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'clusters'),
  array[
    'id:uuid:NO:gen_random_uuid()',
    'cycle_id:uuid:NO:',
    'name:text:NO:',
    'source:text:NO:''manual''::text',
    'sort_order:integer:NO:',
    'created_at:timestamp with time zone:NO:now()',
    'updated_at:timestamp with time zone:NO:now()'
  ],
  'clusters column types, defaults, and not-null rules'
);
select is(
  (select array_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable || ':' || coalesce(c.column_default, '') order by c.ordinal_position) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'cluster_cards'),
  array['cycle_id:uuid:NO:', 'cluster_id:uuid:NO:', 'card_id:uuid:NO:', 'sort_order:integer:NO:0'],
  'cluster_cards column types, defaults, and not-null rules'
);
select col_is_pk('public', 'clusters', 'id', 'clusters.id is the primary key');
select col_is_pk('public', 'cluster_cards', 'card_id', 'cluster_cards.card_id is the primary key: a card is in at most one cluster');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.clusters'::regclass and conname = 'clusters_cycle_id_fkey'), 'c', 'clusters.cycle_id references feedback_cycles on delete cascade');
select is(
  (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.cluster_cards'::regclass and conname = 'cluster_cards_cluster_fkey'),
  'FOREIGN KEY (cluster_id, cycle_id) REFERENCES clusters(id, cycle_id) ON DELETE CASCADE',
  'cluster_cards (cluster_id, cycle_id) references clusters (id, cycle_id) on delete cascade'
);
select is(
  (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.cluster_cards'::regclass and conname = 'cluster_cards_card_fkey'),
  'FOREIGN KEY (card_id, cycle_id) REFERENCES cards(id, cycle_id) ON DELETE CASCADE',
  'cluster_cards (card_id, cycle_id) references cards (id, cycle_id) on delete cascade'
);
select has_index('public', 'cluster_cards', 'cluster_cards_cluster_id_sort_order_idx', array['cluster_id', 'sort_order'], 'cluster_cards has an index on (cluster_id, sort_order)');
select is((select indexdef ~ 'UNIQUE INDEX .* \(cycle_id, lower\(name\)\)' from pg_indexes where schemaname = 'public' and indexname = 'clusters_cycle_id_lower_name_key'), true, 'a unique index on (cycle_id, lower(name))');

-- As postgres: every constraint holds whatever the RPCs do.
insert into public.clusters (id, cycle_id, name, sort_order)
values ('47000000-0000-4000-8000-000000000099', '37000000-0000-4000-8000-000000000011', 'Process', 2);
select throws_ok($$ insert into public.clusters (cycle_id, name, source, sort_order) values ('37000000-0000-4000-8000-000000000011', 'Other source', 'other', 10) $$, '23514', NULL, 'source other is rejected');
select throws_ok($$ insert into public.clusters (cycle_id, name, sort_order) values ('37000000-0000-4000-8000-000000000011', ' Leading', 11) $$, '23514', NULL, 'a name with a leading space is rejected');
select throws_ok($$ insert into public.clusters (cycle_id, name, sort_order) values ('37000000-0000-4000-8000-000000000011', '', 12) $$, '23514', NULL, 'an empty name is rejected');
select throws_ok($$ insert into public.clusters (cycle_id, name, sort_order) values ('37000000-0000-4000-8000-000000000011', repeat('n', 101), 13) $$, '23514', NULL, 'a 101-character name is rejected');
select throws_ok($$ insert into public.clusters (cycle_id, name, sort_order) values ('37000000-0000-4000-8000-000000000011', 'a' || E'\n' || 'b', 14) $$, '23514', NULL, 'a name with a line break is rejected');
select throws_ok($$ insert into public.clusters (cycle_id, name, sort_order) values ('37000000-0000-4000-8000-000000000011', 'process', 15) $$, '23505', NULL, 'process next to Process in the same cycle is rejected');
select lives_ok($$ insert into public.clusters (cycle_id, name, sort_order) values ('37000000-0000-4000-8000-000000000001', 'process', 1) $$, 'the same name in another cycle succeeds');
select throws_ok($$ insert into public.clusters (cycle_id, name, sort_order) values ('37000000-0000-4000-8000-000000000011', 'Same order', 2) $$, '23505', NULL, 'a duplicate (cycle_id, sort_order) is rejected');
delete from public.clusters where cycle_id = '37000000-0000-4000-8000-000000000001';

-- A card of P0 cannot join a cluster of Q1, and a card joins one cluster only.
insert into public.cards (id, cycle_id, category, text) values ('57000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000001', 'start', 'P0 postgres card');
insert into public.cards (id, cycle_id, category, text) values ('57000000-0000-4000-8000-000000000002', '37000000-0000-4000-8000-000000000011', 'stop', 'Q1 postgres card');
select throws_ok($$ insert into public.cluster_cards (cycle_id, cluster_id, card_id) values ('37000000-0000-4000-8000-000000000011', '47000000-0000-4000-8000-000000000002', '57000000-0000-4000-8000-000000000001') $$, '23503', NULL, 'a cluster_cards row whose card belongs to another cycle is rejected');
insert into public.cluster_cards (cycle_id, cluster_id, card_id) values ('37000000-0000-4000-8000-000000000011', '47000000-0000-4000-8000-000000000002', '57000000-0000-4000-8000-000000000002');
select throws_ok($$ insert into public.cluster_cards (cycle_id, cluster_id, card_id) values ('37000000-0000-4000-8000-000000000011', '47000000-0000-4000-8000-000000000099', '57000000-0000-4000-8000-000000000002') $$, '23505', NULL, 'a card in two clusters is rejected');

-- Guards and updated_at.
select throws_ok($$ update public.clusters set id = gen_random_uuid() where id = '47000000-0000-4000-8000-000000000099' $$, 'P0001', 'cluster_immutable_column', 'updating clusters.id is rejected');
select throws_ok($$ update public.clusters set cycle_id = '37000000-0000-4000-8000-000000000001' where id = '47000000-0000-4000-8000-000000000099' $$, 'P0001', 'cluster_immutable_column', 'updating clusters.cycle_id is rejected');
select throws_ok($$ update public.clusters set created_at = now() - interval '1 day' where id = '47000000-0000-4000-8000-000000000099' $$, 'P0001', 'cluster_immutable_column', 'updating clusters.created_at is rejected');
update public.clusters set updated_at = '2020-01-01' where id = '47000000-0000-4000-8000-000000000099';
update public.clusters set name = 'Processes' where id = '47000000-0000-4000-8000-000000000099';
select is((select updated_at = now() from public.clusters where id = '47000000-0000-4000-8000-000000000099'), true, 'updating the name bumps updated_at');

-- Cascades.
delete from public.clusters where id = '47000000-0000-4000-8000-000000000002';
select is((select count(*)::int from public.cluster_cards where cluster_id = '47000000-0000-4000-8000-000000000002'), 0, 'deleting a cluster deletes its cluster_cards rows');
select is((select count(*)::int from public.cards where id = '57000000-0000-4000-8000-000000000002'), 1, 'deleting a cluster deletes no card');
insert into public.cluster_cards (cycle_id, cluster_id, card_id) values ('37000000-0000-4000-8000-000000000011', '47000000-0000-4000-8000-000000000099', '57000000-0000-4000-8000-000000000002');
delete from public.cards where id = '57000000-0000-4000-8000-000000000002';
select is((select count(*)::int from public.cluster_cards where card_id = '57000000-0000-4000-8000-000000000002'), 0, 'deleting a card deletes its cluster_cards row');

insert into public.projects (id, name, owner_id)
values ('27000000-0000-4000-8000-000000000003', 'Project R', '17000000-0000-4000-8000-000000000003');
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('37000000-0000-4000-8000-000000000021', '27000000-0000-4000-8000-000000000003', 'R doomed', '2026-10-19');
insert into public.cards (id, cycle_id, category, text) values ('57000000-0000-4000-8000-000000000003', '37000000-0000-4000-8000-000000000021', 'start', 'Doomed card');
insert into public.clusters (id, cycle_id, name, sort_order) values ('47000000-0000-4000-8000-000000000021', '37000000-0000-4000-8000-000000000021', 'Doomed', 1);
insert into public.cluster_cards (cycle_id, cluster_id, card_id) values ('37000000-0000-4000-8000-000000000021', '47000000-0000-4000-8000-000000000021', '57000000-0000-4000-8000-000000000003');
select lives_ok($$ delete from public.feedback_cycles where id = '37000000-0000-4000-8000-000000000021' $$, 'deleting a cycle with clusters and memberships succeeds');
select is(
  (select count(*)::int from public.clusters where cycle_id = '37000000-0000-4000-8000-000000000021')
  + (select count(*)::int from public.cluster_cards where cycle_id = '37000000-0000-4000-8000-000000000021')
  + (select count(*)::int from public.cycle_events where cycle_id = '37000000-0000-4000-8000-000000000021'),
  0,
  'the deleted cycle''s clusters, memberships, and events are gone'
);
-- Put Q's cluster back for the access tests.
insert into public.clusters (id, cycle_id, name, sort_order)
values ('47000000-0000-4000-8000-000000000002', '37000000-0000-4000-8000-000000000011', 'Q cluster', 1);

-- cards gains only cards_id_cycle_id_key.
select columns_are('public', 'cards', array['id', 'cycle_id', 'category', 'text', 'is_anonymous', 'created_at', 'updated_at'], 'cards keeps exactly its seven columns');
select is(
  (select array_agg(conname::text order by conname) from pg_constraint where conrelid = 'public.cards'::regclass),
  array['cards_category_check', 'cards_cycle_id_fkey', 'cards_id_cycle_id_key', 'cards_pkey', 'cards_text_check'],
  'cards gains only the unique constraint cards_id_cycle_id_key'
);
select is((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.cards'::regclass and conname = 'cards_id_cycle_id_key'), 'UNIQUE (id, cycle_id)', 'cards_id_cycle_id_key is unique (id, cycle_id)');
select is((select array_agg(tgname::text order by tgname) from pg_trigger where tgrelid = 'public.cards'::regclass and not tgisinternal), array['cards_guard_update', 'cards_set_updated_at'], 'cards keeps exactly its two triggers');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('cards', 'card_authors')), 0, 'cards and card_authors still have no policy');
select is(
  (select array_agg(r || ':' || t || ':' || p order by r, t, p) from unnest(array['anon', 'authenticated']) r cross join unnest(array['public.cards', 'public.card_authors', 'public.project_members', 'public.profiles']) t cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege(r, t, p)),
  array['authenticated:public.profiles:SELECT', 'authenticated:public.project_members:SELECT'],
  'anon and authenticated have no new table privilege on cards, card_authors, project_members, or profiles'
);

-- ---------------------------------------------------------------------------
-- RLS, grants, and the Realtime publication.
-- ---------------------------------------------------------------------------
select is((select relrowsecurity from pg_class where oid = 'public.clusters'::regclass), true, 'RLS is enabled on clusters');
select is((select relrowsecurity from pg_class where oid = 'public.cluster_cards'::regclass), true, 'RLS is enabled on cluster_cards');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('clusters', 'cluster_cards')), 0, 'neither table has a policy');
select is(
  (select array_agg(r || ':' || t || ':' || p order by r, t, p) from unnest(array['anon', 'authenticated']) r cross join unnest(array['public.clusters', 'public.cluster_cards']) t cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege(r, t, p)),
  null,
  'anon and authenticated hold no privilege on clusters or cluster_cards'
);
select is(
  (select array_agg(t || ':' || p order by t, p) from unnest(array['public.clusters', 'public.cluster_cards']) t cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege('service_role', t, p)),
  array['public.cluster_cards:DELETE', 'public.cluster_cards:INSERT', 'public.cluster_cards:SELECT', 'public.cluster_cards:UPDATE', 'public.clusters:DELETE', 'public.clusters:INSERT', 'public.clusters:SELECT', 'public.clusters:UPDATE'],
  'service_role has exactly SELECT, INSERT, UPDATE, DELETE on both tables'
);
select is((select (count(*) filter (where a.grantee = 0))::int from pg_class c left join lateral aclexplode(c.relacl) a on true where c.oid in ('public.clusters'::regclass, 'public.cluster_cards'::regclass)), 0, 'PUBLIC has no privilege on either table');
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('clusters', 'cluster_cards')), 0, 'neither cluster table is in supabase_realtime');
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cycle_events'), 1, 'cycle_events is still in supabase_realtime');
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('cards', 'card_authors', 'feedback_cycles')), 0, 'cards, card_authors, and feedback_cycles are still not in supabase_realtime');

-- ---------------------------------------------------------------------------
-- RPC hardening: one row per function.
-- ---------------------------------------------------------------------------
create table cluster_test.rpcs (fn regprocedure primary key, name text not null, args text not null, result text not null);
insert into cluster_test.rpcs (fn, name, args, result)
values
  ('public.create_cluster(uuid, text)', 'create_cluster', 'p_cycle_id uuid, p_name text', 'TABLE(cluster_id uuid, name text, source text)'),
  ('public.rename_cluster(uuid, text)', 'rename_cluster', 'p_cluster_id uuid, p_name text', 'TABLE(cluster_id uuid, name text, source text)'),
  ('public.delete_cluster(uuid)', 'delete_cluster', 'p_cluster_id uuid', 'void');

select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = r.name), 1, r.name || ' has exactly one overload') from cluster_test.rpcs r order by r.name;
select is(pg_get_function_identity_arguments(r.fn), r.args, r.name || ' arguments') from cluster_test.rpcs r order by r.name;
select is(pg_get_function_result(r.fn), r.result, r.name || ' result') from cluster_test.rpcs r order by r.name;
select is((select p.prosecdef and p.provolatile = 'v' and p.proconfig = array['search_path=""']::text[] from pg_proc p where p.oid = r.fn), true, r.name || ' is security definer, volatile, and fixes search_path to empty') from cluster_test.rpcs r order by r.name;
select is(
  array[has_function_privilege('authenticated', r.fn, 'EXECUTE'), has_function_privilege('anon', r.fn, 'EXECUTE'), has_function_privilege('service_role', r.fn, 'EXECUTE')],
  array[true, false, false],
  r.name || ' is executable by authenticated only, not anon or service_role'
) from cluster_test.rpcs r order by r.name;
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = r.fn), 0, 'PUBLIC cannot execute ' || r.name) from cluster_test.rpcs r order by r.name;
select is((select p.prosrc ~ 'from public\.feedback_cycles fc\s+where fc\.id = \w+\s+for update;' from pg_proc p where p.oid = r.fn), true, r.name || ' locks the cycle row FOR UPDATE on public.feedback_cycles') from cluster_test.rpcs r order by r.name;
select is((select p.prosrc ~* '(cycle_events|card_authors|profiles|is_project_facilitator|owner_id|execute|raise\s+notice)' from pg_proc p where p.oid = r.fn), false, r.name || ' mentions no cycle_events, card_authors, profiles, facilitator, owner, dynamic SQL, or notice') from cluster_test.rpcs r order by r.name;
select is((select p.prosrc ~ '\(select auth\.uid\(\)\) is null' and p.prosrc ~ 'private\.is_project_member\(cycle_project\)' from pg_proc p where p.oid = r.fn), true, r.name || ' checks (select auth.uid()) and uses private.is_project_member') from cluster_test.rpcs r order by r.name;
select is(
  (select array_agg(distinct m.msg[1]::text) <@ array['not_project_member', 'cluster_not_found', 'cycle_not_clustering', 'invalid_cluster_name', 'cluster_name_taken', 'cluster_limit_reached'] from pg_proc p cross join lateral regexp_matches(p.prosrc, 'message\s*=\s*''([^'']*)''', 'g') as m(msg) where p.oid = r.fn),
  true,
  r.name || ' raises only the messages of the error table'
) from cluster_test.rpcs r order by r.name;
select is(
  (select (select count(*) from regexp_matches(p.prosrc, '\mraise\M', 'gi')) = (select count(*) from regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''[a-z_]+'';', 'g')) from pg_proc p where p.oid = r.fn),
  true,
  r.name || ': every raise sets only the code and a stable message, with no detail or hint'
) from cluster_test.rpcs r order by r.name;
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and (has_function_privilege('anon', p.oid, 'EXECUTE') or (has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.proname not in ('is_project_member', 'is_project_facilitator')))),
  null,
  'no new private helper is executable by anon or authenticated'
);
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname in ('record_clusters_change', 'guard_cluster_update') and p.prosrc ~ '(card_authors|profiles)'), 0, 'no cluster trigger reads card_authors or profiles');

-- ---------------------------------------------------------------------------
-- Events: the widened type check and the statement-level triggers.
-- ---------------------------------------------------------------------------
select lives_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values ('37000000-0000-4000-8000-000000000011', 'clusters_changed', 'closed', 'closed') $$, 'cycle_events_type_check accepts clusters_changed');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values ('37000000-0000-4000-8000-000000000011', 'voting_closed', 'vote', 'discuss') $$, '23514', NULL, 'cycle_events_type_check still rejects voting_closed');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values ('37000000-0000-4000-8000-000000000011', 'clusters_changed', 'cluster', 'vote') $$, '23514', NULL, 'a clusters_changed row with from_status <> to_status is rejected');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id) values ('37000000-0000-4000-8000-000000000011', 'clusters_changed', 'cluster', 'cluster', '17000000-0000-4000-8000-000000000001') $$, '23514', NULL, 'a clusters_changed row with an actor is rejected');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status, payload) values ('37000000-0000-4000-8000-000000000011', 'clusters_changed', 'cluster', 'cluster', '{"name":"x"}') $$, '23514', NULL, 'a clusters_changed row with a payload is rejected');
select is(
  (select array_agg(t.tgrelid::regclass::text || '.' || t.tgname || ':' || t.tgtype order by t.tgrelid::regclass::text, t.tgname) from pg_trigger t where t.tgrelid in ('public.clusters'::regclass, 'public.cluster_cards'::regclass) and t.tgname ~ '_record_'),
  array['cluster_cards.cluster_cards_record_delete:8', 'cluster_cards.cluster_cards_record_insert:4', 'cluster_cards.cluster_cards_record_update:16', 'clusters.clusters_record_delete:8', 'clusters.clusters_record_insert:4', 'clusters.clusters_record_update:16'],
  'statement-level AFTER INSERT, UPDATE, and DELETE triggers on both tables'
);
select is((select bool_and(t.tgfoid = 'private.record_clusters_change()'::regprocedure) from pg_trigger t where t.tgrelid in ('public.clusters'::regclass, 'public.cluster_cards'::regclass) and t.tgname ~ '_record_'), true, 'all six call private.record_clusters_change');
select is((select prosecdef and proconfig = array['search_path=""']::text[] from pg_proc where oid = 'private.record_clusters_change()'::regprocedure), true, 'record_clusters_change is security definer with an empty search_path');
select cluster_test.mark();
update public.clusters set name = name where id = '00000000-0000-4000-8000-000000000000';
select is(cluster_test.new_events(cluster_test.id('Q1')), '[]'::jsonb, 'a statement that changes no row records nothing');

-- ---------------------------------------------------------------------------
-- P0: a cluster in a collecting cycle, then closed from collecting.
-- ---------------------------------------------------------------------------
insert into public.clusters (id, cycle_id, name, sort_order)
values ('47000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000001', 'P0 cluster', 1);
insert into public.cluster_cards (cycle_id, cluster_id, card_id)
values ('37000000-0000-4000-8000-000000000001', '47000000-0000-4000-8000-000000000001', '57000000-0000-4000-8000-000000000001');
select cluster_test.mark();
select cluster_test.snap('P0 state', to_jsonb(cluster_test.state(cluster_test.id('P0'))));

set local role authenticated;
select is(cluster_test.wrong_stage(cluster_test.id('P0'), cluster_test.id('P0 cluster')), '{}'::text[], 'collecting: every RPC gets cycle_not_clustering');
select is(cluster_test.board('A', cluster_test.id('P0')) -> 'clusters', '[]'::jsonb, 'collecting: A''s clusters is []');
select is(cluster_test.board('B', cluster_test.id('P0')) -> 'clusters', '[]'::jsonb, 'collecting: B''s clusters is []');
select is(cluster_test.board('D', cluster_test.id('P0')) -> 'clusters', '[]'::jsonb, 'collecting: D''s clusters is []');
select cluster_test.close('A', cluster_test.id('P0'));
reset role;
select cluster_test.mark();
set local role authenticated;
select is(cluster_test.wrong_stage(cluster_test.id('P0'), cluster_test.id('P0 cluster')), '{}'::text[], 'closed from collecting: every RPC gets cycle_not_clustering');
select is(cluster_test.board('A', cluster_test.id('P0')) -> 'clusters', '[]'::jsonb, 'closed from collecting: A''s clusters is []');
select is(cluster_test.board('B', cluster_test.id('P0')) -> 'clusters', '[]'::jsonb, 'closed from collecting: B''s clusters is []');
select is(cluster_test.board('D', cluster_test.id('P0')) -> 'clusters', '[]'::jsonb, 'closed from collecting: D''s clusters is []');
reset role;
select is(to_jsonb(cluster_test.state(cluster_test.id('P0'))), cluster_test.snapped('P0 state'), 'collecting and closed: the cluster rows are unchanged');
select is(cluster_test.new_events(cluster_test.id('P0')), '[]'::jsonb, 'the refused calls on P0 record no event');

-- ---------------------------------------------------------------------------
-- P1: cards through create_card, revealed by A.
-- ---------------------------------------------------------------------------
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('37000000-0000-4000-8000-000000000002', '27000000-0000-4000-8000-000000000001', 'P main', '2026-10-26');
set local role authenticated;
select cluster_test.add_card('B', 'P1', 'start', 'B attributed', false);
select cluster_test.add_card('B', 'P1', 'stop', 'B anonymous', true);
select cluster_test.add_card('D', 'P1', 'continue', 'D attributed', false);
select cluster_test.add_card('A', 'P1', 'start', 'A anonymous', true);
select cluster_test.add_card('D', 'P1', 'stop', 'D anonymous', true);
select cluster_test.start('A', cluster_test.id('P1'));
reset role;

-- Reveal: a postgres cluster cannot be touched through the RPCs yet.
insert into public.clusters (id, cycle_id, name, sort_order)
values ('47000000-0000-4000-8000-000000000003', '37000000-0000-4000-8000-000000000002', 'Early', 7);
select cluster_test.mark();
select cluster_test.snap('P1 reveal state', to_jsonb(cluster_test.state(cluster_test.id('P1'))));
set local role authenticated;
select is(cluster_test.wrong_stage(cluster_test.id('P1'), cluster_test.id('Early')), '{}'::text[], 'reveal: every RPC gets cycle_not_clustering');
reset role;
select is(to_jsonb(cluster_test.state(cluster_test.id('P1'))), cluster_test.snapped('P1 reveal state'), 'reveal: the cluster rows are unchanged');
select is(cluster_test.new_events(cluster_test.id('P1')), '[]'::jsonb, 'reveal: the refused calls record no event');
delete from public.clusters where id = '47000000-0000-4000-8000-000000000003';

set local role authenticated;
select cluster_test.advance('A', cluster_test.id('P1'), 'reveal');
select is(cluster_test.board('B', cluster_test.id('P1')) -> 'clusters', '[]'::jsonb, 'cluster with no clusters: clusters is []');
reset role;
select cluster_test.mark();

-- ---------------------------------------------------------------------------
-- Create, order, and events.
-- ---------------------------------------------------------------------------
set local role authenticated;
select cluster_test.snap('Process row', cluster_test.mk('B', cluster_test.id('P1'), '  Process  ', 'Process'));
select is(
  cluster_test.snapped('Process row'),
  jsonb_build_array(jsonb_build_object('cluster_id', cluster_test.id('Process'), 'name', 'Process', 'source', 'manual')),
  'B creates "  Process  ": the call returns (id, Process, manual)'
);
reset role;
select is((cluster_test.row_of(cluster_test.id('Process')) ->> 'sort_order')::int, 1, 'Process has sort_order 1');
select is(cluster_test.new_events(cluster_test.id('P1')), cluster_test.one_event('cluster'), 'create_cluster records exactly one clusters_changed row with null actor and empty payload');
select cluster_test.mark();
set local role authenticated;
select is(cluster_test.mk('D', cluster_test.id('P1'), 'Tools', 'Tools') -> 0 ->> 'name', 'Tools', 'D creates Tools');
reset role;
select is((cluster_test.row_of(cluster_test.id('Tools')) ->> 'sort_order')::int, 2, 'Tools has sort_order 2');
select cluster_test.mark();
set local role authenticated;
select is(cluster_test.del('B', cluster_test.id('Process')), to_jsonb('ok'::text), 'B deletes the empty Process');
reset role;
select is(cluster_test.row_of(cluster_test.id('Process')), null, 'Process is gone');
select is(cluster_test.new_events(cluster_test.id('P1')), cluster_test.one_event('cluster'), 'deleting an empty cluster records exactly one event');
set local role authenticated;
select is(cluster_test.mk('A', cluster_test.id('P1'), 'Docs', 'Docs') -> 0 ->> 'name', 'Docs', 'A creates Docs');
reset role;
select is((cluster_test.row_of(cluster_test.id('Docs')) ->> 'sort_order')::int, 3, 'after deleting Process, Docs gets sort_order 3 (gaps are kept)');
select is(cluster_test.new_other_events(cluster_test.id('P1')), 0, 'no event for another cycle so far');

-- ---------------------------------------------------------------------------
-- A (owner and facilitator) and B (member) behave identically.
-- ---------------------------------------------------------------------------
set local role authenticated;
select cluster_test.snap('parity A', cluster_test.mk('A', cluster_test.id('P1'), 'Parity A', 'Parity A'));
select cluster_test.snap('parity B', cluster_test.mk('B', cluster_test.id('P1'), 'Parity B', 'Parity B'));
select is(
  jsonb_build_array(cluster_test.snapped('parity A') -> 0 ->> 'name', cluster_test.snapped('parity A') -> 0 ->> 'source', cluster_test.snapped('parity B') -> 0 ->> 'name', cluster_test.snapped('parity B') -> 0 ->> 'source'),
  '["Parity A", "manual", "Parity B", "manual"]'::jsonb,
  'A and B each create a manual cluster and get the same row shape'
);
select is(cluster_test.ren('A', cluster_test.id('Parity B'), 'Parity B by A') -> 0 ->> 'name', 'Parity B by A', 'A renames B''s cluster');
select is(cluster_test.ren('B', cluster_test.id('Parity A'), 'Parity A by B') -> 0 ->> 'name', 'Parity A by B', 'B renames A''s cluster');
select is(cluster_test.mk_err('A', cluster_test.id('P1'), 'parity a by b'), cluster_test.mk_err('B', cluster_test.id('P1'), 'parity a by b'), 'A and B get the same cluster_name_taken');
select is(cluster_test.mk_err('A', cluster_test.id('P1'), ''), cluster_test.mk_err('B', cluster_test.id('P1'), ''), 'A and B get the same invalid_cluster_name');
select is(cluster_test.ren_err('A', gen_random_uuid(), 'x'), cluster_test.ren_err('B', gen_random_uuid(), 'x'), 'A and B get the same cluster_not_found on rename');
select is(cluster_test.del('A', cluster_test.id('Parity B')), to_jsonb('ok'::text), 'A deletes the cluster B created');
select is(cluster_test.del('B', cluster_test.id('Parity A')), to_jsonb('ok'::text), 'B deletes the cluster A created');
select is(cluster_test.del('A', cluster_test.id('Parity A')), cluster_test.del('B', cluster_test.id('Parity B')), 'A and B get the same cluster_not_found on delete');
reset role;

-- ---------------------------------------------------------------------------
-- Names.
-- ---------------------------------------------------------------------------
select cluster_test.mark();
select cluster_test.snap('P1 names state', to_jsonb(cluster_test.state(cluster_test.id('P1'))));
set local role authenticated;
select is(cluster_test.mk_err('B', cluster_test.id('P1'), null), cluster_test.e('invalid_cluster_name'), 'a null name gets invalid_cluster_name');
select is(cluster_test.mk_err('B', cluster_test.id('P1'), ''), cluster_test.e('invalid_cluster_name'), 'an empty name gets invalid_cluster_name');
select is(cluster_test.mk_err('B', cluster_test.id('P1'), '   '), cluster_test.e('invalid_cluster_name'), 'a blank name gets invalid_cluster_name');
select is(cluster_test.mk_err('B', cluster_test.id('P1'), repeat('x', 101)), cluster_test.e('invalid_cluster_name'), 'a 101-character name gets invalid_cluster_name');
select is(cluster_test.mk_err('B', cluster_test.id('P1'), 'a' || E'\n' || 'b'), cluster_test.e('invalid_cluster_name'), 'a name with a line break gets invalid_cluster_name');
select is(cluster_test.mk_err('B', cluster_test.id('P1'), 'a' || E'\t' || 'b'), cluster_test.e('invalid_cluster_name'), 'a name with a tab inside gets invalid_cluster_name');
select is(cluster_test.mk_err('B', cluster_test.id('P1'), 'tools'), cluster_test.e('cluster_name_taken'), 'tools next to Tools gets cluster_name_taken');
select is(cluster_test.ren_err('B', cluster_test.id('Docs'), ' TOOLS '), cluster_test.e('cluster_name_taken'), 'renaming Docs to TOOLS gets cluster_name_taken');
select is(cluster_test.ren_err('B', cluster_test.id('Docs'), E'\t'), cluster_test.e('invalid_cluster_name'), 'renaming to a blank name gets invalid_cluster_name');
reset role;
select is(to_jsonb(cluster_test.state(cluster_test.id('P1'))), cluster_test.snapped('P1 names state'), 'refused names change nothing');
select is(cluster_test.new_events(cluster_test.id('P1')), '[]'::jsonb, 'refused names record no event');
set local role authenticated;
select is(cluster_test.mk('B', cluster_test.id('P1'), repeat('y', 100), 'Long') -> 0 ->> 'name', repeat('y', 100), 'exactly 100 characters succeeds');
select is(cluster_test.mk('B', cluster_test.id('P1'), 'Process', 'Process again') -> 0 ->> 'name', 'Process', 'Process can be created again after its delete');
select is(cluster_test.mk_err('B', cluster_test.id('P1'), 'PROCESS'), cluster_test.e('cluster_name_taken'), 'PROCESS next to Process gets cluster_name_taken');
select is(cluster_test.mk('B', cluster_test.id('P1'), 'Ungrouped', 'Ungrouped') -> 0 ->> 'name', 'Ungrouped', 'Ungrouped is an ordinary name on the server');
reset role;

-- ---------------------------------------------------------------------------
-- The 50-cluster limit.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(cluster_test.fill('B', cluster_test.id('P1'), 50), 50, 'B fills P1 up to 50 clusters');
reset role;
select cluster_test.mark();
set local role authenticated;
select is(cluster_test.mk_err('B', cluster_test.id('P1'), 'Fifty-first'), cluster_test.e('cluster_limit_reached'), 'the 51st create_cluster gets cluster_limit_reached');
select is(cluster_test.mk_err('A', cluster_test.id('P1'), 'Fifty-first'), cluster_test.e('cluster_limit_reached'), 'A gets cluster_limit_reached too');
select is(cluster_test.mk_err('B', cluster_test.id('P1'), 'tools'), cluster_test.e('cluster_name_taken'), 'at the limit, a taken name is still reported first');
reset role;
select is(cluster_test.cluster_count(cluster_test.id('P1')), 50, 'the cluster count stays 50');
select is(cluster_test.new_events(cluster_test.id('P1')), '[]'::jsonb, 'the refused 51st create records no event');
delete from public.clusters where cycle_id = '37000000-0000-4000-8000-000000000002' and name ~ '^Bulk ';

-- ---------------------------------------------------------------------------
-- Rename.
-- ---------------------------------------------------------------------------
insert into public.clusters (id, cycle_id, name, source, sort_order, updated_at)
values
  ('47000000-0000-4000-8000-000000000004', '37000000-0000-4000-8000-000000000002', 'AI one', 'ai', 90, '2020-01-01'),
  ('47000000-0000-4000-8000-000000000005', '37000000-0000-4000-8000-000000000002', 'AI two', 'ai', 91, '2020-01-01');
select cluster_test.mark();
set local role authenticated;
select is(
  cluster_test.ren('D', cluster_test.id('Tools'), ' Tooling '),
  jsonb_build_array(jsonb_build_object('cluster_id', cluster_test.id('Tools'), 'name', 'Tooling', 'source', 'manual')),
  'Tools -> Tooling returns the new name and source manual'
);
reset role;
select is(cluster_test.new_events(cluster_test.id('P1')), cluster_test.one_event('cluster'), 'a real rename records exactly one event');
set local role authenticated;
select is(cluster_test.ren('B', cluster_test.id('AI one'), 'AI renamed') -> 0 ->> 'source', 'manual', 'an AI cluster becomes manual when renamed');
reset role;
select is(cluster_test.row_of(cluster_test.id('AI one')) ->> 'source', 'manual', 'the stored source is manual');
select cluster_test.mark();
set local role authenticated;
select is(
  cluster_test.ren('B', cluster_test.id('AI two'), '  AI two  '),
  jsonb_build_array(jsonb_build_object('cluster_id', cluster_test.id('AI two'), 'name', 'AI two', 'source', 'ai')),
  'renaming to its own current name returns the row with source ai'
);
reset role;
select is((cluster_test.row_of(cluster_test.id('AI two')) ->> 'updated_at')::timestamptz, '2020-01-01'::timestamptz, 'the no-op rename leaves updated_at unchanged');
select is(cluster_test.row_of(cluster_test.id('AI two')) ->> 'source', 'ai', 'the no-op rename leaves source ai');
select is(cluster_test.new_events(cluster_test.id('P1')), '[]'::jsonb, 'the no-op rename records no event');
set local role authenticated;
select is(cluster_test.ren('B', cluster_test.id('Tools'), 'tooling') -> 0 ->> 'name', 'tooling', 'Tooling -> tooling (case only) is a real rename');
reset role;
select is(cluster_test.new_events(cluster_test.id('P1')), cluster_test.one_event('cluster'), 'the case-only rename records an event');
set local role authenticated;
select is(cluster_test.ren('B', cluster_test.id('Tools'), 'Tooling') -> 0 ->> 'name', 'Tooling', 'tooling -> Tooling (case only) is a real rename');
select is(cluster_test.ren_err('B', cluster_test.id('Tools'), 'ai TWO'), cluster_test.e('cluster_name_taken'), 'renaming to another cluster''s name in any case gets cluster_name_taken');
reset role;
select is(cluster_test.row_of(cluster_test.id('Tools')) ->> 'name', 'Tooling', 'the refused rename keeps the name');

-- ---------------------------------------------------------------------------
-- Delete with cards; postgres membership writes record events.
-- ---------------------------------------------------------------------------
select cluster_test.mark();
insert into public.cluster_cards (cycle_id, cluster_id, card_id, sort_order)
values
  ('37000000-0000-4000-8000-000000000002', '47000000-0000-4000-8000-000000000004', (select id from cluster_test.ids where label = 'B attributed'), 0),
  ('37000000-0000-4000-8000-000000000002', '47000000-0000-4000-8000-000000000004', (select id from cluster_test.ids where label = 'A anonymous'), 1);
select is(cluster_test.new_events(cluster_test.id('P1')), cluster_test.one_event('cluster'), 'inserting cluster_cards rows as postgres in one statement adds one clusters_changed row');
select cluster_test.snap('cards before delete', to_jsonb(cluster_test.cards_md5()));
select cluster_test.mark();
set local role authenticated;
select is(cluster_test.del('D', cluster_test.id('AI one')), to_jsonb('ok'::text), 'D deletes the cluster with two cards');
reset role;
select is(cluster_test.row_of(cluster_test.id('AI one')), null, 'the cluster is gone');
select is((select count(*)::int from public.cluster_cards where cluster_id = '47000000-0000-4000-8000-000000000004'), 0, 'both cluster_cards rows are gone');
select is(to_jsonb(cluster_test.cards_md5()), cluster_test.snapped('cards before delete'), 'both cards still exist with unchanged text');
select ok(jsonb_array_length(cluster_test.new_events(cluster_test.id('P1'))) between 1 and 2, 'deleting a cluster with cards adds one or two events');
select is((select count(*)::int from jsonb_array_elements(cluster_test.new_events(cluster_test.id('P1'))) e where e <> cluster_test.one_event('cluster') -> 0), 0, 'every one of them is a clusters_changed row with null actor and empty payload');
set local role authenticated;
select is(
  (select count(*)::int from jsonb_array_elements(cluster_test.board('B', cluster_test.id('P1')) -> 'clusters') c cross join jsonb_array_elements_text(c -> 'card_ids') x where x::uuid in (cluster_test.id('B attributed'), cluster_test.id('A anonymous'))),
  0,
  'the cards appear in no cluster''s card_ids'
);

-- ---------------------------------------------------------------------------
-- Access.
-- ---------------------------------------------------------------------------
reset role;
select cluster_test.mark();
set local role authenticated;
select is(cluster_test.mk_err(null, cluster_test.id('P1'), 'Nobody'), cluster_test.e('not_project_member'), 'null auth.uid(): create gets not_project_member');
select is(cluster_test.ren_err(null, cluster_test.id('Docs'), 'Nobody'), cluster_test.e('not_project_member'), 'null auth.uid(): rename gets not_project_member');
select is(cluster_test.del(null, cluster_test.id('Docs')), cluster_test.e('not_project_member'), 'null auth.uid(): delete gets not_project_member');
select is(cluster_test.mk_err('B', null, 'Null cycle'), cluster_test.e('not_project_member'), 'create with a null cycle id gets not_project_member');
select is(cluster_test.mk_err('B', gen_random_uuid(), 'Random cycle'), cluster_test.e('not_project_member'), 'create with a random cycle id gets not_project_member');
select is(cluster_test.mk_err('B', cluster_test.id('Q1'), 'Other project'), cluster_test.e('not_project_member'), 'create on a cycle of project Q gets not_project_member');
select is(cluster_test.mk_err('C', cluster_test.id('P1'), 'Outsider'), cluster_test.e('not_project_member'), 'non-member C gets not_project_member on create');
select is(cluster_test.ren_err('B', null, 'x'), cluster_test.e('cluster_not_found'), 'rename with a null id gets cluster_not_found');
select is(cluster_test.ren_err('B', gen_random_uuid(), 'x'), cluster_test.e('cluster_not_found'), 'rename with a random id gets cluster_not_found');
select is(cluster_test.ren_err('C', cluster_test.id('Docs'), 'x'), cluster_test.e('cluster_not_found'), 'non-member C gets cluster_not_found renaming P''s cluster');
select is(cluster_test.ren_err('B', cluster_test.id('Q cluster'), 'x'), cluster_test.e('cluster_not_found'), 'B gets cluster_not_found renaming Q''s cluster');
select is(cluster_test.del('B', null), cluster_test.e('cluster_not_found'), 'delete with a null id gets cluster_not_found');
select is(cluster_test.del('B', gen_random_uuid()), cluster_test.e('cluster_not_found'), 'delete with a random id gets cluster_not_found');
select is(cluster_test.del('C', cluster_test.id('Docs')), cluster_test.e('cluster_not_found'), 'non-member C gets cluster_not_found deleting P''s cluster');
select is(cluster_test.ren_err('C', cluster_test.id('Docs'), 'x'), cluster_test.ren_err('C', gen_random_uuid(), 'x'), 'the rename error is identical for an existing and a random id');
select is(cluster_test.del('C', cluster_test.id('Docs')), cluster_test.del('C', gen_random_uuid()), 'the delete error is identical for an existing and a random id');
select is(cluster_test.del('B', cluster_test.id('Ungrouped')), to_jsonb('ok'::text), 'B deletes Ungrouped');
select is(cluster_test.ren_err('B', cluster_test.id('Ungrouped'), 'Back'), cluster_test.e('cluster_not_found'), 'renaming a deleted cluster gets cluster_not_found');
select is(cluster_test.del('B', cluster_test.id('Ungrouped')), cluster_test.e('cluster_not_found'), 'deleting it again gets cluster_not_found');
reset role;
select is(cluster_test.row_of(cluster_test.id('Docs')) ->> 'name', 'Docs', 'the refused calls leave Docs unchanged');
select is(
  (select count(*)::int from jsonb_array_elements(cluster_test.new_events(cluster_test.id('P1'))) e where e ->> 'type' = 'clusters_changed'),
  1,
  'the refused access calls add no event (only the delete of Ungrouped did)'
);
select is(cluster_test.new_other_events(cluster_test.id('P1')), 0, 'no cluster write in P1 recorded an event for another cycle');
select is(
  (select count(*)::int from public.cycle_events e where e.cycle_id = '37000000-0000-4000-8000-000000000002' and e.type = 'stage_changed'),
  2,
  'P1 has only its two stage_changed rows: no cluster write added one'
);

-- ---------------------------------------------------------------------------
-- The board's clusters key.
-- ---------------------------------------------------------------------------
delete from public.clusters where cycle_id = '37000000-0000-4000-8000-000000000002';
insert into public.clusters (id, cycle_id, name, sort_order)
values
  ('1c170000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000002', 'Third', 3),
  ('3a170000-0000-4000-8000-000000000002', '37000000-0000-4000-8000-000000000002', 'First', 1),
  ('2b170000-0000-4000-8000-000000000003', '37000000-0000-4000-8000-000000000002', 'Second', 2);
-- First: A anonymous at sort_order -1, then B attributed and D attributed
-- tied at 0 (card_id decides). Third: B anonymous. Second is empty.
insert into public.cluster_cards (cycle_id, cluster_id, card_id, sort_order)
values
  ('37000000-0000-4000-8000-000000000002', '3a170000-0000-4000-8000-000000000002', (select id from cluster_test.ids where label = 'B attributed'), 0),
  ('37000000-0000-4000-8000-000000000002', '3a170000-0000-4000-8000-000000000002', (select id from cluster_test.ids where label = 'A anonymous'), -1),
  ('37000000-0000-4000-8000-000000000002', '3a170000-0000-4000-8000-000000000002', (select id from cluster_test.ids where label = 'D attributed'), 0),
  ('37000000-0000-4000-8000-000000000002', '1c170000-0000-4000-8000-000000000001', (select id from cluster_test.ids where label = 'B anonymous'), 0);

set local role authenticated;
select cluster_test.snap('board A', cluster_test.board('A', cluster_test.id('P1')));
select cluster_test.snap('board B', cluster_test.board('B', cluster_test.id('P1')));
select cluster_test.snap('board D', cluster_test.board('D', cluster_test.id('P1')));
reset role;
select is(cluster_test.keys(cluster_test.snapped('board A')), array['cards', 'clusters', 'cycle_id', 'is_revealed', 'status'], 'the response has exactly five top-level keys');
select is(
  (select count(*)::int from jsonb_array_elements(cluster_test.snapped('board A') -> 'clusters') c where cluster_test.keys(c) is distinct from array['card_ids', 'cluster_id', 'name', 'source']),
  0,
  'each cluster has exactly card_ids, cluster_id, name, source'
);
select is(cluster_test.names(cluster_test.snapped('board A')), array['First', 'Second', 'Third'], 'clusters are ordered by sort_order, not by id');
select is(
  cluster_test.card_ids_of(cluster_test.snapped('board A'), 'First'),
  array[
    cluster_test.id('A anonymous'),
    least(cluster_test.id('B attributed'), cluster_test.id('D attributed')),
    greatest(cluster_test.id('B attributed'), cluster_test.id('D attributed'))
  ],
  'card_ids are ordered by cluster_cards.sort_order, then card_id'
);
select is((select c -> 'card_ids' from jsonb_array_elements(cluster_test.snapped('board A') -> 'clusters') c where c ->> 'name' = 'Second'), '[]'::jsonb, 'an empty cluster has card_ids = []');
select is(
  (select c from jsonb_array_elements(cluster_test.snapped('board A') -> 'clusters') c where c ->> 'name' = 'Third'),
  jsonb_build_object('cluster_id', cluster_test.id('Third'), 'name', 'Third', 'source', 'manual', 'card_ids', jsonb_build_array(cluster_test.id('B anonymous'))),
  'a cluster object carries its id, name, source, and card ids'
);
select is(
  (select count(*)::int from jsonb_array_elements(cluster_test.snapped('board A') -> 'clusters') c cross join jsonb_array_elements_text(c -> 'card_ids') x
    where x not in (select y ->> 'card_id' from jsonb_array_elements(cluster_test.snapped('board A') -> 'cards') y)),
  0,
  'every id in any card_ids appears in cards'
);
select is(
  (select count(*)::int - count(distinct x)::int from jsonb_array_elements(cluster_test.snapped('board A') -> 'clusters') c cross join jsonb_array_elements_text(c -> 'card_ids') x),
  0,
  'no card id appears in two clusters'
);
select is(cluster_test.snapped('board B') -> 'clusters', cluster_test.snapped('board A') -> 'clusters', 'A and B receive identical clusters');
select is(cluster_test.snapped('board D') -> 'clusters', cluster_test.snapped('board A') -> 'clusters', 'A and D receive identical clusters');
select is(cluster_test.anon_cards(cluster_test.snapped('board B')), cluster_test.anon_cards(cluster_test.snapped('board A')), 'anonymous cards are identical for A and B, clustered ones included');
select is(cluster_test.anon_cards(cluster_test.snapped('board D')), cluster_test.anon_cards(cluster_test.snapped('board A')), 'anonymous cards are identical for A and D, clustered ones included');
select is(
  (select count(*)::int from jsonb_array_elements(cluster_test.anon_cards(cluster_test.snapped('board A'))) c where cluster_test.keys(c) is distinct from array['card_id', 'category', 'is_anonymous', 'text']),
  0,
  'anonymous cards still have exactly four keys'
);
select is(jsonb_array_length(cluster_test.anon_cards(cluster_test.snapped('board A'))), 3, 'the three anonymous cards are on the board, two of them in clusters');
select is(cluster_test.forbidden(cluster_test.snapped('board A')) || cluster_test.forbidden(cluster_test.snapped('board B')) || cluster_test.forbidden(cluster_test.snapped('board D')), null, 'no created_at, updated_at, sort_order, actor_id, author_id, user_id, or email key anywhere');
select is(
  (select count(*)::int from cluster_test.ids i cross join unnest(array['board A', 'board B', 'board D']) b
    where i.label in ('A', 'B', 'C', 'D') and cluster_test.snapped(b)::text ~ i.id::text),
  0,
  'no user id appears anywhere in the responses'
);
select is((select count(*)::int from unnest(array['board A', 'board B', 'board D']) b where cluster_test.snapped(b)::text ~* '(@example\.com|created_at|updated_at|sort_order)'), 0, 'no email or time text appears anywhere in the responses');

-- ---------------------------------------------------------------------------
-- vote, discuss, and closed: clusters are frozen.
-- ---------------------------------------------------------------------------
set local role authenticated;
select cluster_test.advance('A', cluster_test.id('P1'), 'cluster');
reset role;
select cluster_test.mark();
select cluster_test.snap('P1 frozen state', to_jsonb(cluster_test.state(cluster_test.id('P1'))));
set local role authenticated;
select is(cluster_test.wrong_stage(cluster_test.id('P1'), cluster_test.id('First')), '{}'::text[], 'vote: every RPC gets cycle_not_clustering');
select is(cluster_test.names(cluster_test.board('B', cluster_test.id('P1'))), array['First', 'Second', 'Third'], 'vote: the board still lists the clusters');
reset role;
update public.feedback_cycles set status = 'discuss', voting_closed_at = now() where id = '37000000-0000-4000-8000-000000000002';
select cluster_test.mark();
set local role authenticated;
select is(cluster_test.wrong_stage(cluster_test.id('P1'), cluster_test.id('First')), '{}'::text[], 'discuss: every RPC gets cycle_not_clustering');
select cluster_test.close('A', cluster_test.id('P1'));
reset role;
select cluster_test.mark();
set local role authenticated;
select is(cluster_test.wrong_stage(cluster_test.id('P1'), cluster_test.id('First')), '{}'::text[], 'closed after reveal: every RPC gets cycle_not_clustering');
reset role;
select is(to_jsonb(cluster_test.state(cluster_test.id('P1'))), cluster_test.snapped('P1 frozen state'), 'vote, discuss, and closed: the cluster rows are unchanged');
select is(cluster_test.new_events(cluster_test.id('P1')), '[]'::jsonb, 'the refused calls in vote, discuss, and closed record no event');

select * from finish();
rollback;
