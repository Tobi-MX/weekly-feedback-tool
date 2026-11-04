-- pgTAP tests for #29: transcripts, transcript_segments_valid, its guard,
-- the replaced meeting_uploads.uploaded_at CHECK, and the RPCs
-- store_transcript, reject_transcript_upload, get_pasted_transcript_text and
-- the replaced get_cycle_uploads.
--
-- Everything runs in one transaction and is rolled back at the end.
-- Fixtures as in meeting_uploads.test.sql: owner and facilitator A, members
-- B and D (D becomes facilitator in the transfer cases), non-member C;
-- projects P (A's) and Q (C's). P1 is moved to discuss through the RPCs and
-- later closed by D. transcript_file rows are completed with storage.objects
-- rows inserted as postgres.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(234);

-- ---------------------------------------------------------------------------
-- Test-only helpers.
-- ---------------------------------------------------------------------------
create schema tr;

create table tr.ids (label text primary key, id uuid not null);
create table tr.snaps (label text primary key, body text);

insert into tr.ids (label, id)
values
  ('A', 'a8100000-0000-4000-8000-000000000001'),
  ('B', 'a8100000-0000-4000-8000-000000000002'),
  ('C', 'a8100000-0000-4000-8000-000000000003'),
  ('D', 'a8100000-0000-4000-8000-000000000004'),
  ('P', 'a9100000-0000-4000-8000-000000000001'),
  ('Q', 'a9100000-0000-4000-8000-000000000002'),
  ('random', 'af100000-0000-4000-8000-000000000029');

create function tr.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from tr.ids i where i.label = p_label;
$$;

create function tr.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', tr.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- The error a refused call gets.
create function tr.e(p_message text)
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
create function tr.run(p_user text, p_sql text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
  v_state text;
  v_message text;
begin
  perform tr.become(p_user);
  execute 'select coalesce(jsonb_agg(to_jsonb(r)), ''[]''::jsonb) from (' || p_sql || ') r' into result;
  return result;
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
    return jsonb_build_object('code', v_state, 'message', v_message);
end;
$$;

-- Runs one statement as the role: 'ok' or the SQLSTATE.
create function tr.try_as(p_role text, p_sql text)
returns text
language plpgsql
as $$
declare
  v_state text;
begin
  execute format('set local role %I', p_role);
  execute p_sql;
  reset role;
  return 'ok';
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate;
    reset role;
    return v_state;
end;
$$;

create function tr.row(p_upload text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.to_jsonb(u) from public.meeting_uploads u where u.id = tr.id(p_upload);
$$;

create function tr.row_md5(p_upload text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(pg_catalog.to_jsonb(u)::text) from public.meeting_uploads u where u.id = tr.id(p_upload);
$$;

create function tr.transcript(p_upload text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.to_jsonb(t) from public.transcripts t where t.upload_id = tr.id(p_upload);
$$;

create function tr.ntranscripts(p_upload text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.transcripts t where t.upload_id = tr.id(p_upload);
$$;

-- Both tables, as one md5.
create function tr.tables_md5()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(
    coalesce((select string_agg(pg_catalog.to_jsonb(u)::text, '|' order by u.id) from public.meeting_uploads u), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(t)::text, '|' order by t.id) from public.transcripts t), '')
  );
$$;

create function tr.others_md5()
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
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(e)::text, '|' order by e.id) from public.cycle_events e), '')
  );
$$;

-- create_meeting_upload as the user; labels the new row. Returns the status
-- or the error message.
create function tr.create(p_user text, p_cycle text, p_kind text, p_filename text, p_size bigint, p_text text, p_label text)
returns text
language plpgsql
as $$
declare
  result jsonb := tr.run(p_user, format(
    'select * from public.create_meeting_upload(%L::uuid, %L, %L, %L::bigint, %L)',
    tr.id(p_cycle), p_kind, p_filename, p_size, p_text));
begin
  if jsonb_typeof(result) = 'array' and jsonb_array_length(result) = 1 then
    insert into tr.ids (label, id) values (p_label, (result -> 0 ->> 'upload_id')::uuid);
    return result -> 0 ->> 'status';
  end if;
  return result ->> 'message';
end;
$$;

