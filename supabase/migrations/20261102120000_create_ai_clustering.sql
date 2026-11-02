-- Task 20: AI clustering. The run log ai_runs, the cluster-state fingerprint,
-- and the three service-role RPCs the cluster-feedback Edge Function calls.
--
-- Contract. Later tasks (#21, #32, #35, #38, #45) build on these rules and
-- must not weaken them:
--
--   * Who. Only the project's current facilitator may run AI clustering. The
--     Edge Function verifies the caller's JWT and passes the verified user id
--     as p_user_id; these RPCs are callable by service_role only, so the id
--     cannot come from a client. private.is_project_member and
--     private.is_project_facilitator read auth.uid(), which is null for the
--     service role, so the RPCs read project_members for p_user_id directly.
--     A null user, a null or unknown cycle, and a non-member all get
--     not_project_member (the same error, so ids cannot be probed); a member
--     who is not the facilitator, the owner included, gets
--     not_project_facilitator.
--   * When. Only while feedback_cycles.status is 'cluster'
--     (cycle_not_clustering otherwise), at the start and again at the write.
--   * Lock order. projects FOR SHARE (serializes with transfer_facilitator),
--     then the role check, then feedback_cycles FOR UPDATE (serializes with
--     every cluster RPC, advance_stage and close_cycle), then ai_runs rows.
--     This is #100's order. No lock is held while the model is called: begin
--     and replace are two short transactions with the call between them.
--   * Available cards. At run start, the cycle's cards that are ungrouped or
--     in an 'ai' cluster. Cards in a 'manual' cluster are never returned and
--     can never be placed. They are returned ordered by category (start,
--     stop, continue), then card id, never by creation time or author, with
--     exactly card_id, category and text. card_authors and profiles are never
--     read; nothing returned tells an anonymous card from an attributed one.
--     A rerun treats a card someone moved to Ungrouped as available (#18
--     leaves no marker); keeping those out is #97.
--   * Fingerprint. private.ai_cluster_fingerprint(cycle) is md5 over every
--     cluster's (id, source) in id order and every cluster_cards
--     (card_id, cluster_id) in card order. begin stores it for the run;
--     replace recomputes it under the cycle lock and fails with
--     clusters_changed_during_run when it differs. Any create, delete, move,
--     merge, split, keep, or AI rename changes it (a move or rename of an AI
--     cluster turns it manual). A rename of a manual cluster does not, which
--     is safe because names are re-read under the lock.
--   * Limits. One running cluster-feedback run per cycle (a partial unique
--     index; ai_run_in_progress). A running row older than 5 minutes is
--     abandoned: the next begin marks it failed with run_abandoned and goes
--     on. At most 20 runs per cycle that reached the model (succeeded or
--     failed with provider_called = true; ai_run_limit_reached). 50 manual
--     clusters give cluster_limit_reached, more than 300 available cards
--     give too_many_cards. All are checked before any model call.
--   * Replace rules. In one transaction under the cycle lock, replace deletes
--     every 'ai' cluster of the cycle (its cluster_cards rows cascade), then
--     inserts the payload's clusters with source 'ai' in payload order, at
--     sort_order (max of the remaining clusters, or 0) + 1, + 2, ..., and
--     their cards at cluster_cards.sort_order 0 ... n-1 in payload order.
--     Manual clusters, their names, sort_order, source, and cards are never
--     updated or deleted, and no card row changes.
--   * Suffixing. A payload name equal, ignoring case, to a manual cluster's
--     name or an earlier name in the payload gets the lowest free suffix
--     " (2)", " (3)", ...; when base plus suffix would exceed 100 characters,
--     the base is cut and right-trimmed so the result is at most 100. A name
--     clash never fails.
--   * Defence in depth. replace re-validates the payload before writing: an
--     array of at most (50 - manual clusters) objects with exactly name,
--     category and card_ids; names pass #17's rules after the trim; every
--     card id is a card of the cycle that is available under the lock, has
--     the cluster's category, and appears once. Any failure raises
--     invalid_ai_payload and writes nothing.
--   * Events. Only #17's statement-level triggers on clusters and
--     cluster_cards record clusters_changed, with actor_id null and payload
--     '{}'. No RPC here writes the events table or records an actor. A
--     refused call writes nothing.
--   * ai_runs. Server-only: RLS with no policy, no privilege for anon or
--     authenticated, service_role has select, insert and update, and it is
--     not in supabase_realtime. It holds no card text, prompt, model output,
--     cluster name, card id, author, or user id.
--   * Errors. Every raised error's message is a stable code (the Edge
--     Function's error table, or invalid_ai_payload / run_not_active), with
--     no detail or hint, and never an id, a name, or a status.
--
-- Beyond ai_runs, the fingerprint function and the three RPCs, this migration
-- adds two private helpers that hold or check no user data:
-- private.ai_run_fingerprints (the fingerprint stored per running run, since
-- ai_runs has no column for it) and private.ai_run_metrics (the shared check
-- of the metrics object). It adds no policy, grant, view, or Realtime
-- publication entry on cards, card_authors, profiles, feedback_cycles,
-- clusters, or cluster_cards, and changes no earlier function.

-- ---------------------------------------------------------------------------
-- ai_runs
-- ---------------------------------------------------------------------------
create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null,
  function_name text not null,
  model text not null,
  response_model text,
  prompt_version text not null,
  status text not null,
  error_code text,
  provider_called boolean not null default false,
  provider_request_id text,
  provider_status integer,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  card_count integer,
  cluster_count integer,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint ai_runs_cycle_id_fkey foreign key (cycle_id)
    references public.feedback_cycles (id) on delete cascade,
  constraint ai_runs_function_name_check check (function_name = 'cluster-feedback'),
  constraint ai_runs_status_check check (status in ('running', 'succeeded', 'failed', 'skipped')),
  constraint ai_runs_error_code_check check (error_code ~ '^[a-z_]{1,64}$'),
  constraint ai_runs_model_check check (pg_catalog.char_length(model) between 1 and 100),
  constraint ai_runs_response_model_check check (pg_catalog.char_length(response_model) between 1 and 100),
  constraint ai_runs_prompt_version_check check (pg_catalog.char_length(prompt_version) between 1 and 100),
  constraint ai_runs_provider_request_id_check check (pg_catalog.char_length(provider_request_id) between 1 and 200),
  constraint ai_runs_counts_check check (
    coalesce(input_tokens, 0) >= 0
    and coalesce(output_tokens, 0) >= 0
    and coalesce(duration_ms, 0) >= 0
    and coalesce(card_count, 0) >= 0
    and coalesce(cluster_count, 0) >= 0
  )
);

