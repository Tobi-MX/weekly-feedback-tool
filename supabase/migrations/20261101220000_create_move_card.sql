-- Task 18: move a card into a cluster, between clusters, back to Ungrouped,
-- or up and down inside its cluster.
--
-- Move contract. Later tasks (#19, #20, #21, #22, #89, #92) build on these
-- rules and must not weaken them:
--
--   * Who. Any current member of the card's project may move any card,
--     attributed or anonymous, their own or not. The facilitator and the
--     owner get nothing extra: move_card has no role branch.
--   * When. Only while feedback_cycles.status is 'cluster'.
--   * Position. p_cluster_id null means Ungrouped, and then p_position must
--     be null. Otherwise p_position is the zero-based index the card gets in
--     the target cluster after the move, counted among the target's cards
--     other than the moved card. Null means "at the end"; a larger value is
--     clamped to the end, so a position computed from a slightly stale board
--     still succeeds; a negative value is invalid_card_position.
--     Ungrouped has no stored order: a card moved there takes its place in
--     get_cycle_board's response order (category, then card_id).
--   * Renumbering. Every cluster the card left or entered is renumbered to
--     sort_order 0 .. n-1, keeping the other cards in their displayed order
--     (sort_order, then card_id). Nothing is ever ordered by a timestamp or
--     by anything author-derived, and a client-sent sort_order is never
--     trusted. Clusters the move did not touch are not changed.
--   * Source. Every cluster the card left or entered becomes 'manual',
--     including a reorder inside one cluster: a person arranged it, so an AI
--     rerun (#20, #21) must not replace it.
--   * No-op. A card already ungrouped moved to Ungrouped, or a card already
--     at the clamped index of its target, writes nothing, changes no source,
--     and records no event.
--   * Locking. The card's cycle row is locked FOR UPDATE, so a move is
--     serialized with every cluster write of the cycle (#17, #19, #20),
--     advance_stage, close_cycle, and every other move. The last committed
--     move wins; there is no version check.
--   * Events. move_card inserts nothing into cycle_events. #17's
--     statement-level triggers on clusters and cluster_cards record
--     clusters_changed rows with actor_id null and payload '{}'. Nothing
--     about the mover is stored, returned, or broadcast, and no error
--     carries an id, a name, a position, or a status.
--
-- This migration adds only move_card: no table, column, constraint, policy,
-- grant on a table, view, or Realtime publication entry. get_cycle_board is
-- unchanged.

-- ---------------------------------------------------------------------------
-- move_card
--
-- Check order (each failing step changes nothing):
--   1. (select auth.uid()) is null                -> 42501 not_project_member
--   2. null or unknown card, or a card of a project the caller is not a
--      member of                                  -> P0001 card_not_found
--   3. lock the card's cycle row FOR UPDATE
--   4. the card is gone under the lock            -> P0001 card_not_found
--   5. status is not cluster                      -> P0001 cycle_not_clustering
--   6. negative position, or a position with a null target
--                                                 -> P0001 invalid_card_position
--   7. unknown target, deleted meanwhile, or of another cycle
--                                                 -> P0001 cluster_not_found
--   8. no-op: return without writing
--   9. write, renumber the touched clusters, set their source to manual
-- ---------------------------------------------------------------------------
create function public.move_card(p_card_id uuid, p_cluster_id uuid, p_position integer)
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
