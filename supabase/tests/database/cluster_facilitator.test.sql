-- pgTAP tests for #19b: only the project's current facilitator may create,
-- rename, delete, move, merge, and split clusters. Covers the hardening of
-- the six redefined RPCs, the refusals for members, the owner when not the
-- facilitator, and a former facilitator, the unchanged errors for non-members
-- and unknown ids, the facilitator's successes and wrong-stage errors, and the
-- events.
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension and the cf_test helper schema. The seed user is never
-- used as a fixture.
--
-- Fixtures: owner A (facilitator by default), members B and D, non-member C.
-- P is owned by A with B and D joined; Q is owned by C. P0 (P) has cards
-- through create_card and clusters inserted as postgres; it is checked in
-- collecting and reveal and then closed. P1 (P) is the main cycle: cards from
-- A, B, and D (attributed and anonymous) through create_card, revealed and
-- moved to cluster by A, with clusters made through the RPCs; then vote,
-- discuss (as postgres), and closed. Q1 (Q) is C's, in cluster.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(125);

-- ---------------------------------------------------------------------------
-- Test-only helpers. The ones that call RPCs are security invoker; the
-- read-back helpers are security definer so they see every row.
-- ---------------------------------------------------------------------------
create schema cf_test;

create table cf_test.ids (label text primary key, id uuid not null);
create table cf_test.snaps (label text primary key, body jsonb);
create table cf_test.seen (id uuid primary key);

insert into cf_test.ids (label, id)
values
  ('A', '1f000000-0000-4000-8000-000000000001'),
  ('B', '1f000000-0000-4000-8000-000000000002'),
  ('C', '1f000000-0000-4000-8000-000000000003'),
  ('D', '1f000000-0000-4000-8000-000000000004'),
  ('P', '2f000000-0000-4000-8000-000000000001'),
  ('Q', '2f000000-0000-4000-8000-000000000002'),
  ('P0', '3f000000-0000-4000-8000-000000000001'),
  ('P1', '3f000000-0000-4000-8000-000000000002'),
  ('Q1', '3f000000-0000-4000-8000-000000000011'),
  ('P0 one', '4f000000-0000-4000-8000-000000000001'),
  ('P0 two', '4f000000-0000-4000-8000-000000000002'),
  ('Q one', '4f000000-0000-4000-8000-000000000011'),
  ('Q two', '4f000000-0000-4000-8000-000000000012'),
  ('q1', '5f000000-0000-4000-8000-000000000011'),
  ('q2', '5f000000-0000-4000-8000-000000000012');

create function cf_test.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from cf_test.ids i where i.label = p_label;
$$;

create function cf_test.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', cf_test.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- The error a refused call gets, with empty detail and hint.
create function cf_test.e(p_message text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'code', case when p_message in ('not_project_member', 'not_project_facilitator') then '42501' else 'P0001' end,
    'message', p_message,
    'detail', '',
    'hint', ''
  );
$$;

-- One of the six RPCs as the user with raw ids: "ok", or the full error.
-- create: p_a = cycle; rename: p_a = cluster; delete: p_a = cluster;
-- move: p_a = card, p_b = target cluster (null = Ungrouped), p_position;
-- merge: p_a = source, p_b = target; split: p_a = cluster, p_cards.
create function cf_test.call(
  p_user text,
  p_op text,
  p_a uuid,
  p_b uuid default null,
  p_cards uuid[] default null,
  p_name text default null,
  p_position integer default null
)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform cf_test.become(p_user);
  case p_op
    when 'create' then perform 1 from public.create_cluster(p_a, p_name);
    when 'rename' then perform 1 from public.rename_cluster(p_a, p_name);
    when 'delete' then perform public.delete_cluster(p_a);
    when 'move' then perform public.move_card(p_a, p_b, p_position);
    when 'merge' then perform 1 from public.merge_clusters(p_a, p_b);
    when 'split' then perform 1 from public.split_cluster(p_a, p_cards, p_name);
  end case;
  return to_jsonb('ok'::text);
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

-- create_cluster as the user; stores the new id under the name.
create function cf_test.mk(p_user text, p_cycle text, p_name text)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform cf_test.become(p_user);
  select r.cluster_id into strict new_id from public.create_cluster(cf_test.id(p_cycle), p_name) r;
  insert into cf_test.ids (label, id) values (p_name, new_id)
  on conflict (label) do update set id = excluded.id;
  return new_id;
end;
$$;

-- Each of the six RPCs once, as the user, on valid ids that would succeed in
-- the cluster stage: create in the cycle, rename and split the cluster
-- p_full (two or more cards), merge p_other into p_full, delete p_other, and
-- move the card p_card into p_full. Returns {op: result}.
create function cf_test.each(p_user text, p_cycle text, p_full text, p_other text, p_card text, p_split_card text)
returns jsonb
language plpgsql
as $$
begin
  return jsonb_build_object(
    'create', cf_test.call(p_user, 'create', cf_test.id(p_cycle), p_name => 'Brand new'),
    'rename', cf_test.call(p_user, 'rename', cf_test.id(p_full), p_name => 'Renamed'),
    'delete', cf_test.call(p_user, 'delete', cf_test.id(p_other)),
    'move', cf_test.call(p_user, 'move', cf_test.id(p_card), cf_test.id(p_full)),
    'merge', cf_test.call(p_user, 'merge', cf_test.id(p_other), cf_test.id(p_full)),
    'split', cf_test.call(p_user, 'split', cf_test.id(p_full), p_cards => array[cf_test.id(p_split_card)], p_name => 'Split off')
  );
