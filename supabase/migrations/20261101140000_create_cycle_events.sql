-- Task 14: start the retrospective, the revealed_at rules, and cycle events.
--
-- Event contract. Later tasks (#15, #16, #24, #34, #71, #81) build on these
-- rules and must not weaken them:
--
--   * public.cycle_events holds one row per broadcast cycle event. Today the
--     only type is stage_changed, written by the feedback_cycles trigger below
--     whenever a cycle's status changes (start_retrospective, close_cycle, and
--     later advance_stage, close_voting, and publish_summary). No RPC inserts
--     an event itself, and none may: the trigger is the only writer.
--   * No column and no payload ever carries card text, a card id, a card or
--     submission count, an author id, per-member data (a member list, a
--     per-member flag or count), or vote data, for this or any later event
--     type. actor_id is the user who changed the stage: today only the
--     current facilitator, whose id every member already sees through
--     get_project_members, or null when postgres or service_role made the
--     change. It is never a card author. Clients read counts from
--     get_cycle_status after an event.
--   * Members of the cycle's project read events through RLS; nobody writes
--     them through PostgREST, and no role (postgres included) may update one.
--   * cycle_events is the only table this migration adds to the
--     supabase_realtime publication. feedback_cycles, cards, and card_authors
--     stay out of it. Realtime applies the select policy to each subscriber,
--     so only current members receive an INSERT. Replica identity stays
--     DEFAULT, so a cascade DELETE event carries only the event id.
--   * Card writes never update feedback_cycles, so they never create an event
--     and the counts in get_cycle_status stay not live.
--
-- Reveal contract. "Revealed" means feedback_cycles.revealed_at is not null.
-- revealed_at is set exactly once, together with collecting -> reveal, and is
-- never cleared or moved. A cycle closed early from collecting keeps
-- revealed_at null for good. #13's get_cycle_status and #15's get_cycle_board
-- rely on this.
--
-- start_retrospective changes no privilege on cards or card_authors and reads
-- neither table: revealing only sets revealed_at. This migration adds no
-- policy, grant, view, or function on cards, card_authors, or profiles.

-- ---------------------------------------------------------------------------
-- cycle_events
-- ---------------------------------------------------------------------------
create table public.cycle_events (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null,
  type text not null,
  from_status text not null,
  to_status text not null,
  actor_id uuid,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint cycle_events_cycle_id_fkey foreign key (cycle_id)
    references public.feedback_cycles (id) on delete cascade,
  -- Deleting an auth user never deletes an event; it only forgets the actor.
  constraint cycle_events_actor_id_fkey foreign key (actor_id)
    references auth.users (id) on delete set null,
  -- Later tasks widen this list in their own migrations.
  constraint cycle_events_type_check check (type in ('stage_changed')),
  constraint cycle_events_from_status_check check (
    from_status in ('collecting', 'reveal', 'cluster', 'vote', 'discuss', 'closed')
  ),
  constraint cycle_events_to_status_check check (
    to_status in ('collecting', 'reveal', 'cluster', 'vote', 'discuss', 'closed')
  ),
  constraint cycle_events_payload_check check (
    pg_catalog.jsonb_typeof(payload) = 'object'
  )
);

create index cycle_events_cycle_created_idx
  on public.cycle_events (cycle_id, created_at);

alter table public.cycle_events enable row level security;

-- Supabase's default privileges would give anon and authenticated every table
-- privilege on a new public table. Revoke those defaults explicitly and grant
-- back only what the product needs: authenticated may read, nothing more.
revoke all on table public.cycle_events from public;
revoke all on table public.cycle_events from anon, authenticated, service_role;

grant select on table public.cycle_events to authenticated;
grant select, insert, update, delete on table public.cycle_events to service_role;

-- A member reads the events of their projects' cycles and nothing else. The
-- cycle lookup runs under feedback_cycles' own member policy. There is no
-- INSERT, UPDATE, or DELETE policy: only the trigger below writes the table.
create policy cycle_events_select_member
  on public.cycle_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.feedback_cycles fc
      where fc.id = cycle_events.cycle_id
        and private.is_project_member(fc.project_id)
    )
  );

-- Events are immutable for every role. The one exception is the
-- cycle_events_actor_id_fkey ON DELETE SET NULL action, which is itself an
-- UPDATE: actor_id may become null once the auth user it names no longer
-- exists, and nothing else may change. The function is security definer only
-- so it can see auth.users for that check.
create function private.guard_cycle_event_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.actor_id is null
     and old.actor_id is not null
     and not exists (select 1 from auth.users u where u.id = old.actor_id)
     and new.id = old.id
     and new.cycle_id = old.cycle_id
     and new.type = old.type
     and new.from_status = old.from_status
     and new.to_status = old.to_status
     and new.payload = old.payload
     and new.created_at = old.created_at then
    return new;
  end if;

  raise exception using errcode = 'P0001', message = 'cycle_event_immutable';
