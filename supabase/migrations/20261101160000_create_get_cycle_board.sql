-- Task 15: the stage-aware board data RPC (folds in #69).
--
-- Board contract. Later tasks (#16, #17, #18, #22, #24, #34, #36) build on
-- these rules and must not weaken them:
--
--   * public.get_cycle_board(p_cycle_id) returns one jsonb object with
--     exactly four keys in this task:
--
--       cycle_id     the cycle
--       status       feedback_cycles.status
--       is_revealed  feedback_cycles.revealed_at is not null
--       cards        a JSON array, [] when there are none, never null
--
--   * Reveal rule. "Revealed" means feedback_cycles.revealed_at is not null,
--     the same rule as #13's get_cycle_status and #14's start_retrospective.
--     The status is never used for this decision: a cycle closed early from
--     collecting was never revealed. Until reveal, cards holds only the
--     caller's own cards (the same ids as get_my_cards, as many as
--     my_card_count). After reveal it holds every card of the cycle (as many
--     as get_cycle_status.card_count), the same set for every caller.
--   * An attributed card (is_anonymous = false) has exactly six keys:
--     card_id, category, text, is_anonymous, is_mine, author_display_name.
--     author_display_name is the author's current profiles.display_name, or
--     JSON null when the author's auth user was deleted (its card_authors
--     row went with the user).
--   * An anonymous card (is_anonymous = true) has exactly four keys: card_id,
--     category, text, is_anonymous. It has no is_mine, no
--     author_display_name, and no author key of any kind. Its object is built
--     from columns of cards only, so it is the same for its author, the
--     facilitator, the owner, and every other member.
--   * is_mine appears only on attributed cards: true on the caller's own,
--     false on every other. Anonymous cards are never marked, not even for
--     their author, so a shared screen cannot out the author. Ownership is
--     resolved from card_authors against (select auth.uid()) inside the
--     function; no user id is accepted from the client.
--   * No timestamps (#69). No card ever carries created_at, updated_at, or
--     any other time, and the response carries no revealed_at. Card times
--     and creation order are visible only to the author, through get_my_cards.
--   * Order. cards is ordered by category (start, stop, continue), then by
--     card_id. Card ids are random v4 UUIDs, so the order is stable between
--     calls, the same for every caller, and unrelated to when a card was
--     written or by whom. Clients do not re-sort.
--   * Same answer for everyone. After reveal any two callers get identical
--     responses apart from is_mine on attributed cards. The facilitator and
--     the owner get nothing extra; the function has no role branch.
--   * Data scope. The function reads only feedback_cycles, cards,
--     card_authors, profiles, and (through private.is_project_member)
--     project_members. It has no placeholder keys for data later tasks add.
--   * One error. A null auth.uid(), a null or unknown cycle id, a non-member,
--     a removed member, and a member of another project all get 42501
--     not_project_member with no detail or hint, whatever the cycle status.
--
-- The single exception to #11's anonymity contract. #11 says "no RPC returns
-- author_id, a user id, an email, or a display name". get_cycle_board returns
-- the author's display name on attributed cards only, which the author chose
-- to make public by not ticking "Submit anonymously". It still returns no
-- author_id, user id, or email, and nothing author-derived for anonymous
-- cards.
--
-- Rules for later extensions. #17, #18, #22, and #24 replace this function
-- with create or replace in their own migrations and add keys. They keep
-- every rule above; only the exact-key-set assertions name the new keys. A
-- new key:
--
--   * has the same value for every caller, unless it describes only the
--     caller's own data (as is_mine, and #22's own votes and remaining votes);
--   * on an anonymous card is never derived from card_authors, profiles, or a
--     timestamp (a cluster id is fine);
--   * never orders cards by created_at, updated_at, or author. Inside a
--     cluster the order is the cluster's sort order, then card_id.
--
-- Vote totals never appear on the board while voting is open. They come only
-- from get_vote_totals (#22, #24); if #24 ever adds totals here, they stay
-- absent until the same gate opens.
--
-- Residual risk, accepted and tracked in #75: attributed cards show how many
-- cards each named author wrote, which with #13's counts can still point at
-- the author of the only anonymous card in a small team. This function adds
-- no per-member count, no per-member time, and no ordering that makes it
-- worse.
--
-- This migration adds no table, column, view, policy, grant, or Realtime
-- publication entry on cards, card_authors, profiles, or project_members.

create function public.get_cycle_board(p_cycle_id uuid)
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

  return pg_catalog.jsonb_build_object(
    'cycle_id', p_cycle_id,
    'status', cycle_status,
    'is_revealed', cycle_revealed,
    'cards', board_cards
  );
end;
$$;

revoke all on function public.get_cycle_board(uuid) from public;
revoke all on function public.get_cycle_board(uuid) from anon, authenticated, service_role;

grant execute on function public.get_cycle_board(uuid) to authenticated;
