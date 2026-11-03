-- Task 25: discussion statuses and notes.
--
-- In the discuss stage the team works through #24's ranked agenda. The
-- facilitator marks each topic discussed, skipped, or deferred (or puts it
-- back to pending), and any member adds notes to a topic or general notes for
-- the meeting. After discuss, statuses and notes are read-only and kept for
-- the summary (#34).
--
-- Decisions:
--
--   1. Notes are attributed and visible to the whole project. There is no
--      anonymous note and no facilitator-only note: anonymity is offered for
--      feedback items only, and a note is part of the meeting record.
--   2. Who does what. Any current member of the cycle's project adds notes
--      (the facilitator and the owner included). Only a note's author edits
--      it. The author or the project's current facilitator deletes it. Only
--      the current facilitator sets a discussion status. The owner gets
--      nothing extra unless they are the facilitator.
--   3. When. Every write (set_discussion_status, add_note, update_note,
--      delete_note) works only while feedback_cycles.status = 'discuss'.
--      get_cycle_discussion answers members in every stage, so #34, #35, and
--      #108 can read a closed cycle. Before discuss every status is pending
--      and there are no notes.
--   4. The status lives in clusters.discussion_status (text not null default
--      'pending'; pending, discussed, skipped, deferred). get_cycle_board does
--      not gain it: statuses and notes come from get_cycle_discussion only.
--      The guard trigger clusters_guard_discussion_status lets the column
--      change only while the cycle is in discuss.
--   5. Live updates through cycle_events. A status change updates clusters,
--      so #17's clusters_changed triggers already record one row. Notes get a
--      new type, notes_changed, recorded by statement-level triggers on
--      notes, with the same rule as clusters_changed: actor_id null, payload
--      '{}', from_status = to_status (enforced by a CHECK). The event names
--      no note, text, author, or count.
--   6. Statuses never reorder the agenda: the client keeps #24's
--      get_vote_totals order.
--   7. Writes are not optimistic (a client rule; nothing here depends on it).
--   8. Notes outlive their author's account: notes.author_id references
--      auth.users on delete set null. Such a note stays, has a null
--      author_name, and can still be deleted by the facilitator. A member
--      removed from the project keeps their name on their notes.
--   9. Limits. Text is trimmed with btrim(p_text, E' \t\n\r') and must then
--      be 1-2000 characters (char_length, so code points). Inner line breaks
--      are kept. A cycle holds at most 500 notes (note_limit_reached).
--  10. notes.edited_at is set only when update_note changes the text. The RPC
--      read returns created_at and edited_at; the UI shows "(edited)" only.
--
-- Tables. public.notes is default-deny like clusters: RLS enabled with no
-- policy, no privilege for PUBLIC, anon, or authenticated, and only
-- service_role keeps select, insert, update, delete. It is not in
-- supabase_realtime and no view reads it. Clients write statuses and notes
-- only through the four write RPCs and read them only through
-- get_cycle_discussion. The author is always (select auth.uid()) inside the
-- RPC, never taken from the client, and no RPC returns a user id.
--
-- Check orders (each failing step changes nothing):
--
--   set_discussion_status(p_cluster_id, p_status)
--     1. (select auth.uid()) is null              -> 42501 not_project_member
--     2. null or unknown cluster, or a cluster of a project the caller is not
--        a member of                              -> P0001 cluster_not_found
--     3. lock projects FOR SHARE; the caller is not the current facilitator
--                                                 -> 42501 not_project_facilitator
--     4. lock the cycle FOR UPDATE; status is not discuss
--                                                 -> P0001 cycle_not_discussing
--     5. p_status null or not one of the four     -> P0001 invalid_discussion_status
--     6. the same value is a no-op that returns it (no updated_at change, no
--        event); otherwise update it and return the new value
--
--   add_note(p_cycle_id, p_cluster_id, p_text)
--     1. null user, null or unknown cycle, or not a member
--                                                 -> 42501 not_project_member
--     2. lock the cycle FOR UPDATE; status is not discuss
--                                                 -> P0001 cycle_not_discussing
--     3. p_cluster_id not null and not a cluster of this cycle
--                                                 -> P0001 cluster_not_found
--     4. trimmed text null, empty, or over 2000   -> P0001 invalid_note_text
--     5. the cycle already has 500 notes          -> P0001 note_limit_reached
--     6. insert with the caller as author; return the id and p_cluster_id
--
--   update_note(p_note_id, p_text)
--     1. null user                                -> 42501 not_project_member
--     2. null or unknown note, or a note of a project the caller is not a
--        member of                                -> P0001 note_not_found
--     3. lock the cycle FOR UPDATE; status is not discuss
--                                                 -> P0001 cycle_not_discussing
--     4. re-read the note; it is gone             -> P0001 note_not_found
--     5. the caller is not its author             -> 42501 not_note_author
--     6. invalid trimmed text                     -> P0001 invalid_note_text
--     7. the same trimmed text is a no-op (no edited_at, no event); otherwise
--        set the text and edited_at = now(). Return the id.
--
--   delete_note(p_note_id)
--     1. null user                                -> 42501 not_project_member
--     2. null or unknown note, or not a member    -> P0001 note_not_found
--     3. lock projects FOR SHARE, then the cycle FOR UPDATE; status is not
--        discuss                                  -> P0001 cycle_not_discussing
--     4. re-read the note; it is gone             -> P0001 note_not_found
--     5. the caller is neither its author nor the current facilitator
--                                                 -> 42501 not_note_author
--     6. delete it and return the id
--
--   get_cycle_discussion(p_cycle_id)
--     1. null user, null or unknown cycle, or not a member
--                                                 -> 42501 not_project_member
--     2. return {cycle_id, statuses, notes}
--
-- Locks. Every write locks the cycle row FOR UPDATE before its stage check
-- and before any write, so writes serialize with each other (keeping the
-- 500-note cap exact), with close_cycle, and later with publish_summary. A
-- write that loses the race to a close gets cycle_not_discussing. The RPCs
-- with a role check (set_discussion_status, delete_note) take #16's order:
-- projects FOR SHARE, then the cycle. add_note and update_note take only the
-- cycle lock. Neither order can form a cycle with transfer_facilitator
-- (projects only) or #24's close_voting (projects, then the cycle).
--
-- Events. One notes_changed row per distinct cycle for every statement that
-- changes notes, with the cycle's current status. A statement that changes no
-- row, or a cascade from a deleted cycle, records nothing. No RPC inserts
-- into cycle_events itself.
--
-- Unchanged: get_cycle_board, get_vote_totals, cast_vote, remove_vote,
-- close_voting, record_clusters_change, record_cycle_stage_change, and the
-- supabase_realtime publication.

-- ---------------------------------------------------------------------------
-- clusters.discussion_status (decision 4)
-- ---------------------------------------------------------------------------
alter table public.clusters
  add column discussion_status text not null default 'pending';

alter table public.clusters
  add constraint clusters_discussion_status_check
  check (discussion_status in ('pending', 'discussed', 'skipped', 'deferred'));

-- Fires only when discussion_status actually changes (the WHEN clause), so
-- no other cluster write in any stage is affected.
create function private.guard_cluster_discussion_status()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (select fc.status from public.feedback_cycles fc where fc.id = new.cycle_id) is distinct from 'discuss' then
    raise exception using errcode = 'P0001', message = 'cycle_not_discussing';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_cluster_discussion_status() from public;
revoke all on function private.guard_cluster_discussion_status() from anon, authenticated, service_role;

create trigger clusters_guard_discussion_status
  before update on public.clusters
  for each row
  when (new.discussion_status is distinct from old.discussion_status)
  execute function private.guard_cluster_discussion_status();

-- ---------------------------------------------------------------------------
-- notes
-- ---------------------------------------------------------------------------
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null,
  -- Null for a general note.
  cluster_id uuid,
  -- Never null when written: only the RPCs write it. Null after the author's
  -- auth user is deleted (decision 8).
  author_id uuid,
  text text not null,
  created_at timestamptz not null default now(),
  -- Null until update_note first changes the text.
  edited_at timestamptz,
  constraint notes_cycle_id_fkey foreign key (cycle_id)
    references public.feedback_cycles (id) on delete cascade,
  -- MATCH SIMPLE: a null cluster_id is not checked (a general note); a topic
  -- note can only point at a cluster of its own cycle.
  constraint notes_cluster_fkey foreign key (cluster_id, cycle_id)
    references public.clusters (id, cycle_id) on delete cascade,
  constraint notes_author_id_fkey foreign key (author_id)
    references auth.users (id) on delete set null,
  -- The RPCs apply the same trim set and length.
  constraint notes_text_check check (
    text = pg_catalog.btrim(text, E' \t\n\r')
    and pg_catalog.char_length(text) between 1 and 2000
  )
);

