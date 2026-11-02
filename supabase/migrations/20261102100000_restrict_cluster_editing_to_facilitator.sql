-- Task 19b: only the project's current facilitator may edit clusters.
--
-- Who. Only the current facilitator of the cycle's project may create,
-- rename, and delete clusters, move cards, and merge and split clusters.
-- Every other member, and the owner when they are not the facilitator, gets
-- 42501 not_project_facilitator from each of the six cluster RPCs, in every
-- stage, and nothing changes. Owning the project gives no right: the check is
-- private.is_project_facilitator(project_id), which reads the caller's own
-- project_members row. This rule replaces the "Who" bullet of the #17
-- (20261101200000_create_clusters.sql), #18
-- (20261101220000_create_move_card.sql), and #19
-- (20261101230000_create_merge_split_clusters.sql) migrations; every other
-- rule of those contracts still holds.
--
-- What changes. Each function below is redefined with the same signature,
-- return type, security definer, volatile, search_path, and grants, and its
-- body is the body it had before with exactly one addition, the facilitator
-- block copied from advance_stage (20261101180000_create_advance_stage.sql):
--
--   lock the projects row FOR SHARE (serializes with transfer_facilitator,
--   which locks it FOR UPDATE); the caller is not the facilitator now
--                                                -> 42501 not_project_facilitator
--
-- It sits right after the existing membership step and before the cycle row
-- lock. A null user, an unknown or null id, and a non-member still fail first
-- with the same error as before (not_project_member for create_cluster,
-- cluster_not_found for rename, delete, merge, and split, card_not_found for
-- move_card), so the new step lets no one probe ids. A facilitator outside
-- cluster still gets cycle_not_clustering; a member who is not the
-- facilitator gets not_project_facilitator first, as in advance_stage.
--
-- Lock order. Every cluster RPC now takes projects FOR SHARE, then
-- feedback_cycles FOR UPDATE, the same order as start_retrospective and
-- advance_stage. transfer_facilitator locks only projects (FOR UPDATE) and
-- close_cycle only the cycle row, so no lock-order cycle exists. If a
-- transfer commits first, the waiting edit's is_project_facilitator call sees
-- the new role (READ COMMITTED) and the former facilitator is refused; if the
-- edit holds the share lock first, the transfer waits until it commits.
--
-- Nothing else changes: no error code, name rule, renumbering, source rule,
-- no-op rule, or return value. No function here reads owner_id,
-- card_authors, or profiles, inserts into cycle_events, or records an actor;
-- events still come only from #17's triggers with actor_id null and payload
-- '{}'. A refused call writes nothing, so it records no event.
--
-- This migration adds no table, column, constraint, policy, grant on a
-- table, view, or Realtime publication entry. get_cycle_board is unchanged.

