-- pgTAP tests for #26: the actions table and its guard, actions_changed
-- events, and the five action RPCs (create_action, update_action,
-- set_action_status, delete_action, get_cycle_actions).
--
-- Everything runs in one transaction and is rolled back at the end. The seed
-- user is never used as a fixture. now() is the transaction time, so actions
-- added here share created_at and are ordered by id; to see updated_at and
-- completed_at move, a test first moves them into the past as postgres. The
-- RLS suite checks real transactions.
--
-- Fixtures: owner and facilitator A, members B and D, non-member C (owner of
-- Q), E (joins P during discuss). P is A's with B and D joined. P's cycles
-- run one after another, each closed before the next is created:
--   P0  a closed cycle with cluster Old (a cluster of another cycle in P)
--   P1  the main cycle: clusters X, Y (cards), Empty (no cards), and AI
--       (source ai), taken to discuss through vote, votes and close_voting;
--       closed from discuss with actions at the end
--   P2  writes in collecting, reveal, cluster, vote, and closed from vote
-- Q1 is C's cycle in discuss with cluster QX and C's action QA.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(349);

-- ---------------------------------------------------------------------------
-- Test-only helpers.
-- ---------------------------------------------------------------------------
create schema ac;

create table ac.ids (label text primary key, id uuid not null);
create table ac.snaps (label text primary key, body jsonb);
create table ac.seen (id uuid primary key);

insert into ac.ids (label, id)
values
  ('A', 'ad000000-0000-4000-8000-000000000001'),
  ('B', 'ad000000-0000-4000-8000-000000000002'),
  ('C', 'ad000000-0000-4000-8000-000000000003'),
  ('D', 'ad000000-0000-4000-8000-000000000004'),
  ('E', 'ad000000-0000-4000-8000-000000000005'),
  ('P', 'ae000000-0000-4000-8000-000000000001'),
  ('Q', 'ae000000-0000-4000-8000-000000000002'),
  ('random', 'af000000-0000-4000-8000-000000000099');

create function ac.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from ac.ids i where i.label = p_label;
$$;

create function ac.label(p_id uuid)
returns text
language sql
stable
as $$
  select coalesce((select i.label from ac.ids i where i.id = p_id order by i.label limit 1), 'null');
$$;

create function ac.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', ac.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- The error a refused call gets, with empty detail and hint.
create function ac.e(p_message text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'code', case when p_message in ('not_project_member', 'not_action_editor', 'not_action_owner') then '42501' else 'P0001' end,
    'message', p_message,
    'detail', '',
    'hint', ''
  );
$$;

-- Runs a query as the user: its rows as a jsonb array, or the error.
create function ac.run(p_user text, p_sql text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform ac.become(p_user);
  execute 'select coalesce(jsonb_agg(to_jsonb(r)), ''[]''::jsonb) from (' || p_sql || ') r' into result;
  return result;
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

-- Read-back helpers, security definer so they see every row.
create function ac.action_exists(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.actions a where a.id = p_id);
$$;

create function ac.action(p_action text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.to_jsonb(a) from public.actions a where a.id = ac.id(p_action);
$$;

create function ac.action_md5(p_action text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(pg_catalog.to_jsonb(a)::text) from public.actions a where a.id = ac.id(p_action);
$$;

create function ac.nactions(p_cycle text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.actions a where a.cycle_id = ac.id(p_cycle);
$$;

create function ac.action_order(p_cycle text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(a.id) order by a.created_at, a.id), '[]'::jsonb) from public.actions a where a.cycle_id = ac.id(p_cycle);
$$;

create function ac.ids_where(p_cycle text, p_column text, p_user text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(a.id) order by a.id), '[]'::jsonb)
    from public.actions a
   where a.cycle_id = ac.id(p_cycle)
     and (case when p_column = 'owner' then a.owner_id else a.created_by end) = ac.id(p_user);
$$;

-- create_action: ["ok"] when the returned id names a new row, or the error.
-- The new action is labelled p_label.
create function ac.create(p_user text, p_cycle text, p_description text, p_owner text, p_due text, p_cluster text, p_label text default null)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := ac.run(p_user, format(
    'select * from public.create_action(%L::uuid, %L, %L::uuid, %L::date, %L::uuid)',
    ac.id(p_cycle), p_description, ac.id(p_owner), p_due, ac.id(p_cluster)));
  new_id uuid;
begin
  if jsonb_typeof(result) = 'array' and jsonb_array_length(result) = 1 then
    new_id := (result -> 0 ->> 'action_id')::uuid;
    if p_label is not null then
      insert into ac.ids (label, id) values (p_label, new_id);
    end if;
    return jsonb_build_array(case when ac.action_exists(new_id) then 'ok' else 'missing' end);
  end if;
  return result;
end;
$$;

-- create_action with a raw due-date literal, for a malformed string.
create function ac.create_raw_due(p_user text, p_cycle text, p_due_literal text)
returns jsonb
language plpgsql
as $$
begin
  return ac.run(p_user, format(
    'select * from public.create_action(%L::uuid, %L, %L::uuid, %L::date, null)',
    ac.id(p_cycle), 'x', ac.id(p_user), p_due_literal));
end;
$$;

-- update_action / delete_action: [action label], or the error.
create function ac.upd(p_user text, p_action text, p_description text, p_owner text, p_due text, p_cluster text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := ac.run(p_user, format(
    'select * from public.update_action(%L::uuid, %L, %L::uuid, %L::date, %L::uuid)',
    ac.id(p_action), p_description, ac.id(p_owner), p_due, ac.id(p_cluster)));
begin
  if jsonb_typeof(result) = 'array' and jsonb_array_length(result) = 1 then
    return jsonb_build_array(ac.label((result -> 0 ->> 'action_id')::uuid));
  end if;
  return result;
end;
$$;

create function ac.del(p_user text, p_action text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := ac.run(p_user, format('select * from public.delete_action(%L::uuid)', ac.id(p_action)));
begin
  if jsonb_typeof(result) = 'array' and jsonb_array_length(result) = 1 then
    return jsonb_build_array(ac.label((result -> 0 ->> 'action_id')::uuid));
  end if;
  return result;
end;
$$;

-- set_action_status: [action label, status], or the error.
create function ac.st(p_user text, p_action text, p_status text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := ac.run(p_user, format('select * from public.set_action_status(%L::uuid, %L)', ac.id(p_action), p_status));
begin
  if jsonb_typeof(result) = 'array' and jsonb_array_length(result) = 1 then
    return jsonb_build_array(ac.label((result -> 0 ->> 'action_id')::uuid), result -> 0 ->> 'status');
  end if;
  return result;
end;
$$;

-- get_cycle_actions as the user, or the error.
create function ac.get(p_user text, p_cycle text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := ac.run(p_user, format('select public.get_cycle_actions(%L::uuid) as d', ac.id(p_cycle)));
begin
  if jsonb_typeof(result) = 'array' then
    return result -> 0 -> 'd';
  end if;
  return result;
end;
$$;

create function ac.item(p_body jsonb, p_action text)
returns jsonb
language sql
stable
as $$
  select x from jsonb_array_elements(p_body -> 'actions') x where (x ->> 'action_id')::uuid = ac.id(p_action);
$$;

-- A response without the two per-viewer flags.
create function ac.without_flags(p_body jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'cycle_id', p_body -> 'cycle_id',
    'actions', coalesce((select jsonb_agg(x - 'owner_is_me' - 'created_by_me' order by o) from jsonb_array_elements(p_body -> 'actions') with ordinality e(x, o)), '[]'::jsonb)
  );
$$;

create function ac.flag_ids(p_body jsonb, p_flag text)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(x -> 'action_id' order by x ->> 'action_id'), '[]'::jsonb)
    from jsonb_array_elements(p_body -> 'actions') x
   where (x ->> p_flag)::boolean;
$$;

-- A new collecting cycle of a project, written as the table owner.
create function ac.new_cycle(p_label text, p_project text, p_week date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid := gen_random_uuid();
begin
  insert into public.feedback_cycles (id, project_id, title, week_start)
  values (new_id, ac.id(p_project), p_label, p_week);
  insert into ac.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

create function ac.start(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform ac.become(p_user);
  perform 1 from public.start_retrospective(ac.id(p_cycle));
end;
$$;

create function ac.advance(p_user text, p_cycle text, p_from text)
returns void
language plpgsql
as $$
begin
  perform ac.become(p_user);
  perform 1 from public.advance_stage(ac.id(p_cycle), p_from);
end;
$$;

create function ac.close_voting(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform ac.become(p_user);
  perform 1 from public.close_voting(ac.id(p_cycle));
end;
$$;

create function ac.close_cycle(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform ac.become(p_user);
  perform 1 from public.close_cycle(ac.id(p_cycle));
end;
$$;

create function ac.cast(p_user text, p_cycle text, p_cluster text)
returns void
language plpgsql
as $$
begin
  perform ac.become(p_user);
  perform 1 from public.cast_vote(ac.id(p_cycle), ac.id(p_cluster));
end;
$$;

-- A cluster made through #17's create_cluster, labelled p_cycle || '.' || name.
create function ac.mk(p_user text, p_cycle text, p_name text)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform ac.become(p_user);
  select r.cluster_id into strict new_id from public.create_cluster(ac.id(p_cycle), p_name) r;
  insert into ac.ids (label, id) values (p_cycle || '.' || p_name, new_id);
  return new_id;
end;
$$;

create function ac.transfer(p_to text)
returns void
language plpgsql
as $$
begin
  perform ac.become('A');
  perform public.transfer_facilitator(ac.id('P'), ac.id(p_to));
end;
$$;

create function ac.join(p_user text)
returns void
language plpgsql
as $$
declare
  invite text;
begin
  perform ac.become('A');
  invite := (select i.token from public.create_project_invite(ac.id('P')) i);
  perform ac.become(p_user);
  perform 1 from public.join_project(invite);
end;
$$;

create function ac.snap(p_label text, p_body jsonb)
returns void
language sql
as $$
  insert into ac.snaps (label, body) values (p_label, p_body)
  on conflict (label) do update set body = excluded.body;
$$;

create function ac.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.body from ac.snaps s where s.label = p_label;
$$;

-- The events of the cycle not returned by an earlier call, as their agreed
-- shape; marks them seen.
create function ac.fresh(p_cycle text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('type', e.type, 'from_status', e.from_status, 'to_status', e.to_status, 'actor_id', e.actor_id, 'payload', e.payload) order by e.type), '[]'::jsonb)
    into result
    from public.cycle_events e
   where e.cycle_id = ac.id(p_cycle)
     and e.id not in (select s.id from ac.seen s);
  insert into ac.seen (id)
  select e.id from public.cycle_events e where e.cycle_id = ac.id(p_cycle)
  on conflict do nothing;
  return result;
end;
$$;

create function ac.ev(p_status text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_array(jsonb_build_object('type', 'actions_changed', 'from_status', p_status, 'to_status', p_status, 'actor_id', null, 'payload', '{}'::jsonb));
$$;

-- Every row of the tables an action write must not touch.
create function ac.others_md5()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(
    coalesce((select string_agg(pg_catalog.to_jsonb(fc)::text, '|' order by fc.id) from public.feedback_cycles fc), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(pm)::text, '|' order by pm.project_id, pm.user_id) from public.project_members pm), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(cl)::text, '|' order by cl.id) from public.clusters cl), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(cc)::text, '|' order by cc.card_id) from public.cluster_cards cc), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(v)::text, '|' order by v.id) from public.votes v), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(n)::text, '|' order by n.id) from public.notes n), '')
  );
