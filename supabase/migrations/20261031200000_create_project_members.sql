-- Task 8: project membership, invite links, and the facilitator role.
--
-- Membership rows are written only by triggers and security definer RPCs; the
-- client can read its co-members' rows through RLS but never insert, update,
-- or delete them. Invite rows are never readable through PostgREST at all:
-- only the owner-only RPCs below touch project_invites.
--
-- Ownership is never a role value. It is always projects.owner_id, and the
-- owner always holds a membership row whose role is facilitator or member.

-- ---------------------------------------------------------------------------
-- project_members
-- ---------------------------------------------------------------------------
create table public.project_members (
  project_id uuid not null,
  user_id uuid not null,
  role text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_members_pkey primary key (project_id, user_id),
  constraint project_members_project_id_fkey foreign key (project_id)
    references public.projects (id) on delete cascade,
  constraint project_members_user_id_fkey foreign key (user_id)
    references auth.users (id) on delete cascade,
  constraint project_members_role_check check (
    role in ('facilitator', 'member')
  )
);

-- Exactly one facilitator per project; the triggers below keep at least one.
create unique index project_members_one_facilitator_idx
  on public.project_members (project_id)
  where role = 'facilitator';

-- The "my projects" lookup and the membership helper read by user id.
create index project_members_user_idx
  on public.project_members (user_id);

create trigger project_members_set_updated_at
  before update on public.project_members
  for each row
  execute function private.set_updated_at();

alter table public.project_members enable row level security;

-- Supabase's default privileges would give anon and authenticated every table
-- privilege on a new public table. Revoke those defaults explicitly and grant
-- back only what the product needs: authenticated may read, nothing more.
revoke all on table public.project_members from public;
revoke all on table public.project_members from anon, authenticated, service_role;

grant select on table public.project_members to authenticated;
grant select, insert, update, delete on table public.project_members to service_role;

-- ---------------------------------------------------------------------------
-- Membership helpers. They are security definer so the project_members policy
-- can call them without querying project_members recursively through RLS.
-- ---------------------------------------------------------------------------
create function private.is_project_member(project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members pm
    where pm.project_id = is_project_member.project_id
      and pm.user_id = (select auth.uid())
  );
$$;

-- Reused by facilitator-only workflow RPCs from #10 onward.
create function private.is_project_facilitator(project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members pm
    where pm.project_id = is_project_facilitator.project_id
      and pm.user_id = (select auth.uid())
      and pm.role = 'facilitator'
  );
$$;

revoke all on function private.is_project_member(uuid) from public;
revoke all on function private.is_project_member(uuid) from anon, authenticated, service_role;
revoke all on function private.is_project_facilitator(uuid) from public;
revoke all on function private.is_project_facilitator(uuid) from anon, authenticated, service_role;

-- RLS policies run as the querying role, so authenticated needs the schema
-- and these two helpers. The private schema stays out of the Data API.
grant usage on schema private to authenticated;
grant execute on function private.is_project_member(uuid) to authenticated;
grant execute on function private.is_project_facilitator(uuid) to authenticated;

-- A member reads every membership row of their projects and nothing else.
-- There is no INSERT, UPDATE, or DELETE policy.
create policy project_members_select_member
  on public.project_members
  for select
  to authenticated
  using (private.is_project_member(project_id));

-- ---------------------------------------------------------------------------
-- Projects: members can read the project, owners still own writes.
-- ---------------------------------------------------------------------------
-- The owner clause stays so `insert ... returning` in createProject works
-- before the AFTER INSERT membership trigger has run.
drop policy projects_select_own on public.projects;

create policy projects_select_member
  on public.projects
  for select
  to authenticated
  using (
    owner_id = (select auth.uid())
    or private.is_project_member(id)
  );

-- ---------------------------------------------------------------------------
-- Owner membership and the last-facilitator guard.
-- ---------------------------------------------------------------------------
create function private.add_project_owner_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.owner_id, 'facilitator')
  on conflict (project_id, user_id) do nothing;

  return new;
end;
$$;

revoke all on function private.add_project_owner_member() from public;
revoke all on function private.add_project_owner_member() from anon, authenticated, service_role;

