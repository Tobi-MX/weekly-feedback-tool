-- Task 26: manual action items.
--
-- In the discuss stage any project member records an action item: a
-- description, an owner chosen from the project's current members, an
-- optional due date, and an optional related topic from #24's agenda. Every
-- member reads the cycle's actions through get_cycle_actions. Their creator
-- or the facilitator edits and deletes them while the cycle is in discuss.
-- Their owner or the facilitator marks them done or reopens them, in discuss
-- and after the cycle is closed (#27 uses that on the project page).
--
-- Decisions:
--
--   1. "Owner" means the action's owner: the member the action is assigned
--      to (actions.owner_id). The project owner gets nothing extra unless
--      they are the facilitator, as in #19b and #25.
--   2. Who does what. Any current member adds an action and assigns it to
--      any current member (themselves and the facilitator included). The
--      member who added it (created_by) or the current facilitator edits its
--      description, owner, due date and related topic, and deletes it. The
--      action's owner or the current facilitator marks it done or reopens it
--      (tech-stack section 6's "Owner or facilitator"; update_action_status is
--      renamed set_action_status). The creator cannot, unless they are also
--      the owner or the facilitator. Other members read every action.
--   3. When. create_action, update_action and delete_action work only while
--      feedback_cycles.status = 'discuss'. set_action_status works in discuss
--      and closed, because actions are followed up after the meeting; before
--      discuss it gets cycle_not_discussing. get_cycle_actions answers members
--      in every stage. Editing and reassigning after closed is #112.
--   4. Deleting is allowed during discuss only, by the creator or the
--      facilitator. There is no delete or archive after discuss.
--   5. Owners must be current members when assigned. create_action checks
--      p_owner_id against project_members, and update_action checks it only
--      when it changes, so a later removal (#49) does not block fixing a
--      typo. owner_id references auth.users on delete set null: a deleted
--      account's action stays, shows no owner name, and only the facilitator
--      can change its status.
--   6. Due dates are dates. due_date is a date with no time zone, optional,
--      and between 2000-01-01 and 2099-12-31 (invalid_due_date). A past date
--      is accepted. The server never changes an action because its date has
--      passed; "overdue" is a client-only label.
--   7. One list in creation order: get_cycle_actions returns the actions by
--      created_at, then id. Marking done does not move an item.
--   8. The related topic is optional and stays in its cycle. cluster_id is
--      null or a cluster of the same cycle, enforced by a composite foreign
--      key (cluster_id, cycle_id) -> clusters (id, cycle_id). If a cluster is
--      ever deleted, its actions lose the topic (on delete set null
--      (cluster_id)) and keep their cycle.
--   9. Text and limits. The description is trimmed with btrim(p_description,
--      E' \t\n\r') and must then be 1-500 characters (char_length, so code
--      points). Inner line breaks are kept. A cycle holds at most 200 actions
--      (action_limit_reached).
--  10. source and completed_at. Every action made here has source = 'manual';
--      #33 writes 'extraction' rows. No RPC changes source, and no rule
--      depends on it. completed_at is set when the status becomes done and
--      cleared on reopen.
--  11. Live updates through a new event type, actions_changed, written by
--      statement-level triggers on actions with the clusters_changed /
--      notes_changed rule: actor_id null, payload '{}', from_status =
--      to_status (closed for a status change after the cycle closed). The
--      event carries no id, text, name or count.
--  12. Writes are not optimistic (a client rule; nothing here depends on it).
--
-- Table. public.actions is default-deny like cards, clusters, votes and
-- notes: RLS enabled with no policy, no privilege for PUBLIC, anon or
-- authenticated, and only service_role keeps select, insert, update, delete.
-- It is not in supabase_realtime and no view reads it. Clients write actions
-- only through the four write RPCs and read them only through
-- get_cycle_actions. The creator is always (select auth.uid()) inside the
-- RPC, never taken from the client; p_owner_id is only ever the assignee.
--
-- Check orders (each failing step changes nothing):
--
--   create_action(p_cycle_id, p_description, p_owner_id, p_due_date, p_cluster_id)
--     1. null user, null or unknown cycle, or not a member
--                                                 -> 42501 not_project_member
--     2. lock the cycle FOR UPDATE; status is not discuss
--                                                 -> P0001 cycle_not_discussing
--     3. p_cluster_id not null and not a cluster of this cycle
--                                                 -> P0001 cluster_not_found
--     4. trimmed description null, empty, or over 500
--                                                 -> P0001 invalid_action_description
--     5. p_owner_id null, unknown, or not a current member of the project
--                                                 -> P0001 invalid_action_owner
--     6. p_due_date outside 2000-01-01 .. 2099-12-31
--                                                 -> P0001 invalid_due_date
--     7. the cycle already has 200 actions        -> P0001 action_limit_reached
--     8. insert (created_by = caller, open, manual); return the id
--
--   update_action(p_action_id, p_description, p_owner_id, p_due_date, p_cluster_id)
--     1. null user                                -> 42501 not_project_member
--     2. null or unknown action, or an action of a project the caller is not
--        a member of                              -> P0001 action_not_found
--     3. lock projects FOR SHARE, then the cycle FOR UPDATE; status is not
--        discuss                                  -> P0001 cycle_not_discussing
--     4. re-read the action; it is gone           -> P0001 action_not_found
--     5. the caller is neither created_by nor the current facilitator
--                                                 -> 42501 not_action_editor
--     6. create_action's steps 3, 4 and 6 (cluster, description, due date)
--     7. p_owner_id null, or changed and not a current member
--                                                 -> P0001 invalid_action_owner
--     8. every field equal is a no-op (no updated_at, no event); otherwise
--        update the four fields and updated_at. Return the id.
--
--   set_action_status(p_action_id, p_status)
--     1. null user                                -> 42501 not_project_member
--     2. null or unknown action, or not a member  -> P0001 action_not_found
--     3. lock projects FOR SHARE, then the cycle FOR UPDATE; status is not
--        discuss or closed                        -> P0001 cycle_not_discussing
--     4. re-read the action; it is gone           -> P0001 action_not_found
--     5. the caller is neither owner_id nor the current facilitator
--                                                 -> 42501 not_action_owner
--     6. p_status null or not open / done         -> P0001 invalid_action_status
--     7. the same status is a no-op that returns it; otherwise set status,
--        completed_at and updated_at. Return the id and the status.
--
--   delete_action(p_action_id)
--     1. null user                                -> 42501 not_project_member
--     2. null or unknown action, or not a member  -> P0001 action_not_found
--     3. lock projects FOR SHARE, then the cycle FOR UPDATE; status is not
--        discuss                                  -> P0001 cycle_not_discussing
--     4. re-read the action; it is gone           -> P0001 action_not_found
--     5. the caller is neither created_by nor the current facilitator
--                                                 -> 42501 not_action_editor
--     6. delete it and return the id
--
--   get_cycle_actions(p_cycle_id)
--     1. null user, null or unknown cycle, or not a member
--                                                 -> 42501 not_project_member
--     2. return {cycle_id, actions}
--
-- Locks. Every write locks the cycle row FOR UPDATE before its stage check
-- and before any write, so writes serialize with each other (keeping the
-- 200-action cap exact), with close_cycle, and later with publish_summary. A
-- create, edit or delete that loses the race to a close gets
-- cycle_not_discussing; a status change succeeds either way. update_action,
-- set_action_status and delete_action take #16's order (projects FOR SHARE,
-- then the cycle); create_action takes only the cycle lock, like add_note.
-- Neither order can form a cycle with transfer_facilitator (projects only),
-- close_voting (projects, then the cycle) or #25's RPCs.
--
-- Events. One actions_changed row per distinct cycle for every statement that
-- changes actions, with the cycle's current status. A statement that changes
-- no row, or a cascade from a deleted cycle, records nothing. An auth-user
-- deletion that sets owner_id or created_by to null records one row per
-- affected cycle for each of the two foreign keys it cascades through. No RPC
-- inserts into cycle_events itself.
--
-- Unchanged: get_cycle_board, get_vote_totals, close_voting,
-- get_cycle_discussion, #25's write RPCs, record_notes_change,
-- record_clusters_change, and the supabase_realtime publication.

-- ---------------------------------------------------------------------------
-- actions
-- ---------------------------------------------------------------------------
create table public.actions (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null,
  -- Null means no related topic.
  cluster_id uuid,
  description text not null,
  -- Never null when written: only the RPCs write it. Null after the owner's
  -- auth user is deleted (decision 5).
  owner_id uuid,
  due_date date,
  status text not null default 'open',
  completed_at timestamptz,
  source text not null default 'manual',
  -- Never null when written. Null after the creator's auth user is deleted.
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint actions_cycle_id_fkey foreign key (cycle_id)
    references public.feedback_cycles (id) on delete cascade,
  -- MATCH SIMPLE: a null cluster_id is not checked (no related topic); a
  -- topic can only be a cluster of the action's own cycle.
  constraint actions_cluster_fkey foreign key (cluster_id, cycle_id)
    references public.clusters (id, cycle_id) on delete set null (cluster_id),
  constraint actions_owner_id_fkey foreign key (owner_id)
    references auth.users (id) on delete set null,
  constraint actions_created_by_fkey foreign key (created_by)
    references auth.users (id) on delete set null,
  -- The RPCs apply the same trim set and length.
  constraint actions_description_check check (
    description = pg_catalog.btrim(description, E' \t\n\r')
    and pg_catalog.char_length(description) between 1 and 500
  ),
  constraint actions_due_date_check check (
    due_date is null or due_date between '2000-01-01'::date and '2099-12-31'::date
  ),
  constraint actions_status_check check (status in ('open', 'done')),
  constraint actions_completed_at_check check (
    (status = 'done') = (completed_at is not null)
  ),
  constraint actions_source_check check (source in ('manual', 'extraction'))
);

create index actions_cycle_id_created_at_idx
  on public.actions (cycle_id, created_at);

create index actions_owner_id_idx
  on public.actions (owner_id);

create index actions_cluster_id_idx
  on public.actions (cluster_id);

alter table public.actions enable row level security;

revoke all on table public.actions from public;
revoke all on table public.actions from anon, authenticated, service_role;

grant select, insert, update, delete on table public.actions to service_role;

create function private.guard_action_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.cycle_id is distinct from old.cycle_id
     or new.source is distinct from old.source
     or new.created_at is distinct from old.created_at
     -- created_by may only become null (the on delete set null action).
     or (new.created_by is distinct from old.created_by and new.created_by is not null) then
    raise exception using errcode = 'P0001', message = 'action_immutable_column';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_action_update() from public;
revoke all on function private.guard_action_update() from anon, authenticated, service_role;

create trigger actions_guard_update
  before update on public.actions
  for each row
  execute function private.guard_action_update();

-- ---------------------------------------------------------------------------
-- actions_changed events (decision 11)
-- ---------------------------------------------------------------------------
alter table public.cycle_events
  drop constraint cycle_events_type_check;

alter table public.cycle_events
  add constraint cycle_events_type_check
  check (type in ('stage_changed', 'clusters_changed', 'notes_changed', 'actions_changed'));

alter table public.cycle_events
  add constraint cycle_events_actions_changed_check check (
    type <> 'actions_changed'
    or (from_status = to_status and actor_id is null and payload = '{}'::jsonb)
  );

-- Modelled on #25's private.record_notes_change(). The cycle is looked up
-- now, so a cascade from a deleted cycle finds no row and records nothing.
create function private.record_actions_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id, payload)
    select fc.id, 'actions_changed', fc.status, fc.status, null, '{}'::jsonb
      from public.feedback_cycles fc
     where fc.id in (select n.cycle_id from new_rows n);
  elsif tg_op = 'UPDATE' then
    insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id, payload)
    select fc.id, 'actions_changed', fc.status, fc.status, null, '{}'::jsonb
      from public.feedback_cycles fc
     where fc.id in (select n.cycle_id from new_rows n union select o.cycle_id from old_rows o);
  else
    insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id, payload)
    select fc.id, 'actions_changed', fc.status, fc.status, null, '{}'::jsonb
      from public.feedback_cycles fc
     where fc.id in (select o.cycle_id from old_rows o);
  end if;

  return null;
