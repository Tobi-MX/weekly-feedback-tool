-- Task 21: keep the AI cluster suggestions.
--
-- The keep rule. #20 has no separate draft state: an AI suggestion is a
-- cluster with source 'ai', which can be voted on, edited, and deleted like
-- any other; the only difference is that the next AI run replaces it.
-- "Keep suggestions" sets every source = 'ai' cluster of the cycle to
-- source = 'manual', so reruns leave them alone and the "AI suggestion"
-- badge goes away. Nothing else changes: each kept cluster keeps its id,
-- name, sort_order, and cards. Editing one AI cluster already keeps that one
-- (#17-#19 flip it to manual). Keeping is optional; "Start voting" neither
-- requires it nor changes source. Keeping a single suggestion is #101.
--
-- Who. Only the project's current facilitator; the owner gets nothing extra.
-- The check is private.is_project_facilitator(project_id), which reads the
-- caller's own project_members row, never owner_id. A null user, a null or
-- unknown cycle, and a non-member all get not_project_member (the same
-- error, so ids cannot be probed).
--
-- Check order (#100's), each failing step changes nothing:
--   1. (select auth.uid()) is null                -> 42501 not_project_member
--   2. null or unknown cycle, or not a member     -> 42501 not_project_member
--   3. lock the projects row FOR SHARE (serializes with transfer_facilitator)
--   4. not the facilitator now                    -> 42501 not_project_facilitator
--   5. lock the cycle row FOR UPDATE (serializes with every cluster write,
--      replace_ai_clusters, advance_stage, and close_cycle)
--   6. status is not cluster                      -> P0001 cycle_not_clustering
--   7. set source 'manual' on the cycle's 'ai' clusters; return the count
--
-- A second call returns 0 and changes nothing. The function inserts no event
-- and records no actor: #17's statement trigger records one clusters_changed
-- row (actor_id null, payload '{}') when at least one cluster changed, and
-- none when none did. Because it changes source, the cluster fingerprint of
-- an AI run in flight changes, and that run fails with
-- clusters_changed_during_run and writes nothing, as #20 intends.
--
-- It reads no author data and returns only a count. This migration adds no
-- table, column, constraint, policy, grant on a table, view, or Realtime
-- publication entry. get_cycle_board is unchanged.

create function public.accept_ai_clusters(p_cycle_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cycle_project uuid;
  cycle_status text;
  kept integer;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- project_id never changes, so it can be read before the locks.
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

  -- Serialize with every cluster write, an AI run's write, advance_stage,
  -- and close_cycle.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = p_cycle_id
     for update;

  if cycle_status is distinct from 'cluster' then
    raise exception using errcode = 'P0001', message = 'cycle_not_clustering';
  end if;

  update public.clusters cl
     set source = 'manual'
   where cl.cycle_id = p_cycle_id
     and cl.source = 'ai';

  get diagnostics kept = row_count;
  return kept;
end;
$$;

revoke all on function public.accept_ai_clusters(uuid) from public;
revoke all on function public.accept_ai_clusters(uuid) from anon, authenticated, service_role;

grant execute on function public.accept_ai_clusters(uuid) to authenticated;
