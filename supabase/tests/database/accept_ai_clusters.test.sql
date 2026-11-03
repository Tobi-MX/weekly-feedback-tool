-- pgTAP tests for #21: accept_ai_clusters keeps the AI suggestions. Covers
-- the hardening, the check order, the facilitator's keep (ids, names, order,
-- cards, the one event), the no-op second call, the refusals for members, the
-- owner when not the facilitator, a former facilitator, non-members and
-- unknown ids, the wrong stages, the stale check against an AI run in flight,
-- and that nothing else in the schema changed.
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension and the ak_test helper schema. The seed user is never
-- used as a fixture.
--
-- Fixtures (as in #100): owner A (facilitator by default), members B and D,
-- non-member C. P is owned by A with B and D joined; Q is owned by C. P1 (P)
-- is the main cycle: attributed and anonymous cards from A, B, and D through
-- create_card, revealed and moved to cluster by A, a manual cluster made
-- through the RPCs, and AI clusters written through #20's
-- begin_ai_clustering + replace_ai_clusters as service_role. Q1 (Q) is C's,
-- in cluster.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(49);

-- ---------------------------------------------------------------------------
-- Test-only helpers. The ones that call RPCs are security invoker; the
-- read-back helpers are security definer so they see every row.
-- ---------------------------------------------------------------------------
create schema ak_test;

create table ak_test.ids (label text primary key, id uuid not null);
create table ak_test.snaps (label text primary key, body jsonb);
create table ak_test.seen (id uuid primary key);

insert into ak_test.ids (label, id)
values
  ('A', '1d000000-0000-4000-8000-000000000001'),
  ('B', '1d000000-0000-4000-8000-000000000002'),
  ('C', '1d000000-0000-4000-8000-000000000003'),
  ('D', '1d000000-0000-4000-8000-000000000004'),
  ('P', '2d000000-0000-4000-8000-000000000001'),
  ('Q', '2d000000-0000-4000-8000-000000000002'),
  ('P1', '3d000000-0000-4000-8000-000000000001'),
  ('Q1', '3d000000-0000-4000-8000-000000000011');

create function ak_test.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from ak_test.ids i where i.label = p_label;
$$;

create function ak_test.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', ak_test.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- The error a refused call gets, with empty detail and hint.
create function ak_test.e(p_message text)
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

-- accept_ai_clusters as the user with a raw cycle id: the count, or the full
-- error.
create function ak_test.accept_raw(p_user text, p_cycle uuid)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform ak_test.become(p_user);
  return to_jsonb(public.accept_ai_clusters(p_cycle));
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

create function ak_test.accept(p_user text, p_cycle text default 'P1')
returns jsonb
language sql
as $$
  select ak_test.accept_raw(p_user, ak_test.id(p_cycle));
$$;

create function ak_test.add_card(p_user text, p_category text, p_label text, p_anonymous boolean)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform ak_test.become(p_user);
  select c.id into strict new_id
    from public.create_card(ak_test.id('P1'), p_category, p_label, p_anonymous) c;
  insert into ak_test.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

-- create_cluster as the user; stores the new id under the name.
create function ak_test.mk(p_user text, p_name text)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform ak_test.become(p_user);
  select r.cluster_id into strict new_id from public.create_cluster(ak_test.id('P1'), p_name) r;
  insert into ak_test.ids (label, id) values (p_name, new_id);
  return new_id;
end;
$$;

create function ak_test.move(p_user text, p_card text, p_cluster text)
returns void
language plpgsql
as $$
begin
  perform ak_test.become(p_user);
  perform public.move_card(ak_test.id(p_card), ak_test.id(p_cluster), null);
end;
$$;

create function ak_test.transfer(p_user text, p_to text)
returns void
language plpgsql
as $$
begin
  perform ak_test.become(p_user);
  perform public.transfer_facilitator(ak_test.id('P'), ak_test.id(p_to));
end;
$$;

create function ak_test.start(p_user text)
returns void
language plpgsql
as $$
begin
  perform ak_test.become(p_user);
  perform 1 from public.start_retrospective(ak_test.id('P1'));
end;
$$;

create function ak_test.advance(p_user text, p_from text)
returns void
language plpgsql
as $$
begin
  perform ak_test.become(p_user);
  perform 1 from public.advance_stage(ak_test.id('P1'), p_from);
end;
$$;

create function ak_test.close(p_user text)
returns void
language plpgsql
as $$
begin
  perform ak_test.become(p_user);
  perform 1 from public.close_cycle(ak_test.id('P1'));
end;
$$;

create function ak_test.board(p_user text)
returns jsonb
language plpgsql
as $$
begin
  perform ak_test.become(p_user);
  return public.get_cycle_board(ak_test.id('P1'));
end;
$$;

-- One payload cluster from card labels.
create function ak_test.cl(p_name text, p_category text, p_cards text[])
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'name', p_name,
    'category', p_category,
    'card_ids', (select jsonb_agg(ak_test.id(c) order by o) from unnest(p_cards) with ordinality u(c, o))
  );