end;
$$;

-- The ops of an each() result whose value is not the expected one.
create function cf_test.differs(p_results jsonb, p_expected jsonb)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(k order by k), '{}') from jsonb_each(p_results) r(k, v) where v is distinct from p_expected;
$$;

create function cf_test.transfer(p_user text, p_to text)
returns void
language plpgsql
as $$
begin
  perform cf_test.become(p_user);
  perform public.transfer_facilitator(cf_test.id('P'), cf_test.id(p_to));
end;
$$;

create function cf_test.add_card(p_user text, p_cycle text, p_category text, p_label text, p_anonymous boolean)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform cf_test.become(p_user);
  select c.id into strict new_id
    from public.create_card(cf_test.id(p_cycle), p_category, p_label, p_anonymous) c;
  insert into cf_test.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

create function cf_test.start(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform cf_test.become(p_user);
  perform 1 from public.start_retrospective(cf_test.id(p_cycle));
end;
$$;

create function cf_test.advance(p_user text, p_cycle text, p_from text)
returns void
language plpgsql
as $$
begin
  perform cf_test.become(p_user);
  perform 1 from public.advance_stage(cf_test.id(p_cycle), p_from);
end;
$$;

create function cf_test.close(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform cf_test.become(p_user);
  perform 1 from public.close_cycle(cf_test.id(p_cycle));
end;
$$;

create function cf_test.board(p_user text, p_cycle text)
returns jsonb
language plpgsql
as $$
begin
  perform cf_test.become(p_user);
  return public.get_cycle_board(cf_test.id(p_cycle));
end;
$$;

-- Every clusters and cluster_cards row and every event, as text: a refused
-- call must leave this byte-identical.
create function cf_test.state()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select string_agg(to_jsonb(cl)::text, '|' order by cl.id) from public.clusters cl), '')
    || '#'
    || coalesce((select string_agg(to_jsonb(cc)::text, '|' order by cc.card_id) from public.cluster_cards cc), '')
    || '#'
    || coalesce((select string_agg(to_jsonb(e)::text, '|' order by e.id) from public.cycle_events e), '');
$$;

create function cf_test.mark()
returns void
language sql
security definer
set search_path = ''
as $$
  insert into cf_test.seen (id)
  select e.id from public.cycle_events e
  on conflict do nothing;
$$;

-- The unseen events, without id, cycle_id, and created_at.
create function cf_test.new_events()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) - 'id' - 'cycle_id' - 'created_at' order by e.created_at, e.id),
    '[]'::jsonb
  )
  from public.cycle_events e
  where not exists (select 1 from cf_test.seen s where s.id = e.id);
$$;

create function cf_test.snap(p_label text, p_body jsonb)
returns void
language sql
as $$
  insert into cf_test.snaps (label, body) values (p_label, p_body)
  on conflict (label) do update set body = excluded.body;
$$;

create function cf_test.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.body from cf_test.snaps s where s.label = p_label;
$$;

grant usage on schema cf_test to authenticated;
grant select, insert, update on all tables in schema cf_test to authenticated;
grant execute on all functions in schema cf_test to authenticated;