-- At most one running run per cycle and function.
create unique index ai_runs_one_running_idx
  on public.ai_runs (cycle_id, function_name)
  where status = 'running';

create index ai_runs_cycle_id_idx
  on public.ai_runs (cycle_id, function_name);

alter table public.ai_runs enable row level security;

revoke all on table public.ai_runs from public;
revoke all on table public.ai_runs from anon, authenticated, service_role;

grant select, insert, update on table public.ai_runs to service_role;

-- ---------------------------------------------------------------------------
-- private.ai_run_fingerprints: the cluster-state fingerprint taken by
-- begin_ai_clustering, one row per running run. Only the RPCs below (as the
-- function owner) read or write it; no API role has any privilege.
-- ---------------------------------------------------------------------------
create table private.ai_run_fingerprints (
  run_id uuid primary key,
  fingerprint text not null,
  constraint ai_run_fingerprints_run_id_fkey foreign key (run_id)
    references public.ai_runs (id) on delete cascade
);

alter table private.ai_run_fingerprints enable row level security;

revoke all on table private.ai_run_fingerprints from public;
revoke all on table private.ai_run_fingerprints from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.ai_cluster_fingerprint
-- ---------------------------------------------------------------------------
create function private.ai_cluster_fingerprint(p_cycle_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.md5(
    coalesce(
      (select pg_catalog.string_agg(cl.id::text || ':' || cl.source, ',' order by cl.id)
         from public.clusters cl
        where cl.cycle_id = p_cycle_id),
      ''
    )
    || '|'
    || coalesce(
      (select pg_catalog.string_agg(cc.card_id::text || ':' || cc.cluster_id::text, ',' order by cc.card_id)
         from public.cluster_cards cc
        where cc.cycle_id = p_cycle_id),
      ''
    )
  );
$$;

revoke all on function private.ai_cluster_fingerprint(uuid) from public;
revoke all on function private.ai_cluster_fingerprint(uuid) from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.ai_run_metrics: checks a metrics object and returns it. Null means
-- '{}'. Only the keys in p_allowed may appear; each has a fixed type:
--   provider_called                   boolean
--   provider_request_id               string, 1-200 characters
--   response_model, status            string, 1-100 characters
--   provider_status                   integer 100-599
--   input_tokens, output_tokens,
--   duration_ms, cluster_count        integer >= 0
-- Anything else raises invalid_ai_payload.
-- ---------------------------------------------------------------------------
create function private.ai_run_metrics(p_metrics jsonb, p_allowed text[])
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  metrics jsonb := coalesce(p_metrics, '{}'::jsonb);
  k text;
  v jsonb;
begin
  if pg_catalog.jsonb_typeof(metrics) <> 'object' then
    raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
  end if;

  for k, v in select e.key, e.value from pg_catalog.jsonb_each(metrics) e loop
    if not (k = any (p_allowed)) then
      raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
    end if;

    if pg_catalog.jsonb_typeof(v) = 'null' then
      continue;
    end if;

    if k = 'provider_called' then
      if pg_catalog.jsonb_typeof(v) <> 'boolean' then
        raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
      end if;
    elsif k in ('provider_request_id', 'response_model', 'status') then
      if pg_catalog.jsonb_typeof(v) <> 'string'
         or pg_catalog.char_length(v #>> '{}') not between 1 and (case when k = 'provider_request_id' then 200 else 100 end) then
        raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
      end if;
    elsif k in ('provider_status', 'input_tokens', 'output_tokens', 'duration_ms', 'cluster_count') then
      if pg_catalog.jsonb_typeof(v) <> 'number'
         or (v #>> '{}') !~ '^[0-9]{1,9}$'
         or (k = 'provider_status' and (v #>> '{}')::integer not between 100 and 599) then
        raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
      end if;
    else
      raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
    end if;
  end loop;

  return metrics;
end;
$$;

revoke all on function private.ai_run_metrics(jsonb, text[]) from public;
revoke all on function private.ai_run_metrics(jsonb, text[]) from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- begin_ai_clustering
--
-- Check order (each failing step writes nothing):
--   1. null user, null or unknown cycle, or the user is not a member
--                                                -> 42501 not_project_member
--   2. lock the projects row FOR SHARE
--   3. the user is not the facilitator now       -> 42501 not_project_facilitator
--   4. lock the cycle row FOR UPDATE
--   5. status is not cluster                     -> P0001 cycle_not_clustering
--   6. p_model or p_prompt_version null, empty, or over 100 characters
--                                                -> P0001 invalid_ai_payload
--   7. mark running runs older than 5 minutes failed / run_abandoned
--   8. a running run remains                     -> P0001 ai_run_in_progress
--   9. 20 runs reached the model                 -> P0001 ai_run_limit_reached
--  10. 50 manual clusters                        -> P0001 cluster_limit_reached
--  11. more than 300 available cards             -> P0001 too_many_cards
--  12. insert the running row and its fingerprint, and return
--      {run_id, cards, manual_cluster_names, cluster_slots}
-- ---------------------------------------------------------------------------
create function public.begin_ai_clustering(
  p_cycle_id uuid,
  p_user_id uuid,
  p_model text,
  p_prompt_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cycle_project uuid;
  cycle_status text;
  manual_count integer;
  available_cards jsonb;
  available_count integer;
  manual_names jsonb;
  new_run uuid;
begin
  if p_user_id is null then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- project_id never changes, so it can be read before the locks.
  select fc.project_id
    into cycle_project
    from public.feedback_cycles fc
   where fc.id = p_cycle_id;

  if cycle_project is null
     or not exists (
       select 1
         from public.project_members pm
        where pm.project_id = cycle_project
          and pm.user_id = p_user_id
     ) then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- Serialize with transfer_facilitator, then check the role as it is now.
  perform 1 from public.projects p where p.id = cycle_project for share;

  if not exists (
    select 1
      from public.project_members pm
     where pm.project_id = cycle_project
       and pm.user_id = p_user_id
       and pm.role = 'facilitator'
  ) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
  end if;

  -- Serialize with every cluster write, advance_stage, and close_cycle.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = p_cycle_id
     for update;

  if cycle_status is distinct from 'cluster' then
    raise exception using errcode = 'P0001', message = 'cycle_not_clustering';
  end if;

  if p_model is null
     or pg_catalog.char_length(p_model) not between 1 and 100
     or p_prompt_version is null
     or pg_catalog.char_length(p_prompt_version) not between 1 and 100 then
    raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
  end if;

  -- A run killed mid-call never finishes; after 5 minutes it is abandoned.
  update public.ai_runs r
     set status = 'failed',
         error_code = 'run_abandoned',
         finished_at = now()
   where r.cycle_id = p_cycle_id
     and r.function_name = 'cluster-feedback'
     and r.status = 'running'
     and r.started_at < now() - interval '5 minutes';

  if exists (
    select 1
      from public.ai_runs r
     where r.cycle_id = p_cycle_id
       and r.function_name = 'cluster-feedback'
       and r.status = 'running'
  ) then
    raise exception using errcode = 'P0001', message = 'ai_run_in_progress';
  end if;

  if (
    select count(*)
      from public.ai_runs r
     where r.cycle_id = p_cycle_id
       and r.function_name = 'cluster-feedback'
       and r.status in ('succeeded', 'failed')
       and r.provider_called
  ) >= 20 then
    raise exception using errcode = 'P0001', message = 'ai_run_limit_reached';
  end if;

  select count(*)
    into manual_count
    from public.clusters cl
   where cl.cycle_id = p_cycle_id
     and cl.source = 'manual';

  if manual_count >= 50 then
    raise exception using errcode = 'P0001', message = 'cluster_limit_reached';
  end if;

  -- Available: ungrouped or in an AI cluster. Built from cards columns only.
  select count(*),
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'card_id', c.id,
               'category', c.category,
               'text', c.text
             )
             order by pg_catalog.array_position(array['start', 'stop', 'continue']::text[], c.category), c.id
           ),
           '[]'::jsonb
         )
    into available_count, available_cards
    from public.cards c
   where c.cycle_id = p_cycle_id
     and not exists (
       select 1
         from public.cluster_cards cc
         join public.clusters cl on cl.id = cc.cluster_id
        where cc.card_id = c.id
          and cl.source = 'manual'
     );

  if available_count > 300 then
    raise exception using errcode = 'P0001', message = 'too_many_cards';
  end if;

  select coalesce(pg_catalog.jsonb_agg(cl.name order by cl.sort_order), '[]'::jsonb)
    into manual_names
    from public.clusters cl
   where cl.cycle_id = p_cycle_id
     and cl.source = 'manual';

  insert into public.ai_runs (cycle_id, function_name, model, prompt_version, status, card_count)
  values (p_cycle_id, 'cluster-feedback', p_model, p_prompt_version, 'running', available_count)
  returning public.ai_runs.id into new_run;

  insert into private.ai_run_fingerprints (run_id, fingerprint)
  values (new_run, private.ai_cluster_fingerprint(p_cycle_id));

  return pg_catalog.jsonb_build_object(
    'run_id', new_run,
    'cards', available_cards,
    'manual_cluster_names', manual_names,
    'cluster_slots', 50 - manual_count
  );
end;
$$;

revoke all on function public.begin_ai_clustering(uuid, uuid, text, text) from public;
revoke all on function public.begin_ai_clustering(uuid, uuid, text, text) from anon, authenticated, service_role;

grant execute on function public.begin_ai_clustering(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- replace_ai_clusters
--
-- p_clusters: a JSON array of {name, category, card_ids} in the model's
-- order. p_metrics: provider_called, provider_request_id, provider_status,
-- response_model, input_tokens, output_tokens, duration_ms, cluster_count,
-- and status ('succeeded', the default, or 'skipped' with an empty payload
-- and provider_called not true). cluster_count is recomputed from the payload.
--
-- Check order (each failing step writes nothing and leaves the run running):
--   1. unknown or finished run                   -> P0001 run_not_active
--   2. null user or not a member                 -> 42501 not_project_member
--   3. lock the projects row FOR SHARE
--   4. not the facilitator now                   -> 42501 not_project_facilitator
--   5. lock the cycle row FOR UPDATE, then the run row FOR UPDATE
--   6. status is not cluster                     -> P0001 cycle_not_clustering
--   7. the run finished meanwhile                -> P0001 run_not_active
--   8. the fingerprint changed                   -> P0001 clusters_changed_during_run
--   9. metrics or payload invalid                -> P0001 invalid_ai_payload
--  10. delete the AI clusters, insert the new ones with suffixed names and
--      their cards, mark the run succeeded (or skipped) with its metrics,
--      and return {cluster_count, clustered_card_count}
-- ---------------------------------------------------------------------------
create function public.replace_ai_clusters(
  p_run_id uuid,
  p_user_id uuid,
  p_clusters jsonb,
  p_metrics jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  run_cycle uuid;
  run_status text;
  cycle_project uuid;
  cycle_status text;
  stored_fingerprint text;
  metrics jsonb;
  final_status text;
  slots integer;
  payload_count integer;
  card_total integer := 0;
  item jsonb;
  item_name text;
  item_category text;
  card_value jsonb;
  card_uuid uuid;
  card_category text;
  seen_cards uuid[] := '{}';
  taken_names text[];
  final_name text;
  suffix text;
  n integer;
  next_sort integer;
  new_cluster uuid;
  pos integer;
begin
  select r.cycle_id, r.status
    into run_cycle, run_status
    from public.ai_runs r
   where r.id = p_run_id
     and r.function_name = 'cluster-feedback';

  if run_cycle is null or run_status is distinct from 'running' then
    raise exception using errcode = 'P0001', message = 'run_not_active';
  end if;

  select fc.project_id
    into cycle_project
    from public.feedback_cycles fc
   where fc.id = run_cycle;

  if p_user_id is null
     or cycle_project is null
     or not exists (
       select 1
         from public.project_members pm
        where pm.project_id = cycle_project
          and pm.user_id = p_user_id
     ) then
    raise exception using errcode = '42501', message = 'not_project_member';
  end if;

  -- Serialize with transfer_facilitator, then check the role as it is now.
  perform 1 from public.projects p where p.id = cycle_project for share;

  if not exists (
    select 1
      from public.project_members pm
     where pm.project_id = cycle_project
       and pm.user_id = p_user_id
       and pm.role = 'facilitator'
  ) then
    raise exception using errcode = '42501', message = 'not_project_facilitator';
  end if;

  -- Serialize with every cluster write, advance_stage, and close_cycle.
  select fc.status
    into cycle_status
    from public.feedback_cycles fc
   where fc.id = run_cycle
     for update;

  select r.status
    into run_status
    from public.ai_runs r
   where r.id = p_run_id
     for update;

  if cycle_status is distinct from 'cluster' then
    raise exception using errcode = 'P0001', message = 'cycle_not_clustering';
  end if;

  if run_status is distinct from 'running' then
    raise exception using errcode = 'P0001', message = 'run_not_active';
  end if;

  select f.fingerprint
    into stored_fingerprint
    from private.ai_run_fingerprints f
   where f.run_id = p_run_id;

  if stored_fingerprint is distinct from private.ai_cluster_fingerprint(run_cycle) then
    raise exception using errcode = 'P0001', message = 'clusters_changed_during_run';
  end if;

  -- Metrics.
  metrics := private.ai_run_metrics(
    p_metrics,
    array['provider_called', 'provider_request_id', 'provider_status', 'response_model',
          'input_tokens', 'output_tokens', 'duration_ms', 'cluster_count', 'status']
  );
  final_status := coalesce(metrics ->> 'status', 'succeeded');
  if final_status not in ('succeeded', 'skipped') then
    raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
  end if;

  -- Payload shape and slots. Manual clusters cannot change while the cycle
  -- row is locked.
  if p_clusters is null or pg_catalog.jsonb_typeof(p_clusters) <> 'array' then
    raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
  end if;

  payload_count := pg_catalog.jsonb_array_length(p_clusters);

  if final_status = 'skipped'
     and (payload_count > 0 or coalesce((metrics ->> 'provider_called')::boolean, false)) then
    raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
  end if;

  select 50 - count(*)
    into slots
    from public.clusters cl
   where cl.cycle_id = run_cycle
     and cl.source = 'manual';

  if payload_count > slots then
    raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
  end if;

  -- Validate every cluster and card before any write.
  for item in select e.value from pg_catalog.jsonb_array_elements(p_clusters) e loop
    if pg_catalog.jsonb_typeof(item) <> 'object'
       or (select pg_catalog.array_agg(k.key order by k.key) from pg_catalog.jsonb_object_keys(item) k(key))
          is distinct from array['card_ids', 'category', 'name']
       or pg_catalog.jsonb_typeof(item -> 'name') <> 'string'
       or pg_catalog.jsonb_typeof(item -> 'category') <> 'string'
       or pg_catalog.jsonb_typeof(item -> 'card_ids') <> 'array'
       or pg_catalog.jsonb_array_length(item -> 'card_ids') = 0 then
      raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
    end if;

    item_name := pg_catalog.btrim(item ->> 'name', E' \t\n\r');
    item_category := item ->> 'category';

    if pg_catalog.char_length(item_name) not between 1 and 100
       or item_name ~ '[[:cntrl:]]'
       or item_category not in ('start', 'stop', 'continue') then
      raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
    end if;

    for card_value in select e.value from pg_catalog.jsonb_array_elements(item -> 'card_ids') e loop
      if pg_catalog.jsonb_typeof(card_value) <> 'string'
         or (card_value #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
        raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
      end if;

      card_uuid := (card_value #>> '{}')::uuid;

      if card_uuid = any (seen_cards) then
        raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
      end if;
      seen_cards := seen_cards || card_uuid;

      card_category := null;
      select c.category
        into card_category
        from public.cards c
       where c.id = card_uuid
         and c.cycle_id = run_cycle
         and not exists (
           select 1
             from public.cluster_cards cc
             join public.clusters cl on cl.id = cc.cluster_id
            where cc.card_id = c.id
              and cl.source = 'manual'
         );

      if card_category is distinct from item_category then
        raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
      end if;
    end loop;
  end loop;

  -- Write. The AI clusters go first; their cards are ungrouped by cascade.
  delete from public.clusters cl
   where cl.cycle_id = run_cycle
     and cl.source = 'ai';

  select coalesce(pg_catalog.array_agg(pg_catalog.lower(cl.name)), '{}')
    into taken_names
    from public.clusters cl
   where cl.cycle_id = run_cycle;

  select coalesce(max(cl.sort_order), 0)
    into next_sort
    from public.clusters cl
   where cl.cycle_id = run_cycle;

  for item in
    select e.value
      from pg_catalog.jsonb_array_elements(p_clusters) with ordinality e(value, ord)
     order by e.ord
  loop
    item_name := pg_catalog.btrim(item ->> 'name', E' \t\n\r');
    final_name := item_name;
    n := 1;
    while pg_catalog.lower(final_name) = any (taken_names) loop
      n := n + 1;
      suffix := ' (' || n::text || ')';
      final_name := pg_catalog.rtrim(
                      pg_catalog.left(item_name, 100 - pg_catalog.char_length(suffix)),
                      E' \t\n\r'
                    ) || suffix;
    end loop;
    taken_names := taken_names || pg_catalog.lower(final_name);

    next_sort := next_sort + 1;
    insert into public.clusters (cycle_id, name, source, sort_order)
    values (run_cycle, final_name, 'ai', next_sort)
    returning public.clusters.id into new_cluster;

    insert into public.cluster_cards (cycle_id, cluster_id, card_id, sort_order)
    select run_cycle, new_cluster, (c.value #>> '{}')::uuid, (c.ord - 1)::integer
      from pg_catalog.jsonb_array_elements(item -> 'card_ids') with ordinality c(value, ord);

    card_total := card_total + pg_catalog.jsonb_array_length(item -> 'card_ids');
  end loop;

  update public.ai_runs r
     set status = final_status,
         error_code = null,
         finished_at = now(),
         provider_called = r.provider_called or coalesce((metrics ->> 'provider_called')::boolean, false),
         provider_request_id = metrics ->> 'provider_request_id',
         provider_status = (metrics ->> 'provider_status')::integer,
         response_model = metrics ->> 'response_model',
         input_tokens = (metrics ->> 'input_tokens')::integer,
         output_tokens = (metrics ->> 'output_tokens')::integer,
         duration_ms = (metrics ->> 'duration_ms')::integer,
         cluster_count = payload_count
   where r.id = p_run_id;

  delete from private.ai_run_fingerprints f where f.run_id = p_run_id;

  return pg_catalog.jsonb_build_object(
    'cluster_count', payload_count,
    'clustered_card_count', card_total
  );
end;
$$;

revoke all on function public.replace_ai_clusters(uuid, uuid, jsonb, jsonb) from public;
revoke all on function public.replace_ai_clusters(uuid, uuid, jsonb, jsonb) from anon, authenticated, service_role;

grant execute on function public.replace_ai_clusters(uuid, uuid, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- finish_ai_run
--
-- Ends a running run without writing clusters: a failure (status 'failed'
-- with an error code) or, for completeness, 'succeeded' / 'skipped' with no
-- error code. p_metrics takes provider_called, provider_request_id,
-- provider_status, response_model, input_tokens, output_tokens, and
-- duration_ms. It locks only the run row.
--
--   1. p_status not succeeded, failed, or skipped; failed without an error
--      code, or an error code on another status; an error code not matching
--      ^[a-z_]{1,64}$; invalid metrics       -> P0001 invalid_ai_payload
--   2. unknown or finished run                -> P0001 run_not_active
--   3. set status, error_code, finished_at, and the metrics
-- ---------------------------------------------------------------------------
create function public.finish_ai_run(
  p_run_id uuid,
  p_status text,
  p_error_code text,
  p_metrics jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  metrics jsonb;
  run_status text;
begin
  if p_status is null
     or p_status not in ('succeeded', 'failed', 'skipped')
     or (p_status = 'failed') <> (p_error_code is not null)
     or (p_error_code is not null and p_error_code !~ '^[a-z_]{1,64}$') then
    raise exception using errcode = 'P0001', message = 'invalid_ai_payload';
  end if;

  metrics := private.ai_run_metrics(
    p_metrics,
    array['provider_called', 'provider_request_id', 'provider_status', 'response_model',
          'input_tokens', 'output_tokens', 'duration_ms']
  );

  select r.status
    into run_status
    from public.ai_runs r
   where r.id = p_run_id
     and r.function_name = 'cluster-feedback'
     for update;

  if run_status is distinct from 'running' then
    raise exception using errcode = 'P0001', message = 'run_not_active';
  end if;

  update public.ai_runs r
     set status = p_status,
         error_code = p_error_code,
         finished_at = now(),
         provider_called = r.provider_called or coalesce((metrics ->> 'provider_called')::boolean, false),
         provider_request_id = metrics ->> 'provider_request_id',
         provider_status = (metrics ->> 'provider_status')::integer,
         response_model = metrics ->> 'response_model',
         input_tokens = (metrics ->> 'input_tokens')::integer,
         output_tokens = (metrics ->> 'output_tokens')::integer,
         duration_ms = (metrics ->> 'duration_ms')::integer
   where r.id = p_run_id;

  delete from private.ai_run_fingerprints f where f.run_id = p_run_id;
end;
$$;

revoke all on function public.finish_ai_run(uuid, text, text, jsonb) from public;
revoke all on function public.finish_ai_run(uuid, text, text, jsonb) from anon, authenticated, service_role;

grant execute on function public.finish_ai_run(uuid, text, text, jsonb) to service_role;
