-- Task 13: pre-reveal visibility and submission status.
--
-- Visibility contract. Later tasks (#14, #15, #22, #24, #34, #36, #37, #69)
-- build on these rules and must not weaken them:
--
--   * public.get_cycle_status(p_cycle_id) returns exactly one row with
--     exactly seven columns, aggregate counts only:
--
--       cycle_id               uuid     the cycle
--       status                 text     feedback_cycles.status
--       is_revealed            boolean  feedback_cycles.revealed_at is not null
--       member_count           integer  current project_members rows of the
--                                       cycle's project
--       submitted_member_count integer  current members with at least one
--                                       card in this cycle (distinct
--                                       card_authors.author_id joined to
--                                       current project_members)
--       my_card_count          integer  the caller's own cards in this cycle
--       card_count             integer  every card in the cycle once
--                                       revealed; null before reveal
--
--   * "Revealed" means revealed_at is not null, which #14 sets when it moves
--     the cycle from collecting to reveal. It does not mean "status is not
--     collecting": a cycle closed early from collecting was never revealed,
--     so its card_count stays null. #15's get_cycle_board must use the same
--     rule, and after reveal the number of cards it returns equals card_count.
--   * Same answer for everyone. The facilitator and the owner get exactly the
--     row any member gets; only my_card_count differs between callers.
--   * Never returned, to anyone, at any stage: a user id, email, or display
--     name; a per-member "submitted" flag or list; a per-member card count for
--     anyone but the caller; a card id or card text; anonymous or attributed
--     counts, or anything else derived from is_anonymous; per-category counts;
--     and any timestamp (no first or last submission time, no revealed_at).
--   * No card total before reveal: a total that changes with every card would
--     tell a watcher how many cards a teammate just wrote, and after reveal
--     the rest of that teammate's count would be anonymous cards.
--     submitted_member_count changes only on a member's first card or the
--     deletion of their last, so it reveals at most whether someone has
--     submitted.
--   * Not live. Card writes create no cycle_events row and nothing is
--     broadcast; the client re-reads on mount, focus, reconnect, and Retry.
--   * Counts never branch on is_anonymous or category, and the function never
--     reads profiles. A removed member's cards and a deleted user's authorless
--     cards still count in card_count; neither counts as a member or as
--     submitted.
--   * Residual risk, accepted for the MVP and tracked in #75: after reveal, a
--     fully submitted team where one member has no attributed card shows that
--     member wrote only anonymous cards, and watching the count go up when
--     someone says "done" shows that they submitted.
--
-- Unauthenticated callers, a null or unknown cycle id, non-members, removed
-- members, and members of another project all get 42501 not_project_member,
-- whatever the cycle's status. This migration adds no table, column, policy,
-- grant, or Realtime publication entry on cards, card_authors,
-- project_members, or profiles.

create function public.get_cycle_status(p_cycle_id uuid)
returns table (
  cycle_id uuid,
  status text,
  is_revealed boolean,
  member_count integer,
  submitted_member_count integer,
  my_card_count integer,
  card_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cycle_project uuid;
  cycle_status text;
  cycle_revealed boolean;
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

  return query
    select
      p_cycle_id,
      cycle_status,
      cycle_revealed,
      (
        select pg_catalog.count(*)::integer
        from public.project_members pm
        where pm.project_id = cycle_project
      ),
      (
        select pg_catalog.count(distinct ca.author_id)::integer
        from public.cards c
        join public.card_authors ca on ca.card_id = c.id
        join public.project_members pm
          on pm.project_id = cycle_project
         and pm.user_id = ca.author_id
        where c.cycle_id = p_cycle_id
      ),
      (
        select pg_catalog.count(*)::integer
        from public.cards c
        join public.card_authors ca on ca.card_id = c.id
        where c.cycle_id = p_cycle_id
          and ca.author_id = (select auth.uid())
      ),
      case
        when cycle_revealed then (
          select pg_catalog.count(*)::integer
          from public.cards c
          where c.cycle_id = p_cycle_id
        )
      end;
end;
$$;

revoke all on function public.get_cycle_status(uuid) from public;
revoke all on function public.get_cycle_status(uuid) from anon, authenticated, service_role;

grant execute on function public.get_cycle_status(uuid) to authenticated;
