-- Task 22: voting RPCs and hidden totals.
--
-- Vote contract. #23 (the voting UI) and #24 (closing voting and the ranked
-- agenda) build on these rules and must not weaken them.
--
-- Decisions:
--
--   1. What is voted on: clusters only. Every cluster of the cycle can
--      receive votes, whether source is 'manual' or 'ai', including one with
--      zero cards. Ungrouped cards, single cards, and an implicit "Ungrouped"
--      bucket cannot. Voting ignores source completely.
--   2. Budget. Each member has exactly 3 votes per cycle. Votes stack: all 3
--      may go on one cluster. One vote is one row. The facilitator and the
--      owner get the same 3 votes and nothing more; no vote function has a
--      role branch.
--   3. Who. Any current member of the cycle's project
--      (private.is_project_member). A member who joins during vote can vote
--      at once with 3 votes.
--   4. When. cast_vote and remove_vote work only while status = 'vote'.
--      Changing a vote is a remove followed by a cast. A member may retract
--      every vote. Nothing writes votes outside vote.
--   5. Totals gate. get_vote_totals answers only when voting_closed_at is not
--      null and status is 'discuss' or 'closed'. There is no "everyone has
--      used 3 votes" gate: it would show totals while the stage is still
--      vote, and a member could then move votes after seeing them. #24's
--      close_voting and auto-close set voting_closed_at. A cycle ended early
--      from vote with close_cycle keeps voting_closed_at null, so it never
--      shows totals.
--   6. Votes outlive their voter. voter_id references auth.users on delete
--      set null. Deleting an account forgets who voted but keeps the vote, so
--      closed totals never change after the fact. A vote with a null voter
--      counts in totals but belongs to nobody's my_votes or budget. A removed
--      member's votes (#49) stay and count.
--   7. No broadcast and no side effects. A vote write inserts into votes or
--      deletes from it, and does nothing else: it changes no row of
--      feedback_cycles, project_members, clusters, or cluster_cards (their
--      updated_at included) and inserts no cycle_events row. The voter's own
--      board refetch is the only signal.
--
-- Table. public.votes is default-deny, like cards, clusters, and ai_runs: RLS
-- is enabled with no policy, PUBLIC, anon, and authenticated hold no
-- privilege, and only service_role keeps select, insert, update, delete. It
-- is not in supabase_realtime and no view reads it. A client sees its own
-- votes only through get_cycle_board (my_votes, votes_remaining) and totals
-- only through get_vote_totals once the gate is open.
--
-- Lock. cast_vote and remove_vote lock the cycle row FOR UPDATE before the
-- status check and before any read or write of votes, as every cluster
-- write, advance_stage, and close_cycle do. They lock nothing else (no
-- projects lock, since there is no role check), so they cannot form a
-- lock-order cycle with transfer_facilitator or the cluster RPCs. The lock
-- serializes double clicks, parallel tabs, and parallel calls, so the cap of
-- 3 is never exceeded by count-then-insert, and serializes votes with stage
-- changes: a vote commits before the stage changes, or waits, re-reads the
-- status, and gets cycle_not_voting.
--
-- cast_vote(p_cycle_id, p_cluster_id) check order (each failing step changes
-- nothing):
--   1. (select auth.uid()) is null                -> 42501 not_project_member
--   2. null or unknown cycle, or not a member     -> 42501 not_project_member
--   3. lock the cycle row FOR UPDATE
--   4. status is not vote                         -> P0001 cycle_not_voting
--   5. null cluster id, or a cluster that is not in this cycle
--                                                 -> P0001 cluster_not_found
--   6. the caller already holds 3 votes           -> P0001 no_votes_remaining
--   7. insert one row; return the cluster id, the caller's votes on it (1-3),
--      and the caller's remaining votes (0-2).
--
-- remove_vote(p_cycle_id, p_cluster_id) has the same steps 1-5, then:
--   6. the caller has no vote on that cluster     -> P0001 no_vote_to_remove
--   7. delete exactly one of the caller's rows on that cluster; return the
--      new count (0-2) and the remaining votes (1-3).
--
-- get_vote_totals(p_cycle_id) check order:
--   1. null user, null or unknown cycle, or not a member
--                                                 -> 42501 not_project_member
--   2. the gate (decision 5) is not open          -> P0001 voting_not_closed
--      The same for every caller, the facilitator included, and no partial
--      rows are returned.
--   3. one row per cluster of the cycle, zeros included, ordered by
--      total_votes desc, then clusters.sort_order, then cluster_id. Votes
--      with a null voter count. No voter id, name, or per-voter value.
--
-- None of the three functions takes a user id; each returns only the
-- caller's own numbers or, after the gate, aggregates.
--
-- get_cycle_board gains exactly two keys, my_votes and votes_remaining, both
-- read only from rows with voter_id = (select auth.uid()). Every rule of #15
-- and #17 still holds.
--
-- Residual risks (accepted, tech-stack §4.3): a vote write can wait
-- milliseconds on the cycle lock while another member's write holds it,
-- which reveals at most that someone wrote at the same moment; after close,
-- in a 2-member team either member can subtract their own votes from the
-- totals to work out the other's.

