-- Task 10: weekly feedback cycles.
--
-- Members read their projects' cycles through RLS. Nobody writes the table
-- through PostgREST: the facilitator-only create_cycle and close_cycle RPCs
-- are the only client write path. The status column and its transition rules
-- are defined here for every later workflow task:
--
--   collecting -> reveal -> cluster -> vote -> discuss -> closed
--   any open status -> closed (close_cycle, ending a cycle early)
--
-- A cycle is open while its status is anything but closed; closed is
-- terminal. The guard trigger enforces the transitions for every role,
-- including service_role and security definer functions.

create table public.feedback_cycles (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  title text not null,
  week_start date not null,
  status text not null default 'collecting',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revealed_at timestamptz,
  voting_closed_at timestamptz,
  closed_at timestamptz,
  constraint feedback_cycles_project_id_fkey foreign key (project_id)
    references public.projects (id) on delete cascade,
  -- Deleting an auth user never deletes a cycle; it only forgets the creator.
  constraint feedback_cycles_created_by_fkey foreign key (created_by)
    references auth.users (id) on delete set null,
  constraint feedback_cycles_status_check check (
    status in ('collecting', 'reveal', 'cluster', 'vote', 'discuss', 'closed')
  ),
  -- The same rule as projects_name_check.
  constraint feedback_cycles_title_check check (
    title = pg_catalog.btrim(title, E' \t\n\r')
    and pg_catalog.char_length(title) between 1 and 100
  ),
  -- week_start is the Monday of the ISO week the cycle covers.
  constraint feedback_cycles_week_start_monday_check check (
    extract(isodow from week_start) = 1
  ),
  constraint feedback_cycles_closed_at_check check (
    (status = 'closed') = (closed_at is not null)
  ),
  constraint feedback_cycles_revealed_at_check check (
    status <> 'collecting' or revealed_at is null
  )
);

-- A project never has more than one open cycle. Several cycles may share a
-- week_start (for example after a cycle was closed early by mistake).
create unique index feedback_cycles_one_open_idx
  on public.feedback_cycles (project_id)
  where status <> 'closed';

-- The project page lists a project's cycles newest first.
create index feedback_cycles_project_created_idx
  on public.feedback_cycles (project_id, created_at desc);

alter table public.feedback_cycles enable row level security;

-- Supabase's default privileges would give anon and authenticated every table
-- privilege on a new public table. Revoke those defaults explicitly and grant
-- back only what the product needs: authenticated may read, nothing more.
revoke all on table public.feedback_cycles from public;
revoke all on table public.feedback_cycles from anon, authenticated, service_role;

grant select on table public.feedback_cycles to authenticated;
grant select, insert, update, delete on table public.feedback_cycles to service_role;

-- A member reads every cycle of their projects and nothing else. There is no
-- INSERT, UPDATE, or DELETE policy: only the RPCs below write the table.
create policy feedback_cycles_select_member
  on public.feedback_cycles
  for select
  to authenticated
  using (private.is_project_member(project_id));

-- ---------------------------------------------------------------------------
-- Transition and immutability guard. It runs before set_updated_at (BEFORE
-- triggers fire in name order) and applies to every role.
-- ---------------------------------------------------------------------------
--
-- created_by has one exception: the feedback_cycles_created_by_fkey ON DELETE
-- SET NULL action is itself an UPDATE, so created_by may become null once the
-- auth user it names no longer exists. Any other change is rejected. The
-- function is security definer only so it can see auth.users for that check.
create function private.guard_feedback_cycle_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.project_id is distinct from old.project_id
     or new.week_start is distinct from old.week_start
     or new.created_at is distinct from old.created_at
     or (
       new.created_by is distinct from old.created_by
       and not (
         new.created_by is null
         and not exists (
           select 1 from auth.users u where u.id = old.created_by
         )
       )
     ) then
    raise exception using errcode = 'P0001', message = 'cycle_immutable_column';
  end if;

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
    raise exception using errcode = 'P0001', message = 'invalid_status_transition';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_feedback_cycle_update() from public;
revoke all on function private.guard_feedback_cycle_update() from anon, authenticated, service_role;

