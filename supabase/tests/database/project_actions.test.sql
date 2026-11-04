-- pgTAP tests for #27: get_project_actions, the project-wide action list.
--
-- Everything runs in one transaction and is rolled back at the end. The seed
-- user is never used as a fixture. now() is the transaction time, so actions
-- created here share created_at; the ordering fixtures move it as postgres.
--
-- Fixtures: owner and facilitator A, members B, D, N (whose profile row is
-- removed: 'Member') and G (whose auth user is deleted: owner_name null),
-- non-member C. Projects P (A's), Q (C's), E (A's, no cycles), F (A's, one
-- collecting cycle with no actions) and R (A's, bulk rows for the limits).
--   P1  P's first cycle: clusters X and Y, to discuss through the RPCs
--       (close_voting included), actions through create_action, closed
--   P2  P's second cycle: cluster Z, to discuss the same way, actions
--   Q1  C's cycle in discuss with cluster QX and C's action QA
--   R1  R's cycle in discuss with 201 open and 25 done actions inserted as
--       postgres

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(79);

-- ---------------------------------------------------------------------------
-- Test-only helpers.
-- ---------------------------------------------------------------------------
create schema pa;

create table pa.ids (label text primary key, id uuid not null);
create table pa.snaps (label text primary key, body jsonb);

insert into pa.ids (label, id)
values
  ('A', 'a7000000-0000-4000-8000-000000000001'),
  ('B', 'a7000000-0000-4000-8000-000000000002'),
  ('C', 'a7000000-0000-4000-8000-000000000003'),
  ('D', 'a7000000-0000-4000-8000-000000000004'),
  ('N', 'a7000000-0000-4000-8000-000000000005'),
  ('G', 'a7000000-0000-4000-8000-000000000006'),
  ('P', 'a8000000-0000-4000-8000-000000000001'),
  ('Q', 'a8000000-0000-4000-8000-000000000002'),
  ('E', 'a8000000-0000-4000-8000-000000000003'),
  ('F', 'a8000000-0000-4000-8000-000000000004'),
  ('R', 'a8000000-0000-4000-8000-000000000005'),
  ('random', 'a9000000-0000-4000-8000-000000000099');

create function pa.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from pa.ids i where i.label = p_label;
$$;

create function pa.label(p_id uuid)
returns text
language sql
stable
as $$
  select coalesce((select i.label from pa.ids i where i.id = p_id order by i.label limit 1), 'unlabelled');
$$;

create function pa.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', pa.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

create function pa.e(p_message text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'code', case when p_message in ('not_project_member', 'not_action_owner') then '42501' else 'P0001' end,
    'message', p_message
  );
$$;

-- get_project_actions as the user: the response, or {code, message}.
create function pa.get(p_user text, p_project uuid, p_status text, p_mine boolean)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
  v_state text;
  v_message text;
begin
  perform pa.become(p_user);
  result := public.get_project_actions(p_project, p_status, p_mine);
  return result;
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
    return jsonb_build_object('code', v_state, 'message', v_message);
end;
$$;

create function pa.g(p_user text, p_project text, p_status text, p_mine boolean default false)
returns jsonb
language sql
as $$
  select pa.get(p_user, pa.id(p_project), p_status, p_mine);
$$;

-- The labels of a list, in response order.
create function pa.labels(p_body jsonb, p_list text)
returns text[]
language sql
stable
as $$
  select coalesce(array_agg(pa.label((x ->> 'action_id')::uuid) order by o), '{}')
    from jsonb_array_elements(p_body -> p_list) with ordinality e(x, o);
$$;

-- The ids of a list, in response order.
create function pa.ids_of(p_body jsonb, p_list text)
returns uuid[]
language sql
immutable
as $$
  select coalesce(array_agg((x ->> 'action_id')::uuid order by o), '{}')
    from jsonb_array_elements(p_body -> p_list) with ordinality e(x, o);
$$;

create function pa.item(p_body jsonb, p_action text)
returns jsonb
language sql
stable
as $$
  select x
    from jsonb_array_elements(coalesce(p_body -> 'open', '[]') || coalesce(p_body -> 'done', '[]')) x
   where (x ->> 'action_id')::uuid = pa.id(p_action);
$$;

-- A response without the two per-viewer flags.
create function pa.without_flags(p_body jsonb)
returns jsonb
language sql
immutable
as $$
  select p_body
    || jsonb_build_object(
         'open', coalesce((select jsonb_agg(x - 'owner_is_me' - 'created_by_me' order by o) from jsonb_array_elements(p_body -> 'open') with ordinality e(x, o)), '[]'::jsonb),
         'done', coalesce((select jsonb_agg(x - 'owner_is_me' - 'created_by_me' order by o) from jsonb_array_elements(p_body -> 'done') with ordinality e(x, o)), '[]'::jsonb)
       );
$$;

-- Read-backs, security definer so they see every row.
create function pa.project_action_ids(p_project text, p_status text, p_owner text default null)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(a.id order by a.id), '{}')
    from public.actions a
    join public.feedback_cycles fc on fc.id = a.cycle_id
   where fc.project_id = pa.id(p_project)
     and (p_status is null or a.status = p_status)
     and (p_owner is null or a.owner_id = pa.id(p_owner));