$$;

-- begin_ai_clustering as service_role for A; stores the run id. Returns the
-- run id.
create function ak_test.begin_run(p_label text)
returns uuid
language plpgsql
as $$
declare
  result jsonb;
begin
  result := public.begin_ai_clustering(ak_test.id('P1'), ak_test.id('A'), 'claude-opus-5-5', 'cluster-feedback/v1');
  insert into ak_test.ids (label, id) values (p_label, (result ->> 'run_id')::uuid)
  on conflict (label) do update set id = excluded.id;
  return (result ->> 'run_id')::uuid;
end;
$$;

-- replace_ai_clusters for the run as service_role: "ok", or the full error.
create function ak_test.replace(p_run text, p_clusters jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform public.replace_ai_clusters(ak_test.id(p_run), ak_test.id('A'), p_clusters, '{}'::jsonb);
  return to_jsonb('ok'::text);
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

-- Every clusters and cluster_cards row and every event, as text: a refused
-- call must leave this byte-identical.
create function ak_test.state()
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

-- One cluster row and its cluster_cards rows, as text.
create function ak_test.cluster_row(p_cluster uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select to_jsonb(cl)::text from public.clusters cl where cl.id = p_cluster), '')
    || '#'
    || coalesce((select string_agg(to_jsonb(cc)::text, '|' order by cc.card_id) from public.cluster_cards cc where cc.cluster_id = p_cluster), '');
$$;

-- P1's clusters by sort_order: id, name, source, sort_order, and card ids by
-- their order in the cluster.
create function ak_test.shape()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', cl.id,
      'name', cl.name,
      'source', cl.source,
      'sort_order', cl.sort_order,
      'cards', (select coalesce(pg_catalog.jsonb_agg(cc.card_id order by cc.sort_order, cc.card_id), '[]'::jsonb)
                  from public.cluster_cards cc where cc.cluster_id = cl.id)
    ) order by cl.sort_order, cl.id), '[]'::jsonb)
  from public.clusters cl
  where cl.cycle_id = '3d000000-0000-4000-8000-000000000001';
$$;

create function ak_test.mark()
returns void
language sql
security definer
set search_path = ''
as $$
  insert into ak_test.seen (id)
  select e.id from public.cycle_events e
  on conflict do nothing;
$$;

-- The unseen events, without id, cycle_id, and created_at.
create function ak_test.new_events()
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
  where not exists (select 1 from ak_test.seen s where s.id = e.id);
$$;

create function ak_test.snap(p_label text, p_body jsonb)
returns void
language sql
as $$
  insert into ak_test.snaps (label, body) values (p_label, p_body)
  on conflict (label) do update set body = excluded.body;
$$;

create function ak_test.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.body from ak_test.snaps s where s.label = p_label;
$$;

-- The ids of P1's clusters with the given source, read as postgres.
create function ak_test.ids_of(p_source text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(cl.id order by cl.sort_order), '{}')
    from public.clusters cl
   where cl.cycle_id = '3d000000-0000-4000-8000-000000000001'
     and cl.source = p_source;
$$;