$$;

create function ac.state()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(
    ac.others_md5()
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(a)::text, '|' order by a.id) from public.actions a), '')
    || '#' || (select count(*)::text from public.cycle_events)
  );
$$;

-- Moves an action's updated_at (and completed_at, when set) a day back, so a
-- later write in this transaction shows as a change. The event this update
-- records is marked seen.
create function ac.age(p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.actions a
     set updated_at = a.updated_at - interval '1 day',
         completed_at = a.completed_at - interval '1 day'
   where a.id = ac.id(p_action);
  perform ac.fresh(ac.label((select a.cycle_id from public.actions a where a.id = ac.id(p_action))));
end;
$$;

grant usage on schema ac to authenticated, service_role;
grant select, insert, update, delete on all tables in schema ac to authenticated, service_role;
grant execute on all functions in schema ac to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures.
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', 'ad000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ac-a@example.com', '{"display_name":"Alice"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'ad000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'ac-b@example.com', '{"display_name":"Bob"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'ad000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'ac-c@example.com', '{"display_name":"Cara"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'ad000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'ac-d@example.com', '{"display_name":"Dan"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'ad000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'ac-e@example.com', '{"display_name":"Eve"}', '', '', '', '');

insert into public.projects (id, name, owner_id)
values
  ('ae000000-0000-4000-8000-000000000001', 'Project P', 'ad000000-0000-4000-8000-000000000001'),
  ('ae000000-0000-4000-8000-000000000002', 'Project Q', 'ad000000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('ae000000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000002', 'member'),
  ('ae000000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000004', 'member');

-- ---------------------------------------------------------------------------
-- Migration hardening.
-- ---------------------------------------------------------------------------
select columns_are('public', 'actions', array['id', 'cycle_id', 'cluster_id', 'description', 'owner_id', 'due_date', 'status', 'completed_at', 'source', 'created_by', 'created_at', 'updated_at'], 'actions has exactly the twelve columns');
select is(
  (select array_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable || ':' || coalesce(c.column_default, '') order by c.ordinal_position) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'actions'),
  array[
    'id:uuid:NO:gen_random_uuid()',
    'cycle_id:uuid:NO:',
    'cluster_id:uuid:YES:',
    'description:text:NO:',
    'owner_id:uuid:YES:',
    'due_date:date:YES:',
    'status:text:NO:''open''::text',
    'completed_at:timestamp with time zone:YES:',
    'source:text:NO:''manual''::text',
    'created_by:uuid:YES:',
    'created_at:timestamp with time zone:NO:now()',
    'updated_at:timestamp with time zone:NO:now()'
  ],
  'actions column types, defaults, and not-null rules'
);
select col_is_pk('public', 'actions', 'id', 'actions.id is the primary key');
select is(
  (select array_agg(c.conname || ' ' || pg_get_constraintdef(c.oid) order by c.conname) from pg_constraint c where c.conrelid = 'public.actions'::regclass and c.contype = 'f'),
  array[
    'actions_cluster_fkey FOREIGN KEY (cluster_id, cycle_id) REFERENCES clusters(id, cycle_id) ON DELETE SET NULL (cluster_id)',
    'actions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL',
    'actions_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES feedback_cycles(id) ON DELETE CASCADE',
    'actions_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL'
  ],
  'actions has exactly its four foreign keys'
);
select is(
  (select array_agg(c.conname::text order by c.conname) from pg_constraint c where c.conrelid = 'public.actions'::regclass and c.contype = 'c'),
  array['actions_completed_at_check', 'actions_description_check', 'actions_due_date_check', 'actions_source_check', 'actions_status_check'],
  'actions has exactly its five CHECKs'
);
select is(
  (select array_agg(pg_get_indexdef(i.indexrelid) order by pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid = 'public.actions'::regclass and not i.indisprimary),
  array[
    'CREATE INDEX actions_cluster_id_idx ON public.actions USING btree (cluster_id)',
    'CREATE INDEX actions_cycle_id_created_at_idx ON public.actions USING btree (cycle_id, created_at)',
    'CREATE INDEX actions_owner_id_idx ON public.actions USING btree (owner_id)'
  ],
  'actions has indexes on (cycle_id, created_at), owner_id, and cluster_id'
);
select trigger_is('public', 'actions', 'actions_guard_update', 'private', 'guard_action_update', 'the actions guard trigger exists');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.actions'::regclass and tgname = 'actions_guard_update'), 19, 'the guard is BEFORE UPDATE FOR EACH ROW');
select is((select relrowsecurity from pg_class where oid = 'public.actions'::regclass), true, 'RLS is enabled on actions');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'actions'), 0, 'actions has no policy');
select is(
  (select array_agg(r || ':' || p order by r, p) from unnest(array['anon', 'authenticated', 'service_role']) r cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege(r, 'public.actions', p)),
  array['service_role:DELETE', 'service_role:INSERT', 'service_role:SELECT', 'service_role:UPDATE'],
  'anon and authenticated have no privilege on actions; service_role has exactly SELECT, INSERT, UPDATE, DELETE'
);
select is((select count(*)::int from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name = 'actions' and g.grantee = 'PUBLIC'), 0, 'PUBLIC has no privilege on actions');
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'actions'), 0, 'actions is not in supabase_realtime');
select is((select count(*)::int from pg_depend d join pg_rewrite rw on rw.oid = d.objid where d.refobjid = 'public.actions'::regclass and rw.ev_class <> 'public.actions'::regclass), 0, 'no view depends on actions');

select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.cycle_events'::regclass and c.conname = 'cycle_events_type_check'),
  'CHECK ((type = ANY (ARRAY[''stage_changed''::text, ''clusters_changed''::text, ''notes_changed''::text, ''actions_changed''::text])))',
  'cycle_events_type_check allows stage_changed, clusters_changed, notes_changed, and actions_changed'
);
select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.cycle_events'::regclass and c.conname = 'cycle_events_actions_changed_check'),
  'CHECK (((type <> ''actions_changed''::text) OR ((from_status = to_status) AND (actor_id IS NULL) AND (payload = ''{}''::jsonb))))',
  'cycle_events_actions_changed_check pins the actions_changed shape'
);
select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.cycle_events'::regclass and c.conname = 'cycle_events_notes_changed_check'),
  'CHECK (((type <> ''notes_changed''::text) OR ((from_status = to_status) AND (actor_id IS NULL) AND (payload = ''{}''::jsonb))))',
  'cycle_events_notes_changed_check is unchanged'
);
select is(
  (select array_agg(t.tgname::text || ':' || t.tgtype order by t.tgname) from pg_trigger t where t.tgrelid = 'public.actions'::regclass and not t.tgisinternal and t.tgname like 'actions_record_%'),
  array['actions_record_delete:8', 'actions_record_insert:4', 'actions_record_update:16'],
  'actions has AFTER INSERT, UPDATE, and DELETE statement triggers'
);
select is(
  (select bool_and(p.proname = 'record_actions_change') from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'public.actions'::regclass and t.tgname like 'actions_record_%'),
  true,
  'the three triggers call private.record_actions_change'
);

