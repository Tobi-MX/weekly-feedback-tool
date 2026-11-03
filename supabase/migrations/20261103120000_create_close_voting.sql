-- Task 24: close voting and the ranked agenda.
--
-- Voting closes in one of two ways: automatically, in the same transaction as
-- the vote that gives every current project member all 3 votes, or earlier
-- by the facilitator with close_voting. Either way the cycle moves
-- vote -> discuss, voting_closed_at is set once, exactly one stage_changed
-- event is recorded, and #22's get_vote_totals gate opens.
--
-- Decisions:
--
--   1. One close, one event: stage_changed only. No voting_closed event type
--      is added and cycle_events_type_check does not change. #14's trigger
--      records the vote -> discuss row in the same transaction as the update.
--      Both close paths record exactly one row: type stage_changed,
--      from_status vote, to_status discuss, payload {}. Neither path inserts
--      into cycle_events itself.
--   2. The vote -> discuss event has actor_id null, whichever path closed
--      voting. The automatic close runs inside the final voter's cast_vote,
--      so #14's trigger would otherwise broadcast who cast the last vote
--      (per-member vote timing, #22 decision 7). private.record_cycle_stage_
--      change() is replaced so that it records null for vote -> discuss and
--      (select auth.uid()) for every other transition, exactly as before. A
--      manual and an automatic close produce identical events.
--   3. Automatic close is an explicit step at the end of cast_vote. cast_vote
--      is replaced with every #22 rule, check, error, and return value
--      unchanged; its last step calls private.close_voting_if_complete under
--      the cycle row lock cast_vote already holds. The helper closes voting
--      exactly when every project_members row of the cycle's project has
--      exactly 3 rows in votes for this cycle with voter_id = that member.
--      Votes with a null voter, and votes of a user who is no longer a
--      member, count for nobody. It takes no lock of its own, raises
--      nothing, and returns whether it closed. remove_vote never closes and
--      nothing else calls the helper. A cycle with zero clusters, or with a
--      member who never votes, never closes automatically.
--   4. close_voting is facilitator-only and idempotent, with #16's lock
--      order. On a cycle already in discuss it is a successful no-op that
--      returns the current row (a second click, a second tab, or a call that
--      lost the race to an automatic close). Any other status gets
--      stage_out_of_date.
--   5. voting_closed_at invariants, in the style of #14's revealed_at:
--      - CHECK feedback_cycles_voting_closed_status_check: null in
--        collecting, reveal, cluster, and vote; not null in discuss; closed
--        may have it or not (a cycle closed from vote or earlier keeps it
--        null for good).
--      - Guard trigger feedback_cycles_guard_voting_closed: voting_closed_at
--        changes only from null to a value, together with vote -> discuss.
--        It is never cleared or moved; any such change raises P0001
--        cycle_immutable_column. A value set while the row stays in (or
--        moves to) collecting, reveal, cluster, or vote is left to the CHECK
--        (23514), as #14's reveal guard leaves invalid transitions to #10's
--        guard. The trigger name sorts after #10's
--        feedback_cycles_guard_update (BEFORE triggers fire in name order),
--        so an invalid status transition is still reported as
--        invalid_status_transition.
--   6. The results are aggregates only and identical for every caller: the
--      agenda never shows the caller's own votes. get_cycle_board's my_votes
--      stays in the response in discuss, but the agenda does not render it.
--   7. Ranking is the server's order: get_vote_totals' total desc, then
--      clusters.sort_order, then id. The client never re-sorts; ties follow
--      the cluster-board order, which is frozen from vote on.
--
-- close_voting(p_cycle_id) check order (each failing step changes nothing):
--   1. (select auth.uid()) is null                -> 42501 not_project_member
--   2. read the cycle's project_id; a null id, an unknown cycle, or a caller
--      who is not a member                        -> 42501 not_project_member
--   3. lock the projects row FOR SHARE (serializes with
--      transfer_facilitator); the caller is not the current facilitator
--      (owning the project gives no right)        -> 42501 not_project_facilitator
--   4. lock the cycle row FOR UPDATE, then read its status:
--        vote    -> set discuss and voting_closed_at = now(), return the row
--        discuss -> no-op, return the current row (same voting_closed_at)
--        other   -> P0001 stage_out_of_date
--
-- Locks. close_voting: projects FOR SHARE, then the cycle FOR UPDATE, as
-- advance_stage. cast_vote: the cycle FOR UPDATE only; the helper runs under
-- it and takes nothing more, so a final cast and close_voting serialize on
-- the cycle row and cannot form a lock-order cycle. A cast that waits for a
-- close re-reads the status and gets cycle_not_voting.
--
-- Data scope. close_voting reads and writes only feedback_cycles (and,
-- through the private helpers, projects and project_members). The helper
-- reads project_members and votes for counts only and returns a boolean.
-- Neither reads cards, card_authors, or profiles, and neither writes
-- cycle_events. get_cycle_board, get_vote_totals, remove_vote,
-- advance_stage, close_cycle, and cycle_events' columns and CHECKs are
-- unchanged.

-- ---------------------------------------------------------------------------
-- voting_closed_at invariants (decision 5)
-- ---------------------------------------------------------------------------
alter table public.feedback_cycles
  add constraint feedback_cycles_voting_closed_status_check check (
    (status in ('collecting', 'reveal', 'cluster', 'vote') and voting_closed_at is null)
    or (status = 'discuss' and voting_closed_at is not null)
    or status = 'closed'
  );

create function private.guard_feedback_cycle_voting_closed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.voting_closed_at is not distinct from old.voting_closed_at then
    return new;
  end if;

  -- Set once, together with vote -> discuss.
  if old.voting_closed_at is null
     and old.status = 'vote'
     and new.status = 'discuss' then
    return new;
  end if;

  -- A value in a stage before discuss breaks the CHECK; leave it to that.
  if old.voting_closed_at is null
     and new.status in ('collecting', 'reveal', 'cluster', 'vote') then
    return new;
  end if;

  raise exception using errcode = 'P0001', message = 'cycle_immutable_column';
end;
$$;

revoke all on function private.guard_feedback_cycle_voting_closed() from public;
revoke all on function private.guard_feedback_cycle_voting_closed() from anon, authenticated, service_role;

create trigger feedback_cycles_guard_voting_closed
  before update on public.feedback_cycles
  for each row
  execute function private.guard_feedback_cycle_voting_closed();

-- ---------------------------------------------------------------------------
-- Stage-change events: vote -> discuss has no actor (decision 2).
-- ---------------------------------------------------------------------------
create or replace function private.record_cycle_stage_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.cycle_events (cycle_id, type, from_status, to_status, actor_id, payload)
  values (new.id, 'stage_changed', old.status, new.status, case when old.status = 'vote' and new.status = 'discuss' then null else (select auth.uid()) end, '{}'::jsonb);

  return null;
end;
$$;

revoke all on function private.record_cycle_stage_change() from public;
revoke all on function private.record_cycle_stage_change() from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.close_voting_if_complete (decision 3)
-- ---------------------------------------------------------------------------
create function private.close_voting_if_complete(p_cycle_id uuid)
returns boolean
language plpgsql
volatile
set search_path = ''
as $$
declare
  cycle_project uuid;
  cycle_status text;
begin
  -- The caller (cast_vote) already holds the cycle row lock.
  select fc.project_id, fc.status
    into cycle_project, cycle_status
    from public.feedback_cycles fc
   where fc.id = p_cycle_id;

  if cycle_status is distinct from 'vote' then
    return false;
  end if;

  -- Every current member holds exactly 3 votes in this cycle. Votes with a
  -- null voter or of a former member belong to no current member.
  if not exists (
       select 1
         from public.project_members pm
        where pm.project_id = cycle_project
     )
     or exists (
       select 1
         from public.project_members pm
        where pm.project_id = cycle_project
          and (select count(*)
                 from public.votes v
                where v.cycle_id = p_cycle_id
                  and v.voter_id = pm.user_id) <> 3
     ) then
    return false;
  end if;

  update public.feedback_cycles fc
     set status = 'discuss',
         voting_closed_at = pg_catalog.now()
   where fc.id = p_cycle_id;

  return true;
end;
$$;

revoke all on function private.close_voting_if_complete(uuid) from public;
revoke all on function private.close_voting_if_complete(uuid) from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- cast_vote: #22's function with one final step, the automatic close.
-- ---------------------------------------------------------------------------
create or replace function public.cast_vote(p_cycle_id uuid, p_cluster_id uuid)
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

  -- #24: close voting when this vote completes every member's 3, under the
  -- cycle lock taken above.
  perform private.close_voting_if_complete(p_cycle_id);
end;
$$;

revoke all on function public.cast_vote(uuid, uuid) from public;
revoke all on function public.cast_vote(uuid, uuid) from anon, authenticated, service_role;

grant execute on function public.cast_vote(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- close_voting (decision 4)
-- ---------------------------------------------------------------------------
create function public.close_voting(p_cycle_id uuid)
returns table (
  id uuid,
  status text,
  voting_closed_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cycle_project uuid;
  cycle_status text;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- project_id never changes, so it can be read before the locks. A null or
  -- unknown cycle id and a non-member look the same.
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

  -- Serialize with cast_vote (and its automatic close), close_cycle, and a
  -- second close_voting, then compare.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = p_cycle_id
     for update;

  if cycle_status = 'vote' then
    update public.feedback_cycles fc
       set status = 'discuss',
           voting_closed_at = pg_catalog.now()
     where fc.id = p_cycle_id;
  elsif cycle_status is distinct from 'discuss' then
    raise exception using errcode = 'P0001', message = 'stage_out_of_date';
  end if;

  return query
    select fc.id, fc.status, fc.voting_closed_at
    from public.feedback_cycles fc
    where fc.id = p_cycle_id;
end;
$$;

revoke all on function public.close_voting(uuid) from public;
revoke all on function public.close_voting(uuid) from anon, authenticated, service_role;

grant execute on function public.close_voting(uuid) to authenticated;