create trigger feedback_cycles_guard_update
  before update on public.feedback_cycles
  for each row
  execute function private.guard_feedback_cycle_update();

-- updated_at is owned by the database: this trigger overwrites it on update.
create trigger feedback_cycles_set_updated_at
  before update on public.feedback_cycles
  for each row
  execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- RPCs. Both are security definer with an empty search_path, check the caller
-- inside the function, and raise only stable error codes. Control follows the
-- caller's current project_members.role; the cycle only records its creator.
-- ---------------------------------------------------------------------------
create function public.create_cycle(
  p_project_id uuid,
  p_title text,
  p_week_start date
)
returns table (
  id uuid,
  project_id uuid,
  title text,
  week_start date,
  status text,
  created_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_title text;
  new_id uuid;
begin
  -- 1. Unauthenticated, non-member, and unknown project look the same.
  if (select auth.uid()) is null
     or not private.is_project_member(p_project_id) then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- 2. Only the current facilitator may act, whoever owns the project.
  if not private.is_project_facilitator(p_project_id) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
  end if;

  -- 3. The title is trimmed and must be 1-100 characters.
  clean_title := pg_catalog.btrim(p_title, E' \t\n\r');
  if clean_title is null
     or pg_catalog.char_length(clean_title) not between 1 and 100 then
    raise exception using errcode = 'P0001', message = 'invalid_cycle_title';
  end if;

  -- 4. A Monday within 28 days of the database's current date.
  if p_week_start is null
     or extract(isodow from p_week_start) <> 1
     or pg_catalog.abs(p_week_start - current_date) > 28 then
    raise exception using errcode = 'P0001', message = 'invalid_week_start';
  end if;

  -- 5. Serialize cycle creation per project before the open-cycle check.
  perform 1 from public.projects p where p.id = p_project_id for update;

  if exists (
    select 1
    from public.feedback_cycles fc
    where fc.project_id = p_project_id
      and fc.status <> 'closed'
  ) then
    raise exception using errcode = 'P0001', message = 'cycle_already_open';
  end if;

  begin
    insert into public.feedback_cycles (project_id, title, week_start, status, created_by)
    values (p_project_id, clean_title, p_week_start, 'collecting', (select auth.uid()))
    returning feedback_cycles.id into new_id;
  exception
    -- feedback_cycles_one_open_idx is the only unique index a new row with a
    -- generated id can violate.
    when unique_violation then
      raise exception using errcode = 'P0001', message = 'cycle_already_open';
  end;

  return query
    select fc.id, fc.project_id, fc.title, fc.week_start, fc.status, fc.created_at
    from public.feedback_cycles fc
    where fc.id = new_id;
end;
$$;

create function public.close_cycle(p_cycle_id uuid)
returns table (
  id uuid,
  status text,
  closed_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cycle_project uuid;
  cycle_status text;
  cycle_closed_at timestamptz;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- project_id never changes, so it can be read before the lock.
  select fc.project_id
    into cycle_project
    from public.feedback_cycles fc
   where fc.id = p_cycle_id;

  -- An unknown cycle id and a non-member look the same.
  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  if not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
  end if;

  select fc.status, fc.closed_at
    into cycle_status, cycle_closed_at
    from public.feedback_cycles fc
   where fc.id = p_cycle_id
     for update;

  -- Closing an already closed cycle is a successful no-op.
  if cycle_status = 'closed' then
    return query select p_cycle_id, cycle_status, cycle_closed_at;
    return;
  end if;

  update public.feedback_cycles fc
     set status = 'closed',
         closed_at = pg_catalog.now()
   where fc.id = p_cycle_id;

  return query
    select fc.id, fc.status, fc.closed_at
    from public.feedback_cycles fc
    where fc.id = p_cycle_id;
end;
$$;

revoke all on function public.create_cycle(uuid, text, date) from public;
revoke all on function public.create_cycle(uuid, text, date) from anon, authenticated, service_role;
revoke all on function public.close_cycle(uuid) from public;
revoke all on function public.close_cycle(uuid) from anon, authenticated, service_role;

grant execute on function public.create_cycle(uuid, text, date) to authenticated;
grant execute on function public.close_cycle(uuid) to authenticated;