-- The id of a cluster of a cycle by name, read as postgres (the clusters
-- table is default-deny).
create function cf_test.cluster_id_by_name(p_cycle uuid, p_name text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select cl.id from public.clusters cl where cl.cycle_id = p_cycle and cl.name = p_name;
$$;
grant execute on function cf_test.cluster_id_by_name(uuid, text) to authenticated;

-- A full successful run of all six as the user in P1 over the ungrouped cards
-- u1 and u2. Leaves no cluster of its own behind and u1 and u2 ungrouped.
-- Returns each step's result.
create function cf_test.run(p_user text, p_tag text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := '{}'::jsonb;
  one_id uuid;
  two_id uuid;
begin
  result := result || jsonb_build_object('create', cf_test.call(p_user, 'create', cf_test.id('P1'), p_name => p_tag || ' one'));
  one_id := cf_test.cluster_id_by_name(cf_test.id('P1'), p_tag || ' one');
  result := result || jsonb_build_object('rename', cf_test.call(p_user, 'rename', one_id, p_name => p_tag || ' renamed'));
  result := result || jsonb_build_object('move', cf_test.call(p_user, 'move', cf_test.id('u1'), one_id));
  perform cf_test.call(p_user, 'move', cf_test.id('u2'), one_id);
  result := result || jsonb_build_object('split', cf_test.call(p_user, 'split', one_id, p_cards => array[cf_test.id('u2')], p_name => p_tag || ' two'));
  two_id := cf_test.cluster_id_by_name(cf_test.id('P1'), p_tag || ' two');
  result := result || jsonb_build_object('merge', cf_test.call(p_user, 'merge', two_id, one_id));
  result := result || jsonb_build_object('delete', cf_test.call(p_user, 'delete', one_id));
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures. The token columns are empty strings, as the Auth server writes
-- them.
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', '1f000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'cf-a@example.com', '{"display_name":"Alice"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '1f000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'cf-b@example.com', '{"display_name":"Bob"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '1f000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'cf-c@example.com', '{"display_name":"Cara"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '1f000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'cf-d@example.com', '{"display_name":"Dan"}', '', '', '', '');

insert into public.projects (id, name, owner_id)
values
  ('2f000000-0000-4000-8000-000000000001', 'Project P', '1f000000-0000-4000-8000-000000000001'),
  ('2f000000-0000-4000-8000-000000000002', 'Project Q', '1f000000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('2f000000-0000-4000-8000-000000000001', '1f000000-0000-4000-8000-000000000002', 'member'),
  ('2f000000-0000-4000-8000-000000000001', '1f000000-0000-4000-8000-000000000004', 'member');

-- Q1: C's cycle in cluster, with two clusters and two cards (as postgres), so
-- P's members can be given existing ids of another project.
insert into public.feedback_cycles (id, project_id, title, week_start, status, revealed_at)
values ('3f000000-0000-4000-8000-000000000011', '2f000000-0000-4000-8000-000000000002', 'Q one', '2026-10-26', 'cluster', now());
insert into public.cards (id, cycle_id, category, text)
values
  ('5f000000-0000-4000-8000-000000000011', '3f000000-0000-4000-8000-000000000011', 'start', 'Q card one'),
  ('5f000000-0000-4000-8000-000000000012', '3f000000-0000-4000-8000-000000000011', 'stop', 'Q card two');
insert into public.clusters (id, cycle_id, name, sort_order)
values
  ('4f000000-0000-4000-8000-000000000011', '3f000000-0000-4000-8000-000000000011', 'Q one', 1),
  ('4f000000-0000-4000-8000-000000000012', '3f000000-0000-4000-8000-000000000011', 'Q two', 2);
insert into public.cluster_cards (cycle_id, cluster_id, card_id, sort_order)
values
  ('3f000000-0000-4000-8000-000000000011', '4f000000-0000-4000-8000-000000000011', '5f000000-0000-4000-8000-000000000011', 0),
  ('3f000000-0000-4000-8000-000000000011', '4f000000-0000-4000-8000-000000000011', '5f000000-0000-4000-8000-000000000012', 1);

-- ---------------------------------------------------------------------------
-- Hardening: one row per redefined function.
-- ---------------------------------------------------------------------------
create table cf_test.rpcs (fn regprocedure primary key, name text not null, args text not null, result text not null, messages text[] not null);
insert into cf_test.rpcs (fn, name, args, result, messages)
values
  ('public.create_cluster(uuid, text)', 'create_cluster', 'p_cycle_id uuid, p_name text', 'TABLE(cluster_id uuid, name text, source text)',
   array['cluster_limit_reached', 'cluster_name_taken', 'cycle_not_clustering', 'invalid_cluster_name', 'not_project_facilitator', 'not_project_member']),
  ('public.rename_cluster(uuid, text)', 'rename_cluster', 'p_cluster_id uuid, p_name text', 'TABLE(cluster_id uuid, name text, source text)',
   array['cluster_name_taken', 'cluster_not_found', 'cycle_not_clustering', 'invalid_cluster_name', 'not_project_facilitator', 'not_project_member']),
  ('public.delete_cluster(uuid)', 'delete_cluster', 'p_cluster_id uuid', 'void',
   array['cluster_not_found', 'cycle_not_clustering', 'not_project_facilitator', 'not_project_member']),
  ('public.move_card(uuid, uuid, integer)', 'move_card', 'p_card_id uuid, p_cluster_id uuid, p_position integer', 'void',
   array['card_not_found', 'cluster_not_found', 'cycle_not_clustering', 'invalid_card_position', 'not_project_facilitator', 'not_project_member']),
  ('public.merge_clusters(uuid, uuid)', 'merge_clusters', 'p_source_cluster_id uuid, p_target_cluster_id uuid', 'TABLE(cluster_id uuid, name text, source text)',
   array['cannot_merge_into_self', 'cluster_not_found', 'cycle_not_clustering', 'not_project_facilitator', 'not_project_member']),
  ('public.split_cluster(uuid, uuid[], text)', 'split_cluster', 'p_cluster_id uuid, p_card_ids uuid[], p_name text', 'TABLE(cluster_id uuid, name text, source text)',
   array['card_not_in_cluster', 'cluster_limit_reached', 'cluster_name_taken', 'cluster_not_found', 'cycle_not_clustering', 'invalid_card_selection', 'invalid_cluster_name', 'not_project_facilitator', 'not_project_member', 'split_takes_all_cards']);

select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = r.name), 1, r.name || ' has exactly one overload') from cf_test.rpcs r order by r.name;
select is(pg_get_function_identity_arguments(r.fn) || ' -> ' || pg_get_function_result(r.fn), r.args || ' -> ' || r.result, r.name || ' keeps its arguments and return type') from cf_test.rpcs r order by r.name;
select is((select p.prosecdef and p.provolatile = 'v' and p.proconfig = array['search_path=""']::text[] from pg_proc p where p.oid = r.fn), true, r.name || ' is security definer, volatile, and fixes search_path to empty') from cf_test.rpcs r order by r.name;
select is(
  array[has_function_privilege('authenticated', r.fn, 'EXECUTE'), has_function_privilege('anon', r.fn, 'EXECUTE'), has_function_privilege('service_role', r.fn, 'EXECUTE'), (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = r.fn)],
  array[true, false, false, false],
  r.name || ' is executable by authenticated only (not PUBLIC, anon, or service_role)'
) from cf_test.rpcs r order by r.name;
select is(
  (select
     strpos(p.prosrc, 'private.is_project_member(cycle_project)') > 0
     and strpos(p.prosrc, 'private.is_project_member(cycle_project)') < strpos(p.prosrc, 'from public.projects p where p.id = cycle_project for share')
     and strpos(p.prosrc, 'from public.projects p where p.id = cycle_project for share') < strpos(p.prosrc, 'if not private.is_project_facilitator(cycle_project)')
   from pg_proc p where p.oid = r.fn),
  true,
  r.name || ': the membership check, then projects FOR SHARE, then the facilitator check'
) from cf_test.rpcs r order by r.name;
select is(
  (select
     regexp_instr(p.prosrc, 'from public\.feedback_cycles fc\s+where fc\.id = \w+\s+for update;') > strpos(p.prosrc, 'if not private.is_project_facilitator(cycle_project)')
     and p.prosrc ~ 'if not private\.is_project_facilitator\(cycle_project\) then\s+raise exception using errcode = ''42501'', message = ''not_project_facilitator'';'
   from pg_proc p where p.oid = r.fn),
  true,
  r.name || ': the facilitator check raises 42501 not_project_facilitator before the cycle row FOR UPDATE'
) from cf_test.rpcs r order by r.name;
select is(
  (select array_agg(distinct m.msg[1]::text order by m.msg[1]::text) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'message\s*=\s*''([^'']*)''', 'g') as m(msg) where p.oid = r.fn),
  r.messages,
  r.name || ' raises exactly its earlier messages plus not_project_facilitator'
) from cf_test.rpcs r order by r.name;
select is(
  (select (select count(*) from regexp_matches(p.prosrc, '\mraise\M', 'gi')) = (select count(*) from regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''[a-z_]+'';', 'g')) from pg_proc p where p.oid = r.fn),
  true,
  r.name || ': every raise sets only the code and a stable message, with no detail or hint'
) from cf_test.rpcs r order by r.name;
select is((select p.prosrc ~* '(owner_id|card_authors|profiles|cycle_events|execute|raise\s+notice)' from pg_proc p where p.oid = r.fn), false, r.name || ' mentions no owner_id, card_authors, profiles, cycle_events, execute, or raise notice') from cf_test.rpcs r order by r.name;
select is((select (select count(*)::int from regexp_matches(p.prosrc, 'is_project_facilitator', 'g')) from pg_proc p where p.oid = r.fn), 1, r.name || ' checks the facilitator exactly once') from cf_test.rpcs r order by r.name;

select is((select md5(prosrc) from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), 'a652b8eee54255a3b19a6448c77fc9ee', 'get_cycle_board is unchanged');
select is(
  -- ai_runs and votes are added by #20's and #22's later migrations, not by this one.
  (select string_agg(table_name, ',' order by table_name) from information_schema.tables where table_schema = 'public' and table_name not in ('ai_runs', 'votes')),
  'card_authors,cards,cluster_cards,clusters,cycle_events,feedback_cycles,profiles,project_invites,project_members,projects',
  'no table or view is added to public'
);
select is(
  (select md5(string_agg(table_name || '.' || column_name || ':' || data_type, ',' order by table_name, ordinal_position)) from information_schema.columns where table_schema = 'public' and table_name not in ('ai_runs', 'votes')),
  'e519634cb52f8c0b7a540df3f7a00978',
  'no column is added or changed in public'
);
select is(
  (select string_agg(tablename || ':' || policyname, ',' order by tablename, policyname) from pg_policies where schemaname = 'public'),
  'cycle_events:cycle_events_select_member,feedback_cycles:feedback_cycles_select_member,profiles:profiles_select_own,profiles:profiles_update_own,project_members:project_members_select_member,projects:projects_insert_own,projects:projects_select_member,projects:projects_update_own',
  'no policy is added'
);
select is(
  (select string_agg(r || ':' || t || ':' || p, ',' order by r, t, p) from unnest(array['anon', 'authenticated']) r cross join (select 'public.' || table_name t from information_schema.tables where table_schema = 'public') x cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege(r, t, p)),
  'authenticated:public.cycle_events:SELECT,authenticated:public.feedback_cycles:SELECT,authenticated:public.profiles:SELECT,authenticated:public.project_members:SELECT,authenticated:public.projects:SELECT',
  'no table grant is added for anon or authenticated'
);
select is((select array_agg(tablename::text order by tablename) from pg_publication_tables where pubname = 'supabase_realtime'), array['cycle_events'], 'supabase_realtime still publishes only cycle_events');
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname ~ 'facilitator'),
  array['is_project_facilitator', 'restore_project_facilitator'],
  'no new facilitator helper is added'
);

