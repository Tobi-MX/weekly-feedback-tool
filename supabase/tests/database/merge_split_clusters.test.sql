-- pgTAP tests for cluster merge and split (#19): the hardening and behaviour
-- of merge_clusters and split_cluster, the clusters_changed events their
-- writes record through #17's triggers, and that the migration adds nothing
-- else.
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension and the ms_test helper schema. The seed user is never
-- used as a fixture.
--
-- Fixtures: owner and facilitator A, members B and D, non-member C. Project P
-- is owned by A with B and D joined; project Q is owned by C. P0 (P) gets
-- cards through create_card and clusters inserted as postgres, and is closed
-- from collecting. P1 (P) is the main cycle: cards from A, B, and D through
-- create_card (attributed and anonymous), clusters inserted as postgres in
-- collecting and reveal, revealed through start_retrospective, moved to
-- cluster through advance_stage, with clusters from create_cluster and cards
-- placed through move_card or inserted as postgres; then vote, discuss (as
-- postgres), and closed through close_cycle. Q1 (Q) is C's.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(151);

-- ---------------------------------------------------------------------------
-- Test-only helpers. The ones that call RPCs are security invoker; the
-- read-back helpers are security definer so they see every row.
-- ---------------------------------------------------------------------------
create schema ms_test;

create table ms_test.ids (label text primary key, id uuid not null);
create table ms_test.snaps (label text primary key, body jsonb);
create table ms_test.seen (id uuid primary key);

insert into ms_test.ids (label, id)
values
  ('A', '19000000-0000-4000-8000-000000000001'),
  ('B', '19000000-0000-4000-8000-000000000002'),
  ('C', '19000000-0000-4000-8000-000000000003'),
  ('D', '19000000-0000-4000-8000-000000000004'),
  ('P', '29000000-0000-4000-8000-000000000001'),
  ('Q', '29000000-0000-4000-8000-000000000002'),
  ('P0', '39000000-0000-4000-8000-000000000001'),
  ('P1', '39000000-0000-4000-8000-000000000002'),
  ('Q1', '39000000-0000-4000-8000-000000000011'),
  ('P0x', '49000000-0000-4000-8000-000000000001'),
  ('P0y', '49000000-0000-4000-8000-000000000002'),
  ('W1', '49000000-0000-4000-8000-000000000011'),
  ('W2', '49000000-0000-4000-8000-000000000012'),
  ('T2', '49000000-0000-4000-8000-000000000021'),
  ('S2', '49000000-0000-4000-8000-000000000022'),
  ('E', '49000000-0000-4000-8000-000000000031'),
  ('TA', '49000000-0000-4000-8000-000000000032'),
  ('ET', '49000000-0000-4000-8000-000000000041'),
  ('AIX', '49000000-0000-4000-8000-000000000051'),
  ('AIY', '49000000-0000-4000-8000-000000000052');

create function ms_test.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from ms_test.ids i where i.label = p_label;
$$;

create function ms_test.label(p_id uuid)
returns text
language sql
stable
as $$
  select i.label from ms_test.ids i where i.id = p_id;
$$;

create function ms_test.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', ms_test.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- The full error of a failed call, as jsonb.
create function ms_test.e(p_message text)
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

-- merge_clusters as the user with raw ids: the returned row, or the error.
create function ms_test.mg_raw(p_user text, p_source uuid, p_target uuid)
returns jsonb
language plpgsql
as $$
declare
  v_row jsonb;
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform ms_test.become(p_user);
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_row
    from public.merge_clusters(p_source, p_target) r;
  return v_row;
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

create function ms_test.mg(p_user text, p_source text, p_target text)
returns jsonb
language sql
as $$
  select ms_test.mg_raw(p_user, ms_test.id(p_source), ms_test.id(p_target));
$$;

-- split_cluster as the user with raw ids: the returned row, or the error.
create function ms_test.sp_raw(p_user text, p_cluster uuid, p_cards uuid[], p_name text)
returns jsonb
language plpgsql
as $$
declare
  v_row jsonb;
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform ms_test.become(p_user);
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_row
    from public.split_cluster(p_cluster, p_cards, p_name) r;
  return v_row;
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

-- split_cluster with labels; the new cluster is stored under p_label.
create function ms_test.sp(p_user text, p_cluster text, p_cards text[], p_name text, p_label text default null)
returns jsonb
language plpgsql
as $$
declare
  v_result jsonb;
begin
  v_result := ms_test.sp_raw(
    p_user,
    ms_test.id(p_cluster),
    (select array_agg(ms_test.id(c) order by o) from unnest(p_cards) with ordinality u(c, o)),
    p_name
  );
  if p_label is not null and jsonb_typeof(v_result) = 'array' then
    insert into ms_test.ids (label, id) values (p_label, (v_result -> 0 ->> 'cluster_id')::uuid);
  end if;
  return v_result;
end;
$$;

-- The expected one-row result of a cluster.
create function ms_test.row_of(p_cluster text, p_name text, p_source text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_array(jsonb_build_object('cluster_id', ms_test.id(p_cluster), 'name', p_name, 'source', p_source));
$$;

create function ms_test.add_card(p_user text, p_cycle text, p_category text, p_label text, p_anonymous boolean)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform ms_test.become(p_user);
  select c.id into strict new_id
    from public.create_card(ms_test.id(p_cycle), p_category, p_label, p_anonymous) c;
  insert into ms_test.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

create function ms_test.mk(p_user text, p_name text)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform ms_test.become(p_user);
  select r.cluster_id into strict new_id from public.create_cluster(ms_test.id('P1'), p_name) r;
  insert into ms_test.ids (label, id) values (p_name, new_id)
  on conflict (label) do update set id = excluded.id;
  return new_id;
end;
$$;

create function ms_test.mv(p_user text, p_card text, p_cluster text)
returns void
language plpgsql
as $$
begin
  perform ms_test.become(p_user);
  perform public.move_card(ms_test.id(p_card), ms_test.id(p_cluster), null);
end;
$$;

create function ms_test.del(p_user text, p_cluster text)
returns void
language plpgsql
as $$
begin
  perform ms_test.become(p_user);
  perform public.delete_cluster(ms_test.id(p_cluster));
end;
$$;

create function ms_test.start(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform ms_test.become(p_user);
  perform 1 from public.start_retrospective(ms_test.id(p_cycle));
end;
$$;

create function ms_test.advance(p_user text, p_cycle text, p_from text)
returns void
language plpgsql
as $$
begin
  perform ms_test.become(p_user);
  perform 1 from public.advance_stage(ms_test.id(p_cycle), p_from);
end;
$$;

create function ms_test.close(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform ms_test.become(p_user);
  perform 1 from public.close_cycle(ms_test.id(p_cycle));
end;
$$;

create function ms_test.board(p_user text)
returns jsonb
language plpgsql
as $$
begin
  perform ms_test.become(p_user);
  return public.get_cycle_board(ms_test.id('P1'));
end;
$$;

-- The card labels of a cluster in a board response, in card_ids order; null
-- when the board has no such cluster.
create function ms_test.board_list(p_board jsonb, p_cluster text)
returns text[]
language sql
stable
as $$
  select (
    select coalesce(array_agg(ms_test.label(x::uuid) order by o), '{}')
    from jsonb_array_elements_text(c -> 'card_ids') with ordinality e(x, o)
  )
  from jsonb_array_elements(p_board -> 'clusters') c
  where (c ->> 'cluster_id')::uuid = ms_test.id(p_cluster);
$$;

-- The last cluster of a board response.
create function ms_test.board_last(p_board jsonb)
returns uuid
language sql
stable
as $$
  select (p_board -> 'clusters' -> -1 ->> 'cluster_id')::uuid;
$$;

-- A cluster's card labels in (sort_order, card_id) order, read as postgres.
create function ms_test.list(p_cluster text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(i.label order by cc.sort_order, cc.card_id), '{}')
  from public.cluster_cards cc
  join ms_test.ids i on i.id = cc.card_id
  where cc.cluster_id = (select x.id from ms_test.ids x where x.label = p_cluster);
$$;

create function ms_test.orders(p_cluster text)
returns integer[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(cc.sort_order order by cc.sort_order, cc.card_id), '{}')
  from public.cluster_cards cc
  where cc.cluster_id = (select x.id from ms_test.ids x where x.label = p_cluster);
$$;

create function ms_test.source(p_cluster text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select cl.source from public.clusters cl where cl.id = (select x.id from ms_test.ids x where x.label = p_cluster);
$$;

create function ms_test.exists_cluster(p_cluster text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.clusters cl where cl.id = (select x.id from ms_test.ids x where x.label = p_cluster));
$$;

-- A cluster's row (timestamps included), as postgres.
create function ms_test.cluster_row(p_cluster text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(cl) from public.clusters cl where cl.id = (select x.id from ms_test.ids x where x.label = p_cluster);
$$;

create function ms_test.cluster_order(p_cluster text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select cl.sort_order from public.clusters cl where cl.id = (select x.id from ms_test.ids x where x.label = p_cluster);
$$;

create function ms_test.max_order(p_cycle text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select max(cl.sort_order) from public.clusters cl where cl.cycle_id = (select x.id from ms_test.ids x where x.label = p_cycle);
$$;

create function ms_test.cluster_count(p_cycle text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.clusters cl where cl.cycle_id = (select x.id from ms_test.ids x where x.label = p_cycle);
$$;

-- An md5 of every clusters and cluster_cards row of a cycle (timestamps
-- included).
create function ms_test.state(p_cycle text default 'P1')
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(
    coalesce((select string_agg(to_jsonb(cl)::text, '|' order by cl.id) from public.clusters cl where cl.cycle_id = (select x.id from ms_test.ids x where x.label = p_cycle)), '')
    || '#'
    || coalesce((select string_agg(to_jsonb(cc)::text, '|' order by cc.card_id) from public.cluster_cards cc where cc.cycle_id = (select x.id from ms_test.ids x where x.label = p_cycle)), '')
  );
$$;

-- An md5 of the clusters and cluster_cards rows of P1 outside the given
-- clusters.
create function ms_test.others(p_except text[])
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(
    coalesce((select string_agg(to_jsonb(cl)::text, '|' order by cl.id) from public.clusters cl where cl.cycle_id = '39000000-0000-4000-8000-000000000002' and cl.id not in (select x.id from ms_test.ids x where x.label = any (p_except))), '')
    || '#'
    || coalesce((select string_agg(to_jsonb(cc)::text, '|' order by cc.card_id) from public.cluster_cards cc where cc.cycle_id = '39000000-0000-4000-8000-000000000002' and cc.cluster_id not in (select x.id from ms_test.ids x where x.label = any (p_except))), '')
  );
$$;

-- An md5 of every card row of P1.
create function ms_test.cards_state()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), ''))
  from public.cards c
  where c.cycle_id = '39000000-0000-4000-8000-000000000002';
$$;

-- The labels of P1's ungrouped cards.
create function ms_test.ungrouped()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(i.label order by i.label), '{}')
  from public.cards c
  join ms_test.ids i on i.id = c.id
  where c.cycle_id = '39000000-0000-4000-8000-000000000002'
    and not exists (select 1 from public.cluster_cards cc where cc.card_id = c.id);
$$;

create function ms_test.one_cluster_each()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) = count(distinct cc.card_id)
     and count(*) <= (select count(*) from public.cards c where c.cycle_id = '39000000-0000-4000-8000-000000000002')
  from public.cluster_cards cc
  where cc.cycle_id = '39000000-0000-4000-8000-000000000002';
$$;

create function ms_test.mark()
returns void
language sql
security definer
set search_path = ''
as $$
  insert into ms_test.seen (id)
  select e.id from public.cycle_events e
  on conflict do nothing;
$$;

-- The unseen events of a cycle, without id, cycle_id, and created_at.
create function ms_test.new_events(p_cycle text default 'P1')
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(e) - 'id' - 'cycle_id' - 'created_at'), '[]'::jsonb)
  from public.cycle_events e
  where e.cycle_id = (select x.id from ms_test.ids x where x.label = p_cycle)
    and not exists (select 1 from ms_test.seen s where s.id = e.id);
$$;

create function ms_test.new_other_events()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int
  from public.cycle_events e
  where e.cycle_id <> '39000000-0000-4000-8000-000000000002'
    and not exists (select 1 from ms_test.seen s where s.id = e.id);
$$;

create function ms_test.events_ok()
returns boolean
language sql
stable
as $$
  select jsonb_array_length(ms_test.new_events()) >= 1
     and not exists (
       select 1 from jsonb_array_elements(ms_test.new_events()) e(j)
       where j <> jsonb_build_object('type', 'clusters_changed', 'from_status', 'cluster', 'to_status', 'cluster', 'actor_id', null, 'payload', '{}'::jsonb)
     );
$$;

create function ms_test.snap(p_label text, p_body jsonb)
returns void
language sql
as $$
  insert into ms_test.snaps (label, body) values (p_label, p_body)
  on conflict (label) do update set body = excluded.body;
$$;

create function ms_test.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.body from ms_test.snaps s where s.label = p_label;
$$;

-- One sequence of splits and merges as the user over ungrouped cards k (B's,
-- anonymous), l (A's, attributed), m, n. Returns each step's result without
-- ids and the card lists after it, and leaves the cards ungrouped again.
create function ms_test.sequence(p_user text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := '[]'::jsonb;
  outcome jsonb;
  step text;
begin
  perform ms_test.mk(p_user, 'Seq T');
  perform ms_test.mk(p_user, 'Seq S');
  perform ms_test.mv(p_user, 'k', 'Seq T');
  perform ms_test.mv(p_user, 'l', 'Seq T');
  perform ms_test.mv(p_user, 'm', 'Seq T');
  perform ms_test.mv(p_user, 'n', 'Seq S');
  delete from ms_test.ids where label in ('Seq K', 'Seq L');
  foreach step in array array['split k', 'split l', 'merge K into L', 'merge L into T', 'merge S into T'] loop
    outcome := case step
      when 'split k' then ms_test.sp(p_user, 'Seq T', array['k'], 'Seq K', 'Seq K')
      when 'split l' then ms_test.sp(p_user, 'Seq T', array['l'], 'Seq L', 'Seq L')
      when 'merge K into L' then ms_test.mg(p_user, 'Seq K', 'Seq L')
      when 'merge L into T' then ms_test.mg(p_user, 'Seq L', 'Seq T')
      else ms_test.mg(p_user, 'Seq S', 'Seq T')
    end;
    result := result || jsonb_build_array(jsonb_build_object(
      'step', step,
      'result', outcome #- '{0,cluster_id}',
      'T', to_jsonb(ms_test.list('Seq T')),
      'S', to_jsonb(ms_test.list('Seq S')),
      'K', to_jsonb(ms_test.list('Seq K')),
      'L', to_jsonb(ms_test.list('Seq L')),
      'T orders', to_jsonb(ms_test.orders('Seq T'))
    ));
  end loop;
  perform ms_test.del(p_user, 'Seq T');
  return result;
end;
$$;

grant usage on schema ms_test to authenticated;
grant select, insert, update, delete on all tables in schema ms_test to authenticated;
grant execute on all functions in schema ms_test to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures. The token columns are empty strings, as the Auth server writes
-- them.
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', '19000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ms-a@example.com', '{"display_name":"Alice"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '19000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'ms-b@example.com', '{"display_name":"Bob"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '19000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'ms-c@example.com', '{"display_name":"Cara"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '19000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'ms-d@example.com', '{"display_name":"Dan"}', '', '', '', '');

insert into public.projects (id, name, owner_id)
values
  ('29000000-0000-4000-8000-000000000001', 'Project P', '19000000-0000-4000-8000-000000000001'),
  ('29000000-0000-4000-8000-000000000002', 'Project Q', '19000000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('29000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000002', 'member'),
  ('29000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000004', 'member');

-- P0: cards, two clusters inserted as postgres, closed from collecting.
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('39000000-0000-4000-8000-000000000001', '29000000-0000-4000-8000-000000000001', 'P early close', '2026-10-12');
set local role authenticated;
select ms_test.add_card('A', 'P0', 'start', 'p0a', false);
select ms_test.add_card('B', 'P0', 'stop', 'p0b', true);
select ms_test.add_card('D', 'P0', 'stop', 'p0c', false);
reset role;
insert into public.clusters (id, cycle_id, name, sort_order)
values
  (ms_test.id('P0x'), ms_test.id('P0'), 'Old x', 1),
  (ms_test.id('P0y'), ms_test.id('P0'), 'Old y', 2);
insert into public.cluster_cards (cycle_id, cluster_id, card_id, sort_order)
values
  (ms_test.id('P0'), ms_test.id('P0x'), ms_test.id('p0a'), 0),
  (ms_test.id('P0'), ms_test.id('P0x'), ms_test.id('p0b'), 1),
  (ms_test.id('P0'), ms_test.id('P0y'), ms_test.id('p0c'), 0);
set local role authenticated;
select ms_test.close('A', 'P0');
reset role;

insert into public.feedback_cycles (id, project_id, title, week_start)
values
  ('39000000-0000-4000-8000-000000000002', '29000000-0000-4000-8000-000000000001', 'P main', '2026-10-26'),
  ('39000000-0000-4000-8000-000000000011', '29000000-0000-4000-8000-000000000002', 'Q one', '2026-10-26');

set local role authenticated;
select ms_test.add_card('A', 'P1', 'start', 'a', false);
select ms_test.add_card('B', 'P1', 'stop', 'b', true);
select ms_test.add_card('D', 'P1', 'continue', 'c', false);
select ms_test.add_card('B', 'P1', 'start', 'd', false);
select ms_test.add_card('A', 'P1', 'stop', 'e', true);
select ms_test.add_card('D', 'P1', 'start', 'f', true);
select ms_test.add_card('A', 'P1', 'continue', 'g', false);
select ms_test.add_card('B', 'P1', 'continue', 'h', true);
select ms_test.add_card('D', 'P1', 'stop', 'i', false);
select ms_test.add_card('A', 'P1', 'start', 'j', true);
select ms_test.add_card('B', 'P1', 'stop', 'k', true);
select ms_test.add_card('A', 'P1', 'continue', 'l', false);
select ms_test.add_card('D', 'P1', 'start', 'm', false);
select ms_test.add_card('B', 'P1', 'stop', 'n', false);
select ms_test.add_card('A', 'P1', 'start', 'o', true);
select ms_test.add_card('D', 'P1', 'continue', 'p', false);
select ms_test.add_card('B', 'P1', 'start', 'r', true);
select ms_test.add_card('A', 'P1', 'stop', 's', false);
select ms_test.add_card('D', 'P1', 'stop', 't', false);
select ms_test.add_card('B', 'P1', 'continue', 'u', true);
select ms_test.add_card('C', 'Q1', 'start', 'q', false);
reset role;

-- ---------------------------------------------------------------------------
-- The migration: merge_clusters and split_cluster only.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'merge_clusters'), 1, 'merge_clusters has exactly one overload');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'split_cluster'), 1, 'split_cluster has exactly one overload');
select is(pg_get_function_identity_arguments('public.merge_clusters(uuid, uuid)'::regprocedure), 'p_source_cluster_id uuid, p_target_cluster_id uuid', 'merge_clusters arguments');
select is(pg_get_function_identity_arguments('public.split_cluster(uuid, uuid[], text)'::regprocedure), 'p_cluster_id uuid, p_card_ids uuid[], p_name text', 'split_cluster arguments');
select is(pg_get_function_result('public.merge_clusters(uuid, uuid)'::regprocedure), 'TABLE(cluster_id uuid, name text, source text)', 'merge_clusters returns the target row');
select is(pg_get_function_result('public.split_cluster(uuid, uuid[], text)'::regprocedure), 'TABLE(cluster_id uuid, name text, source text)', 'split_cluster returns the new row');
select is(
  (select bool_and(p.prosecdef and p.provolatile = 'v' and p.proconfig = array['search_path=""']::text[]) from pg_proc p where p.oid in ('public.merge_clusters(uuid, uuid)'::regprocedure, 'public.split_cluster(uuid, uuid[], text)'::regprocedure)),
  true,
  'both are security definer, volatile, and fix search_path to empty'
);
select is(
  array[
    has_function_privilege('authenticated', 'public.merge_clusters(uuid, uuid)', 'EXECUTE'),
    has_function_privilege('anon', 'public.merge_clusters(uuid, uuid)', 'EXECUTE'),
    has_function_privilege('service_role', 'public.merge_clusters(uuid, uuid)', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.split_cluster(uuid, uuid[], text)', 'EXECUTE'),
    has_function_privilege('anon', 'public.split_cluster(uuid, uuid[], text)', 'EXECUTE'),
    has_function_privilege('service_role', 'public.split_cluster(uuid, uuid[], text)', 'EXECUTE')
  ],
  array[true, false, false, true, false, false],
  'both are executable by authenticated only'
);
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid in ('public.merge_clusters(uuid, uuid)'::regprocedure, 'public.split_cluster(uuid, uuid[], text)'::regprocedure)), 0, 'PUBLIC cannot execute either');
select is((select bool_and(p.prosrc ~ 'from public\.feedback_cycles fc\s+where fc\.id = \w+\s+for update;') from pg_proc p where p.oid in ('public.merge_clusters(uuid, uuid)'::regprocedure, 'public.split_cluster(uuid, uuid[], text)'::regprocedure)), true, 'both lock the cycle row FOR UPDATE on public.feedback_cycles');
select is((select bool_or(p.prosrc ~* '(cycle_events|card_authors|profiles|created_at|updated_at|is_project_facilitator|owner_id|execute|raise\s+notice)') from pg_proc p where p.oid in ('public.merge_clusters(uuid, uuid)'::regprocedure, 'public.split_cluster(uuid, uuid[], text)'::regprocedure)), false, 'neither mentions cycle_events, card_authors, profiles, timestamps, facilitator, owner, dynamic SQL, or notice');
select is((select bool_and(p.prosrc ~ '\(select auth\.uid\(\)\) is null' and p.prosrc ~ 'private\.is_project_member\(cycle_project\)') from pg_proc p where p.oid in ('public.merge_clusters(uuid, uuid)'::regprocedure, 'public.split_cluster(uuid, uuid[], text)'::regprocedure)), true, 'both check (select auth.uid()) and use private.is_project_member');
select is(
  (select array_agg(distinct m.msg[1]::text order by m.msg[1]::text) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'message\s*=\s*''([^'']*)''', 'g') as m(msg) where p.oid = 'public.merge_clusters(uuid, uuid)'::regprocedure),
  array['cannot_merge_into_self', 'cluster_not_found', 'cycle_not_clustering', 'not_project_member'],
  'merge_clusters raises exactly the messages of the error table'
);
select is(
  (select array_agg(distinct m.msg[1]::text order by m.msg[1]::text) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'message\s*=\s*''([^'']*)''', 'g') as m(msg) where p.oid = 'public.split_cluster(uuid, uuid[], text)'::regprocedure),
  array['card_not_in_cluster', 'cluster_limit_reached', 'cluster_name_taken', 'cluster_not_found', 'cycle_not_clustering', 'invalid_card_selection', 'invalid_cluster_name', 'not_project_member', 'split_takes_all_cards'],
  'split_cluster raises exactly the messages of the error table'
);
select is(
  (select bool_and((select count(*) from regexp_matches(p.prosrc, '\mraise\M', 'gi')) = (select count(*) from regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''[a-z_]+'';', 'g'))) from pg_proc p where p.oid in ('public.merge_clusters(uuid, uuid)'::regprocedure, 'public.split_cluster(uuid, uuid[], text)'::regprocedure)),
  true,
  'every raise sets only the code and a stable message, with no detail or hint'
);
select is((select bool_or(pg_get_function_identity_arguments(p.oid) ~* 'user|author|actor') from pg_proc p where p.oid in ('public.merge_clusters(uuid, uuid)'::regprocedure, 'public.split_cluster(uuid, uuid[], text)'::regprocedure)), false, 'neither takes a user id');
select is((select md5(prosrc) from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), '63317c82ae89c6b9c7851c07bafefbc7', 'get_cycle_board is unchanged from #17');
select is((select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.clusters'::regclass, 'public.cluster_cards'::regclass)), true, 'clusters and cluster_cards keep RLS enabled');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('clusters', 'cluster_cards', 'cards', 'card_authors')), 0, 'clusters, cluster_cards, cards, and card_authors still have no policy');
select is(
  (select array_agg(tablename || ':' || n order by tablename) from (select tablename, count(*)::text n from pg_policies where schemaname = 'public' group by tablename) x),
  array['cycle_events:1', 'feedback_cycles:1', 'profiles:2', 'project_members:1', 'projects:3'],
  'the public policies are exactly those before #19'
);
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated']) r cross join unnest(array['public.clusters', 'public.cluster_cards', 'public.cards', 'public.card_authors']) t cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p where has_table_privilege(r, t, p)),
  0,
  'anon and authenticated hold no privilege on clusters, cluster_cards, cards, or card_authors'
);
select is((select array_agg(tablename::text order by tablename) from pg_publication_tables where pubname = 'supabase_realtime'), array['cycle_events'], 'supabase_realtime still publishes only cycle_events');
select is((select count(*)::int from pg_views where schemaname = 'public'), 0, 'no view in public');
select is(
  (select array_agg(c.relname || '.' || a.attname order by c.relname, a.attnum) from pg_attribute a join pg_class c on c.oid = a.attrelid where c.oid in ('public.clusters'::regclass, 'public.cluster_cards'::regclass) and a.attnum > 0 and not a.attisdropped),
  array['cluster_cards.cycle_id', 'cluster_cards.cluster_id', 'cluster_cards.card_id', 'cluster_cards.sort_order', 'clusters.id', 'clusters.cycle_id', 'clusters.name', 'clusters.source', 'clusters.sort_order', 'clusters.created_at', 'clusters.updated_at'],
  'clusters and cluster_cards have exactly #17''s columns'
);
select is(
  (select array_agg(conname::text order by conname) from pg_constraint where conrelid in ('public.clusters'::regclass, 'public.cluster_cards'::regclass)),
  array['cluster_cards_card_fkey', 'cluster_cards_cluster_fkey', 'cluster_cards_pkey', 'clusters_cycle_id_fkey', 'clusters_cycle_id_sort_order_key', 'clusters_id_cycle_id_key', 'clusters_name_check', 'clusters_pkey', 'clusters_source_check'],
  'clusters and cluster_cards have exactly #17''s constraints'
);

-- ---------------------------------------------------------------------------
-- closed from collecting (P0): neither runs.
-- ---------------------------------------------------------------------------
select ms_test.snap('P0 state', to_jsonb(ms_test.state('P0')));
select ms_test.mark();
set local role authenticated;
select is(ms_test.mg('B', 'P0y', 'P0x'), ms_test.e('cycle_not_clustering'), 'closed from collecting: merge_clusters gets cycle_not_clustering');
select is(ms_test.sp('B', 'P0x', array['p0a'], 'New'), ms_test.e('cycle_not_clustering'), 'closed from collecting: split_cluster gets cycle_not_clustering');
reset role;
select is(to_jsonb(ms_test.state('P0')), ms_test.snapped('P0 state'), 'closed from collecting: the rows are unchanged');
select is(ms_test.new_events('P0'), '[]'::jsonb, 'closed from collecting: no event');

-- ---------------------------------------------------------------------------
-- collecting and reveal (P1, clusters inserted as postgres): neither runs.
-- ---------------------------------------------------------------------------
insert into public.clusters (id, cycle_id, name, sort_order)
values
  (ms_test.id('W1'), ms_test.id('P1'), 'Early one', 1),
  (ms_test.id('W2'), ms_test.id('P1'), 'Early two', 2);
insert into public.cluster_cards (cycle_id, cluster_id, card_id, sort_order)
values
  (ms_test.id('P1'), ms_test.id('W1'), ms_test.id('a'), 0),
  (ms_test.id('P1'), ms_test.id('W1'), ms_test.id('b'), 1),
  (ms_test.id('P1'), ms_test.id('W2'), ms_test.id('c'), 0);
select ms_test.snap('state', to_jsonb(ms_test.state()));
select ms_test.mark();
set local role authenticated;
select is(ms_test.mg('B', 'W2', 'W1'), ms_test.e('cycle_not_clustering'), 'collecting: merge_clusters gets cycle_not_clustering');
select is(ms_test.sp('B', 'W1', array['a'], 'New'), ms_test.e('cycle_not_clustering'), 'collecting: split_cluster gets cycle_not_clustering');
reset role;
select is(ms_test.new_events(), '[]'::jsonb, 'collecting: no event');
set local role authenticated;
select ms_test.start('A', 'P1');
reset role;
select ms_test.mark();
set local role authenticated;
select is(ms_test.mg('B', 'W2', 'W1'), ms_test.e('cycle_not_clustering'), 'reveal: merge_clusters gets cycle_not_clustering');
select is(ms_test.sp('B', 'W1', array['a'], 'New'), ms_test.e('cycle_not_clustering'), 'reveal: split_cluster gets cycle_not_clustering');
reset role;
select is(to_jsonb(ms_test.state()), ms_test.snapped('state'), 'collecting and reveal: the rows are unchanged');
select is(ms_test.new_events(), '[]'::jsonb, 'reveal: no event');
delete from public.clusters where id in (ms_test.id('W1'), ms_test.id('W2'));

-- ---------------------------------------------------------------------------
-- cluster: merge.
-- ---------------------------------------------------------------------------
set local role authenticated;
select ms_test.advance('A', 'P1', 'reveal');
select ms_test.mk('A', 'T');
select ms_test.mk('D', 'S');
select ms_test.mk('A', 'Z');
select ms_test.mk('A', 'Gone');
select ms_test.del('A', 'Gone');
select ms_test.mv('A', 'a', 'T');
select ms_test.mv('B', 'b', 'T');
select ms_test.mv('D', 'c', 'S');
select ms_test.mv('A', 'd', 'S');
select ms_test.mv('A', 'e', 'Z');
reset role;

select ms_test.snap('T order', to_jsonb(ms_test.cluster_order('T')));
select ms_test.snap('others', to_jsonb(ms_test.others(array['T', 'S'])));
select ms_test.snap('ungrouped', to_jsonb(ms_test.ungrouped()));
select ms_test.snap('cards', to_jsonb(ms_test.cards_state()));
select ms_test.mark();
set local role authenticated;
select is(ms_test.mg('B', 'S', 'T'), ms_test.row_of('T', 'T', 'manual'), 'B merges S into T and gets T''s id, name, and manual');
reset role;
select is(ms_test.list('T'), array['a', 'b', 'c', 'd'], 'T has [a, b, c, d]');
select is(ms_test.orders('T'), array[0, 1, 2, 3], 'numbered 0 .. 3');
select is(ms_test.exists_cluster('S'), false, 'S no longer exists');
set local role authenticated;
select is(ms_test.board_list(ms_test.board('B'), 'T'), array['a', 'b', 'c', 'd'], 'get_cycle_board lists T''s cards in that order');
select is(ms_test.board_list(ms_test.board('B'), 'S'), null, 'and no S');
reset role;
select is(to_jsonb(ms_test.cluster_order('T')), ms_test.snapped('T order'), 'T keeps its clusters.sort_order');
select is(to_jsonb(ms_test.others(array['T', 'S'])), ms_test.snapped('others'), 'no other cluster or cluster_cards row changed');
select is(to_jsonb(ms_test.ungrouped()), ms_test.snapped('ungrouped'), 'ungrouped cards stay ungrouped');
select is(to_jsonb(ms_test.cards_state()), ms_test.snapped('cards'), 'the cards, their count and texts are unchanged');
select is(ms_test.one_cluster_each(), true, 'every card is in at most one cluster');
select is(ms_test.events_ok(), true, 'the merge recorded clusters_changed events with no actor and an empty payload');
select is((select count(*)::int from jsonb_array_elements(ms_test.new_events()) e(j) where j ->> 'type' = 'stage_changed'), 0, 'and no stage_changed row');
select is(ms_test.new_other_events(), 0, 'and no other cycle''s events');

select ms_test.snap('state', to_jsonb(ms_test.state()));
select ms_test.mark();
set local role authenticated;
select is(ms_test.mg('B', 'T', 'S'), ms_test.e('cluster_not_found'), 'the opposite merge after it gets cluster_not_found');
select is(ms_test.mg('A', 'S', 'T'), ms_test.e('cluster_not_found'), 'the same merge again gets cluster_not_found');
reset role;
select is(to_jsonb(ms_test.state()), ms_test.snapped('state'), 'and changes nothing');
select is(ms_test.new_events(), '[]'::jsonb, 'and records nothing');

-- Stale order and AI clusters.
insert into public.clusters (id, cycle_id, name, source, sort_order)
values
  (ms_test.id('T2'), ms_test.id('P1'), 'Stale target', 'ai', 201),
  (ms_test.id('S2'), ms_test.id('P1'), 'Stale source', 'ai', 202);
insert into public.cluster_cards (cycle_id, cluster_id, card_id, sort_order)
values
  (ms_test.id('P1'), ms_test.id('T2'), ms_test.id('f'), 1),
  (ms_test.id('P1'), ms_test.id('T2'), ms_test.id('g'), 0),
  (ms_test.id('P1'), ms_test.id('T2'), ms_test.id('h'), 0),
  (ms_test.id('P1'), ms_test.id('S2'), ms_test.id('i'), 5),
  (ms_test.id('P1'), ms_test.id('S2'), ms_test.id('j'), 5);
select ms_test.snap('expected', to_jsonb(ms_test.list('T2') || ms_test.list('S2')));
select ms_test.snap('T2 order', to_jsonb(ms_test.cluster_order('T2')));
set local role authenticated;
select is(ms_test.mg('D', 'S2', 'T2'), ms_test.row_of('T2', 'Stale target', 'manual'), 'D merges AI cluster S2 into AI cluster T2');
reset role;
select is(to_jsonb(ms_test.list('T2')), ms_test.snapped('expected'), 'stale order: T2''s (sort_order, card_id) order, then S2''s');
select is((ms_test.list('T2'))[3], 'f', 'T2''s two sort_order 0 cards come before its sort_order 1 card');
select is(ms_test.orders('T2'), array[0, 1, 2, 3, 4], 'numbered 0 .. 4');
select is(ms_test.source('T2'), 'manual', 'an AI target that received cards becomes manual');
select is(to_jsonb(ms_test.cluster_order('T2')), ms_test.snapped('T2 order'), 'and keeps its place');

-- Empty source.
insert into public.clusters (id, cycle_id, name, source, sort_order)
values
  (ms_test.id('E'), ms_test.id('P1'), 'Empty source', 'manual', 301),
  (ms_test.id('TA'), ms_test.id('P1'), 'AI target', 'ai', 302);
insert into public.cluster_cards (cycle_id, cluster_id, card_id, sort_order)
values
  (ms_test.id('P1'), ms_test.id('TA'), ms_test.id('k'), 3),
  (ms_test.id('P1'), ms_test.id('TA'), ms_test.id('l'), 7);
select ms_test.snap('TA row', ms_test.cluster_row('TA'));
select ms_test.snap('TA cards', jsonb_build_object('list', ms_test.list('TA'), 'orders', ms_test.orders('TA')));
set local role authenticated;
select is(ms_test.mg('B', 'E', 'TA'), ms_test.row_of('TA', 'AI target', 'ai'), 'merging an empty source into an AI target returns it unchanged');
reset role;
select is(ms_test.exists_cluster('E'), false, 'the empty source is deleted');
select is(ms_test.cluster_row('TA'), ms_test.snapped('TA row'), 'the target row (source, updated_at, sort_order) is unchanged');
select is(jsonb_build_object('list', ms_test.list('TA'), 'orders', ms_test.orders('TA')), ms_test.snapped('TA cards'), 'its cards and their stale sort_order are unchanged');
set local role authenticated;
select ms_test.mk('B', 'Empty two');
reset role;
select ms_test.snap('Z row', ms_test.cluster_row('Z'));
set local role authenticated;
select is(ms_test.mg('B', 'Empty two', 'Z'), ms_test.row_of('Z', 'Z', 'manual'), 'merging an empty source into a manual target succeeds');
reset role;
select is(ms_test.cluster_row('Z'), ms_test.snapped('Z row'), 'and leaves the manual target row unchanged');
select is(ms_test.list('Z'), array['e'], 'and its cards');
-- Put k and l back for the sequences below.
delete from public.clusters where id = ms_test.id('TA');

-- Empty target.
insert into public.clusters (id, cycle_id, name, source, sort_order)
values (ms_test.id('ET'), ms_test.id('P1'), 'Empty target', 'ai', 401);
set local role authenticated;
select ms_test.mk('D', 'SS');
select ms_test.mv('D', 'o', 'SS');
select ms_test.mv('D', 'p', 'SS');
select is(ms_test.mg('A', 'SS', 'ET'), ms_test.row_of('ET', 'Empty target', 'manual'), 'merging into an empty AI target succeeds');
reset role;
select is(ms_test.list('ET'), array['o', 'p'], 'the target gets the source''s cards in order');
select is(ms_test.orders('ET'), array[0, 1], 'numbered 0, 1');
select is(ms_test.source('ET'), 'manual', 'and becomes manual');

-- Merge errors.
select ms_test.snap('state', to_jsonb(ms_test.state()));
select ms_test.mark();
set local role authenticated;
select is(ms_test.mg('B', 'T', 'T'), ms_test.e('cannot_merge_into_self'), 'merging a cluster into itself gets cannot_merge_into_self');
select is(ms_test.mg_raw('B', ms_test.id('T'), null), ms_test.e('cluster_not_found'), 'a null target gets cluster_not_found');
select is(ms_test.mg_raw('B', ms_test.id('T'), gen_random_uuid()), ms_test.e('cluster_not_found'), 'a random target gets cluster_not_found');
select is(ms_test.mg('B', 'T', 'Gone'), ms_test.e('cluster_not_found'), 'a deleted target gets cluster_not_found');
select is(ms_test.mg('B', 'T', 'P0x'), ms_test.e('cluster_not_found'), 'a target in another cycle of P gets cluster_not_found');
select is(ms_test.mg_raw('B', null, ms_test.id('T')), ms_test.e('cluster_not_found'), 'a null source gets cluster_not_found');
select is(ms_test.mg_raw('B', gen_random_uuid(), ms_test.id('T')), ms_test.e('cluster_not_found'), 'a random source gets cluster_not_found');
select is(ms_test.mg('C', 'Z', 'T'), ms_test.e('cluster_not_found'), 'non-member C merging P''s clusters gets cluster_not_found');
select is(ms_test.mg('C', 'Z', 'T'), ms_test.mg_raw('C', gen_random_uuid(), ms_test.id('T')), 'identical for an existing and a random source');
select is(ms_test.mg(null, 'Z', 'T'), ms_test.e('not_project_member'), 'a null auth.uid() gets not_project_member');
reset role;
select is(to_jsonb(ms_test.state()), ms_test.snapped('state'), 'after every failed merge the rows are unchanged');
select is(ms_test.new_events(), '[]'::jsonb, 'the failed merges recorded no event');

-- ---------------------------------------------------------------------------
-- cluster: split.
-- ---------------------------------------------------------------------------
select ms_test.snap('max order', to_jsonb(ms_test.max_order('P1')));
select ms_test.snap('others', to_jsonb(ms_test.others(array['T'])));
select ms_test.mark();
set local role authenticated;
select ms_test.snap('split', ms_test.sp('B', 'T', array['d', 'b'], '  Tools  ', 'Tools'));
reset role;
select is(ms_test.snapped('split'), ms_test.row_of('Tools', 'Tools', 'manual'), 'B splits [d, b] out of T = [a, b, c, d] and gets the new cluster''s id, Tools, manual');
select is(ms_test.id('Tools') is not null and ms_test.id('Tools') <> ms_test.id('T'), true, 'the id is new');
select is(ms_test.list('Tools'), array['b', 'd'], 'the new cluster has [b, d]: source order, not array order');
select is(ms_test.orders('Tools'), array[0, 1], 'numbered 0, 1');
select is(ms_test.list('T'), array['a', 'c'], 'T keeps [a, c]');
select is(ms_test.orders('T'), array[0, 1], 'renumbered 0, 1');
select is(ms_test.source('T'), 'manual', 'T is manual');
select is(to_jsonb(ms_test.cluster_order('Tools')), to_jsonb((ms_test.snapped('max order'))::int + 1), 'the new cluster''s sort_order is the previous maximum plus 1');
set local role authenticated;
select is(ms_test.board_last(ms_test.board('B')), ms_test.id('Tools'), 'get_cycle_board lists it last');
reset role;
select is(to_jsonb(ms_test.others(array['T', 'Tools'])), ms_test.snapped('others'), 'no other cluster or cluster_cards row changed');
select is(ms_test.one_cluster_each(), true, 'every card is in at most one cluster');
select is(ms_test.events_ok(), true, 'the split recorded clusters_changed events with no actor and an empty payload');
select is((select count(*)::int from jsonb_array_elements(ms_test.new_events()) e(j) where j ->> 'type' = 'stage_changed'), 0, 'and no stage_changed row');
select is(ms_test.new_other_events(), 0, 'and no other cycle''s events');

set local role authenticated;
select is(ms_test.sp('D', 'Tools', array['d'], 'Solo', 'Solo') -> 0 ->> 'name', 'Solo', 'splitting one card out of a two-card cluster succeeds');
reset role;
select is(ms_test.list('Tools'), array['b'], 'one card stays');
select is(ms_test.list('Solo'), array['d'], 'one card moves');

insert into public.clusters (id, cycle_id, name, source, sort_order)
values
  (ms_test.id('AIX'), ms_test.id('P1'), 'AI x', 'ai', 501),
  (ms_test.id('AIY'), ms_test.id('P1'), 'AI y', 'ai', 502);
insert into public.cluster_cards (cycle_id, cluster_id, card_id, sort_order)
values
  (ms_test.id('P1'), ms_test.id('AIX'), ms_test.id('r'), 0),
  (ms_test.id('P1'), ms_test.id('AIX'), ms_test.id('s'), 1),
  (ms_test.id('P1'), ms_test.id('AIX'), ms_test.id('t'), 2),
  (ms_test.id('P1'), ms_test.id('AIY'), ms_test.id('u'), 0);
set local role authenticated;
select is(ms_test.sp('A', 'AIX', array['t'], 'From AI', 'From AI') -> 0 ->> 'source', 'manual', 'a split of an AI cluster creates a manual cluster');
reset role;
select is(ms_test.source('AIX'), 'manual', 'and makes the AI cluster manual');
select is(ms_test.source('AIY'), 'ai', 'an untouched AI cluster stays ai');

-- Split errors, on AIX = [r, s].
select ms_test.snap('state', to_jsonb(ms_test.state()));
select ms_test.mark();
set local role authenticated;
select is(ms_test.sp_raw('B', ms_test.id('AIX'), null, 'New'), ms_test.e('invalid_card_selection'), 'a null selection gets invalid_card_selection');
select is(ms_test.sp_raw('B', ms_test.id('AIX'), '{}', 'New'), ms_test.e('invalid_card_selection'), 'an empty selection gets invalid_card_selection');
select is(ms_test.sp('B', 'AIX', array['r', 'r'], 'New'), ms_test.e('invalid_card_selection'), 'a duplicate id gets invalid_card_selection');
select is(ms_test.sp_raw('B', ms_test.id('AIX'), array[null]::uuid[], 'New'), ms_test.e('invalid_card_selection'), 'a null element gets invalid_card_selection');
select is(ms_test.sp('B', 'AIX', array['m'], 'New'), ms_test.e('card_not_in_cluster'), 'an ungrouped card gets card_not_in_cluster');
select is(ms_test.sp('B', 'AIX', array['a'], 'New'), ms_test.e('card_not_in_cluster'), 'a card of another cluster gets card_not_in_cluster');
select is(ms_test.sp('B', 'AIX', array['p0a'], 'New'), ms_test.e('card_not_in_cluster'), 'a card of another cycle gets card_not_in_cluster');
select is(ms_test.sp('B', 'AIX', array['q'], 'New'), ms_test.e('card_not_in_cluster'), 'a card of project Q gets card_not_in_cluster');
select is(ms_test.sp_raw('B', ms_test.id('AIX'), array[gen_random_uuid()], 'New'), ms_test.e('card_not_in_cluster'), 'a random id gets card_not_in_cluster');
select is(ms_test.sp_raw('B', ms_test.id('AIX'), array[ms_test.id('r'), gen_random_uuid()], 'New'), ms_test.e('card_not_in_cluster'), 'one good and one random id gets card_not_in_cluster');
select is(ms_test.sp('B', 'AIX', array['s', 'r'], 'New'), ms_test.e('split_takes_all_cards'), 'every card of the cluster gets split_takes_all_cards');
select is(ms_test.sp('B', 'Tools', array['b'], 'New'), ms_test.e('split_takes_all_cards'), 'the one card of a one-card cluster gets split_takes_all_cards');
select is(ms_test.sp('B', 'AIX', array['r'], null), ms_test.e('invalid_cluster_name'), 'a null name gets invalid_cluster_name');
select is(ms_test.sp('B', 'AIX', array['r'], ''), ms_test.e('invalid_cluster_name'), 'an empty name gets invalid_cluster_name');
select is(ms_test.sp('B', 'AIX', array['r'], '   '), ms_test.e('invalid_cluster_name'), 'a blank name gets invalid_cluster_name');
select is(ms_test.sp('B', 'AIX', array['r'], repeat('x', 101)), ms_test.e('invalid_cluster_name'), 'a 101-character name gets invalid_cluster_name');
select is(ms_test.sp('B', 'AIX', array['r'], 'a' || E'\n' || 'b'), ms_test.e('invalid_cluster_name'), 'a name with a line feed inside gets invalid_cluster_name');
select is(ms_test.sp('B', 'AIX', array['r'], 'ai X'), ms_test.e('cluster_name_taken'), 'the split cluster''s own name in another case gets cluster_name_taken');
select is(ms_test.sp('B', 'AIX', array['r'], 'TOOLS'), ms_test.e('cluster_name_taken'), 'another cluster''s name in any case gets cluster_name_taken');
select is(ms_test.sp(null, 'AIX', array['r'], 'New'), ms_test.e('not_project_member'), 'a null auth.uid() gets not_project_member');
select is(ms_test.sp_raw('B', null, array[ms_test.id('r')], 'New'), ms_test.e('cluster_not_found'), 'a null cluster id gets cluster_not_found');
select is(ms_test.sp_raw('B', gen_random_uuid(), array[ms_test.id('r')], 'New'), ms_test.e('cluster_not_found'), 'a random cluster id gets cluster_not_found');
select is(ms_test.sp('B', 'Gone', array['r'], 'New'), ms_test.e('cluster_not_found'), 'a deleted cluster gets cluster_not_found');
select is(ms_test.sp('B', 'S', array['r'], 'New'), ms_test.e('cluster_not_found'), 'a merged-away cluster gets cluster_not_found');
select is(ms_test.sp('C', 'AIX', array['r'], 'New'), ms_test.e('cluster_not_found'), 'non-member C on P''s cluster gets cluster_not_found');
select is(ms_test.sp('C', 'AIX', array['r'], 'New'), ms_test.sp_raw('C', gen_random_uuid(), array[ms_test.id('r')], 'New'), 'identical for an existing and a random cluster id');
reset role;
select is(to_jsonb(ms_test.state()), ms_test.snapped('state'), 'after every failed split the rows are unchanged');
select is(ms_test.new_events(), '[]'::jsonb, 'the failed splits recorded no event');

set local role authenticated;
select is(ms_test.sp('B', 'AIX', array['r'], repeat('y', 100)) -> 0 ->> 'name', repeat('y', 100), 'a 100-character name succeeds');
reset role;

-- The 50-cluster limit.
insert into public.clusters (cycle_id, name, sort_order)
select ms_test.id('P1'), 'Filler ' || g, 1000 + g
from generate_series(1, 50 - ms_test.cluster_count('P1')) g;
select is(ms_test.cluster_count('P1'), 50, 'the cycle has 50 clusters');
select ms_test.snap('state', to_jsonb(ms_test.state()));
select ms_test.mark();
set local role authenticated;
select is(ms_test.sp('B', 'ET', array['o'], 'Fifty-one'), ms_test.e('cluster_limit_reached'), 'a valid split at 50 clusters gets cluster_limit_reached');
reset role;
select is(ms_test.cluster_count('P1'), 50, 'the count stays 50');
select is(to_jsonb(ms_test.state()), ms_test.snapped('state'), 'and the rows are unchanged');
select is(ms_test.new_events(), '[]'::jsonb, 'and no event is recorded');
delete from public.clusters where cycle_id = ms_test.id('P1') and name like 'Filler %';

-- ---------------------------------------------------------------------------
-- A and B get identical results; own anonymous and others' attributed cards
-- behave the same.
-- ---------------------------------------------------------------------------
select is(ms_test.ungrouped() @> array['k', 'l', 'm', 'n'], true, 'k, l, m, n are ungrouped');
set local role authenticated;
select ms_test.snap('sequence A', ms_test.sequence('A'));
select ms_test.snap('sequence B', ms_test.sequence('B'));
reset role;
select is(ms_test.snapped('sequence A'), ms_test.snapped('sequence B'), 'the owner/facilitator and a member get identical results');
select is((select bool_and(jsonb_typeof(s -> 'result') = 'array') from jsonb_array_elements(ms_test.snapped('sequence B')) s), true, 'B splits its own anonymous card and A''s attributed card alike, and every merge succeeds');
select is(ms_test.snapped('sequence B') -> 4 -> 'T', '["m", "l", "k", "n"]'::jsonb, 'the sequence ends with every card in Seq T');
select is(ms_test.snapped('sequence B') -> 4 -> 'T orders', '[0, 1, 2, 3]'::jsonb, 'numbered 0 .. 3');
select is(ms_test.one_cluster_each(), true, 'every card is still in at most one cluster');

-- ---------------------------------------------------------------------------
-- vote, discuss, closed: neither runs.
-- ---------------------------------------------------------------------------
set local role authenticated;
select ms_test.advance('A', 'P1', 'cluster');
reset role;
select ms_test.snap('state', to_jsonb(ms_test.state()));
select ms_test.mark();
set local role authenticated;
select is(ms_test.mg('B', 'Tools', 'T'), ms_test.e('cycle_not_clustering'), 'vote: merge_clusters gets cycle_not_clustering');
select is(ms_test.sp('B', 'ET', array['o'], 'New'), ms_test.e('cycle_not_clustering'), 'vote: split_cluster gets cycle_not_clustering');
reset role;
update public.feedback_cycles set status = 'discuss', voting_closed_at = now() where id = ms_test.id('P1');
select ms_test.mark();
set local role authenticated;
select is(ms_test.mg('B', 'Tools', 'T'), ms_test.e('cycle_not_clustering'), 'discuss: merge_clusters gets cycle_not_clustering');
select is(ms_test.sp('B', 'ET', array['o'], 'New'), ms_test.e('cycle_not_clustering'), 'discuss: split_cluster gets cycle_not_clustering');
select ms_test.close('A', 'P1');
reset role;
select ms_test.mark();
set local role authenticated;
select is(ms_test.mg('B', 'Tools', 'T'), ms_test.e('cycle_not_clustering'), 'closed after reveal: merge_clusters gets cycle_not_clustering');
select is(ms_test.sp('B', 'ET', array['o'], 'New'), ms_test.e('cycle_not_clustering'), 'closed after reveal: split_cluster gets cycle_not_clustering');
reset role;
select is(to_jsonb(ms_test.state()), ms_test.snapped('state'), 'vote, discuss, and closed: the rows are unchanged');
select is(ms_test.new_events(), '[]'::jsonb, 'the refused calls recorded no event');

select * from finish();
rollback;