-- The five RPCs.
create table ac.rpcs (name text primary key, fn regprocedure, sig text, vol "char");
insert into ac.rpcs (name, fn, sig, vol)
values
  ('create_action', 'public.create_action(uuid, text, uuid, date, uuid)', 'p_cycle_id uuid, p_description text, p_owner_id uuid, p_due_date date, p_cluster_id uuid -> TABLE(action_id uuid)', 'v'),
  ('update_action', 'public.update_action(uuid, text, uuid, date, uuid)', 'p_action_id uuid, p_description text, p_owner_id uuid, p_due_date date, p_cluster_id uuid -> TABLE(action_id uuid)', 'v'),
  ('set_action_status', 'public.set_action_status(uuid, text)', 'p_action_id uuid, p_status text -> TABLE(action_id uuid, status text)', 'v'),
  ('delete_action', 'public.delete_action(uuid)', 'p_action_id uuid -> TABLE(action_id uuid)', 'v'),
  ('get_cycle_actions', 'public.get_cycle_actions(uuid)', 'p_cycle_id uuid -> jsonb', 's');

select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = r.name), 1, r.name || ' has exactly one overload') from ac.rpcs r order by r.name;
select is(pg_get_function_identity_arguments(r.fn) || ' -> ' || pg_get_function_result(r.fn), r.sig, r.name || ' has the agreed signature') from ac.rpcs r order by r.name;
select is((select p.prosecdef and p.proconfig = array['search_path=""']::text[] and p.provolatile = r.vol from pg_proc p where p.oid = r.fn), true, r.name || ' is security definer with search_path fixed to empty and the agreed volatility') from ac.rpcs r order by r.name;
select is(
  array[
    has_function_privilege('authenticated', r.fn, 'EXECUTE'),
    has_function_privilege('anon', r.fn, 'EXECUTE'),
    has_function_privilege('service_role', r.fn, 'EXECUTE'),
    (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = r.fn)
  ],
  array[true, false, false, false],
  r.name || ' is executable by authenticated only'
) from ac.rpcs r order by r.name;
select is(
  (select (select count(*)::int from regexp_matches(p.prosrc, '\mraise\M', 'gi'))
          = (select count(*)::int from regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''[a-z_]+'';', 'g'))
     from pg_proc p where p.oid = r.fn),
  true,
  r.name || ': every raise has errcode and message only'
) from ac.rpcs r order by r.name;
select is((select p.prosrc ~* '(detail|hint)' from pg_proc p where p.oid = r.fn), false, r.name || ' sets no detail or hint') from ac.rpcs r order by r.name;
-- p_owner_id is the assignee, never the caller.
select is(
  (select coalesce(bool_or(a ~* '(user|author|actor|voter|creator|created_by)'), false) from pg_proc p cross join unnest(p.proargnames) a where p.oid = r.fn and a like 'p\_%'),
  false,
  r.name || ' takes no caller id'
) from ac.rpcs r order by r.name;
select is((select p.prosrc ~* '(votes|cards|card_authors|notes|execute|raise\s+notice)' from pg_proc p where p.oid = r.fn), false, r.name || ' mentions no votes, cards, card_authors, notes, execute, or raise notice') from ac.rpcs r order by r.name;
select is((select p.prosrc ~* '(\mp\.owner_id|projects\.owner_id|select\s+[a-z_.]*owner_id\s+from\s+public\.projects)' from pg_proc p where p.oid = r.fn), false, r.name || ' never reads projects.owner_id') from ac.rpcs r order by r.name;
select is((select p.prosrc ~* 'profiles' from pg_proc p where p.oid = r.fn), r.name = 'get_cycle_actions', r.name || (case when r.name = 'get_cycle_actions' then ' reads profiles' else ' does not mention profiles' end)) from ac.rpcs r order by r.name;
select is((select p.prosrc ~* 'cycle_events' from pg_proc p where p.oid = r.fn), false, r.name || ' never mentions cycle_events') from ac.rpcs r order by r.name;

select is(
  (select array_agg(m[1] || ':' || m[2]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = 'public.create_action(uuid, text, uuid, date, uuid)'::regprocedure),
  array['42501:not_project_member', '42501:not_project_member', 'P0001:cycle_not_discussing', 'P0001:cluster_not_found', 'P0001:invalid_action_description', 'P0001:invalid_action_owner', 'P0001:invalid_due_date', 'P0001:action_limit_reached'],
  'create_action raises its codes in the agreed order'
);
select is(
  (select array_agg(m[1] || ':' || m[2]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = 'public.update_action(uuid, text, uuid, date, uuid)'::regprocedure),
  array['42501:not_project_member', 'P0001:action_not_found', 'P0001:cycle_not_discussing', 'P0001:action_not_found', '42501:not_action_editor', 'P0001:cluster_not_found', 'P0001:invalid_action_description', 'P0001:invalid_due_date', 'P0001:invalid_action_owner'],
  'update_action raises its codes in the agreed order'
);
select is(
  (select array_agg(m[1] || ':' || m[2]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = 'public.set_action_status(uuid, text)'::regprocedure),
  array['42501:not_project_member', 'P0001:action_not_found', 'P0001:cycle_not_discussing', 'P0001:action_not_found', '42501:not_action_owner', 'P0001:invalid_action_status'],
  'set_action_status raises its codes in the agreed order'
);
select is(
  (select array_agg(m[1] || ':' || m[2]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = 'public.delete_action(uuid)'::regprocedure),
  array['42501:not_project_member', 'P0001:action_not_found', 'P0001:cycle_not_discussing', 'P0001:action_not_found', '42501:not_action_editor'],
  'delete_action raises its codes in the agreed order'
);
select is(
  (select array_agg(m[1] || ':' || m[2]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = 'public.get_cycle_actions(uuid)'::regprocedure),
  array['42501:not_project_member', '42501:not_project_member'],
  'get_cycle_actions raises only not_project_member'
);

-- Locking.
create function ac.pos(p_fn regprocedure, p_pattern text)
returns integer
language sql
stable
as $$
  select coalesce((select regexp_instr(p.prosrc, p_pattern) from pg_proc p where p.oid = p_fn), 0);
$$;

select is(
  ac.pos(r.fn, 'from public\.feedback_cycles fc\s+where fc\.id = [a-z_]+\s+for update') > 0
  and ac.pos(r.fn, 'from public\.feedback_cycles fc\s+where fc\.id = [a-z_]+\s+for update') < ac.pos(r.fn, 'cycle_not_discussing')
  and ac.pos(r.fn, 'from public\.feedback_cycles fc\s+where fc\.id = [a-z_]+\s+for update') < ac.pos(r.fn, '(insert into|update|delete from) public\.actions '),
  true,
  r.name || ' locks the cycle FOR UPDATE before the stage check and before any write'
) from ac.rpcs r where r.name <> 'get_cycle_actions' order by r.name;
select is(
  ac.pos(r.fn, 'from public\.projects p where p\.id = cycle_project for share') > 0
  and ac.pos(r.fn, 'from public\.projects p where p\.id = cycle_project for share') < ac.pos(r.fn, 'is_project_facilitator')
  and ac.pos(r.fn, 'from public\.projects p where p\.id = cycle_project for share') < ac.pos(r.fn, 'for update'),
  true,
  r.name || ' locks projects FOR SHARE before the role check and the cycle lock'
) from ac.rpcs r where r.name in ('update_action', 'set_action_status', 'delete_action') order by r.name;
select is((select p.prosrc ~ 'public\.projects' from pg_proc p where p.oid = 'public.create_action(uuid, text, uuid, date, uuid)'::regprocedure), false, 'create_action does not lock projects');
select is((select count(*)::int from pg_proc p, regexp_matches(p.prosrc, 'for (update|share)', 'gi') where p.oid = 'public.get_cycle_actions(uuid)'::regprocedure), 0, 'get_cycle_actions takes no lock');

-- Trigger functions are not client-callable.
select is(
  array[
    has_function_privilege('authenticated', f, 'EXECUTE'),
    has_function_privilege('anon', f, 'EXECUTE'),
    has_function_privilege('service_role', f, 'EXECUTE'),
    (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = f)
  ],
  array[false, false, false, false],
  f::text || ' is not executable by any client role'
) from unnest(array['private.guard_action_update()'::regprocedure, 'private.record_actions_change()'::regprocedure]) f;
select is((select proconfig from pg_proc where oid = f), array['search_path=""']::text[], f::text || ' fixes search_path to empty')
  from unnest(array['private.guard_action_update()'::regprocedure, 'private.record_actions_change()'::regprocedure]) f;
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'EXECUTE')), 4, 'authenticated can still execute exactly four private functions (#28 adds two Storage policy helpers)');

-- Earlier RPCs are untouched.
select is(
  (select array_agg(p.proname || ':' || md5(p.prosrc) order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('get_cycle_board', 'get_vote_totals', 'close_voting', 'get_cycle_discussion', 'set_discussion_status', 'add_note', 'update_note', 'delete_note')),
  array[
    'add_note:0712cc8b5fce312f9fbe16211b4c5afe',
    'close_voting:cd475fa921a9b8d0846c07c0ea79301d',
    'delete_note:74812bb1159abd3aa70e30419dec8d6a',
    'get_cycle_board:a652b8eee54255a3b19a6448c77fc9ee',
    'get_cycle_discussion:2ba7ea31e14bf4730a4e9117b6db9fe2',
    'get_vote_totals:0959ef4dcfd9cd5e6fae69f9ea7fd3fe',
    'set_discussion_status:82e2375e414b15aec9980782c382cb27',
    'update_note:5048badb685c3a2ef194f46fb60143be'
  ],
  'get_cycle_board, get_vote_totals, close_voting, get_cycle_discussion, and #25''s write RPCs are unchanged'
);
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.prosrc ~ 'public\.actions'),
  array['create_action', 'delete_action', 'get_cycle_actions', 'get_project_actions', 'set_action_status', 'update_action'],
  'only the five RPCs and #27''s get_project_actions read or write public.actions'
);

-- ---------------------------------------------------------------------------
-- P0: a closed cycle of P with cluster Old.
-- ---------------------------------------------------------------------------
set local role authenticated;
select ac.new_cycle('P0', 'P', '2026-08-31');
select ac.start('A', 'P0');
select ac.advance('A', 'P0', 'reveal');
select ac.mk('A', 'P0', 'Old');
select ac.close_cycle('A', 'P0');
reset role;

-- ---------------------------------------------------------------------------
-- Q1: C's cycle in discuss, with cluster QX and C's action QA.
-- ---------------------------------------------------------------------------
set local role authenticated;
select ac.new_cycle('Q1', 'Q', '2026-09-07');
select ac.start('C', 'Q1');
select ac.advance('C', 'Q1', 'reveal');
select ac.mk('C', 'Q1', 'QX');
select ac.advance('C', 'Q1', 'cluster');
select ac.close_voting('C', 'Q1');
select is(ac.create('C', 'Q1', 'Q action', 'C', null, 'Q1.QX', 'QA'), '["ok"]'::jsonb, 'C adds an action in Q1');
reset role;

-- ---------------------------------------------------------------------------
-- P1: to discuss through vote and close_voting.
-- ---------------------------------------------------------------------------
select ac.new_cycle('P1', 'P', '2026-09-14');
insert into ac.ids (label, id) values ('P1.s1', gen_random_uuid()), ('P1.s2', gen_random_uuid()), ('P1.t1', gen_random_uuid()), ('P1.k1', gen_random_uuid());
insert into public.cards (id, cycle_id, category, text, is_anonymous)
values
  (ac.id('P1.s1'), ac.id('P1'), 'start', 'Pair more', false),
  (ac.id('P1.s2'), ac.id('P1'), 'start', 'Demo weekly', true),
  (ac.id('P1.t1'), ac.id('P1'), 'stop', 'Late merges', false),
  (ac.id('P1.k1'), ac.id('P1'), 'continue', 'Retro notes', false);
insert into public.card_authors (card_id, author_id)
values (ac.id('P1.s1'), ac.id('A')), (ac.id('P1.s2'), ac.id('B')), (ac.id('P1.t1'), ac.id('D')), (ac.id('P1.k1'), ac.id('B'));

set local role authenticated;
select ac.start('A', 'P1');
select ac.advance('A', 'P1', 'reveal');
select ac.mk('A', 'P1', 'X');
select ac.mk('A', 'P1', 'Y');
select ac.mk('A', 'P1', 'Empty');
select ac.become('A');
select public.move_card(ac.id('P1.s1'), ac.id('P1.X'), null);
select public.move_card(ac.id('P1.s2'), ac.id('P1.X'), null);
select public.move_card(ac.id('P1.t1'), ac.id('P1.Y'), null);
reset role;

set local role service_role;
do $$
declare
  run uuid;
begin
  run := (public.begin_ai_clustering(ac.id('P1'), ac.id('A'), 'claude-opus-5-5', 'cluster-feedback/v1') ->> 'run_id')::uuid;
  perform public.replace_ai_clusters(
    run, ac.id('A'),
    jsonb_build_array(jsonb_build_object('name', 'AI', 'category', 'continue', 'card_ids', jsonb_build_array(ac.id('P1.k1')))),
    '{}'::jsonb
  );
end;
$$;
reset role;
insert into ac.ids (label, id) select 'P1.AI', cl.id from public.clusters cl where cl.cycle_id = ac.id('P1') and cl.source = 'ai';
select is(
  (select array_agg(ac.label(cl.id) || ':' || cl.source || ':' || (select count(*) from public.cluster_cards cc where cc.cluster_id = cl.id) order by cl.sort_order) from public.clusters cl where cl.cycle_id = ac.id('P1')),
  array['P1.X:manual:2', 'P1.Y:manual:1', 'P1.Empty:manual:0', 'P1.AI:ai:1'],
  'P1 has X, Y, a zero-card cluster, and an ai cluster'
);

-- get_cycle_actions answers before discuss with no actions.
set local role authenticated;
select is(ac.get('D', 'P1'), jsonb_build_object('cycle_id', ac.id('P1'), 'actions', '[]'::jsonb), 'cluster: get_cycle_actions answers with no actions');
select ac.advance('A', 'P1', 'cluster');
select ac.cast('B', 'P1', 'P1.Y');
select ac.cast('D', 'P1', 'P1.AI');
select ac.cast('A', 'P1', 'P1.X');
select ac.close_voting('A', 'P1');
reset role;
select is((select fc.status from public.feedback_cycles fc where fc.id = ac.id('P1')), 'discuss', 'P1 is in discuss');
select ac.fresh('P1');

-- ---------------------------------------------------------------------------
-- Create.
-- ---------------------------------------------------------------------------
set local role authenticated;
select ac.snap('others', to_jsonb(ac.others_md5()));
select is(ac.create('B', 'P1', E'  Write the runbook\nfirst draft \t\r\n', 'D', '2026-11-12', 'P1.X', 'BD'), '["ok"]'::jsonb, 'B creates an action owned by D with a due date and topic X');
select is(ac.fresh('P1'), ac.ev('discuss'), 'create_action records one actions_changed row');
select is(to_jsonb(ac.others_md5()), ac.snapped('others'), 'create_action leaves feedback_cycles, project_members, clusters, cluster_cards, votes, and notes byte-identical');
select is(ac.create('B', 'P1', 'Own it', 'B', null, null, 'BB'), '["ok"]'::jsonb, 'B creates an action owned by B with no date and no topic');
select ac.fresh('P1');
reset role;
select is(
  ac.action('BD') - 'id' - 'created_at' - 'updated_at',
  jsonb_build_object(
    'cycle_id', ac.id('P1'), 'cluster_id', ac.id('P1.X'), 'description', E'Write the runbook\nfirst draft',
    'owner_id', ac.id('D'), 'due_date', '2026-11-12', 'status', 'open', 'completed_at', null,
    'source', 'manual', 'created_by', ac.id('B')
  ),
  'the stored row: trimmed description with the inner line break, open, manual, created by B'
);
select is(
  ac.action('BB') - 'id' - 'created_at' - 'updated_at',
  jsonb_build_object(
    'cycle_id', ac.id('P1'), 'cluster_id', null, 'description', 'Own it',
    'owner_id', ac.id('B'), 'due_date', null, 'status', 'open', 'completed_at', null,
    'source', 'manual', 'created_by', ac.id('B')
  ),
  'the second row has no due date and no topic'
);
set local role authenticated;
select is(ac.create('D', 'P1', repeat('a', 500), 'A', null, null, 'D500'), '["ok"]'::jsonb, 'a 500-character description is accepted');
select is(ac.create('D', 'P1', repeat('😀', 500), 'D', null, 'P1.Y', 'Demoji'), '["ok"]'::jsonb, 'a 500-multi-byte-character description is accepted');
select is(ac.create('D', 'P1', '<b>bold</b> & <script>x</script>', 'D', '2000-01-01', 'P1.Empty', 'Dhtml'), '["ok"]'::jsonb, 'HTML-like text, 2000-01-01, and a zero-card cluster are accepted');
select is(ac.create('A', 'P1', 'Facilitator action', 'B', '2099-12-31', 'P1.AI', 'AB'), '["ok"]'::jsonb, '2099-12-31 and an ai cluster are accepted; the facilitator assigns to B');
select is(ac.create('D', 'P1', 'For the facilitator', 'A', '2020-01-01', null, 'DA'), '["ok"]'::jsonb, 'a past due date is accepted and D assigns to the facilitator and project owner A');
select ac.fresh('P1');
select ac.snap('state', to_jsonb(ac.state()));
select is(ac.create('B', 'P1', '', 'D', null, null), ac.e('invalid_action_description'), 'an empty description gets invalid_action_description');
select is(ac.create('B', 'P1', E' \t\n\r ', 'D', null, null), ac.e('invalid_action_description'), 'a whitespace-only description gets invalid_action_description');
select is(ac.create('B', 'P1', null, 'D', null, null), ac.e('invalid_action_description'), 'a null description gets invalid_action_description');
select is(ac.create('B', 'P1', repeat('a', 501), 'D', null, null), ac.e('invalid_action_description'), '501 characters get invalid_action_description');
select is(ac.create('B', 'P1', repeat('😀', 501), 'D', null, null), ac.e('invalid_action_description'), '501 multi-byte characters get invalid_action_description');
select is(ac.create('B', 'P1', 'x', 'D', null, 'P0.Old'), ac.e('cluster_not_found'), 'a cluster of another cycle in P gets cluster_not_found');
select is(ac.create('B', 'P1', 'x', 'D', null, 'Q1.QX'), ac.e('cluster_not_found'), 'a cluster of Q gets cluster_not_found');
select is(ac.create('B', 'P1', 'x', 'D', null, 'random'), ac.e('cluster_not_found'), 'a random cluster id gets cluster_not_found');
select is(ac.create('B', 'P1', 'x', 'C', null, null), ac.e('invalid_action_owner'), 'an owner who is a non-member (C, a member of Q only) gets invalid_action_owner');
select is(ac.create('B', 'P1', 'x', 'random', null, null), ac.e('invalid_action_owner'), 'a random owner id gets invalid_action_owner');
select is(ac.create('B', 'P1', 'x', null, null, null), ac.e('invalid_action_owner'), 'a null owner gets invalid_action_owner');
select is(ac.create('B', 'P1', 'x', 'E', null, null), ac.e('invalid_action_owner'), 'a user who has not joined yet gets invalid_action_owner');
select is(ac.create('B', 'P1', 'x', 'D', '1999-12-31', null), ac.e('invalid_due_date'), '1999-12-31 gets invalid_due_date');
select is(ac.create('B', 'P1', 'x', 'D', '2100-01-01', null), ac.e('invalid_due_date'), '2100-01-01 gets invalid_due_date');
select is(ac.create_raw_due('B', 'P1', '2026-13-40') ->> 'code', '22008', 'a malformed date string is refused before the RPC runs');
select is(ac.create('B', 'P1', '', 'C', '1999-12-31', 'random'), ac.e('cluster_not_found'), 'the topic is checked before the description, owner, and date');
select is(ac.create('B', 'P1', '', 'C', '1999-12-31', null), ac.e('invalid_action_description'), 'the description is checked before the owner and date');
select is(ac.create('B', 'P1', 'x', 'C', '1999-12-31', null), ac.e('invalid_action_owner'), 'the owner is checked before the date');
select is(ac.create('C', 'P1', 'x', 'D', null, null), ac.e('not_project_member'), 'C gets not_project_member from create_action');
select is(ac.create(null, 'P1', 'x', 'D', null, null), ac.e('not_project_member'), 'a null user gets not_project_member from create_action');
select is(ac.create('B', null, 'x', 'D', null, null), ac.e('not_project_member'), 'a null cycle gets not_project_member from create_action');
select is(ac.create('B', 'random', 'x', 'D', null, null), ac.e('not_project_member'), 'an unknown cycle gets not_project_member from create_action');
select is(ac.create('B', 'Q1', 'x', 'B', null, null), ac.e('not_project_member'), 'a cycle of another project gets not_project_member from create_action');
select is(to_jsonb(ac.state()), ac.snapped('state'), 'the refused creates changed nothing and recorded no event');
reset role;

-- ---------------------------------------------------------------------------
-- Edit.
-- ---------------------------------------------------------------------------
select ac.age('BB');
select ac.snap('BB before', ac.action('BB'));
set local role authenticated;
select ac.snap('others', to_jsonb(ac.others_md5()));
select is(ac.upd('B', 'BB', E'  Own it, edited\nnow ', 'D', '2026-11-20', 'P1.Y'), '["BB"]'::jsonb, 'B (creator) changes the description, owner, due date, and topic');
select is(ac.fresh('P1'), ac.ev('discuss'), 'a changing update_action records one actions_changed row');
select is(to_jsonb(ac.others_md5()), ac.snapped('others'), 'update_action leaves the other tables byte-identical');
reset role;
select is(
  ac.action('BB') - 'updated_at',
  (ac.snapped('BB before') - 'updated_at') || jsonb_build_object('description', E'Own it, edited\nnow', 'owner_id', ac.id('D'), 'due_date', '2026-11-20', 'cluster_id', ac.id('P1.Y')),
  'the four fields change; created_at, status, completed_at, source, cycle_id, and created_by are kept'
);
select is((ac.action('BB') ->> 'updated_at')::timestamptz, now(), 'updated_at is set');
set local role authenticated;
select is(ac.upd('B', 'BB', 'Own it, edited', 'D', null, null), '["BB"]'::jsonb, 'clearing the due date and topic with nulls works');
reset role;
select is(array[ac.action('BB') ->> 'due_date', ac.action('BB') ->> 'cluster_id'], array[null, null]::text[], 'the due date and topic are cleared');
select ac.age('BB');
set local role authenticated;
select ac.fresh('P1');
select ac.snap('state', to_jsonb(ac.state()));
select is(ac.upd('B', 'BB', E'\n Own it, edited\t', 'D', null, null), '["BB"]'::jsonb, 'editing to the same values after trimming returns the id');
select is(to_jsonb(ac.state()), ac.snapped('state'), 'and changes nothing (updated_at included) and records no event');
select is(ac.upd('A', 'BB', 'Facilitator edit', 'D', null, null), '["BB"]'::jsonb, 'the facilitator A edits B''s action');
select ac.fresh('P1');
select ac.snap('state', to_jsonb(ac.state()));
select is(ac.upd('D', 'BB', 'Owner edit', 'D', null, null), ac.e('not_action_editor'), 'D (the owner, not the creator) gets not_action_editor');
select is(ac.upd('B', 'BB', '', 'D', null, null), ac.e('invalid_action_description'), 'an edit to empty gets invalid_action_description');
select is(ac.upd('B', 'BB', '   ', 'D', null, null), ac.e('invalid_action_description'), 'an edit to whitespace gets invalid_action_description');
select is(ac.upd('B', 'BB', null, 'D', null, null), ac.e('invalid_action_description'), 'an edit to null gets invalid_action_description');
select is(ac.upd('B', 'BB', repeat('a', 501), 'D', null, null), ac.e('invalid_action_description'), 'an edit to 501 characters gets invalid_action_description');
select is(ac.upd('B', 'BB', 'x', 'D', null, 'P0.Old'), ac.e('cluster_not_found'), 'a cluster of another cycle gets cluster_not_found');
select is(ac.upd('B', 'BB', 'x', 'D', null, 'Q1.QX'), ac.e('cluster_not_found'), 'a cluster of Q gets cluster_not_found');
select is(ac.upd('B', 'BB', 'x', 'D', null, 'random'), ac.e('cluster_not_found'), 'a random cluster gets cluster_not_found');
select is(ac.upd('B', 'BB', 'x', 'C', null, null), ac.e('invalid_action_owner'), 'a non-member owner gets invalid_action_owner');
select is(ac.upd('B', 'BB', 'x', 'random', null, null), ac.e('invalid_action_owner'), 'a random owner gets invalid_action_owner');
select is(ac.upd('B', 'BB', 'x', null, null, null), ac.e('invalid_action_owner'), 'a null owner gets invalid_action_owner');
select is(ac.upd('B', 'BB', 'x', 'D', '1999-12-31', null), ac.e('invalid_due_date'), 'an edit to 1999-12-31 gets invalid_due_date');
select is(ac.upd('B', 'BB', 'x', 'D', '2100-01-01', null), ac.e('invalid_due_date'), 'an edit to 2100-01-01 gets invalid_due_date');
select is(to_jsonb(ac.state()), ac.snapped('state'), 'the refused edits changed nothing and recorded no event');
reset role;

-- An owner who has since left project_members stays valid when unchanged.
delete from public.project_members where project_id = ac.id('P') and user_id = ac.id('D');
set local role authenticated;
select is(ac.upd('B', 'BB', 'Typo fixed', 'D', null, null), '["BB"]'::jsonb, 'an owner who has left stays valid when unchanged');
select is(ac.upd('B', 'BB', 'Typo fixed', 'B', null, null), '["BB"]'::jsonb, 'reassigning to a current member works');
select is(ac.upd('B', 'BB', 'Typo fixed', 'D', null, null), ac.e('invalid_action_owner'), 'and a member who left is refused when newly assigned');
select ac.fresh('P1');
reset role;
insert into public.project_members (project_id, user_id, role) values (ac.id('P'), ac.id('D'), 'member');
set local role authenticated;
select is(ac.upd('B', 'BB', 'Own it', 'B', null, null), '["BB"]'::jsonb, 'B tidies the action back up');
select ac.fresh('P1');
reset role;

-- ---------------------------------------------------------------------------
-- Status.
-- ---------------------------------------------------------------------------
select ac.age('BD');
select ac.snap('BD before', ac.action('BD'));
set local role authenticated;
select ac.snap('others', to_jsonb(ac.others_md5()));
select is(ac.st('D', 'BD', 'done'), '["BD", "done"]'::jsonb, 'D (the owner) marks D''s action done');
select is(ac.fresh('P1'), ac.ev('discuss'), 'a changing set_action_status records one actions_changed row');
select is(to_jsonb(ac.others_md5()), ac.snapped('others'), 'set_action_status leaves the other tables byte-identical');
reset role;
select is((ac.action('BD') ->> 'completed_at')::timestamptz, now(), 'completed_at is set');
select is((ac.action('BD') ->> 'updated_at')::timestamptz, now(), 'updated_at is set');
select is(
  ac.action('BD') - 'status' - 'completed_at' - 'updated_at',
  ac.snapped('BD before') - 'status' - 'completed_at' - 'updated_at',
  'only status, completed_at, and updated_at change'
);
select ac.age('BD');
select ac.snap('BD md5', to_jsonb(ac.action_md5('BD')));
set local role authenticated;
select is(ac.st('D', 'BD', 'done'), '["BD", "done"]'::jsonb, 'marking done again returns it');
select is(to_jsonb(ac.action_md5('BD')), ac.snapped('BD md5'), 'and leaves the row byte-identical');
select is(ac.fresh('P1'), '[]'::jsonb, 'and records no event');
select is(ac.st('D', 'BD', 'open'), '["BD", "open"]'::jsonb, 'D reopens it');
select is(ac.fresh('P1'), ac.ev('discuss'), 'reopening records one event');
reset role;
select is(ac.action('BD') -> 'completed_at', 'null'::jsonb, 'reopening clears completed_at');
set local role authenticated;
select is(ac.st('A', 'D500', 'done'), '["D500", "done"]'::jsonb, 'the facilitator A marks A''s own action done');
select is(ac.st('A', 'Demoji', 'done'), '["Demoji", "done"]'::jsonb, 'A marks D''s action done');
select is(ac.st('A', 'Demoji', 'open'), '["Demoji", "open"]'::jsonb, 'A reopens D''s action');
select ac.fresh('P1');
select ac.snap('state', to_jsonb(ac.state()));
select is(ac.st('B', 'BD', 'done'), ac.e('not_action_owner'), 'B (creator, not owner) gets not_action_owner');
select is(ac.st('D', 'BD', 'finished'), ac.e('invalid_action_status'), 'an invalid status gets invalid_action_status');
select is(ac.st('D', 'BD', 'Done'), ac.e('invalid_action_status'), 'a wrong-case status gets invalid_action_status');
select is(ac.st('D', 'BD', null), ac.e('invalid_action_status'), 'a null status gets invalid_action_status');
select is(ac.st('B', 'BD', 'nonsense'), ac.e('not_action_owner'), 'the role is checked before the status value');
select is(to_jsonb(ac.state()), ac.snapped('state'), 'the refused status calls changed nothing');
reset role;

-- Editing a done action keeps it done; reassigning keeps it done.
set local role authenticated;
select is(ac.st('A', 'AB', 'done'), '["AB", "done"]'::jsonb, 'A marks AB done');
select ac.snap('AB completed', to_jsonb(ac.action('AB') ->> 'completed_at'));
select is(ac.upd('A', 'AB', 'Facilitator action, edited', 'D', '2099-12-31', 'P1.AI'), '["AB"]'::jsonb, 'A edits and reassigns the done action');
reset role;
select is(array[ac.action('AB') ->> 'status', ac.action('AB') ->> 'owner_id'], array['done', ac.id('D')::text], 'it stays done with the new owner');
select is(to_jsonb(ac.action('AB') ->> 'completed_at'), ac.snapped('AB completed'), 'completed_at is kept');
set local role authenticated;
select ac.fresh('P1');
reset role;

-- ---------------------------------------------------------------------------
-- Action access.
-- ---------------------------------------------------------------------------
set local role authenticated;
select ac.snap('state', to_jsonb(ac.state()));
select is(ac.upd('C', 'BD', 'x', 'C', null, null), ac.e('action_not_found'), 'C gets action_not_found from update_action');
select is(ac.upd('C', 'random', 'x', 'C', null, null), ac.e('action_not_found'), 'C gets the same for a random id');
select is(ac.upd('B', 'random', 'x', 'B', null, null), ac.e('action_not_found'), 'a random action id gets action_not_found from update_action');
select is(ac.upd('B', null, 'x', 'B', null, null), ac.e('action_not_found'), 'a null action id gets action_not_found from update_action');
select is(ac.upd('B', 'QA', 'x', 'B', null, null), ac.e('action_not_found'), 'an action of project Q gets action_not_found from update_action');
select is(ac.upd(null, 'BD', 'x', 'B', null, null), ac.e('not_project_member'), 'a null user gets not_project_member from update_action');
select is(ac.st('C', 'BD', 'done'), ac.e('action_not_found'), 'C gets action_not_found from set_action_status');
select is(ac.st('C', 'random', 'done'), ac.e('action_not_found'), 'C gets the same for a random id');
select is(ac.st('B', 'random', 'done'), ac.e('action_not_found'), 'a random action id gets action_not_found from set_action_status');
select is(ac.st('B', null, 'done'), ac.e('action_not_found'), 'a null action id gets action_not_found from set_action_status');
select is(ac.st('B', 'QA', 'done'), ac.e('action_not_found'), 'an action of project Q gets action_not_found from set_action_status');
select is(ac.st(null, 'BD', 'done'), ac.e('not_project_member'), 'a null user gets not_project_member from set_action_status');
select is(ac.del('C', 'BD'), ac.e('action_not_found'), 'C gets action_not_found from delete_action');
select is(ac.del('C', 'random'), ac.e('action_not_found'), 'C gets the same for a random id');
select is(ac.del('B', 'random'), ac.e('action_not_found'), 'a random action id gets action_not_found from delete_action');
select is(ac.del('B', null), ac.e('action_not_found'), 'a null action id gets action_not_found from delete_action');
select is(ac.del('B', 'QA'), ac.e('action_not_found'), 'an action of project Q gets action_not_found from delete_action');
select is(ac.del(null, 'BD'), ac.e('not_project_member'), 'a null user gets not_project_member from delete_action');
select is(ac.get('C', 'P1'), ac.e('not_project_member'), 'C gets not_project_member from get_cycle_actions');
select is(ac.get(null, 'P1'), ac.e('not_project_member'), 'a null user gets not_project_member from get_cycle_actions');
select is(ac.get('B', null), ac.e('not_project_member'), 'a null cycle gets not_project_member from get_cycle_actions');
select is(ac.get('B', 'random'), ac.e('not_project_member'), 'an unknown cycle gets not_project_member from get_cycle_actions');
select is(to_jsonb(ac.state()), ac.snapped('state'), 'the refused calls changed nothing');
reset role;

-- ---------------------------------------------------------------------------
-- Read.
-- ---------------------------------------------------------------------------
insert into public.actions (id, cycle_id, description, owner_id, created_by, source)
values ('a1000000-0000-4000-8000-000000000001', ac.id('P1'), 'Extracted from the recording', ac.id('B'), ac.id('A'), 'extraction');
insert into ac.ids (label, id) values ('EXT', 'a1000000-0000-4000-8000-000000000001');
select ac.fresh('P1');
set local role authenticated;
select ac.snap('A', ac.get('A', 'P1'));
select ac.snap('B', ac.get('B', 'P1'));
select ac.snap('D', ac.get('D', 'P1'));
select is((select array_agg(k order by k) from jsonb_object_keys(ac.snapped('A')) k), array['actions', 'cycle_id'], 'get_cycle_actions returns exactly two keys');
select is(ac.snapped('A') ->> 'cycle_id', ac.id('P1')::text, 'cycle_id is the cycle');
select is(
  (select coalesce(jsonb_agg(x -> 'action_id' order by o), '[]'::jsonb) from jsonb_array_elements(ac.snapped('A') -> 'actions') with ordinality e(x, o)),
  ac.action_order('P1'),
  'actions are every action of P1, in created_at, then action_id order'
);
select is(jsonb_array_length(ac.snapped('A') -> 'actions'), ac.nactions('P1'), 'one element per action of P1');
select is(
  (select count(*)::int from jsonb_array_elements(ac.snapped('A') -> 'actions') x
    where (select array_agg(k order by k) from jsonb_object_keys(x) k)
       <> array['action_id', 'cluster_id', 'completed_at', 'created_at', 'created_by_me', 'description', 'due_date', 'owner_id', 'owner_is_me', 'owner_name', 'source', 'status', 'updated_at']),
  0,
  'each action has exactly the 13 keys, with no created_by'
);
select is(
  ac.item(ac.snapped('D'), 'BD') - 'created_at' - 'updated_at',
  jsonb_build_object(
    'action_id', ac.id('BD'), 'cluster_id', ac.id('P1.X'), 'description', E'Write the runbook\nfirst draft',
    'owner_id', ac.id('D'), 'owner_name', 'Dan', 'owner_is_me', true, 'created_by_me', false,
    'due_date', '2026-11-12', 'status', 'open', 'completed_at', null, 'source', 'manual'
  ),
  'B''s action owned by D, as D sees it'
);
select is(ac.item(ac.snapped('B'), 'BD') -> 'created_by_me', 'true'::jsonb, 'B sees created_by_me on B''s action');
select is(ac.item(ac.snapped('B'), 'BB') -> 'due_date', 'null'::jsonb, 'a missing due date is null');
select is(ac.item(ac.snapped('A'), 'Dhtml') ->> 'description', '<b>bold</b> & <script>x</script>', 'HTML-like text is returned as text');
select is(ac.item(ac.snapped('A'), 'Dhtml') ->> 'due_date', '2000-01-01', 'due_date is YYYY-MM-DD');
select is(jsonb_typeof(ac.item(ac.snapped('A'), 'D500') -> 'completed_at'), 'string', 'a done action has completed_at');
select is(ac.item(ac.snapped('A'), 'EXT') ->> 'source', 'extraction', 'an extraction row is returned with source extraction');
select is(
  ac.flag_ids(ac.snapped(u), 'owner_is_me'),
  ac.ids_where('P1', 'owner', u),
  'owner_is_me is true only on ' || u || '''s owned actions'
) from unnest(array['A', 'B', 'D']) u;
select is(
  ac.flag_ids(ac.snapped(u), 'created_by_me'),
  ac.ids_where('P1', 'creator', u),
  'created_by_me is true only on ' || u || '''s created actions'
) from unnest(array['A', 'B', 'D']) u;
select is(
  (select array_agg(distinct (x ->> 'owner_name') order by (x ->> 'owner_name')) from jsonb_array_elements(ac.snapped('A') -> 'actions') x),
  array['Alice', 'Bob', 'Dan'],
  'owner_name is the owner''s display name'
);
select is(array[ac.without_flags(ac.snapped('B')), ac.without_flags(ac.snapped('D'))], array[ac.without_flags(ac.snapped('A')), ac.without_flags(ac.snapped('A'))], 'A''s, B''s, and D''s responses differ only in owner_is_me and created_by_me');
select is(ac.snapped('A')::text ~ ac.id('QA')::text, false, 'no action of another cycle appears');
reset role;
update public.profiles set display_name = 'Daniel' where id = ac.id('D');
set local role authenticated;
select is(ac.item(ac.get('B', 'P1'), 'BD') ->> 'owner_name', 'Daniel', 'owner_name is the current display name');
reset role;
update public.profiles set display_name = 'Dan' where id = ac.id('D');
set local role authenticated;
select is(ac.st('A', 'EXT', 'done'), '["EXT", "done"]'::jsonb, 'the extraction row follows the same status rule');
select is(ac.upd('A', 'EXT', 'Extracted, edited', 'B', null, null), '["EXT"]'::jsonb, 'and the same edit rule');
select is(ac.del('A', 'EXT'), '["EXT"]'::jsonb, 'and the same delete rule');
select is(ac.fresh('P1'), ac.ev('discuss') || ac.ev('discuss') || ac.ev('discuss'), 'each of the three writes records one event');
reset role;

-- ---------------------------------------------------------------------------
-- Delete.
-- ---------------------------------------------------------------------------
set local role authenticated;
select ac.snap('others', to_jsonb(ac.others_md5()));
select is(ac.create('B', 'P1', 'To delete', 'B', null, null, 'BDEL'), '["ok"]'::jsonb, 'B adds an action to delete');
select ac.fresh('P1');
select is(ac.del('D', 'BDEL'), ac.e('not_action_editor'), 'D deleting B''s action gets not_action_editor');
select is(ac.del('B', 'BDEL'), '["BDEL"]'::jsonb, 'B deletes B''s action');
select is(ac.fresh('P1'), ac.ev('discuss'), 'delete_action records one actions_changed row');
select is(to_jsonb(ac.others_md5()), ac.snapped('others'), 'create and delete leave the other tables byte-identical');
select is(ac.action_exists(ac.id('BDEL')), false, 'the action is gone');
select is(ac.del('B', 'BDEL'), ac.e('action_not_found'), 'a second delete gets action_not_found');
select is(ac.upd('B', 'BDEL', 'x', 'B', null, null), ac.e('action_not_found'), 'an edit of a deleted action gets action_not_found');
select is(ac.st('B', 'BDEL', 'done'), ac.e('action_not_found'), 'a status change of a deleted action gets action_not_found');
select is(ac.create('D', 'P1', 'D''s own', 'D', null, null, 'DOWN'), '["ok"]'::jsonb, 'D adds an action');
select is(ac.del('A', 'DOWN'), '["DOWN"]'::jsonb, 'the facilitator A deletes D''s action');
select is(ac.fresh('P1'), ac.ev('discuss') || ac.ev('discuss'), 'one event each');
reset role;

-- ---------------------------------------------------------------------------
-- Facilitator transfer.
-- ---------------------------------------------------------------------------
set local role authenticated;
select ac.transfer('B');
select ac.snap('state', to_jsonb(ac.state()));
select is(ac.upd('A', 'Demoji', 'x', 'D', null, null), ac.e('not_action_editor'), 'after transfer_facilitator(P, B), the project owner A gets not_action_editor on an action A neither created nor owns');
select is(ac.st('A', 'Demoji', 'done'), ac.e('not_action_owner'), 'and not_action_owner');
select is(ac.del('A', 'Demoji'), ac.e('not_action_editor'), 'and not_action_editor from delete_action');
select is(to_jsonb(ac.state()), ac.snapped('state'), 'the refused calls changed nothing');
select is(ac.st('B', 'Demoji', 'done'), '["Demoji", "done"]'::jsonb, 'the new facilitator B changes the status of D''s action');
select is(ac.upd('B', 'Demoji', 'Edited by B', 'D', null, 'P1.Y'), '["Demoji"]'::jsonb, 'B edits D''s action');
select is(ac.upd('B', 'D500', 'Edited by B too', 'A', null, null), '["D500"]'::jsonb, 'B edits A''s action');
select is(ac.st('B', 'D500', 'open'), '["D500", "open"]'::jsonb, 'B reopens A''s action');
select is(ac.create('D', 'P1', 'To delete by B', 'D', null, null, 'DB'), '["ok"]'::jsonb, 'D adds an action');
select is(ac.del('B', 'DB'), '["DB"]'::jsonb, 'B deletes D''s action');
select ac.transfer('A');
select ac.fresh('P1');
reset role;

-- ---------------------------------------------------------------------------
-- Mid-discussion join.
-- ---------------------------------------------------------------------------
set local role authenticated;
select ac.join('E');
select is(ac.create('E', 'P1', 'Joined late', 'E', null, 'P1.Y', 'EY'), '["ok"]'::jsonb, 'a user who joins during discuss can create an action at once');
select is(ac.create('B', 'P1', 'For the newcomer', 'E', null, null, 'BE'), '["ok"]'::jsonb, 'and can be chosen as an owner at once');
select ac.fresh('P1');
reset role;

-- ---------------------------------------------------------------------------
-- As postgres: the table rules.
-- ---------------------------------------------------------------------------
select throws_ok($$ insert into public.actions (cycle_id, cluster_id, description, owner_id, created_by) values (ac.id('P1'), ac.id('P0.Old'), 'x', ac.id('B'), ac.id('B')) $$, '23503', NULL, 'a (cluster_id, cycle_id) of another cycle fails with 23503');
select throws_ok($$ insert into public.actions (cycle_id, cluster_id, description, owner_id, created_by) values (ac.id('P1'), ac.id('random'), 'x', ac.id('B'), ac.id('B')) $$, '23503', NULL, 'an unknown cluster fails with 23503');
select lives_ok($$ insert into public.actions (id, cycle_id, cluster_id, description, owner_id, created_by) values ('a1000000-0000-4000-8000-000000000002', ac.id('P1'), null, 'general', ac.id('B'), ac.id('B')) $$, 'a null cluster_id succeeds');
insert into ac.ids (label, id) values ('PG', 'a1000000-0000-4000-8000-000000000002');
select throws_ok($$ insert into public.actions (cycle_id, description) values (ac.id('P1'), ' x') $$, '23514', NULL, 'an untrimmed description fails with 23514');
select throws_ok($$ insert into public.actions (cycle_id, description) values (ac.id('P1'), E'x\n') $$, '23514', NULL, 'a trailing line break fails with 23514');
select throws_ok($$ insert into public.actions (cycle_id, description) values (ac.id('P1'), '') $$, '23514', NULL, 'an empty description fails with 23514');
select throws_ok($$ insert into public.actions (cycle_id, description) values (ac.id('P1'), repeat('a', 501)) $$, '23514', NULL, '501 characters fail with 23514');
select throws_ok($$ insert into public.actions (cycle_id, description, status) values (ac.id('P1'), 'x', 'blocked') $$, '23514', NULL, 'a status other than open or done fails with 23514');
select throws_ok($$ insert into public.actions (cycle_id, description, source) values (ac.id('P1'), 'x', 'import') $$, '23514', NULL, 'a source other than manual or extraction fails with 23514');
select throws_ok($$ insert into public.actions (cycle_id, description, due_date) values (ac.id('P1'), 'x', '1999-12-31') $$, '23514', NULL, 'a due date of 1999-12-31 fails with 23514');
select throws_ok($$ insert into public.actions (cycle_id, description, due_date) values (ac.id('P1'), 'x', '2100-01-01') $$, '23514', NULL, 'a due date of 2100-01-01 fails with 23514');
select throws_ok($$ insert into public.actions (cycle_id, description, status) values (ac.id('P1'), 'x', 'done') $$, '23514', NULL, 'done without completed_at fails with 23514');
select throws_ok($$ insert into public.actions (cycle_id, description, completed_at) values (ac.id('P1'), 'x', now()) $$, '23514', NULL, 'open with completed_at fails with 23514');
select throws_ok($$ update public.actions set id = gen_random_uuid() where id = ac.id('PG') $$, 'P0001', 'action_immutable_column', 'changing id raises action_immutable_column');
select throws_ok($$ update public.actions set cycle_id = ac.id('P0') where id = ac.id('PG') $$, 'P0001', 'action_immutable_column', 'changing cycle_id raises action_immutable_column');
select throws_ok($$ update public.actions set source = 'extraction' where id = ac.id('PG') $$, 'P0001', 'action_immutable_column', 'changing source raises action_immutable_column');
select throws_ok($$ update public.actions set created_at = now() - interval '1 day' where id = ac.id('PG') $$, 'P0001', 'action_immutable_column', 'changing created_at raises action_immutable_column');
select throws_ok($$ update public.actions set created_by = ac.id('D') where id = ac.id('PG') $$, 'P0001', 'action_immutable_column', 'changing created_by to another user raises action_immutable_column');
select lives_ok($$ update public.actions set description = 'general edited', owner_id = ac.id('D') where id = ac.id('PG') $$, 'the description and owner may change');
delete from public.actions where id = ac.id('PG');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id) values (ac.id('P1'), 'actions_changed', 'discuss', 'discuss', ac.id('A')) $$, '23514', NULL, 'an actions_changed row with an actor fails');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status, payload) values (ac.id('P1'), 'actions_changed', 'discuss', 'discuss', '{"n": 1}') $$, '23514', NULL, 'an actions_changed row with a payload fails');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values (ac.id('P1'), 'actions_changed', 'discuss', 'closed') $$, '23514', NULL, 'an actions_changed row with from_status <> to_status fails');
select lives_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values (ac.id('P1'), 'actions_changed', 'discuss', 'discuss') $$, 'an actions_changed row of the agreed shape is accepted');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values (ac.id('P1'), 'voting_closed', 'vote', 'discuss') $$, '23514', NULL, 'voting_closed is still rejected');
select ac.fresh('P1');