-- ---------------------------------------------------------------------------
-- P0: collecting and reveal, clusters inserted as postgres. A member and the
-- non-facilitator owner are refused; the facilitator gets cycle_not_clustering.
-- ---------------------------------------------------------------------------
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('3f000000-0000-4000-8000-000000000001', '2f000000-0000-4000-8000-000000000001', 'P early', '2026-10-12');
set local role authenticated;
select cf_test.add_card('A', 'P0', 'start', 'p0a', false);
select cf_test.add_card('B', 'P0', 'stop', 'p0b', true);
select cf_test.add_card('D', 'P0', 'continue', 'p0c', false);
reset role;
insert into public.clusters (id, cycle_id, name, sort_order)
values
  ('4f000000-0000-4000-8000-000000000001', '3f000000-0000-4000-8000-000000000001', 'P0 one', 1),
  ('4f000000-0000-4000-8000-000000000002', '3f000000-0000-4000-8000-000000000001', 'P0 two', 2);
insert into public.cluster_cards (cycle_id, cluster_id, card_id, sort_order)
values
  ('3f000000-0000-4000-8000-000000000001', '4f000000-0000-4000-8000-000000000001', cf_test.id('p0a'), 0),
  ('3f000000-0000-4000-8000-000000000001', '4f000000-0000-4000-8000-000000000001', cf_test.id('p0b'), 1);

