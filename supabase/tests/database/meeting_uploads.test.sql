-- pgTAP tests for #28: meeting_uploads, its guard, the meeting-media bucket
-- and its two storage.objects policies with their helpers, and the three
-- RPCs (create_meeting_upload, complete_meeting_upload, get_cycle_uploads).
--
-- Everything runs in one transaction and is rolled back at the end. now() is
-- the transaction time, so rows made here share created_at and are ordered
-- by id; a test that needs a 24-hour-old row moves created_at back as
-- postgres with the guard disabled. storage.objects rows for completion
-- cases are inserted as postgres with metadata {"size", "mimetype"}. The RLS
-- suite exercises the real Storage API.
--
-- Fixtures: owner and facilitator A, members B and D (D is made facilitator
-- in the transfer cases), non-member C; projects P (A's) and Q (C's, C the
-- facilitator). P1 is taken through every stage by the RPCs and closed; P2
-- is P's next cycle, used in collecting and then for the limits. Q1 is C's
-- cycle in discuss.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(282);

-- ---------------------------------------------------------------------------
-- Test-only helpers.
-- ---------------------------------------------------------------------------
create schema mu;

create table mu.ids (label text primary key, id uuid not null);
create table mu.snaps (label text primary key, body text);

insert into mu.ids (label, id)
values
  ('A', 'a8000000-0000-4000-8000-000000000001'),
  ('B', 'a8000000-0000-4000-8000-000000000002'),
  ('C', 'a8000000-0000-4000-8000-000000000003'),
  ('D', 'a8000000-0000-4000-8000-000000000004'),
  ('P', 'a9000000-0000-4000-8000-000000000001'),
  ('Q', 'a9000000-0000-4000-8000-000000000002'),
  ('random', 'af000000-0000-4000-8000-000000000028');

create function mu.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from mu.ids i where i.label = p_label;
$$;

create function mu.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', mu.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- The error a refused call gets.
create function mu.e(p_message text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'code', case when p_message in ('not_project_member', 'not_project_facilitator') then '42501' else 'P0001' end,
    'message', p_message
  );
$$;

-- Runs a query as the user: its rows as a jsonb array, or {code, message}.
create function mu.run(p_user text, p_sql text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
  v_state text;
  v_message text;
begin
  perform mu.become(p_user);
  execute 'select coalesce(jsonb_agg(to_jsonb(r)), ''[]''::jsonb) from (' || p_sql || ') r' into result;
  return result;
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
    return jsonb_build_object('code', v_state, 'message', v_message);
end;
$$;

-- Runs one statement as the user: 'ok' or the SQLSTATE.
create function mu.try(p_user text, p_sql text)
returns text
language plpgsql
as $$
declare
  v_state text;
begin
  perform mu.become(p_user);
  execute p_sql;
  return 'ok';
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate;
    return v_state;
end;
$$;

-- Read-back helpers, security definer so they see every row.
create function mu.row(p_upload text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.to_jsonb(u) from public.meeting_uploads u where u.id = mu.id(p_upload);
$$;

create function mu.row_md5(p_upload text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(pg_catalog.to_jsonb(u)::text) from public.meeting_uploads u where u.id = mu.id(p_upload);
$$;

create function mu.nrows(p_cycle text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.meeting_uploads u where u.cycle_id = mu.id(p_cycle);
$$;

create function mu.upload_order(p_cycle text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(u.id) order by u.created_at desc, u.id) from public.meeting_uploads u where u.cycle_id = mu.id(p_cycle);
$$;

create function mu.all_md5()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(coalesce((select string_agg(pg_catalog.to_jsonb(u)::text, '|' order by u.id) from public.meeting_uploads u), ''));
$$;

create function mu.others_md5()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(
    coalesce((select string_agg(pg_catalog.to_jsonb(fc)::text, '|' order by fc.id) from public.feedback_cycles fc), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(p)::text, '|' order by p.id) from public.projects p), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(pm)::text, '|' order by pm.project_id, pm.user_id) from public.project_members pm), '')
    || '#' || (select count(*)::text from public.cycle_events)
  );
$$;

-- create_meeting_upload as the user. On success: [kind, status, path, mime]
-- with the new row labelled p_label; otherwise the error.
create function mu.create(p_user text, p_cycle text, p_kind text, p_filename text, p_size bigint, p_text text, p_label text default null)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := mu.run(p_user, format(
    'select * from public.create_meeting_upload(%L::uuid, %L, %L, %L::bigint, %L)',
    mu.id(p_cycle), p_kind, p_filename, p_size, p_text));
begin
  if jsonb_typeof(result) = 'array' and jsonb_array_length(result) = 1 then
    if p_label is not null then
      insert into mu.ids (label, id) values (p_label, (result -> 0 ->> 'upload_id')::uuid);
    end if;
    return jsonb_build_array(result -> 0 -> 'kind', result -> 0 -> 'status', result -> 0 -> 'storage_path', result -> 0 -> 'mime_type');
  end if;
  return result;
end;
$$;

-- Just the outcome of a create: 'ok' or the error message.
create function mu.cr(p_user text, p_cycle text, p_kind text, p_filename text, p_size bigint, p_text text)
returns text
language plpgsql
as $$
declare
  result jsonb := mu.create(p_user, p_cycle, p_kind, p_filename, p_size, p_text);
begin
  if jsonb_typeof(result) = 'array' then
    return 'ok';
  end if;
  return result ->> 'message';
end;
$$;

-- The MIME type a successful create returns, or the error message.
create function mu.mime(p_user text, p_cycle text, p_kind text, p_filename text, p_size bigint)
returns text
language plpgsql
as $$
declare
  result jsonb := mu.create(p_user, p_cycle, p_kind, p_filename, p_size, null);
begin
  if jsonb_typeof(result) = 'array' then
    return result ->> 3;
  end if;
  return result ->> 'message';
end;
$$;