-- An update statement that changes no row records nothing.
update public.actions set description = 'nothing' where id = ac.id('random');
select is(ac.fresh('P1'), '[]'::jsonb, 'a statement that changes no row records no event');

-- ---------------------------------------------------------------------------
-- Limit.
-- ---------------------------------------------------------------------------
insert into public.actions (cycle_id, description, owner_id, created_by)
select ac.id('P1'), 'filler ' || g, ac.id('D'), ac.id('D') from generate_series(1, 200 - ac.nactions('P1')) g;
select is(ac.nactions('P1'), 200, 'P1 holds 200 actions');
select is(ac.fresh('P1'), ac.ev('discuss'), 'one statement inserting many rows records one event');
set local role authenticated;
select ac.snap('state', to_jsonb(ac.state()));
select is(ac.create('B', 'P1', 'one too many', 'B', null, null), ac.e('action_limit_reached'), 'the 201st action gets action_limit_reached');
select is(to_jsonb(ac.state()), ac.snapped('state'), 'and changes nothing');
select is(ac.del('B', 'BE'), '["BE"]'::jsonb, 'B deletes an action');
select is(ac.create('B', 'P1', 'back under the cap', 'B', null, null, 'BCAP'), '["ok"]'::jsonb, 'then create_action succeeds');
select ac.fresh('P1');
reset role;
delete from public.actions a where a.cycle_id = ac.id('P1') and a.description like 'filler %';
select ac.fresh('P1');