select cf_test.snap('state', to_jsonb(cf_test.state()));
set local role authenticated;
select is(cf_test.differs(cf_test.each('D', 'P0', 'P0 one', 'P0 two', 'p0c', 'p0a'), cf_test.e('not_project_facilitator')), '{}'::text[], 'collecting: member D gets not_project_facilitator from all six');
select is(cf_test.differs(cf_test.each('B', 'P0', 'P0 one', 'P0 two', 'p0c', 'p0a'), cf_test.e('not_project_facilitator')), '{}'::text[], 'collecting: member B gets not_project_facilitator from all six');
select is(cf_test.differs(cf_test.each('A', 'P0', 'P0 one', 'P0 two', 'p0c', 'p0a'), cf_test.e('cycle_not_clustering')), '{}'::text[], 'collecting: the facilitator A gets cycle_not_clustering from all six');
reset role;
select is(to_jsonb(cf_test.state()), cf_test.snapped('state'), 'collecting: the refused calls leave clusters, cluster_cards, and cycle_events byte-identical');
set local role authenticated;
select cf_test.start('A', 'P0');
reset role;
select cf_test.snap('state', to_jsonb(cf_test.state()));
set local role authenticated;
select is(cf_test.differs(cf_test.each('D', 'P0', 'P0 one', 'P0 two', 'p0c', 'p0a'), cf_test.e('not_project_facilitator')), '{}'::text[], 'reveal: member D gets not_project_facilitator from all six');
select is(cf_test.differs(cf_test.each('A', 'P0', 'P0 one', 'P0 two', 'p0c', 'p0a'), cf_test.e('cycle_not_clustering')), '{}'::text[], 'reveal: the facilitator A gets cycle_not_clustering from all six');
reset role;
select is(to_jsonb(cf_test.state()), cf_test.snapped('state'), 'reveal: the refused calls leave clusters, cluster_cards, and cycle_events byte-identical');
set local role authenticated;
select cf_test.close('A', 'P0');
reset role;
select cf_test.snap('state', to_jsonb(cf_test.state()));
set local role authenticated;
select is(cf_test.differs(cf_test.each('D', 'P0', 'P0 one', 'P0 two', 'p0c', 'p0a'), cf_test.e('not_project_facilitator')), '{}'::text[], 'closed from reveal: member D gets not_project_facilitator from all six');
select is(cf_test.differs(cf_test.each('A', 'P0', 'P0 one', 'P0 two', 'p0c', 'p0a'), cf_test.e('cycle_not_clustering')), '{}'::text[], 'closed from reveal: the facilitator A gets cycle_not_clustering from all six');
reset role;
select is(to_jsonb(cf_test.state()), cf_test.snapped('state'), 'closed: the refused calls leave every row byte-identical');

-- ---------------------------------------------------------------------------
-- P1 in cluster. A (owner and facilitator) runs all six.
-- ---------------------------------------------------------------------------
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('3f000000-0000-4000-8000-000000000002', '2f000000-0000-4000-8000-000000000001', 'P main', '2026-10-26');
set local role authenticated;
select cf_test.add_card('A', 'P1', 'start', 'a attributed', false);
select cf_test.add_card('A', 'P1', 'stop', 'a anonymous', true);
select cf_test.add_card('B', 'P1', 'start', 'b attributed', false);
select cf_test.add_card('B', 'P1', 'continue', 'b anonymous', true);
select cf_test.add_card('D', 'P1', 'stop', 'd attributed', false);
select cf_test.add_card('D', 'P1', 'continue', 'd anonymous', true);
select cf_test.add_card('B', 'P1', 'start', 'u1', true);
select cf_test.add_card('D', 'P1', 'stop', 'u2', false);
select cf_test.start('A', 'P1');
select cf_test.advance('A', 'P1', 'reveal');
reset role;