-- ---------------------------------------------------------------------------
-- votes
-- ---------------------------------------------------------------------------
create table public.votes (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null,
  cluster_id uuid not null,
  -- Never null when written: only the RPCs write it. Null after the voter's
  -- auth user is deleted; the vote still counts in totals.
  voter_id uuid,
  -- Kept for operators only; never returned to clients.
  created_at timestamptz not null default now(),
  constraint votes_cycle_id_fkey foreign key (cycle_id)
    references public.feedback_cycles (id) on delete cascade,
  -- A vote can only point at a cluster of its own cycle.
  constraint votes_cluster_fkey foreign key (cluster_id, cycle_id)
    references public.clusters (id, cycle_id) on delete cascade,
  constraint votes_voter_id_fkey foreign key (voter_id)
    references auth.users (id) on delete set null
);

create index votes_cycle_id_voter_id_idx on public.votes (cycle_id, voter_id);
create index votes_cluster_id_idx on public.votes (cluster_id);

-- RLS and grants. Default-deny with no policies. Supabase's default
-- privileges would give anon and authenticated every privilege on a new
-- public table; revoke them explicitly.
alter table public.votes enable row level security;

revoke all on table public.votes from public;
revoke all on table public.votes from anon, authenticated, service_role;

grant select, insert, update, delete on table public.votes to service_role;

