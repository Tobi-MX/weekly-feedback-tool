-- pgTAP tests for card movement (#18): move_card's hardening and behaviour,
-- the clusters_changed events its writes record through #17's triggers, and
-- that the migration adds nothing else.
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension and the move_test helper schema. The seed user is never
-- used as a fixture.
--
-- Fixtures: owner and facilitator A, members B and D, non-member C. Project P
-- is owned by A with B and D joined; project Q is owned by C. P0 (P) gets a
-- cluster inserted as postgres and is closed from collecting. P1 (P) is the
-- main cycle: cards from A, B, and D through create_card (attributed and
-- anonymous), revealed through start_retrospective, moved to cluster through
-- advance_stage, with clusters from create_cluster; then vote, discuss (as
-- postgres), and closed through close_cycle. Q1 (Q) is C's.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(98);

-- ---------------------------------------------------------------------------
-- Test-only helpers. The ones that call RPCs are security invoker; the
-- read-back helpers are security definer so they see every row.
-- ---------------------------------------------------------------------------
create schema move_test;

create table move_test.ids (label text primary key, id uuid not null);
create table move_test.snaps (label text primary key, body jsonb);
create table move_test.seen (id uuid primary key);

insert into move_test.ids (label, id)
values
  ('A', '18000000-0000-4000-8000-000000000001'),
  ('B', '18000000-0000-4000-8000-000000000002'),
  ('C', '18000000-0000-4000-8000-000000000003'),
  ('D', '18000000-0000-4000-8000-000000000004'),
  ('P', '28000000-0000-4000-8000-000000000001'),
  ('Q', '28000000-0000-4000-8000-000000000002'),
  ('P0', '38000000-0000-4000-8000-000000000001'),
  ('P1', '38000000-0000-4000-8000-000000000002'),
  ('Q1', '38000000-0000-4000-8000-000000000011'),
  ('P0 cluster', '48000000-0000-4000-8000-000000000001'),
  ('AI1', '48000000-0000-4000-8000-000000000011'),
  ('AI2', '48000000-0000-4000-8000-000000000012'),
  ('AI3', '48000000-0000-4000-8000-000000000013'),
  ('AI4', '48000000-0000-4000-8000-000000000014');

create function move_test.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from move_test.ids i where i.label = p_label;
$$;

-- The label of a stored id.
create function move_test.label(p_id uuid)
returns text
language sql
stable
as $$
  select i.label from move_test.ids i where i.id = p_id;
$$;

create function move_test.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', move_test.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- move_card as the user with raw ids: "ok", or the full error.
create function move_test.mv_raw(p_user text, p_card uuid, p_cluster uuid, p_position integer)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform move_test.become(p_user);
  perform public.move_card(p_card, p_cluster, p_position);
  return to_jsonb('ok'::text);
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

-- move_card as the user with labels; a null cluster label is Ungrouped.
create function move_test.mv(p_user text, p_card text, p_cluster text, p_position integer)
returns jsonb
language sql
as $$
  select move_test.mv_raw(p_user, move_test.id(p_card), move_test.id(p_cluster), p_position);
$$;

create function move_test.ok()
returns jsonb
language sql
immutable
as $$
  select to_jsonb('ok'::text);
$$;

create function move_test.e(p_message text)
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

create function move_test.add_card(p_user text, p_category text, p_label text, p_anonymous boolean)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform move_test.become(p_user);
  select c.id into strict new_id
    from public.create_card(move_test.id(case when p_user = 'C' then 'Q1' else 'P1' end), p_category, p_label, p_anonymous) c;
  insert into move_test.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

create function move_test.mk(p_user text, p_name text)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform move_test.become(p_user);
  select r.cluster_id into strict new_id from public.create_cluster(move_test.id('P1'), p_name) r;
  insert into move_test.ids (label, id) values (p_name, new_id);
  return new_id;
end;
$$;

create function move_test.del(p_user text, p_cluster text)
returns void
language plpgsql
as $$
begin
  perform move_test.become(p_user);
  perform public.delete_cluster(move_test.id(p_cluster));
end;
$$;

create function move_test.start(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform move_test.become(p_user);
  perform 1 from public.start_retrospective(move_test.id(p_cycle));
end;
$$;

create function move_test.advance(p_user text, p_cycle text, p_from text)
returns void
language plpgsql
as $$
begin
  perform move_test.become(p_user);
  perform 1 from public.advance_stage(move_test.id(p_cycle), p_from);
end;
$$;

create function move_test.close(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform move_test.become(p_user);
  perform 1 from public.close_cycle(move_test.id(p_cycle));
end;
$$;

create function move_test.board(p_user text)
returns jsonb
language plpgsql
as $$
begin
  perform move_test.become(p_user);
  return public.get_cycle_board(move_test.id('P1'));
end;
$$;

-- The card labels of a cluster in a board response, in card_ids order.
create function move_test.board_list(p_board jsonb, p_cluster text)
returns text[]
language sql
stable
as $$
  select coalesce(array_agg(move_test.label(x::uuid) order by o), '{}')
  from jsonb_array_elements(p_board -> 'clusters') c
  cross join lateral jsonb_array_elements_text(c -> 'card_ids') with ordinality e(x, o)
  where (c ->> 'cluster_id')::uuid = move_test.id(p_cluster);
$$;

-- Every card id listed in any cluster of a board response.
create function move_test.board_clustered(p_board jsonb)
returns text[]
language sql
stable
as $$
  select coalesce(array_agg(move_test.label(x::uuid) order by move_test.label(x::uuid)), '{}')
  from jsonb_array_elements(p_board -> 'clusters') c
  cross join lateral jsonb_array_elements_text(c -> 'card_ids') e(x);
$$;

-- A cluster's card labels in (sort_order, card_id) order, read as postgres.
create function move_test.list(p_cluster text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(i.label order by cc.sort_order, cc.card_id), '{}')
  from public.cluster_cards cc
  join move_test.ids i on i.id = cc.card_id
  where cc.cluster_id = (select x.id from move_test.ids x where x.label = p_cluster);
$$;

-- A cluster's sort_order values in that order, read as postgres.
create function move_test.orders(p_cluster text)
returns integer[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(cc.sort_order order by cc.sort_order, cc.card_id), '{}')
  from public.cluster_cards cc
  where cc.cluster_id = (select x.id from move_test.ids x where x.label = p_cluster);
$$;

-- Whether a cluster's sort_order values are exactly 0 .. n-1.
create function move_test.contiguous(p_cluster text)
returns boolean
language sql
stable
as $$
  select move_test.orders(p_cluster) = coalesce(
    (select array_agg(g order by g) from generate_series(0, cardinality(move_test.orders(p_cluster)) - 1) g),
    '{}'
  );
$$;

create function move_test.source(p_cluster text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select cl.source from public.clusters cl where cl.id = (select x.id from move_test.ids x where x.label = p_cluster);
$$;

-- An md5 of every clusters and cluster_cards row of P1 (timestamps included).
create function move_test.state()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(
    coalesce((select string_agg(to_jsonb(cl)::text, '|' order by cl.id) from public.clusters cl where cl.cycle_id = '38000000-0000-4000-8000-000000000002'), '')
    || '#'
    || coalesce((select string_agg(to_jsonb(cc)::text, '|' order by cc.card_id) from public.cluster_cards cc where cc.cycle_id = '38000000-0000-4000-8000-000000000002'), '')
  );
$$;

-- An md5 of one cluster's cluster_cards rows.
create function move_test.rows_of(p_cluster text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(coalesce(string_agg(to_jsonb(cc)::text, '|' order by cc.card_id), ''))
  from public.cluster_cards cc
  where cc.cluster_id = (select x.id from move_test.ids x where x.label = p_cluster);
$$;

-- No card is in two clusters and there are no more memberships than cards.
create function move_test.one_cluster_each()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) = count(distinct cc.card_id)
     and count(*) <= (select count(*) from public.cards c where c.cycle_id = '38000000-0000-4000-8000-000000000002')
  from public.cluster_cards cc
  where cc.cycle_id = '38000000-0000-4000-8000-000000000002';
$$;

create function move_test.mark()
returns void
language sql
security definer
set search_path = ''
as $$
  insert into move_test.seen (id)
  select e.id from public.cycle_events e
  on conflict do nothing;
$$;

-- The unseen events of P1, without id, cycle_id, and created_at.
create function move_test.new_events()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(e) - 'id' - 'cycle_id' - 'created_at'), '[]'::jsonb)
  from public.cycle_events e
  where e.cycle_id = '38000000-0000-4000-8000-000000000002'
    and not exists (select 1 from move_test.seen s where s.id = e.id);
$$;

create function move_test.new_other_events()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int
  from public.cycle_events e
  where e.cycle_id <> '38000000-0000-4000-8000-000000000002'
    and not exists (select 1 from move_test.seen s where s.id = e.id);
$$;

-- Whether the unseen events are at least one, each a clusters_changed row
-- of a cluster-stage cycle with no actor and an empty payload.
create function move_test.events_ok()
returns boolean
language sql
stable
as $$
  select jsonb_array_length(move_test.new_events()) >= 1
     and not exists (
       select 1 from jsonb_array_elements(move_test.new_events()) e(j)
       where j <> jsonb_build_object('type', 'clusters_changed', 'from_status', 'cluster', 'to_status', 'cluster', 'actor_id', null, 'payload', '{}'::jsonb)
     );
$$;

create function move_test.snap(p_label text, p_body jsonb)
returns void
language sql
as $$
  insert into move_test.snaps (label, body) values (p_label, p_body)
  on conflict (label) do update set body = excluded.body;
$$;

create function move_test.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.body from move_test.snaps s where s.label = p_label;
$$;

-- One sequence of moves as the user over ungrouped cards k, l, m into X and
-- Y; returns the lists after each step and puts the cards back at the end.
create function move_test.sequence(p_user text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := '[]'::jsonb;
  step jsonb;
  outcome jsonb;
begin
  foreach step in array array[
    jsonb_build_array('k', 'X', null),
    jsonb_build_array('l', 'X', 0),
    jsonb_build_array('m', 'Y', null),
    jsonb_build_array('k', 'X', 0),
    jsonb_build_array('m', 'X', 1),
    jsonb_build_array('l', null, null)
  ] loop
    -- A separate statement, so the read-back below sees the move.
    outcome := move_test.mv(p_user, step ->> 0, step ->> 1, (step ->> 2)::int);
    result := result || jsonb_build_array(jsonb_build_object(
      'result', outcome,
      'X', to_jsonb(move_test.list('X')),
      'Y', to_jsonb(move_test.list('Y')),
      'X orders', to_jsonb(move_test.orders('X'))
    ));
  end loop;
  perform move_test.mv(p_user, 'k', null, null);
  perform move_test.mv(p_user, 'm', null, null);
  return result;
end;
$$;

grant usage on schema move_test to authenticated;
grant select, insert, update on all tables in schema move_test to authenticated;
grant execute on all functions in schema move_test to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures. The token columns are empty strings, as the Auth server writes
-- them.
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', '18000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'move-a@example.com', '{"display_name":"Alice"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '18000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'move-b@example.com', '{"display_name":"Bob"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '18000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'move-c@example.com', '{"display_name":"Cara"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '18000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'move-d@example.com', '{"display_name":"Dan"}', '', '', '', '');

insert into public.projects (id, name, owner_id)
values
  ('28000000-0000-4000-8000-000000000001', 'Project P', '18000000-0000-4000-8000-000000000001'),
  ('28000000-0000-4000-8000-000000000002', 'Project Q', '18000000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('28000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-000000000002', 'member'),
  ('28000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-000000000004', 'member');

-- P0: a closed cycle of P with one cluster.
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('38000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001', 'P early close', '2026-10-12');
insert into public.clusters (id, cycle_id, name, sort_order)
values ('48000000-0000-4000-8000-000000000001', '38000000-0000-4000-8000-000000000001', 'Old cluster', 1);
set local role authenticated;
select move_test.close('A', 'P0');
reset role;

insert into public.feedback_cycles (id, project_id, title, week_start)
values
  ('38000000-0000-4000-8000-000000000002', '28000000-0000-4000-8000-000000000001', 'P main', '2026-10-26'),
  ('38000000-0000-4000-8000-000000000011', '28000000-0000-4000-8000-000000000002', 'Q one', '2026-10-26');

set local role authenticated;
select move_test.add_card('A', 'start', 'a', false);
select move_test.add_card('B', 'stop', 'b', true);
select move_test.add_card('D', 'continue', 'c', false);
select move_test.add_card('B', 'start', 'd', false);
select move_test.add_card('A', 'stop', 'e', true);
select move_test.add_card('D', 'start', 'f', true);
select move_test.add_card('A', 'continue', 'g', false);
select move_test.add_card('B', 'continue', 'h', true);
select move_test.add_card('D', 'stop', 'i', false);
select move_test.add_card('A', 'start', 'j', true);
select move_test.add_card('B', 'stop', 'k', true);
select move_test.add_card('A', 'continue', 'l', false);
select move_test.add_card('D', 'start', 'm', false);
select move_test.add_card('C', 'start', 'q', false);
reset role;

-- ---------------------------------------------------------------------------
-- The migration: move_card only.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'move_card'), 1, 'move_card has exactly one overload');
select is(pg_get_function_identity_arguments('public.move_card(uuid, uuid, integer)'::regprocedure), 'p_card_id uuid, p_cluster_id uuid, p_position integer', 'move_card arguments');
select is(pg_get_function_result('public.move_card(uuid, uuid, integer)'::regprocedure), 'void', 'move_card returns void');
select is((select p.prosecdef and p.provolatile = 'v' and p.proconfig = array['search_path=""']::text[] from pg_proc p where p.oid = 'public.move_card(uuid, uuid, integer)'::regprocedure), true, 'move_card is security definer, volatile, and fixes search_path to empty');
select is(
  array[
    has_function_privilege('authenticated', 'public.move_card(uuid, uuid, integer)', 'EXECUTE'),
    has_function_privilege('anon', 'public.move_card(uuid, uuid, integer)', 'EXECUTE'),
    has_function_privilege('service_role', 'public.move_card(uuid, uuid, integer)', 'EXECUTE')
  ],
  array[true, false, false],
  'move_card is executable by authenticated only'
);
select is((select (count(*) filter (where a.grantee = 0))::int from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.move_card(uuid, uuid, integer)'::regprocedure), 0, 'PUBLIC cannot execute move_card');
select is((select p.prosrc ~ 'from public\.feedback_cycles fc\s+where fc\.id = \w+\s+for update;' from pg_proc p where p.oid = 'public.move_card(uuid, uuid, integer)'::regprocedure), true, 'move_card locks the cycle row FOR UPDATE on public.feedback_cycles');
select is((select p.prosrc ~* '(cycle_events|card_authors|profiles|created_at|updated_at|is_project_facilitator|owner_id|execute|raise\s+notice)' from pg_proc p where p.oid = 'public.move_card(uuid, uuid, integer)'::regprocedure), false, 'move_card mentions no cycle_events, card_authors, profiles, timestamps, facilitator, owner, dynamic SQL, or notice');
select is((select p.prosrc ~ '\(select auth\.uid\(\)\) is null' and p.prosrc ~ 'private\.is_project_member\(cycle_project\)' from pg_proc p where p.oid = 'public.move_card(uuid, uuid, integer)'::regprocedure), true, 'move_card checks (select auth.uid()) and uses private.is_project_member');
select is(
  (select array_agg(distinct m.msg[1]::text order by m.msg[1]::text) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'message\s*=\s*''([^'']*)''', 'g') as m(msg) where p.oid = 'public.move_card(uuid, uuid, integer)'::regprocedure),
  array['card_not_found', 'cluster_not_found', 'cycle_not_clustering', 'invalid_card_position', 'not_project_member'],
  'move_card raises exactly the messages of the error table'
);
select is(
  (select (select count(*) from regexp_matches(p.prosrc, '\mraise\M', 'gi')) = (select count(*) from regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''[a-z_]+'';', 'g')) from pg_proc p where p.oid = 'public.move_card(uuid, uuid, integer)'::regprocedure),
  true,
  'every raise sets only the code and a stable message, with no detail or hint'
);
select is(pg_get_function_identity_arguments('public.move_card(uuid, uuid, integer)'::regprocedure) ~* 'user|author|actor', false, 'move_card takes no user id');
select is((select md5(prosrc) from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), '63317c82ae89c6b9c7851c07bafefbc7', 'get_cycle_board is unchanged from #17');
select is((select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.clusters'::regclass, 'public.cluster_cards'::regclass)), true, 'clusters and cluster_cards keep RLS enabled');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('clusters', 'cluster_cards', 'cards', 'card_authors')), 0, 'clusters, cluster_cards, cards, and card_authors still have no policy');
select is(
  (select array_agg(tablename || ':' || n order by tablename) from (select tablename, count(*)::text n from pg_policies where schemaname = 'public' group by tablename) x),
  array['cycle_events:1', 'feedback_cycles:1', 'profiles:2', 'project_members:1', 'projects:3'],
  'the public policies are exactly those before #18'
);
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated']) r cross join unnest(array['public.clusters', 'public.cluster_cards', 'public.cards', 'public.card_authors']) t cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p where has_table_privilege(r, t, p)),
  0,
  'anon and authenticated hold no privilege on clusters, cluster_cards, cards, or card_authors'
);
select is((select array_agg(tablename::text order by tablename) from pg_publication_tables where pubname = 'supabase_realtime'), array['cycle_events'], 'supabase_realtime still publishes only cycle_events');
select is((select count(*)::int from pg_views where schemaname = 'public'), 0, 'no view in public');

-- ---------------------------------------------------------------------------
-- collecting and reveal: no move.
-- ---------------------------------------------------------------------------
select move_test.mark();
set local role authenticated;
select is(move_test.mv('B', 'a', null, null), move_test.e('cycle_not_clustering'), 'collecting: move_card gets cycle_not_clustering');
select move_test.start('A', 'P1');
select is(move_test.mv('B', 'a', null, null), move_test.e('cycle_not_clustering'), 'reveal: move_card gets cycle_not_clustering');
select move_test.snap('board before', move_test.board('B'));
select move_test.advance('A', 'P1', 'reveal');
select move_test.mk('A', 'X');
select move_test.mk('B', 'Y');
select move_test.mk('D', 'Z');
select move_test.mk('A', 'Gone');
select move_test.del('A', 'Gone');
reset role;

-- ---------------------------------------------------------------------------
-- Into a cluster, positions, between clusters, to Ungrouped.
-- ---------------------------------------------------------------------------
select move_test.mark();
set local role authenticated;
select is(move_test.mv('B', 'a', 'X', null), move_test.ok(), 'B moves an ungrouped card into empty cluster X');
select is(move_test.list('X'), array['a'], 'the card is in X');
select is(move_test.orders('X'), array[0], 'with sort_order 0');
select is(move_test.board_list(move_test.board('B'), 'X'), array['a'], 'get_cycle_board lists it in X');
reset role;
select is(move_test.events_ok(), true, 'the move recorded clusters_changed events with no actor and an empty payload');
select is((select count(*)::int from jsonb_array_elements(move_test.new_events()) e(j) where j ->> 'type' = 'stage_changed'), 0, 'and no stage_changed row');
select is(move_test.new_other_events(), 0, 'and no other cycle''s events');

set local role authenticated;
select move_test.mv('B', 'b', 'X', null);
select move_test.mv('B', 'c', 'X', null);
select is(move_test.list('X'), array['a', 'b', 'c'], 'X = [a, b, c]');
select is(move_test.mv('B', 'a', 'X', 2), move_test.ok(), 'move_card(a, X, 2)');
select is(move_test.list('X'), array['b', 'c', 'a'], 'gives [b, c, a]');
select is(move_test.orders('X'), array[0, 1, 2], 'numbered 0 .. 2');
select move_test.mv('B', 'a', 'X', 0);
select is(move_test.list('X'), array['a', 'b', 'c'], 'move_card(a, X, 0) restores [a, b, c]');
select is(move_test.mv('D', 'c', 'X', 0), move_test.ok(), 'move_card(c, X, 0)');
select is(move_test.list('X'), array['c', 'a', 'b'], 'gives [c, a, b]');
select is(move_test.orders('X'), array[0, 1, 2], 'numbered 0 .. 2');
select move_test.mv('D', 'c', 'X', 2);
select is(move_test.list('X'), array['a', 'b', 'c'], 'move_card(c, X, 2) restores [a, b, c]');
select is(move_test.mv('A', 'd', 'X', 1), move_test.ok(), 'move_card(d, X, 1) from Ungrouped');
select is(move_test.list('X'), array['a', 'd', 'b', 'c'], 'gives [a, d, b, c]');
select is(move_test.orders('X'), array[0, 1, 2, 3], 'numbered 0 .. 3');
select is(move_test.mv('A', 'd', null, null), move_test.ok(), 'd back to Ungrouped');
select is(move_test.list('X'), array['a', 'b', 'c'], 'X is [a, b, c] again');
select is(move_test.orders('X'), array[0, 1, 2], 'and renumbered 0 .. 2');
select is(move_test.mv('A', 'd', 'X', 99), move_test.ok(), 'move_card(d, X, 99)');
select is(move_test.list('X'), array['a', 'b', 'c', 'd'], 'clamps to [a, b, c, d]');
select is(move_test.orders('X'), array[0, 1, 2, 3], 'numbered 0 .. 3');
select move_test.mv('A', 'd', null, null);
select is(move_test.mv('A', 'd', 'X', null), move_test.ok(), 'move_card(d, X, null)');
select is(move_test.list('X'), array['a', 'b', 'c', 'd'], 'appends: [a, b, c, d]');
select move_test.mv('A', 'd', null, null);

select move_test.mv('B', 'e', 'Y', null);
select is(move_test.mv('B', 'b', 'Y', 0), move_test.ok(), 'b moves from X to Y at position 0');
select is(move_test.list('X'), array['a', 'c'], 'X = [a, c]');
select is(move_test.orders('X'), array[0, 1], 'X numbered 0, 1');
select is(move_test.list('Y'), array['b', 'e'], 'Y has b first');
select is(move_test.orders('Y'), array[0, 1], 'Y numbered 0, 1');

select is(move_test.mv('D', 'c', null, null), move_test.ok(), 'c to Ungrouped');
reset role;
select is((select count(*)::int from public.cluster_cards where card_id = move_test.id('c')), 0, 'its cluster_cards row is gone');
select is(move_test.orders('X'), array[0], 'its old cluster is renumbered');
set local role authenticated;
select is('c' = any(move_test.board_clustered(move_test.board('B'))), false, 'it is in no card_ids');
select is(move_test.board('B') -> 'cards', move_test.snapped('board before') -> 'cards', 'the cards are in the same response order as before any move');
reset role;
select is(move_test.one_cluster_each(), true, 'every card is in at most one cluster');

-- ---------------------------------------------------------------------------
-- Stale order is repaired; an untouched cluster is unchanged.
-- ---------------------------------------------------------------------------
insert into public.cluster_cards (cycle_id, cluster_id, card_id, sort_order)
values
  (move_test.id('P1'), move_test.id('Z'), move_test.id('c'), 0),
  (move_test.id('P1'), move_test.id('Z'), move_test.id('d'), 0);
select move_test.snap('Y rows', to_jsonb(move_test.rows_of('Y')));
select move_test.snap('Z old', to_jsonb(move_test.list('Z')));
set local role authenticated;
select is(move_test.mv('B', 'f', 'Z', 1), move_test.ok(), 'f moves into Z with duplicate sort_order 0');
reset role;
select is(
  move_test.list('Z'),
  array[move_test.snapped('Z old') ->> 0, 'f', move_test.snapped('Z old') ->> 1],
  'Z keeps the old (sort_order, card_id) order around f'
);
select is(move_test.orders('Z'), array[0, 1, 2], 'and is numbered 0 .. 2');
select is(to_jsonb(move_test.rows_of('Y')), move_test.snapped('Y rows'), 'Y, untouched, keeps its rows');

-- ---------------------------------------------------------------------------
-- source.
-- ---------------------------------------------------------------------------
insert into public.clusters (id, cycle_id, name, source, sort_order)
values
  (move_test.id('AI1'), move_test.id('P1'), 'AI one', 'ai', 101),
  (move_test.id('AI2'), move_test.id('P1'), 'AI two', 'ai', 102),
  (move_test.id('AI3'), move_test.id('P1'), 'AI three', 'ai', 103),
  (move_test.id('AI4'), move_test.id('P1'), 'AI four', 'ai', 104);
insert into public.cluster_cards (cycle_id, cluster_id, card_id, sort_order)
values
  (move_test.id('P1'), move_test.id('AI1'), move_test.id('g'), 0),
  (move_test.id('P1'), move_test.id('AI1'), move_test.id('h'), 1),
  (move_test.id('P1'), move_test.id('AI3'), move_test.id('i'), 0),
  (move_test.id('P1'), move_test.id('AI3'), move_test.id('j'), 1);
set local role authenticated;
select move_test.mv('B', 'g', 'AI2', null);
reset role;
select is(array[move_test.source('AI1'), move_test.source('AI2')], array['manual', 'manual'], 'a move from one AI cluster to another makes both manual');
set local role authenticated;
select move_test.mv('D', 'j', 'AI3', 0);
reset role;
select is(move_test.list('AI3'), array['j', 'i'], 'a reorder inside AI three');
select is(move_test.source('AI3'), 'manual', 'makes it manual');
update public.clusters set source = 'ai' where id = move_test.id('AI1');
set local role authenticated;
select move_test.mv('A', 'h', null, null);
reset role;
select is(move_test.source('AI1'), 'manual', 'moving out of an AI cluster to Ungrouped makes it manual');
select is(move_test.source('AI4'), 'ai', 'an untouched AI cluster stays ai');

-- ---------------------------------------------------------------------------
-- No-ops.
-- ---------------------------------------------------------------------------
update public.clusters set source = 'ai' where id = move_test.id('AI3');
select move_test.snap('state', to_jsonb(move_test.state()));
select move_test.mark();
set local role authenticated;
select is(move_test.mv('B', 'h', null, null), move_test.ok(), 'an ungrouped card to Ungrouped succeeds');
select is(move_test.mv('B', 'j', 'AI3', 0), move_test.ok(), 'a card to its current index succeeds');
select is(move_test.mv('B', 'i', 'AI3', 99), move_test.ok(), 'a card to a clamped index equal to its last place succeeds');
select is(move_test.mv('B', 'i', 'AI3', null), move_test.ok(), 'a card to the end where it already is succeeds');
reset role;
select is(to_jsonb(move_test.state()), move_test.snapped('state'), 'the no-ops changed no row, source, or updated_at');
select is(move_test.source('AI3'), 'ai', 'AI three is still ai');
select is(move_test.new_events(), '[]'::jsonb, 'the no-ops recorded no event');

-- ---------------------------------------------------------------------------
-- A and B get identical results; own anonymous and others' attributed cards
-- behave the same.
-- ---------------------------------------------------------------------------
set local role authenticated;
select move_test.snap('sequence A', move_test.sequence('A'));
select move_test.snap('sequence B', move_test.sequence('B'));
reset role;
select is(move_test.snapped('sequence A'), move_test.snapped('sequence B'), 'the owner/facilitator and a member get identical results');
select is((select bool_and(s -> 'result' = move_test.ok()) from jsonb_array_elements(move_test.snapped('sequence B')) s), true, 'B moves its own anonymous card and A''s attributed card alike');
select is(move_test.snapped('sequence B') -> 5 -> 'X', '["k", "m", "a"]'::jsonb, 'the sequence ends with the expected X');
select is(move_test.one_cluster_each(), true, 'every card is still in at most one cluster');

-- ---------------------------------------------------------------------------
-- Errors: each changes nothing and records nothing.
-- ---------------------------------------------------------------------------
select move_test.snap('state', to_jsonb(move_test.state()));
select move_test.mark();
set local role authenticated;
select is(move_test.mv(null, 'a', 'X', null), move_test.e('not_project_member'), 'a null auth.uid() gets not_project_member');
select is(move_test.mv_raw('B', null, move_test.id('X'), null), move_test.e('card_not_found'), 'a null card id gets card_not_found');
select is(move_test.mv_raw('B', gen_random_uuid(), move_test.id('X'), null), move_test.e('card_not_found'), 'a random card id gets card_not_found');
select is(move_test.mv('B', 'q', 'X', null), move_test.e('card_not_found'), 'a card of project Q gets card_not_found');
select is(move_test.mv('C', 'a', 'X', null), move_test.e('card_not_found'), 'non-member C moving P''s card gets card_not_found');
select is(move_test.mv('C', 'a', 'X', null), move_test.mv_raw('C', gen_random_uuid(), move_test.id('X'), null), 'the error is identical for an existing and a random card id');
select is(move_test.mv_raw('B', move_test.id('a'), gen_random_uuid(), null), move_test.e('cluster_not_found'), 'a random cluster id gets cluster_not_found');
select is(move_test.mv('B', 'a', 'Gone', null), move_test.e('cluster_not_found'), 'a deleted cluster gets cluster_not_found');
select is(move_test.mv('B', 'a', 'P0 cluster', null), move_test.e('cluster_not_found'), 'a cluster of another cycle of P gets cluster_not_found');
select is(move_test.mv('B', 'a', 'X', -1), move_test.e('invalid_card_position'), 'position -1 gets invalid_card_position');
select is(move_test.mv('B', 'a', null, 0), move_test.e('invalid_card_position'), 'position 0 with a null target gets invalid_card_position');
reset role;
select is(to_jsonb(move_test.state()), move_test.snapped('state'), 'after every failure the rows are unchanged');
select is(move_test.new_events(), '[]'::jsonb, 'the failures recorded no event');

-- ---------------------------------------------------------------------------
-- vote, discuss, closed: no move.
-- ---------------------------------------------------------------------------
set local role authenticated;
select move_test.advance('A', 'P1', 'cluster');
reset role;
select move_test.snap('state', to_jsonb(move_test.state()));
select move_test.mark();
set local role authenticated;
select is(move_test.mv('B', 'a', 'Y', null), move_test.e('cycle_not_clustering'), 'vote: a move into a cluster gets cycle_not_clustering');
select is(move_test.mv('B', 'a', null, null), move_test.e('cycle_not_clustering'), 'vote: a move to Ungrouped gets cycle_not_clustering');
reset role;
update public.feedback_cycles set status = 'discuss', voting_closed_at = now() where id = move_test.id('P1');
select move_test.mark();
set local role authenticated;
select is(move_test.mv('B', 'a', 'Y', null), move_test.e('cycle_not_clustering'), 'discuss: move_card gets cycle_not_clustering');
select move_test.close('A', 'P1');
reset role;
select move_test.mark();
set local role authenticated;
select is(move_test.mv('B', 'a', 'Y', null), move_test.e('cycle_not_clustering'), 'closed after reveal: move_card gets cycle_not_clustering');
reset role;
select is(to_jsonb(move_test.state()), move_test.snapped('state'), 'vote, discuss, and closed: the rows are unchanged');
select is(move_test.new_events(), '[]'::jsonb, 'the refused calls recorded no event');

select * from finish();
rollback;
