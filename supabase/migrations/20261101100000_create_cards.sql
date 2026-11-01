-- Task 11: feedback cards and the card RPCs.
--
-- Anonymity contract. Later tasks (#12-#15, #20) build on these rules and
-- must not weaken them:
--
--   * public.cards has no author column. The author link lives only in
--     public.card_authors (card_id, author_id).
--   * No client role (anon, authenticated, PUBLIC) has any privilege on cards
--     or card_authors. RLS is enabled on both with no policies, and there is
--     no self-select policy on card_authors: an author reads their own cards
--     through get_my_cards, which matches card_authors.author_id = auth.uid()
--     inside the function.
--   * Ownership is always derived from the session ((select auth.uid())). No
--     RPC takes a user id parameter, and no RPC returns author_id, a user id,
--     an email, or a display name.
--   * The facilitator and the project owner have no extra card rights. They
--     cannot read, edit, or delete another member's card, and they cannot
--     learn who wrote a card.
--   * A card id the caller did not write gets the same error as a card id
--     that does not exist (card_not_found).
--   * Card ids are random v4 UUIDs (gen_random_uuid()), never time-ordered.
--     Timestamps are set by the database and returned only to the author.
--   * is_anonymous is chosen per card, defaults to false (attributed), and
--     may change only while the cycle is collecting.
--   * Only create_card, update_card, delete_card, and get_my_cards read
--     card_authors. No view or other public function may read it. AI
--     clustering (#20) reads cards with the service role and never reads
--     card_authors.
--   * Neither table is in the supabase_realtime publication.
--   * Operator caveat (_docs/tech-stack.md section 4.4): anyone holding the
--     service-role key can still read card_authors.
--
-- Cards are writable only while their cycle is collecting. Every write RPC
-- reads the cycle row FOR SHARE before checking its status, so a write that
-- races close_cycle or start_retrospective (both FOR UPDATE) either commits
-- before the stage change or fails with cycle_not_collecting.

-- ---------------------------------------------------------------------------
-- cards
-- ---------------------------------------------------------------------------
create table public.cards (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null,
  category text not null,
  text text not null,
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cards_cycle_id_fkey foreign key (cycle_id)
    references public.feedback_cycles (id) on delete cascade,
  constraint cards_category_check check (
    category in ('start', 'stop', 'continue')
  ),
  -- The RPCs apply the same trim set and length before writing.
  constraint cards_text_check check (
    text = pg_catalog.btrim(text, E' \t\n\r')
    and pg_catalog.char_length(text) between 1 and 500
  )
);

create index cards_cycle_id_idx on public.cards (cycle_id);

-- ---------------------------------------------------------------------------
-- card_authors: the only link between a card and a user.
-- ---------------------------------------------------------------------------
create table public.card_authors (
  card_id uuid not null,
  author_id uuid not null,
  constraint card_authors_pkey primary key (card_id),
  constraint card_authors_card_id_fkey foreign key (card_id)
    references public.cards (id) on delete cascade,
  -- Deleting an auth user forgets their authorship but keeps their cards.
  constraint card_authors_author_id_fkey foreign key (author_id)
    references auth.users (id) on delete cascade
);

create index card_authors_author_id_idx on public.card_authors (author_id);

-- ---------------------------------------------------------------------------
-- RLS and grants. Both tables are default-deny with no policies. Supabase's
-- default privileges would give anon and authenticated every table privilege
-- on a new public table; revoke them explicitly. Only service_role keeps
-- plain read and write access.
-- ---------------------------------------------------------------------------
alter table public.cards enable row level security;
alter table public.card_authors enable row level security;

revoke all on table public.cards from public;
revoke all on table public.cards from anon, authenticated, service_role;
revoke all on table public.card_authors from public;
revoke all on table public.card_authors from anon, authenticated, service_role;

grant select, insert, update, delete on table public.cards to service_role;
grant select, insert, update, delete on table public.card_authors to service_role;

-- ---------------------------------------------------------------------------
-- Guards. Both run for every role. BEFORE triggers fire in name order, so
-- cards_guard_update runs before cards_set_updated_at.
-- ---------------------------------------------------------------------------
create function private.guard_card_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.cycle_id is distinct from old.cycle_id
     or new.category is distinct from old.category
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = 'P0001', message = 'card_immutable_column';
  end if;

  return new;
end;
$$;

create function private.guard_card_author_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'card_author_immutable';
end;
$$;

revoke all on function private.guard_card_update() from public;
revoke all on function private.guard_card_update() from anon, authenticated, service_role;
revoke all on function private.guard_card_author_update() from public;
revoke all on function private.guard_card_author_update() from anon, authenticated, service_role;

create trigger cards_guard_update
  before update on public.cards
  for each row
  execute function private.guard_card_update();

-- updated_at is owned by the database: this trigger overwrites it on update.
create trigger cards_set_updated_at
  before update on public.cards
  for each row
  execute function private.set_updated_at();

create trigger card_authors_guard_update
  before update on public.card_authors
  for each row
  execute function private.guard_card_author_update();

-- ---------------------------------------------------------------------------
-- RPCs. All four are security definer with an empty search_path, read the
-- caller from (select auth.uid()), use private.is_project_member, raise only
-- stable error codes with no detail or hint, and never log card text or ids.
-- ---------------------------------------------------------------------------
create function public.create_card(
  p_cycle_id uuid,
  p_category text,
  p_text text,
  p_is_anonymous boolean default false
)
returns table (
  id uuid,
  cycle_id uuid,
  category text,
  text text,
  is_anonymous boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cycle_project uuid;
  cycle_status text;
  clean_text text;
  new_id uuid;
begin
  -- 1. Unauthenticated, unknown cycle, and non-member look the same.
  if (select auth.uid()) is null then
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

  -- 2. Lock the cycle against a concurrent stage change, then check it.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = p_cycle_id
     for share;

  if cycle_status is distinct from 'collecting' then
    raise exception using errcode = 'P0001', message = 'cycle_not_collecting';
  end if;

  -- 3. The same categories as cards_category_check.
  if p_category is null
     or p_category not in ('start', 'stop', 'continue') then
    raise exception using errcode = 'P0001', message = 'invalid_card_category';
  end if;

  -- 4. The same trim set and length as cards_text_check.
  clean_text := pg_catalog.btrim(p_text, E' \t\n\r');
  if clean_text is null
     or pg_catalog.char_length(clean_text) not between 1 and 500 then
    raise exception using errcode = 'P0001', message = 'invalid_card_text';
  end if;

  -- 5. Anonymity is an explicit choice; null is not one.
  if p_is_anonymous is null then
    raise exception using errcode = 'P0001', message = 'invalid_card_anonymity';
  end if;

  insert into public.cards (cycle_id, category, text, is_anonymous)
  values (p_cycle_id, p_category, clean_text, p_is_anonymous)
  returning cards.id into new_id;

  insert into public.card_authors (card_id, author_id)
  values (new_id, (select auth.uid()));

  return query
    select c.id, c.cycle_id, c.category, c.text, c.is_anonymous, c.created_at, c.updated_at
    from public.cards c
    where c.id = new_id;
end;
$$;

create function public.update_card(
  p_card_id uuid,
  p_text text,
  p_is_anonymous boolean
)
returns table (
  id uuid,
  cycle_id uuid,
  category text,
  text text,
  is_anonymous boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  card_cycle uuid;
  card_text text;
  card_is_anonymous boolean;
  cycle_project uuid;
  cycle_status text;
  clean_text text;
begin
  -- 1. Unauthenticated.
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- 2. Unknown card and someone else's card look the same.
  select c.cycle_id, c.text, c.is_anonymous
    into card_cycle, card_text, card_is_anonymous
    from public.cards c
    join public.card_authors ca on ca.card_id = c.id
   where c.id = p_card_id
     and ca.author_id = (select auth.uid())
     for update of c;

  if card_cycle is null then
    raise exception using errcode = 'P0001', message = 'card_not_found';
  end if;

  -- 3. The author must still be a member of the project.
  select fc.project_id
    into cycle_project
    from public.feedback_cycles fc
   where fc.id = card_cycle;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- 4. Lock the cycle against a concurrent stage change, then check it.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = card_cycle
     for share;

  if cycle_status is distinct from 'collecting' then
    raise exception using errcode = 'P0001', message = 'cycle_not_collecting';
  end if;

  -- 5. The same rules as create_card.
  clean_text := pg_catalog.btrim(p_text, E' \t\n\r');
  if clean_text is null
     or pg_catalog.char_length(clean_text) not between 1 and 500 then
    raise exception using errcode = 'P0001', message = 'invalid_card_text';
  end if;

  if p_is_anonymous is null then
    raise exception using errcode = 'P0001', message = 'invalid_card_anonymity';
  end if;

  -- An edit that changes nothing writes nothing and keeps updated_at.
  if clean_text is distinct from card_text
     or p_is_anonymous is distinct from card_is_anonymous then
    update public.cards c
       set text = clean_text,
           is_anonymous = p_is_anonymous
     where c.id = p_card_id;
  end if;

  return query
    select c.id, c.cycle_id, c.category, c.text, c.is_anonymous, c.created_at, c.updated_at
    from public.cards c
    where c.id = p_card_id;
end;
$$;

create function public.delete_card(p_card_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  card_cycle uuid;
  cycle_project uuid;
  cycle_status text;
begin
  -- 1. Unauthenticated.
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- 2. Unknown card and someone else's card look the same.
  select c.cycle_id
    into card_cycle
    from public.cards c
    join public.card_authors ca on ca.card_id = c.id
   where c.id = p_card_id
     and ca.author_id = (select auth.uid())
     for update of c;

  if card_cycle is null then
    raise exception using errcode = 'P0001', message = 'card_not_found';
  end if;

  -- 3. The author must still be a member of the project.
  select fc.project_id
    into cycle_project
    from public.feedback_cycles fc
   where fc.id = card_cycle;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- 4. Lock the cycle against a concurrent stage change, then check it.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = card_cycle
     for share;

  if cycle_status is distinct from 'collecting' then
    raise exception using errcode = 'P0001', message = 'cycle_not_collecting';
  end if;

  -- The card_authors row goes with the card through its cascade.
  delete from public.cards c
   where c.id = p_card_id;
end;
$$;

create function public.get_my_cards(p_cycle_id uuid)
returns table (
  id uuid,
  category text,
  text text,
  is_anonymous boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cycle_project uuid;
begin
  -- Unauthenticated, unknown cycle, non-member, and removed member look the
  -- same. Any cycle status is readable.
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

  return query
    select c.id, c.category, c.text, c.is_anonymous, c.created_at, c.updated_at
    from public.cards c
    join public.card_authors ca on ca.card_id = c.id
    where c.cycle_id = p_cycle_id
      and ca.author_id = (select auth.uid())
    order by c.created_at, c.id;
end;
$$;

revoke all on function public.create_card(uuid, text, text, boolean) from public;
revoke all on function public.create_card(uuid, text, text, boolean) from anon, authenticated, service_role;
revoke all on function public.update_card(uuid, text, boolean) from public;
revoke all on function public.update_card(uuid, text, boolean) from anon, authenticated, service_role;
revoke all on function public.delete_card(uuid) from public;
revoke all on function public.delete_card(uuid) from anon, authenticated, service_role;
revoke all on function public.get_my_cards(uuid) from public;
revoke all on function public.get_my_cards(uuid) from anon, authenticated, service_role;

grant execute on function public.create_card(uuid, text, text, boolean) to authenticated;
grant execute on function public.update_card(uuid, text, boolean) to authenticated;
grant execute on function public.delete_card(uuid) to authenticated;
grant execute on function public.get_my_cards(uuid) to authenticated;