end;
$$;

revoke all on function private.record_actions_change() from public;
revoke all on function private.record_actions_change() from anon, authenticated, service_role;

create trigger actions_record_insert
  after insert on public.actions
  referencing new table as new_rows
  for each statement
  execute function private.record_actions_change();

create trigger actions_record_update
  after update on public.actions
  referencing old table as old_rows new table as new_rows
  for each statement
  execute function private.record_actions_change();

create trigger actions_record_delete
  after delete on public.actions
  referencing old table as old_rows
  for each statement
  execute function private.record_actions_change();

-- ---------------------------------------------------------------------------
-- create_action
-- ---------------------------------------------------------------------------
create function public.create_action(
  p_cycle_id uuid,
  p_description text,
  p_owner_id uuid,
  p_due_date date,
  p_cluster_id uuid
)
returns table (
  action_id uuid
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
  clean_description text;
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

  -- Serialize with every other action write (the 200-action cap),
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

  clean_description := pg_catalog.btrim(p_description, E' \t\n\r');
  if clean_description is null
     or pg_catalog.char_length(clean_description) not between 1 and 500 then
    raise exception using errcode = 'P0001', message = 'invalid_action_description';
  end if;

  if p_owner_id is null
     or not exists (
       select 1
         from public.project_members pm
        where pm.project_id = cycle_project
          and pm.user_id = p_owner_id
     ) then
    raise exception using errcode = 'P0001', message = 'invalid_action_owner';
  end if;

  if p_due_date is not null
     and p_due_date not between '2000-01-01'::date and '2099-12-31'::date then
    raise exception using errcode = 'P0001', message = 'invalid_due_date';
  end if;

  if (select count(*) from public.actions a where a.cycle_id = p_cycle_id) >= 200 then
    raise exception using errcode = 'P0001', message = 'action_limit_reached';
  end if;

  insert into public.actions (cycle_id, cluster_id, description, owner_id, due_date, status, source, created_by)
  values (p_cycle_id, p_cluster_id, clean_description, p_owner_id, p_due_date, 'open', 'manual', caller)
  returning public.actions.id into new_id;

  return query
    select new_id;
end;
$$;

revoke all on function public.create_action(uuid, text, uuid, date, uuid) from public;
revoke all on function public.create_action(uuid, text, uuid, date, uuid) from anon, authenticated, service_role;

grant execute on function public.create_action(uuid, text, uuid, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- update_action
-- ---------------------------------------------------------------------------
create function public.update_action(
  p_action_id uuid,
  p_description text,
  p_owner_id uuid,
  p_due_date date,
  p_cluster_id uuid
)
returns table (
  action_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid;
  action_cycle uuid;
  cycle_project uuid;
  cycle_status text;
  stored public.actions%rowtype;
  clean_description text;
begin
  caller := (select auth.uid());

  if caller is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- An action's cycle_id and a cycle's project_id never change. An unknown
  -- action and one the caller cannot see get the same error.
  select a.cycle_id, fc.project_id
    into action_cycle, cycle_project
    from public.actions a
    join public.feedback_cycles fc on fc.id = a.cycle_id
   where a.id = p_action_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = 'P0001', message = 'action_not_found';
  end if;

  -- Serialize with transfer_facilitator, then with every other action write
  -- and close_cycle.
  perform 1 from public.projects p where p.id = cycle_project for share;

  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = action_cycle
     for update;

  if cycle_status is distinct from 'discuss' then
    raise exception using errcode = 'P0001', message = 'cycle_not_discussing';
  end if;

  -- Re-read under the locks: another member may have deleted it just before.
  select a.*
    into stored
    from public.actions a
   where a.id = p_action_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'action_not_found';
  end if;

  -- The creator, or the current facilitator. The action's owner and the
  -- project owner get no edit right of their own.
  if stored.created_by is distinct from caller
     and not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_action_editor';
  end if;

  if p_cluster_id is not null
     and not exists (
       select 1
         from public.clusters cl
        where cl.id = p_cluster_id
          and cl.cycle_id = action_cycle
     ) then
    raise exception using errcode = 'P0001', message = 'cluster_not_found';
  end if;

  clean_description := pg_catalog.btrim(p_description, E' \t\n\r');
  if clean_description is null
     or pg_catalog.char_length(clean_description) not between 1 and 500 then
    raise exception using errcode = 'P0001', message = 'invalid_action_description';
  end if;

  if p_due_date is not null
     and p_due_date not between '2000-01-01'::date and '2099-12-31'::date then
    raise exception using errcode = 'P0001', message = 'invalid_due_date';
  end if;

  -- An unchanged owner is not re-checked (decision 5).
  if p_owner_id is null
     or (p_owner_id is distinct from stored.owner_id
         and not exists (
           select 1
             from public.project_members pm
            where pm.project_id = cycle_project
              and pm.user_id = p_owner_id
         )) then
    raise exception using errcode = 'P0001', message = 'invalid_action_owner';
  end if;

  if clean_description is distinct from stored.description
     or p_owner_id is distinct from stored.owner_id
     or p_due_date is distinct from stored.due_date
     or p_cluster_id is distinct from stored.cluster_id then
    update public.actions a
       set description = clean_description,
           owner_id = p_owner_id,
           due_date = p_due_date,
           cluster_id = p_cluster_id,
           updated_at = pg_catalog.now()
     where a.id = p_action_id;
  end if;

  return query
    select p_action_id;
end;
$$;

revoke all on function public.update_action(uuid, text, uuid, date, uuid) from public;
revoke all on function public.update_action(uuid, text, uuid, date, uuid) from anon, authenticated, service_role;

grant execute on function public.update_action(uuid, text, uuid, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- set_action_status
-- ---------------------------------------------------------------------------
create function public.set_action_status(p_action_id uuid, p_status text)
returns table (
  action_id uuid,
  status text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid;
  action_cycle uuid;
  cycle_project uuid;
  cycle_status text;
  action_owner uuid;
  current_status text;
begin
  caller := (select auth.uid());

  if caller is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  select a.cycle_id, fc.project_id
    into action_cycle, cycle_project
    from public.actions a
    join public.feedback_cycles fc on fc.id = a.cycle_id
   where a.id = p_action_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = 'P0001', message = 'action_not_found';
  end if;

  -- Serialize with transfer_facilitator, then with every other action write
  -- and close_cycle.
  perform 1 from public.projects p where p.id = cycle_project for share;

  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = action_cycle
     for update;

  -- Actions are followed up after the meeting (decision 3).
  if cycle_status is null
     or cycle_status not in ('discuss', 'closed') then
    raise exception using errcode = 'P0001', message = 'cycle_not_discussing';
  end if;

  select a.owner_id, a.status
    into action_owner, current_status
    from public.actions a
   where a.id = p_action_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'action_not_found';
  end if;

  -- The action's owner, or the current facilitator. The creator and the
  -- project owner get no status right of their own.
  if action_owner is distinct from caller
     and not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_action_owner';
  end if;

  if p_status is null
     or p_status not in ('open', 'done') then
    raise exception using errcode = 'P0001', message = 'invalid_action_status';
  end if;

  if current_status is distinct from p_status then
    update public.actions a
       set status = p_status,
           completed_at = case when p_status = 'done' then pg_catalog.now() else null end,
           updated_at = pg_catalog.now()
     where a.id = p_action_id;
  end if;

  return query
    select a.id, a.status
    from public.actions a
    where a.id = p_action_id;
end;
$$;

revoke all on function public.set_action_status(uuid, text) from public;
revoke all on function public.set_action_status(uuid, text) from anon, authenticated, service_role;

grant execute on function public.set_action_status(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- delete_action
-- ---------------------------------------------------------------------------
create function public.delete_action(p_action_id uuid)
returns table (
  action_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid;
  action_cycle uuid;
  cycle_project uuid;
  cycle_status text;
  action_creator uuid;
begin
  caller := (select auth.uid());

  if caller is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  select a.cycle_id, fc.project_id
    into action_cycle, cycle_project
    from public.actions a
    join public.feedback_cycles fc on fc.id = a.cycle_id
   where a.id = p_action_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = 'P0001', message = 'action_not_found';
  end if;

  -- Serialize with transfer_facilitator, then with every other action write
  -- and close_cycle.
  perform 1 from public.projects p where p.id = cycle_project for share;

  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = action_cycle
     for update;

  if cycle_status is distinct from 'discuss' then
    raise exception using errcode = 'P0001', message = 'cycle_not_discussing';
  end if;

  -- Re-read under the locks: another member may have deleted it just before.
  select a.created_by
    into action_creator
    from public.actions a
   where a.id = p_action_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'action_not_found';
  end if;

  if action_creator is distinct from caller
     and not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_action_editor';
  end if;

  delete from public.actions a
   where a.id = p_action_id;

  return query
    select p_action_id;
end;
$$;

revoke all on function public.delete_action(uuid) from public;
revoke all on function public.delete_action(uuid) from anon, authenticated, service_role;

grant execute on function public.delete_action(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_cycle_actions
--
-- Exactly two keys: cycle_id, and actions (every action of the cycle by
-- created_at, then id, each with exactly action_id, cluster_id, description,
-- owner_id, owner_name, owner_is_me, created_by_me, due_date, status,
-- completed_at, source, created_at and updated_at). The same for every
-- member except owner_is_me and created_by_me, in every stage, and with no
-- created_by id.
-- ---------------------------------------------------------------------------
create function public.get_cycle_actions(p_cycle_id uuid)
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
    'actions', coalesce(
      (select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'action_id', a.id,
                  'cluster_id', a.cluster_id,
                  'description', a.description,
                  'owner_id', a.owner_id,
                  'owner_name', case
                                  when a.owner_id is null then null
                                  else coalesce(pr.display_name, 'Member')
                                end,
                  'owner_is_me', coalesce(a.owner_id = caller, false),
                  'created_by_me', coalesce(a.created_by = caller, false),
                  'due_date', pg_catalog.to_char(a.due_date, 'YYYY-MM-DD'),
                  'status', a.status,
                  'completed_at', a.completed_at,
                  'source', a.source,
                  'created_at', a.created_at,
                  'updated_at', a.updated_at
                )
                order by a.created_at, a.id
              )
         from public.actions a
         left join public.profiles pr on pr.id = a.owner_id
        where a.cycle_id = p_cycle_id),
      '[]'::jsonb
    )
  );
end;
$$;

revoke all on function public.get_cycle_actions(uuid) from public;
revoke all on function public.get_cycle_actions(uuid) from anon, authenticated, service_role;

grant execute on function public.get_cycle_actions(uuid) to authenticated;