-- ---------------------------------------------------------------------------
-- Deleting a cluster (as postgres) keeps the action and its cycle.
-- ---------------------------------------------------------------------------
select ac.snap('cluster delete', to_jsonb(ac.action('Dhtml') ->> 'cycle_id'));
delete from public.clusters where id = ac.id('P1.Empty');
select is(ac.action('Dhtml') -> 'cluster_id', 'null'::jsonb, 'deleting a cluster sets the action''s cluster_id to null');
select is(to_jsonb(ac.action('Dhtml') ->> 'cycle_id'), ac.snapped('cluster delete'), 'and keeps its cycle_id');
select ac.fresh('P1');

-- ---------------------------------------------------------------------------
-- A deleted owner account.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(ac.create('B', 'P1', 'B made it for D', 'D', null, null, 'BFD'), '["ok"]'::jsonb, 'B creates an action owned by D');
reset role;
select ac.snap('D created', ac.ids_where('P1', 'creator', 'D'));
delete from auth.users where id = ac.id('D');
select is(ac.action('BFD') -> 'owner_id', 'null'::jsonb, 'deleting D''s auth user leaves D''s action with owner_id null');
select is(
  (select coalesce(jsonb_agg(to_jsonb(a.id) order by a.id), '[]'::jsonb) from public.actions a where a.cycle_id = ac.id('P1') and a.created_by is null),
  ac.snapped('D created'),
  'and D''s created actions with created_by null'
);
select is(jsonb_array_length(ac.snapped('D created')) > 0, true, 'D had created actions');
select ac.fresh('P1');
set local role authenticated;
select is(
  ac.item(ac.get('B', 'P1'), 'BFD') - 'action_id' - 'cluster_id' - 'description' - 'due_date' - 'status' - 'completed_at' - 'source' - 'created_at' - 'updated_at',
  jsonb_build_object('owner_id', null, 'owner_name', null, 'owner_is_me', false, 'created_by_me', true),
  'the orphaned action shows owner_id and owner_name null'
);
select is(ac.st('B', 'BFD', 'done'), ac.e('not_action_owner'), 'B (its creator) gets not_action_owner on its status');
select is(ac.st('A', 'BFD', 'done'), '["BFD", "done"]'::jsonb, 'the facilitator A changes its status');
select is(ac.upd('A', 'BFD', 'B made it for D', 'B', null, null), '["BFD"]'::jsonb, 'A reassigns it to B with update_action');
select is(ac.item(ac.get('B', 'P1'), 'BFD') ->> 'owner_name', 'Bob', 'it now shows B as its owner');
select ac.fresh('P1');
reset role;