$$;

create function pa.first_open(p_project text, p_limit integer)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(s.id order by s.n), '{}')
    from (
      select a.id, row_number() over (order by a.due_date asc nulls last, a.created_at, a.id) as n
        from public.actions a
        join public.feedback_cycles fc on fc.id = a.cycle_id
       where fc.project_id = pa.id(p_project) and a.status = 'open'
    ) s
   where s.n <= p_limit;
$$;

create function pa.newest_done(p_project text, p_limit integer)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(s.id order by s.n), '{}')
    from (
      select a.id, row_number() over (order by a.completed_at desc, a.id) as n
        from public.actions a
        join public.feedback_cycles fc on fc.id = a.cycle_id
       where fc.project_id = pa.id(p_project) and a.status = 'done'
    ) s
   where s.n <= p_limit;
$$;

create function pa.sorted(p_ids uuid[])
returns uuid[]
language sql
immutable
as $$
  select coalesce(array_agg(i order by i), '{}') from unnest(p_ids) i;
$$;

-- Every row of the tables a read must not touch, and the event count.
create function pa.state()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(
    coalesce((select string_agg(pg_catalog.to_jsonb(a)::text, '|' order by a.id) from public.actions a), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(fc)::text, '|' order by fc.id) from public.feedback_cycles fc), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(e)::text, '|' order by e.id) from public.cycle_events e), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(pm)::text, '|' order by pm.project_id, pm.user_id) from public.project_members pm), '')
  );
$$;

create function pa.nevents()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.cycle_events;
$$;

