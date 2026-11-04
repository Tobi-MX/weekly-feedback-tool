-- Task 27: the project action list.
--
-- The project page lists the action items of every retrospective in the
-- project. Members read them through one new read, get_project_actions, and
-- change their status through #26's set_action_status. This migration creates
-- that one function and changes no table, trigger, policy, grant on a table,
-- or publication. #26's RPCs are unchanged.
--
-- Decisions:
--
--   1. One read RPC, filters in SQL. get_project_actions(p_project_id,
--      p_status, p_mine_only) returns the project's actions across all of its
--      cycles. The status filter (open, done, all) and "Assigned to me"
--      (owner_id = auth.uid()) are applied in the database. The browser never
--      fetches all actions and filters them.
--   2. Two lists, two limits.
--      - open: every open action, by due_date ascending with no-date actions
--        last, then created_at, then id. Overdue items come first. At most
--        200 are returned.
--      - done: the 20 most recently completed, by completed_at descending,
--        then id.
--      open_count and done_count are always the full totals under the current
--      p_mine_only, whatever p_status is. Paging past the limits is #114.
--   3. The element shape extends #26's get_cycle_actions element: its 13 keys
--      (action_id, cluster_id, description, owner_id, owner_name, owner_is_me,
--      created_by_me, due_date, status, completed_at, source, created_at,
--      updated_at) plus cycle_id, cycle_title, cycle_status and cluster_name
--      (17 keys). owner_name is joined from profiles here, with #26's rule:
--      the current display_name, 'Member' when the profile has none, null when
--      owner_id is null. cluster_name is null exactly when cluster_id is null.
--      No created_by id is returned. Two members' responses with the same
--      filters differ only in owner_is_me and created_by_me (and, with
--      p_mine_only, in which rows are listed).
--
-- Check order:
--
--   get_project_actions(p_project_id, p_status, p_mine_only)
--     1. null user, null or unknown project, or not a member
--                                                 -> 42501 not_project_member
--     2. p_status null or not open / done / all, or p_mine_only null
--                                                 -> P0001 invalid_action_filter
--     3. return {project_id, status, mine_only, open_count, done_count, open,
--        done}; open is [] unless p_status is open or all, done is [] unless
--        p_status is done or all.
--
-- The function is stable, takes no lock and writes nothing. It reads only
-- actions, feedback_cycles (matched on project_id), clusters, profiles and
-- the private.is_project_member helper; never the projects table itself.

create function public.get_project_actions(
  p_project_id uuid,
  p_status text,
  p_mine_only boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid;
  open_total integer;
  done_total integer;
  open_items jsonb := '[]'::jsonb;
  done_items jsonb := '[]'::jsonb;
begin
  caller := (select auth.uid());

  if caller is null
     or p_project_id is null
     or not private.is_project_member(p_project_id) then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  if p_status is null
     or p_status not in ('open', 'done', 'all')
     or p_mine_only is null then
    raise exception using errcode = 'P0001', message = 'invalid_action_filter';
  end if;

  select pg_catalog.count(*) filter (where a.status = 'open')::integer,
         pg_catalog.count(*) filter (where a.status = 'done')::integer
    into open_total, done_total
    from public.actions a
    join public.feedback_cycles fc on fc.id = a.cycle_id
   where fc.project_id = p_project_id
     and (not p_mine_only or a.owner_id = caller);

  if p_status in ('open', 'all') then
    select coalesce(
             pg_catalog.jsonb_agg(x.item order by x.ord),
             '[]'::jsonb
           )
      into open_items
      from (
        select pg_catalog.jsonb_build_object(
                 'action_id', a.id,
                 'cluster_id', a.cluster_id,
                 'description', a.description,
                 'owner_id', a.owner_id,
                 'owner_name', case
                                 when a.owner_id is null then null
                                 else coalesce(pr.display_name, 'Member')
                               end,
                 'owner_is_me', coalesce(a.owner_id = caller, false),
                 'created_by_me', coalesce(a.created_by = caller, false),
                 'due_date', pg_catalog.to_char(a.due_date, 'YYYY-MM-DD'),
                 'status', a.status,
                 'completed_at', a.completed_at,
                 'source', a.source,
                 'created_at', a.created_at,
                 'updated_at', a.updated_at,
                 'cycle_id', fc.id,
                 'cycle_title', fc.title,
                 'cycle_status', fc.status,
                 'cluster_name', cl.name
               ) as item,
               pg_catalog.row_number() over (
                 order by a.due_date asc nulls last, a.created_at, a.id
               ) as ord
          from public.actions a
          join public.feedback_cycles fc on fc.id = a.cycle_id
          left join public.clusters cl on cl.id = a.cluster_id
          left join public.profiles pr on pr.id = a.owner_id
         where fc.project_id = p_project_id
           and a.status = 'open'
           and (not p_mine_only or a.owner_id = caller)
         order by a.due_date asc nulls last, a.created_at, a.id
         limit 200
      ) x;
  end if;

  if p_status in ('done', 'all') then
    select coalesce(
             pg_catalog.jsonb_agg(x.item order by x.ord),
             '[]'::jsonb
           )
      into done_items
      from (
        select pg_catalog.jsonb_build_object(
                 'action_id', a.id,
                 'cluster_id', a.cluster_id,
                 'description', a.description,
                 'owner_id', a.owner_id,
                 'owner_name', case
                                 when a.owner_id is null then null
                                 else coalesce(pr.display_name, 'Member')
                               end,
                 'owner_is_me', coalesce(a.owner_id = caller, false),
                 'created_by_me', coalesce(a.created_by = caller, false),
                 'due_date', pg_catalog.to_char(a.due_date, 'YYYY-MM-DD'),
                 'status', a.status,
                 'completed_at', a.completed_at,
                 'source', a.source,
                 'created_at', a.created_at,
                 'updated_at', a.updated_at,
                 'cycle_id', fc.id,
                 'cycle_title', fc.title,
                 'cycle_status', fc.status,
                 'cluster_name', cl.name
               ) as item,
               pg_catalog.row_number() over (
                 order by a.completed_at desc, a.id
               ) as ord
          from public.actions a
          join public.feedback_cycles fc on fc.id = a.cycle_id
          left join public.clusters cl on cl.id = a.cluster_id
          left join public.profiles pr on pr.id = a.owner_id
         where fc.project_id = p_project_id
           and a.status = 'done'
           and (not p_mine_only or a.owner_id = caller)
         order by a.completed_at desc, a.id
         limit 20
      ) x;
  end if;

  return pg_catalog.jsonb_build_object(
    'project_id', p_project_id,
    'status', p_status,
    'mine_only', p_mine_only,
    'open_count', open_total,
    'done_count', done_total,
    'open', open_items,
    'done', done_items
  );
end;
$$;

revoke all on function public.get_project_actions(uuid, text, boolean) from public;
revoke all on function public.get_project_actions(uuid, text, boolean) from anon, authenticated, service_role;

grant execute on function public.get_project_actions(uuid, text, boolean) to authenticated;