select cf_test.mark();
set local role authenticated;
select cf_test.snap('run A', cf_test.run('A', 'Owner'));
reset role;
select is(cf_test.differs(cf_test.snapped('run A'), to_jsonb('ok'::text)), '{}'::text[], 'A, the facilitator, creates, renames, moves, splits, merges, and deletes');
select is(jsonb_array_length(cf_test.new_events()) > 0, true, 'the facilitator''s writes record clusters_changed events');
select is(
  (select count(*)::int from jsonb_array_elements(cf_test.new_events()) e where e is distinct from jsonb_build_object('type', 'clusters_changed', 'from_status', 'cluster', 'to_status', 'cluster', 'actor_id', null, 'payload', '{}'::jsonb)),
  0,
  'every event from the facilitator''s writes is clusters_changed with actor_id null and payload {}'
);

-- The fixture clusters, made through the RPCs by A:
-- Full = [a attributed, a anonymous, b anonymous], Other = [d anonymous];
-- b attributed, d attributed, u1, u2 ungrouped.
set local role authenticated;
select cf_test.mk('A', 'P1', 'Full');
select cf_test.mk('A', 'P1', 'Other');
select cf_test.call('A', 'move', cf_test.id('a attributed'), cf_test.id('Full'));
select cf_test.call('A', 'move', cf_test.id('a anonymous'), cf_test.id('Full'));
select cf_test.call('A', 'move', cf_test.id('b anonymous'), cf_test.id('Full'));
select cf_test.call('A', 'move', cf_test.id('d anonymous'), cf_test.id('Other'));
select cf_test.snap('board', cf_test.board('B', 'P1'));
reset role;
select cf_test.snap('state', to_jsonb(cf_test.state()));

-- ---------------------------------------------------------------------------
-- Members who are not the facilitator are refused in cluster.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(cf_test.each('D', 'P1', 'Full', 'Other', 'd attributed', 'a anonymous'), jsonb_build_object('create', cf_test.e('not_project_facilitator'), 'rename', cf_test.e('not_project_facilitator'), 'delete', cf_test.e('not_project_facilitator'), 'move', cf_test.e('not_project_facilitator'), 'merge', cf_test.e('not_project_facilitator'), 'split', cf_test.e('not_project_facilitator')), 'cluster: member D gets 42501 not_project_facilitator from each of the six');
select is(cf_test.differs(cf_test.each('B', 'P1', 'Full', 'Other', 'b attributed', 'b anonymous'), cf_test.e('not_project_facilitator')), '{}'::text[], 'cluster: member B gets not_project_facilitator from all six, on cards B wrote too');
select is(cf_test.call('D', 'move', cf_test.id('d anonymous'), null), cf_test.e('not_project_facilitator'), 'D cannot move D''s own anonymous card to Ungrouped');
select is(cf_test.call('D', 'move', cf_test.id('d attributed'), null), cf_test.e('not_project_facilitator'), 'D gets not_project_facilitator even for a move that would be a no-op');
select is(cf_test.call('D', 'rename', cf_test.id('Full'), p_name => 'Full'), cf_test.e('not_project_facilitator'), 'D gets not_project_facilitator even for a no-op rename');
select is(cf_test.call('D', 'merge', cf_test.id('Full'), cf_test.id('Full')), cf_test.e('not_project_facilitator'), 'D gets not_project_facilitator before cannot_merge_into_self');
select is(cf_test.call('D', 'create', cf_test.id('P1'), p_name => ''), cf_test.e('not_project_facilitator'), 'D gets not_project_facilitator before invalid_cluster_name');
select is(cf_test.call('D', 'split', cf_test.id('Full'), p_cards => '{}'::uuid[], p_name => 'x'), cf_test.e('not_project_facilitator'), 'D gets not_project_facilitator before invalid_card_selection');
select is(cf_test.call('D', 'move', cf_test.id('u1'), cf_test.id('Full'), p_position => -1), cf_test.e('not_project_facilitator'), 'D gets not_project_facilitator before invalid_card_position');
select is(cf_test.call('D', 'move', cf_test.id('u1'), gen_random_uuid()), cf_test.e('not_project_facilitator'), 'D with a valid card and a random target cluster gets not_project_facilitator');
reset role;
select is(to_jsonb(cf_test.state()), cf_test.snapped('state'), 'the refused calls leave clusters, cluster_cards, and cycle_events byte-identical');
set local role authenticated;
select is(cf_test.board('B', 'P1'), cf_test.snapped('board'), 'the board is unchanged');
reset role;