-- A new collecting cycle of a project, written as the table owner (as in
-- #26's tests: create_cycle only accepts a week near today).
create function pa.new_cycle(p_label text, p_project text, p_week date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid := gen_random_uuid();
begin
  insert into public.feedback_cycles (id, project_id, title, week_start)
  values (new_id, pa.id(p_project), p_label, p_week);
  insert into pa.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

-- A new cycle labelled p_cycle, taken to discuss by p_user through the RPCs,
-- with one cluster per name (labelled p_cycle || '.' || name).
create function pa.discuss(p_user text, p_project text, p_cycle text, p_week date, p_clusters text[])
returns void
language plpgsql
as $$
declare
  new_id uuid;
  cluster_name text;
  cluster_id uuid;
begin
  new_id := pa.new_cycle(p_cycle, p_project, p_week);
  perform pa.become(p_user);
  perform 1 from public.start_retrospective(new_id);
  perform 1 from public.advance_stage(new_id, 'reveal');
  foreach cluster_name in array p_clusters loop
    select r.cluster_id into strict cluster_id from public.create_cluster(new_id, cluster_name) r;
    insert into pa.ids (label, id) values (p_cycle || '.' || cluster_name, cluster_id);
  end loop;
  perform 1 from public.advance_stage(new_id, 'cluster');
  perform 1 from public.close_voting(new_id);
end;
$$;

-- create_action through #26's RPC; the new action is labelled p_label.
create function pa.create(p_user text, p_cycle text, p_label text, p_owner text, p_due date, p_cluster text)
returns void
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform pa.become(p_user);
  select r.action_id into strict new_id
    from public.create_action(pa.id(p_cycle), 'Action ' || p_label, pa.id(p_owner), p_due, pa.id(p_cluster)) r;
  insert into pa.ids (label, id) values (p_label, new_id);
end;
$$;

-- set_action_status through #26's RPC: the returned status, or the error.
create function pa.st(p_user text, p_action text, p_status text)
returns jsonb
language plpgsql
as $$
declare
  result text;
  v_state text;
  v_message text;
begin
  perform pa.become(p_user);
  select r.status into strict result from public.set_action_status(pa.id(p_action), p_status) r;
  return to_jsonb(result);
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
    return jsonb_build_object('code', v_state, 'message', v_message);
end;
$$;

create function pa.close_cycle(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform pa.become(p_user);
  perform 1 from public.close_cycle(pa.id(p_cycle));
end;
$$;

create function pa.join(p_project text, p_owner text, p_user text)
returns void
language plpgsql
as $$
declare
  invite text;
begin
  perform pa.become(p_owner);
  invite := (select i.token from public.create_project_invite(pa.id(p_project)) i);
  perform pa.become(p_user);
  perform 1 from public.join_project(invite);
end;
$$;

create function pa.snap(p_label text, p_body jsonb)
returns void
language sql
as $$
  insert into pa.snaps (label, body) values (p_label, p_body)
  on conflict (label) do update set body = excluded.body;
$$;

create function pa.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.body from pa.snaps s where s.label = p_label;
$$;

grant usage on schema pa to authenticated, service_role;
grant select, insert, update, delete on all tables in schema pa to authenticated, service_role;
grant execute on all functions in schema pa to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Users and projects.
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', 'a7000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pa-a@example.com', '{"display_name":"Alice"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a7000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pa-b@example.com', '{"display_name":"Bob"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a7000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pa-c@example.com', '{"display_name":"Cara"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a7000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'pa-d@example.com', '{"display_name":"Dan"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a7000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'pa-n@example.com', '{"display_name":"Nia"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a7000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'pa-g@example.com', '{"display_name":"Gus"}', '', '', '', '');

insert into public.projects (id, name, owner_id)
values
  ('a8000000-0000-4000-8000-000000000001', 'Project P', 'a7000000-0000-4000-8000-000000000001'),
  ('a8000000-0000-4000-8000-000000000002', 'Project Q', 'a7000000-0000-4000-8000-000000000003'),
  ('a8000000-0000-4000-8000-000000000003', 'Project E', 'a7000000-0000-4000-8000-000000000001'),
  ('a8000000-0000-4000-8000-000000000004', 'Project F', 'a7000000-0000-4000-8000-000000000001'),
  ('a8000000-0000-4000-8000-000000000005', 'Project R', 'a7000000-0000-4000-8000-000000000001');

set local role authenticated;
select pa.join('P', 'A', 'B');
select pa.join('P', 'A', 'D');
select pa.join('P', 'A', 'N');
select pa.join('P', 'A', 'G');
reset role;

-- ---------------------------------------------------------------------------
-- Migration hardening.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_project_actions'), 1, 'get_project_actions has exactly one overload');
select is(
  (select pg_get_function_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid) from pg_proc p where p.oid = 'public.get_project_actions(uuid, text, boolean)'::regprocedure),
  'p_project_id uuid, p_status text, p_mine_only boolean -> jsonb',
  'get_project_actions takes (p_project_id, p_status, p_mine_only) and returns jsonb'
);
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']::text[] from pg_proc p where p.oid = 'public.get_project_actions(uuid, text, boolean)'::regprocedure),
  true,
  'get_project_actions is security definer, stable, and fixes search_path to empty'
);
select is(
  array[
    has_function_privilege('authenticated', 'public.get_project_actions(uuid, text, boolean)', 'EXECUTE'),
    has_function_privilege('anon', 'public.get_project_actions(uuid, text, boolean)', 'EXECUTE'),
    has_function_privilege('service_role', 'public.get_project_actions(uuid, text, boolean)', 'EXECUTE'),
    (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.get_project_actions(uuid, text, boolean)'::regprocedure)
  ],
  array[true, false, false, false],
  'EXECUTE for authenticated only (not anon, service_role, or PUBLIC)'
);
select is(
  (select (select count(*) from regexp_matches(p.prosrc, '\mraise\M', 'gi'))
        = (select count(*) from regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''[a-z_]+'';', 'g'))
     from pg_proc p where p.oid = 'public.get_project_actions(uuid, text, boolean)'::regprocedure),
  true,
  'every raise is raise exception using errcode = 42501|P0001, message = <code>'
);
select is(
  (select array_agg(distinct m[1] order by m[1]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'message = ''([a-z_]+)''', 'g') m where p.oid = 'public.get_project_actions(uuid, text, boolean)'::regprocedure),
  array['invalid_action_filter', 'not_project_member'],
  'get_project_actions raises exactly not_project_member and invalid_action_filter'
);
select is(
  (select p.prosrc ~* '(votes|cards|card_authors|notes|cycle_events|public\.projects|execute|raise\s+notice|for\s+update|for\s+share)' from pg_proc p where p.oid = 'public.get_project_actions(uuid, text, boolean)'::regprocedure),
  false,
  'get_project_actions mentions no votes, cards, card_authors, notes, cycle_events, public.projects, execute, raise notice, for update, or for share'
);
select is(
  (select p.prosrc ~ 'private\.is_project_member\(p_project_id\)' and p.prosrc ~ 'fc\.project_id = p_project_id' from pg_proc p where p.oid = 'public.get_project_actions(uuid, text, boolean)'::regprocedure),
  true,
  'membership comes from private.is_project_member and cycles are matched on feedback_cycles.project_id'
);
select is(
  (select p.prosrc ~* 'created_by[^_]' and not p.prosrc ~* '''created_by''' from pg_proc p where p.oid = 'public.get_project_actions(uuid, text, boolean)'::regprocedure),
  true,
  'get_project_actions returns no created_by key (it compares created_by only)'
);
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc ~ 'public\.actions'),
  array['create_action', 'delete_action', 'get_cycle_actions', 'get_project_actions', 'set_action_status', 'update_action'],
  'get_project_actions is the only new function that reads public.actions'
);
select is(
  (select array_agg(pg_get_indexdef(i.indexrelid) order by pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid = 'public.actions'::regclass and not i.indisprimary),
  array[
    'CREATE INDEX actions_cluster_id_idx ON public.actions USING btree (cluster_id)',
    'CREATE INDEX actions_cycle_id_created_at_idx ON public.actions USING btree (cycle_id, created_at)',
    'CREATE INDEX actions_owner_id_idx ON public.actions USING btree (owner_id)'
  ],
  'no index was added to actions'
);
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'actions'), 0, 'actions still has no policy');
select is(
  (select array_agg(r || ':' || p order by r, p) from unnest(array['anon', 'authenticated', 'service_role']) r cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege(r, 'public.actions', p)),
  array['service_role:DELETE', 'service_role:INSERT', 'service_role:SELECT', 'service_role:UPDATE'],
  'no table privilege on actions was added'
);
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'actions'), 0, 'actions is still not in supabase_realtime');

-- ---------------------------------------------------------------------------
-- Q1: C's cycle in discuss with C's action QA.
-- ---------------------------------------------------------------------------
set local role authenticated;
select pa.discuss('C', 'Q', 'Q1', '2026-09-07', array['QX']);
select pa.create('C', 'Q1', 'QA', 'C', '2026-11-01', 'Q1.QX');

-- F: a project with a cycle but no actions.
select pa.new_cycle('F1', 'F', '2026-09-07');

-- ---------------------------------------------------------------------------
-- P1: to discuss through the RPCs, actions, then closed.
-- ---------------------------------------------------------------------------
select pa.discuss('A', 'P', 'P1', '2026-09-14', array['X', 'Y']);
select pa.create('B', 'P1', 'a1', 'D', '2026-11-12', 'P1.X');
select pa.create('A', 'P1', 'a2', 'B', '2026-11-01', 'P1.Y');
select pa.create('D', 'P1', 'a3', 'D', null, null);
select pa.create('A', 'P1', 'a4', 'N', null, 'P1.X');
select pa.create('A', 'P1', 'a5', 'G', '2026-12-01', null);
select pa.create('B', 'P1', 'a6', 'B', null, null);
select is(pa.st('D', 'a3', 'done'), '"done"'::jsonb, 'D marks a3 done in discuss');
select pa.close_cycle('A', 'P1');

-- ---------------------------------------------------------------------------
-- P2: the current cycle, in discuss.
-- ---------------------------------------------------------------------------
select pa.discuss('A', 'P', 'P2', '2026-09-21', array['Z']);
select pa.create('B', 'P2', 'b1', 'B', '2026-11-12', 'P2.Z');
select pa.create('A', 'P2', 'b2', 'A', '2026-11-30', null);
select pa.create('B', 'P2', 'b3', 'A', null, 'P2.Z');
select is(pa.st('A', 'b3', 'done'), '"done"'::jsonb, 'A marks b3 done in discuss');
reset role;

select is(
  (select array_agg(fc.title || ':' || fc.status order by fc.title) from public.feedback_cycles fc where fc.project_id = pa.id('P')),
  array['P1:closed', 'P2:discuss'],
  'P has a closed cycle and a cycle in discuss'
);

-- Ordering fixtures, as postgres: a1 and b1 share a due date; the one with
-- the greater id gets the earlier created_at, so created_at decides before
-- id. b3 is completed earlier than a3. The guard forbids created_at changes,
-- so it is switched off for these updates only.
alter table public.actions disable trigger actions_guard_update;
update public.actions a
   set created_at = a.created_at - interval '2 hours'
 where a.id = greatest(pa.id('a1'), pa.id('b1'));
update public.actions a
   set created_at = a.created_at - interval '1 hour'
 where a.id = least(pa.id('a1'), pa.id('b1'));
update public.actions a
   set completed_at = a.completed_at - interval '1 day'
 where a.id = pa.id('b3');
alter table public.actions enable trigger actions_guard_update;

insert into pa.ids (label, id)
values
  ('first12', greatest(pa.id('a1'), pa.id('b1'))),
  ('second12', least(pa.id('a1'), pa.id('b1'))),
  ('nodate1', least(pa.id('a4'), pa.id('a6'))),
  ('nodate2', greatest(pa.id('a4'), pa.id('a6')));

-- N's profile is gone ('Member'); G's account is deleted (owner_name null).
delete from public.profiles where id = pa.id('N');
delete from auth.users where id = pa.id('G');

-- ---------------------------------------------------------------------------
-- Access.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(pa.g('C', 'P', 'all'), pa.e('not_project_member'), 'non-member C gets not_project_member');
select is(pa.g(null, 'P', 'all'), pa.e('not_project_member'), 'a null user gets not_project_member');
select is(pa.get('B', null, 'all', false), pa.e('not_project_member'), 'a null project id gets not_project_member');
select is(pa.g('B', 'random', 'all'), pa.e('not_project_member'), 'a random project id gets not_project_member');
select is(pa.g('B', 'Q', 'all'), pa.e('not_project_member'), 'a member of P calling with Q''s id gets not_project_member');
select is(pa.g('C', 'P', null), pa.e('not_project_member'), 'membership is checked before the filters');
select is(pa.g('B', 'P', null), pa.e('invalid_action_filter'), 'p_status null gets invalid_action_filter');
select is(pa.g('B', 'P', ''), pa.e('invalid_action_filter'), 'p_status '''' gets invalid_action_filter');
select is(pa.g('B', 'P', 'Open'), pa.e('invalid_action_filter'), 'p_status ''Open'' gets invalid_action_filter');
select is(pa.g('B', 'P', 'closed'), pa.e('invalid_action_filter'), 'p_status ''closed'' gets invalid_action_filter');
select is(pa.get('B', pa.id('P'), 'open', null), pa.e('invalid_action_filter'), 'p_mine_only null gets invalid_action_filter');

-- ---------------------------------------------------------------------------
-- Shape.
-- ---------------------------------------------------------------------------
select pa.snap('B all', pa.g('B', 'P', 'all'));
select pa.snap('B open', pa.g('B', 'P', 'open'));
select pa.snap('B done', pa.g('B', 'P', 'done'));
reset role;

select is(
  (select array_agg(k order by k) from jsonb_object_keys(pa.snapped('B all')) k),
  array['done', 'done_count', 'mine_only', 'open', 'open_count', 'project_id', 'status'],
  'the response has exactly the seven keys'
);
select is(
  pa.snapped('B all') - 'open' - 'done',
  jsonb_build_object('project_id', pa.id('P'), 'status', 'all', 'mine_only', false, 'open_count', 7, 'done_count', 2),
  'project_id, status and mine_only echo the request; the counts are P''s totals'
);
select is(
  (select bool_and((select array_agg(k order by k) from jsonb_object_keys(x) k) = array['action_id', 'cluster_id', 'cluster_name', 'completed_at', 'created_at', 'created_by_me', 'cycle_id', 'cycle_status', 'cycle_title', 'description', 'due_date', 'owner_id', 'owner_is_me', 'owner_name', 'source', 'status', 'updated_at'])
     from jsonb_array_elements((pa.snapped('B all') -> 'open') || (pa.snapped('B all') -> 'done')) x),
  true,
  'every element has exactly the 17 keys (no created_by id)'
);
select is(
  pa.item(pa.snapped('B all'), 'a1') - 'created_at' - 'updated_at',
  jsonb_build_object(
    'action_id', pa.id('a1'), 'cluster_id', pa.id('P1.X'), 'description', 'Action a1',
    'owner_id', pa.id('D'), 'owner_name', 'Dan', 'owner_is_me', false, 'created_by_me', true,
    'due_date', '2026-11-12', 'status', 'open', 'completed_at', null, 'source', 'manual',
    'cycle_id', pa.id('P1'), 'cycle_title', 'P1', 'cycle_status', 'closed', 'cluster_name', 'X'
  ),
  'a1: every value, with the closed cycle''s title and status and cluster X''s name'
);
select is(
  jsonb_build_array(pa.item(pa.snapped('B all'), 'b1') -> 'cycle_title', pa.item(pa.snapped('B all'), 'b1') -> 'cycle_status', pa.item(pa.snapped('B all'), 'b1') -> 'cluster_name'),
  '["P2", "discuss", "Z"]'::jsonb,
  'b1 carries the discuss cycle''s title and status and cluster Z''s name'
);
select is(
  (select array_agg(pa.label((x ->> 'action_id')::uuid) order by x ->> 'action_id') from jsonb_array_elements((pa.snapped('B all') -> 'open') || (pa.snapped('B all') -> 'done')) x where x -> 'cluster_id' = 'null'::jsonb and x -> 'cluster_name' = 'null'::jsonb)
    = (select array_agg(pa.label((x ->> 'action_id')::uuid) order by x ->> 'action_id') from jsonb_array_elements((pa.snapped('B all') -> 'open') || (pa.snapped('B all') -> 'done')) x where x -> 'cluster_id' = 'null'::jsonb or x -> 'cluster_name' = 'null'::jsonb),
  true,
  'cluster_name is null exactly when cluster_id is null'
);
select is(pa.item(pa.snapped('B all'), 'a3') -> 'cluster_name', 'null'::jsonb, 'a3 has no topic and cluster_name null');
select is(pa.item(pa.snapped('B all'), 'a4') ->> 'owner_name', 'Member', 'an owner with no profile name is ''Member''');
select is(
  jsonb_build_array(pa.item(pa.snapped('B all'), 'a5') -> 'owner_id', pa.item(pa.snapped('B all'), 'a5') -> 'owner_name', pa.item(pa.snapped('B all'), 'a5') -> 'owner_is_me'),
  '[null, null, false]'::jsonb,
  'after the owner''s auth user is deleted, owner_id and owner_name are null'
);
select is(pa.item(pa.snapped('B all'), 'a2') ->> 'owner_name', 'Bob', 'owner_name is the current display name');
select is(pa.item(pa.snapped('B all'), 'a2') -> 'owner_is_me', 'true'::jsonb, 'owner_is_me is true on B''s own action');
select is(pa.item(pa.snapped('B all'), 'a3') ->> 'completed_at' is not null, true, 'a done action carries completed_at');
select is(
  (select count(*)::int from jsonb_array_elements((pa.snapped('B all') -> 'open') || (pa.snapped('B all') -> 'done')) x where (x ->> 'action_id')::uuid = pa.id('QA') or (x ->> 'cycle_id')::uuid = pa.id('Q1')),
  0,
  'no action of Q appears in P''s response'
);

-- ---------------------------------------------------------------------------
-- Status filter.
-- ---------------------------------------------------------------------------
select is(pa.snapped('B open') -> 'done', '[]'::jsonb, 'open: done is []');
select is(
  (select bool_and(x ->> 'status' = 'open') from jsonb_array_elements(pa.snapped('B open') -> 'open') x),
  true,
  'open: only open actions'
);
select is(pa.sorted(pa.ids_of(pa.snapped('B open'), 'open')), pa.project_action_ids('P', 'open'), 'open: every open action of P');
select is(pa.snapped('B done') -> 'open', '[]'::jsonb, 'done: open is []');
select is(
  (select bool_and(x ->> 'status' = 'done') from jsonb_array_elements(pa.snapped('B done') -> 'done') x),
  true,
  'done: only done actions'
);
select is(pa.sorted(pa.ids_of(pa.snapped('B done'), 'done')), pa.project_action_ids('P', 'done'), 'done: every done action of P');
select is(
  jsonb_build_array(pa.snapped('B all') -> 'open', pa.snapped('B all') -> 'done'),
  jsonb_build_array(pa.snapped('B open') -> 'open', pa.snapped('B done') -> 'done'),
  'all: both lists, equal to the open and done responses'
);
select is(
  jsonb_build_array(
    jsonb_build_array(pa.snapped('B open') -> 'open_count', pa.snapped('B open') -> 'done_count'),
    jsonb_build_array(pa.snapped('B done') -> 'open_count', pa.snapped('B done') -> 'done_count')
  ),
  jsonb_build_array(
    jsonb_build_array(pa.snapped('B all') -> 'open_count', pa.snapped('B all') -> 'done_count'),
    jsonb_build_array(pa.snapped('B all') -> 'open_count', pa.snapped('B all') -> 'done_count')
  ),
  'open_count and done_count are the same for all three filters'
);

-- ---------------------------------------------------------------------------
-- Assigned to me.
-- ---------------------------------------------------------------------------
set local role authenticated;
select pa.snap('B mine', pa.g('B', 'P', 'all', true));
select pa.snap('A mine', pa.g('A', 'P', 'all', true));
select pa.snap('D mine done', pa.g('D', 'P', 'done', true));
select pa.snap('N mine', pa.g('N', 'P', 'all', true));
reset role;

select is(pa.snapped('B mine') -> 'mine_only', 'true'::jsonb, 'mine_only echoes true');
select is(pa.sorted(pa.ids_of(pa.snapped('B mine'), 'open')), pa.project_action_ids('P', 'open', 'B'), 'B mine: open lists exactly B''s open actions');
select is(pa.sorted(pa.ids_of(pa.snapped('B mine'), 'done')), pa.project_action_ids('P', 'done', 'B'), 'B mine: done lists exactly B''s done actions');
select is(
  jsonb_build_array(pa.snapped('B mine') -> 'open_count', pa.snapped('B mine') -> 'done_count'),
  jsonb_build_array(cardinality(pa.project_action_ids('P', 'open', 'B')), cardinality(pa.project_action_ids('P', 'done', 'B'))),
  'B mine: the counts are B''s counts'
);
select is(
  pa.sorted(pa.ids_of(pa.snapped('B all'), 'open') || pa.ids_of(pa.snapped('B all'), 'done')),
  pa.project_action_ids('P', null),
  'without mine_only, B gets every action of P'
);
select is(
  jsonb_build_array(pa.labels(pa.snapped('A mine'), 'open'), pa.labels(pa.snapped('A mine'), 'done')),
  jsonb_build_array(array['b2'], array['b3']),
  'the facilitator with mine_only gets only their own actions'
);
select is(
  pa.snapped('D mine done') - 'project_id',
  jsonb_build_object('status', 'done', 'mine_only', true, 'open_count', 1, 'done_count', 1, 'open', '[]'::jsonb, 'done', jsonb_build_array(pa.item(pa.snapped('D mine done'), 'a3'))),
  'D mine done: only a3, with D''s counts'
);
select is(
  jsonb_build_array(pa.labels(pa.snapped('N mine'), 'open'), pa.snapped('N mine') -> 'open_count', pa.snapped('N mine') -> 'done_count'),
  jsonb_build_array(array['a4'], 1, 0),
  'N (no profile) still gets their own action'
);

-- ---------------------------------------------------------------------------
-- Open and done order.
-- ---------------------------------------------------------------------------
select is(
  pa.ids_of(pa.snapped('B open'), 'open'),
  array[pa.id('a2'), pa.id('first12'), pa.id('second12'), pa.id('b2'), pa.id('a5'), pa.id('nodate1'), pa.id('nodate2')],
  'open: 2026-11-01, the two 2026-11-12 by created_at, 2026-11-30, 2026-12-01, then no date by id, across both cycles'
);
select is(
  pa.labels(pa.snapped('B done'), 'done'),
  array['a3', 'b3'],
  'done: by completed_at descending'
);

-- ---------------------------------------------------------------------------
-- Sameness.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(
  jsonb_build_array(pa.without_flags(pa.g('A', 'P', 'all')), pa.without_flags(pa.g('D', 'P', 'all'))),
  jsonb_build_array(pa.without_flags(pa.snapped('B all')), pa.without_flags(pa.snapped('B all'))),
  'all: A''s, B''s and D''s responses differ only in owner_is_me and created_by_me'
);
select is(
  jsonb_build_array(pa.without_flags(pa.g('A', 'P', 'open')), pa.without_flags(pa.g('D', 'P', 'open'))),
  jsonb_build_array(pa.without_flags(pa.snapped('B open')), pa.without_flags(pa.snapped('B open'))),
  'open: A''s, B''s and D''s responses differ only in the two flags'
);
select is(
  jsonb_build_array(pa.without_flags(pa.g('A', 'P', 'done')), pa.without_flags(pa.g('D', 'P', 'done'))),
  jsonb_build_array(pa.without_flags(pa.snapped('B done')), pa.without_flags(pa.snapped('B done'))),
  'done: A''s, B''s and D''s responses differ only in the two flags'
);
select isnt(pa.g('A', 'P', 'all'), pa.snapped('B all'), 'the flags do differ between A and B');

-- ---------------------------------------------------------------------------
-- Reads in every stage, and empty projects.
-- ---------------------------------------------------------------------------
reset role;
select is(
  (select array_agg(distinct x ->> 'cycle_status' order by x ->> 'cycle_status') from jsonb_array_elements(pa.snapped('B all') -> 'open') x),
  array['closed', 'discuss'],
  'actions of the closed and the discuss cycle are both listed'
);
set local role authenticated;
select is(
  pa.g('A', 'E', 'all') - 'project_id',
  '{"status": "all", "mine_only": false, "open_count": 0, "done_count": 0, "open": [], "done": []}'::jsonb,
  'a project with no cycles: both lists [] and both counts 0'
);
select is(
  pa.g('A', 'F', 'all') - 'project_id',
  '{"status": "all", "mine_only": false, "open_count": 0, "done_count": 0, "open": [], "done": []}'::jsonb,
  'a project with a cycle but no actions: both lists [] and both counts 0'
);

-- ---------------------------------------------------------------------------
-- No side effect.
-- ---------------------------------------------------------------------------
select pa.snap('state', to_jsonb(pa.state()));
select pa.snap('events', to_jsonb(pa.nevents()));
select pa.g('A', 'P', 'all');
select pa.g('B', 'P', 'open', true);
select pa.g('D', 'P', 'done');
select pa.g('C', 'P', 'all');
select pa.g('B', 'P', 'bad');
select is(to_jsonb(pa.state()), pa.snapped('state'), 'actions, feedback_cycles, cycle_events and project_members are byte-identical around the reads');
select is(to_jsonb(pa.nevents()), pa.snapped('events'), 'the cycle_events count is unchanged');

-- ---------------------------------------------------------------------------
-- #26's set_action_status from a closed cycle, reflected in the listing.
-- ---------------------------------------------------------------------------
select is(pa.st('B', 'a1', 'done'), pa.e('not_action_owner'), 'B cannot change D''s action in the closed cycle');
select is(pa.st('D', 'a1', 'done'), '"done"'::jsonb, 'D, the owner, marks a1 (closed cycle) done');
select pa.snap('after done', pa.g('B', 'P', 'all'));
select is(
  jsonb_build_array(pa.snapped('after done') -> 'open_count', pa.snapped('after done') -> 'done_count'),
  '[6, 3]'::jsonb,
  'after D marks a1 done: one fewer open, one more done'
);
select is(
  jsonb_build_array(
    pa.item(pa.snapped('after done'), 'a1') ->> 'status',
    pa.item(pa.snapped('after done'), 'a1') ->> 'completed_at' is not null,
    pa.id('a1') = any (pa.ids_of(pa.snapped('after done'), 'done')),
    pa.id('a1') = any (pa.ids_of(pa.snapped('after done'), 'open'))
  ),
  '["done", true, true, false]'::jsonb,
  'a1 is in done with completed_at set, and not in open'
);
select is(pa.st('A', 'a1', 'open'), '"open"'::jsonb, 'A, the facilitator, reopens a1 (closed cycle)');
select pa.snap('after reopen', pa.g('B', 'P', 'all'));
select is(
  jsonb_build_array(
    pa.snapped('after reopen') -> 'open_count',
    pa.snapped('after reopen') -> 'done_count',
    pa.item(pa.snapped('after reopen'), 'a1') -> 'status',
    pa.item(pa.snapped('after reopen'), 'a1') -> 'completed_at',
    pa.id('a1') = any (pa.ids_of(pa.snapped('after reopen'), 'open'))
  ),
  '[7, 2, "open", null, true]'::jsonb,
  'after A reopens a1: back in open with completed_at null, and the counts follow'
);
reset role;

-- ---------------------------------------------------------------------------
-- Limits: R1 with 201 open and 25 done actions, inserted as postgres.
-- ---------------------------------------------------------------------------
set local role authenticated;
select pa.discuss('A', 'R', 'R1', '2026-09-14', array['RX']);
reset role;

insert into public.actions (cycle_id, description, owner_id, due_date, status, source, created_by, created_at)
select pa.id('R1'), 'Open ' || g, pa.id('A'),
       case when g % 7 = 0 then null else date '2026-11-01' + (g % 13) end,
       'open', 'manual', pa.id('A'), now() - (g % 3) * interval '1 minute'
  from generate_series(1, 201) g;

insert into public.actions (cycle_id, description, owner_id, status, completed_at, source, created_by)
select pa.id('R1'), 'Done ' || g, pa.id('A'), 'done',
       -- Two equal completed_at values (g = 24 and g = 25) among the newest.
       timestamptz '2026-11-01 12:00:00+00' + least(g, 24) * interval '1 hour',
       'manual', pa.id('A')
  from generate_series(1, 25) g;

set local role authenticated;
select pa.snap('R all', pa.g('A', 'R', 'all'));
reset role;

select is(
  jsonb_build_array(pa.snapped('R all') -> 'open_count', jsonb_array_length(pa.snapped('R all') -> 'open')),
  '[201, 200]'::jsonb,
  'open: 200 elements and open_count 201'
);
select is(pa.ids_of(pa.snapped('R all'), 'open'), pa.first_open('R', 200), 'open: the 200 first by due_date (no date last), created_at, id');
select is(
  jsonb_build_array(pa.snapped('R all') -> 'done_count', jsonb_array_length(pa.snapped('R all') -> 'done')),
  '[25, 20]'::jsonb,
  'done: 20 elements and done_count 25'
);
select is(pa.ids_of(pa.snapped('R all'), 'done'), pa.newest_done('R', 20), 'done: the 20 newest by completed_at descending, then id');
select is(
  jsonb_build_array(
    pa.snapped('R all') -> 'done' -> 0 -> 'completed_at' = pa.snapped('R all') -> 'done' -> 1 -> 'completed_at',
    (pa.snapped('R all') -> 'done' -> 0 ->> 'action_id')::uuid < (pa.snapped('R all') -> 'done' -> 1 ->> 'action_id')::uuid
  ),
  '[true, true]'::jsonb,
  'done: the two equal completed_at values come first, by action_id'
);

select * from finish();

rollback;
