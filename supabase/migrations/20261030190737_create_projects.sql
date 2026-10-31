-- Task 7: projects owned by a single auth user.
--
-- Access is direct table access through PostgREST with no RPC or view. RLS is
-- the row boundary and the column grants below keep the client from supplying
-- its own id or timestamps. The owner_id foreign key deliberately restricts
-- auth-user deletion so a project can never be orphaned.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_name_check check (
    name = pg_catalog.btrim(name, E' \t\n\r')
    and pg_catalog.char_length(name) between 1 and 100
  )
);

alter table public.projects enable row level security;

-- Supabase's default privileges would give anon and authenticated every table
-- privilege on a new public table. Revoke those defaults explicitly and grant
-- back only what the product needs.
revoke all on table public.projects from public;
revoke all on table public.projects from anon, authenticated, service_role;

grant select on table public.projects to authenticated;
grant insert (name, owner_id) on table public.projects to authenticated;
grant update (name) on table public.projects to authenticated;
grant select, insert, update, delete on table public.projects to service_role;

-- A user may read, create, and rename only their own projects. There is no
-- DELETE policy or DELETE grant in this task: projects cannot be removed yet.
create policy projects_select_own
  on public.projects
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

create policy projects_insert_own
  on public.projects
  for insert
  to authenticated
  with check (owner_id = (select auth.uid()));

create policy projects_update_own
  on public.projects
  for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- The project list reads newest first.
create index projects_owner_created_idx
  on public.projects (owner_id, created_at desc);

-- updated_at is owned by the database, never by the client: the column is not
-- in authenticated's UPDATE grant and this trigger overwrites it on update.
create trigger projects_set_updated_at
  before update on public.projects
  for each row
  execute function private.set_updated_at();