-- ---------------------------------------------------------------------------
-- Non-members, a null user, and unknown ids get exactly the earlier errors,
-- the same for an existing id of another project and a random id.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(cf_test.differs(cf_test.each('C', 'P1', 'Full', 'Other', 'u1', 'a anonymous') - 'create' - 'move', cf_test.e('cluster_not_found')), '{}'::text[], 'non-member C gets cluster_not_found from rename, delete, merge, and split on P''s ids');
select is(cf_test.call('C', 'create', cf_test.id('P1'), p_name => 'x'), cf_test.e('not_project_member'), 'non-member C gets not_project_member from create_cluster');
select is(cf_test.call('C', 'move', cf_test.id('u1'), cf_test.id('Full')), cf_test.e('card_not_found'), 'non-member C gets card_not_found from move_card');
select is(
  cf_test.each('C', 'P1', 'Full', 'Other', 'u1', 'a anonymous'),
  jsonb_build_object(
    'create', cf_test.call('C', 'create', gen_random_uuid(), p_name => 'x'),
    'rename', cf_test.call('C', 'rename', gen_random_uuid(), p_name => 'x'),
    'delete', cf_test.call('C', 'delete', gen_random_uuid()),
    'move', cf_test.call('C', 'move', gen_random_uuid(), cf_test.id('Full')),
    'merge', cf_test.call('C', 'merge', gen_random_uuid(), cf_test.id('Full')),
    'split', cf_test.call('C', 'split', gen_random_uuid(), p_cards => array[cf_test.id('a anonymous')], p_name => 'Split off')
  ),
  'non-member C: every error is identical for an existing id and a random id'
);
select is(
  cf_test.each(null, 'P1', 'Full', 'Other', 'u1', 'a anonymous'),
  jsonb_build_object('create', cf_test.e('not_project_member'), 'rename', cf_test.e('not_project_member'), 'delete', cf_test.e('not_project_member'), 'move', cf_test.e('not_project_member'), 'merge', cf_test.e('not_project_member'), 'split', cf_test.e('not_project_member')),
  'a null user gets not_project_member from all six'
);
select is(
  cf_test.each('D', 'Q1', 'Q one', 'Q two', 'q1', 'q2'),
  jsonb_build_object('create', cf_test.e('not_project_member'), 'rename', cf_test.e('cluster_not_found'), 'delete', cf_test.e('cluster_not_found'), 'move', cf_test.e('card_not_found'), 'merge', cf_test.e('cluster_not_found'), 'split', cf_test.e('cluster_not_found')),
  'member D with existing ids of project Q gets the non-member errors'
);
select is(
  jsonb_build_object(
    'create', cf_test.call('D', 'create', gen_random_uuid(), p_name => 'x'),
    'rename', cf_test.call('D', 'rename', gen_random_uuid(), p_name => 'x'),
    'delete', cf_test.call('D', 'delete', gen_random_uuid()),
    'move', cf_test.call('D', 'move', gen_random_uuid(), cf_test.id('Full')),
    'merge', cf_test.call('D', 'merge', gen_random_uuid(), cf_test.id('Full')),
    'split', cf_test.call('D', 'split', gen_random_uuid(), p_cards => array[cf_test.id('a anonymous')], p_name => 'x')
  ),
  cf_test.each('D', 'Q1', 'Q one', 'Q two', 'q1', 'q2'),
  'member D with random ids gets cluster_not_found / card_not_found / not_project_member, the same as for project Q''s ids'
);
select is(cf_test.call('D', 'move', null, cf_test.id('Full')), cf_test.e('card_not_found'), 'member D with a null card id gets card_not_found');
select is(cf_test.call('D', 'rename', null, p_name => 'x'), cf_test.e('cluster_not_found'), 'member D with a null cluster id gets cluster_not_found');
select is(cf_test.call('D', 'create', null, p_name => 'x'), cf_test.e('not_project_member'), 'member D with a null cycle id gets not_project_member');
reset role;
select is(to_jsonb(cf_test.state()), cf_test.snapped('state'), 'the access refusals change nothing');

-- ---------------------------------------------------------------------------
-- transfer_facilitator(P, B): the owner is refused, B runs all six.
-- ---------------------------------------------------------------------------
set local role authenticated;
select cf_test.transfer('A', 'B');
reset role;
select cf_test.snap('state', to_jsonb(cf_test.state()));
set local role authenticated;
select is(cf_test.differs(cf_test.each('A', 'P1', 'Full', 'Other', 'u1', 'a anonymous'), cf_test.e('not_project_facilitator')), '{}'::text[], 'after the transfer to B, the owner A gets not_project_facilitator from all six');
select is(cf_test.differs(cf_test.each('D', 'P1', 'Full', 'Other', 'u1', 'a anonymous'), cf_test.e('not_project_facilitator')), '{}'::text[], 'member D is still refused');
reset role;
select is(to_jsonb(cf_test.state()), cf_test.snapped('state'), 'the owner''s refused calls change nothing');
select cf_test.mark();
set local role authenticated;
select cf_test.snap('run B', cf_test.run('B', 'Bee'));
reset role;
select is(cf_test.snapped('run B'), cf_test.snapped('run A'), 'B, the new facilitator, gets the same results as A did');
select is(
  (select count(*)::int from jsonb_array_elements(cf_test.new_events()) e where e is distinct from jsonb_build_object('type', 'clusters_changed', 'from_status', 'cluster', 'to_status', 'cluster', 'actor_id', null, 'payload', '{}'::jsonb)),
  0,
  'B''s writes record clusters_changed events with actor_id null and payload {}'
);
set local role authenticated;
select is(cf_test.board('B', 'P1'), cf_test.snapped('board'), 'B''s run leaves the fixture board as it was');
reset role;