end;
$$;

revoke all on function private.guard_cycle_event_update() from public;
revoke all on function private.guard_cycle_event_update() from anon, authenticated, service_role;

create trigger cycle_events_guard_update
  before update on public.cycle_events
  for each row
  execute function private.guard_cycle_event_update();

-- Only cycle_events is published. Postgres Changes applies the select policy
-- above to each subscriber.
alter publication supabase_realtime add table public.cycle_events;

-- ---------------------------------------------------------------------------
-- revealed_at rules on feedback_cycles
-- ---------------------------------------------------------------------------
-- Every revealed stage has revealed_at. closed may have it or not: a cycle
-- closed early from collecting was never revealed.
alter table public.feedback_cycles
  add constraint feedback_cycles_revealed_status_check check (
    status not in ('reveal', 'cluster', 'vote', 'discuss')
    or revealed_at is not null
  );

-- revealed_at changes only once, from null to a value, together with
-- collecting -> reveal. This trigger fires before #10's
-- feedback_cycles_guard_update (BEFORE triggers fire in name order), so it
-- leaves a status change that #10 does not allow to that guard, which reports
-- it as invalid_status_transition, as #10's tests expect.
create function private.guard_feedback_cycle_reveal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status
     and not (
       (old.status, new.status) in (
         ('collecting', 'reveal'),
         ('reveal', 'cluster'),
         ('cluster', 'vote'),
         ('vote', 'discuss'),
         ('discuss', 'closed')
       )
       or (old.status <> 'closed' and new.status = 'closed')
     ) then
    return new;
  end if;

  if old.status = 'collecting' and new.status = 'reveal' then
    if old.revealed_at is not null or new.revealed_at is null then
      raise exception using errcode = 'P0001', message = 'cycle_immutable_column';
    end if;
  elsif new.revealed_at is distinct from old.revealed_at then
    raise exception using errcode = 'P0001', message = 'cycle_immutable_column';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_feedback_cycle_reveal() from public;
revoke all on function private.guard_feedback_cycle_reveal() from anon, authenticated, service_role;

create trigger feedback_cycles_guard_reveal
  before update on public.feedback_cycles
  for each row
  execute function private.guard_feedback_cycle_reveal();

-- ---------------------------------------------------------------------------
-- Stage-change events. One row per status change, in the same transaction as
-- the change. An update that leaves the status alone records nothing.
-- ---------------------------------------------------------------------------
create function private.record_cycle_stage_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id, payload)
  values (new.id, 'stage_changed', old.status, new.status, (select auth.uid()), '{}'::jsonb);

  return null;
end;
$$;

revoke all on function private.record_cycle_stage_change() from public;
revoke all on function private.record_cycle_stage_change() from anon, authenticated, service_role;

create trigger feedback_cycles_record_stage_change
  after update of status on public.feedback_cycles
  for each row
  when (old.status is distinct from new.status)
  execute function private.record_cycle_stage_change();

-- ---------------------------------------------------------------------------
-- start_retrospective: the facilitator moves the open cycle from collecting
-- to reveal and sets revealed_at. Starting a cycle already in reveal is a
-- successful no-op that returns the current row.
-- ---------------------------------------------------------------------------
create function public.start_retrospective(p_cycle_id uuid)
returns table (
  id uuid,
  status text,
  revealed_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cycle_project uuid;
  cycle_status text;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- project_id never changes, so it can be read before the locks.
  select fc.project_id
    into cycle_project
    from public.feedback_cycles fc
   where fc.id = p_cycle_id;

  -- A null or unknown cycle id and a non-member look the same.
  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- Serialize with transfer_facilitator (FOR UPDATE on the same row), then
  -- check the role as it is now. Owning the project gives no right.
  perform 1 from public.projects p where p.id = cycle_project for share;

  if not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
  end if;

  -- Serialize with close_cycle (FOR UPDATE) and the card writes (FOR SHARE).
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = p_cycle_id
     for update;

  if cycle_status = 'collecting' then
    update public.feedback_cycles fc
       set status = 'reveal',
           revealed_at = pg_catalog.now()
     where fc.id = p_cycle_id;
  elsif cycle_status <> 'reveal' then
    raise exception using errcode = 'P0001', message = 'cycle_not_collecting';
  end if;

  return query
    select fc.id, fc.status, fc.revealed_at
    from public.feedback_cycles fc
    where fc.id = p_cycle_id;
end;
$$;

revoke all on function public.start_retrospective(uuid) from public;
revoke all on function public.start_retrospective(uuid) from anon, authenticated, service_role;

grant execute on function public.start_retrospective(uuid) to authenticated;
