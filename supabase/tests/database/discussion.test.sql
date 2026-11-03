-- pgTAP tests for #25: clusters.discussion_status and its guard, notes and
-- its guard, notes_changed events, and the five discussion RPCs
-- (set_discussion_status, add_note, update_note, delete_note,
-- get_cycle_discussion).
--
-- Everything runs in one transaction and is rolled back at the end. The seed
-- user is never used as a fixture. now() is the transaction time, so notes
-- added here share created_at and are ordered by note_id; the RLS suite
-- checks real transactions.
--
-- Fixtures: owner and facilitator A, members B and D, non-member C (owner of
-- Q), E (joins P during discuss). P is A's with B and D joined. P's cycles
-- run one after another, each closed before the next is created:
--   P0  a closed cycle with cluster Old (a cluster of another cycle in P)
--   P1  the main cycle: clusters X, Y (cards), Empty (no cards), and AI
--       (source ai), taken to discuss through vote and close_voting; closed
--       from discuss with notes at the end
--   P2  writes in collecting, reveal, cluster, vote, and closed from vote
-- Q1 is C's cycle in discuss with cluster QX and C's note.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(317);

-- ---------------------------------------------------------------------------
-- Test-only helpers.
-- ---------------------------------------------------------------------------
create schema dn;

create table dn.ids (label text primary key, id uuid not null);
create table dn.snaps (label text primary key, body jsonb);
create table dn.seen (id uuid primary key);

insert into dn.ids (label, id)
values
  ('A', 'dd000000-0000-4000-8000-000000000001'),
  ('B', 'dd000000-0000-4000-8000-000000000002'),
  ('C', 'dd000000-0000-4000-8000-000000000003'),
  ('D', 'dd000000-0000-4000-8000-000000000004'),
  ('E', 'dd000000-0000-4000-8000-000000000005'),
  ('P', 'de000000-0000-4000-8000-000000000001'),
  ('Q', 'de000000-0000-4000-8000-000000000002'),
  ('random', 'df000000-0000-4000-8000-000000000099');

create function dn.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from dn.ids i where i.label = p_label;
$$;

create function dn.label(p_id uuid)
returns text
language sql
stable
as $$
  select coalesce((select i.label from dn.ids i where i.id = p_id order by i.label limit 1), 'null');
$$;

create function dn.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', dn.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- The error a refused call gets, with empty detail and hint.
create function dn.e(p_message text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'code', case when p_message in ('not_project_member', 'not_project_facilitator', 'not_note_author') then '42501' else 'P0001' end,
    'message', p_message,
    'detail', '',
    'hint', ''
  );
$$;

-- Runs a query as the user: its rows as a jsonb array, or the error.
create function dn.run(p_user text, p_sql text)
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
  perform dn.become(p_user);
  execute 'select coalesce(jsonb_agg(to_jsonb(r)), ''[]''::jsonb) from (' || p_sql || ') r' into result;
  return result;
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

