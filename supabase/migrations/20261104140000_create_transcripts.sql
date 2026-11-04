-- Task 29: parse transcript files and pasted text.
--
-- The project's current facilitator turns an uploaded .txt, .vtt or .srt
-- transcript file, or pasted transcript text, into one stored transcript:
-- normalized text plus timestamped segments. The browser parses; the
-- database re-validates and stores. #32 reads the result.
--
-- Decisions:
--
--   1. Parse in the browser, store through an RPC, no Edge Function. The file
--      is the facilitator's own content, already readable by them through
--      #28's meeting-media SELECT policy. The browser gets a 60-second signed
--      URL, fetches the bytes, decodes and parses them with one pure
--      TypeScript parser (app/src/uploads/transcriptParser.ts) and calls
--      store_transcript. The database does not trust the client's parse: it
--      re-validates every limit and shape below. It does not check that the
--      transcript matches the file, because the facilitator could upload any
--      file anyway. Files never pass through an Edge Function.
--   3. Encodings (client). A UTF-8, UTF-16LE or UTF-16BE byte order mark
--      decides the encoding and is removed; a UTF-32 mark is refused; without
--      a mark the bytes must be valid UTF-8. Text containing U+0000 is not
--      text. Pasted text loses one leading U+FEFF. No Unicode normalization.
--      Lengths are code points, as Postgres char_length counts them.
--   4. Normalization (client). CRLF, LF and lone CR end a line; C0 controls
--      other than tab, LF and CR, and DEL, are removed. Plain text keeps its
--      lines (trailing whitespace removed, leading and trailing blank lines
--      removed, three or more line breaks become two) and has no segments.
--      A VTT or SRT cue's text lines are joined with one space and its
--      whitespace collapsed; a cue with no text is dropped. The transcript
--      text of a VTT or SRT file is its segment texts joined with \n, in
--      file order, so evidence quotes (#32) are substrings of it.
--   5. Cue rules (client): WebVTT and SRT timing lines, timestamps of at most
--      24 hours, end >= start, starts that never decrease; markup removed.
--   6. Limits. At most 200,000 characters of text and 20,000 segments; every
--      timestamp is an integer number of milliseconds from 0 to 86,400,000.
--      The same literals are pinned by pgTAP and app/src/uploads/
--      uploadRules.ts.
--   7. Shape. public.transcripts holds at most one row per upload. segments
--      is a JSON array of objects with exactly start_ms, end_ms and text, in
--      file order; a speaker name lives in the text as a "Name: " prefix.
--      private.transcript_segments_valid enforces the shape in a table
--      CHECK, so #31's service-role inserts get the same limits. Rows never
--      change (transcript_immutable); deleting the upload deletes its
--      transcript.
--   8. Statuses. A stored transcript moves its upload uploaded -> extracting.
--      A file the parser refuses moves it uploaded -> rejected with one of
--      transcript_bad_encoding, transcript_not_text, transcript_empty,
--      transcript_malformed, transcript_no_cues, transcript_too_long,
--      transcript_too_many_segments. rejected stays terminal and frees the
--      active-upload slot. The parser's line number is never stored. #28's
--      uploaded_at CHECK is replaced: pending_upload => null; rejected =>
--      either (a row rejected after upload keeps its uploaded_at); every
--      other status => not null.
--   9. Re-parsing and idempotency. The parser is deterministic.
--      store_transcript for an upload that already has a transcript returns
--      the stored result unchanged when text and segments are identical (a
--      lost response, a second tab) and raises transcript_already_stored
--      when they differ. A stored transcript is never replaced; a network,
--      download or store failure leaves the upload uploaded so the read can
--      be repeated for the same row.
--
-- Table. public.transcripts is default-deny: RLS enabled with no policy, no
-- privilege for PUBLIC, anon or authenticated, and service_role keeps
-- exactly select, insert, delete (#31, #32). It is not in supabase_realtime.
--
-- Check orders (each failing step changes nothing):
--
--   store_transcript(p_upload_id, p_text, p_segments)
--     1. null user                                -> 42501 not_project_member
--     2. null or unknown upload, or not a member  -> P0001 upload_not_found
--     3. lock projects FOR SHARE; not the facilitator
--                                                 -> 42501 not_project_facilitator
--     4. lock the cycle FOR UPDATE, then the upload FOR UPDATE (gone ->
--        upload_not_found); cycle not discuss or closed
--                                                 -> P0001 cycle_not_discussing
--     5. kind not transcript_file / transcript_text
--                                                 -> P0001 upload_not_transcript
--     6. a transcript exists: identical -> return it; different
--                                                 -> P0001 transcript_already_stored
--     7. status not uploaded                      -> P0001 upload_not_ready
--     8. text or segments invalid                 -> P0001 invalid_transcript
--     9. insert; the upload becomes extracting with error_code null
--
--   reject_transcript_upload(p_upload_id, p_reason)
--     1-5 as store_transcript; a reason outside decision 8's seven
--                                                 -> P0001 invalid_reject_reason
--     uploaded -> rejected with error_code = p_reason; any other status is a
--     no-op returning the current row.
--
--   get_pasted_transcript_text(p_upload_id)
--     1-3 as store_transcript without the lock, no stage check; kind not
--     transcript_text -> P0001 upload_not_transcript; status not uploaded
--     -> P0001 upload_not_ready.

-- ---------------------------------------------------------------------------
-- The segments shape (decisions 6 and 7).
-- ---------------------------------------------------------------------------
create function private.transcript_segments_valid(p_segments jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  elem jsonb;
  prev_start integer := 0;
  start_ms integer;
  end_ms integer;
  seg_text text;
begin
  if p_segments is null
     or pg_catalog.jsonb_typeof(p_segments) <> 'array'
     or pg_catalog.jsonb_array_length(p_segments) > 20000 then
    return false;
  end if;

  for elem in
    select x.value
      from pg_catalog.jsonb_array_elements(p_segments) with ordinality as x(value, ord)
     order by x.ord
  loop
    if pg_catalog.jsonb_typeof(elem) <> 'object'
       or (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(elem) k)
          is distinct from array['end_ms', 'start_ms', 'text']
       or pg_catalog.jsonb_typeof(elem -> 'start_ms') <> 'number'
       or pg_catalog.jsonb_typeof(elem -> 'end_ms') <> 'number'
       or pg_catalog.jsonb_typeof(elem -> 'text') <> 'string'
       -- Integers only: no sign, no fraction, no exponent, at most 8 digits.
       or (elem ->> 'start_ms') !~ '^[0-9]{1,8}$'
       or (elem ->> 'end_ms') !~ '^[0-9]{1,8}$' then
      return false;
    end if;

    start_ms := (elem ->> 'start_ms')::integer;
    end_ms := (elem ->> 'end_ms')::integer;
    seg_text := elem ->> 'text';

    if start_ms > 86400000
       or end_ms > 86400000
       or end_ms < start_ms
       or start_ms < prev_start
       or pg_catalog.char_length(seg_text) not between 1 and 200000
       or seg_text !~ '[^[:space:]]'
       or pg_catalog.strpos(seg_text, E'\n') > 0
       or pg_catalog.strpos(seg_text, E'\r') > 0 then
      return false;
    end if;

    prev_start := start_ms;
  end loop;

  return true;
end;
$$;

revoke all on function private.transcript_segments_valid(jsonb) from public;
revoke all on function private.transcript_segments_valid(jsonb) from anon, authenticated, service_role;

-- A CHECK runs its function with the inserting role's privileges, so
-- service_role (#31's inserts) needs EXECUTE. No client role gets it.
grant execute on function private.transcript_segments_valid(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- transcripts
-- ---------------------------------------------------------------------------
create table public.transcripts (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid not null,
  text text not null,
  segments jsonb not null default '[]',
  created_at timestamptz not null default now(),
  constraint transcripts_upload_id_key unique (upload_id),
  constraint transcripts_upload_id_fkey foreign key (upload_id)
    references public.meeting_uploads (id) on delete cascade,
  constraint transcripts_text_check check (
    pg_catalog.char_length(text) between 1 and 200000
    and text ~ '[^[:space:]]'
  ),
  constraint transcripts_segments_check check (
    private.transcript_segments_valid(segments)
  )
);

alter table public.transcripts enable row level security;

revoke all on table public.transcripts from public;
revoke all on table public.transcripts from anon, authenticated, service_role;

grant select, insert, delete on table public.transcripts to service_role;

create function private.guard_transcript_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'transcript_immutable';
end;
$$;

revoke all on function private.guard_transcript_update() from public;
revoke all on function private.guard_transcript_update() from anon, authenticated, service_role;

create trigger transcripts_guard_update
  before update on public.transcripts
  for each row
  execute function private.guard_transcript_update();

-- ---------------------------------------------------------------------------
-- meeting_uploads.uploaded_at (decision 8).
-- ---------------------------------------------------------------------------
alter table public.meeting_uploads
  drop constraint meeting_uploads_uploaded_at_check;

alter table public.meeting_uploads
  add constraint meeting_uploads_uploaded_at_check check (
    case
      when status = 'pending_upload' then uploaded_at is null
      when status = 'rejected' then true
      else uploaded_at is not null
    end
  );

-- ---------------------------------------------------------------------------
-- store_transcript
-- ---------------------------------------------------------------------------
create function public.store_transcript(p_upload_id uuid, p_text text, p_segments jsonb)
returns table (
  upload_id uuid,
  status text,
  text_length integer,
  segment_count integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid;
  upload_cycle uuid;
  cycle_project uuid;
  cycle_status text;
  stored public.meeting_uploads%rowtype;
  existing public.transcripts%rowtype;
  joined text;
begin
  caller := (select auth.uid());

  if caller is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- An upload's cycle_id and a cycle's project_id never change. An unknown
  -- upload and one the caller cannot see get the same error.
  select u.cycle_id, fc.project_id
    into upload_cycle, cycle_project
    from public.meeting_uploads u
    join public.feedback_cycles fc on fc.id = u.cycle_id
   where u.id = p_upload_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = 'P0001', message = 'upload_not_found';
  end if;

  perform 1 from public.projects p where p.id = cycle_project for share;

  if not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
  end if;

  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = upload_cycle
     for update;

  select u.*
    into stored
    from public.meeting_uploads u
   where u.id = p_upload_id
     for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'upload_not_found';
  end if;

  if cycle_status is null or cycle_status not in ('discuss', 'closed') then
    raise exception using errcode = 'P0001', message = 'cycle_not_discussing';
  end if;

  if stored.kind not in ('transcript_file', 'transcript_text') then
    raise exception using errcode = 'P0001', message = 'upload_not_transcript';
  end if;

  -- Decision 9: an identical second call returns the stored result.
  select t.*
    into existing
    from public.transcripts t
   where t.upload_id = p_upload_id;

  if found then
    if existing.text is not distinct from p_text
       and existing.segments is not distinct from p_segments then
      return query
        select stored.id, stored.status,
               pg_catalog.char_length(existing.text)::integer,
               pg_catalog.jsonb_array_length(existing.segments)::integer;
      return;
    end if;
    raise exception using errcode = 'P0001', message = 'transcript_already_stored';
  end if;

  if stored.status <> 'uploaded' then
    raise exception using errcode = 'P0001', message = 'upload_not_ready';
  end if;

  if p_text is null
     or pg_catalog.char_length(p_text) not between 1 and 200000
     or p_text !~ '[^[:space:]]'
     or not private.transcript_segments_valid(p_segments) then
    raise exception using errcode = 'P0001', message = 'invalid_transcript';
  end if;

  if pg_catalog.jsonb_array_length(p_segments) = 0 then
    -- A VTT or SRT file always has timed segments.
    if stored.mime_type in ('text/vtt', 'application/x-subrip') then
      raise exception using errcode = 'P0001', message = 'invalid_transcript';
    end if;
  else
    select pg_catalog.string_agg(x.value ->> 'text', E'\n' order by x.ord)
      into joined
      from pg_catalog.jsonb_array_elements(p_segments) with ordinality as x(value, ord);

    if joined is distinct from p_text then
      raise exception using errcode = 'P0001', message = 'invalid_transcript';
    end if;
  end if;

  insert into public.transcripts (upload_id, text, segments)
  values (p_upload_id, p_text, p_segments);

  update public.meeting_uploads u
     set status = 'extracting',
         error_code = null
   where u.id = p_upload_id;

  return query
    select p_upload_id, 'extracting'::text,
           pg_catalog.char_length(p_text)::integer,
           pg_catalog.jsonb_array_length(p_segments)::integer;
end;
$$;

revoke all on function public.store_transcript(uuid, text, jsonb) from public;
revoke all on function public.store_transcript(uuid, text, jsonb) from anon, authenticated, service_role;

grant execute on function public.store_transcript(uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- reject_transcript_upload
-- ---------------------------------------------------------------------------
create function public.reject_transcript_upload(p_upload_id uuid, p_reason text)
returns table (
  upload_id uuid,
  status text,
  error_code text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid;
  upload_cycle uuid;
  cycle_project uuid;
  cycle_status text;
  stored public.meeting_uploads%rowtype;
begin
  caller := (select auth.uid());

  if caller is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  select u.cycle_id, fc.project_id
    into upload_cycle, cycle_project
    from public.meeting_uploads u
    join public.feedback_cycles fc on fc.id = u.cycle_id
   where u.id = p_upload_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = 'P0001', message = 'upload_not_found';
  end if;

  perform 1 from public.projects p where p.id = cycle_project for share;

  if not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
  end if;

  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = upload_cycle
     for update;

  select u.*
    into stored
    from public.meeting_uploads u
   where u.id = p_upload_id
     for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'upload_not_found';
  end if;

  if cycle_status is null or cycle_status not in ('discuss', 'closed') then
    raise exception using errcode = 'P0001', message = 'cycle_not_discussing';
  end if;

  if stored.kind not in ('transcript_file', 'transcript_text') then
    raise exception using errcode = 'P0001', message = 'upload_not_transcript';
  end if;

  if p_reason is null
     or p_reason not in ('transcript_bad_encoding', 'transcript_not_text',
                         'transcript_empty', 'transcript_malformed',
                         'transcript_no_cues', 'transcript_too_long',
                         'transcript_too_many_segments') then
    raise exception using errcode = 'P0001', message = 'invalid_reject_reason';
  end if;

  if stored.status = 'uploaded' then
    -- uploaded_at is kept (decision 8).
    update public.meeting_uploads u
       set status = 'rejected',
           error_code = p_reason
     where u.id = p_upload_id;
  end if;

  return query
    select u.id, u.status, u.error_code
      from public.meeting_uploads u
     where u.id = p_upload_id;
end;
$$;

revoke all on function public.reject_transcript_upload(uuid, text) from public;
revoke all on function public.reject_transcript_upload(uuid, text) from anon, authenticated, service_role;

grant execute on function public.reject_transcript_upload(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- get_pasted_transcript_text
-- ---------------------------------------------------------------------------
create function public.get_pasted_transcript_text(p_upload_id uuid)
returns table (
  upload_id uuid,
  pasted_text text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cycle_project uuid;
  stored public.meeting_uploads%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  select fc.project_id
    into cycle_project
    from public.meeting_uploads u
    join public.feedback_cycles fc on fc.id = u.cycle_id
   where u.id = p_upload_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = 'P0001', message = 'upload_not_found';
  end if;

  if not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
  end if;

  select u.*
    into stored
    from public.meeting_uploads u
   where u.id = p_upload_id;

  if stored.kind <> 'transcript_text' then
    raise exception using errcode = 'P0001', message = 'upload_not_transcript';
  end if;

  if stored.status <> 'uploaded' then
    raise exception using errcode = 'P0001', message = 'upload_not_ready';
  end if;

  return query
    select stored.id, stored.pasted_text;
end;
$$;

revoke all on function public.get_pasted_transcript_text(uuid) from public;
revoke all on function public.get_pasted_transcript_text(uuid) from anon, authenticated, service_role;

grant execute on function public.get_pasted_transcript_text(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_cycle_uploads (#28), with transcript_length and
-- transcript_segment_count. Same signature, checks and order; it still never
-- returns pasted_text or transcript text.
-- ---------------------------------------------------------------------------
create or replace function public.get_cycle_uploads(p_cycle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cycle_project uuid;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  select fc.project_id
    into cycle_project
    from public.feedback_cycles fc
   where fc.id = p_cycle_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  if not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
  end if;

  return pg_catalog.jsonb_build_object(
    'cycle_id', p_cycle_id,
    'uploads', coalesce(
      (select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'upload_id', u.id,
                  'kind', u.kind,
                  'status', u.status,
                  'original_filename', u.original_filename,
                  'mime_type', u.mime_type,
                  'size_bytes', u.size_bytes,
                  'text_length', case
                                   when u.kind = 'transcript_text'
                                     then pg_catalog.char_length(u.pasted_text)
                                 end,
                  'storage_path', u.storage_path,
                  'error_code', u.error_code,
                  'error_message', u.error_message,
                  'created_at', u.created_at,
                  'uploaded_at', u.uploaded_at,
                  'updated_at', u.updated_at,
                  'transcript_length', pg_catalog.char_length(t.text),
                  'transcript_segment_count', pg_catalog.jsonb_array_length(t.segments)
                )
                order by u.created_at desc, u.id
              )
         from public.meeting_uploads u
         left join public.transcripts t on t.upload_id = u.id
        where u.cycle_id = p_cycle_id),
      '[]'::jsonb
    )
  );
end;
$$;

revoke all on function public.get_cycle_uploads(uuid) from public;
revoke all on function public.get_cycle_uploads(uuid) from anon, authenticated, service_role;

grant execute on function public.get_cycle_uploads(uuid) to authenticated;
