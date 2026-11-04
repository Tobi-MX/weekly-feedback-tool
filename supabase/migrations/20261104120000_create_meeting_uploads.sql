-- Task 28: meeting upload registration and signed uploads.
--
-- The project's current facilitator adds the meeting record of a
-- retrospective in discuss or closed: an audio recording, a video recording,
-- a transcript file, or pasted transcript text. The database registers each
-- upload and generates its storage path; the browser uploads the file
-- straight to the private meeting-media bucket with a Storage signed upload
-- URL; a completion RPC checks the stored object before the upload counts as
-- uploaded. Pasted text is stored in the database. #29-#32 start from the
-- uploaded rows made here.
--
-- Decisions:
--
--   1. Register, upload, complete. create_meeting_upload validates the
--      request and inserts a pending_upload row with a server-generated
--      path. The browser asks Storage for a signed upload URL for exactly
--      that path (createSignedUploadUrl) and uploads to it
--      (uploadToSignedUrl); Storage allows that only through the INSERT
--      policy below. complete_meeting_upload checks the stored object and
--      sets uploaded or rejected. A Postgres function cannot sign Storage
--      URLs, so "issue a signed storage URL" (tech-stack section 6) becomes
--      "register; the browser gets the signed upload URL from Storage under
--      the facilitator-only insert policy". No Edge Function and no
--      service-role key are involved, and no RPC returns the upload token.
--   2. The path never contains the file name. storage_path is
--      {project_id}/{cycle_id}/{upload_id}.{ext} (lowercase UUIDs, ext the
--      lowercased allowlisted extension). The original name is kept in
--      original_filename for display only. The Storage policies match
--      name = meeting_uploads.storage_path exactly, so a traversal (../), an
--      encoded path, another project's prefix, or an unregistered name never
--      matches.
--   3. The extension decides the kind's file type; the MIME type is derived
--      from it. The client never sends a MIME type. The RPC returns the
--      canonical type and the browser uploads a Blob of that type. The
--      bucket's allowed_mime_types is the set of canonical types.
--        audio            mp3 audio/mpeg, m4a audio/mp4, wav audio/wav,
--                         ogg audio/ogg, webm audio/webm    up to 209715200 bytes
--        video            mp4 video/mp4, mov video/quicktime,
--                         webm video/webm                   up to 209715200 bytes
--        transcript_file  txt text/plain, vtt text/vtt,
--                         srt application/x-subrip          up to 10485760 bytes
--        transcript_text  no file; 1-200,000 characters (code points) with a
--                         non-whitespace character, stored as given
--      Content is not sniffed; a renamed file fails later, in #29-#31.
--   4. File names: 1-255 characters after trimming spaces; no / or \; no C0
--      or C1 control character, no DEL, no bidi control (U+202A-U+202E,
--      U+2066-U+2069); a non-empty base name before the last dot. The
--      extension is the text after the last dot, lowercased.
--   5. Who and when. Only the project's current facilitator registers,
--      completes, lists and reads. Registering and completing work only
--      while the cycle is discuss or closed (cycle_not_discussing). Listing
--      works in every stage. Members, the project owner when not the
--      facilitator, non-members and anon get nothing.
--   6. Statuses. pending_upload -> uploaded | rejected, then #29-#33's
--      transcribing, extracting, draft_ready, confirmed, published, failed.
--      transcript_text starts at uploaded. rejected is terminal: the stored
--      object did not match the row (upload_file_mismatch), or a
--      pending_upload row had no object 24 hours after registration
--      (upload_abandoned).
--   7. Completion checks the real object in storage.objects (bucket
--      meeting-media, name = storage_path): no object raises
--      upload_file_missing and changes nothing (past 24 hours the row becomes
--      rejected / upload_abandoned instead); a size or mimetype that differs
--      from the row makes it rejected / upload_file_mismatch; otherwise it is
--      uploaded. A call on any other status is a no-op returning the row.
--   8. No overwrite, no client delete. storage.objects gets exactly two
--      policies for this bucket: INSERT for a pending_upload row less than
--      24 hours old (current facilitator, cycle in discuss or closed) and
--      SELECT for any registered row (current facilitator). There is no
--      UPDATE or DELETE policy, so upsert, overwrite, move and remove are
--      refused.
--   9. Limits. At most 20 uploads per cycle that are neither rejected nor
--      abandoned (pending_upload older than 24 hours), and at most 50 rows
--      per cycle in total (upload_limit_reached). create_meeting_upload first
--      marks the cycle's abandoned rows that have no object rejected /
--      upload_abandoned.
--  10. Orphaned objects are documented, not deleted: a rejected row's
--      object, an upload landing after its row was abandoned, and an object
--      left by a cycle or project an operator deleted (the row cascades, the
--      object stays). Clients cannot delete objects (decision 8).
--      _docs/tech-stack.md section 12 lists them; deleting them is #44's
--      runbook and in-product removal is #116.
--
-- Table. public.meeting_uploads is default-deny: RLS enabled with no policy,
-- no privilege for PUBLIC, anon or authenticated, and only service_role
-- keeps select, insert, update, delete (for #30-#32's functions). It is not
-- in supabase_realtime and no view reads it. Only the three RPCs and the two
-- Storage helpers below read it.
--
-- Check orders (each failing step changes nothing):
--
--   create_meeting_upload(p_cycle_id, p_kind, p_filename, p_size_bytes, p_pasted_text)
--     1. null user, null or unknown cycle, or not a member
--                                                 -> 42501 not_project_member
--     2. lock projects FOR SHARE; not the current facilitator
--                                                 -> 42501 not_project_facilitator
--     3. lock the cycle FOR UPDATE; status not discuss or closed
--                                                 -> P0001 cycle_not_discussing
--     4. p_kind null or unknown                   -> P0001 invalid_upload_kind
--     5. file kinds: text given                   -> P0001 invalid_transcript_text
--        bad name or extension, null or non-positive size
--                                                 -> P0001 invalid_upload_file
--        size over the kind's limit               -> P0001 upload_too_large
--     6. transcript_text: a name or size given    -> P0001 invalid_upload_file
--        text null, blank or over 200,000         -> P0001 invalid_transcript_text
--     7. mark abandoned rows; 20 active or 50 rows
--                                                 -> P0001 upload_limit_reached
--     8. insert; return (upload_id, kind, status, storage_path, mime_type)
--
--   complete_meeting_upload(p_upload_id)
--     1. null user                                -> 42501 not_project_member
--     2. null or unknown upload, or not a member  -> P0001 upload_not_found
--     3. lock projects FOR SHARE; not the facilitator
--                                                 -> 42501 not_project_facilitator
--     4. lock the cycle FOR UPDATE; re-read the upload (gone -> P0001
--        upload_not_found); status not discuss or closed
--                                                 -> P0001 cycle_not_discussing
--     5. decision 7                               -> P0001 upload_file_missing
--
--   get_cycle_uploads(p_cycle_id)
--     1. null user, null or unknown cycle, or not a member
--                                                 -> 42501 not_project_member
--     2. not the current facilitator              -> 42501 not_project_facilitator
--     3. return {cycle_id, uploads}
--
-- Locks. The two writes take #24's order: membership check, projects FOR
-- SHARE, facilitator check, cycle FOR UPDATE. Every write to a cycle's
-- uploads holds the cycle lock, so the limits stay exact and two tabs
-- completing the same row serialize.

-- ---------------------------------------------------------------------------
-- meeting_uploads
-- ---------------------------------------------------------------------------
create table public.meeting_uploads (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null,
  kind text not null,
  status text not null,
  storage_path text unique,
  original_filename text,
  mime_type text,
  size_bytes bigint,
  pasted_text text,
  error_code text,
  error_message text,
  provider_job_id text,
  -- Never null when written. Null after the creator's auth user is deleted.
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  uploaded_at timestamptz,
  constraint meeting_uploads_cycle_id_fkey foreign key (cycle_id)
    references public.feedback_cycles (id) on delete cascade,
  constraint meeting_uploads_created_by_fkey foreign key (created_by)
    references auth.users (id) on delete set null,
  constraint meeting_uploads_kind_check check (
    kind in ('audio', 'video', 'transcript_file', 'transcript_text')
  ),
  constraint meeting_uploads_status_check check (
    status in ('pending_upload', 'uploaded', 'transcribing', 'extracting',
               'draft_ready', 'confirmed', 'published', 'failed', 'rejected')
  ),
  -- File kinds carry every file field and no text; pasted text is the reverse
  -- and never waits for a file.
  constraint meeting_uploads_fields_check check (
    case
      when kind = 'transcript_text' then
        storage_path is null and original_filename is null
        and mime_type is null and size_bytes is null
        and pasted_text is not null and status <> 'pending_upload'
      else
        storage_path is not null and original_filename is not null
        and mime_type is not null and size_bytes is not null
        and pasted_text is null
    end
  ),
  -- Decision 3's table.
  constraint meeting_uploads_size_check check (
    size_bytes is null
    or size_bytes between 1 and (case when kind = 'transcript_file' then 10485760 else 209715200 end)
  ),
  constraint meeting_uploads_mime_type_check check (
    mime_type is null
    or (kind = 'audio' and mime_type in ('audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm'))
    or (kind = 'video' and mime_type in ('video/mp4', 'video/quicktime', 'video/webm'))
    or (kind = 'transcript_file' and mime_type in ('text/plain', 'text/vtt', 'application/x-subrip'))
  ),
  constraint meeting_uploads_pasted_text_check check (
    pasted_text is null
    or (pg_catalog.char_length(pasted_text) between 1 and 200000
        and pasted_text ~ '[^[:space:]]')
  ),
  constraint meeting_uploads_original_filename_check check (
    original_filename is null
    or pg_catalog.char_length(original_filename) between 1 and 255
  ),
  constraint meeting_uploads_error_code_check check (
    error_code is null or error_code ~ '^[a-z_]{1,64}$'
  ),
  constraint meeting_uploads_error_message_check check (
    error_message is null or pg_catalog.char_length(error_message) between 1 and 500
  ),
  constraint meeting_uploads_provider_job_id_check check (
    provider_job_id is null or pg_catalog.char_length(provider_job_id) between 1 and 200
  ),
  constraint meeting_uploads_uploaded_at_check check (
    (status in ('pending_upload', 'rejected')) = (uploaded_at is null)
  )
);

create index meeting_uploads_cycle_id_created_at_idx
  on public.meeting_uploads (cycle_id, created_at);

alter table public.meeting_uploads enable row level security;

revoke all on table public.meeting_uploads from public;
revoke all on table public.meeting_uploads from anon, authenticated, service_role;

grant select, insert, update, delete on table public.meeting_uploads to service_role;

create function private.guard_meeting_upload_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.cycle_id is distinct from old.cycle_id
     or new.kind is distinct from old.kind
     or new.storage_path is distinct from old.storage_path
     or new.original_filename is distinct from old.original_filename
     or new.mime_type is distinct from old.mime_type
     or new.size_bytes is distinct from old.size_bytes
     or new.pasted_text is distinct from old.pasted_text
     or new.created_at is distinct from old.created_at
     -- created_by may only become null (the on delete set null action).
     or (new.created_by is distinct from old.created_by and new.created_by is not null) then
    raise exception using errcode = 'P0001', message = 'meeting_upload_immutable_column';
  end if;

  -- pending_upload ends in uploaded or rejected; nothing returns to
  -- pending_upload; rejected is terminal. Later transitions belong to
  -- #29-#34.
  if new.status is distinct from old.status
     and ((old.status = 'pending_upload' and new.status not in ('uploaded', 'rejected'))
          or new.status = 'pending_upload'
          or old.status = 'rejected') then
    raise exception using errcode = 'P0001', message = 'invalid_meeting_upload_transition';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_meeting_upload_update() from public;
revoke all on function private.guard_meeting_upload_update() from anon, authenticated, service_role;

-- The guard runs before set_updated_at (BEFORE triggers fire by name).
create trigger meeting_uploads_guard_update
  before update on public.meeting_uploads
  for each row
  execute function private.guard_meeting_upload_update();

create trigger meeting_uploads_set_updated_at
  before update on public.meeting_uploads
  for each row
  execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- The meeting-media bucket (decision 3; decision 12 in the issue for the
-- project-wide limit in supabase/config.toml).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'meeting-media',
  'meeting-media',
  false,
  209715200,
  array[
    'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm',
    'video/mp4', 'video/quicktime', 'video/webm',
    'text/plain', 'text/vtt', 'application/x-subrip'
  ]
);