create index notes_cycle_id_created_at_idx
  on public.notes (cycle_id, created_at);

create index notes_cluster_id_idx
  on public.notes (cluster_id);

alter table public.notes enable row level security;

revoke all on table public.notes from public;
revoke all on table public.notes from anon, authenticated, service_role;

grant select, insert, update, delete on table public.notes to service_role;

create function private.guard_note_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.cycle_id is distinct from old.cycle_id
     or new.cluster_id is distinct from old.cluster_id
     or new.created_at is distinct from old.created_at
     -- author_id may only become null (the on delete set null action).
     or (new.author_id is distinct from old.author_id and new.author_id is not null) then
    raise exception using errcode = 'P0001', message = 'note_immutable_column';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_note_update() from public;
revoke all on function private.guard_note_update() from anon, authenticated, service_role;

create trigger notes_guard_update
  before update on public.notes
  for each row
  execute function private.guard_note_update();

-- ---------------------------------------------------------------------------
-- notes_changed events (decision 5)
-- ---------------------------------------------------------------------------
alter table public.cycle_events
  drop constraint cycle_events_type_check;

alter table public.cycle_events
  add constraint cycle_events_type_check
  check (type in ('stage_changed', 'clusters_changed', 'notes_changed'));

alter table public.cycle_events
  add constraint cycle_events_notes_changed_check check (
    type <> 'notes_changed'
    or (from_status = to_status and actor_id is null and payload = '{}'::jsonb)
  );