-- set_discussion_status: [cluster label, status], or the error.
create function dn.status(p_user text, p_cluster text, p_status text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := dn.run(p_user, format('select * from public.set_discussion_status(%L::uuid, %L)', dn.id(p_cluster), p_status));
begin
  if jsonb_typeof(result) = 'array' and jsonb_array_length(result) = 1 then
    return jsonb_build_array(dn.label((result -> 0 ->> 'cluster_id')::uuid), result -> 0 ->> 'discussion_status');
  end if;
  return result;
end;
$$;

-- add_note: the returned [note id is new, cluster label], or the error. The
-- new note is labelled p_label.
create function dn.add(p_user text, p_cycle text, p_cluster text, p_text text, p_label text default null)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := dn.run(p_user, format('select * from public.add_note(%L::uuid, %L::uuid, %L)', dn.id(p_cycle), dn.id(p_cluster), p_text));
  new_id uuid;
begin
  if jsonb_typeof(result) = 'array' and jsonb_array_length(result) = 1 then
    new_id := (result -> 0 ->> 'note_id')::uuid;
    if p_label is not null then
      insert into dn.ids (label, id) values (p_label, new_id);
    end if;
    return jsonb_build_array(dn.note_exists(new_id), dn.label((result -> 0 ->> 'cluster_id')::uuid));
  end if;
  return result;
end;
$$;

-- update_note / delete_note: [note label], or the error.
create function dn.upd(p_user text, p_note text, p_text text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := dn.run(p_user, format('select * from public.update_note(%L::uuid, %L)', dn.id(p_note), p_text));
begin
  if jsonb_typeof(result) = 'array' and jsonb_array_length(result) = 1 then
    return jsonb_build_array(dn.label((result -> 0 ->> 'note_id')::uuid));
  end if;
  return result;
end;
$$;

create function dn.del(p_user text, p_note text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := dn.run(p_user, format('select * from public.delete_note(%L::uuid)', dn.id(p_note)));
begin
  if jsonb_typeof(result) = 'array' and jsonb_array_length(result) = 1 then
    return jsonb_build_array(dn.label((result -> 0 ->> 'note_id')::uuid));
  end if;
  return result;
end;
$$;

-- get_cycle_discussion as the user, or the error.
create function dn.disc(p_user text, p_cycle text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := dn.run(p_user, format('select public.get_cycle_discussion(%L::uuid) as d', dn.id(p_cycle)));
begin
  if jsonb_typeof(result) = 'array' then
    return result -> 0 -> 'd';
  end if;
  return result;
end;
$$;

-- A response without is_mine, for "differs only in is_mine".
create function dn.without_mine(p_body jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'cycle_id', p_body -> 'cycle_id',
    'statuses', p_body -> 'statuses',
    'notes', coalesce((select jsonb_agg(n - 'is_mine' order by o) from jsonb_array_elements(p_body -> 'notes') with ordinality e(n, o)), '[]'::jsonb)
  );
$$;

-- statuses as [[cluster label, status], ...] in returned order.
create function dn.statuses(p_body jsonb)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_array(dn.label((s ->> 'cluster_id')::uuid), s ->> 'discussion_status') order by o), '[]'::jsonb)
    from jsonb_array_elements(p_body -> 'statuses') with ordinality e(s, o);
$$;

-- notes as [note label, ...] in returned order.
create function dn.note_labels(p_body jsonb)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(to_jsonb(dn.label((n ->> 'note_id')::uuid)) order by o), '[]'::jsonb)
    from jsonb_array_elements(p_body -> 'notes') with ordinality e(n, o);
$$;

create function dn.note_of(p_body jsonb, p_note text)
returns jsonb
language sql
stable
as $$
  select n from jsonb_array_elements(p_body -> 'notes') n where (n ->> 'note_id')::uuid = dn.id(p_note);
$$;

-- get_vote_totals as A: [[cluster label, total], ...].
create function dn.totals(p_cycle text)
returns jsonb
language plpgsql
as $$
begin
  perform dn.become('A');
  return (select coalesce(jsonb_agg(jsonb_build_array(dn.label(t.cluster_id), t.total_votes) order by t.n), '[]'::jsonb)
            from public.get_vote_totals(dn.id(p_cycle)) with ordinality t(cluster_id, total_votes, n));
end;
$$;

-- A new collecting cycle of a project, written as the table owner.
create function dn.new_cycle(p_label text, p_project text, p_week date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid := gen_random_uuid();
begin
  insert into public.feedback_cycles (id, project_id, title, week_start)
  values (new_id, dn.id(p_project), p_label, p_week);
  insert into dn.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

create function dn.start(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform dn.become(p_user);
  perform 1 from public.start_retrospective(dn.id(p_cycle));
end;
$$;

create function dn.advance(p_user text, p_cycle text, p_from text)
returns void
language plpgsql
as $$
begin
  perform dn.become(p_user);
  perform 1 from public.advance_stage(dn.id(p_cycle), p_from);
end;
$$;

create function dn.close_voting(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform dn.become(p_user);
  perform 1 from public.close_voting(dn.id(p_cycle));
end;
$$;

create function dn.close_cycle(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform dn.become(p_user);
  perform 1 from public.close_cycle(dn.id(p_cycle));
end;
$$;

create function dn.cast(p_user text, p_cycle text, p_cluster text)
returns void
language plpgsql
as $$
begin
  perform dn.become(p_user);
  perform 1 from public.cast_vote(dn.id(p_cycle), dn.id(p_cluster));
end;
$$;

-- A cluster made through #17's create_cluster, labelled p_cycle || '.' || name.
create function dn.mk(p_user text, p_cycle text, p_name text)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform dn.become(p_user);
  select r.cluster_id into strict new_id from public.create_cluster(dn.id(p_cycle), p_name) r;
  insert into dn.ids (label, id) values (p_cycle || '.' || p_name, new_id);
  return new_id;
end;
$$;

create function dn.transfer(p_to text)
returns void
language plpgsql
as $$
begin
  perform dn.become('A');
  perform public.transfer_facilitator(dn.id('P'), dn.id(p_to));
end;
$$;

create function dn.join(p_user text)
returns void
language plpgsql
as $$
declare
  invite text;
begin
  perform dn.become('A');
  invite := (select i.token from public.create_project_invite(dn.id('P')) i);
  perform dn.become(p_user);
  perform 1 from public.join_project(invite);
end;
$$;

create function dn.snap(p_label text, p_body jsonb)
returns void
language sql
as $$
  insert into dn.snaps (label, body) values (p_label, p_body)
  on conflict (label) do update set body = excluded.body;
$$;

create function dn.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.body from dn.snaps s where s.label = p_label;
$$;

-- Read-back helpers, security definer so they see every row.
create function dn.note_exists(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.notes n where n.id = p_id);
$$;

create function dn.note(p_note text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.to_jsonb(n) from public.notes n where n.id = dn.id(p_note);
$$;

create function dn.nnotes(p_cycle text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.notes n where n.cycle_id = dn.id(p_cycle);
$$;

create function dn.note_order(p_cycle text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(dn.label(n.id)) order by n.created_at, n.id), '[]'::jsonb) from public.notes n where n.cycle_id = dn.id(p_cycle);
$$;

create function dn.notes_by(p_cycle text, p_user text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_agg(dn.label(n.id) order by n.id::text) from public.notes n where n.cycle_id = dn.id(p_cycle) and n.author_id = dn.id(p_user);
$$;

create function dn.rest_md5()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(string_agg(pg_catalog.to_jsonb(cl)::text, '|' order by cl.id)) from public.clusters cl where cl.id in (dn.id('P1.Y'), dn.id('P1.Empty'), dn.id('P1.AI'));
$$;

create function dn.cc_md5()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(coalesce(string_agg(pg_catalog.to_jsonb(cc)::text, '|' order by cc.card_id), '')) from public.cluster_cards cc;
$$;

create function dn.cluster_row(p_cluster text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.to_jsonb(cl) from public.clusters cl where cl.id = dn.id(p_cluster);
$$;

-- The events of the cycle not returned by an earlier call, as their agreed
-- shape; marks them seen.
create function dn.fresh(p_cycle text)
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
   where e.cycle_id = dn.id(p_cycle)
     and e.id not in (select s.id from dn.seen s);
  insert into dn.seen (id)
  select e.id from public.cycle_events e where e.cycle_id = dn.id(p_cycle)
  on conflict do nothing;
  return result;
end;
$$;

create function dn.ev(p_type text, p_status text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_array(jsonb_build_object('type', p_type, 'from_status', p_status, 'to_status', p_status, 'actor_id', null, 'payload', '{}'::jsonb));
$$;

-- Every row of the tables a discussion write must not touch, and the notes,
-- clusters, and events of one cycle.
create function dn.others_md5()
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
  );
$$;

create function dn.state()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(
    dn.others_md5()
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(n)::text, '|' order by n.id) from public.notes n), '')
    || '#' || (select count(*)::text from public.cycle_events)
  );
$$;

grant usage on schema dn to authenticated, service_role;
grant select, insert, update, delete on all tables in schema dn to authenticated, service_role;
grant execute on all functions in schema dn to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures.
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', 'dd000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'dn-a@example.com', '{"display_name":"Alice"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'dd000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'dn-b@example.com', '{"display_name":"Bob"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'dd000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'dn-c@example.com', '{"display_name":"Cara"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'dd000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'dn-d@example.com', '{"display_name":"Dan"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'dd000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'dn-e@example.com', '{"display_name":"Eve"}', '', '', '', '');

insert into public.projects (id, name, owner_id)
values
  ('de000000-0000-4000-8000-000000000001', 'Project P', 'dd000000-0000-4000-8000-000000000001'),
  ('de000000-0000-4000-8000-000000000002', 'Project Q', 'dd000000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('de000000-0000-4000-8000-000000000001', 'dd000000-0000-4000-8000-000000000002', 'member'),
  ('de000000-0000-4000-8000-000000000001', 'dd000000-0000-4000-8000-000000000004', 'member');

-- ---------------------------------------------------------------------------
-- Migration hardening.
-- ---------------------------------------------------------------------------
select columns_are('public', 'clusters', array['id', 'cycle_id', 'name', 'source', 'sort_order', 'created_at', 'updated_at', 'discussion_status'], 'clusters gains exactly discussion_status');
select is(
  (select c.data_type || ':' || c.is_nullable || ':' || coalesce(c.column_default, '') from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'clusters' and c.column_name = 'discussion_status'),
  'text:NO:''pending''::text',
  'clusters.discussion_status is text not null default ''pending'''
);
select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.clusters'::regclass and c.conname = 'clusters_discussion_status_check'),
  'CHECK ((discussion_status = ANY (ARRAY[''pending''::text, ''discussed''::text, ''skipped''::text, ''deferred''::text])))',
  'clusters_discussion_status_check allows exactly the four values'
);
select trigger_is('public', 'clusters', 'clusters_guard_discussion_status', 'private', 'guard_cluster_discussion_status', 'the discussion_status guard trigger exists');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.clusters'::regclass and tgname = 'clusters_guard_discussion_status'), 19, 'the guard is BEFORE UPDATE FOR EACH ROW');
select is(
  (select pg_get_triggerdef(t.oid) ~ 'WHEN \(\(new\.discussion_status IS DISTINCT FROM old\.discussion_status\)\)' from pg_trigger t where t.tgrelid = 'public.clusters'::regclass and t.tgname = 'clusters_guard_discussion_status'),
  true,
  'the guard fires only when discussion_status changes'
);

select columns_are('public', 'notes', array['id', 'cycle_id', 'cluster_id', 'author_id', 'text', 'created_at', 'edited_at'], 'notes has exactly the seven columns');
select is(
  (select array_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable || ':' || coalesce(c.column_default, '') order by c.ordinal_position) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'notes'),
  array[
    'id:uuid:NO:gen_random_uuid()',
    'cycle_id:uuid:NO:',
    'cluster_id:uuid:YES:',
    'author_id:uuid:YES:',
    'text:text:NO:',
    'created_at:timestamp with time zone:NO:now()',
    'edited_at:timestamp with time zone:YES:'
  ],
  'notes column types, defaults, and not-null rules'
);
select col_is_pk('public', 'notes', 'id', 'notes.id is the primary key');
select is(
  (select array_agg(c.conname || ' ' || pg_get_constraintdef(c.oid) order by c.conname) from pg_constraint c where c.conrelid = 'public.notes'::regclass and c.contype = 'f'),
  array[
    'notes_author_id_fkey FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE SET NULL',
    'notes_cluster_fkey FOREIGN KEY (cluster_id, cycle_id) REFERENCES clusters(id, cycle_id) ON DELETE CASCADE',
    'notes_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES feedback_cycles(id) ON DELETE CASCADE'
  ],
  'notes has exactly its three foreign keys'
);
select is((select array_agg(c.conname::text order by c.conname) from pg_constraint c where c.conrelid = 'public.notes'::regclass and c.contype = 'c'), array['notes_text_check'], 'notes has exactly one CHECK, on text');
select is(
  (select array_agg(pg_get_indexdef(i.indexrelid) order by pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid = 'public.notes'::regclass and not i.indisprimary),
  array[
    'CREATE INDEX notes_cluster_id_idx ON public.notes USING btree (cluster_id)',
    'CREATE INDEX notes_cycle_id_created_at_idx ON public.notes USING btree (cycle_id, created_at)'
  ],
  'notes has indexes on (cycle_id, created_at) and cluster_id'
);
select trigger_is('public', 'notes', 'notes_guard_update', 'private', 'guard_note_update', 'the notes guard trigger exists');
select is((select relrowsecurity from pg_class where oid = 'public.notes'::regclass), true, 'RLS is enabled on notes');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'notes'), 0, 'notes has no policy');
select is(
  (select array_agg(r || ':' || p order by r, p) from unnest(array['anon', 'authenticated', 'service_role']) r cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege(r, 'public.notes', p)),
  array['service_role:DELETE', 'service_role:INSERT', 'service_role:SELECT', 'service_role:UPDATE'],
  'anon and authenticated have no privilege on notes; service_role has exactly SELECT, INSERT, UPDATE, DELETE'
);
select is((select count(*)::int from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name = 'notes' and g.grantee = 'PUBLIC'), 0, 'PUBLIC has no privilege on notes');
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notes'), 0, 'notes is not in supabase_realtime');
select is((select count(*)::int from pg_depend d join pg_rewrite rw on rw.oid = d.objid where d.refobjid = 'public.notes'::regclass and rw.ev_class <> 'public.notes'::regclass), 0, 'no view depends on notes');
select is(
  array[
    has_table_privilege('authenticated', 'public.clusters', 'UPDATE'),
    has_column_privilege('authenticated', 'public.clusters', 'discussion_status', 'UPDATE'),
    has_column_privilege('anon', 'public.clusters', 'discussion_status', 'UPDATE')
  ],
  array[false, false, false],
  'clients get no new privilege on clusters'
);

select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.cycle_events'::regclass and c.conname = 'cycle_events_type_check'),
  'CHECK ((type = ANY (ARRAY[''stage_changed''::text, ''clusters_changed''::text, ''notes_changed''::text])))',
  'cycle_events_type_check allows stage_changed, clusters_changed, and notes_changed'
);
select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.cycle_events'::regclass and c.conname = 'cycle_events_notes_changed_check'),
  'CHECK (((type <> ''notes_changed''::text) OR ((from_status = to_status) AND (actor_id IS NULL) AND (payload = ''{}''::jsonb))))',
  'cycle_events_notes_changed_check pins the notes_changed shape'
);
select is(
  (select array_agg(t.tgname::text || ':' || t.tgtype order by t.tgname) from pg_trigger t where t.tgrelid = 'public.notes'::regclass and not t.tgisinternal and t.tgname like 'notes_record_%'),
  array['notes_record_delete:8', 'notes_record_insert:4', 'notes_record_update:16'],
  'notes has AFTER INSERT, UPDATE, and DELETE statement triggers'
);
select is(
  (select bool_and(p.proname = 'record_notes_change') from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'public.notes'::regclass and t.tgname like 'notes_record_%'),
  true,
  'the three triggers call private.record_notes_change'
);