-- ---------------------------------------------------------------------------
-- Storage policy helpers. Policies run as the caller, so authenticated
-- executes them; they read meeting_uploads as the definer.
-- ---------------------------------------------------------------------------
create function private.can_upload_meeting_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
     and exists (
       select 1
         from public.meeting_uploads u
         join public.feedback_cycles fc on fc.id = u.cycle_id
        where u.storage_path = p_name
          and u.status = 'pending_upload'
          and u.created_at > pg_catalog.now() - interval '24 hours'
          and fc.status in ('discuss', 'closed')
          and private.is_project_facilitator(fc.project_id)
     );
$$;

create function private.can_read_meeting_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
     and exists (
       select 1
         from public.meeting_uploads u
         join public.feedback_cycles fc on fc.id = u.cycle_id
        where u.storage_path = p_name
          and private.is_project_facilitator(fc.project_id)
     );
$$;

revoke all on function private.can_upload_meeting_object(text) from public;
revoke all on function private.can_upload_meeting_object(text) from anon, authenticated, service_role;
revoke all on function private.can_read_meeting_object(text) from public;
revoke all on function private.can_read_meeting_object(text) from anon, authenticated, service_role;

grant execute on function private.can_upload_meeting_object(text) to authenticated;
grant execute on function private.can_read_meeting_object(text) to authenticated;