-- ---------------------------------------------------------------------------
-- transfer_facilitator(P, D): the former facilitator B is refused, D runs.
-- ---------------------------------------------------------------------------
set local role authenticated;
select cf_test.transfer('A', 'D');
reset role;
select cf_test.snap('state', to_jsonb(cf_test.state()));
set local role authenticated;
select is(cf_test.differs(cf_test.each('B', 'P1', 'Full', 'Other', 'u1', 'a anonymous'), cf_test.e('not_project_facilitator')), '{}'::text[], 'after the transfer to D, the former facilitator B gets not_project_facilitator from all six');
select is(cf_test.differs(cf_test.each('A', 'P1', 'Full', 'Other', 'u1', 'a anonymous'), cf_test.e('not_project_facilitator')), '{}'::text[], 'the owner A is still refused');
reset role;
select is(to_jsonb(cf_test.state()), cf_test.snapped('state'), 'the former facilitator''s refused calls change nothing');
set local role authenticated;
select cf_test.snap('run D', cf_test.run('D', 'Dee'));
reset role;
select is(cf_test.snapped('run D'), cf_test.snapped('run A'), 'D, the new facilitator, gets the same results as A did');

-- Back to A: A runs again with the same results as before any transfer.
set local role authenticated;
select cf_test.transfer('A', 'A');
select is(cf_test.run('A', 'Again'), cf_test.snapped('run A'), 'A, facilitator again, gets the same results as before the transfers');
select is(cf_test.call('A', 'merge', cf_test.id('Full'), cf_test.id('Full')), cf_test.e('cannot_merge_into_self'), 'the facilitator still gets #19''s cannot_merge_into_self');
select is(cf_test.call('A', 'create', cf_test.id('P1'), p_name => 'full'), cf_test.e('cluster_name_taken'), 'the facilitator still gets #17''s cluster_name_taken');
select is(cf_test.call('A', 'move', cf_test.id('u1'), cf_test.id('Full'), p_position => -1), cf_test.e('invalid_card_position'), 'the facilitator still gets #18''s invalid_card_position');
select is(cf_test.call('A', 'rename', gen_random_uuid(), p_name => 'x'), cf_test.e('cluster_not_found'), 'the facilitator with a random id gets cluster_not_found');
reset role;

-- ---------------------------------------------------------------------------
-- vote, discuss, closed: members are refused, the facilitator gets
-- cycle_not_clustering.
-- ---------------------------------------------------------------------------
set local role authenticated;
select cf_test.advance('A', 'P1', 'cluster');
reset role;
select cf_test.snap('state', to_jsonb(cf_test.state()));
set local role authenticated;
select is(cf_test.differs(cf_test.each('D', 'P1', 'Full', 'Other', 'u1', 'a anonymous'), cf_test.e('not_project_facilitator')), '{}'::text[], 'vote: member D gets not_project_facilitator from all six');
select is(cf_test.differs(cf_test.each('A', 'P1', 'Full', 'Other', 'u1', 'a anonymous'), cf_test.e('cycle_not_clustering')), '{}'::text[], 'vote: the facilitator gets cycle_not_clustering from all six');
reset role;
update public.feedback_cycles set status = 'discuss', voting_closed_at = now() where id = '3f000000-0000-4000-8000-000000000002';
select cf_test.snap('state', to_jsonb(cf_test.state()));
set local role authenticated;
select is(cf_test.differs(cf_test.each('D', 'P1', 'Full', 'Other', 'u1', 'a anonymous'), cf_test.e('not_project_facilitator')), '{}'::text[], 'discuss: member D gets not_project_facilitator from all six');
select is(cf_test.differs(cf_test.each('A', 'P1', 'Full', 'Other', 'u1', 'a anonymous'), cf_test.e('cycle_not_clustering')), '{}'::text[], 'discuss: the facilitator gets cycle_not_clustering from all six');
select cf_test.close('A', 'P1');
reset role;
select cf_test.snap('state', to_jsonb(cf_test.state()));
set local role authenticated;
select is(cf_test.differs(cf_test.each('D', 'P1', 'Full', 'Other', 'u1', 'a anonymous'), cf_test.e('not_project_facilitator')), '{}'::text[], 'closed: member D gets not_project_facilitator from all six');
select is(cf_test.differs(cf_test.each('A', 'P1', 'Full', 'Other', 'u1', 'a anonymous'), cf_test.e('cycle_not_clustering')), '{}'::text[], 'closed: the facilitator gets cycle_not_clustering from all six');
reset role;
select is(to_jsonb(cf_test.state()), cf_test.snapped('state'), 'closed: every refused call leaves the rows and events byte-identical');

select * from finish();
rollback;