-- Modelled on private.record_clusters_change(). The cycle is looked up now,
-- so a cascade from a deleted cycle finds no row and records nothing.
create function private.record_notes_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id, payload)
    select fc.id, 'notes_changed', fc.status, fc.status, null, '{}'::jsonb
      from public.feedback_cycles fc
     where fc.id in (select n.cycle_id from new_rows n);
  elsif tg_op = 'UPDATE' then
    insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id, payload)
    select fc.id, 'notes_changed', fc.status, fc.status, null, '{}'::jsonb
      from public.feedback_cycles fc
     where fc.id in (select n.cycle_id from new_rows n union select o.cycle_id from old_rows o);
  else
    insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id, payload)
    select fc.id, 'notes_changed', fc.status, fc.status, null, '{}'::jsonb
      from public.feedback_cycles fc
     where fc.id in (select o.cycle_id from old_rows o);
  end if;

  return null;
end;
$$;

revoke all on function private.record_notes_change() from public;
revoke all on function private.record_notes_change() from anon, authenticated, service_role;

create trigger notes_record_insert
  after insert on public.notes
  referencing new table as new_rows
  for each statement
  execute function private.record_notes_change();

create trigger notes_record_update
  after update on public.notes
  referencing old table as old_rows new table as new_rows
  for each statement
  execute function private.record_notes_change();

create trigger notes_record_delete
  after delete on public.notes
  referencing old table as old_rows
  for each statement
  execute function private.record_notes_change();