-- Exactly two policies for this bucket and no UPDATE or DELETE (decision 8).
create policy meeting_media_insert_facilitator
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'meeting-media' and private.can_upload_meeting_object(name));

create policy meeting_media_select_facilitator
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'meeting-media' and private.can_read_meeting_object(name));

-- ---------------------------------------------------------------------------
-- create_meeting_upload
-- ---------------------------------------------------------------------------
create function public.create_meeting_upload(
  p_cycle_id uuid,
  p_kind text,
  p_filename text,
  p_size_bytes bigint,
  p_pasted_text text
)
returns table (
  upload_id uuid,
  kind text,
  status text,
  storage_path text,
  mime_type text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid;
  cycle_project uuid;
  cycle_status text;
  clean_name text;
  name_parts text[];
  ext text;
  canonical text;
  size_limit bigint;
  new_id uuid := gen_random_uuid();
  new_path text;
begin
  caller := (select auth.uid());

  if caller is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- project_id never changes, so it can be read before the locks.
  select fc.project_id
    into cycle_project
    from public.feedback_cycles fc
   where fc.id = p_cycle_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- Serialize with transfer_facilitator, then check the role as it is now.
  perform 1 from public.projects p where p.id = cycle_project for share;

  if not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
  end if;

  -- Serialize with every other upload write of this cycle (the limits) and
  -- with stage changes.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = p_cycle_id
     for update;

  if cycle_status is null or cycle_status not in ('discuss', 'closed') then
    raise exception using errcode = 'P0001', message = 'cycle_not_discussing';
  end if;

  if p_kind is null
     or p_kind not in ('audio', 'video', 'transcript_file', 'transcript_text') then
    raise exception using errcode = 'P0001', message = 'invalid_upload_kind';
  end if;

  if p_kind = 'transcript_text' then
    if p_filename is not null or p_size_bytes is not null then
      raise exception using errcode = 'P0001', message = 'invalid_upload_file';
    end if;

    if p_pasted_text is null
       or pg_catalog.char_length(p_pasted_text) not between 1 and 200000
       or p_pasted_text !~ '[^[:space:]]' then
      raise exception using errcode = 'P0001', message = 'invalid_transcript_text';
    end if;
  else
    if p_pasted_text is not null then
      raise exception using errcode = 'P0001', message = 'invalid_transcript_text';
    end if;

    -- Decision 4. The base name is everything before the last dot and must
    -- not be empty; the extension is everything after it.
    clean_name := pg_catalog.btrim(p_filename);
    name_parts := pg_catalog.regexp_match(clean_name, '^(.+)\.([^.]+)$');
    ext := pg_catalog.lower(name_parts[2]);

    canonical := case
      when p_kind = 'audio' then
        case ext
          when 'mp3' then 'audio/mpeg'
          when 'm4a' then 'audio/mp4'
          when 'wav' then 'audio/wav'
          when 'ogg' then 'audio/ogg'
          when 'webm' then 'audio/webm'
        end
      when p_kind = 'video' then
        case ext
          when 'mp4' then 'video/mp4'
          when 'mov' then 'video/quicktime'
          when 'webm' then 'video/webm'
        end
      else
        case ext
          when 'txt' then 'text/plain'
          when 'vtt' then 'text/vtt'
          when 'srt' then 'application/x-subrip'
        end
    end;

    if clean_name is null
       or pg_catalog.char_length(clean_name) not between 1 and 255
       or clean_name ~ '[/\\\u0001-\u001f\u007f-\u009f‪-‮⁦-⁩]'
       or name_parts is null
       or canonical is null
       or p_size_bytes is null
       or p_size_bytes < 1 then
      raise exception using errcode = 'P0001', message = 'invalid_upload_file';
    end if;

    size_limit := case when p_kind = 'transcript_file' then 10485760 else 209715200 end;
    if p_size_bytes > size_limit then
      raise exception using errcode = 'P0001', message = 'upload_too_large';
    end if;
  end if;

  -- Decision 9: the cycle's abandoned rows with no object become rejected
  -- first, so they free their slot.
  update public.meeting_uploads u
     set status = 'rejected',
         error_code = 'upload_abandoned'
   where u.cycle_id = p_cycle_id
     and u.status = 'pending_upload'
     and u.created_at <= pg_catalog.now() - interval '24 hours'
     and not exists (
       select 1
         from storage.objects o
        where o.bucket_id = 'meeting-media'
          and o.name = u.storage_path
     );

  if (select count(*) from public.meeting_uploads u where u.cycle_id = p_cycle_id) >= 50
     or (select count(*)
           from public.meeting_uploads u
          where u.cycle_id = p_cycle_id
            and u.status <> 'rejected'
            and not (u.status = 'pending_upload'
                     and u.created_at <= pg_catalog.now() - interval '24 hours')) >= 20 then
    raise exception using errcode = 'P0001', message = 'upload_limit_reached';
  end if;

  if p_kind = 'transcript_text' then
    insert into public.meeting_uploads (id, cycle_id, kind, status, pasted_text, created_by, uploaded_at)
    values (new_id, p_cycle_id, p_kind, 'uploaded', p_pasted_text, caller, pg_catalog.now());

    return query
      select new_id, p_kind, 'uploaded'::text, null::text, null::text;
  else
    new_path := cycle_project::text || '/' || p_cycle_id::text || '/' || new_id::text || '.' || ext;

    insert into public.meeting_uploads (id, cycle_id, kind, status, storage_path, original_filename, mime_type, size_bytes, created_by)
    values (new_id, p_cycle_id, p_kind, 'pending_upload', new_path, clean_name, canonical, p_size_bytes, caller);

    return query
      select new_id, p_kind, 'pending_upload'::text, new_path, canonical;
  end if;
end;
$$;

revoke all on function public.create_meeting_upload(uuid, text, text, bigint, text) from public;
revoke all on function public.create_meeting_upload(uuid, text, text, bigint, text) from anon, authenticated, service_role;

grant execute on function public.create_meeting_upload(uuid, text, text, bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- complete_meeting_upload
-- ---------------------------------------------------------------------------
create function public.complete_meeting_upload(p_upload_id uuid)
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
  object_metadata jsonb;
  object_found boolean;
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

  -- Re-read under the locks: a second tab may have completed it just before.
  select u.*
    into stored
    from public.meeting_uploads u
   where u.id = p_upload_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'upload_not_found';
  end if;

  if cycle_status is null or cycle_status not in ('discuss', 'closed') then
    raise exception using errcode = 'P0001', message = 'cycle_not_discussing';
  end if;

  if stored.status = 'pending_upload' then
    select true, o.metadata
      into object_found, object_metadata
      from storage.objects o
     where o.bucket_id = 'meeting-media'
       and o.name = stored.storage_path;

    if object_found is null then
      if stored.created_at > pg_catalog.now() - interval '24 hours' then
        raise exception using errcode = 'P0001', message = 'upload_file_missing';
      end if;

      update public.meeting_uploads u
         set status = 'rejected',
             error_code = 'upload_abandoned'
       where u.id = p_upload_id;
    elsif (object_metadata ->> 'size') is distinct from stored.size_bytes::text
          or (object_metadata ->> 'mimetype') is distinct from stored.mime_type then
      update public.meeting_uploads u
         set status = 'rejected',
             error_code = 'upload_file_mismatch'
       where u.id = p_upload_id;
    else
      update public.meeting_uploads u
         set status = 'uploaded',
             error_code = null,
             uploaded_at = pg_catalog.now()
       where u.id = p_upload_id;
    end if;
  end if;

  return query
    select u.id, u.status, u.error_code
      from public.meeting_uploads u
     where u.id = p_upload_id;
end;
$$;

revoke all on function public.complete_meeting_upload(uuid) from public;
revoke all on function public.complete_meeting_upload(uuid) from anon, authenticated, service_role;

grant execute on function public.complete_meeting_upload(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_cycle_uploads
-- ---------------------------------------------------------------------------
create function public.get_cycle_uploads(p_cycle_id uuid)
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
                  'updated_at', u.updated_at
                )
                order by u.created_at desc, u.id
              )
         from public.meeting_uploads u
        where u.cycle_id = p_cycle_id),
      '[]'::jsonb
    )
  );
end;
$$;

revoke all on function public.get_cycle_uploads(uuid) from public;
revoke all on function public.get_cycle_uploads(uuid) from anon, authenticated, service_role;

grant execute on function public.get_cycle_uploads(uuid) to authenticated;