-- ---------------------------------------------------------------------------
-- Closed from discuss with actions present.
-- ---------------------------------------------------------------------------
select is(ac.nactions('P1') > 0, true, 'P1 still has actions');
set local role authenticated;
select ac.close_cycle('A', 'P1');
select ac.fresh('P1');
select ac.snap('state', to_jsonb(ac.state()));
select is(ac.create('B', 'P1', 'late', 'B', null, null), ac.e('cycle_not_discussing'), 'closed from discuss: create_action gets cycle_not_discussing');
select is(ac.upd('B', 'BD', 'late', 'D', null, null), ac.e('cycle_not_discussing'), 'closed from discuss: update_action gets cycle_not_discussing');
select is(ac.upd('A', 'BD', 'late', 'D', null, null), ac.e('cycle_not_discussing'), 'closed from discuss: the facilitator''s update_action gets cycle_not_discussing');
select is(ac.del('B', 'BD'), ac.e('cycle_not_discussing'), 'closed from discuss: delete_action gets cycle_not_discussing');
select is(ac.del('A', 'BD'), ac.e('cycle_not_discussing'), 'closed from discuss: the facilitator''s delete_action gets cycle_not_discussing');
select is(to_jsonb(ac.state()), ac.snapped('state'), 'closed from discuss: the refused writes changed nothing');
select ac.snap('others', to_jsonb(ac.others_md5()));
select is(ac.st('B', 'BFD', 'open'), '["BFD", "open"]'::jsonb, 'after close_cycle, the owner B can still change status');
select is(ac.fresh('P1'), ac.ev('closed'), 'one actions_changed row with from_status = to_status = closed');
select is(ac.st('A', 'BFD', 'done'), '["BFD", "done"]'::jsonb, 'and the facilitator A can');
select is(ac.fresh('P1'), ac.ev('closed'), 'one closed event');
select is(to_jsonb(ac.others_md5()), ac.snapped('others'), 'status changes in closed leave the other tables byte-identical');
select is(jsonb_array_length(ac.get('B', 'P1') -> 'actions'), ac.nactions('P1'), 'closed: get_cycle_actions still returns every action');
reset role;

