-- Task 16: advance_stage, the board's one-step stage control.
--
-- Transition table. No transition skips a stage and none goes backwards.
--
--   collecting -> reveal    start_retrospective (#14), sets revealed_at
--   reveal     -> cluster   advance_stage (this migration)
--   cluster    -> vote      advance_stage (this migration)
--   vote       -> discuss   close_voting (#24), sets voting_closed_at
--   discuss    -> closed    publish_summary (#34)
--   any open   -> closed    close_cycle (#10)
--   backwards               not built (#81)
--
-- advance_stage allows only reveal -> cluster and cluster -> vote. It refuses
-- vote (moving to discuss without close_voting would leave voting_closed_at
-- null and the vote totals gate shut), discuss (#34 snapshots the summary
-- while closing), and collecting (#14 must set revealed_at).
--
-- From-status rule. public.advance_stage(p_cycle_id, p_from_status) names the
-- stage the caller is leaving; the target is fixed by it (reveal -> cluster,
-- cluster -> vote), so no argument can skip a stage. Two clicks, two tabs, or
-- a retry that each send 'reveal' move the cycle to cluster once: the second
-- call finds the target already reached and is a successful no-op.
--
-- Check order. Each failing check changes nothing.
--
--   1. (select auth.uid()) is null                -> 42501 not_project_member
--   2. read the cycle's project_id; a null id, an unknown cycle, or a caller
--      who is not a member of the project       -> 42501 not_project_member
--   3. lock the projects row FOR SHARE (serializes with transfer_facilitator,
--      which locks it FOR UPDATE); the caller is not the facilitator now
--      (owning the project gives no right)      -> 42501 not_project_facilitator
--   4. p_from_status is not exactly 'reveal' or 'cluster' (null included)
--                                                -> P0001 invalid_stage_transition
--   5. lock the cycle row FOR UPDATE (serializes with close_cycle and with a
--      second advance) and compare its status:
--        status = p_from_status  -> update to the target, return the new row
--        status = the target     -> no-op, return the current row
--        anything else           -> P0001 stage_out_of_date
--
-- No event insert. #14's feedback_cycles_record_stage_change trigger records
-- the one stage_changed row in the same transaction, with actor_id = the
-- caller. A no-op changes no status, so it records nothing. This function
-- never writes cycle_events itself, which would record two events per step.
--
-- Data scope. The function reads and writes only feedback_cycles and (through
-- the private helpers) projects and project_members. It never reads cards,
-- card_authors, or profiles, and it never touches revealed_at or
-- voting_closed_at. Its errors carry only the stable message, with no detail
-- or hint, and never an id or a status.
--
-- This migration adds no table, column, view, policy, grant, or Realtime
-- publication entry on cards, card_authors, profiles, or feedback_cycles.

create function public.advance_stage(p_cycle_id uuid, p_from_status text)
returns table (
  id uuid,
  status text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cycle_project uuid;
  cycle_status text;
  target_status text;
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

  -- The target is fixed by the stage being left.
  target_status := case p_from_status
                     when 'reveal' then 'cluster'
                     when 'cluster' then 'vote'
                   end;

  if target_status is null then
    raise exception using errcode = 'P0001', message = 'invalid_stage_transition';
  end if;

  -- Serialize with close_cycle and a concurrent advance, then compare.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = p_cycle_id
     for update;

  if cycle_status = p_from_status then
    update public.feedback_cycles fc
       set status = target_status
     where fc.id = p_cycle_id;
  elsif cycle_status is distinct from target_status then
    raise exception using errcode = 'P0001', message = 'stage_out_of_date';
  end if;

  return query
    select fc.id, fc.status
    from public.feedback_cycles fc
    where fc.id = p_cycle_id;
end;
$$;

revoke all on function public.advance_stage(uuid, text) from public;
revoke all on function public.advance_stage(uuid, text) from anon, authenticated, service_role;

grant execute on function public.advance_stage(uuid, text) to authenticated;
