-- Task 19: merge one cluster into another, and split selected cards of a
-- cluster out into a new named cluster.
--
-- Merge and split contract. Later tasks (#20, #21, #22, #24, #89, #92, #95)
-- build on these rules and must not weaken them:
--
--   * Who. Any current member of the cycle's project may merge and split any
--     cluster, manual or AI, holding anyone's cards, attributed or anonymous.
--     The facilitator and the owner get nothing extra: neither RPC has a role
--     branch.
--   * When. Only while feedback_cycles.status is 'cluster'. In reveal there
--     is nothing to merge yet; from vote on, clusters are frozen because
--     votes point at them (#22).
--   * Merge. merge_clusters(source, target) moves every card of the source to
--     the end of the target and deletes the source. The target keeps its id,
--     its name, and its place (clusters.sort_order); the source's sort_order
--     leaves a gap, as #17's delete does. Card order after the merge: the
--     target's cards in (sort_order, card_id) order, then the source's cards
--     in (sort_order, card_id) order, numbered 0 .. n-1. One merge joins
--     exactly two clusters. It returns the target after the merge.
--   * Split. split_cluster(cluster, card_ids, name) creates one new cluster
--     with source 'manual', appended at coalesce(max(sort_order), 0) + 1 for
--     the cycle (#17's rule), and moves the selected cards to it in their
--     current order in the original cluster (sort_order, then card_id), never
--     in the order of p_card_ids, numbered 0 .. k-1. The cards left behind
--     are renumbered 0 .. n-k-1 in their current order. At least one card
--     must be selected and at least one must stay. The name follows #17's
--     rules exactly (trim set, invalid_cluster_name, cluster_name_taken
--     against every cluster of the cycle, cluster_limit_reached at 50). It
--     returns the new cluster.
--   * Source. Every cluster whose cards change becomes 'manual': a merge
--     target that received at least one card, the new cluster of a split,
--     and the cluster a split took cards from. A merge of an empty source
--     deletes the source and leaves the target row and its cards entirely
--     unchanged (source, updated_at, sort_order values). An AI rerun (#20,
--     #21) must keep manual clusters.
--   * Order. Nothing is ever ordered by a timestamp or anything
--     author-derived, and no client-sent order is trusted. Ungrouped cards
--     and clusters other than the two named are never touched.
--   * Locking. Each RPC locks the cycle row FOR UPDATE before any read that
--     decides the write and re-reads its cluster under the lock, so it is
--     serialized with #17's cluster RPCs, #18's move_card, other merges and
--     splits, advance_stage, close_cycle, and #20's AI writes. Each runs on
--     the state at the moment it gets the lock; there is no version check.
--   * Never a no-op. A successful merge always deletes a cluster; a
--     successful split always creates one.
--   * Events. Neither RPC inserts into cycle_events. #17's statement-level
--     triggers on clusters and cluster_cards record clusters_changed rows
--     with actor_id null and payload '{}'. Neither reads card_authors or
--     profiles, takes a user id, or stores an actor. No error carries an id,
--     a name, a count, or a status.
--
-- This migration adds only merge_clusters and split_cluster: no table,
-- column, constraint, policy, grant on a table, view, or Realtime publication
-- entry. get_cycle_board is unchanged.

-- ---------------------------------------------------------------------------
-- merge_clusters
--
-- Check order (each failing step changes nothing):
--   1. (select auth.uid()) is null                -> 42501 not_project_member
--   2. null or unknown source, or a source of a project the caller is not a
--      member of                                  -> P0001 cluster_not_found
--   3. lock the source's cycle row FOR UPDATE
--   4. the source is gone under the lock          -> P0001 cluster_not_found
--   5. status is not cluster                      -> P0001 cycle_not_clustering
--   6. the target is the source                   -> P0001 cannot_merge_into_self
--   7. null, unknown, or deleted target, or a target of another cycle
--                                                 -> P0001 cluster_not_found
--   8. move the source's cards to the end of the target, renumber the
--      target, make it manual if any card moved, delete the source
-- ---------------------------------------------------------------------------
create function public.merge_clusters(p_source_cluster_id uuid, p_target_cluster_id uuid)
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
--   3. lock the cluster's cycle row FOR UPDATE
--   4. the cluster is gone under the lock         -> P0001 cluster_not_found
--   5. status is not cluster                      -> P0001 cycle_not_clustering
--   6. p_card_ids null, empty, or with a duplicate (or a null element)
--                                                 -> P0001 invalid_card_selection
--   7. any id not currently in this cluster       -> P0001 card_not_in_cluster
--   8. the selection is every card of the cluster -> P0001 split_takes_all_cards
--   9. name rules -> invalid_cluster_name, then cluster_name_taken, then
--      50 clusters already                        -> P0001 cluster_limit_reached
--  10. insert the new cluster, move the selected cards to it, renumber both,
--      make the original manual
-- ---------------------------------------------------------------------------
create function public.split_cluster(p_cluster_id uuid, p_card_ids uuid[], p_name text)
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