-- A deleted creator account: the creator's rights pass to nobody but the
-- facilitator.
select ac.snap('B owned', ac.ids_where('P1', 'owner', 'B'));
delete from auth.users where id = ac.id('B');
select is(
  (select coalesce(jsonb_agg(to_jsonb(a.id) order by a.id), '[]'::jsonb) from public.actions a where a.cycle_id = ac.id('P1') and a.owner_id is null and a.id in (select (jsonb_array_elements_text(ac.snapped('B owned')))::uuid)),
  ac.snapped('B owned'),
  'deleting B''s auth user leaves B''s owned actions with owner_id null'
);
select is((select count(*)::int from public.actions a where a.cycle_id = ac.id('P1') and a.created_by = ac.id('B')), 0, 'and no action still names B as creator');

-- Deleting the cycle removes its actions and records nothing.
select is(ac.nactions('Q1'), 1, 'Q1 has an action');
delete from public.feedback_cycles where id = ac.id('Q1');
select is(ac.nactions('Q1'), 0, 'deleting the cycle removes its actions');
select is((select count(*)::int from public.cycle_events e where e.cycle_id = ac.id('Q1')), 0, 'and leaves no event for it');

-- ---------------------------------------------------------------------------
-- P2: writes in every other stage. An action is written as postgres so each
-- write has a target.
-- ---------------------------------------------------------------------------
create function ac.wrong_stage(p_stage text, p_status_allowed boolean)
returns setof text
language plpgsql
as $$
declare
  before text;