grant usage on schema ak_test to authenticated, service_role;
grant select, insert, update on all tables in schema ak_test to authenticated, service_role;
grant execute on all functions in schema ak_test to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures. The token columns are empty strings, as the Auth server writes
-- them.
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', '1d000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ak-a@example.com', '{"display_name":"Alice"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '1d000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'ak-b@example.com', '{"display_name":"Bob"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '1d000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'ak-c@example.com', '{"display_name":"Cara"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '1d000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'ak-d@example.com', '{"display_name":"Dan"}', '', '', '', '');

insert into public.projects (id, name, owner_id)
values
  ('2d000000-0000-4000-8000-000000000001', 'Project P', '1d000000-0000-4000-8000-000000000001'),
  ('2d000000-0000-4000-8000-000000000002', 'Project Q', '1d000000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('2d000000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-000000000002', 'member'),
  ('2d000000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-000000000004', 'member');

-- Q1: C's cycle in cluster with an AI cluster (as postgres), so P's members
-- can be given an existing id of another project.
insert into public.feedback_cycles (id, project_id, title, week_start, status, revealed_at)
values ('3d000000-0000-4000-8000-000000000011', '2d000000-0000-4000-8000-000000000002', 'Q one', '2026-10-26', 'cluster', now());
insert into public.clusters (id, cycle_id, name, source, sort_order)
values ('4d000000-0000-4000-8000-000000000011', '3d000000-0000-4000-8000-000000000011', 'Q AI', 'ai', 1);

insert into public.feedback_cycles (id, project_id, title, week_start)
values ('3d000000-0000-4000-8000-000000000001', '2d000000-0000-4000-8000-000000000001', 'P main', '2026-10-26');

set local role authenticated;
select ak_test.add_card('A', 'start', 's1', false);
select ak_test.add_card('B', 'start', 's2', true);
select ak_test.add_card('D', 'stop', 't1', false);
select ak_test.add_card('A', 'stop', 't2', true);
select ak_test.add_card('B', 'continue', 'k1', false);
select ak_test.add_card('D', 'continue', 'k2', true);
select ak_test.add_card('A', 'start', 'm1', true);
reset role;

-- ---------------------------------------------------------------------------
-- Hardening.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'accept_ai_clusters'),
  1,
  'accept_ai_clusters has exactly one overload'
);
select is(
  pg_get_function_identity_arguments('public.accept_ai_clusters(uuid)'::regprocedure) || ' -> ' || pg_get_function_result('public.accept_ai_clusters(uuid)'::regprocedure),
  'p_cycle_id uuid -> integer',
  'accept_ai_clusters(p_cycle_id uuid) returns integer'
);
select is(
  (select p.prosecdef and p.provolatile = 'v' and p.proconfig = array['search_path=""']::text[] from pg_proc p where p.oid = 'public.accept_ai_clusters(uuid)'::regprocedure),
  true,
  'accept_ai_clusters is security definer, volatile, and fixes search_path to empty'
);
select is(
  array[
    has_function_privilege('authenticated', 'public.accept_ai_clusters(uuid)', 'EXECUTE'),
    has_function_privilege('anon', 'public.accept_ai_clusters(uuid)', 'EXECUTE'),
    (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.accept_ai_clusters(uuid)'::regprocedure)
  ],
  array[true, false, false],
  'accept_ai_clusters is executable by authenticated, not by PUBLIC or anon'
);
select is(
  (select
     strpos(p.prosrc, 'private.is_project_member') > 0
     and strpos(p.prosrc, 'private.is_project_member') < strpos(p.prosrc, 'from public.projects p where p.id = cycle_project for share')
     and strpos(p.prosrc, 'from public.projects p where p.id = cycle_project for share') < strpos(p.prosrc, 'private.is_project_facilitator')
     and strpos(p.prosrc, 'private.is_project_facilitator') < strpos(p.prosrc, 'for update')
     and strpos(substr(p.prosrc, strpos(p.prosrc, 'private.is_project_facilitator')), 'public.feedback_cycles') > 0
     and strpos(substr(p.prosrc, strpos(p.prosrc, 'private.is_project_facilitator')), 'public.feedback_cycles')
         < strpos(substr(p.prosrc, strpos(p.prosrc, 'private.is_project_facilitator')), 'for update')
   from pg_proc p where p.oid = 'public.accept_ai_clusters(uuid)'::regprocedure),
  true,
  'the membership check, then projects FOR SHARE, then the facilitator check, then the cycle row FOR UPDATE'
);
select is(
  (select array_agg(w order by w) from unnest(array['owner_id', 'card_authors', 'profiles', 'cycle_events', 'execute', 'raise notice']) w
     where strpos(lower((select p.prosrc from pg_proc p where p.oid = 'public.accept_ai_clusters(uuid)'::regprocedure)), w) > 0),
  null,
  'the source mentions none of owner_id, card_authors, profiles, cycle_events, execute, or raise notice'
);
select is(
  (select array_agg(m[1] order by m[1]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise\s+exception\s+using\s+errcode\s*=\s*''(\w+)'',\s*message\s*=\s*''(\w+)'';', 'g') m
     where p.oid = 'public.accept_ai_clusters(uuid)'::regprocedure),
  array['42501', '42501', '42501', 'P0001'],
  'every raise uses errcode and message only'
);
select is(
  (select count(*)::int from pg_proc p cross join lateral regexp_matches(p.prosrc, '\mraise\M', 'gi') m where p.oid = 'public.accept_ai_clusters(uuid)'::regprocedure),
  4,
  'there is no other raise'
);
select is(
  (select strpos(lower(p.prosrc), 'detail') + strpos(lower(p.prosrc), 'hint') from pg_proc p where p.oid = 'public.accept_ai_clusters(uuid)'::regprocedure),
  0,
  'no raise carries a detail or a hint'
);

-- ---------------------------------------------------------------------------
-- Collecting and reveal: cycle_not_clustering.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(ak_test.accept('A'), ak_test.e('cycle_not_clustering'), 'collecting: the facilitator gets cycle_not_clustering');
select ak_test.start('A');
select is(ak_test.accept('A'), ak_test.e('cycle_not_clustering'), 'reveal: the facilitator gets cycle_not_clustering');
select ak_test.advance('A', 'reveal');
-- The manual cluster "Process" holds m1 and k2.
select ak_test.mk('A', 'Process');
select ak_test.move('A', 'm1', 'Process');
select ak_test.move('A', 'k2', 'Process');
reset role;

-- Two AI clusters from a run, as the Edge Function writes them.
set local role service_role;
select ak_test.begin_run('R1');
select is(
  ak_test.replace('R1', jsonb_build_array(ak_test.cl('Starts', 'start', array['s1', 's2']), ak_test.cl('Stops', 'stop', array['t1', 't2']))),
  to_jsonb('ok'::text),
  'the AI run writes two AI clusters'
);
reset role;
select is(array_length(ak_test.ids_of('ai'), 1), 2, 'P1 has two AI clusters');
select is(array_length(ak_test.ids_of('manual'), 1), 1, 'and one manual cluster');

-- ---------------------------------------------------------------------------
-- Refusals change nothing.
-- ---------------------------------------------------------------------------
select ak_test.snap('state', to_jsonb(ak_test.state()));
set local role authenticated;
select is(ak_test.accept('D'), ak_test.e('not_project_facilitator'), 'member D gets not_project_facilitator');
reset role;
select is(to_jsonb(ak_test.state()), ak_test.snapped('state'), 'D''s refusal leaves clusters, cluster_cards, and cycle_events byte-identical');

set local role authenticated;
select ak_test.transfer('A', 'B');
reset role;
select ak_test.snap('state', to_jsonb(ak_test.state()));
set local role authenticated;
select is(ak_test.accept('A'), ak_test.e('not_project_facilitator'), 'the owner A, no longer facilitator, gets not_project_facilitator');
reset role;
select is(to_jsonb(ak_test.state()), ak_test.snapped('state'), 'the owner''s refusal leaves everything byte-identical');

set local role authenticated;
select ak_test.transfer('A', 'D');
reset role;
select ak_test.snap('state', to_jsonb(ak_test.state()));
set local role authenticated;
select is(ak_test.accept('B'), ak_test.e('not_project_facilitator'), 'the former facilitator B gets not_project_facilitator');
reset role;
select is(to_jsonb(ak_test.state()), ak_test.snapped('state'), 'B''s refusal leaves everything byte-identical');

set local role authenticated;
select ak_test.transfer('A', 'A');
reset role;
select ak_test.snap('state', to_jsonb(ak_test.state()));
set local role authenticated;
select is(ak_test.accept('C'), ak_test.e('not_project_member'), 'non-member C gets not_project_member');
select is(ak_test.accept(null), ak_test.e('not_project_member'), 'a null user gets not_project_member');
select is(ak_test.accept_raw('A', gen_random_uuid()), ak_test.e('not_project_member'), 'a random cycle id gets not_project_member');
select is(ak_test.accept_raw('A', null), ak_test.e('not_project_member'), 'a null cycle id gets not_project_member');
select is(ak_test.accept('A', 'Q1'), ak_test.e('not_project_member'), 'A gets not_project_member on a cycle of project Q');
select is(ak_test.accept('C'), ak_test.accept_raw('C', gen_random_uuid()), 'C gets the identical error for an existing and a random cycle');
reset role;
select is(to_jsonb(ak_test.state()), ak_test.snapped('state'), 'no non-member refusal changed anything');
select is(
  (select source from public.clusters where id = '4d000000-0000-4000-8000-000000000011'),
  'ai',
  'Q1''s AI cluster is still an AI cluster'
);

-- ---------------------------------------------------------------------------
-- The facilitator keeps the suggestions.
-- ---------------------------------------------------------------------------
select ak_test.snap('ai ids', to_jsonb(ak_test.ids_of('ai')));
select ak_test.snap('manual row', to_jsonb(ak_test.cluster_row((ak_test.ids_of('manual'))[1])));
select ak_test.snap('shape', ak_test.shape());
select ak_test.mark();
set local role authenticated;
select is(ak_test.accept('A'), to_jsonb(2), 'the facilitator keeps two suggestions: it returns 2');
reset role;
select is(array_length(ak_test.ids_of('ai'), 1), null, 'no AI cluster is left');
select is(
  ak_test.shape(),
  (select jsonb_agg(case when ak_test.snapped('ai ids') ? (c ->> 'id') then jsonb_set(c, '{source}', '"manual"') else c end order by o)
     from jsonb_array_elements(ak_test.snapped('shape')) with ordinality x(c, o)),
  'both AI clusters are manual with the same id, name, sort_order, and cards'
);
select is(
  to_jsonb(ak_test.cluster_row(ak_test.id('Process'))),
  ak_test.snapped('manual row'),
  'the manual cluster''s row and cluster_cards are byte-identical'
);
select is(
  ak_test.new_events(),
  jsonb_build_array(jsonb_build_object('type', 'clusters_changed', 'from_status', 'cluster', 'to_status', 'cluster', 'actor_id', null, 'payload', '{}'::jsonb)),
  'exactly one clusters_changed event with no actor and an empty payload'
);

select ak_test.snap('state', to_jsonb(ak_test.state()));
set local role authenticated;
select is(ak_test.accept('A'), to_jsonb(0), 'a second call returns 0');
reset role;
select is(to_jsonb(ak_test.state()), ak_test.snapped('state'), 'and changes no row and adds no event');

select is(
  (select jsonb_agg(c ->> 'source' order by o) from jsonb_array_elements(ak_test.board('B') -> 'clusters') with ordinality x(c, o)),
  '["manual", "manual", "manual"]'::jsonb,
  'get_cycle_board shows every kept cluster as manual'
);

-- ---------------------------------------------------------------------------
-- Stale check: a keep during an AI run makes the run's write fail.
-- ---------------------------------------------------------------------------
set local role service_role;
select ak_test.begin_run('R2');
select is(ak_test.replace('R2', jsonb_build_array(ak_test.cl('Continues', 'continue', array['k1']))), to_jsonb('ok'::text), 'a second run writes one AI cluster');
select ak_test.begin_run('R3');
reset role;
set local role authenticated;
select is(ak_test.accept('A'), to_jsonb(1), 'the facilitator keeps it while a third run is in flight');
reset role;
select ak_test.snap('state', to_jsonb(ak_test.state()));
set local role service_role;
select is(
  ak_test.replace('R3', jsonb_build_array(ak_test.cl('Again', 'continue', array['k1']))),
  ak_test.e('clusters_changed_during_run'),
  'the run in flight fails with clusters_changed_during_run'
);
reset role;
select is(to_jsonb(ak_test.state()), ak_test.snapped('state'), 'and writes nothing');

-- ---------------------------------------------------------------------------
-- Vote, discuss, and closed: cycle_not_clustering.
-- ---------------------------------------------------------------------------
set local role authenticated;
select ak_test.advance('A', 'cluster');
select is(ak_test.accept('A'), ak_test.e('cycle_not_clustering'), 'vote: the facilitator gets cycle_not_clustering');
reset role;
update public.feedback_cycles set status = 'discuss' where id = ak_test.id('P1');
set local role authenticated;
select is(ak_test.accept('A'), ak_test.e('cycle_not_clustering'), 'discuss: the facilitator gets cycle_not_clustering');
select ak_test.close('A');
select is(ak_test.accept('A'), ak_test.e('cycle_not_clustering'), 'closed: the facilitator gets cycle_not_clustering');
reset role;

-- ---------------------------------------------------------------------------
-- Nothing else changes.
-- ---------------------------------------------------------------------------
select is((select md5(prosrc) from pg_proc where oid = 'public.get_cycle_board(uuid)'::regprocedure), '63317c82ae89c6b9c7851c07bafefbc7', 'get_cycle_board is unchanged');
select is(
  (select string_agg(table_name, ',' order by table_name) from information_schema.tables where table_schema = 'public'),
  'ai_runs,card_authors,cards,cluster_cards,clusters,cycle_events,feedback_cycles,profiles,project_invites,project_members,projects',
  'no table is added to public'
);
select is(
  (select md5(string_agg(table_name || '.' || column_name || ':' || data_type, ',' order by table_name, ordinal_position)) from information_schema.columns where table_schema = 'public'),
  'f727772622900c188bd798812baf45d5',
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

select * from finish();

rollback;