create trigger projects_add_owner_member
  after insert on public.projects
  for each row
  execute function private.add_project_owner_member();

-- When a facilitator's row disappears while its project still exists (for
-- example an operator deletes that auth user and the cascade fires), the
-- owner takes the role back in the same transaction. When the project itself
-- is being deleted, the project row is already gone and nothing happens.
create function private.restore_project_facilitator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  project_owner uuid;
begin
  if old.role <> 'facilitator' then
    return old;
  end if;

  select p.owner_id
    into project_owner
    from public.projects p
   where p.id = old.project_id;

  if project_owner is null then
    return old;
  end if;

  if exists (
    select 1
    from public.project_members pm
    where pm.project_id = old.project_id
      and pm.role = 'facilitator'
  ) then
    return old;
  end if;

  insert into public.project_members (project_id, user_id, role)
  values (old.project_id, project_owner, 'facilitator')
  on conflict (project_id, user_id) do update
    set role = 'facilitator';

  return old;
end;
$$;

revoke all on function private.restore_project_facilitator() from public;
revoke all on function private.restore_project_facilitator() from anon, authenticated, service_role;

create trigger project_members_restore_facilitator
  after delete on public.project_members
  for each row
  execute function private.restore_project_facilitator();

-- Backfill: every existing project's owner becomes its facilitator, joined at
-- the project's creation time. Safe to run more than once.
insert into public.project_members (project_id, user_id, role, created_at, updated_at)
select p.id, p.owner_id, 'facilitator', p.created_at, p.created_at
from public.projects p
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- project_invites: one reusable link per project, readable only via RPCs.
-- ---------------------------------------------------------------------------
create table public.project_invites (
  project_id uuid not null,
  token text not null,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint project_invites_pkey primary key (project_id),
  constraint project_invites_project_id_fkey foreign key (project_id)
    references public.projects (id) on delete cascade,
  constraint project_invites_token_key unique (token)
);

alter table public.project_invites enable row level security;

revoke all on table public.project_invites from public;
revoke all on table public.project_invites from anon, authenticated, service_role;

grant select, insert, update, delete on table public.project_invites to service_role;

-- ---------------------------------------------------------------------------
-- RPCs. Every one is security definer with an empty search_path, checks the
-- caller inside the function, and raises only stable error codes.
-- ---------------------------------------------------------------------------