begin
  return next is(ac.get('A', 'P2'), jsonb_build_object('cycle_id', ac.id('P2'), 'actions', '[]'::jsonb), p_stage || ': get_cycle_actions answers with []');
  reset role;
  insert into public.actions (id, cycle_id, description, owner_id, created_by) values (ac.id('P2A'), ac.id('P2'), 'seeded', ac.id('A'), ac.id('A'));
  set local role authenticated;
  before := ac.state();
  return next is(ac.create('A', 'P2', 'x', 'A', null, null), ac.e('cycle_not_discussing'), p_stage || ': create_action gets cycle_not_discussing');
  return next is(ac.upd('A', 'P2A', 'x', 'A', null, null), ac.e('cycle_not_discussing'), p_stage || ': update_action gets cycle_not_discussing');
  return next is(ac.del('A', 'P2A'), ac.e('cycle_not_discussing'), p_stage || ': delete_action gets cycle_not_discussing');
  if p_status_allowed then
    return next is(ac.st('A', 'P2A', 'done'), '["P2A", "done"]'::jsonb, p_stage || ': set_action_status works');
  else
    return next is(ac.st('A', 'P2A', 'done'), ac.e('cycle_not_discussing'), p_stage || ': set_action_status gets cycle_not_discussing');
    return next is(ac.state(), before, p_stage || ': the refused writes changed nothing and recorded no event');
  end if;
  reset role;
  delete from public.actions where id = ac.id('P2A');
  set local role authenticated;
end;
$$;
grant execute on function ac.wrong_stage(text, boolean) to authenticated;

select ac.new_cycle('P2', 'P', '2026-09-21');
insert into ac.ids (label, id) values ('P2A', 'a2000000-0000-4000-8000-000000000001');
set local role authenticated;
select * from ac.wrong_stage('collecting', false);
select ac.start('A', 'P2');
select * from ac.wrong_stage('reveal', false);
select ac.advance('A', 'P2', 'reveal');
select * from ac.wrong_stage('cluster', false);
select ac.advance('A', 'P2', 'cluster');
select * from ac.wrong_stage('vote', false);
select ac.close_cycle('A', 'P2');
select * from ac.wrong_stage('closed from vote', true);
reset role;

select * from finish();
rollback;