-- ---------------------------------------------------------------------------
-- set_discussion_status
-- ---------------------------------------------------------------------------
create function public.set_discussion_status(p_cluster_id uuid, p_status text)
returns table (
  cluster_id uuid,
  discussion_status text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cluster_cycle uuid;
  cycle_project uuid;
  cycle_status text;
  current_status text;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- A cluster's cycle_id and a cycle's project_id never change. An unknown
  -- cluster and one the caller cannot see get the same error.
  select cl.cycle_id, fc.project_id
    into cluster_cycle, cycle_project
    from public.clusters cl
    join public.feedback_cycles fc on fc.id = cl.cycle_id
   where cl.id = p_cluster_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = 'P0001', message = 'cluster_not_found';
  end if;

  -- Serialize with transfer_facilitator, then check the role as it is now.
  perform 1 from public.projects p where p.id = cycle_project for share;

  if not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
  end if;

  -- Serialize with every other discussion write, close_cycle, and later
  -- publish_summary.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = cluster_cycle
     for update;

  if cycle_status is distinct from 'discuss' then
    raise exception using errcode = 'P0001', message = 'cycle_not_discussing';
  end if;

  if p_status is null
     or p_status not in ('pending', 'discussed', 'skipped', 'deferred') then
    raise exception using errcode = 'P0001', message = 'invalid_discussion_status';
  end if;

  -- Clusters are frozen from vote on, so the row is still there.
  select cl.discussion_status
    into current_status
    from public.clusters cl
   where cl.id = p_cluster_id;

  if current_status is distinct from p_status then
    update public.clusters cl
       set discussion_status = p_status
     where cl.id = p_cluster_id;
  end if;

  return query
    select cl.id, cl.discussion_status
    from public.clusters cl
    where cl.id = p_cluster_id;
end;
$$;

revoke all on function public.set_discussion_status(uuid, text) from public;
revoke all on function public.set_discussion_status(uuid, text) from anon, authenticated, service_role;

grant execute on function public.set_discussion_status(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- add_note
-- ---------------------------------------------------------------------------
create function public.add_note(p_cycle_id uuid, p_cluster_id uuid, p_text text)
returns table (
  note_id uuid,
  cluster_id uuid
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
  clean_text text;
  new_id uuid;
begin
  caller := (select auth.uid());

  if caller is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- project_id never changes, so it can be read before the lock.
  select fc.project_id
    into cycle_project
    from public.feedback_cycles fc
   where fc.id = p_cycle_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- Serialize with every other discussion write (the 500-note cap),
  -- close_cycle, and later publish_summary.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = p_cycle_id
     for update;

  if cycle_status is distinct from 'discuss' then
    raise exception using errcode = 'P0001', message = 'cycle_not_discussing';
  end if;

  if p_cluster_id is not null
     and not exists (
       select 1
         from public.clusters cl
        where cl.id = p_cluster_id
          and cl.cycle_id = p_cycle_id
     ) then
    raise exception using errcode = 'P0001', message = 'cluster_not_found';
  end if;

  clean_text := pg_catalog.btrim(p_text, E' \t\n\r');
  if clean_text is null
     or pg_catalog.char_length(clean_text) not between 1 and 2000 then
    raise exception using errcode = 'P0001', message = 'invalid_note_text';
  end if;

  if (select count(*) from public.notes n where n.cycle_id = p_cycle_id) >= 500 then
    raise exception using errcode = 'P0001', message = 'note_limit_reached';
  end if;

  insert into public.notes (cycle_id, cluster_id, author_id, text)
  values (p_cycle_id, p_cluster_id, caller, clean_text)
  returning public.notes.id into new_id;

  return query
    select new_id, p_cluster_id;
end;
$$;

revoke all on function public.add_note(uuid, uuid, text) from public;
revoke all on function public.add_note(uuid, uuid, text) from anon, authenticated, service_role;

grant execute on function public.add_note(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- update_note
-- ---------------------------------------------------------------------------
create function public.update_note(p_note_id uuid, p_text text)
returns table (
  note_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid;
  note_cycle uuid;
  cycle_project uuid;
  cycle_status text;
  note_author uuid;
  note_text text;
  clean_text text;
begin
  caller := (select auth.uid());

  if caller is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- A note's cycle_id and a cycle's project_id never change. An unknown note
  -- and one the caller cannot see get the same error.
  select n.cycle_id, fc.project_id
    into note_cycle, cycle_project
    from public.notes n
    join public.feedback_cycles fc on fc.id = n.cycle_id
   where n.id = p_note_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = 'P0001', message = 'note_not_found';
  end if;

  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = note_cycle
     for update;

  if cycle_status is distinct from 'discuss' then
    raise exception using errcode = 'P0001', message = 'cycle_not_discussing';
  end if;

  -- Re-read under the lock: the note may have been deleted meanwhile.
  select n.author_id, n.text
    into note_author, note_text
    from public.notes n
   where n.id = p_note_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'note_not_found';
  end if;

  -- The facilitator gets no edit right, and nobody edits an orphaned note.
  if note_author is distinct from caller then
    raise exception using errcode = '42501', message = 'not_note_author';
  end if;

  clean_text := pg_catalog.btrim(p_text, E' \t\n\r');
  if clean_text is null
     or pg_catalog.char_length(clean_text) not between 1 and 2000 then
    raise exception using errcode = 'P0001', message = 'invalid_note_text';
  end if;

  if clean_text is distinct from note_text then
    update public.notes n
       set text = clean_text,
           edited_at = pg_catalog.now()
     where n.id = p_note_id;
  end if;

  return query
    select p_note_id;
end;
$$;

revoke all on function public.update_note(uuid, text) from public;
revoke all on function public.update_note(uuid, text) from anon, authenticated, service_role;

grant execute on function public.update_note(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- delete_note
-- ---------------------------------------------------------------------------
create function public.delete_note(p_note_id uuid)
returns table (
  note_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid;
  note_cycle uuid;
  cycle_project uuid;
  cycle_status text;
  note_author uuid;
begin
  caller := (select auth.uid());

  if caller is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  select n.cycle_id, fc.project_id
    into note_cycle, cycle_project
    from public.notes n
    join public.feedback_cycles fc on fc.id = n.cycle_id
   where n.id = p_note_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = 'P0001', message = 'note_not_found';
  end if;

  -- Serialize with transfer_facilitator, then with every other discussion
  -- write and close_cycle.
  perform 1 from public.projects p where p.id = cycle_project for share;

  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = note_cycle
     for update;

  if cycle_status is distinct from 'discuss' then
    raise exception using errcode = 'P0001', message = 'cycle_not_discussing';
  end if;

  -- Re-read under the locks: another member may have deleted it just before.
  select n.author_id
    into note_author
    from public.notes n
   where n.id = p_note_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'note_not_found';
  end if;

  -- The author, or the current facilitator (the only moderation power).
  if note_author is distinct from caller
     and not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_note_author';
  end if;

  delete from public.notes n
   where n.id = p_note_id;

  return query
    select p_note_id;
end;
$$;

revoke all on function public.delete_note(uuid) from public;
revoke all on function public.delete_note(uuid) from anon, authenticated, service_role;

grant execute on function public.delete_note(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_cycle_discussion
--
-- Exactly three keys: cycle_id; statuses (one element per cluster of the
-- cycle by sort_order, each with exactly cluster_id and discussion_status);
-- notes (every note of the cycle by created_at, then note_id, each with
-- exactly note_id, cluster_id, text, author_name, is_mine, created_at, and
-- edited_at). The same for every member except is_mine, in every stage, and
-- with no user id.
-- ---------------------------------------------------------------------------
create function public.get_cycle_discussion(p_cycle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid;
  cycle_project uuid;
begin
  caller := (select auth.uid());

  if caller is null then
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

  return pg_catalog.jsonb_build_object(
    'cycle_id', p_cycle_id,
    'statuses', coalesce(
      (select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'cluster_id', cl.id,
                  'discussion_status', cl.discussion_status
                )
                order by cl.sort_order
              )
         from public.clusters cl
        where cl.cycle_id = p_cycle_id),
      '[]'::jsonb
    ),
    'notes', coalesce(
      (select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'note_id', n.id,
                  'cluster_id', n.cluster_id,
                  'text', n.text,
                  'author_name', pr.display_name,
                  'is_mine', coalesce(n.author_id = caller, false),
                  'created_at', n.created_at,
                  'edited_at', n.edited_at
                )
                order by n.created_at, n.id
              )
         from public.notes n
         left join public.profiles pr on pr.id = n.author_id
        where n.cycle_id = p_cycle_id),
      '[]'::jsonb
    )
  );
end;
$$;

revoke all on function public.get_cycle_discussion(uuid) from public;
revoke all on function public.get_cycle_discussion(uuid) from anon, authenticated, service_role;

grant execute on function public.get_cycle_discussion(uuid) to authenticated;