create function tr.path(p_upload text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.storage_path from public.meeting_uploads u where u.id = tr.id(p_upload);
$$;

-- A stored object for the upload's path (written as postgres), then
-- completion as the user. Returns the status.
create function tr.put(p_upload text, p_size bigint, p_mime text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into storage.objects (bucket_id, name, metadata)
  values ('meeting-media', tr.path(p_upload), pg_catalog.jsonb_build_object('size', p_size, 'mimetype', p_mime));
$$;

create function tr.complete(p_user text, p_upload text)
returns text
language plpgsql
as $$
declare
  result jsonb := tr.run(p_user, format('select * from public.complete_meeting_upload(%L::uuid)', tr.id(p_upload)));
begin
  if jsonb_typeof(result) = 'array' then
    return result -> 0 ->> 'status';
  end if;
  return result ->> 'message';
end;
$$;

-- A transcript file uploaded and completed by A: register, object, complete.
create function tr.file(p_cycle text, p_name text, p_label text)
returns text
language plpgsql
as $$
declare
  ext text := lower(substring(p_name from '\.([^.]+)$'));
  mime text := case ext when 'txt' then 'text/plain' when 'vtt' then 'text/vtt' when 'srt' then 'application/x-subrip'
                        when 'mp3' then 'audio/mpeg' when 'mp4' then 'video/mp4' end;
  kind text := case ext when 'mp3' then 'audio' when 'mp4' then 'video' else 'transcript_file' end;
  created text;
begin
  created := tr.create('A', p_cycle, kind, p_name, 16, null, p_label);
  if created <> 'pending_upload' then
    return created;
  end if;
  perform tr.put(p_label, 16, mime);
  return tr.complete('A', p_label);
end;
$$;

-- store_transcript as the user: [status, text_length, segment_count, id ok]
-- or the error.
create function tr.store(p_user text, p_upload text, p_text text, p_segments jsonb)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := tr.run(p_user, format('select * from public.store_transcript(%L::uuid, %L, %L::jsonb)', tr.id(p_upload), p_text, p_segments));
begin
  if jsonb_typeof(result) = 'array' and jsonb_array_length(result) = 1 then
    return jsonb_build_array(result -> 0 -> 'status', result -> 0 -> 'text_length', result -> 0 -> 'segment_count', (result -> 0 ->> 'upload_id')::uuid = tr.id(p_upload));
  end if;
  return result;
end;
$$;

-- reject_transcript_upload as the user: [status, error_code, id ok] or the error.
create function tr.reject(p_user text, p_upload text, p_reason text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := tr.run(p_user, format('select * from public.reject_transcript_upload(%L::uuid, %L)', tr.id(p_upload), p_reason));
begin
  if jsonb_typeof(result) = 'array' and jsonb_array_length(result) = 1 then
    return jsonb_build_array(result -> 0 -> 'status', result -> 0 -> 'error_code', (result -> 0 ->> 'upload_id')::uuid = tr.id(p_upload));
  end if;
  return result;
end;
$$;

-- get_pasted_transcript_text as the user: the text or the error.
create function tr.pasted(p_user text, p_upload text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := tr.run(p_user, format('select * from public.get_pasted_transcript_text(%L::uuid)', tr.id(p_upload)));
begin
  if jsonb_typeof(result) = 'array' and jsonb_array_length(result) = 1 then
    return jsonb_build_array(result -> 0 -> 'pasted_text', (result -> 0 ->> 'upload_id')::uuid = tr.id(p_upload));
  end if;
  return result;
end;
$$;

create function tr.list(p_user text, p_cycle text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := tr.run(p_user, format('select public.get_cycle_uploads(%L::uuid) as d', tr.id(p_cycle)));
begin
  if jsonb_typeof(result) = 'array' then
    return result -> 0 -> 'd';
  end if;
  return result;
end;
$$;

-- n segments with equal starts and ends 1..n and the given text.
create function tr.segs(p_n integer, p_text text)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(jsonb_build_object('start_ms', i, 'end_ms', i, 'text', p_text) order by i), '[]'::jsonb)
    from generate_series(1, p_n) i;
$$;

create function tr.v(p_segments jsonb)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select private.transcript_segments_valid(p_segments);
$$;

create function tr.new_cycle(p_label text, p_project text, p_week date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid := gen_random_uuid();
begin
  insert into public.feedback_cycles (id, project_id, title, week_start)
  values (new_id, tr.id(p_project), p_label, p_week);
  insert into tr.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

create function tr.to_discuss(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform tr.become(p_user);
  perform 1 from public.start_retrospective(tr.id(p_cycle));
  perform 1 from public.advance_stage(tr.id(p_cycle), 'reveal');
  perform 1 from public.create_cluster(tr.id(p_cycle), 'X');
  perform 1 from public.advance_stage(tr.id(p_cycle), 'cluster');
  perform 1 from public.close_voting(tr.id(p_cycle));
end;
$$;

create function tr.close_cycle(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform tr.become(p_user);
  perform 1 from public.close_cycle(tr.id(p_cycle));
end;
$$;

create function tr.transfer(p_from text, p_to text)
returns void
language plpgsql
as $$
begin
  perform tr.become(p_from);
  perform public.transfer_facilitator(tr.id('P'), tr.id(p_to));
end;
$$;

-- Forces a cycle's status as postgres, with feedback_cycles' triggers off.
create function tr.force_status(p_cycle text, p_status text)
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
         voting_closed_at = case when p_status = 'vote' then null else coalesce(fc.voting_closed_at, pg_catalog.now()) end
   where fc.id = tr.id(p_cycle);
  alter table public.feedback_cycles enable trigger user;
end;
$$;

create function tr.snap(p_label text, p_body text)
returns void
language sql
as $$
  insert into tr.snaps (label, body) values (p_label, p_body)
  on conflict (label) do update set body = excluded.body;
$$;

create function tr.snapped(p_label text)
returns text
language sql
stable
as $$
  select s.body from tr.snaps s where s.label = p_label;
$$;

grant usage on schema tr to authenticated, anon;
grant select, insert, update, delete on all tables in schema tr to authenticated;
grant execute on all functions in schema tr to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures.
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', 'a8100000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'tr-a@example.com', '{"display_name":"Alice"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a8100000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'tr-b@example.com', '{"display_name":"Bob"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a8100000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'tr-c@example.com', '{"display_name":"Cara"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a8100000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'tr-d@example.com', '{"display_name":"Dan"}', '', '', '', '');

insert into public.projects (id, name, owner_id)
values
  ('a9100000-0000-4000-8000-000000000001', 'Project P', 'a8100000-0000-4000-8000-000000000001'),
  ('a9100000-0000-4000-8000-000000000002', 'Project Q', 'a8100000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('a9100000-0000-4000-8000-000000000001', 'a8100000-0000-4000-8000-000000000002', 'member'),
  ('a9100000-0000-4000-8000-000000000001', 'a8100000-0000-4000-8000-000000000004', 'member');

-- ---------------------------------------------------------------------------
-- transcripts: columns, keys, CHECKs, guard, default-deny.
-- ---------------------------------------------------------------------------
select columns_are('public', 'transcripts', array['id', 'upload_id', 'text', 'segments', 'created_at'], 'transcripts has exactly the five columns');
select is(
  (select array_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable || ':' || coalesce(c.column_default, '') order by c.ordinal_position) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'transcripts'),
  array[
    'id:uuid:NO:gen_random_uuid()',
    'upload_id:uuid:NO:',
    'text:text:NO:',
    'segments:jsonb:NO:''[]''::jsonb',
    'created_at:timestamp with time zone:NO:now()'
  ],
  'transcripts column types, defaults, and not-null rules'
);
select col_is_pk('public', 'transcripts', 'id', 'transcripts.id is the primary key');
select is(
  (select array_agg(c.conname || ':' || pg_get_constraintdef(c.oid) order by c.conname) from pg_constraint c where c.conrelid = 'public.transcripts'::regclass and c.contype in ('f', 'u', 'c')),
  array[
    'transcripts_segments_check:CHECK (private.transcript_segments_valid(segments))',
    'transcripts_text_check:CHECK ((((char_length(text) >= 1) AND (char_length(text) <= 200000)) AND (text ~ ''[^[:space:]]''::text)))',
    'transcripts_upload_id_fkey:FOREIGN KEY (upload_id) REFERENCES meeting_uploads(id) ON DELETE CASCADE',
    'transcripts_upload_id_key:UNIQUE (upload_id)'
  ],
  'upload_id is unique and cascades; text and segments have their CHECKs'
);
select trigger_is('public', 'transcripts', 'transcripts_guard_update', 'private', 'guard_transcript_update', 'the guard trigger exists');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.transcripts'::regclass and tgname = 'transcripts_guard_update'), 19, 'the guard is BEFORE UPDATE FOR EACH ROW');

select is((select relrowsecurity from pg_class where oid = 'public.transcripts'::regclass), true, 'RLS is enabled on transcripts');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'transcripts'), 0, 'transcripts has no policy');
select is(
  (select array_agg(r || ':' || p order by r, p) from unnest(array['anon', 'authenticated', 'service_role']) r cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege(r, 'public.transcripts', p)),
  array['service_role:DELETE', 'service_role:INSERT', 'service_role:SELECT'],
  'anon and authenticated hold no privilege; service_role holds exactly SELECT, INSERT, DELETE'
);
select is((select count(*)::int from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name = 'transcripts' and g.grantee = 'PUBLIC'), 0, 'PUBLIC has no privilege on transcripts');
select is(
  (select array_agg(schemaname || '.' || tablename order by schemaname, tablename) from pg_publication_tables where pubname = 'supabase_realtime'),
  array['public.cycle_events'],
  'supabase_realtime still publishes only cycle_events'
);

-- transcript_segments_valid.
select is(
  (select p.provolatile = 'i' and p.proconfig = array['search_path=""']::text[] and not p.prosecdef from pg_proc p where p.oid = 'private.transcript_segments_valid(jsonb)'::regprocedure),
  true,
  'transcript_segments_valid is immutable with search_path fixed to empty'
);
select is(
  array[
    has_function_privilege('authenticated', 'private.transcript_segments_valid(jsonb)'::regprocedure, 'EXECUTE'),
    has_function_privilege('anon', 'private.transcript_segments_valid(jsonb)'::regprocedure, 'EXECUTE'),
    (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'private.transcript_segments_valid(jsonb)'::regprocedure)
  ],
  array[false, false, false],
  'PUBLIC, anon and authenticated cannot execute transcript_segments_valid'
);
select is(
  array[
    has_function_privilege('authenticated', 'private.guard_transcript_update()'::regprocedure, 'EXECUTE'),
    has_function_privilege('anon', 'private.guard_transcript_update()'::regprocedure, 'EXECUTE'),
    has_function_privilege('service_role', 'private.guard_transcript_update()'::regprocedure, 'EXECUTE')
  ],
  array[false, false, false],
  'the guard function is not executable by any client role'
);

select is(tr.v(s), true, 'valid: ' || label)
  from (values
    ('[]', '[]'::jsonb),
    ('one segment', '[{"start_ms": 0, "end_ms": 1500, "text": "Alice: Hi"}]'::jsonb),
    ('20,000 segments', tr.segs(20000, 'abcdefghi')),
    ('equal starts', '[{"start_ms": 5, "end_ms": 6, "text": "a"}, {"start_ms": 5, "end_ms": 7, "text": "b"}]'::jsonb),
    ('overlapping cues', '[{"start_ms": 0, "end_ms": 5000, "text": "a"}, {"start_ms": 1000, "end_ms": 2000, "text": "b"}]'::jsonb),
    ('end_ms = start_ms', '[{"start_ms": 86400000, "end_ms": 86400000, "text": "a"}]'::jsonb)
  ) t(label, s);
select is(tr.v(s), false, 'invalid: ' || label)
  from (values
    ('null', null::jsonb),
    ('an object', '{"start_ms": 0, "end_ms": 1, "text": "a"}'::jsonb),
    ('a number', '1'::jsonb),
    ('20,001 elements', tr.segs(20001, 'a')),
    ('a missing key', '[{"start_ms": 0, "text": "a"}]'::jsonb),
    ('an extra key', '[{"start_ms": 0, "end_ms": 1, "text": "a", "speaker": "A"}]'::jsonb),
    ('a non-object element', '["a"]'::jsonb),
    ('a string start_ms', '[{"start_ms": "0", "end_ms": 1, "text": "a"}]'::jsonb),
    ('a float start_ms', '[{"start_ms": 1.5, "end_ms": 2, "text": "a"}]'::jsonb),
    ('a negative start_ms', '[{"start_ms": -1, "end_ms": 2, "text": "a"}]'::jsonb),
    ('end_ms 86,400,001', '[{"start_ms": 0, "end_ms": 86400001, "text": "a"}]'::jsonb),
    ('start_ms 86,400,001', '[{"start_ms": 86400001, "end_ms": 86400001, "text": "a"}]'::jsonb),
    ('end_ms < start_ms', '[{"start_ms": 5, "end_ms": 4, "text": "a"}]'::jsonb),
    ('a decreasing start', '[{"start_ms": 5, "end_ms": 6, "text": "a"}, {"start_ms": 4, "end_ms": 6, "text": "b"}]'::jsonb),
    ('non-string text', '[{"start_ms": 0, "end_ms": 1, "text": 1}]'::jsonb),
    ('empty text', '[{"start_ms": 0, "end_ms": 1, "text": ""}]'::jsonb),
    ('whitespace-only text', '[{"start_ms": 0, "end_ms": 1, "text": " \t "}]'::jsonb),
    ('text with \n', '[{"start_ms": 0, "end_ms": 1, "text": "a\nb"}]'::jsonb),
    ('text with \r', '[{"start_ms": 0, "end_ms": 1, "text": "a\rb"}]'::jsonb)
  ) t(label, s);

-- Every CHECK refuses a bad row inserted as postgres.
-- Q's cycle, so P can open P1 later (one open cycle per project).
select tr.new_cycle('P0', 'Q', '2026-09-07');
insert into tr.ids (label, id) values ('SU', gen_random_uuid()), ('SU2', gen_random_uuid());
insert into public.meeting_uploads (id, cycle_id, kind, status, storage_path, original_filename, mime_type, size_bytes, uploaded_at)
values
  (tr.id('SU'), tr.id('P0'), 'transcript_file', 'uploaded', 's/1.txt', 'a.txt', 'text/plain', 5, now()),
  (tr.id('SU2'), tr.id('P0'), 'transcript_file', 'uploaded', 's/2.txt', 'a.txt', 'text/plain', 5, now());

create function tr.bad(p_upload text, p_text text, p_segments jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_constraint text;
begin
  insert into public.transcripts (upload_id, text, segments)
  values (tr.id(p_upload), p_text, p_segments);
  delete from public.transcripts t where t.upload_id = tr.id(p_upload);
  return 'ok';
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name;
    return v_state || ':' || coalesce(v_constraint, '');
end;
$$;

select is(tr.bad('SU', 'Hello', '[]'), 'ok', 'a valid row is accepted (the baseline)');
select is(tr.bad('SU', repeat('😀', 200000), '[]'), 'ok', '200,000 characters of emoji are accepted');
select is(tr.bad('SU', '', '[]'), '23514:transcripts_text_check', 'empty text is refused');
select is(tr.bad('SU', E' \n\t ', '[]'), '23514:transcripts_text_check', 'whitespace-only text is refused');
select is(tr.bad('SU', repeat('a', 200001), '[]'), '23514:transcripts_text_check', '200,001 characters are refused');
select is(tr.bad('SU', 'a', s), '23514:transcripts_segments_check', 'segments refused: ' || label)
  from (values
    ('an object', '{}'::jsonb),
    ('a number', '1'::jsonb),
    ('20,001 elements', tr.segs(20001, 'a')),
    ('a missing key', '[{"start_ms": 0, "text": "a"}]'::jsonb),
    ('an extra key', '[{"start_ms": 0, "end_ms": 1, "text": "a", "x": 1}]'::jsonb),
    ('a string start_ms', '[{"start_ms": "0", "end_ms": 1, "text": "a"}]'::jsonb),
    ('a float start_ms', '[{"start_ms": 1.5, "end_ms": 2, "text": "a"}]'::jsonb),
    ('a negative start_ms', '[{"start_ms": -1, "end_ms": 2, "text": "a"}]'::jsonb),
    ('86,400,001', '[{"start_ms": 0, "end_ms": 86400001, "text": "a"}]'::jsonb),
    ('end_ms < start_ms', '[{"start_ms": 5, "end_ms": 4, "text": "a"}]'::jsonb),
    ('a decreasing start', '[{"start_ms": 5, "end_ms": 6, "text": "a"}, {"start_ms": 4, "end_ms": 6, "text": "b"}]'::jsonb),
    ('non-string text', '[{"start_ms": 0, "end_ms": 1, "text": 1}]'::jsonb),
    ('empty text', '[{"start_ms": 0, "end_ms": 1, "text": ""}]'::jsonb),
    ('whitespace-only text', '[{"start_ms": 0, "end_ms": 1, "text": " "}]'::jsonb),
    ('text with \n', '[{"start_ms": 0, "end_ms": 1, "text": "a\nb"}]'::jsonb),
    ('text with \r', '[{"start_ms": 0, "end_ms": 1, "text": "a\rb"}]'::jsonb)
  ) t(label, s);
select throws_ok(format('insert into public.transcripts (upload_id, text, segments) values (%L, %L, null)', tr.id('SU'), 'a'), '23502', null, 'null segments are refused');

insert into public.transcripts (upload_id, text) values (tr.id('SU'), 'first');
select throws_ok(format('insert into public.transcripts (upload_id, text) values (%L, %L)', tr.id('SU'), 'second'), '23505', null, 'a second row for the same upload is refused');
select is(tr.ntranscripts('SU'), 1, 'the upload still has one transcript');

-- Guard: any UPDATE as postgres.
select throws_ok(format('update public.transcripts set %s where upload_id = %L', c, tr.id('SU')), 'P0001', 'transcript_immutable', 'updating ' || c || ' raises transcript_immutable')
  from unnest(array['id = gen_random_uuid()', 'upload_id = ' || quote_literal(tr.id('SU2')), 'text = ''x''', 'segments = ''[]''', 'created_at = now()']) c;

select lives_ok(format('delete from public.meeting_uploads where id = %L', tr.id('SU')), 'the upload can be deleted');
select is(tr.ntranscripts('SU'), 0, 'deleting the upload deleted its transcript');

-- The service role (#31) inserts under the same CHECKs.
select is(tr.try_as('service_role', format('insert into public.transcripts (upload_id, text, segments) values (%L, %L, %L)', tr.id('SU2'), 'a', '[{"start_ms": 0, "end_ms": 1, "text": "a\nb"}]')), '23514', 'service_role gets the segments CHECK');
select is(tr.try_as('service_role', format('insert into public.transcripts (upload_id, text) values (%L, %L)', tr.id('SU2'), 'a')), 'ok', 'service_role can insert a valid transcript');

-- meeting_uploads.uploaded_at, replaced (decision 8).
create function tr.bad_upload(p_status text, p_uploaded timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_constraint text;
begin
  insert into public.meeting_uploads (cycle_id, kind, status, storage_path, original_filename, mime_type, size_bytes, error_code, uploaded_at)
  values (tr.id('P0'), 'transcript_file', p_status, 'u/' || gen_random_uuid() || '.txt', 'a.txt', 'text/plain', 5,
          case when p_status = 'rejected' then 'transcript_empty' end, p_uploaded);
  return 'ok';
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name;
    return v_state || ':' || coalesce(v_constraint, '');
end;
$$;

select is(tr.bad_upload('pending_upload', now()), '23514:meeting_uploads_uploaded_at_check', 'pending_upload with uploaded_at is refused');
select is(tr.bad_upload('uploaded', null), '23514:meeting_uploads_uploaded_at_check', 'uploaded without uploaded_at is refused');
select is(tr.bad_upload('extracting', null), '23514:meeting_uploads_uploaded_at_check', 'extracting without uploaded_at is refused');
select is(tr.bad_upload('rejected', now()), 'ok', 'rejected with uploaded_at is accepted');
select is(tr.bad_upload('rejected', null), 'ok', 'rejected without uploaded_at is accepted');
select is(tr.bad_upload('pending_upload', null), 'ok', 'pending_upload without uploaded_at is accepted');
select is(tr.bad_upload('extracting', now()), 'ok', 'extracting with uploaded_at is accepted');

delete from public.meeting_uploads where cycle_id = tr.id('P0');

-- ---------------------------------------------------------------------------
-- RPC hardening.
-- ---------------------------------------------------------------------------
create table tr.rpcs (name text primary key, fn regprocedure, sig text, vol "char", codes text[]);
insert into tr.rpcs (name, fn, sig, vol, codes)
values
  ('store_transcript', 'public.store_transcript(uuid, text, jsonb)',
   'p_upload_id uuid, p_text text, p_segments jsonb -> TABLE(upload_id uuid, status text, text_length integer, segment_count integer)', 'v',
   array['cycle_not_discussing', 'invalid_transcript', 'not_project_facilitator', 'not_project_member', 'transcript_already_stored', 'upload_not_found', 'upload_not_ready', 'upload_not_transcript']),
  ('reject_transcript_upload', 'public.reject_transcript_upload(uuid, text)',
   'p_upload_id uuid, p_reason text -> TABLE(upload_id uuid, status text, error_code text)', 'v',
   array['cycle_not_discussing', 'invalid_reject_reason', 'not_project_facilitator', 'not_project_member', 'upload_not_found', 'upload_not_transcript']),
  ('get_pasted_transcript_text', 'public.get_pasted_transcript_text(uuid)',
   'p_upload_id uuid -> TABLE(upload_id uuid, pasted_text text)', 's',
   array['not_project_facilitator', 'not_project_member', 'upload_not_found', 'upload_not_ready', 'upload_not_transcript']),
  ('get_cycle_uploads', 'public.get_cycle_uploads(uuid)', 'p_cycle_id uuid -> jsonb', 's',
   array['not_project_facilitator', 'not_project_member']);

select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = r.name), 1, r.name || ' has exactly one overload') from tr.rpcs r order by r.name;
select is(pg_get_function_identity_arguments(r.fn) || ' -> ' || pg_get_function_result(r.fn), r.sig, r.name || ' has the agreed signature') from tr.rpcs r order by r.name;
select is((select p.prosecdef and p.proconfig = array['search_path=""']::text[] and p.provolatile = r.vol from pg_proc p where p.oid = r.fn), true, r.name || ' is security definer with search_path fixed to empty and the agreed volatility') from tr.rpcs r order by r.name;
select is(
  array[
    has_function_privilege('authenticated', r.fn, 'EXECUTE'),
    has_function_privilege('anon', r.fn, 'EXECUTE'),
    has_function_privilege('service_role', r.fn, 'EXECUTE'),
    (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = r.fn)
  ],
  array[true, false, false, false],
  r.name || ' is executable by authenticated only'
) from tr.rpcs r order by r.name;
select is(
  (select (select count(*)::int from regexp_matches(p.prosrc, '\mraise\M', 'gi'))
          = (select count(*)::int from regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''[a-z_]+'';', 'g'))
     from pg_proc p where p.oid = r.fn),
  true,
  r.name || ': every raise has the pinned form'
) from tr.rpcs r order by r.name;
select is(
  (select array_agg(distinct m[2] order by m[2]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = r.fn),
  r.codes,
  r.name || ' raises exactly its codes'
) from tr.rpcs r order by r.name;
select is(
  (select bool_and((m[1] = '42501') = (m[2] in ('not_project_member', 'not_project_facilitator'))) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = r.fn),
  true,
  r.name || ' uses 42501 for the access codes and P0001 for the rest'
) from tr.rpcs r order by r.name;
select is((select p.prosrc ~* '(execute|raise\s+notice)' from pg_proc p where p.oid = r.fn), false, r.name || ' has no execute and no raise notice') from tr.rpcs r order by r.name;
select is((select p.prosrc ~* '(cycle_events|update public\.feedback_cycles|update public\.projects|project_members)' from pg_proc p where p.oid = r.fn), false, r.name || ' never writes cycle_events, feedback_cycles, projects or project_members') from tr.rpcs r order by r.name;
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.prosrc ~ 'public\.transcripts'),
  array['get_cycle_uploads', 'store_transcript'],
  'only store_transcript and get_cycle_uploads read transcripts'
);
select is((select count(*)::int from pg_proc p, regexp_matches(p.prosrc, 'for (update|share)', 'gi') where p.oid = 'public.get_pasted_transcript_text(uuid)'::regprocedure), 0, 'get_pasted_transcript_text takes no lock');

-- ---------------------------------------------------------------------------
-- P1 in discuss with twenty active uploads, all made through the RPCs.
-- ---------------------------------------------------------------------------
select tr.new_cycle('P1', 'P', '2026-09-14');
set local role authenticated;
select tr.to_discuss('A', 'P1');

select is(tr.file('P1', name, label), 'uploaded', label || ': ' || name || ' is uploaded')
  from (values
    ('F1', 'standup.txt'), ('V1', 'standup.vtt'), ('V2', 'other.vtt'), ('S1', 'standup.srt'),
    ('X1', 'x.txt'), ('E1', 'emoji.txt'), ('AU', 'standup.mp3'), ('VI', 'standup.mp4'),
    ('R1', 'r1.txt'), ('R2', 'r2.txt'), ('R3', 'r3.txt'), ('R4', 'r4.txt'), ('R5', 'r5.vtt'), ('R6', 'r6.srt'), ('R7', 'r7.txt'),
    ('DT1', 'd1.vtt'), ('DT2', 'd2.txt'), ('CL1', 'c1.srt')
  ) t(label, name);
select is(tr.create('A', 'P1', 'transcript_text', null, null, E'﻿ZEBRA-PASTE one\r\ntwo', 'T1'), 'uploaded', 'T1: pasted text is uploaded');
select is(tr.create('A', 'P1', 'transcript_file', 'pending.txt', 16, null, 'PEND'), 'pending_upload', 'PEND: a transcript file is pending');
select is(tr.create('A', 'P1', 'transcript_text', null, null, 'more', 'LIMIT'), 'upload_limit_reached', 'P1 has twenty active uploads');

select tr.snap('others', tr.others_md5());

-- ---------------------------------------------------------------------------
-- Access, for each of the three new RPCs.
-- ---------------------------------------------------------------------------
select tr.snap('access', tr.tables_md5());
select is(tr.store(null, 'F1', 'a', '[]'), tr.e('not_project_member'), 'store: a null user gets not_project_member');
select is(tr.reject(null, 'F1', 'transcript_empty'), tr.e('not_project_member'), 'reject: a null user gets not_project_member');
select is(tr.pasted(null, 'T1'), tr.e('not_project_member'), 'pasted: a null user gets not_project_member');
select is(tr.store('A', 'nothing', 'a', '[]'), tr.e('upload_not_found'), 'store: a null id gets upload_not_found');
select is(tr.reject('A', 'nothing', 'transcript_empty'), tr.e('upload_not_found'), 'reject: a null id gets upload_not_found');
select is(tr.pasted('A', 'nothing'), tr.e('upload_not_found'), 'pasted: a null id gets upload_not_found');
select is(tr.store('A', 'random', 'a', '[]'), tr.e('upload_not_found'), 'store: a random id gets upload_not_found');
select is(tr.reject('A', 'random', 'transcript_empty'), tr.e('upload_not_found'), 'reject: a random id gets upload_not_found');
select is(tr.pasted('A', 'random'), tr.e('upload_not_found'), 'pasted: a random id gets upload_not_found');
select is(tr.store('C', 'F1', 'a', '[]'), tr.e('upload_not_found'), 'store: C on P''s upload gets upload_not_found');
select is(tr.reject('C', 'F1', 'transcript_empty'), tr.e('upload_not_found'), 'reject: C on P''s upload gets upload_not_found');
select is(tr.pasted('C', 'T1'), tr.e('upload_not_found'), 'pasted: C on P''s upload gets upload_not_found');
select is(tr.store(u, 'F1', 'a', '[]'), tr.e('not_project_facilitator'), 'store: ' || u || ' gets not_project_facilitator') from unnest(array['B', 'D']) u;
select is(tr.reject(u, 'F1', 'transcript_empty'), tr.e('not_project_facilitator'), 'reject: ' || u || ' gets not_project_facilitator') from unnest(array['B', 'D']) u;
select is(tr.pasted(u, 'T1'), tr.e('not_project_facilitator'), 'pasted: ' || u || ' gets not_project_facilitator') from unnest(array['B', 'D']) u;
select is(tr.tables_md5(), tr.snapped('access'), 'no refused call changed anything');

-- ---------------------------------------------------------------------------
-- Kind and status.
-- ---------------------------------------------------------------------------
select is(tr.store('A', u, 'a', '[]'), tr.e('upload_not_transcript'), 'store: ' || u || ' gets upload_not_transcript') from unnest(array['AU', 'VI']) u;
select is(tr.reject('A', u, 'transcript_empty'), tr.e('upload_not_transcript'), 'reject: ' || u || ' gets upload_not_transcript') from unnest(array['AU', 'VI']) u;
select is(tr.pasted('A', u), tr.e('upload_not_transcript'), 'pasted: ' || u || ' gets upload_not_transcript') from unnest(array['AU', 'VI', 'F1']) u;
select is(tr.store('A', 'PEND', 'a', '[]'), tr.e('upload_not_ready'), 'store: a pending_upload row gets upload_not_ready');

-- ---------------------------------------------------------------------------
-- get_pasted_transcript_text returns the text unchanged.
-- ---------------------------------------------------------------------------
select tr.snap('read', tr.tables_md5() || tr.others_md5());
select is(tr.pasted('A', 'T1'), jsonb_build_array(E'﻿ZEBRA-PASTE one\r\ntwo', true), 'pasted: A gets the stored text unchanged, CRLF and U+FEFF included');
select is(tr.list('A', 'P1') ->> 'cycle_id', tr.id('P1')::text, 'A lists P1');
select is(tr.tables_md5() || tr.others_md5(), tr.snapped('read'), 'get_pasted_transcript_text and get_cycle_uploads change nothing');

-- ---------------------------------------------------------------------------
-- Stages: forced back to vote.
-- ---------------------------------------------------------------------------
reset role;
select tr.force_status('P1', 'vote');
set local role authenticated;
select is(tr.store('A', 'F1', 'a', '[]'), tr.e('cycle_not_discussing'), 'store in vote gets cycle_not_discussing');
select is(tr.reject('A', 'F1', 'transcript_empty'), tr.e('cycle_not_discussing'), 'reject in vote gets cycle_not_discussing');
select is(tr.pasted('A', 'T1') ->> 1, 'true', 'get_pasted_transcript_text has no stage check');
reset role;
select tr.force_status('P1', 'discuss');
set local role authenticated;

-- ---------------------------------------------------------------------------
-- Store: validation (invalid_transcript; nothing changes).
-- ---------------------------------------------------------------------------
select tr.snap('validation', tr.tables_md5());
select is(tr.store('A', u, t, s), tr.e('invalid_transcript'), 'store: ' || label || ' is invalid_transcript')
  from (values
    ('null text', 'X1', null::text, '[]'::jsonb),
    ('empty text', 'X1', '', '[]'::jsonb),
    ('whitespace-only text', 'X1', E' \n\t ', '[]'::jsonb),
    ('200,001 characters', 'X1', repeat('a', 200001), '[]'::jsonb),
    ('null segments', 'X1', 'a', null::jsonb),
    ('invalid segments', 'X1', 'a', '[{"start_ms": 0, "end_ms": 1}]'::jsonb),
    ('[] on a text/vtt upload', 'V2', 'a', '[]'::jsonb),
    ('[] on an application/x-subrip upload', 'S1', 'a', '[]'::jsonb),
    ('joined texts one character off', 'V2', E'Alice: Hi\nBob: Hello!', '[{"start_ms": 0, "end_ms": 1000, "text": "Alice: Hi"}, {"start_ms": 1000, "end_ms": 2500, "text": "Bob: Hello"}]'::jsonb)
  ) t(label, u, t, s);
select is(tr.tables_md5(), tr.snapped('validation'), 'no invalid store changed an upload or wrote a transcript');

-- ---------------------------------------------------------------------------
-- Store: success.
-- ---------------------------------------------------------------------------
select tr.snap('F1-uploaded-at', tr.row('F1') ->> 'uploaded_at');
select is(tr.store('A', 'F1', E'Alice: Hi\n\nZEBRA-TRANSCRIPT', '[]'), jsonb_build_array('extracting', 27, 0, true), 'store: a plain transcript on a text/plain file');
select is(tr.store('A', 'T1', E'ZEBRA-PASTE one\ntwo', '[]'), jsonb_build_array('extracting', 19, 0, true), 'store: a plain transcript on pasted text');
select is(tr.store('A', 'V1', E'Alice: Hi\nBob: Hello', '[{"start_ms": 0, "end_ms": 1000, "text": "Alice: Hi"}, {"start_ms": 1000, "end_ms": 2500, "text": "Bob: Hello"}]'), jsonb_build_array('extracting', 20, 2, true), 'store: a VTT transcript on a text/vtt file');
select is(tr.store('A', 'E1', repeat('😀', 200000), '[]'), jsonb_build_array('extracting', 200000, 0, true), 'store: 200,000 emoji count as 200,000 characters');
select is(tr.ntranscripts(u), 1, u || ' has one transcript') from unnest(array['F1', 'T1', 'V1', 'E1']) u;
select is((select r ->> 'status' || '/' || coalesce(r ->> 'error_code', 'null') from tr.row(u) r), 'extracting/null', u || ' is extracting with error_code null') from unnest(array['F1', 'T1', 'V1', 'E1']) u;
select is(tr.row('F1') ->> 'uploaded_at', tr.snapped('F1-uploaded-at'), 'store keeps uploaded_at');
select is(tr.transcript('V1') -> 'segments', '[{"start_ms": 0, "end_ms": 1000, "text": "Alice: Hi"}, {"start_ms": 1000, "end_ms": 2500, "text": "Bob: Hello"}]'::jsonb, 'the VTT segments are stored in order');
select is(tr.pasted('A', 'T1'), tr.e('upload_not_ready'), 'pasted: an extracting row gets upload_not_ready');

-- ---------------------------------------------------------------------------
-- Store: idempotency.
-- ---------------------------------------------------------------------------
select tr.snap('idempotent', tr.tables_md5());
select is(tr.store('A', 'V1', E'Alice: Hi\nBob: Hello', '[{"start_ms": 0, "end_ms": 1000, "text": "Alice: Hi"}, {"start_ms": 1000, "end_ms": 2500, "text": "Bob: Hello"}]'), jsonb_build_array('extracting', 20, 2, true), 'an identical second store returns the same result');
select is(tr.tables_md5(), tr.snapped('idempotent'), 'and changes nothing');
select is(tr.store('A', 'V1', E'Alice: Hi\nBob: Hello!', '[{"start_ms": 0, "end_ms": 1000, "text": "Alice: Hi"}, {"start_ms": 1000, "end_ms": 2500, "text": "Bob: Hello!"}]'), tr.e('transcript_already_stored'), 'a different text gets transcript_already_stored');
select is(tr.store('A', 'V1', E'Alice: Hi\nBob: Hello', '[{"start_ms": 0, "end_ms": 1001, "text": "Alice: Hi"}, {"start_ms": 1000, "end_ms": 2500, "text": "Bob: Hello"}]'), tr.e('transcript_already_stored'), 'different segments get transcript_already_stored');
select is(tr.tables_md5(), tr.snapped('idempotent'), 'the stored row is unchanged');
select is(tr.ntranscripts('V1'), 1, 'there is never a second row');

-- ---------------------------------------------------------------------------
-- Reject.
-- ---------------------------------------------------------------------------
select is(tr.reject('A', 'R1', r), tr.e('invalid_reject_reason'), 'reject: ' || coalesce(quote_literal(r), 'null') || ' gets invalid_reject_reason')
  from unnest(array[null, '', 'upload_file_mismatch']) r;
select tr.snap(u, tr.row('R' || n) ->> 'uploaded_at') from (select 'R' || n as u, n from generate_series(1, 7) n) x;
select is(tr.reject('A', 'R' || n, r), jsonb_build_array('rejected', r, true), 'reject: R' || n || ' becomes rejected / ' || r)
  from unnest(array['transcript_bad_encoding', 'transcript_not_text', 'transcript_empty', 'transcript_malformed', 'transcript_no_cues', 'transcript_too_long', 'transcript_too_many_segments']) with ordinality as t(r, n);
select is(
  (select bool_and(tr.row('R' || n) ->> 'uploaded_at' = tr.snapped('R' || n) and tr.row('R' || n) ->> 'uploaded_at' is not null) from generate_series(1, 7) n),
  true,
  'every rejected row keeps its uploaded_at'
);
select tr.snap('no-op', tr.tables_md5());
select is(tr.reject('A', 'R1', 'transcript_empty'), jsonb_build_array('rejected', 'transcript_bad_encoding', true), 'reject on a rejected row returns it unchanged');
select is(tr.reject('A', 'F1', 'transcript_empty'), jsonb_build_array('extracting', null, true), 'reject on an extracting row (reject after store) returns it unchanged');
select is(tr.reject('A', 'PEND', 'transcript_empty'), jsonb_build_array('pending_upload', null, true), 'reject on a pending_upload row returns it unchanged');
select is(tr.tables_md5(), tr.snapped('no-op'), 'the no-op rejects changed nothing');
select is(tr.store('A', 'R1', 'a', '[]'), tr.e('upload_not_ready'), 'store after reject gets upload_not_ready');
select is(tr.create('A', 'P1', 'transcript_text', null, null, 'Recovered', 'N1'), 'uploaded', 'rejected rows no longer count toward the 20 active uploads');

-- ---------------------------------------------------------------------------
-- get_cycle_uploads.
-- ---------------------------------------------------------------------------
select is(
  (select bool_and((select array_agg(k order by k) from jsonb_object_keys(x) k) = array['created_at', 'error_code', 'error_message', 'kind', 'mime_type', 'original_filename', 'size_bytes', 'status', 'storage_path', 'text_length', 'transcript_length', 'transcript_segment_count', 'updated_at', 'upload_id', 'uploaded_at']) from jsonb_array_elements(tr.list('A', 'P1') -> 'uploads') x),
  true,
  'list: every element has exactly the 15 keys'
);
select is(
  (select bool_and(((x -> 'transcript_length') = 'null'::jsonb) = ((x -> 'transcript_segment_count') = 'null'::jsonb)
                   and ((x -> 'transcript_length') <> 'null'::jsonb) = ((x ->> 'upload_id')::uuid in (tr.id('F1'), tr.id('T1'), tr.id('V1'), tr.id('E1'))))
     from jsonb_array_elements(tr.list('A', 'P1') -> 'uploads') x),
  true,
  'list: the two keys are set exactly for uploads with a transcript'
);
select is(
  (select jsonb_build_array(x -> 'transcript_length', x -> 'transcript_segment_count') from jsonb_array_elements(tr.list('A', 'P1') -> 'uploads') x where (x ->> 'upload_id')::uuid = tr.id('V1')),
  '[20, 2]'::jsonb,
  'list: V1 shows 20 characters and 2 segments'
);
select is(
  (select jsonb_build_array(x -> 'transcript_length', x -> 'transcript_segment_count') from jsonb_array_elements(tr.list('A', 'P1') -> 'uploads') x where (x ->> 'upload_id')::uuid = tr.id('E1')),
  '[200000, 0]'::jsonb,
  'list: E1 shows 200,000 characters and 0 segments'
);
select is(
  (select position('ZEBRA' in tr.list('A', 'P1')::text) = 0 and position('Recovered' in tr.list('A', 'P1')::text) = 0),
  true,
  'list: the response contains no pasted text and no transcript text'
);

select is(tr.others_md5(), tr.snapped('others'), 'the RPCs wrote no cycle_events row and changed no cycle, project or member row');

-- ---------------------------------------------------------------------------
-- Transfer: D becomes the facilitator.
-- ---------------------------------------------------------------------------
select tr.transfer('A', 'D');
select is(tr.store('A', 'DT1', 'a', '[]'), tr.e('not_project_facilitator'), 'after the transfer A cannot store');
select is(tr.reject('A', 'DT2', 'transcript_empty'), tr.e('not_project_facilitator'), 'after the transfer A cannot reject');
select is(tr.pasted('A', 'N1'), tr.e('not_project_facilitator'), 'after the transfer A cannot read pasted text');
select is(tr.store('D', 'DT1', 'Hi', '[{"start_ms": 0, "end_ms": 1, "text": "Hi"}]'), jsonb_build_array('extracting', 2, 1, true), 'D stores A''s earlier upload');
select is(tr.reject('D', 'DT2', 'transcript_empty'), jsonb_build_array('rejected', 'transcript_empty', true), 'D rejects A''s earlier upload');
select is(tr.pasted('D', 'N1'), jsonb_build_array('Recovered', true), 'D reads A''s pasted text');

-- ---------------------------------------------------------------------------
-- Stages: closed.
-- ---------------------------------------------------------------------------
select tr.close_cycle('D', 'P1');
select is((select fc.status from public.feedback_cycles fc where fc.id = tr.id('P1')), 'closed', 'P1 is closed');
reset role;
set local role authenticated;
select is(tr.store('D', 'CL1', 'Done', '[{"start_ms": 0, "end_ms": 1, "text": "Done"}]'), jsonb_build_array('extracting', 4, 1, true), 'store works in closed');
select is(tr.reject('D', 'N1', 'transcript_empty'), jsonb_build_array('rejected', 'transcript_empty', true), 'reject works in closed');
reset role;

select * from finish();

rollback;