-- Raises not_project_owner unless the caller owns the project. An unknown id
-- raises the same error so project existence is never leaked.
create function private.assert_project_owner(p_project_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null
     or not exists (
       select 1
       from public.projects p
       where p.id = p_project_id
         and p.owner_id = (select auth.uid())
     ) then
    raise exception using errcode = '42501', message = 'not_project_owner';
  end if;
end;
$$;

revoke all on function private.assert_project_owner(uuid) from public;
revoke all on function private.assert_project_owner(uuid) from anon, authenticated, service_role;

create function public.create_project_invite(p_project_id uuid)
returns table (token text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  new_token text;
  new_expires_at timestamptz;
begin
  perform private.assert_project_owner(p_project_id);

  new_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  new_expires_at := pg_catalog.now() + interval '7 days';

  insert into public.project_invites as pi (project_id, token, created_by, expires_at, revoked_at)
  values (p_project_id, new_token, (select auth.uid()), new_expires_at, null)
  on conflict on constraint project_invites_pkey do update
    set token = excluded.token,
        created_by = excluded.created_by,
        created_at = pg_catalog.now(),
        expires_at = excluded.expires_at,
        revoked_at = null;

  return query select new_token, new_expires_at;
end;
$$;

create function public.get_project_invite(p_project_id uuid)
returns table (token text, expires_at timestamptz, status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_project_owner(p_project_id);

  return query
    select
      pi.token,
      pi.expires_at,
      case
        when pi.revoked_at is not null then 'revoked'
        when pi.expires_at <= pg_catalog.now() then 'expired'
        else 'active'
      end
    from public.project_invites pi
    where pi.project_id = p_project_id;
end;
$$;

create function public.revoke_project_invite(p_project_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.assert_project_owner(p_project_id);

  update public.project_invites pi
     set revoked_at = pg_catalog.now()
   where pi.project_id = p_project_id
     and pi.revoked_at is null;
end;
$$;

create function public.join_project(p_token text)
returns table (project_id uuid, project_name text, already_member boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  invite_project uuid;
  invite_expires_at timestamptz;
  invite_revoked_at timestamptz;
  inserted_count integer;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;

  -- The token is validated before membership so members and non-members see
  -- the same errors.
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invite_invalid';
  end if;

  select pi.project_id, pi.expires_at, pi.revoked_at
    into invite_project, invite_expires_at, invite_revoked_at
    from public.project_invites pi
   where pi.token = p_token;

  if invite_project is null or invite_revoked_at is not null then
    raise exception using errcode = 'P0001', message = 'invite_invalid';
  end if;

  if invite_expires_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'invite_expired';
  end if;

  insert into public.project_members (project_id, user_id, role)
  values (invite_project, caller, 'member')
  on conflict on constraint project_members_pkey do nothing;

  get diagnostics inserted_count = row_count;

  return query
    select p.id, p.name, inserted_count = 0
    from public.projects p
    where p.id = invite_project;
end;
$$;

create function public.get_project_members(p_project_id uuid)
returns table (
  user_id uuid,
  display_name text,
  role text,
  is_owner boolean,
  is_me boolean,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null
     or not exists (
       select 1
       from public.project_members pm
       where pm.project_id = p_project_id
         and pm.user_id = caller
     ) then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  return query
    select
      pm.user_id,
      coalesce(pr.display_name, 'Member'),
      pm.role,
      pm.user_id = p.owner_id,
      pm.user_id = caller,
      pm.created_at
    from public.project_members pm
    join public.projects p on p.id = pm.project_id
    left join public.profiles pr on pr.id = pm.user_id
    where pm.project_id = p_project_id
    order by pm.created_at, pm.user_id;
end;
$$;

create function public.transfer_facilitator(p_project_id uuid, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.assert_project_owner(p_project_id);

  -- Serialize transfers on the same project.
  perform 1 from public.projects p where p.id = p_project_id for update;

  if not exists (
    select 1
    from public.project_members pm
    where pm.project_id = p_project_id
      and pm.user_id = p_user_id
  ) then
    raise exception using errcode = 'P0001', message = 'target_not_member';
  end if;

  if exists (
    select 1
    from public.project_members pm
    where pm.project_id = p_project_id
      and pm.user_id = p_user_id
      and pm.role = 'facilitator'
  ) then
    return;
  end if;

  update public.project_members pm
     set role = 'member'
   where pm.project_id = p_project_id
     and pm.role = 'facilitator';

  update public.project_members pm
     set role = 'facilitator'
   where pm.project_id = p_project_id
     and pm.user_id = p_user_id;
end;
$$;

revoke all on function public.create_project_invite(uuid) from public;
revoke all on function public.create_project_invite(uuid) from anon, authenticated, service_role;
revoke all on function public.get_project_invite(uuid) from public;
revoke all on function public.get_project_invite(uuid) from anon, authenticated, service_role;
revoke all on function public.revoke_project_invite(uuid) from public;
revoke all on function public.revoke_project_invite(uuid) from anon, authenticated, service_role;
revoke all on function public.join_project(text) from public;
revoke all on function public.join_project(text) from anon, authenticated, service_role;
revoke all on function public.get_project_members(uuid) from public;
revoke all on function public.get_project_members(uuid) from anon, authenticated, service_role;
revoke all on function public.transfer_facilitator(uuid, uuid) from public;
revoke all on function public.transfer_facilitator(uuid, uuid) from anon, authenticated, service_role;

grant execute on function public.create_project_invite(uuid) to authenticated;
grant execute on function public.get_project_invite(uuid) to authenticated;
grant execute on function public.revoke_project_invite(uuid) to authenticated;
grant execute on function public.join_project(text) to authenticated;
grant execute on function public.get_project_members(uuid) to authenticated;
grant execute on function public.transfer_facilitator(uuid, uuid) to authenticated;