create function mu.complete(p_user text, p_upload text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := mu.run(p_user, format('select * from public.complete_meeting_upload(%L::uuid)', mu.id(p_upload)));
begin
  if jsonb_typeof(result) = 'array' and jsonb_array_length(result) = 1 then
    return jsonb_build_array(result -> 0 -> 'status', result -> 0 -> 'error_code', (result -> 0 ->> 'upload_id')::uuid = mu.id(p_upload));
  end if;
  return result;
end;
$$;

create function mu.list(p_user text, p_cycle text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := mu.run(p_user, format('select public.get_cycle_uploads(%L::uuid) as d', mu.id(p_cycle)));
begin
  if jsonb_typeof(result) = 'array' then
    return result -> 0 -> 'd';
  end if;
  return result;
end;
$$;

-- A helper's answer for the user and a name.
create function mu.can_upload(p_user text, p_name text)
returns boolean
language plpgsql
as $$
begin
  perform mu.become(p_user);
  return private.can_upload_meeting_object(p_name);
end;
$$;

create function mu.can_read(p_user text, p_name text)
returns boolean
language plpgsql
as $$
begin
  perform mu.become(p_user);
  return private.can_read_meeting_object(p_name);
end;
$$;

create function mu.path(p_upload text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.storage_path from public.meeting_uploads u where u.id = mu.id(p_upload);
$$;

-- A stored object for the upload's path (written as postgres).
create function mu.put(p_upload text, p_size bigint, p_mime text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into storage.objects (bucket_id, name, metadata)
  values ('meeting-media', mu.path(p_upload), pg_catalog.jsonb_build_object('size', p_size, 'mimetype', p_mime));
$$;

-- Moves an upload's created_at back by p_hours, with the guard disabled.
create function mu.age(p_upload text, p_hours integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  alter table public.meeting_uploads disable trigger meeting_uploads_guard_update;
  update public.meeting_uploads u
     set created_at = u.created_at - pg_catalog.make_interval(hours => p_hours)
   where u.id = mu.id(p_upload);
  alter table public.meeting_uploads enable trigger meeting_uploads_guard_update;
end;
$$;

create function mu.new_cycle(p_label text, p_project text, p_week date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid := gen_random_uuid();
begin
  insert into public.feedback_cycles (id, project_id, title, week_start)
  values (new_id, mu.id(p_project), p_label, p_week);
  insert into mu.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

create function mu.start(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform mu.become(p_user);
  perform 1 from public.start_retrospective(mu.id(p_cycle));
end;
$$;

create function mu.advance(p_user text, p_cycle text, p_from text)
returns void
language plpgsql
as $$
begin
  perform mu.become(p_user);
  perform 1 from public.advance_stage(mu.id(p_cycle), p_from);
end;
$$;

create function mu.mk(p_user text, p_cycle text, p_name text)
returns void
language plpgsql
as $$
begin
  perform mu.become(p_user);
  perform 1 from public.create_cluster(mu.id(p_cycle), p_name);
end;
$$;

create function mu.close_voting(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform mu.become(p_user);
  perform 1 from public.close_voting(mu.id(p_cycle));
end;
$$;

create function mu.close_cycle(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform mu.become(p_user);
  perform 1 from public.close_cycle(mu.id(p_cycle));
end;
$$;

create function mu.transfer(p_from text, p_to text)
returns void
language plpgsql
as $$
begin
  perform mu.become(p_from);
  perform public.transfer_facilitator(mu.id('P'), mu.id(p_to));
end;
$$;

-- Forces a cycle's status as postgres, with feedback_cycles' triggers off.
create function mu.force_status(p_cycle text, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  alter table public.feedback_cycles disable trigger user;
  update public.feedback_cycles fc
     set status = p_status,
         closed_at = case when p_status = 'closed' then coalesce(fc.closed_at, pg_catalog.now()) end,
         voting_closed_at = case when p_status = 'vote' then null else fc.voting_closed_at end
   where fc.id = mu.id(p_cycle);
  alter table public.feedback_cycles enable trigger user;
end;
$$;

create function mu.snap(p_label text, p_body text)
returns void
language sql
as $$
  insert into mu.snaps (label, body) values (p_label, p_body)
  on conflict (label) do update set body = excluded.body;
$$;

create function mu.snapped(p_label text)
returns text
language sql
stable
as $$
  select s.body from mu.snaps s where s.label = p_label;
$$;

grant usage on schema mu to authenticated, anon;
grant select, insert, update, delete on all tables in schema mu to authenticated;
grant execute on all functions in schema mu to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures.
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', 'a8000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'mu-a@example.com', '{"display_name":"Alice"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a8000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'mu-b@example.com', '{"display_name":"Bob"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a8000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'mu-c@example.com', '{"display_name":"Cara"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a8000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'mu-d@example.com', '{"display_name":"Dan"}', '', '', '', '');

insert into public.projects (id, name, owner_id)
values
  ('a9000000-0000-4000-8000-000000000001', 'Project P', 'a8000000-0000-4000-8000-000000000001'),
  ('a9000000-0000-4000-8000-000000000002', 'Project Q', 'a8000000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('a9000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000002', 'member'),
  ('a9000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000004', 'member');

-- ---------------------------------------------------------------------------
-- Table.
-- ---------------------------------------------------------------------------
select columns_are('public', 'meeting_uploads', array['id', 'cycle_id', 'kind', 'status', 'storage_path', 'original_filename', 'mime_type', 'size_bytes', 'pasted_text', 'error_code', 'error_message', 'provider_job_id', 'created_by', 'created_at', 'updated_at', 'uploaded_at'], 'meeting_uploads has exactly the sixteen columns');
select is(
  (select array_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable || ':' || coalesce(c.column_default, '') order by c.ordinal_position) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'meeting_uploads'),
  array[
    'id:uuid:NO:gen_random_uuid()',
    'cycle_id:uuid:NO:',
    'kind:text:NO:',
    'status:text:NO:',
    'storage_path:text:YES:',
    'original_filename:text:YES:',
    'mime_type:text:YES:',
    'size_bytes:bigint:YES:',
    'pasted_text:text:YES:',
    'error_code:text:YES:',
    'error_message:text:YES:',
    'provider_job_id:text:YES:',
    'created_by:uuid:YES:',
    'created_at:timestamp with time zone:NO:now()',
    'updated_at:timestamp with time zone:NO:now()',
    'uploaded_at:timestamp with time zone:YES:'
  ],
  'meeting_uploads column types, defaults, and not-null rules'
);
select col_is_pk('public', 'meeting_uploads', 'id', 'meeting_uploads.id is the primary key');
select is(
  (select array_agg(pg_get_constraintdef(c.oid) order by c.conname) from pg_constraint c where c.conrelid = 'public.meeting_uploads'::regclass and c.contype in ('f', 'u')),
  array[
    'FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL',
    'FOREIGN KEY (cycle_id) REFERENCES feedback_cycles(id) ON DELETE CASCADE',
    'UNIQUE (storage_path)'
  ],
  'cycle_id cascades, created_by is set null, and storage_path is unique'
);
select is(
  (select array_agg(pg_get_indexdef(i.indexrelid) order by pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid = 'public.meeting_uploads'::regclass and not i.indisprimary and not i.indisunique),
  array['CREATE INDEX meeting_uploads_cycle_id_created_at_idx ON public.meeting_uploads USING btree (cycle_id, created_at)'],
  'meeting_uploads has the (cycle_id, created_at) index'
);
select trigger_is('public', 'meeting_uploads', 'meeting_uploads_guard_update', 'private', 'guard_meeting_upload_update', 'the guard trigger exists');
select trigger_is('public', 'meeting_uploads', 'meeting_uploads_set_updated_at', 'private', 'set_updated_at', 'updated_at reuses private.set_updated_at');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.meeting_uploads'::regclass and tgname = 'meeting_uploads_guard_update'), 19, 'the guard is BEFORE UPDATE FOR EACH ROW');

-- Default-deny.
select is((select relrowsecurity from pg_class where oid = 'public.meeting_uploads'::regclass), true, 'RLS is enabled on meeting_uploads');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'meeting_uploads'), 0, 'meeting_uploads has no policy');
select is(
  (select array_agg(r || ':' || p order by r, p) from unnest(array['anon', 'authenticated', 'service_role']) r cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege(r, 'public.meeting_uploads', p)),
  array['service_role:DELETE', 'service_role:INSERT', 'service_role:SELECT', 'service_role:UPDATE'],
  'anon and authenticated hold no privilege; service_role holds exactly SELECT, INSERT, UPDATE, DELETE'
);
select is((select count(*)::int from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name = 'meeting_uploads' and g.grantee = 'PUBLIC'), 0, 'PUBLIC has no privilege on meeting_uploads');
select is(
  (select array_agg(schemaname || '.' || tablename order by schemaname, tablename) from pg_publication_tables where pubname = 'supabase_realtime'),
  array['public.cycle_events'],
  'supabase_realtime still publishes only cycle_events'
);
select is((select count(*)::int from pg_depend d join pg_rewrite rw on rw.oid = d.objid where d.refobjid = 'public.meeting_uploads'::regclass and rw.ev_class <> 'public.meeting_uploads'::regclass), 0, 'no view depends on meeting_uploads');

-- Every CHECK refuses a bad row inserted as postgres.
select mu.new_cycle('P1', 'P', '2026-09-14');

create function mu.bad(p_kind text, p_status text, p_path text, p_name text, p_mime text, p_size bigint, p_text text, p_code text, p_uploaded timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_constraint text;
begin
  insert into public.meeting_uploads (cycle_id, kind, status, storage_path, original_filename, mime_type, size_bytes, pasted_text, error_code, uploaded_at)
  values (mu.id('P1'), p_kind, p_status, p_path, p_name, p_mime, p_size, p_text, p_code, p_uploaded);
  return 'ok';
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name;
    return v_state || ':' || coalesce(v_constraint, '');
end;
$$;

select is(mu.bad('audio', 'uploaded', 'x/ok-a.mp3', 'a.mp3', 'audio/mpeg', 1, null, null, now()), 'ok', 'a valid audio row is accepted (the baseline)');
select is(mu.bad('transcript_text', 'uploaded', null, null, null, null, 'hi', null, now()), 'ok', 'a valid text row is accepted (the baseline)');
select is(mu.bad('slides', 'uploaded', 'x/1.mp3', 'a.mp3', 'audio/mpeg', 1, null, null, now()), '23514:meeting_uploads_kind_check', 'an unknown kind is refused');
select is(mu.bad('audio', 'lost', 'x/2.mp3', 'a.mp3', 'audio/mpeg', 1, null, null, now()), '23514:meeting_uploads_status_check', 'an unknown status is refused');
select is(mu.bad('audio', 'uploaded', null, 'a.mp3', 'audio/mpeg', 1, null, null, now()), '23514:meeting_uploads_fields_check', 'a file kind without storage_path is refused');
select is(mu.bad('audio', 'uploaded', 'x/3.mp3', null, 'audio/mpeg', 1, null, null, now()), '23514:meeting_uploads_fields_check', 'a file kind without original_filename is refused');
select is(mu.bad('audio', 'uploaded', 'x/4.mp3', 'a.mp3', null, 1, null, null, now()), '23514:meeting_uploads_fields_check', 'a file kind without mime_type is refused');
select is(mu.bad('audio', 'uploaded', 'x/5.mp3', 'a.mp3', 'audio/mpeg', null, null, null, now()), '23514:meeting_uploads_fields_check', 'a file kind without size_bytes is refused');
select is(mu.bad('audio', 'uploaded', 'x/6.mp3', 'a.mp3', 'audio/mpeg', 1, 'text', null, now()), '23514:meeting_uploads_fields_check', 'a file kind with pasted_text is refused');
select is(mu.bad('transcript_text', 'uploaded', 'x/7.txt', 'a.txt', 'text/plain', 1, 'text', null, now()), '23514:meeting_uploads_fields_check', 'text with file fields is refused');
select is(mu.bad('transcript_text', 'pending_upload', null, null, null, null, 'text', null, null), '23514:meeting_uploads_fields_check', 'transcript_text in pending_upload is refused');
select is(mu.bad('audio', 'uploaded', 'x/8.mp3', 'a.mp3', 'audio/mpeg', 0, null, null, now()), '23514:meeting_uploads_size_check', 'size 0 is refused');
select is(mu.bad('video', 'uploaded', 'x/9.mp4', 'a.mp4', 'video/mp4', 209715201, null, null, now()), '23514:meeting_uploads_size_check', 'video one byte over 200 MiB is refused');
select is(mu.bad('video', 'uploaded', 'x/9b.mp4', 'a.mp4', 'video/mp4', 209715200, null, null, now()), 'ok', 'video at exactly 200 MiB is accepted');
select is(mu.bad('transcript_file', 'uploaded', 'x/10.txt', 'a.txt', 'text/plain', 10485761, null, null, now()), '23514:meeting_uploads_size_check', 'a transcript file one byte over 10 MiB is refused');
select is(mu.bad('audio', 'uploaded', 'x/11.mp4', 'a.mp4', 'video/mp4', 1, null, null, now()), '23514:meeting_uploads_mime_type_check', 'a MIME type not paired with its kind is refused');
select is(mu.bad('transcript_text', 'uploaded', null, null, null, null, '', null, now()), '23514:meeting_uploads_pasted_text_check', 'empty text is refused');
select is(mu.bad('transcript_text', 'uploaded', null, null, null, null, E' \n\t ', null, now()), '23514:meeting_uploads_pasted_text_check', 'whitespace-only text is refused');
select is(mu.bad('transcript_text', 'uploaded', null, null, null, null, repeat('a', 200001), null, now()), '23514:meeting_uploads_pasted_text_check', '200,001 characters of text are refused');
select is(mu.bad('audio', 'uploaded', 'x/12.mp3', repeat('a', 252) || '.mp3', 'audio/mpeg', 1, null, null, now()), '23514:meeting_uploads_original_filename_check', 'a 256-character name is refused');
select is(mu.bad('audio', 'rejected', 'x/13.mp3', 'a.mp3', 'audio/mpeg', 1, null, 'Bad-Code', null), '23514:meeting_uploads_error_code_check', 'a bad error_code is refused');
select is(mu.bad('audio', 'pending_upload', 'x/14.mp3', 'a.mp3', 'audio/mpeg', 1, null, null, now()), '23514:meeting_uploads_uploaded_at_check', 'uploaded_at set in pending_upload is refused');
select is(mu.bad('audio', 'uploaded', 'x/15.mp3', 'a.mp3', 'audio/mpeg', 1, null, null, null), '23514:meeting_uploads_uploaded_at_check', 'uploaded_at missing in uploaded is refused');

-- Guard trigger, on rows written as postgres.
insert into mu.ids (label, id) values ('g1', gen_random_uuid()), ('g2', gen_random_uuid()), ('g3', gen_random_uuid()), ('g4', gen_random_uuid()), ('g5', gen_random_uuid());
insert into public.meeting_uploads (id, cycle_id, kind, status, storage_path, original_filename, mime_type, size_bytes, created_by, uploaded_at)
values
  (mu.id('g1'), mu.id('P1'), 'audio', 'pending_upload', 'g/1.mp3', 'a.mp3', 'audio/mpeg', 5, mu.id('A'), null),
  (mu.id('g2'), mu.id('P1'), 'audio', 'pending_upload', 'g/2.mp3', 'a.mp3', 'audio/mpeg', 5, mu.id('A'), null),
  (mu.id('g3'), mu.id('P1'), 'audio', 'uploaded', 'g/3.mp3', 'a.mp3', 'audio/mpeg', 5, mu.id('A'), now()),
  (mu.id('g4'), mu.id('P1'), 'audio', 'rejected', 'g/4.mp3', 'a.mp3', 'audio/mpeg', 5, mu.id('A'), null),
  (mu.id('g5'), mu.id('P1'), 'audio', 'pending_upload', 'g/5.mp3', 'a.mp3', 'audio/mpeg', 5, mu.id('A'), null);

select throws_ok(format('update public.meeting_uploads set id = gen_random_uuid() where id = %L', mu.id('g1')), 'P0001', 'meeting_upload_immutable_column', 'id is immutable');
select throws_ok(format('update public.meeting_uploads set kind = %L where id = %L', 'video', mu.id('g1')), 'P0001', 'meeting_upload_immutable_column', 'kind is immutable');
select throws_ok(format('update public.meeting_uploads set storage_path = %L where id = %L', 'g/x.mp3', mu.id('g1')), 'P0001', 'meeting_upload_immutable_column', 'storage_path is immutable');
select throws_ok(format('update public.meeting_uploads set original_filename = %L where id = %L', 'b.mp3', mu.id('g1')), 'P0001', 'meeting_upload_immutable_column', 'original_filename is immutable');
select throws_ok(format('update public.meeting_uploads set mime_type = %L where id = %L', 'audio/wav', mu.id('g1')), 'P0001', 'meeting_upload_immutable_column', 'mime_type is immutable');
select throws_ok(format('update public.meeting_uploads set size_bytes = 6 where id = %L', mu.id('g1')), 'P0001', 'meeting_upload_immutable_column', 'size_bytes is immutable');
select throws_ok(format('update public.meeting_uploads set created_at = now() - interval ''1 day'' where id = %L', mu.id('g1')), 'P0001', 'meeting_upload_immutable_column', 'created_at is immutable');
select throws_ok(format('update public.meeting_uploads set created_by = %L where id = %L', mu.id('B'), mu.id('g1')), 'P0001', 'meeting_upload_immutable_column', 'created_by cannot change to another user');
select throws_ok(format('update public.meeting_uploads set cycle_id = gen_random_uuid() where id = %L', mu.id('g1')), 'P0001', 'meeting_upload_immutable_column', 'cycle_id is immutable');
select lives_ok(format('update public.meeting_uploads set created_by = null where id = %L', mu.id('g1')), 'created_by may become null');
select throws_ok(format('update public.meeting_uploads set pasted_text = %L where id = %L', 'x', mu.id('g1')), 'P0001', 'meeting_upload_immutable_column', 'pasted_text is immutable');
select throws_ok(format('update public.meeting_uploads set status = %L, uploaded_at = now() where id = %L', 'transcribing', mu.id('g1')), 'P0001', 'invalid_meeting_upload_transition', 'pending_upload -> transcribing is refused');
select throws_ok(format('update public.meeting_uploads set status = %L, uploaded_at = null where id = %L', 'pending_upload', mu.id('g3')), 'P0001', 'invalid_meeting_upload_transition', 'uploaded -> pending_upload is refused');
select throws_ok(format('update public.meeting_uploads set status = %L, uploaded_at = now() where id = %L', 'uploaded', mu.id('g4')), 'P0001', 'invalid_meeting_upload_transition', 'rejected -> uploaded is refused');
select lives_ok(format('update public.meeting_uploads set status = %L, uploaded_at = now() where id = %L', 'uploaded', mu.id('g1')), 'pending_upload -> uploaded passes');
select lives_ok(format('update public.meeting_uploads set status = %L where id = %L', 'rejected', mu.id('g2')), 'pending_upload -> rejected passes');
select lives_ok(format('update public.meeting_uploads set status = %L where id = %L', 'transcribing', mu.id('g3')), 'uploaded -> transcribing passes');

-- Clean the structure rows out of P1 before the RPC cases.
delete from public.meeting_uploads where cycle_id = mu.id('P1');

-- ---------------------------------------------------------------------------
-- Bucket and policies.
-- ---------------------------------------------------------------------------
select is(
  (select jsonb_build_object('public', b.public, 'limit', b.file_size_limit) from storage.buckets b where b.id = 'meeting-media' and b.name = 'meeting-media'),
  '{"public": false, "limit": 209715200}'::jsonb,
  'meeting-media is private with a 209715200-byte limit'
);
select is(
  (select array_agg(t order by t) from storage.buckets b cross join unnest(b.allowed_mime_types) t where b.id = 'meeting-media'),
  (select array_agg(t order by t) from unnest(array['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm', 'video/mp4', 'video/quicktime', 'video/webm', 'text/plain', 'text/vtt', 'application/x-subrip']) t),
  'allowed_mime_types is exactly the 11 canonical types'
);
select is((select cardinality(b.allowed_mime_types) from storage.buckets b where b.id = 'meeting-media'), 11, 'allowed_mime_types has no duplicate');
select is(
  (select array_agg(p.policyname || ':' || p.cmd || ':' || p.roles::text order by p.policyname) from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects' and (coalesce(p.qual, '') || coalesce(p.with_check, '')) like '%meeting-media%'),
  array['meeting_media_insert_facilitator:INSERT:{authenticated}', 'meeting_media_select_facilitator:SELECT:{authenticated}'],
  'storage.objects has exactly the insert and select policies for meeting-media'
);
select is((select count(*)::int from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects' and p.cmd in ('UPDATE', 'DELETE', 'ALL') and (coalesce(p.qual, '') || coalesce(p.with_check, '')) like '%meeting-media%'), 0, 'no UPDATE, DELETE or ALL policy mentions meeting-media');
select is((select p.with_check from pg_policies p where p.schemaname = 'storage' and p.policyname = 'meeting_media_insert_facilitator'), '((bucket_id = ''meeting-media''::text) AND private.can_upload_meeting_object(name))', 'the insert policy checks the bucket and can_upload_meeting_object(name)');
select is((select p.qual from pg_policies p where p.schemaname = 'storage' and p.policyname = 'meeting_media_select_facilitator'), '((bucket_id = ''meeting-media''::text) AND private.can_read_meeting_object(name))', 'the select policy checks the bucket and can_read_meeting_object(name)');

-- Helpers' hardening.
select is(
  (select p.prosecdef and p.proconfig = array['search_path=""']::text[] and p.provolatile = 's' from pg_proc p where p.oid = f),
  true,
  f::text || ' is stable security definer with search_path fixed to empty'
) from unnest(array['private.can_upload_meeting_object(text)'::regprocedure, 'private.can_read_meeting_object(text)'::regprocedure]) f;
select is(
  array[
    has_function_privilege('authenticated', f, 'EXECUTE'),
    has_function_privilege('anon', f, 'EXECUTE'),
    has_function_privilege('service_role', f, 'EXECUTE'),
    (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = f)
  ],
  array[true, false, false, false],
  f::text || ' is executable by authenticated only'
) from unnest(array['private.can_upload_meeting_object(text)'::regprocedure, 'private.can_read_meeting_object(text)'::regprocedure]) f;
select is(
  array[
    has_function_privilege('authenticated', 'private.guard_meeting_upload_update()'::regprocedure, 'EXECUTE'),
    has_function_privilege('anon', 'private.guard_meeting_upload_update()'::regprocedure, 'EXECUTE'),
    has_function_privilege('service_role', 'private.guard_meeting_upload_update()'::regprocedure, 'EXECUTE')
  ],
  array[false, false, false],
  'the guard function is not executable by any client role'
);
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  array['can_read_meeting_object', 'can_upload_meeting_object', 'is_project_facilitator', 'is_project_member'],
  'authenticated can execute exactly four private functions'
);
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.prosrc ~ 'public\.meeting_uploads'),
  array['can_read_meeting_object', 'can_upload_meeting_object', 'complete_meeting_upload', 'create_meeting_upload', 'get_cycle_uploads'],
  'only the three RPCs and the two helpers read meeting_uploads'
);

-- ---------------------------------------------------------------------------
-- RPC hardening.
-- ---------------------------------------------------------------------------
create table mu.rpcs (name text primary key, fn regprocedure, sig text, vol "char", codes text[]);
insert into mu.rpcs (name, fn, sig, vol, codes)
values
  ('create_meeting_upload', 'public.create_meeting_upload(uuid, text, text, bigint, text)',
   'p_cycle_id uuid, p_kind text, p_filename text, p_size_bytes bigint, p_pasted_text text -> TABLE(upload_id uuid, kind text, status text, storage_path text, mime_type text)', 'v',
   array['cycle_not_discussing', 'invalid_transcript_text', 'invalid_upload_file', 'invalid_upload_kind', 'not_project_facilitator', 'not_project_member', 'upload_limit_reached', 'upload_too_large']),
  ('complete_meeting_upload', 'public.complete_meeting_upload(uuid)',
   'p_upload_id uuid -> TABLE(upload_id uuid, status text, error_code text)', 'v',
   array['cycle_not_discussing', 'not_project_facilitator', 'not_project_member', 'upload_file_missing', 'upload_not_found']),
  ('get_cycle_uploads', 'public.get_cycle_uploads(uuid)', 'p_cycle_id uuid -> jsonb', 's',
   array['not_project_facilitator', 'not_project_member']);

select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = r.name), 1, r.name || ' has exactly one overload') from mu.rpcs r order by r.name;
select is(pg_get_function_identity_arguments(r.fn) || ' -> ' || pg_get_function_result(r.fn), r.sig, r.name || ' has the agreed signature') from mu.rpcs r order by r.name;
select is((select p.prosecdef and p.proconfig = array['search_path=""']::text[] and p.provolatile = r.vol from pg_proc p where p.oid = r.fn), true, r.name || ' is security definer with search_path fixed to empty and the agreed volatility') from mu.rpcs r order by r.name;
select is(
  array[
    has_function_privilege('authenticated', r.fn, 'EXECUTE'),
    has_function_privilege('anon', r.fn, 'EXECUTE'),
    has_function_privilege('service_role', r.fn, 'EXECUTE'),
    (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = r.fn)
  ],
  array[true, false, false, false],
  r.name || ' is executable by authenticated only'
) from mu.rpcs r order by r.name;
select is(
  (select (select count(*)::int from regexp_matches(p.prosrc, '\mraise\M', 'gi'))
          = (select count(*)::int from regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''[a-z_]+'';', 'g'))
     from pg_proc p where p.oid = r.fn),
  true,
  r.name || ': every raise has the pinned form'
) from mu.rpcs r order by r.name;
select is(
  (select array_agg(distinct m[2] order by m[2]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = r.fn),
  r.codes,
  r.name || ' raises exactly its codes'
) from mu.rpcs r order by r.name;
select is(
  (select bool_and((m[1] = '42501') = (m[2] in ('not_project_member', 'not_project_facilitator'))) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = r.fn),
  true,
  r.name || ' uses 42501 for the access codes and P0001 for the rest'
) from mu.rpcs r order by r.name;
select is((select p.prosrc ~* '(execute|raise\s+notice|detail|hint)' from pg_proc p where p.oid = r.fn), false, r.name || ' has no execute, raise notice, detail or hint') from mu.rpcs r order by r.name;
select is((select p.prosrc ~* '(cycle_events|projects\.owner_id|p\.owner_id)' from pg_proc p where p.oid = r.fn), false, r.name || ' never mentions cycle_events or projects.owner_id') from mu.rpcs r order by r.name;
select is(
  (select regexp_instr(p.prosrc, 'from public\.projects p where p\.id = cycle_project for share') between 1 and regexp_instr(p.prosrc, 'not private\.is_project_facilitator')
      and regexp_instr(p.prosrc, 'not private\.is_project_facilitator') < regexp_instr(p.prosrc, 'for update')
      and regexp_instr(p.prosrc, 'for update') < regexp_instr(p.prosrc, 'cycle_not_discussing')
     from pg_proc p where p.oid = r.fn),
  true,
  r.name || ' locks projects FOR SHARE, checks the facilitator, then locks the cycle before the stage check'
) from mu.rpcs r where r.name <> 'get_cycle_uploads' order by r.name;
select is((select count(*)::int from pg_proc p, regexp_matches(p.prosrc, 'for (update|share)', 'gi') where p.oid = 'public.get_cycle_uploads(uuid)'::regprocedure), 0, 'get_cycle_uploads takes no lock');

-- ---------------------------------------------------------------------------
-- Q1: C's cycle in discuss with C's pending upload QU.
-- ---------------------------------------------------------------------------
set local role authenticated;
select mu.new_cycle('Q1', 'Q', '2026-09-07');
select mu.start('C', 'Q1');
select mu.advance('C', 'Q1', 'reveal');
select mu.mk('C', 'Q1', 'QX');
select mu.advance('C', 'Q1', 'cluster');
select mu.close_voting('C', 'Q1');
select is(mu.create('C', 'Q1', 'audio', 'q.mp3', 16, null, 'QU') ->> 1, 'pending_upload', 'C registers an upload in Q1');
reset role;
select mu.put('QU', 16, 'audio/mpeg');

-- ---------------------------------------------------------------------------
-- P1 through the stages: create is refused before discuss.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(mu.cr('A', 'P1', 'audio', 'a.mp3', 16, null), 'cycle_not_discussing', 'collecting: A gets cycle_not_discussing');
select mu.start('A', 'P1');
select is(mu.cr('A', 'P1', 'audio', 'a.mp3', 16, null), 'cycle_not_discussing', 'reveal: A gets cycle_not_discussing');
select mu.advance('A', 'P1', 'reveal');
select is(mu.cr('A', 'P1', 'audio', 'a.mp3', 16, null), 'cycle_not_discussing', 'cluster: A gets cycle_not_discussing');
select mu.mk('A', 'P1', 'X');
select mu.advance('A', 'P1', 'cluster');
select is(mu.cr('A', 'P1', 'audio', 'a.mp3', 16, null), 'cycle_not_discussing', 'vote: A gets cycle_not_discussing');
select is(mu.list('A', 'P1'), jsonb_build_object('cycle_id', mu.id('P1'), 'uploads', '[]'::jsonb), 'listing works before discuss (empty)');
select mu.close_voting('A', 'P1');
select is(mu.nrows('P1'), 0, 'no row was written before discuss');

-- Access.
select is(mu.create('C', 'P1', 'audio', 'a.mp3', 16, null), mu.e('not_project_member'), 'C (non-member) gets not_project_member');
select is(mu.create(null, 'P1', 'audio', 'a.mp3', 16, null), mu.e('not_project_member'), 'a null user gets not_project_member');
select is(mu.create('A', null, 'audio', 'a.mp3', 16, null), mu.e('not_project_member'), 'a null cycle gets not_project_member');
select is(mu.create('A', 'random', 'audio', 'a.mp3', 16, null), mu.e('not_project_member'), 'a random cycle gets not_project_member');
select is(mu.create('B', 'P1', 'audio', 'a.mp3', 16, null), mu.e('not_project_facilitator'), 'member B gets not_project_facilitator');
select is(mu.create('D', 'P1', 'audio', 'a.mp3', 16, null), mu.e('not_project_facilitator'), 'member D gets not_project_facilitator');

-- Validation: each refused with exactly its code, no row written.
select mu.snap('before-validation', mu.all_md5());
select is(mu.cr('A', 'P1', null, 'a.mp3', 16, null), 'invalid_upload_kind', 'a null kind is invalid_upload_kind');
select is(mu.cr('A', 'P1', 'slides', 'a.mp3', 16, null), 'invalid_upload_kind', 'an unknown kind is invalid_upload_kind');
select is(mu.cr('A', 'P1', 'Audio', 'a.mp3', 16, null), 'invalid_upload_kind', 'a kind in another case is invalid_upload_kind');
select is(mu.cr('A', 'P1', 'audio', 'a.mp4', 16, null), 'invalid_upload_file', 'mp4 as audio is refused');
select is(mu.cr('A', 'P1', 'video', 'a.wav', 16, null), 'invalid_upload_file', 'wav as video is refused');
select is(mu.cr('A', 'P1', 'transcript_file', 'a.pdf', 16, null), 'invalid_upload_file', 'pdf is refused');
select is(mu.cr('A', 'P1', 'audio', '.mp3', 16, null), 'invalid_upload_file', '.mp3 (no base name) is refused');
select is(mu.cr('A', 'P1', 'audio', 'notes.', 16, null), 'invalid_upload_file', 'notes. (no extension) is refused');
select is(mu.cr('A', 'P1', 'audio', 'README', 16, null), 'invalid_upload_file', 'README (no dot) is refused');
select is(mu.cr('A', 'P1', 'audio', 'a/b.mp3', 16, null), 'invalid_upload_file', 'a slash is refused');
select is(mu.cr('A', 'P1', 'audio', 'a\b.mp3', 16, null), 'invalid_upload_file', 'a backslash is refused');
select is(mu.cr('A', 'P1', 'audio', '../a.mp3', 16, null), 'invalid_upload_file', '../a.mp3 is refused');
select is(mu.cr('A', 'P1', 'audio', 'a' || chr(1) || '.mp3', 16, null), 'invalid_upload_file', 'U+0001 is refused');
select is(mu.cr('A', 'P1', 'audio', 'a' || chr(127) || '.mp3', 16, null), 'invalid_upload_file', 'U+007F is refused');
select is(mu.cr('A', 'P1', 'audio', 'a' || chr(133) || '.mp3', 16, null), 'invalid_upload_file', 'U+0085 is refused');
select is(mu.cr('A', 'P1', 'audio', 'a' || chr(8238) || '3pm.mp3', 16, null), 'invalid_upload_file', 'U+202E is refused');
select is(mu.cr('A', 'P1', 'audio', 'a' || chr(8294) || '.mp3', 16, null), 'invalid_upload_file', 'U+2066 is refused');
select is(mu.cr('A', 'P1', 'audio', repeat('a', 252) || '.mp3', 16, null), 'invalid_upload_file', 'a 256-character name is refused');
select is(mu.cr('A', 'P1', 'audio', null, 16, null), 'invalid_upload_file', 'a null name is refused');
select is(mu.cr('A', 'P1', 'audio', '   ', 16, null), 'invalid_upload_file', 'a blank name is refused');
select is(mu.cr('A', 'P1', 'audio', 'a.mp3', null, null), 'invalid_upload_file', 'a null size is refused');
select is(mu.cr('A', 'P1', 'audio', 'a.mp3', 0, null), 'invalid_upload_file', 'size 0 is refused');
select is(mu.cr('A', 'P1', 'audio', 'a.mp3', -1, null), 'invalid_upload_file', 'size -1 is refused');
select is(mu.cr('A', 'P1', 'audio', 'a.mp3', 209715201, null), 'upload_too_large', 'audio at 209,715,201 bytes is upload_too_large');
select is(mu.cr('A', 'P1', 'video', 'a.mp4', 209715201, null), 'upload_too_large', 'video at 209,715,201 bytes is upload_too_large');
select is(mu.cr('A', 'P1', 'transcript_file', 'a.txt', 10485761, null), 'upload_too_large', 'a transcript file at 10,485,761 bytes is upload_too_large');
select is(mu.cr('A', 'P1', 'audio', 'a.mp3', 16, 'text'), 'invalid_transcript_text', 'text with a file kind is invalid_transcript_text');
select is(mu.cr('A', 'P1', 'transcript_text', 'a.txt', null, 'text'), 'invalid_upload_file', 'a file name with transcript_text is invalid_upload_file');
select is(mu.cr('A', 'P1', 'transcript_text', null, 16, 'text'), 'invalid_upload_file', 'a size with transcript_text is invalid_upload_file');
select is(mu.cr('A', 'P1', 'transcript_text', null, null, null), 'invalid_transcript_text', 'null text is refused');
select is(mu.cr('A', 'P1', 'transcript_text', null, null, ''), 'invalid_transcript_text', 'empty text is refused');
select is(mu.cr('A', 'P1', 'transcript_text', null, null, E'  \n\t '), 'invalid_transcript_text', 'whitespace and line breaks only are refused');
select is(mu.cr('A', 'P1', 'transcript_text', null, null, repeat('a', 200001)), 'invalid_transcript_text', '200,001 characters are refused');
select is(mu.all_md5(), mu.snapped('before-validation'), 'no refused create wrote a row');

-- Every allowed extension, with its canonical MIME type.
select is(mu.mime('A', 'P1', k, 'f.' || e, 1), m, k || ' .' || e || ' -> ' || m)
  from (values
    ('audio', 'mp3', 'audio/mpeg'), ('audio', 'm4a', 'audio/mp4'), ('audio', 'wav', 'audio/wav'), ('audio', 'ogg', 'audio/ogg'), ('audio', 'webm', 'audio/webm'),
    ('video', 'mp4', 'video/mp4'), ('video', 'mov', 'video/quicktime'), ('video', 'webm', 'video/webm'),
    ('transcript_file', 'txt', 'text/plain'), ('transcript_file', 'vtt', 'text/vtt'), ('transcript_file', 'srt', 'application/x-subrip')
  ) t(k, e, m);
select is(mu.nrows('P1'), 11, 'the eleven allowed files made eleven rows');
-- These fill the active slots used later; clear them as postgres.
reset role;
delete from public.meeting_uploads where cycle_id = mu.id('P1');
set local role authenticated;

-- Result.
select is(
  mu.create('A', 'P1', 'audio', '  Standup.MP3 ', 16, null, 'U1') - 2,
  '["audio", "pending_upload", "audio/mpeg"]'::jsonb,
  'upper-case MP3 registers as audio/mpeg in pending_upload'
);
select is(mu.path('U1'), mu.id('P') || '/' || mu.id('P1') || '/' || mu.id('U1') || '.mp3', 'storage_path is {project_id}/{cycle_id}/{upload_id}.mp3');
select is(mu.path('U1') ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.mp3$', true, 'the path is lowercase and holds no part of the file name');
select is(
  (select jsonb_build_object('created_by', r ->> 'created_by', 'uploaded_at', r -> 'uploaded_at', 'name', r ->> 'original_filename', 'size', r -> 'size_bytes') from mu.row('U1') r),
  jsonb_build_object('created_by', mu.id('A')::text, 'uploaded_at', null, 'name', 'Standup.MP3', 'size', 16),
  'the stored row has created_by A, no uploaded_at, and the trimmed name'
);
select is(mu.create('A', 'P1', 'video', 'talk.txt.mp4', 16, null) ->> 3, 'video/mp4', 'talk.txt.mp4 is a video (the last dot decides)');
select is(mu.create('A', 'P1', 'audio', 'talk.txt.mp3', 16, null) ->> 3, 'audio/mpeg', 'talk.txt.mp3 is audio');
select is(mu.create('A', 'P1', 'audio', 'Standup.MP3', 16, null, 'U1b') ->> 1, 'pending_upload', 'the same file registers again');
select isnt(mu.path('U1b'), mu.path('U1'), 'two registrations of the same file get different paths');
select is(mu.create('A', 'P1', 'audio', repeat('a', 251) || '.mp3', 209715200, null) ->> 1, 'pending_upload', 'a 255-character name at exactly 200 MiB passes');
select is(mu.create('A', 'P1', 'transcript_file', 'a.srt', 10485760, null) ->> 3, 'application/x-subrip', 'a transcript file at exactly 10 MiB passes');
select is(mu.create('A', 'P1', 'video', 'v.webm', 209715200, null) ->> 3, 'video/webm', 'webm as video at exactly 200 MiB passes');

-- Text, with 200,000 multi-byte characters.
select is(
  mu.create('A', 'P1', 'transcript_text', null, null, repeat('é😀', 100000), 'T1'),
  '["transcript_text", "uploaded", null, null]'::jsonb,
  '200,000 multi-byte characters register as uploaded with no path or MIME type'
);
select is((select r ->> 'pasted_text' = repeat('é😀', 100000) and r ->> 'uploaded_at' is not null from mu.row('T1') r), true, 'the text is stored unchanged with uploaded_at set');
select is(mu.create('A', 'P1', 'transcript_text', null, null, E'  Line one\n\n  ', 'T2') ->> 1, 'uploaded', 'text is stored as given, surrounding space included');
select is((select r ->> 'pasted_text' from mu.row('T2') r), E'  Line one\n\n  ', 'the text keeps its surrounding space');

-- No side effects.
select mu.snap('others', mu.others_md5());
select is(mu.create('A', 'P1', 'audio', 'side.mp3', 16, null, 'S1') ->> 1, 'pending_upload', 'one more create');
select is(mu.others_md5(), mu.snapped('others'), 'create writes no cycle_events row and changes no cycle, project or member');
select mu.snap('all', mu.all_md5() || mu.others_md5());
select is(mu.list('A', 'P1') ->> 'cycle_id', mu.id('P1')::text, 'A lists P1');
select is(mu.all_md5() || mu.others_md5(), mu.snapped('all'), 'get_cycle_uploads changes nothing');
reset role;

-- ---------------------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------------------
select mu.put('U1b', 16, 'audio/mpeg');
set local role authenticated;
select is(mu.can_upload('A', mu.path('U1')), true, 'can_upload: A on a fresh pending path in discuss');
select is(mu.can_upload('B', mu.path('U1')), false, 'can_upload: false for member B');
select is(mu.can_upload('C', mu.path('U1')), false, 'can_upload: false for non-member C');
select is(mu.can_upload(null, mu.path('U1')), false, 'can_upload: false for a null user');
select is(mu.can_upload('A', null), false, 'can_upload: false for a null name');
select is(mu.can_upload('A', mu.id('P') || '/' || mu.id('P1') || '/' || mu.id('random') || '.mp3'), false, 'can_upload: false for an unregistered path');
select is(mu.can_upload('A', '../' || mu.path('U1')), false, 'can_upload: false for a ../-prefixed path');
select is(mu.can_upload('A', mu.path('U1') || '/../x.mp3'), false, 'can_upload: false for path/../x.mp3');
select is(mu.can_upload('A', upper(mu.path('U1'))), false, 'can_upload: false for the upper-cased path');
select is(mu.can_upload('A', regexp_replace(mu.path('U1'), 'mp3$', 'MP3')), false, 'can_upload: false for an upper-case extension');
select is(mu.can_upload('A', mu.path('U1') || '/'), false, 'can_upload: false for a trailing slash');
select is(mu.can_upload('C', mu.path('QU')), true, 'can_upload: C on Q''s pending path');
select is(mu.can_upload('A', mu.path('QU')), false, 'can_upload: false for A on Q''s path');
select is(mu.can_read('A', mu.path('U1')), true, 'can_read: A on a registered path');
select is(mu.can_read('B', mu.path('U1')), false, 'can_read: false for member B');
select is(mu.can_read('C', mu.path('U1')), false, 'can_read: false for non-member C');
select is(mu.can_read(null, mu.path('U1')), false, 'can_read: false for a null user');
select is(mu.can_read('A', null), false, 'can_read: false for a null name');
select is(mu.can_read('A', mu.id('P') || '/' || mu.id('P1') || '/' || mu.id('random') || '.mp3'), false, 'can_read: false for an unregistered path');
select is(mu.can_read('A', mu.path('QU')), false, 'can_read: false for A on Q''s path');

-- Storage policy behaviour: inserts and selects on storage.objects as the
-- caller (authenticated, with JWT claims), on PI, a fresh pending upload.
select is(mu.create('A', 'P1', 'audio', 'policy.mp3', 16, null, 'PI') ->> 1, 'pending_upload', 'register PI');
select is(mu.try('B', format('insert into storage.objects (bucket_id, name, metadata) values (%L, %L, %L)', 'meeting-media', mu.path('PI'), '{"size": 16, "mimetype": "audio/mpeg"}')), '42501', 'policy: B cannot insert the registered pending path');
select is(mu.try('C', format('insert into storage.objects (bucket_id, name, metadata) values (%L, %L, %L)', 'meeting-media', mu.path('PI'), '{"size": 16, "mimetype": "audio/mpeg"}')), '42501', 'policy: C cannot insert it');
select is(mu.try('A', format('insert into storage.objects (bucket_id, name, metadata) values (%L, %L, %L)', 'meeting-media', mu.id('P') || '/' || mu.id('P1') || '/' || mu.id('random') || '.mp3', '{}')), '42501', 'policy: A cannot insert an unregistered path');
select is(mu.try('A', format('insert into storage.objects (bucket_id, name, metadata) values (%L, %L, %L)', 'meeting-media', mu.path('PI'), '{"size": 16, "mimetype": "audio/mpeg"}')), 'ok', 'policy: A inserts the registered pending path');
select is(mu.try('A', format('update storage.objects set metadata = %L where bucket_id = %L', '{}', 'meeting-media')), 'ok', 'policy: an update statement runs');
select is(mu.run('A', 'select o.metadata from storage.objects o where o.bucket_id = ''meeting-media'' and o.name = ' || quote_literal(mu.path('PI'))), '[{"metadata": {"size": 16, "mimetype": "audio/mpeg"}}]'::jsonb, 'policy: with no UPDATE policy the update changed nothing');
select is(mu.try('A', format('delete from storage.objects where bucket_id = %L', 'meeting-media')), '42501', 'policy: a delete is refused');
select is(
  mu.run('A', 'select o.name from storage.objects o where o.bucket_id = ''meeting-media'' order by o.name'),
  (select jsonb_agg(jsonb_build_object('name', n) order by n) from unnest(array[mu.path('PI'), mu.path('U1b')]) n),
  'policy: A sees exactly P''s objects (none of Q''s), and the delete removed nothing'
);
select is(mu.run('B', 'select o.name from storage.objects o where o.bucket_id = ''meeting-media'''), '[]'::jsonb, 'policy: B sees no object');
select is(mu.run('C', 'select o.name from storage.objects o where o.bucket_id = ''meeting-media'' and o.name not like ' || quote_literal(mu.id('Q') || '/%')), '[]'::jsonb, 'policy: C sees none of P''s objects');

-- ---------------------------------------------------------------------------
-- Complete.
-- ---------------------------------------------------------------------------
select is(mu.complete(null, 'U1'), mu.e('not_project_member'), 'complete: a null user gets not_project_member');
select is(mu.run('A', 'select * from public.complete_meeting_upload(null)'), mu.e('upload_not_found'), 'complete: a null id gets upload_not_found');
select is(mu.complete('A', 'random'), mu.e('upload_not_found'), 'complete: a random id gets upload_not_found');
select is(mu.complete('C', 'U1'), mu.e('upload_not_found'), 'complete: C on P''s upload gets upload_not_found');
select is(mu.complete('B', 'U1'), mu.e('not_project_facilitator'), 'complete: member B gets not_project_facilitator');
select is(mu.complete('A', 'QU'), mu.e('upload_not_found'), 'complete: A on Q''s upload gets upload_not_found');

select mu.snap('U1', mu.row_md5('U1'));
select is(mu.complete('A', 'U1'), mu.e('upload_file_missing'), 'complete: no object raises upload_file_missing');
select is(mu.row_md5('U1'), mu.snapped('U1'), 'complete: the row is byte-identical after upload_file_missing');

reset role;
select mu.put('U1', 16, 'audio/mpeg');
set local role authenticated;
select is(mu.complete('A', 'U1'), '["uploaded", null, true]'::jsonb, 'complete: a matching object makes it uploaded');
select is((select r ->> 'uploaded_at' is not null and r -> 'error_code' = 'null'::jsonb from mu.row('U1') r), true, 'complete: uploaded_at is set and error_code null');
select mu.snap('U1', mu.row_md5('U1'));
select is(mu.complete('A', 'U1'), '["uploaded", null, true]'::jsonb, 'complete: a second call returns the row');
select is(mu.row_md5('U1'), mu.snapped('U1'), 'complete: a second call changes nothing');

-- Mismatches.
select is(mu.create('A', 'P1', 'audio', 'size.mp3', 16, null, 'M1') ->> 1, 'pending_upload', 'register M1');
select is(mu.create('A', 'P1', 'audio', 'type.mp3', 16, null, 'M2') ->> 1, 'pending_upload', 'register M2');
reset role;
select mu.put('M1', 32, 'audio/mpeg');
select mu.put('M2', 16, 'text/plain');
set local role authenticated;
select is(mu.complete('A', 'M1'), '["rejected", "upload_file_mismatch", true]'::jsonb, 'complete: a size mismatch is rejected / upload_file_mismatch');
select is(mu.complete('A', 'M2'), '["rejected", "upload_file_mismatch", true]'::jsonb, 'complete: a mimetype mismatch is rejected / upload_file_mismatch');
select mu.snap('M1', mu.row_md5('M1'));
select is(mu.complete('A', 'M1'), '["rejected", "upload_file_mismatch", true]'::jsonb, 'complete: a call on rejected returns the row');
select is(mu.row_md5('M1'), mu.snapped('M1'), 'complete: a call on rejected changes nothing');
select mu.snap('T1', mu.row_md5('T1'));
select is(mu.complete('A', 'T1'), '["uploaded", null, true]'::jsonb, 'complete: a call on transcript_text returns the row');
select is(mu.row_md5('T1'), mu.snapped('T1'), 'complete: a call on transcript_text changes nothing');

-- 24 hours.
select is(mu.create('A', 'P1', 'audio', 'old.mp3', 16, null, 'O1') ->> 1, 'pending_upload', 'register O1');
select is(mu.create('A', 'P1', 'audio', 'old2.mp3', 16, null, 'O2') ->> 1, 'pending_upload', 'register O2');
reset role;
select mu.age('O1', 25);
select mu.age('O2', 25);
select mu.put('O2', 16, 'audio/mpeg');
set local role authenticated;
select is(mu.can_upload('A', mu.path('O1')), false, 'can_upload: false for a 24-hour-old pending_upload row');
select is(mu.can_read('A', mu.path('O1')), true, 'can_read: true for the old row''s path');
select is(mu.complete('A', 'O1'), '["rejected", "upload_abandoned", true]'::jsonb, 'complete: an old row with no object is rejected / upload_abandoned');
select is(mu.complete('A', 'O2'), '["uploaded", null, true]'::jsonb, 'complete: an old row with a matching object is uploaded');
select is(mu.can_upload('A', mu.path('U1')), false, 'can_upload: false for an uploaded row''s path');
select is(mu.can_upload('A', mu.path('M1')), false, 'can_upload: false for a rejected row''s path');
select is(mu.can_read('A', mu.path('M1')), true, 'can_read: true for a rejected row''s path');

-- Later statuses are untouched by complete.
reset role;
update public.meeting_uploads set status = 'transcribing' where id = mu.id('O2');
set local role authenticated;
select mu.snap('O2', mu.row_md5('O2'));
select is(mu.complete('A', 'O2'), '["transcribing", null, true]'::jsonb, 'complete: a call on a later status returns the row');
select is(mu.row_md5('O2'), mu.snapped('O2'), 'complete: a call on a later status changes nothing');

-- ---------------------------------------------------------------------------
-- List.
-- ---------------------------------------------------------------------------
select is(mu.list('C', 'P1'), mu.e('not_project_member'), 'list: C gets not_project_member');
select is(mu.list(null, 'P1'), mu.e('not_project_member'), 'list: a null user gets not_project_member');
select is(mu.list('A', 'random'), mu.e('not_project_member'), 'list: a random cycle gets not_project_member');
select is(mu.list('B', 'P1'), mu.e('not_project_facilitator'), 'list: B gets not_project_facilitator');
select is((select array_agg(k order by k) from jsonb_object_keys(mu.list('A', 'P1')) k), array['cycle_id', 'uploads'], 'list: exactly cycle_id and uploads');
select is(
  (select bool_and((select array_agg(k order by k) from jsonb_object_keys(x) k) = array['created_at', 'error_code', 'error_message', 'kind', 'mime_type', 'original_filename', 'size_bytes', 'status', 'storage_path', 'text_length', 'updated_at', 'upload_id', 'uploaded_at']) from jsonb_array_elements(mu.list('A', 'P1') -> 'uploads') x),
  true,
  'list: every element has exactly the 13 keys'
);
select is(
  (select jsonb_agg(x -> 'upload_id' order by o) from jsonb_array_elements(mu.list('A', 'P1') -> 'uploads') with ordinality e(x, o)),
  mu.upload_order('P1'),
  'list: ordered by created_at desc, then upload_id'
);
reset role;
select is(
  (select count(*)::int from jsonb_array_elements(mu.list('A', 'P1') -> 'uploads') x),
  (select count(*)::int from public.meeting_uploads u where u.cycle_id = mu.id('P1')),
  'list: every row of P1 and no other cycle''s'
);
set local role authenticated;
select is(
  (select bool_and((x ->> 'text_length' is not null) = (x ->> 'kind' = 'transcript_text')) from jsonb_array_elements(mu.list('A', 'P1') -> 'uploads') x),
  true,
  'list: text_length is set only for transcript_text'
);
select is((select (x ->> 'text_length')::int from jsonb_array_elements(mu.list('A', 'P1') -> 'uploads') x where (x ->> 'upload_id')::uuid = mu.id('T1')), 200000, 'list: text_length counts code points');
select is(strpos(mu.list('A', 'P1')::text, 'Line one'), 0, 'list: no pasted_text value appears in the response');
select is(strpos(mu.list('A', 'P1')::text, mu.id('QU')::text), 0, 'list: no row of another cycle is included');
select is((select (x ->> 'uploaded_at') is null and x ->> 'status' = 'pending_upload' from jsonb_array_elements(mu.list('A', 'P1') -> 'uploads') x where (x ->> 'upload_id')::uuid = mu.id('S1')), true, 'list: a pending row has no uploaded_at');

-- ---------------------------------------------------------------------------
-- Transfer: D becomes facilitator between register and complete.
-- ---------------------------------------------------------------------------
select is(mu.create('A', 'P1', 'audio', 'handover.mp3', 16, null, 'H1') ->> 1, 'pending_upload', 'register H1 as A');
select mu.transfer('A', 'D');
select is(mu.can_upload('A', mu.path('H1')), false, 'after the transfer, can_upload is false for A');
select is(mu.can_upload('D', mu.path('H1')), true, 'after the transfer, can_upload is true for D');
select is(mu.can_read('A', mu.path('U1')), false, 'after the transfer, can_read is false for A');
select is(mu.can_read('D', mu.path('U1')), true, 'after the transfer, can_read is true for D');
select is(mu.create('A', 'P1', 'audio', 'a.mp3', 16, null), mu.e('not_project_facilitator'), 'after the transfer, A (owner, not facilitator) gets not_project_facilitator');
select is(mu.complete('A', 'H1'), mu.e('not_project_facilitator'), 'after the transfer, A cannot complete');
select is(mu.list('A', 'P1'), mu.e('not_project_facilitator'), 'after the transfer, A cannot list');
reset role;
select mu.put('H1', 16, 'audio/mpeg');
set local role authenticated;
select is(mu.complete('D', 'H1'), '["uploaded", null, true]'::jsonb, 'after the transfer, D completes A''s upload');
-- Only the owner transfers the role: A hands it back to A.
select mu.transfer('A', 'A');

-- ---------------------------------------------------------------------------
-- Stage after register: closed allows; a cycle forced back to vote refuses.
-- ---------------------------------------------------------------------------
select is(mu.create('A', 'P1', 'audio', 'closing.mp3', 16, null, 'K1') ->> 1, 'pending_upload', 'register K1 in discuss');
select mu.close_cycle('A', 'P1');
reset role;
select mu.put('K1', 16, 'audio/mpeg');
set local role authenticated;
select is(mu.complete('A', 'K1'), '["uploaded", null, true]'::jsonb, 'complete works after close_cycle');
select is(mu.create('A', 'P1', 'transcript_text', null, null, 'Closed notes') ->> 1, 'uploaded', 'create works in closed');
select is(mu.create('A', 'P1', 'audio', 'vote.mp3', 16, null, 'V1') ->> 1, 'pending_upload', 'register V1 in closed');
select is(mu.can_upload('A', mu.path('V1')), true, 'can_upload: true for A in closed');
reset role;
select mu.force_status('P1', 'vote');
set local role authenticated;
select is(mu.complete('A', 'V1'), mu.e('cycle_not_discussing'), 'complete on a cycle forced back to vote gets cycle_not_discussing');
select is(mu.can_upload('A', mu.path('V1')), false, 'can_upload: false while the cycle is in vote');
reset role;
select mu.force_status('P1', 'closed');
set local role authenticated;
select is((select x ->> 'status' from jsonb_array_elements(mu.list('A', 'P1') -> 'uploads') x where (x ->> 'upload_id')::uuid = mu.id('V1')), 'pending_upload', 'list works in closed');

-- ---------------------------------------------------------------------------
-- Limits, on P2 (P's next cycle).
-- ---------------------------------------------------------------------------
select mu.new_cycle('P2', 'P', '2026-09-21');
select is(mu.list('A', 'P2'), jsonb_build_object('cycle_id', mu.id('P2'), 'uploads', '[]'::jsonb), 'list works in collecting (empty)');
select mu.close_cycle('A', 'P2');

select is(
  (select count(*)::int from generate_series(1, 20) i where mu.cr('A', 'P2', 'audio', 'f' || i || '.mp3', 16, null) = 'ok'),
  20,
  'twenty uploads register'
);
select is(mu.cr('A', 'P2', 'audio', 'more.mp3', 16, null), 'upload_limit_reached', 'the 21st active upload gets upload_limit_reached');
select is(mu.cr('A', 'P2', 'transcript_text', null, null, 'text'), 'upload_limit_reached', 'pasted text counts toward the same limit');
reset role;
-- Three rows stop counting: one rejected, two older than 24 hours (one of
-- them with an object). Q1's pending upload is also old.
insert into mu.ids (label, id)
select 'L' || o, u.id from (select u.id, row_number() over (order by u.id) o from public.meeting_uploads u where u.cycle_id = mu.id('P2')) u where o <= 3;
update public.meeting_uploads set status = 'rejected', error_code = 'upload_file_mismatch' where id = mu.id('L1');
select mu.age('L2', 30);
select mu.age('L3', 30);
select mu.put('L3', 16, 'audio/mpeg');
select mu.age('QU', 30);
select mu.snap('QU', mu.row_md5('QU'));
set local role authenticated;
select is(mu.cr('A', 'P2', 'audio', 'slot1.mp3', 16, null), 'ok', 'rejected and old rows free active slots');
select is((select r ->> 'status' || '/' || coalesce(r ->> 'error_code', '') from mu.row('L2') r), 'rejected/upload_abandoned', 'the old row with no object is marked rejected / upload_abandoned');
select is((select r ->> 'status' from mu.row('L3') r), 'pending_upload', 'the old row whose object exists is left alone');
select is(mu.row_md5('QU'), mu.snapped('QU'), 'another cycle''s old row is left alone');
select is(mu.cr('A', 'P2', 'audio', 'slot2.mp3', 16, null), 'ok', 'a second freed slot is used');
select is(mu.cr('A', 'P2', 'audio', 'slot3.mp3', 16, null), 'ok', 'a third freed slot is used');
select is(mu.cr('A', 'P2', 'audio', 'slot4.mp3', 16, null), 'upload_limit_reached', 'then the active limit applies again');
select is(mu.nrows('P2'), 23, 'P2 has 23 rows');
reset role;
-- 27 more rejected rows (as postgres): 50 rows in total, 20 of them active
-- before every pending row is rejected too, so only the 50-row cap remains.
update public.meeting_uploads set status = 'rejected', error_code = 'upload_file_mismatch'
 where cycle_id = mu.id('P2') and status = 'pending_upload';
insert into public.meeting_uploads (cycle_id, kind, status, storage_path, original_filename, mime_type, size_bytes, error_code, created_by)
select mu.id('P2'), 'audio', 'rejected', 'cap/' || i || '.mp3', 'cap.mp3', 'audio/mpeg', 16, 'upload_abandoned', mu.id('A') from generate_series(1, 27) i;
set local role authenticated;
select is(mu.nrows('P2'), 50, 'P2 has 50 rows, none of them active');
select is(mu.cr('A', 'P2', 'transcript_text', null, null, 'text'), 'upload_limit_reached', 'with 50 rows in total the next create is refused');
reset role;

select * from finish();

rollback;