-- The five RPCs.
create table dn.rpcs (name text primary key, fn regprocedure, sig text, vol "char");
insert into dn.rpcs (name, fn, sig, vol)
values
  ('set_discussion_status', 'public.set_discussion_status(uuid, text)', 'p_cluster_id uuid, p_status text -> TABLE(cluster_id uuid, discussion_status text)', 'v'),
  ('add_note', 'public.add_note(uuid, uuid, text)', 'p_cycle_id uuid, p_cluster_id uuid, p_text text -> TABLE(note_id uuid, cluster_id uuid)', 'v'),
  ('update_note', 'public.update_note(uuid, text)', 'p_note_id uuid, p_text text -> TABLE(note_id uuid)', 'v'),
  ('delete_note', 'public.delete_note(uuid)', 'p_note_id uuid -> TABLE(note_id uuid)', 'v'),
  ('get_cycle_discussion', 'public.get_cycle_discussion(uuid)', 'p_cycle_id uuid -> jsonb', 's');

select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = r.name), 1, r.name || ' has exactly one overload') from dn.rpcs r order by r.name;
select is(pg_get_function_identity_arguments(r.fn) || ' -> ' || pg_get_function_result(r.fn), r.sig, r.name || ' has the agreed signature') from dn.rpcs r order by r.name;
select is((select p.prosecdef and p.proconfig = array['search_path=""']::text[] and p.provolatile = r.vol from pg_proc p where p.oid = r.fn), true, r.name || ' is security definer with search_path fixed to empty and the agreed volatility') from dn.rpcs r order by r.name;
select is(
  array[
    has_function_privilege('authenticated', r.fn, 'EXECUTE'),
    has_function_privilege('anon', r.fn, 'EXECUTE'),
    has_function_privilege('service_role', r.fn, 'EXECUTE'),
    (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = r.fn)
  ],
  array[true, false, false, false],
  r.name || ' is executable by authenticated only'
) from dn.rpcs r order by r.name;
select is(
  (select (select count(*)::int from regexp_matches(p.prosrc, '\mraise\M', 'gi'))
          = (select count(*)::int from regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''[a-z_]+'';', 'g'))
     from pg_proc p where p.oid = r.fn),
  true,
  r.name || ': every raise has errcode and message only'
) from dn.rpcs r order by r.name;
select is((select p.prosrc ~* '(detail|hint)' from pg_proc p where p.oid = r.fn), false, r.name || ' sets no detail or hint') from dn.rpcs r order by r.name;
select is(
  (select coalesce(bool_or(a ~* '(user|author|actor|voter|owner)'), false) from pg_proc p cross join unnest(p.proargnames) a where p.oid = r.fn and a like 'p\_%'),
  false,
  r.name || ' takes no user id'
) from dn.rpcs r order by r.name;
select is((select p.prosrc ~* '(votes|cards|card_authors|owner_id|execute|raise\s+notice)' from pg_proc p where p.oid = r.fn), false, r.name || ' mentions no votes, cards, card_authors, owner_id, execute, or raise notice') from dn.rpcs r order by r.name;
select is((select p.prosrc ~* 'profiles' from pg_proc p where p.oid = r.fn), r.name = 'get_cycle_discussion', r.name || (case when r.name = 'get_cycle_discussion' then ' reads profiles' else ' does not mention profiles' end)) from dn.rpcs r order by r.name;
select is((select p.prosrc ~* 'cycle_events' from pg_proc p where p.oid = r.fn), false, r.name || ' never mentions cycle_events') from dn.rpcs r order by r.name;

select is(
  (select array_agg(m[1] || ':' || m[2]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = 'public.set_discussion_status(uuid, text)'::regprocedure),
  array['42501:not_project_member', 'P0001:cluster_not_found', '42501:not_project_facilitator', 'P0001:cycle_not_discussing', 'P0001:invalid_discussion_status'],
  'set_discussion_status raises its codes in the agreed order'
);
select is(
  (select array_agg(m[1] || ':' || m[2]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = 'public.add_note(uuid, uuid, text)'::regprocedure),
  array['42501:not_project_member', '42501:not_project_member', 'P0001:cycle_not_discussing', 'P0001:cluster_not_found', 'P0001:invalid_note_text', 'P0001:note_limit_reached'],
  'add_note raises its codes in the agreed order'
);
select is(
  (select array_agg(m[1] || ':' || m[2]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = 'public.update_note(uuid, text)'::regprocedure),
  array['42501:not_project_member', 'P0001:note_not_found', 'P0001:cycle_not_discussing', 'P0001:note_not_found', '42501:not_note_author', 'P0001:invalid_note_text'],
  'update_note raises its codes in the agreed order'
);
select is(
  (select array_agg(m[1] || ':' || m[2]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = 'public.delete_note(uuid)'::regprocedure),
  array['42501:not_project_member', 'P0001:note_not_found', 'P0001:cycle_not_discussing', 'P0001:note_not_found', '42501:not_note_author'],
  'delete_note raises its codes in the agreed order'
);
select is(
  (select array_agg(m[1] || ':' || m[2]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = 'public.get_cycle_discussion(uuid)'::regprocedure),
  array['42501:not_project_member', '42501:not_project_member'],
  'get_cycle_discussion raises only not_project_member'
);

-- Locking.
create function dn.pos(p_fn regprocedure, p_pattern text)
returns integer
language sql
stable
as $$
  select coalesce((select regexp_instr(p.prosrc, p_pattern) from pg_proc p where p.oid = p_fn), 0);
$$;

select is(
  dn.pos(r.fn, 'from public\.feedback_cycles fc\s+where fc\.id = [a-z_]+\s+for update') > 0
  and dn.pos(r.fn, 'from public\.feedback_cycles fc\s+where fc\.id = [a-z_]+\s+for update') < dn.pos(r.fn, 'cycle_not_discussing')
  and dn.pos(r.fn, 'from public\.feedback_cycles fc\s+where fc\.id = [a-z_]+\s+for update') < dn.pos(r.fn, '(insert into|update|delete from) public\.(notes|clusters) '),
  true,
  r.name || ' locks the cycle FOR UPDATE before the stage check and before any write'
) from dn.rpcs r where r.name <> 'get_cycle_discussion' order by r.name;
select is(
  dn.pos(r.fn, 'from public\.projects p where p\.id = cycle_project for share') > 0
  and dn.pos(r.fn, 'from public\.projects p where p\.id = cycle_project for share') < dn.pos(r.fn, 'is_project_facilitator')
  and dn.pos(r.fn, 'from public\.projects p where p\.id = cycle_project for share') < dn.pos(r.fn, 'for update'),
  true,
  r.name || ' locks projects FOR SHARE before the facilitator check and the cycle lock'
) from dn.rpcs r where r.name in ('set_discussion_status', 'delete_note') order by r.name;
select is((select p.prosrc ~ 'public\.projects' from pg_proc p where p.oid = r.fn), false, r.name || ' does not lock projects') from dn.rpcs r where r.name in ('add_note', 'update_note') order by r.name;
select is((select count(*)::int from pg_proc p, regexp_matches(p.prosrc, 'for (update|share)', 'gi') where p.oid = 'public.get_cycle_discussion(uuid)'::regprocedure), 0, 'get_cycle_discussion takes no lock');

-- Trigger functions and helpers are not client-callable.
select is(
  array[
    has_function_privilege('authenticated', f, 'EXECUTE'),
    has_function_privilege('anon', f, 'EXECUTE'),
    has_function_privilege('service_role', f, 'EXECUTE'),
    (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = f)
  ],
  array[false, false, false, false],
  f::text || ' is not executable by any client role'
) from unnest(array['private.guard_cluster_discussion_status()'::regprocedure, 'private.guard_note_update()'::regprocedure, 'private.record_notes_change()'::regprocedure]) f;
select is((select proconfig from pg_proc where oid = f), array['search_path=""']::text[], f::text || ' fixes search_path to empty')
  from unnest(array['private.guard_cluster_discussion_status()'::regprocedure, 'private.guard_note_update()'::regprocedure, 'private.record_notes_change()'::regprocedure]) f;
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'EXECUTE')), 2, 'authenticated can still execute exactly two private functions');

-- Earlier RPCs are untouched.
select is(
  (select array_agg(p.proname || ':' || md5(p.prosrc) order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('get_cycle_board', 'get_vote_totals', 'cast_vote', 'remove_vote', 'close_voting')),
  array['cast_vote:79bc72ccf51a8c11d49f82cc13fa44f9', 'close_voting:cd475fa921a9b8d0846c07c0ea79301d', 'get_cycle_board:a652b8eee54255a3b19a6448c77fc9ee', 'get_vote_totals:0959ef4dcfd9cd5e6fae69f9ea7fd3fe', 'remove_vote:410e240ea9de04643cb626d4965508d0'],
  'get_cycle_board, get_vote_totals, cast_vote, remove_vote, and close_voting are unchanged'
);
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc ~ '(notes|discussion_status)'),
  array['add_note', 'delete_note', 'get_cycle_discussion', 'set_discussion_status', 'update_note'],
  'only the five new RPCs read or write notes or discussion_status'
);

-- ---------------------------------------------------------------------------
-- P0: a closed cycle of P with cluster Old.
-- ---------------------------------------------------------------------------
set local role authenticated;
select dn.new_cycle('P0', 'P', '2026-08-31');
select dn.start('A', 'P0');
select dn.advance('A', 'P0', 'reveal');
select dn.mk('A', 'P0', 'Old');
select dn.close_cycle('A', 'P0');
reset role;

-- ---------------------------------------------------------------------------
-- Q1: C's cycle in discuss, with cluster QX and C's note.
-- ---------------------------------------------------------------------------
set local role authenticated;
select dn.new_cycle('Q1', 'Q', '2026-09-07');
select dn.start('C', 'Q1');
select dn.advance('C', 'Q1', 'reveal');
select dn.mk('C', 'Q1', 'QX');
select dn.advance('C', 'Q1', 'cluster');
select dn.close_voting('C', 'Q1');
select is(dn.add('C', 'Q1', 'Q1.QX', 'Q note', 'QN'), '[true, "Q1.QX"]'::jsonb, 'C adds a note in Q1');
reset role;

-- ---------------------------------------------------------------------------
-- P1: to discuss through vote and close_voting.
-- ---------------------------------------------------------------------------
select dn.new_cycle('P1', 'P', '2026-09-14');
insert into dn.ids (label, id) values ('P1.s1', gen_random_uuid()), ('P1.s2', gen_random_uuid()), ('P1.t1', gen_random_uuid()), ('P1.k1', gen_random_uuid());
insert into public.cards (id, cycle_id, category, text, is_anonymous)
values
  (dn.id('P1.s1'), dn.id('P1'), 'start', 'Pair more', false),
  (dn.id('P1.s2'), dn.id('P1'), 'start', 'Demo weekly', true),
  (dn.id('P1.t1'), dn.id('P1'), 'stop', 'Late merges', false),
  (dn.id('P1.k1'), dn.id('P1'), 'continue', 'Retro notes', false);
insert into public.card_authors (card_id, author_id)
values (dn.id('P1.s1'), dn.id('A')), (dn.id('P1.s2'), dn.id('B')), (dn.id('P1.t1'), dn.id('D')), (dn.id('P1.k1'), dn.id('B'));

set local role authenticated;
select dn.start('A', 'P1');
select dn.advance('A', 'P1', 'reveal');
select dn.mk('A', 'P1', 'X');
select dn.mk('A', 'P1', 'Y');
select dn.mk('A', 'P1', 'Empty');
select dn.become('A');
select public.move_card(dn.id('P1.s1'), dn.id('P1.X'), null);
select public.move_card(dn.id('P1.s2'), dn.id('P1.X'), null);
select public.move_card(dn.id('P1.t1'), dn.id('P1.Y'), null);
reset role;

set local role service_role;
do $$
declare
  run uuid;
begin
  run := (public.begin_ai_clustering(dn.id('P1'), dn.id('A'), 'claude-opus-5-5', 'cluster-feedback/v1') ->> 'run_id')::uuid;
  perform public.replace_ai_clusters(
    run, dn.id('A'),
    jsonb_build_array(jsonb_build_object('name', 'AI', 'category', 'continue', 'card_ids', jsonb_build_array(dn.id('P1.k1')))),
    '{}'::jsonb
  );
end;
$$;
reset role;
insert into dn.ids (label, id) select 'P1.AI', cl.id from public.clusters cl where cl.cycle_id = dn.id('P1') and cl.source = 'ai';
select is(
  (select array_agg(dn.label(cl.id) || ':' || cl.source || ':' || (select count(*) from public.cluster_cards cc where cc.cluster_id = cl.id) order by cl.sort_order) from public.clusters cl where cl.cycle_id = dn.id('P1')),
  array['P1.X:manual:2', 'P1.Y:manual:1', 'P1.Empty:manual:0', 'P1.AI:ai:1'],
  'P1 has X, Y, a zero-card cluster, and an ai cluster, in that board order'
);
select is(
  (select array_agg(cl.discussion_status order by cl.sort_order) from public.clusters cl where cl.cycle_id = dn.id('P1')),
  array['pending', 'pending', 'pending', 'pending'],
  'every new cluster reads pending'
);

-- Wrong stage for a status in cluster; a rename still works.
select throws_ok($$ update public.clusters set discussion_status = 'discussed' where id = dn.id('P1.X') $$, 'P0001', 'cycle_not_discussing', 'as postgres, a discussion_status change in cluster raises cycle_not_discussing');
select lives_ok($$ update public.clusters set name = 'Renamed' where id = dn.id('P1.Empty') $$, 'as postgres, renaming a cluster in cluster still works');
update public.clusters set name = 'Empty' where id = dn.id('P1.Empty');

set local role authenticated;
select dn.advance('A', 'P1', 'cluster');
select dn.cast('B', 'P1', 'P1.Y');
select dn.cast('B', 'P1', 'P1.Y');
select dn.cast('D', 'P1', 'P1.AI');
select dn.cast('A', 'P1', 'P1.X');
select dn.close_voting('A', 'P1');
reset role;
select is((select fc.status from public.feedback_cycles fc where fc.id = dn.id('P1')), 'discuss', 'P1 is in discuss');
select dn.fresh('P1');

set local role authenticated;
select is(dn.disc('A', 'P1'), jsonb_build_object('cycle_id', dn.id('P1'), 'statuses', jsonb_build_array(
  jsonb_build_object('cluster_id', dn.id('P1.X'), 'discussion_status', 'pending'),
  jsonb_build_object('cluster_id', dn.id('P1.Y'), 'discussion_status', 'pending'),
  jsonb_build_object('cluster_id', dn.id('P1.Empty'), 'discussion_status', 'pending'),
  jsonb_build_object('cluster_id', dn.id('P1.AI'), 'discussion_status', 'pending')), 'notes', '[]'::jsonb),
  'discuss before any write: four pending statuses in sort_order and no notes');
reset role;

-- ---------------------------------------------------------------------------
-- Statuses.
-- ---------------------------------------------------------------------------
select dn.snap('totals', dn.totals('P1'));
select is(dn.snapped('totals'), '[["P1.Y", 2], ["P1.X", 1], ["P1.AI", 1], ["P1.Empty", 0]]'::jsonb, 'the totals before any status');

set local role authenticated;
select dn.snap('others', to_jsonb(dn.others_md5()));
select dn.snap('X row', dn.cluster_row('P1.X'));
select dn.snap('rest md5', to_jsonb(dn.rest_md5()));
select dn.snap('cards md5', to_jsonb(dn.cc_md5()));
select is(dn.status('A', 'P1.X', 'discussed'), '["P1.X", "discussed"]'::jsonb, 'A sets X to discussed');
select is(dn.fresh('P1'), dn.ev('clusters_changed', 'discuss'), 'one clusters_changed event, actor null, payload {}');
select is(
  dn.cluster_row('P1.X') - 'discussion_status' - 'updated_at',
  dn.snapped('X row') - 'discussion_status' - 'updated_at',
  'only X''s discussion_status and updated_at change'
);
select is(dn.rest_md5(), dn.snapped('rest md5') #>> '{}', 'the other clusters are byte-identical');
select is(dn.status('A', 'P1.X', 'skipped'), '["P1.X", "skipped"]'::jsonb, 'A sets X to skipped');
select is(dn.fresh('P1'), dn.ev('clusters_changed', 'discuss'), 'one event for skipped');
select is(dn.status('A', 'P1.X', 'deferred'), '["P1.X", "deferred"]'::jsonb, 'A sets X to deferred');
select is(dn.fresh('P1'), dn.ev('clusters_changed', 'discuss'), 'one event for deferred');
select is(dn.status('A', 'P1.X', 'pending'), '["P1.X", "pending"]'::jsonb, 'A puts X back to pending');
select is(dn.fresh('P1'), dn.ev('clusters_changed', 'discuss'), 'one event for pending');
select is(dn.status('A', 'P1.X', 'discussed'), '["P1.X", "discussed"]'::jsonb, 'A sets X to discussed again');
select dn.fresh('P1');
select dn.snap('X md5', to_jsonb(md5(dn.cluster_row('P1.X')::text)));
select is(dn.status('A', 'P1.X', 'discussed'), '["P1.X", "discussed"]'::jsonb, 'setting the current value again returns it');
select is(to_jsonb(md5(dn.cluster_row('P1.X')::text)), dn.snapped('X md5'), 'and leaves the cluster row byte-identical');
select is(dn.fresh('P1'), '[]'::jsonb, 'and records no event');
select is(dn.status('A', 'P1.Empty', 'skipped'), '["P1.Empty", "skipped"]'::jsonb, 'a zero-card cluster takes a status');
select is(dn.fresh('P1'), dn.ev('clusters_changed', 'discuss'), 'one event for the zero-card cluster');
select is(dn.status('A', 'P1.AI', 'deferred'), '["P1.AI", "deferred"]'::jsonb, 'an ai cluster takes a status');
select is(dn.fresh('P1'), dn.ev('clusters_changed', 'discuss'), 'one event for the ai cluster');
select is(dn.status('A', 'P1.Y', 'discussed'), '["P1.Y", "discussed"]'::jsonb, 'the top topic takes a status');
select dn.fresh('P1');
select is(to_jsonb(dn.cc_md5()), dn.snapped('cards md5'), 'status writes leave cluster_cards byte-identical');
reset role;
select is(dn.totals('P1'), dn.snapped('totals'), 'get_vote_totals'' rows and order are identical after the statuses');

-- Status access.
set local role authenticated;
select dn.snap('state', to_jsonb(dn.state()));
select is(dn.status('B', 'P1.X', 'skipped'), dn.e('not_project_facilitator'), 'B gets not_project_facilitator');
select is(dn.status('D', 'P1.X', 'skipped'), dn.e('not_project_facilitator'), 'D gets not_project_facilitator');
select is(dn.status('C', 'P1.X', 'skipped'), dn.e('cluster_not_found'), 'C gets cluster_not_found');
select is(dn.status('A', null, 'skipped'), dn.e('cluster_not_found'), 'a null cluster id gets cluster_not_found');
select is(dn.status('A', 'random', 'skipped'), dn.e('cluster_not_found'), 'a random id gets cluster_not_found');
select is(dn.status('A', 'Q1.QX', 'skipped'), dn.e('cluster_not_found'), 'a cluster of project Q gets cluster_not_found');
select is(dn.status(null, 'P1.X', 'skipped'), dn.e('not_project_member'), 'a null user gets not_project_member');
select is(dn.status('A', 'P1.X', 'done'), dn.e('invalid_discussion_status'), 'an invalid status gets invalid_discussion_status');
select is(dn.status('A', 'P1.X', 'Discussed'), dn.e('invalid_discussion_status'), 'a wrong-case status gets invalid_discussion_status');
select is(dn.status('A', 'P1.X', null), dn.e('invalid_discussion_status'), 'a null status gets invalid_discussion_status');
select is(to_jsonb(dn.state()), dn.snapped('state'), 'the refused status calls changed nothing and recorded no event');

select dn.transfer('B');
select is(dn.status('A', 'P1.X', 'skipped'), dn.e('not_project_facilitator'), 'after transfer_facilitator(P, B), the owner A gets not_project_facilitator');
select is(dn.status('B', 'P1.X', 'skipped'), '["P1.X", "skipped"]'::jsonb, 'and B succeeds');
select dn.transfer('A');
select dn.fresh('P1');
reset role;

-- As postgres: the CHECK.
select throws_ok($$ update public.clusters set discussion_status = 'done' where id = dn.id('P1.X') $$, '23514', NULL, 'as postgres, an unknown status fails the CHECK');

-- ---------------------------------------------------------------------------
-- Notes.
-- ---------------------------------------------------------------------------
set local role authenticated;
select dn.snap('others', to_jsonb(dn.others_md5()));
select is(dn.add('B', 'P1', 'P1.X', E'  first line\nsecond line \t\r\n', 'BX'), '[true, "P1.X"]'::jsonb, 'B adds a topic note: its id and cluster id');
select is(dn.fresh('P1'), dn.ev('notes_changed', 'discuss'), 'add_note records one notes_changed event');
select is(to_jsonb(dn.others_md5()), dn.snapped('others'), 'add_note leaves feedback_cycles, project_members, clusters, cluster_cards, and votes byte-identical');
reset role;
select is(dn.note('BX') ->> 'text', E'first line\nsecond line', 'the stored text is trimmed with the inner line break kept');
select is(array[dn.note('BX') ->> 'author_id', dn.note('BX') ->> 'cluster_id', dn.note('BX') ->> 'cycle_id'], array[dn.id('B')::text, dn.id('P1.X')::text, dn.id('P1')::text], 'author, cluster, and cycle are stored');
select is(dn.note('BX') -> 'edited_at', 'null'::jsonb, 'edited_at starts null');
set local role authenticated;
select is(dn.add('B', 'P1', null, 'General point', 'BG'), '[true, "null"]'::jsonb, 'B adds a general note with a null cluster id');
select dn.fresh('P1');
select is(dn.add('D', 'P1', 'P1.Y', repeat('a', 2000), 'D2000'), '[true, "P1.Y"]'::jsonb, 'text of exactly 2000 characters is accepted');
select is(dn.add('D', 'P1', 'P1.Y', repeat('😀', 2000), 'Demoji'), '[true, "P1.Y"]'::jsonb, 'text of 2000 multi-byte characters is accepted');
select is(dn.add('D', 'P1', 'P1.Y', '<b>bold</b> & <script>x</script>', 'Dhtml'), '[true, "P1.Y"]'::jsonb, 'HTML-like text is stored as text');
select is(dn.add('A', 'P1', 'P1.Empty', 'Facilitator note', 'AE'), '[true, "P1.Empty"]'::jsonb, 'the facilitator adds a note to a zero-card cluster');
select is(dn.add('D', 'P1', 'P1.AI', 'D on AI', 'DAI'), '[true, "P1.AI"]'::jsonb, 'D adds a note to the ai cluster');
select dn.fresh('P1');
select dn.snap('state', to_jsonb(dn.state()));
select is(dn.add('B', 'P1', 'P1.X', ''), dn.e('invalid_note_text'), 'empty text gets invalid_note_text');
select is(dn.add('B', 'P1', 'P1.X', E' \t\n\r '), dn.e('invalid_note_text'), 'whitespace-only text gets invalid_note_text');
select is(dn.add('B', 'P1', 'P1.X', null), dn.e('invalid_note_text'), 'null text gets invalid_note_text');
select is(dn.add('B', 'P1', 'P1.X', repeat('a', 2001)), dn.e('invalid_note_text'), '2001 characters get invalid_note_text');
select is(dn.add('B', 'P1', 'P1.X', repeat('😀', 2001)), dn.e('invalid_note_text'), '2001 multi-byte characters get invalid_note_text');
select is(dn.add('B', 'P1', 'P0.Old', 'x'), dn.e('cluster_not_found'), 'a cluster of another cycle in P gets cluster_not_found');
select is(dn.add('B', 'P1', 'Q1.QX', 'x'), dn.e('cluster_not_found'), 'a cluster of Q gets cluster_not_found');
select is(dn.add('B', 'P1', 'random', 'x'), dn.e('cluster_not_found'), 'a random cluster id gets cluster_not_found');
select is(dn.add('C', 'P1', 'P1.X', 'x'), dn.e('not_project_member'), 'C gets not_project_member from add_note');
select is(dn.add(null, 'P1', 'P1.X', 'x'), dn.e('not_project_member'), 'a null user gets not_project_member from add_note');
select is(dn.add('B', null, 'P1.X', 'x'), dn.e('not_project_member'), 'a null cycle gets not_project_member from add_note');
select is(dn.add('B', 'random', null, 'x'), dn.e('not_project_member'), 'an unknown cycle gets not_project_member from add_note');
select is(dn.add('B', 'Q1', null, 'x'), dn.e('not_project_member'), 'a cycle of another project gets not_project_member from add_note');
select is(to_jsonb(dn.state()), dn.snapped('state'), 'the refused adds changed nothing and recorded no event');

-- Edit.
select dn.snap('others', to_jsonb(dn.others_md5()));
select dn.snap('BX created', dn.note('BX') -> 'created_at');
select is(dn.upd('B', 'BX', E'  edited\ntext  '), '["BX"]'::jsonb, 'B edits B''s note');
select is(dn.fresh('P1'), dn.ev('notes_changed', 'discuss'), 'a changing edit records one notes_changed event');
select is(to_jsonb(dn.others_md5()), dn.snapped('others'), 'update_note leaves the other tables byte-identical');
reset role;
select is(dn.note('BX') ->> 'text', E'edited\ntext', 'the new text is trimmed');
select isnt(dn.note('BX') -> 'edited_at', 'null'::jsonb, 'edited_at is set');
select is(dn.note('BX') -> 'created_at', dn.snapped('BX created'), 'created_at is kept');
set local role authenticated;
select dn.snap('state', to_jsonb(dn.state()));
select is(dn.upd('B', 'BX', E'\n edited\ntext\t'), '["BX"]'::jsonb, 'editing to the same text after trimming returns the id');
select is(to_jsonb(dn.state()), dn.snapped('state'), 'and changes nothing and records no event');
select is(dn.upd('A', 'BX', 'mine now'), dn.e('not_note_author'), 'the facilitator A editing B''s note gets not_note_author');
select is(dn.upd('D', 'BX', 'mine now'), dn.e('not_note_author'), 'D editing B''s note gets not_note_author');
select is(dn.upd('B', 'BX', '   '), dn.e('invalid_note_text'), 'an edit to whitespace gets invalid_note_text');
select is(dn.upd('B', 'BX', ''), dn.e('invalid_note_text'), 'an edit to empty gets invalid_note_text');
select is(dn.upd('B', 'BX', repeat('a', 2001)), dn.e('invalid_note_text'), 'an edit to 2001 characters gets invalid_note_text');
select is(dn.upd('B', 'BX', null), dn.e('invalid_note_text'), 'an edit to null gets invalid_note_text');
select is(to_jsonb(dn.state()), dn.snapped('state'), 'the refused edits changed nothing');

-- Note access.
select is(dn.upd('C', 'BX', 'x'), dn.e('note_not_found'), 'C gets note_not_found from update_note');
select is(dn.upd('C', 'random', 'x'), dn.e('note_not_found'), 'C gets the same for a random id');
select is(dn.upd('B', 'random', 'x'), dn.e('note_not_found'), 'a random note id gets note_not_found from update_note');
select is(dn.upd('B', null, 'x'), dn.e('note_not_found'), 'a null note id gets note_not_found from update_note');
select is(dn.upd('B', 'QN', 'x'), dn.e('note_not_found'), 'a note of project Q gets note_not_found from update_note');
select is(dn.upd(null, 'BX', 'x'), dn.e('not_project_member'), 'a null user gets not_project_member from update_note');
select is(dn.del('C', 'BX'), dn.e('note_not_found'), 'C gets note_not_found from delete_note');
select is(dn.del('C', 'random'), dn.e('note_not_found'), 'C gets the same for a random id');
select is(dn.del('B', 'random'), dn.e('note_not_found'), 'a random note id gets note_not_found from delete_note');
select is(dn.del('B', null), dn.e('note_not_found'), 'a null note id gets note_not_found from delete_note');
select is(dn.del('B', 'QN'), dn.e('note_not_found'), 'a note of project Q gets note_not_found from delete_note');
select is(dn.del(null, 'BX'), dn.e('not_project_member'), 'a null user gets not_project_member from delete_note');
select is(dn.disc('C', 'P1'), dn.e('not_project_member'), 'C gets not_project_member from get_cycle_discussion');
select is(dn.disc(null, 'P1'), dn.e('not_project_member'), 'a null user gets not_project_member from get_cycle_discussion');
select is(dn.disc('B', null), dn.e('not_project_member'), 'a null cycle gets not_project_member from get_cycle_discussion');
select is(dn.disc('B', 'random'), dn.e('not_project_member'), 'an unknown cycle gets not_project_member from get_cycle_discussion');
select is(to_jsonb(dn.state()), dn.snapped('state'), 'the refused calls changed nothing');

-- Read.
select dn.snap('A', dn.disc('A', 'P1'));
select dn.snap('B', dn.disc('B', 'P1'));
select dn.snap('D', dn.disc('D', 'P1'));
select is((select array_agg(k order by k) from jsonb_object_keys(dn.snapped('A')) k), array['cycle_id', 'notes', 'statuses'], 'get_cycle_discussion returns exactly three keys');
select is(dn.snapped('A') ->> 'cycle_id', dn.id('P1')::text, 'cycle_id is the cycle');
select is(dn.statuses(dn.snapped('A')), '[["P1.X", "skipped"], ["P1.Y", "discussed"], ["P1.Empty", "skipped"], ["P1.AI", "deferred"]]'::jsonb, 'statuses: one per cluster, in sort_order');
select is((select count(*)::int from jsonb_array_elements(dn.snapped('A') -> 'statuses') s where (select array_agg(k order by k) from jsonb_object_keys(s) k) <> array['cluster_id', 'discussion_status']), 0, 'each status has exactly two keys');
select is(
  dn.note_labels(dn.snapped('A')),
  dn.note_order('P1'),
  'notes are every note of P1, in created_at, then note_id order'
);
select is(jsonb_array_length(dn.snapped('A') -> 'notes'), 7, 'P1 has seven notes');
select is((select count(*)::int from jsonb_array_elements(dn.snapped('A') -> 'notes') n where (select array_agg(k order by k) from jsonb_object_keys(n) k) <> array['author_name', 'cluster_id', 'created_at', 'edited_at', 'is_mine', 'note_id', 'text']), 0, 'each note has exactly the seven keys');
select is(dn.note_of(dn.snapped('A'), 'BG') -> 'cluster_id', 'null'::jsonb, 'the general note has cluster_id null');
select is(
  dn.note_of(dn.snapped('B'), 'BX') - 'created_at' - 'edited_at',
  jsonb_build_object('note_id', dn.id('BX'), 'cluster_id', dn.id('P1.X'), 'text', E'edited\ntext', 'author_name', 'Bob', 'is_mine', true),
  'B''s note as B sees it'
);
select is(jsonb_typeof(dn.note_of(dn.snapped('B'), 'BX') -> 'edited_at'), 'string', 'an edited note has edited_at');
select is(dn.note_of(dn.snapped('B'), 'BG') -> 'edited_at', 'null'::jsonb, 'an unedited note has edited_at null');
select is(dn.note_of(dn.snapped('A'), 'Dhtml') ->> 'text', '<b>bold</b> & <script>x</script>', 'HTML-like text is returned as text');
select is(
  (select array_agg(dn.label((n ->> 'note_id')::uuid) order by n ->> 'note_id') from jsonb_array_elements(dn.snapped(u) -> 'notes') n where (n ->> 'is_mine')::boolean),
  dn.notes_by('P1', u),
  'is_mine is true only on ' || u || '''s notes'
) from unnest(array['A', 'B', 'D']) u;
select is(
  (select array_agg(distinct (n ->> 'author_name')) from jsonb_array_elements(dn.snapped('A') -> 'notes') n),
  array['Alice', 'Bob', 'Dan'],
  'author_name is the author''s display name'
);
select is(array[dn.without_mine(dn.snapped('B')), dn.without_mine(dn.snapped('D'))], array[dn.without_mine(dn.snapped('A')), dn.without_mine(dn.snapped('A'))], 'A''s, B''s, and D''s responses differ only in is_mine');
select is(
  (select bool_or(dn.snapped(u)::text ~* dn.id(x)::text) from unnest(array['A', 'B', 'D']) u cross join unnest(array['A', 'B', 'C', 'D', 'E']) x),
  false,
  'no response contains a user id'
);
select is(dn.snapped('A')::text ~ dn.id('QN')::text, false, 'no note of another cycle appears');
reset role;
update public.profiles set display_name = 'Robert' where id = dn.id('B');
set local role authenticated;
select is(dn.note_of(dn.disc('D', 'P1'), 'BX') ->> 'author_name', 'Robert', 'author_name is the current display name');
reset role;
update public.profiles set display_name = 'Bob' where id = dn.id('B');

-- Delete.
set local role authenticated;
select dn.snap('others', to_jsonb(dn.others_md5()));
select is(dn.del('D', 'BG'), dn.e('not_note_author'), 'D deleting B''s note gets not_note_author');
select is(dn.del('B', 'BG'), '["BG"]'::jsonb, 'B deletes B''s own note');
select is(dn.fresh('P1'), dn.ev('notes_changed', 'discuss'), 'delete_note records one notes_changed event');
select is(to_jsonb(dn.others_md5()), dn.snapped('others'), 'delete_note leaves the other tables byte-identical');
select is(dn.note_exists(dn.id('BG')), false, 'the note is gone');
select is(dn.del('B', 'BG'), dn.e('note_not_found'), 'a second delete of the same note gets note_not_found');
select is(dn.upd('B', 'BG', 'x'), dn.e('note_not_found'), 'an edit of a deleted note gets note_not_found');
select is(dn.fresh('P1'), '[]'::jsonb, 'the failing calls recorded no event');
select is(dn.del('A', 'DAI'), '["DAI"]'::jsonb, 'the facilitator A deletes D''s note');
select dn.fresh('P1');
select dn.transfer('B');
select is(dn.del('A', 'Dhtml'), dn.e('not_note_author'), 'the owner who is not the facilitator gets not_note_author');
select is(dn.del('B', 'Dhtml'), '["Dhtml"]'::jsonb, 'the new facilitator B deletes D''s note');
select dn.transfer('A');
select dn.fresh('P1');

-- Mid-discussion join.
select dn.join('E');
select is(dn.add('E', 'P1', 'P1.Y', 'Joined late', 'EY'), '[true, "P1.Y"]'::jsonb, 'a user who joins during discuss can add a note at once');
select dn.fresh('P1');
reset role;

-- As postgres: the notes table rules.
select throws_ok($$ insert into public.notes (cycle_id, cluster_id, author_id, text) values (dn.id('P1'), dn.id('P0.Old'), dn.id('B'), 'x') $$, '23503', NULL, 'a (cluster_id, cycle_id) of another cycle fails with 23503');
select throws_ok($$ insert into public.notes (cycle_id, cluster_id, author_id, text) values (dn.id('P1'), dn.id('random'), dn.id('B'), 'x') $$, '23503', NULL, 'an unknown cluster fails with 23503');
select lives_ok($$ insert into public.notes (id, cycle_id, cluster_id, author_id, text) values ('d1000000-0000-4000-8000-000000000001', dn.id('P1'), null, dn.id('B'), 'general') $$, 'a null cluster_id is allowed');
insert into dn.ids (label, id) values ('PG', 'd1000000-0000-4000-8000-000000000001');
select throws_ok($$ insert into public.notes (cycle_id, author_id, text) values (dn.id('P1'), dn.id('B'), ' x') $$, '23514', NULL, 'untrimmed text fails with 23514');
select throws_ok($$ insert into public.notes (cycle_id, author_id, text) values (dn.id('P1'), dn.id('B'), E'x\n') $$, '23514', NULL, 'text with a trailing line break fails with 23514');
select throws_ok($$ insert into public.notes (cycle_id, author_id, text) values (dn.id('P1'), dn.id('B'), '') $$, '23514', NULL, 'empty text fails with 23514');
select throws_ok($$ insert into public.notes (cycle_id, author_id, text) values (dn.id('P1'), dn.id('B'), repeat('a', 2001)) $$, '23514', NULL, '2001 characters fail with 23514');
select throws_ok($$ update public.notes set id = gen_random_uuid() where id = dn.id('PG') $$, 'P0001', 'note_immutable_column', 'changing id raises note_immutable_column');
select throws_ok($$ update public.notes set cycle_id = dn.id('P0') where id = dn.id('PG') $$, 'P0001', 'note_immutable_column', 'changing cycle_id raises note_immutable_column');
select throws_ok($$ update public.notes set cluster_id = dn.id('P1.X') where id = dn.id('PG') $$, 'P0001', 'note_immutable_column', 'changing cluster_id raises note_immutable_column');
select throws_ok($$ update public.notes set created_at = now() - interval '1 day' where id = dn.id('PG') $$, 'P0001', 'note_immutable_column', 'changing created_at raises note_immutable_column');
select throws_ok($$ update public.notes set author_id = dn.id('D') where id = dn.id('PG') $$, 'P0001', 'note_immutable_column', 'changing author_id to another user raises note_immutable_column');
select lives_ok($$ update public.notes set text = 'general edited' where id = dn.id('PG') $$, 'the text may change');
delete from public.notes where id = dn.id('PG');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id) values (dn.id('P1'), 'notes_changed', 'discuss', 'discuss', dn.id('A')) $$, '23514', NULL, 'a notes_changed row with an actor fails');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status, payload) values (dn.id('P1'), 'notes_changed', 'discuss', 'discuss', '{"n": 1}') $$, '23514', NULL, 'a notes_changed row with a payload fails');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values (dn.id('P1'), 'notes_changed', 'discuss', 'closed') $$, '23514', NULL, 'a notes_changed row with from_status <> to_status fails');
select lives_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values (dn.id('P1'), 'notes_changed', 'discuss', 'discuss') $$, 'a notes_changed row of the agreed shape is accepted');
select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values (dn.id('P1'), 'voting_closed', 'vote', 'discuss') $$, '23514', NULL, 'voting_closed is still rejected');
select dn.fresh('P1');

-- Limit.
insert into public.notes (cycle_id, cluster_id, author_id, text)
select dn.id('P1'), null, dn.id('D'), 'filler ' || g from generate_series(1, 500 - dn.nnotes('P1')) g;
select is(dn.nnotes('P1'), 500, 'P1 holds 500 notes');
select dn.fresh('P1');
set local role authenticated;
select dn.snap('state', to_jsonb(dn.state()));
select is(dn.add('B', 'P1', null, 'one too many'), dn.e('note_limit_reached'), 'the 501st note gets note_limit_reached');
select is(to_jsonb(dn.state()), dn.snapped('state'), 'and changes nothing');
select is(dn.del('B', 'BX'), '["BX"]'::jsonb, 'B deletes a note');
select is(dn.add('B', 'P1', 'P1.X', 'back under the cap', 'BX2'), '[true, "P1.X"]'::jsonb, 'then add_note succeeds');
select dn.fresh('P1');
reset role;
delete from public.notes n where n.cycle_id = dn.id('P1') and n.text like 'filler %';
select dn.fresh('P1');

-- A deleted author account.
select dn.snap('B notes', (select to_jsonb(array_agg(n.id order by n.id)) from public.notes n where n.author_id = dn.id('B')));
delete from auth.users where id = dn.id('B');
select is(
  (select to_jsonb(array_agg(n.id order by n.id)) from public.notes n where n.cycle_id = dn.id('P1') and n.author_id is null),
  dn.snapped('B notes'),
  'deleting B''s auth user leaves B''s notes with author_id null'
);
set local role authenticated;
select is(dn.note_of(dn.disc('D', 'P1'), 'BX2') -> 'author_name', 'null'::jsonb, 'B''s orphaned note shows author_name null');
select is(dn.note_of(dn.disc('D', 'P1'), 'BX2') -> 'is_mine', 'false'::jsonb, 'and is_mine false');
select is(dn.upd('A', 'BX2', 'x'), dn.e('not_note_author'), 'nobody can edit an orphaned note, the facilitator included');
select is(dn.del('D', 'BX2'), dn.e('not_note_author'), 'a member cannot delete an orphaned note');
select is(dn.del('A', 'BX2'), '["BX2"]'::jsonb, 'the facilitator A deletes B''s orphaned note');
select dn.fresh('P1');
reset role;

-- Closed from discuss with notes present.
select is(dn.nnotes('P1') > 0, true, 'P1 still has notes');
set local role authenticated;
select dn.close_cycle('A', 'P1');
select dn.fresh('P1');
select dn.snap('state', to_jsonb(dn.state()));
select is(dn.status('A', 'P1.X', 'skipped'), dn.e('cycle_not_discussing'), 'closed from discuss: set_discussion_status gets cycle_not_discussing');
select is(dn.add('D', 'P1', 'P1.X', 'late'), dn.e('cycle_not_discussing'), 'closed from discuss: add_note gets cycle_not_discussing');
select is(dn.upd('D', 'D2000', 'late'), dn.e('cycle_not_discussing'), 'closed from discuss: update_note gets cycle_not_discussing');
select is(dn.del('D', 'D2000'), dn.e('cycle_not_discussing'), 'closed from discuss: delete_note gets cycle_not_discussing');
select is(dn.del('A', 'D2000'), dn.e('cycle_not_discussing'), 'closed from discuss: the facilitator''s delete_note gets cycle_not_discussing');
select is(to_jsonb(dn.state()), dn.snapped('state'), 'closed from discuss: the refused writes changed nothing');
select is(dn.statuses(dn.disc('D', 'P1')), '[["P1.X", "skipped"], ["P1.Y", "discussed"], ["P1.Empty", "skipped"], ["P1.AI", "deferred"]]'::jsonb, 'closed: get_cycle_discussion still returns the statuses');
select is(jsonb_array_length(dn.disc('D', 'P1') -> 'notes'), dn.nnotes('P1'), 'closed: and every note');
reset role;
select throws_ok($$ update public.clusters set discussion_status = 'pending' where id = dn.id('P1.X') $$, 'P0001', 'cycle_not_discussing', 'as postgres, a status change in closed raises cycle_not_discussing');

-- Deleting the cycle removes its notes and records nothing.
select dn.snap('Q notes', to_jsonb(dn.nnotes('Q1')));
select is((dn.snapped('Q notes') #>> '{}')::int, 1, 'Q1 has a note');
delete from public.feedback_cycles where id = dn.id('Q1');
select is(dn.nnotes('Q1'), 0, 'deleting the cycle removes its notes');
select is((select count(*)::int from public.cycle_events e where e.cycle_id = dn.id('Q1')), 0, 'and leaves no event for it');

-- ---------------------------------------------------------------------------
-- P2: writes in every other stage. A note and a cluster are written as
-- postgres so each write has a target.
-- ---------------------------------------------------------------------------
create function dn.wrong_stage(p_stage text)
returns setof text
language plpgsql
as $$
declare
  before text;
begin
  -- Reads first: all pending, no notes.
  return next is(dn.statuses(dn.disc('D', 'P2')), '[["P2.Z", "pending"]]'::jsonb, p_stage || ': get_cycle_discussion answers, all pending');
  return next is(dn.disc('D', 'P2') -> 'notes', '[]'::jsonb, p_stage || ': no notes');
  reset role;
  insert into public.notes (id, cycle_id, author_id, text) values (dn.id('P2N'), dn.id('P2'), dn.id('D'), 'seeded');
  return next throws_ok(format('update public.clusters set discussion_status = %L where id = %L', 'skipped', dn.id('P2.Z')), 'P0001', 'cycle_not_discussing', p_stage || ': as postgres, a status change raises cycle_not_discussing');
  set local role authenticated;
  before := dn.state();
  return next is(dn.status('A', 'P2.Z', 'skipped'), dn.e('cycle_not_discussing'), p_stage || ': set_discussion_status gets cycle_not_discussing');
  return next is(dn.add('D', 'P2', null, 'x'), dn.e('cycle_not_discussing'), p_stage || ': add_note gets cycle_not_discussing');
  return next is(dn.add('D', 'P2', 'P2.Z', 'x'), dn.e('cycle_not_discussing'), p_stage || ': add_note on a topic gets cycle_not_discussing');
  return next is(dn.upd('D', 'P2N', 'x'), dn.e('cycle_not_discussing'), p_stage || ': update_note gets cycle_not_discussing');
  return next is(dn.del('D', 'P2N'), dn.e('cycle_not_discussing'), p_stage || ': delete_note gets cycle_not_discussing');
  return next is(dn.state(), before, p_stage || ': the refused writes changed nothing and recorded no event');
  reset role;
  delete from public.notes where id = dn.id('P2N');
  set local role authenticated;
end;
$$;
grant execute on function dn.wrong_stage(text) to authenticated;

select dn.new_cycle('P2', 'P', '2026-09-21');
insert into dn.ids (label, id) values ('P2N', 'd2000000-0000-4000-8000-000000000001'), ('P2.Z', 'd2000000-0000-4000-8000-000000000002');
insert into public.clusters (id, cycle_id, name, sort_order) values (dn.id('P2.Z'), dn.id('P2'), 'Z', 1);
set local role authenticated;
select * from dn.wrong_stage('collecting');
select dn.start('A', 'P2');
select * from dn.wrong_stage('reveal');
select dn.advance('A', 'P2', 'reveal');
select * from dn.wrong_stage('cluster');
select dn.advance('A', 'P2', 'cluster');
select * from dn.wrong_stage('vote');
select dn.close_cycle('A', 'P2');
select * from dn.wrong_stage('closed from vote');
reset role;

select * from finish();
rollback;