-- ---------------------------------------------------------------------------
-- create_cluster
--
-- Check order (each failing step changes nothing):
--   1. (select auth.uid()) is null                -> 42501 not_project_member
--   2. null or unknown cycle, or not a member     -> 42501 not_project_member
--   3. lock the projects row FOR SHARE
--   4. not the facilitator now                    -> 42501 not_project_facilitator
--   5. lock the cycle row FOR UPDATE
--   6. status is not cluster                      -> P0001 cycle_not_clustering
--   7. name rules -> invalid_cluster_name, then cluster_name_taken, then
--      50 clusters already                        -> P0001 cluster_limit_reached
--   8. insert with source 'manual', appended after the last cluster
-- ---------------------------------------------------------------------------
create or replace function public.create_cluster(p_cycle_id uuid, p_name text)
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

  -- Serialize with transfer_facilitator, then check the role as it is now.
  perform 1 from public.projects p where p.id = cycle_project for share;

  if not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
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
--   3. lock the projects row FOR SHARE
--   4. not the facilitator now                    -> 42501 not_project_facilitator
--   5. lock the cycle row FOR UPDATE, then the cluster row FOR UPDATE
--   6. the cluster was deleted meanwhile          -> P0001 cluster_not_found
--   7. status is not cluster                      -> P0001 cycle_not_clustering
--   8. name rules -> invalid_cluster_name, then cluster_name_taken (the
--      cluster's own row does not count)
--   9. the same name (same case) is a no-op that returns the current row;
--      otherwise set the name and source 'manual'
-- ---------------------------------------------------------------------------
create or replace function public.rename_cluster(p_cluster_id uuid, p_name text)
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

  -- Serialize with transfer_facilitator, then check the role as it is now.
  perform 1 from public.projects p where p.id = cycle_project for share;

  if not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
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
--   3. lock the projects row FOR SHARE
--   4. not the facilitator now                    -> 42501 not_project_facilitator
--   5. lock the cycle row FOR UPDATE
--   6. the cluster was deleted meanwhile          -> P0001 cluster_not_found
--   7. status is not cluster                      -> P0001 cycle_not_clustering
--   8. delete the cluster; its cards become ungrouped
-- ---------------------------------------------------------------------------
create or replace function public.delete_cluster(p_cluster_id uuid)
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

  -- Serialize with transfer_facilitator, then check the role as it is now.
  perform 1 from public.projects p where p.id = cycle_project for share;

  if not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
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
-- move_card
--
-- Check order (each failing step changes nothing):
--   1. (select auth.uid()) is null                -> 42501 not_project_member
--   2. null or unknown card, or a card of a project the caller is not a
--      member of                                  -> P0001 card_not_found
--   3. lock the projects row FOR SHARE
--   4. not the facilitator now                    -> 42501 not_project_facilitator
--   5. lock the card's cycle row FOR UPDATE
--   6. the card is gone under the lock            -> P0001 card_not_found
--   7. status is not cluster                      -> P0001 cycle_not_clustering
--   8. negative position, or a position with a null target
--                                                 -> P0001 invalid_card_position
--   9. unknown target, deleted meanwhile, or of another cycle
--                                                 -> P0001 cluster_not_found
--  10. no-op: return without writing
--  11. write, renumber the touched clusters, set their source to manual
-- ---------------------------------------------------------------------------
create or replace function public.move_card(p_card_id uuid, p_cluster_id uuid, p_position integer)
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
  current_cluster uuid;
  current_list uuid[];
  current_index integer;
  others uuid[];
  target_index integer;
  new_list uuid[];
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- A card's cycle_id and a cycle's project_id never change. An unknown card
  -- and one the caller cannot see get the same error.
  select c.cycle_id, fc.project_id
    into card_cycle, cycle_project
    from public.cards c
    join public.feedback_cycles fc on fc.id = c.cycle_id
   where c.id = p_card_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = 'P0001', message = 'card_not_found';
  end if;

  -- Serialize with transfer_facilitator, then check the role as it is now.
  perform 1 from public.projects p where p.id = cycle_project for share;

  if not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
  end if;

  -- Serialize with every cluster write, advance_stage, and close_cycle.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = card_cycle
     for update;

  if not exists (select 1 from public.cards c where c.id = p_card_id) then
    raise exception using errcode = 'P0001', message = 'card_not_found';
  end if;

  if cycle_status is distinct from 'cluster' then
    raise exception using errcode = 'P0001', message = 'cycle_not_clustering';
  end if;

  if p_position < 0
     or (p_position is not null and p_cluster_id is null) then
    raise exception using errcode = 'P0001', message = 'invalid_card_position';
  end if;

  if p_cluster_id is not null
     and not exists (
       select 1
         from public.clusters cl
        where cl.id = p_cluster_id
          and cl.cycle_id = card_cycle
     ) then
    raise exception using errcode = 'P0001', message = 'cluster_not_found';
  end if;

  select cc.cluster_id
    into current_cluster
    from public.cluster_cards cc
   where cc.card_id = p_card_id;

  -- To Ungrouped.
  if p_cluster_id is null then
    if current_cluster is null then
      return;
    end if;

    delete from public.cluster_cards cc where cc.card_id = p_card_id;

    update public.cluster_cards cc
       set sort_order = r.rn - 1
      from (
        select x.card_id, pg_catalog.row_number() over (order by x.sort_order, x.card_id) as rn
          from public.cluster_cards x
         where x.cluster_id = current_cluster
      ) r
     where cc.card_id = r.card_id
       and cc.sort_order is distinct from r.rn - 1;

    update public.clusters cl
       set source = 'manual'
     where cl.id = current_cluster
       and cl.source is distinct from 'manual';

    return;
  end if;

  -- Into a cluster: the target's other cards in displayed order.
  select coalesce(pg_catalog.array_agg(cc.card_id order by cc.sort_order, cc.card_id), '{}'::uuid[])
    into others
    from public.cluster_cards cc
   where cc.cluster_id = p_cluster_id
     and cc.card_id <> p_card_id;

  target_index := least(coalesce(p_position, pg_catalog.cardinality(others)), pg_catalog.cardinality(others));

  if current_cluster = p_cluster_id then
    select coalesce(pg_catalog.array_agg(cc.card_id order by cc.sort_order, cc.card_id), '{}'::uuid[])
      into current_list
      from public.cluster_cards cc
     where cc.cluster_id = p_cluster_id;

    current_index := pg_catalog.array_position(current_list, p_card_id) - 1;
    if current_index = target_index then
      return;
    end if;
  end if;

  new_list := others[1:target_index] || p_card_id || others[target_index + 1:pg_catalog.cardinality(others)];

  if current_cluster is null then
    insert into public.cluster_cards (cycle_id, cluster_id, card_id, sort_order)
    values (card_cycle, p_cluster_id, p_card_id, target_index);
  elsif current_cluster <> p_cluster_id then
    update public.cluster_cards cc
       set cluster_id = p_cluster_id,
           sort_order = target_index
     where cc.card_id = p_card_id;
  end if;

  -- The target, in its new order.
  update public.cluster_cards cc
     set sort_order = n.ord - 1
    from pg_catalog.unnest(new_list) with ordinality as n(card_id, ord)
   where cc.card_id = n.card_id
     and cc.cluster_id = p_cluster_id
     and cc.sort_order is distinct from n.ord - 1;

  -- The cluster the card left, if another one.
  if current_cluster is not null and current_cluster <> p_cluster_id then
    update public.cluster_cards cc
       set sort_order = r.rn - 1
      from (
        select x.card_id, pg_catalog.row_number() over (order by x.sort_order, x.card_id) as rn
          from public.cluster_cards x
         where x.cluster_id = current_cluster
      ) r
     where cc.card_id = r.card_id
       and cc.sort_order is distinct from r.rn - 1;
  end if;

  update public.clusters cl
     set source = 'manual'
   where cl.id in (p_cluster_id, current_cluster)
     and cl.source is distinct from 'manual';
end;
$$;

revoke all on function public.move_card(uuid, uuid, integer) from public;
revoke all on function public.move_card(uuid, uuid, integer) from anon, authenticated, service_role;

grant execute on function public.move_card(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- merge_clusters
--
-- Check order (each failing step changes nothing):
--   1. (select auth.uid()) is null                -> 42501 not_project_member
--   2. null or unknown source, or a source of a project the caller is not a
--      member of                                  -> P0001 cluster_not_found
--   3. lock the projects row FOR SHARE
--   4. not the facilitator now                    -> 42501 not_project_facilitator
--   5. lock the source's cycle row FOR UPDATE
--   6. the source is gone under the lock          -> P0001 cluster_not_found
--   7. status is not cluster                      -> P0001 cycle_not_clustering
--   8. the target is the source                   -> P0001 cannot_merge_into_self
--   9. null, unknown, or deleted target, or a target of another cycle
--                                                 -> P0001 cluster_not_found
--  10. move the source's cards to the end of the target, renumber the
--      target, make it manual if any card moved, delete the source
-- ---------------------------------------------------------------------------
create or replace function public.merge_clusters(p_source_cluster_id uuid, p_target_cluster_id uuid)
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
  source_cycle uuid;
  cycle_project uuid;
  cycle_status text;
  moving integer;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- A cluster's cycle_id and a cycle's project_id never change. An unknown
  -- source and one the caller cannot see get the same error.
  select cl.cycle_id, fc.project_id
    into source_cycle, cycle_project
    from public.clusters cl
    join public.feedback_cycles fc on fc.id = cl.cycle_id
   where cl.id = p_source_cluster_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = 'P0001', message = 'cluster_not_found';
  end if;

  -- Serialize with transfer_facilitator, then check the role as it is now.
  perform 1 from public.projects p where p.id = cycle_project for share;

  if not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
  end if;

  -- Serialize with every cluster write, move, advance_stage, and close_cycle.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = source_cycle
     for update;

  if not exists (select 1 from public.clusters cl where cl.id = p_source_cluster_id) then
    raise exception using errcode = 'P0001', message = 'cluster_not_found';
  end if;

  if cycle_status is distinct from 'cluster' then
    raise exception using errcode = 'P0001', message = 'cycle_not_clustering';
  end if;

  if p_target_cluster_id = p_source_cluster_id then
    raise exception using errcode = 'P0001', message = 'cannot_merge_into_self';
  end if;

  -- Unknown, deleted meanwhile, and of another cycle look the same.
  if p_target_cluster_id is null
     or not exists (
       select 1
         from public.clusters cl
        where cl.id = p_target_cluster_id
          and cl.cycle_id = source_cycle
     ) then
    raise exception using errcode = 'P0001', message = 'cluster_not_found';
  end if;

  select count(*)::integer
    into moving
    from public.cluster_cards cc
   where cc.cluster_id = p_source_cluster_id;

  -- An empty source changes nothing in the target.
  if moving > 0 then
    -- The target's cards first, then the source's, each in its displayed
    -- order, numbered 0 .. n-1 in the target.
    update public.cluster_cards cc
       set cluster_id = p_target_cluster_id,
           sort_order = r.rn - 1
      from (
        select x.card_id,
               pg_catalog.row_number() over (
                 order by (x.cluster_id = p_source_cluster_id), x.sort_order, x.card_id
               ) as rn
          from public.cluster_cards x
         where x.cluster_id in (p_target_cluster_id, p_source_cluster_id)
      ) r
     where cc.card_id = r.card_id
       and (cc.cluster_id is distinct from p_target_cluster_id
            or cc.sort_order is distinct from r.rn - 1);

    update public.clusters cl
       set source = 'manual'
     where cl.id = p_target_cluster_id
       and cl.source is distinct from 'manual';
  end if;

  -- No cluster_cards row is left to cascade.
  delete from public.clusters cl where cl.id = p_source_cluster_id;

  return query
    select cl.id, cl.name, cl.source
    from public.clusters cl
    where cl.id = p_target_cluster_id;
end;
$$;

revoke all on function public.merge_clusters(uuid, uuid) from public;
revoke all on function public.merge_clusters(uuid, uuid) from anon, authenticated, service_role;

grant execute on function public.merge_clusters(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- split_cluster
--
-- Check order (each failing step changes nothing):
--   1. (select auth.uid()) is null                -> 42501 not_project_member
--   2. null or unknown cluster, or a cluster of a project the caller is not
--      a member of                                -> P0001 cluster_not_found
--   3. lock the projects row FOR SHARE
--   4. not the facilitator now                    -> 42501 not_project_facilitator
--   5. lock the cluster's cycle row FOR UPDATE
--   6. the cluster is gone under the lock         -> P0001 cluster_not_found
--   7. status is not cluster                      -> P0001 cycle_not_clustering
--   8. p_card_ids null, empty, or with a duplicate (or a null element)
--                                                 -> P0001 invalid_card_selection
--   9. any id not currently in this cluster       -> P0001 card_not_in_cluster
--  10. the selection is every card of the cluster -> P0001 split_takes_all_cards
--  11. name rules -> invalid_cluster_name, then cluster_name_taken, then
--      50 clusters already                        -> P0001 cluster_limit_reached
--  12. insert the new cluster, move the selected cards to it, renumber both,
--      make the original manual
-- ---------------------------------------------------------------------------
create or replace function public.split_cluster(p_cluster_id uuid, p_card_ids uuid[], p_name text)
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
  clean_name text;
  new_id uuid;
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

  -- Serialize with transfer_facilitator, then check the role as it is now.
  perform 1 from public.projects p where p.id = cycle_project for share;

  if not private.is_project_facilitator(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
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

  -- count(distinct) skips nulls, so a null element also fails here.
  if p_card_ids is null
     or pg_catalog.cardinality(p_card_ids) = 0
     or pg_catalog.cardinality(p_card_ids) <> (
       select count(distinct s.id) from pg_catalog.unnest(p_card_ids) s(id)
     ) then
    raise exception using errcode = 'P0001', message = 'invalid_card_selection';
  end if;

  -- Unknown, ungrouped, in another cluster, cycle, or project, and deleted
  -- meanwhile all look the same.
  if exists (
    select 1
      from pg_catalog.unnest(p_card_ids) s(id)
     where not exists (
       select 1
         from public.cluster_cards cc
        where cc.card_id = s.id
          and cc.cluster_id = p_cluster_id
     )
  ) then
    raise exception using errcode = 'P0001', message = 'card_not_in_cluster';
  end if;

  if (select count(*) from public.cluster_cards cc where cc.cluster_id = p_cluster_id)
     = pg_catalog.cardinality(p_card_ids) then
    raise exception using errcode = 'P0001', message = 'split_takes_all_cards';
  end if;

  clean_name := pg_catalog.btrim(p_name, E' \t\n\r');
  if clean_name is null
     or pg_catalog.char_length(clean_name) not between 1 and 100
     or clean_name ~ '[[:cntrl:]]' then
    raise exception using errcode = 'P0001', message = 'invalid_cluster_name';
  end if;

  -- Every cluster of the cycle counts, the one being split included.
  if exists (
    select 1
      from public.clusters cl
     where cl.cycle_id = cluster_cycle
       and pg_catalog.lower(cl.name) = pg_catalog.lower(clean_name)
  ) then
    raise exception using errcode = 'P0001', message = 'cluster_name_taken';
  end if;

  if (select count(*) from public.clusters cl where cl.cycle_id = cluster_cycle) >= 50 then
    raise exception using errcode = 'P0001', message = 'cluster_limit_reached';
  end if;

  begin
    insert into public.clusters (cycle_id, name, source, sort_order)
    values (
      cluster_cycle,
      clean_name,
      'manual',
      (select coalesce(max(cl.sort_order), 0) + 1 from public.clusters cl where cl.cycle_id = cluster_cycle)
    )
    returning public.clusters.id into new_id;
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = 'cluster_name_taken';
  end;

  -- The selected cards, in their order in the original cluster.
  update public.cluster_cards cc
     set cluster_id = new_id,
         sort_order = r.rn - 1
    from (
      select x.card_id,
             pg_catalog.row_number() over (order by x.sort_order, x.card_id) as rn
        from public.cluster_cards x
       where x.cluster_id = p_cluster_id
         and x.card_id = any (p_card_ids)
    ) r
   where cc.card_id = r.card_id;

  -- The cards left behind, in their current order.
  update public.cluster_cards cc
     set sort_order = r.rn - 1
    from (
      select x.card_id,
             pg_catalog.row_number() over (order by x.sort_order, x.card_id) as rn
        from public.cluster_cards x
       where x.cluster_id = p_cluster_id
    ) r
   where cc.card_id = r.card_id
     and cc.sort_order is distinct from r.rn - 1;

  update public.clusters cl
     set source = 'manual'
   where cl.id = p_cluster_id
     and cl.source is distinct from 'manual';

  return query
    select cl.id, cl.name, cl.source
    from public.clusters cl
    where cl.id = new_id;
end;
$$;

revoke all on function public.split_cluster(uuid, uuid[], text) from public;
revoke all on function public.split_cluster(uuid, uuid[], text) from anon, authenticated, service_role;

grant execute on function public.split_cluster(uuid, uuid[], text) to authenticated;
