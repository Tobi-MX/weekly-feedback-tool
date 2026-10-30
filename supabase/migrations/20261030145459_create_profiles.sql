-- Task 4: base profile schema, signup trigger, and the shared updated_at trigger.
--
-- Every schema, function, trigger, policy, and grant change for this task lives
-- in this migration. The private schema is intentionally absent from the Data
-- API: it is not listed in [api] schemas nor in extra_search_path.

-- Internal helpers live in the private schema so they are never exposed through
-- PostgREST. New schemas grant nothing to PUBLIC by default; the revokes below
-- make that guarantee explicit.
create schema if not exists private;

-- Reusable trigger function: stamps updated_at with the database clock whenever
-- a row is updated. It is generic and never references a concrete table, so
-- later tables can attach their own trigger to it.
create function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on schema private from public;
revoke all on schema private from anon, authenticated;
revoke all on function private.set_updated_at() from public;
revoke all on function private.set_updated_at() from anon, authenticated;

-- One profile per auth user. There is deliberately no email, author, role, or
-- other column: those belong elsewhere in the data model.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_check check (
    display_name = pg_catalog.btrim(display_name, E' \t\n\r')
    and pg_catalog.char_length(display_name) between 1 and 100
  )
);

alter table public.profiles enable row level security;

-- Members may read and edit only their own profile row. There is no INSERT or
-- DELETE policy: profiles are created by the signup trigger and removed by the
-- auth-users cascade.
create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Supabase's default privileges would give anon and authenticated every table
-- privilege on a new public table. Revoke those defaults explicitly and grant
-- back only what the product needs.
revoke all on table public.profiles from public;
revoke all on table public.profiles from anon, authenticated, service_role;

grant select on table public.profiles to authenticated;
grant update (display_name, avatar_url) on table public.profiles to authenticated;
grant select, insert, update, delete on table public.profiles to service_role;

-- updated_at is owned by the database, never by the client: the column is not
-- in authenticated's UPDATE grant and this trigger overwrites it on update.
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function private.set_updated_at();

-- Signup trigger. The function is security definer (owned by the migration role
-- postgres) because there is intentionally no INSERT policy on profiles. It
-- treats signup metadata defensively: only JSON strings are usable sources, and
-- every source is trimmed with the same ASCII whitespace definition as the
-- CHECK constraint before measuring in characters.
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  metadata jsonb := '{}'::jsonb;
  key_name text;
  candidate text;
  chosen_name text;
  chosen_avatar text;
begin
  if new.raw_user_meta_data is not null
     and pg_catalog.jsonb_typeof(new.raw_user_meta_data) = 'object' then
    metadata := new.raw_user_meta_data;
  end if;

  foreach key_name in array array['display_name', 'full_name', 'name'] loop
    if metadata ? key_name
       and pg_catalog.jsonb_typeof(metadata -> key_name) = 'string' then
      candidate := pg_catalog.btrim(metadata ->> key_name, E' \t\n\r');
      if candidate <> '' then
        chosen_name := candidate;
        exit;
      end if;
    end if;
  end loop;

  if chosen_name is null and new.email is not null then
    candidate := pg_catalog.btrim(
      pg_catalog.split_part(new.email, '@', 1),
      E' \t\n\r'
    );
    if candidate <> '' then
      chosen_name := candidate;
    end if;
  end if;

  if chosen_name is null then
    chosen_name := 'Member';
  end if;

  -- Truncate in characters so a multibyte character is never split. Trimming
  -- the truncation boundary keeps the value valid when the 100th character of
  -- the source happens to be ASCII whitespace.
  chosen_name := pg_catalog.left(chosen_name, 100);
  chosen_name := pg_catalog.rtrim(chosen_name, E' \t\n\r');

  if metadata ? 'avatar_url'
     and pg_catalog.jsonb_typeof(metadata -> 'avatar_url') = 'string' then
    candidate := pg_catalog.btrim(metadata ->> 'avatar_url', E' \t\n\r');
    if candidate <> '' then
      chosen_avatar := candidate;
    end if;
  end if;

  if chosen_avatar is null
     and metadata ? 'picture'
     and pg_catalog.jsonb_typeof(metadata -> 'picture') = 'string' then
    candidate := pg_catalog.btrim(metadata ->> 'picture', E' \t\n\r');
    if candidate <> '' then
      chosen_avatar := candidate;
    end if;
  end if;

  insert into public.profiles (id, display_name, avatar_url)
  values (new.id, chosen_name, chosen_avatar)
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function private.handle_new_user() from public;
revoke all on function private.handle_new_user() from anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function private.handle_new_user();
