-- Task 17: manual cluster creation, renaming, and deletion.
--
-- Cluster contract. Later tasks (#18, #19, #20, #21, #22, #24, #25, #36, #89)
-- build on these rules and must not weaken them:
--
--   * Who. Any current member of the cycle's project may create, rename, and
--     delete clusters. The facilitator and the owner get nothing extra: no
--     cluster RPC has a role branch.
--   * When. Cluster writes are allowed only while feedback_cycles.status is
--     'cluster'. In reveal the team has not started clustering; from vote on,
--     clusters are frozen because votes point at them (#22).
--   * Tables. public.clusters and public.cluster_cards are default-deny: RLS
--     is enabled with no policy, anon and authenticated hold no privilege,
--     and only service_role keeps select, insert, update, delete. Neither
--     table is in supabase_realtime. Clients read clusters only through
--     get_cycle_board and write them only through the security definer RPCs
--     below. There is no creator, editor, author, or actor column on either.
--     A card is in at most one cluster (cluster_cards' primary key is
--     card_id), and only in a cluster of its own cycle (composite foreign
--     keys). A missing cluster_cards row means the card is ungrouped.
--   * Name rules. The RPCs trim with btrim(p_name, E' \t\n\r') (the card
--     trim set), then reject with invalid_cluster_name: null, empty after
--     trimming, more than 100 characters, or any control character left
--     inside. A name equal to another cluster's name in the same cycle
--     ignoring case is cluster_name_taken; a unique index on
--     (cycle_id, lower(name)) backs this up. "Ungrouped" is an ordinary name
--     on the server; the client refuses it.
--   * Limit. A cycle holds at most 50 clusters (cluster_limit_reached).
--   * Order. create_cluster appends at coalesce(max(sort_order), 0) + 1 under
--     the cycle lock. sort_order is unique per cycle; deleting leaves gaps and
--     nothing renumbers. Clusters are listed by sort_order only; cards inside
--     a cluster by cluster_cards.sort_order, then card_id (never created_at).
--   * Locking. Every cluster write locks the cycle row FOR UPDATE, so it is
--     serialized with every other cluster write of the cycle and with
--     advance_stage and close_cycle. A write that loses the race to a stage
--     change gets cycle_not_clustering and changes nothing.
--   * Events. Statement-level AFTER INSERT, UPDATE, and DELETE triggers on
--     both tables record one cycle_events row of type clusters_changed per
--     distinct cycle among the changed rows, with from_status = to_status =
--     the cycle's current status, actor_id null, and payload '{}'. Who edited
--     a cluster is never broadcast, and no event carries a cluster id, card
--     id, name, or count. No RPC inserts into cycle_events; #18's, #19's, and
--     #20's writes broadcast through these triggers. A statement that changes
--     no row, or a cascade from a deleted cycle, records nothing.
--   * Board key. get_cycle_board gains exactly one key, clusters: [] before
--     reveal, otherwise every cluster of the cycle by sort_order, each with
--     exactly cluster_id, name, source, and card_ids. No timestamp,
--     sort_order, editor, creator, or count, and the same for every caller.
--
-- discussion_status is not added here; #25 adds it in its own migration.
--
-- This migration adds no policy, grant, view, or Realtime publication entry
-- on cards, card_authors, profiles, or feedback_cycles. Its only change to
-- cards is the unique constraint cards_id_cycle_id_key, which backs the
-- cluster_cards foreign key. No function here reads card_authors or profiles.

-- ---------------------------------------------------------------------------
-- cards: the target of cluster_cards' composite foreign key.
-- ---------------------------------------------------------------------------
alter table public.cards
  add constraint cards_id_cycle_id_key unique (id, cycle_id);

-- ---------------------------------------------------------------------------
-- clusters
-- ---------------------------------------------------------------------------
create table public.clusters (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null,
  name text not null,
  source text not null default 'manual',
  sort_order integer not null,
  -- Kept for operators only; never returned to clients.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clusters_cycle_id_fkey foreign key (cycle_id)
    references public.feedback_cycles (id) on delete cascade,
  constraint clusters_source_check check (source in ('manual', 'ai')),
  -- The RPCs apply the same trim set, length, and control-character rule.
  constraint clusters_name_check check (
    name = pg_catalog.btrim(name, E' \t\n\r')
    and pg_catalog.char_length(name) between 1 and 100
    and name !~ '[[:cntrl:]]'
  ),
  constraint clusters_cycle_id_sort_order_key unique (cycle_id, sort_order),
  constraint clusters_id_cycle_id_key unique (id, cycle_id)
);

create unique index clusters_cycle_id_lower_name_key
  on public.clusters (cycle_id, pg_catalog.lower(name));

-- ---------------------------------------------------------------------------
-- cluster_cards: at most one cluster per card, always of the card's cycle.
-- ---------------------------------------------------------------------------
create table public.cluster_cards (
  cycle_id uuid not null,
  cluster_id uuid not null,
  card_id uuid not null,
  sort_order integer not null default 0,
  constraint cluster_cards_pkey primary key (card_id),
  constraint cluster_cards_cluster_fkey foreign key (cluster_id, cycle_id)
    references public.clusters (id, cycle_id) on delete cascade,
  constraint cluster_cards_card_fkey foreign key (card_id, cycle_id)
    references public.cards (id, cycle_id) on delete cascade
);

create index cluster_cards_cluster_id_sort_order_idx
  on public.cluster_cards (cluster_id, sort_order);

-- ---------------------------------------------------------------------------
-- RLS and grants. Default-deny with no policies, as cards. Supabase's default
-- privileges would give anon and authenticated every privilege on a new
-- public table; revoke them explicitly.
-- ---------------------------------------------------------------------------
alter table public.clusters enable row level security;
alter table public.cluster_cards enable row level security;

revoke all on table public.clusters from public;
revoke all on table public.clusters from anon, authenticated, service_role;
revoke all on table public.cluster_cards from public;
revoke all on table public.cluster_cards from anon, authenticated, service_role;

grant select, insert, update, delete on table public.clusters to service_role;
grant select, insert, update, delete on table public.cluster_cards to service_role;

-- ---------------------------------------------------------------------------
-- Guards. BEFORE triggers fire in name order, so clusters_guard_update runs
-- before clusters_set_updated_at.
-- ---------------------------------------------------------------------------
create function private.guard_cluster_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.cycle_id is distinct from old.cycle_id
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = 'P0001', message = 'cluster_immutable_column';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_cluster_update() from public;
revoke all on function private.guard_cluster_update() from anon, authenticated, service_role;

create trigger clusters_guard_update
  before update on public.clusters
  for each row
  execute function private.guard_cluster_update();

create trigger clusters_set_updated_at
  before update on public.clusters
  for each row
  execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- clusters_changed events.
-- ---------------------------------------------------------------------------
alter table public.cycle_events
  drop constraint cycle_events_type_check;

alter table public.cycle_events
  add constraint cycle_events_type_check
  check (type in ('stage_changed', 'clusters_changed'));

-- A clusters_changed row names no actor, carries nothing, and changes no
-- stage.
alter table public.cycle_events
  add constraint cycle_events_clusters_changed_check check (
    type <> 'clusters_changed'
    or (from_status = to_status and actor_id is null and payload = '{}'::jsonb)
  );

-- One function for all six statement-level triggers. Each trigger names its
-- transition tables old_rows and/or new_rows; the branch reads only the ones
-- its event has. The cycle is looked up now, so a cascade from a deleted
-- cycle (or project) finds no row and records nothing.
create function private.record_clusters_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id, payload)
    select fc.id, 'clusters_changed', fc.status, fc.status, null, '{}'::jsonb
      from public.feedback_cycles fc
     where fc.id in (select n.cycle_id from new_rows n);
  elsif tg_op = 'UPDATE' then
    insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id, payload)
    select fc.id, 'clusters_changed', fc.status, fc.status, null, '{}'::jsonb
      from public.feedback_cycles fc
     where fc.id in (select n.cycle_id from new_rows n union select o.cycle_id from old_rows o);
  else
    insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id, payload)
    select fc.id, 'clusters_changed', fc.status, fc.status, null, '{}'::jsonb
      from public.feedback_cycles fc
     where fc.id in (select o.cycle_id from old_rows o);
  end if;

  return null;