-- ---------------------------------------------------------------------------
-- cast_vote
-- ---------------------------------------------------------------------------
create function public.cast_vote(p_cycle_id uuid, p_cluster_id uuid)
returns table (
  cluster_id uuid,
  vote_count integer,
  votes_remaining integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid;
  cycle_project uuid;
  cycle_status text;
begin
  caller := (select auth.uid());

  if caller is null then
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

  -- Serialize with every other vote write of the cycle, advance_stage, and
  -- close_cycle. This is the only lock.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = p_cycle_id
     for update;

  if cycle_status is distinct from 'vote' then
    raise exception using errcode = 'P0001', message = 'cycle_not_voting';
  end if;

  if not exists (
    select 1
      from public.clusters cl
     where cl.id = p_cluster_id
       and cl.cycle_id = p_cycle_id
  ) then
    raise exception using errcode = 'P0001', message = 'cluster_not_found';
  end if;

  if (select count(*) from public.votes v where v.cycle_id = p_cycle_id and v.voter_id = caller) >= 3 then
    raise exception using errcode = 'P0001', message = 'no_votes_remaining';
  end if;

  insert into public.votes (cycle_id, cluster_id, voter_id)
  values (p_cycle_id, p_cluster_id, caller);

  return query
    select
      p_cluster_id,
      (select count(*)::integer
         from public.votes v
        where v.cluster_id = p_cluster_id
          and v.voter_id = caller),
      (select 3 - count(*)::integer
         from public.votes v
        where v.cycle_id = p_cycle_id
          and v.voter_id = caller);
end;
$$;

revoke all on function public.cast_vote(uuid, uuid) from public;
revoke all on function public.cast_vote(uuid, uuid) from anon, authenticated, service_role;

grant execute on function public.cast_vote(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- remove_vote
-- ---------------------------------------------------------------------------
create function public.remove_vote(p_cycle_id uuid, p_cluster_id uuid)
returns table (
  cluster_id uuid,
  vote_count integer,
  votes_remaining integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid;
  cycle_project uuid;
  cycle_status text;
  removed_id uuid;
begin
  caller := (select auth.uid());

  if caller is null then
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

  -- The same single lock as cast_vote.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = p_cycle_id
     for update;

  if cycle_status is distinct from 'vote' then
    raise exception using errcode = 'P0001', message = 'cycle_not_voting';
  end if;

  if not exists (
    select 1
      from public.clusters cl
     where cl.id = p_cluster_id
       and cl.cycle_id = p_cycle_id
  ) then
    raise exception using errcode = 'P0001', message = 'cluster_not_found';
  end if;

  -- The caller's rows on one cluster are interchangeable; remove any one.
  select v.id
    into removed_id
    from public.votes v
   where v.cycle_id = p_cycle_id
     and v.cluster_id = p_cluster_id
     and v.voter_id = caller
   limit 1;

  if removed_id is null then
    raise exception using errcode = 'P0001', message = 'no_vote_to_remove';
  end if;

  delete from public.votes v where v.id = removed_id;

  return query
    select
      p_cluster_id,
      (select count(*)::integer
         from public.votes v
        where v.cluster_id = p_cluster_id
          and v.voter_id = caller),
      (select 3 - count(*)::integer
         from public.votes v
        where v.cycle_id = p_cycle_id
          and v.voter_id = caller);
end;
$$;

revoke all on function public.remove_vote(uuid, uuid) from public;
revoke all on function public.remove_vote(uuid, uuid) from anon, authenticated, service_role;

grant execute on function public.remove_vote(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_vote_totals
-- ---------------------------------------------------------------------------
create function public.get_vote_totals(p_cycle_id uuid)
returns table (
  cluster_id uuid,
  total_votes integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cycle_project uuid;
  cycle_status text;
  cycle_voting_closed_at timestamptz;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  select fc.project_id, fc.status, fc.voting_closed_at
    into cycle_project, cycle_status, cycle_voting_closed_at
    from public.feedback_cycles fc
   where fc.id = p_cycle_id;

  if cycle_project is null
     or not private.is_project_member(cycle_project) then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- The gate. The same answer for every caller, whatever votes exist.
  if cycle_voting_closed_at is null
     or cycle_status not in ('discuss', 'closed') then
    raise exception using errcode = 'P0001', message = 'voting_not_closed';
  end if;

  return query
    select cl.id, count(v.id)::integer
      from public.clusters cl
      left join public.votes v on v.cluster_id = cl.id
     where cl.cycle_id = p_cycle_id
     group by cl.id, cl.sort_order
     order by count(v.id) desc, cl.sort_order, cl.id;
end;
$$;

revoke all on function public.get_vote_totals(uuid) from public;
revoke all on function public.get_vote_totals(uuid) from anon, authenticated, service_role;

grant execute on function public.get_vote_totals(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_cycle_board gains my_votes and votes_remaining. Every rule of #15's
-- board contract (20261101160000_create_get_cycle_board.sql) and #17's
-- clusters key (20261101200000_create_clusters.sql) still holds; the
-- response now has exactly seven keys:
--
--   cycle_id, status, is_revealed, cards, clusters   unchanged
--   my_votes         a JSON array, never null, [] when the caller has no
--                    votes (always before vote). One element per cluster
--                    where the caller holds at least one vote, each with
--                    exactly cluster_id and vote_count (1-3), ordered by
--                    clusters.sort_order. Still shown in discuss and closed.
--   votes_remaining  3 minus the caller's votes in the cycle (0-3), in every
--                    status.
--
-- Both keys are read only from votes rows with voter_id = (select
-- auth.uid()); the function never aggregates other members' votes. Clusters
-- keep exactly their four keys, the same for every caller, and no card gains
-- a key. Neither card nor cluster order depends on votes. Two callers'
-- responses differ only in is_mine, my_votes, and votes_remaining. Vote
-- totals never appear here.
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
  board_my_votes jsonb;
  my_vote_total integer;
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

  -- The caller's own votes only, per cluster by sort_order.
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'cluster_id', mine.cluster_id,
               'vote_count', mine.vote_count
             )
             order by mine.sort_order
           ),
           '[]'::jsonb
         ),
         coalesce(sum(mine.vote_count), 0)::integer
    into board_my_votes, my_vote_total
    from (
      select v.cluster_id, cl.sort_order, count(*)::integer as vote_count
        from public.votes v
        join public.clusters cl on cl.id = v.cluster_id
       where v.cycle_id = p_cycle_id
         and v.voter_id = (select auth.uid())
       group by v.cluster_id, cl.sort_order
    ) mine;

  return pg_catalog.jsonb_build_object(
    'cycle_id', p_cycle_id,
    'status', cycle_status,
    'is_revealed', cycle_revealed,
    'cards', board_cards,
    'clusters', board_clusters,
    'my_votes', board_my_votes,
    'votes_remaining', 3 - my_vote_total
  );
end;
$$;

revoke all on function public.get_cycle_board(uuid) from public;
revoke all on function public.get_cycle_board(uuid) from anon, authenticated, service_role;

grant execute on function public.get_cycle_board(uuid) to authenticated;