end;
$$;

revoke all on function private.record_clusters_change() from public;
revoke all on function private.record_clusters_change() from anon, authenticated, service_role;

create trigger clusters_record_insert
  after insert on public.clusters
  referencing new table as new_rows
  for each statement
  execute function private.record_clusters_change();

create trigger clusters_record_update
  after update on public.clusters
  referencing old table as old_rows new table as new_rows
  for each statement
  execute function private.record_clusters_change();

create trigger clusters_record_delete
  after delete on public.clusters
  referencing old table as old_rows
  for each statement
  execute function private.record_clusters_change();

create trigger cluster_cards_record_insert
  after insert on public.cluster_cards
  referencing new table as new_rows
  for each statement
  execute function private.record_clusters_change();

create trigger cluster_cards_record_update
  after update on public.cluster_cards
  referencing old table as old_rows new table as new_rows
  for each statement
  execute function private.record_clusters_change();

create trigger cluster_cards_record_delete
  after delete on public.cluster_cards
  referencing old table as old_rows
  for each statement
  execute function private.record_clusters_change();

-- ---------------------------------------------------------------------------
-- create_cluster
--
-- Check order (each failing step changes nothing):
--   1. (select auth.uid()) is null                -> 42501 not_project_member
--   2. null or unknown cycle, or not a member     -> 42501 not_project_member
--   3. lock the cycle row FOR UPDATE
--   4. status is not cluster                      -> P0001 cycle_not_clustering
--   5. name rules -> invalid_cluster_name, then cluster_name_taken, then
--      50 clusters already                        -> P0001 cluster_limit_reached
--   6. insert with source 'manual', appended after the last cluster
-- ---------------------------------------------------------------------------
create function public.create_cluster(p_cycle_id uuid, p_name text)
returns table (
  cluster_id uuid,
  name text,
  source text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cycle_project uuid;
  cycle_status text;
  clean_name text;
  new_id uuid;
begin
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

  -- Serialize with every other cluster write, advance_stage, and close_cycle.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = p_cycle_id
     for update;

  if cycle_status is distinct from 'cluster' then
    raise exception using errcode = 'P0001', message = 'cycle_not_clustering';
  end if;

  clean_name := pg_catalog.btrim(p_name, E' \t\n\r');
  if clean_name is null
     or pg_catalog.char_length(clean_name) not between 1 and 100
     or clean_name ~ '[[:cntrl:]]' then
    raise exception using errcode = 'P0001', message = 'invalid_cluster_name';
  end if;

  if exists (
    select 1
      from public.clusters cl
     where cl.cycle_id = p_cycle_id
       and pg_catalog.lower(cl.name) = pg_catalog.lower(clean_name)
  ) then
    raise exception using errcode = 'P0001', message = 'cluster_name_taken';
  end if;

  if (select count(*) from public.clusters cl where cl.cycle_id = p_cycle_id) >= 50 then
    raise exception using errcode = 'P0001', message = 'cluster_limit_reached';
  end if;

  begin
    insert into public.clusters (cycle_id, name, source, sort_order)
    values (
      p_cycle_id,
      clean_name,
      'manual',
      (select coalesce(max(cl.sort_order), 0) + 1 from public.clusters cl where cl.cycle_id = p_cycle_id)
    )
    returning public.clusters.id into new_id;
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = 'cluster_name_taken';
  end;

  return query
    select cl.id, cl.name, cl.source
    from public.clusters cl
    where cl.id = new_id;
end;
$$;

revoke all on function public.create_cluster(uuid, text) from public;
revoke all on function public.create_cluster(uuid, text) from anon, authenticated, service_role;

grant execute on function public.create_cluster(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- rename_cluster
--
-- Check order (each failing step changes nothing):
--   1. (select auth.uid()) is null                -> 42501 not_project_member
--   2. null or unknown cluster, or a cluster of a project the caller is not
--      a member of                                -> P0001 cluster_not_found
--   3. lock the cycle row FOR UPDATE
--   4. the cluster was deleted meanwhile          -> P0001 cluster_not_found
--   5. status is not cluster                      -> P0001 cycle_not_clustering
--   6. name rules -> invalid_cluster_name, then cluster_name_taken (the
--      cluster's own row does not count)
--   7. the same name (same case) is a no-op that returns the current row;
--      otherwise set the name and source 'manual'
-- ---------------------------------------------------------------------------
create function public.rename_cluster(p_cluster_id uuid, p_name text)
returns table (
  cluster_id uuid,
  name text,
  source text
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
  current_name text;
  clean_name text;
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

  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = cluster_cycle
     for update;

  select cl.name
    into current_name
    from public.clusters cl
   where cl.id = p_cluster_id
     for update;

  if current_name is null then
    raise exception using errcode = 'P0001', message = 'cluster_not_found';
  end if;

  if cycle_status is distinct from 'cluster' then
    raise exception using errcode = 'P0001', message = 'cycle_not_clustering';
  end if;

  clean_name := pg_catalog.btrim(p_name, E' \t\n\r');
  if clean_name is null
     or pg_catalog.char_length(clean_name) not between 1 and 100
     or clean_name ~ '[[:cntrl:]]' then
    raise exception using errcode = 'P0001', message = 'invalid_cluster_name';
  end if;

  if exists (
    select 1
      from public.clusters cl
     where cl.cycle_id = cluster_cycle
       and cl.id <> p_cluster_id
       and pg_catalog.lower(cl.name) = pg_catalog.lower(clean_name)
  ) then
    raise exception using errcode = 'P0001', message = 'cluster_name_taken';
  end if;

  if clean_name is distinct from current_name then
    begin
      update public.clusters cl
         set name = clean_name,
             source = 'manual'
       where cl.id = p_cluster_id;
    exception
      when unique_violation then
        raise exception using errcode = 'P0001', message = 'cluster_name_taken';
    end;
  end if;

  return query
    select cl.id, cl.name, cl.source
    from public.clusters cl
    where cl.id = p_cluster_id;
end;
$$;

revoke all on function public.rename_cluster(uuid, text) from public;
revoke all on function public.rename_cluster(uuid, text) from anon, authenticated, service_role;

grant execute on function public.rename_cluster(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- delete_cluster
--
-- Check order (each failing step changes nothing):
--   1. (select auth.uid()) is null                -> 42501 not_project_member
--   2. null or unknown cluster, or a cluster of a project the caller is not
--      a member of                                -> P0001 cluster_not_found
--   3. lock the cycle row FOR UPDATE
--   4. the cluster was deleted meanwhile          -> P0001 cluster_not_found
--   5. status is not cluster                      -> P0001 cycle_not_clustering
--   6. delete the cluster; its cluster_cards rows go by cascade, so its
--      cards become ungrouped. No card is changed.
-- ---------------------------------------------------------------------------
create function public.delete_cluster(p_cluster_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cluster_cycle uuid;
  cycle_project uuid;
  cycle_status text;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  select cl.cycle_id, fc.project_id
    into cluster_cycle, cycle_project
    from public.clusters cl
    join public.feedback_cycles fc on fc.id = cl.cycle_id
   where cl.id = p_cluster_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = 'P0001', message = 'cluster_not_found';
  end if;

  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = cluster_cycle
     for update;

  if not exists (select 1 from public.clusters cl where cl.id = p_cluster_id) then
    raise exception using errcode = 'P0001', message = 'cluster_not_found';
  end if;

  if cycle_status is distinct from 'cluster' then
    raise exception using errcode = 'P0001', message = 'cycle_not_clustering';
  end if;

  delete from public.clusters cl where cl.id = p_cluster_id;
end;
$$;

revoke all on function public.delete_cluster(uuid) from public;
revoke all on function public.delete_cluster(uuid) from anon, authenticated, service_role;

grant execute on function public.delete_cluster(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_cycle_board gains the clusters key. Every rule of #15's board contract
-- (20261101160000_create_get_cycle_board.sql) still holds; the response now
-- has exactly five keys:
--
--   cycle_id, status, is_revealed, cards   unchanged
--   clusters   a JSON array, [] when there are none and always [] before
--              reveal, never null; ordered by clusters.sort_order; each
--              element has exactly cluster_id, name, source, card_ids, where
--              card_ids is a JSON array ([] when empty) ordered by
--              cluster_cards.sort_order, then card_id.
--
-- No card gains a key. Ungrouped cards are the ones in no cluster's card_ids.
-- The data scope grows by clusters and cluster_cards only. clusters carries
-- no timestamp, sort_order, editor, creator, or count, and is the same for
-- every caller.
-- ---------------------------------------------------------------------------
create or replace function public.get_cycle_board(p_cycle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cycle_project uuid;
  cycle_status text;
  cycle_revealed boolean;
  board_cards jsonb;
  board_clusters jsonb;
begin
  -- Unauthenticated, unknown cycle, non-member, and removed member look the
  -- same. Any cycle status is readable.
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  select fc.project_id, fc.status, fc.revealed_at is not null
    into cycle_project, cycle_status, cycle_revealed
    from public.feedback_cycles fc
   where fc.id = p_cycle_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- One set-based query. An anonymous card is built from cards columns only;
  -- the profile is joined for attributed cards alone.
  select coalesce(
           pg_catalog.jsonb_agg(
             case
               when c.is_anonymous then
                 pg_catalog.jsonb_build_object(
                   'card_id', c.id,
                   'category', c.category,
                   'text', c.text,
                   'is_anonymous', true
                 )
               else
                 pg_catalog.jsonb_build_object(
                   'card_id', c.id,
                   'category', c.category,
                   'text', c.text,
                   'is_anonymous', false,
                   'is_mine', coalesce(ca.author_id = (select auth.uid()), false),
                   'author_display_name', p.display_name
                 )
             end
             order by pg_catalog.array_position(array['start', 'stop', 'continue']::text[], c.category), c.id
           ),
           '[]'::jsonb
         )
    into board_cards
    from public.cards c
    left join public.card_authors ca on ca.card_id = c.id
    left join public.profiles p on not c.is_anonymous and p.id = ca.author_id
   where c.cycle_id = p_cycle_id
     and (cycle_revealed or ca.author_id = (select auth.uid()));

  -- Clusters only after reveal, the same for every caller. Built from
  -- clusters and cluster_cards columns only.
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'cluster_id', cl.id,
               'name', cl.name,
               'source', cl.source,
               'card_ids', coalesce(
                 (select pg_catalog.jsonb_agg(cc.card_id order by cc.sort_order, cc.card_id)
                    from public.cluster_cards cc
                   where cc.cluster_id = cl.id),
                 '[]'::jsonb
               )
             )
             order by cl.sort_order
           ),
           '[]'::jsonb
         )
    into board_clusters
    from public.clusters cl
   where cl.cycle_id = p_cycle_id
     and cycle_revealed;

  return pg_catalog.jsonb_build_object(
    'cycle_id', p_cycle_id,
    'status', cycle_status,
    'is_revealed', cycle_revealed,
    'cards', board_cards,
    'clusters', board_clusters
  );
end;
$$;

revoke all on function public.get_cycle_board(uuid) from public;
revoke all on function public.get_cycle_board(uuid) from anon, authenticated, service_role;

grant execute on function public.get_cycle_board(uuid) to authenticated;
