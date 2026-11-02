-- pgTAP tests for #20: ai_runs, the cluster fingerprint, and the three
-- service-role RPCs begin_ai_clustering, replace_ai_clusters, and
-- finish_ai_run. Covers the table, grants and RLS, the hardening of the
-- RPCs, available cards, refusals, limits, the write, manual preservation,
-- name suffixes, the stale and race checks, the payload re-validation, the
-- events, and finish_ai_run.
--
-- Everything runs in one transaction and is rolled back at the end,
-- including the pgTAP extension and the ai_test helper schema. The seed user
-- is never used as a fixture.
--
-- Fixtures: owner A (facilitator by default), members B and D, non-member C.
-- P is owned by A with B and D joined; Q is owned by C. P1 (P) is the main
-- cycle: attributed and anonymous cards from A, B, and D through
-- create_card, revealed and moved to cluster by A through the real RPCs.
-- Q1 (Q) is C's cycle in cluster, built as postgres, for the limits.
-- The RPCs are called as service_role, as the Edge Function calls them.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(161);

-- ---------------------------------------------------------------------------
-- Test-only helpers.
-- ---------------------------------------------------------------------------
create schema ai_test;

create table ai_test.ids (label text primary key, id uuid not null);
create table ai_test.snaps (label text primary key, body jsonb);
create table ai_test.seen (id uuid primary key);

insert into ai_test.ids (label, id)
values
  ('A', '1a000000-0000-4000-8000-000000000001'),
  ('B', '1a000000-0000-4000-8000-000000000002'),
  ('C', '1a000000-0000-4000-8000-000000000003'),
  ('D', '1a000000-0000-4000-8000-000000000004'),
  ('P', '2a000000-0000-4000-8000-000000000001'),
  ('Q', '2a000000-0000-4000-8000-000000000002'),
  ('P1', '3a000000-0000-4000-8000-000000000001'),
  ('Q1', '3a000000-0000-4000-8000-000000000011'),
  ('q card', '5a000000-0000-4000-8000-000000000011'),
  ('Old AI', '4a000000-0000-4000-8000-000000000001');

create function ai_test.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from ai_test.ids i where i.label = p_label;
$$;

create function ai_test.become(p_user text)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', ai_test.id(p_user), 'role', 'authenticated')::text,
    true
  );
end;
$$;

-- The error a refused call gets, with empty detail and hint.
create function ai_test.e(p_message text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'code', case when p_message in ('not_project_member', 'not_project_facilitator') then '42501' else 'P0001' end,
    'message', p_message,
    'detail', '',
    'hint', ''
  );
$$;

-- begin_ai_clustering with raw ids: the result, or the full error.
create function ai_test.begin_raw(p_cycle uuid, p_user uuid)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  return public.begin_ai_clustering(p_cycle, p_user, 'claude-opus-5-5', 'cluster-feedback/v1');
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

create function ai_test.begin(p_cycle text, p_user text)
returns jsonb
language sql
as $$
  select ai_test.begin_raw(ai_test.id(p_cycle), ai_test.id(p_user));
$$;

-- begin as the user and store the run id under the label.
create function ai_test.start_run(p_cycle text, p_user text, p_label text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb := ai_test.begin(p_cycle, p_user);
begin
  if result ? 'run_id' then
    insert into ai_test.ids (label, id) values (p_label, (result ->> 'run_id')::uuid)
    on conflict (label) do update set id = excluded.id;
  end if;
  return result;
end;
$$;

create function ai_test.replace_raw(p_run uuid, p_user uuid, p_clusters jsonb, p_metrics jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  return public.replace_ai_clusters(p_run, p_user, p_clusters, p_metrics);
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

create function ai_test.replace(p_run text, p_user text, p_clusters jsonb, p_metrics jsonb default '{}'::jsonb)
returns jsonb
language sql
as $$
  select ai_test.replace_raw(ai_test.id(p_run), ai_test.id(p_user), p_clusters, p_metrics);
$$;

create function ai_test.finish_raw(p_run uuid, p_status text, p_code text, p_metrics jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform public.finish_ai_run(p_run, p_status, p_code, p_metrics);
  return to_jsonb('ok'::text);
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

create function ai_test.finish(p_run text, p_status text, p_code text, p_metrics jsonb default '{}'::jsonb)
returns jsonb
language sql
as $$
  select ai_test.finish_raw(ai_test.id(p_run), p_status, p_code, p_metrics);
$$;

-- One payload cluster from card labels.
create function ai_test.cl(p_name text, p_category text, p_cards text[])
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'name', p_name,
    'category', p_category,
    'card_ids', (select jsonb_agg(ai_test.id(c) order by o) from unnest(p_cards) with ordinality u(c, o))
  );
$$;

create function ai_test.add_card(p_user text, p_category text, p_label text, p_anonymous boolean)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform ai_test.become(p_user);
  select c.id into strict new_id
    from public.create_card(ai_test.id('P1'), p_category, p_label, p_anonymous) c;
  insert into ai_test.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

-- A cluster RPC as the user: "ok", or the error message.
create function ai_test.as_user(p_user text, p_op text, p_a uuid, p_b uuid default null, p_name text default null)
returns text
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform ai_test.become(p_user);
  case p_op
    when 'create' then
      select r.cluster_id into new_id from public.create_cluster(p_a, p_name) r;
      insert into ai_test.ids (label, id) values (p_name, new_id)
      on conflict (label) do update set id = excluded.id;
    when 'rename' then perform 1 from public.rename_cluster(p_a, p_name);
    when 'move' then perform public.move_card(p_a, p_b, null);
    when 'start' then perform 1 from public.start_retrospective(p_a);
    when 'advance' then perform 1 from public.advance_stage(p_a, p_name);
    when 'transfer' then perform public.transfer_facilitator(p_a, p_b);
  end case;
  return 'ok';
exception
  when others then
    return sqlerrm;
end;
$$;

create function ai_test.board(p_user text)
returns jsonb
language plpgsql
as $$
begin
  perform ai_test.become(p_user);
  return public.get_cycle_board(ai_test.id('P1'));
end;
$$;

-- Every clusters, cluster_cards, cycle_events, and cards row of P1 as text.
create function ai_test.state()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select string_agg(to_jsonb(cl)::text, '|' order by cl.id) from public.clusters cl), '')
    || '#'
    || coalesce((select string_agg(to_jsonb(cc)::text, '|' order by cc.card_id) from public.cluster_cards cc), '')
    || '#'
    || coalesce((select string_agg(to_jsonb(e)::text, '|' order by e.id) from public.cycle_events e), '')
    || '#'
    || coalesce((select string_agg(to_jsonb(c)::text, '|' order by c.id) from public.cards c), '');
$$;

-- Every manual cluster and its cards, every column.
create function ai_test.manual_state()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select string_agg(to_jsonb(cl)::text, '|' order by cl.id) from public.clusters cl where cl.source = 'manual'), '')
    || '#'
    || coalesce((select string_agg(to_jsonb(cc)::text, '|' order by cc.card_id) from public.cluster_cards cc join public.clusters cl on cl.id = cc.cluster_id where cl.source = 'manual'), '');
$$;

create function ai_test.mark()
returns void
language sql
security definer
set search_path = ''
as $$
  insert into ai_test.seen (id)
  select e.id from public.cycle_events e
  on conflict do nothing;
$$;

-- The unseen events, without id, cycle_id, and created_at.
create function ai_test.new_events()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) - 'id' - 'cycle_id' - 'created_at' order by e.created_at, e.id),
    '[]'::jsonb
  )
  from public.cycle_events e
  where not exists (select 1 from ai_test.seen s where s.id = e.id);
$$;

create function ai_test.snap(p_label text, p_body jsonb)
returns void
language sql
as $$
  insert into ai_test.snaps (label, body) values (p_label, p_body)
  on conflict (label) do update set body = excluded.body;
$$;

create function ai_test.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.body from ai_test.snaps s where s.label = p_label;
$$;

-- The run row, without its id and timestamps.
create function ai_test.run(p_label text)
returns jsonb
language sql
stable
as $$
  select to_jsonb(r) - 'id' - 'cycle_id' - 'started_at' - 'finished_at'
    from public.ai_runs r
   where r.id = ai_test.id(p_label);
$$;

create function ai_test.cluster(p_name text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object('source', cl.source, 'sort_order', cl.sort_order)
    from public.clusters cl
   where cl.cycle_id = ai_test.id('P1') and cl.name = p_name;
$$;

grant usage on schema ai_test to authenticated, service_role;
grant select, insert, update on all tables in schema ai_test to authenticated, service_role;
grant execute on all functions in schema ai_test to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixture users and projects. The token columns are set to '' as GoTrue does.
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', '1a000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ai-a@example.com', '{"display_name":"Alice"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '1a000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'ai-b@example.com', '{"display_name":"Bob"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '1a000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'ai-c@example.com', '{"display_name":"Cara"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '1a000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'ai-d@example.com', '{"display_name":"Dan"}', '', '', '', '');

insert into public.projects (id, name, owner_id)
values
  ('2a000000-0000-4000-8000-000000000001', 'Project P', '1a000000-0000-4000-8000-000000000001'),
  ('2a000000-0000-4000-8000-000000000002', 'Project Q', '1a000000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('2a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000002', 'member'),
  ('2a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000004', 'member');

-- Q1: C's cycle in cluster with one card, as postgres.
insert into public.feedback_cycles (id, project_id, title, week_start, status, revealed_at)
values ('3a000000-0000-4000-8000-000000000011', '2a000000-0000-4000-8000-000000000002', 'Q one', '2026-10-26', 'cluster', now());
insert into public.cards (id, cycle_id, category, text)
values ('5a000000-0000-4000-8000-000000000011', '3a000000-0000-4000-8000-000000000011', 'start', 'Q card');

-- ---------------------------------------------------------------------------
-- ai_runs: columns, constraints, index, RLS, grants, publication.
-- ---------------------------------------------------------------------------
select columns_are(
  'public', 'ai_runs',
  array['id', 'cycle_id', 'function_name', 'model', 'response_model', 'prompt_version', 'status', 'error_code',
        'provider_called', 'provider_request_id', 'provider_status', 'input_tokens', 'output_tokens', 'duration_ms',
        'card_count', 'cluster_count', 'started_at', 'finished_at'],
  'ai_runs has exactly the run-log columns: no text, prompt, output, name, card id, author, or user id'
);
select col_is_pk('public', 'ai_runs', 'id', 'ai_runs.id is the primary key');
select col_type_is('public', 'ai_runs', 'id', 'uuid', 'ai_runs.id is uuid');
select col_type_is('public', 'ai_runs', 'cycle_id', 'uuid', 'ai_runs.cycle_id is uuid');
select col_type_is('public', 'ai_runs', 'provider_called', 'boolean', 'ai_runs.provider_called is boolean');
select col_default_is('public', 'ai_runs', 'provider_called', 'false', 'provider_called defaults to false');
select is(
  (select c.confdeltype::text || ':' || c.confrelid::regclass::text from pg_constraint c where c.conrelid = 'public.ai_runs'::regclass and c.contype = 'f'),
  'c:feedback_cycles',
  'ai_runs.cycle_id references feedback_cycles on delete cascade'
);
select throws_ok(
  $$insert into public.ai_runs (cycle_id, function_name, model, prompt_version, status) values ('3a000000-0000-4000-8000-000000000011', 'extract-outcomes', 'm', 'v', 'failed')$$,
  '23514', null, 'function_name must be cluster-feedback'
);
select throws_ok(
  $$insert into public.ai_runs (cycle_id, function_name, model, prompt_version, status) values ('3a000000-0000-4000-8000-000000000011', 'cluster-feedback', 'm', 'v', 'done')$$,
  '23514', null, 'status must be running, succeeded, failed, or skipped'
);
select throws_ok(
  $$insert into public.ai_runs (cycle_id, function_name, model, prompt_version, status, error_code) values ('3a000000-0000-4000-8000-000000000011', 'cluster-feedback', 'm', 'v', 'failed', 'Not A Code')$$,
  '23514', null, 'error_code must match ^[a-z_]{1,64}$'
);
select lives_ok(
  $$insert into public.ai_runs (cycle_id, function_name, model, prompt_version, status, error_code) values ('3a000000-0000-4000-8000-000000000011', 'cluster-feedback', 'm', 'v', 'failed', null)$$,
  'error_code may be null'
);
select lives_ok(
  $$insert into public.ai_runs (cycle_id, function_name, model, prompt_version, status) values ('3a000000-0000-4000-8000-000000000011', 'cluster-feedback', 'm', 'v', 'running')$$,
  'one running row per cycle is allowed'
);
select throws_ok(
  $$insert into public.ai_runs (cycle_id, function_name, model, prompt_version, status) values ('3a000000-0000-4000-8000-000000000011', 'cluster-feedback', 'm', 'v', 'running')$$,
  '23505', null, 'a second running row for the same cycle fails with 23505'
);
delete from public.ai_runs where cycle_id = '3a000000-0000-4000-8000-000000000011';

select is((select relrowsecurity from pg_class where oid = 'public.ai_runs'::regclass), true, 'RLS is enabled on ai_runs');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'ai_runs'), 0, 'ai_runs has no policy');
select is(
  (select array_agg(r || ':' || p order by r, p) from unnest(array['anon', 'authenticated', 'service_role']) r cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege(r, 'public.ai_runs', p)),
  array['service_role:INSERT', 'service_role:SELECT', 'service_role:UPDATE'],
  'anon and authenticated have no privilege on ai_runs; service_role has exactly SELECT, INSERT, UPDATE'
);
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'ai_runs'), 0, 'ai_runs is not in supabase_realtime');
select is(
  (select array_agg(r || ':' || p order by r, p) from unnest(array['anon', 'authenticated', 'service_role']) r cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p where has_table_privilege(r, 'private.ai_run_fingerprints', p)),
  null,
  'no API role has any privilege on the private fingerprint table'
);

-- Nothing on the earlier tables or functions changes.
select is(
  (select string_agg(tablename || ':' || policyname, ',' order by tablename, policyname) from pg_policies where schemaname = 'public' and tablename in ('cards', 'card_authors', 'profiles', 'feedback_cycles', 'clusters', 'cluster_cards')),
  'feedback_cycles:feedback_cycles_select_member,profiles:profiles_select_own,profiles:profiles_update_own',
  'no policy is added on cards, card_authors, profiles, feedback_cycles, clusters, or cluster_cards'
);
select is(
  (select string_agg(r || ':' || t || ':' || p, ',' order by r, t, p) from unnest(array['anon', 'authenticated']) r cross join unnest(array['public.cards', 'public.card_authors', 'public.profiles', 'public.feedback_cycles', 'public.clusters', 'public.cluster_cards']) t cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege(r, t, p)),
  'authenticated:public.feedback_cycles:SELECT,authenticated:public.profiles:SELECT',
  'no grant is added on those tables for anon or authenticated'
);
select is((select array_agg(tablename::text order by tablename) from pg_publication_tables where pubname = 'supabase_realtime'), array['cycle_events'], 'supabase_realtime still publishes only cycle_events');
select is((select count(*)::int from information_schema.views where table_schema = 'public'), 0, 'no view is added to public');
select is(
  (select array_agg(p.proname || ':' || md5(p.prosrc) order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('get_cycle_board', 'create_cluster', 'rename_cluster', 'delete_cluster', 'move_card', 'merge_clusters', 'split_cluster')),
  array[
    'create_cluster:6e419da2c54e963084d55378eac06a54',
    'delete_cluster:fe503ba041904b04400473e98a80f85a',
    'get_cycle_board:63317c82ae89c6b9c7851c07bafefbc7',
    'merge_clusters:9927da8d94660c9750277da2cf16b1f3',
    'move_card:37b6cf3190d3a1e70471707305f1be5f',
    'rename_cluster:d5bf8b168f739970d58bb3aa66dc6864',
    'split_cluster:40a570447c337ce2ecb78de171f88032'
  ],
  'get_cycle_board and the six cluster RPCs keep the source of #100''s migration'
);

-- ---------------------------------------------------------------------------
-- RPC hardening.
-- ---------------------------------------------------------------------------
create table ai_test.rpcs (fn regprocedure primary key, name text not null, signature text not null);
insert into ai_test.rpcs (fn, name, signature)
values
  ('public.begin_ai_clustering(uuid, uuid, text, text)', 'begin_ai_clustering', 'p_cycle_id uuid, p_user_id uuid, p_model text, p_prompt_version text -> jsonb'),
  ('public.replace_ai_clusters(uuid, uuid, jsonb, jsonb)', 'replace_ai_clusters', 'p_run_id uuid, p_user_id uuid, p_clusters jsonb, p_metrics jsonb -> jsonb'),
  ('public.finish_ai_run(uuid, text, text, jsonb)', 'finish_ai_run', 'p_run_id uuid, p_status text, p_error_code text, p_metrics jsonb -> void');

select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = r.name), 1, r.name || ' has exactly one overload') from ai_test.rpcs r order by r.name;
select is(pg_get_function_identity_arguments(r.fn) || ' -> ' || pg_get_function_result(r.fn), r.signature, r.name || ' has the agreed arguments and return type') from ai_test.rpcs r order by r.name;
select is((select p.prosecdef and p.provolatile = 'v' and p.proconfig = array['search_path=""']::text[] from pg_proc p where p.oid = r.fn), true, r.name || ' is security definer, volatile, and fixes search_path to empty') from ai_test.rpcs r order by r.name;
select is(
  array[
    has_function_privilege('service_role', r.fn, 'EXECUTE'),
    has_function_privilege('authenticated', r.fn, 'EXECUTE'),
    has_function_privilege('anon', r.fn, 'EXECUTE'),
    (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = r.fn)
  ],
  array[true, false, false, false],
  r.name || ' is executable by service_role only (not PUBLIC, anon, or authenticated)'
) from ai_test.rpcs r order by r.name;
select is((select p.prosrc ~* '(card_authors|profiles|is_anonymous|created_at|updated_at|cycle_events|execute|raise\s+notice)' from pg_proc p where p.oid = r.fn), false, r.name || ' mentions no card_authors, profiles, is_anonymous, created_at, updated_at, cycle_events, execute, or raise notice') from ai_test.rpcs r order by r.name;
select is(
  (select (select count(*) from regexp_matches(p.prosrc, '\mraise\M', 'gi')) = (select count(*) from regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''[a-z_]+'';', 'g')) from pg_proc p where p.oid = r.fn),
  true,
  r.name || ': every raise sets only the code and a stable message, with no detail or hint'
) from ai_test.rpcs r order by r.name;
select is(
  (select array_agg(distinct m.msg[1]::text order by m.msg[1]::text) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'message\s*=\s*''([^'']*)''', 'g') as m(msg) where p.oid = 'public.begin_ai_clustering(uuid, uuid, text, text)'::regprocedure),
  array['ai_run_in_progress', 'ai_run_limit_reached', 'cluster_limit_reached', 'cycle_not_clustering', 'invalid_ai_payload', 'not_project_facilitator', 'not_project_member', 'too_many_cards'],
  'begin_ai_clustering raises only codes from the error table and invalid_ai_payload'
);
select is(
  (select array_agg(distinct m.msg[1]::text order by m.msg[1]::text) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'message\s*=\s*''([^'']*)''', 'g') as m(msg) where p.oid = 'public.replace_ai_clusters(uuid, uuid, jsonb, jsonb)'::regprocedure),
  array['clusters_changed_during_run', 'cycle_not_clustering', 'invalid_ai_payload', 'not_project_facilitator', 'not_project_member', 'run_not_active'],
  'replace_ai_clusters raises only codes from the error table, invalid_ai_payload, and run_not_active'
);
select is(
  (select array_agg(distinct m.msg[1]::text order by m.msg[1]::text) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'message\s*=\s*''([^'']*)''', 'g') as m(msg) where p.oid = 'public.finish_ai_run(uuid, text, text, jsonb)'::regprocedure),
  array['invalid_ai_payload', 'run_not_active'],
  'finish_ai_run raises only invalid_ai_payload and run_not_active'
);
select is(
  (select p.prosrc ~ 'from public\.feedback_cycles fc\s+where fc\.id = \w+\s+for update;' from pg_proc p where p.oid = r.fn),
  true,
  r.name || ' locks the cycle row FOR UPDATE'
) from ai_test.rpcs r where r.name <> 'finish_ai_run' order by r.name;
select is(
  (select
     strpos(p.prosrc, 'from public.projects p where p.id = cycle_project for share') > 0
     and strpos(p.prosrc, 'from public.projects p where p.id = cycle_project for share') < strpos(p.prosrc, 'message = ''not_project_facilitator''')
     and strpos(p.prosrc, 'message = ''not_project_facilitator''') < regexp_instr(p.prosrc, 'from public\.feedback_cycles fc\s+where fc\.id = \w+\s+for update;')
   from pg_proc p where p.oid = r.fn),
  true,
  r.name || ': projects FOR SHARE, then the facilitator check, then the cycle row FOR UPDATE'
) from ai_test.rpcs r where r.name <> 'finish_ai_run' order by r.name;
select is((select p.prosrc ~* 'feedback_cycles|projects' from pg_proc p where p.oid = 'public.finish_ai_run(uuid, text, text, jsonb)'::regprocedure), false, 'finish_ai_run locks only the run row');

-- ---------------------------------------------------------------------------
-- P1 in collecting and reveal: cycle_not_clustering, no row.
-- ---------------------------------------------------------------------------
insert into public.feedback_cycles (id, project_id, title, week_start)
values ('3a000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-000000000001', 'P main', '2026-10-26');
set local role authenticated;
select ai_test.add_card('A', 'start', 's1', false);
select ai_test.add_card('B', 'start', 's2', true);
select ai_test.add_card('D', 'start', 's3', false);
select ai_test.add_card('A', 'start', 'm1', true);
select ai_test.add_card('B', 'stop', 't1', false);
select ai_test.add_card('D', 'stop', 't2', true);
select ai_test.add_card('A', 'stop', 't3', false);
select ai_test.add_card('D', 'continue', 'k1', false);
select ai_test.add_card('B', 'continue', 'k2', true);
reset role;

set local role service_role;
select is(ai_test.begin('P1', 'A'), ai_test.e('cycle_not_clustering'), 'collecting: the facilitator gets cycle_not_clustering');
reset role;
set local role authenticated;
select is(ai_test.as_user('A', 'start', ai_test.id('P1')), 'ok', 'A starts the retrospective');
reset role;
set local role service_role;
select is(ai_test.begin('P1', 'A'), ai_test.e('cycle_not_clustering'), 'reveal: the facilitator gets cycle_not_clustering');
reset role;
set local role authenticated;
select is(ai_test.as_user('A', 'advance', ai_test.id('P1'), p_name => 'reveal'), 'ok', 'A moves P1 to cluster');
-- The manual cluster "process" holds m1.
select is(ai_test.as_user('A', 'create', ai_test.id('P1'), p_name => 'process'), 'ok', 'A creates the manual cluster process');
select is(ai_test.as_user('A', 'move', ai_test.id('m1'), ai_test.id('process')), 'ok', 'A moves m1 into process');
reset role;
-- An AI cluster from an earlier run holds t1 (as postgres: only the RPC writes AI clusters).
insert into public.clusters (id, cycle_id, name, source, sort_order)
values ('4a000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000001', 'Old AI', 'ai', 2);
insert into public.cluster_cards (cycle_id, cluster_id, card_id, sort_order)
values ('3a000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000001', ai_test.id('t1'), 0);
select is((select count(*)::int from public.ai_runs), 0, 'the refused begins inserted no row');

-- ---------------------------------------------------------------------------
-- Refusals in cluster write nothing.
-- ---------------------------------------------------------------------------
select ai_test.snap('state', to_jsonb(ai_test.state()));
set local role service_role;
select is(ai_test.begin('P1', 'B'), ai_test.e('not_project_facilitator'), 'member B gets not_project_facilitator');
select is(ai_test.begin('P1', 'D'), ai_test.e('not_project_facilitator'), 'member D gets not_project_facilitator');
select is(ai_test.begin('P1', 'C'), ai_test.e('not_project_member'), 'non-member C gets not_project_member');
select is(ai_test.begin_raw(ai_test.id('P1'), gen_random_uuid()), ai_test.e('not_project_member'), 'a random user id gets not_project_member');
select is(ai_test.begin_raw(ai_test.id('P1'), null), ai_test.e('not_project_member'), 'a null user id gets not_project_member');
select is(ai_test.begin_raw(gen_random_uuid(), ai_test.id('A')), ai_test.e('not_project_member'), 'a random cycle id gets not_project_member');
select is(ai_test.begin_raw(null, ai_test.id('A')), ai_test.e('not_project_member'), 'a null cycle id gets not_project_member');
select is(ai_test.begin('P1', 'C'), ai_test.begin_raw(gen_random_uuid(), ai_test.id('C')), 'C gets the identical error for an existing and a random cycle');
select is(ai_test.begin_raw(ai_test.id('Q1'), ai_test.id('A')), ai_test.e('not_project_member'), 'A gets not_project_member on another project''s cycle');
reset role;
select is((select count(*)::int from public.ai_runs), 0, 'no refused begin inserted a row');
select is(to_jsonb(ai_test.state()), ai_test.snapped('state'), 'no refused begin changed a cluster, card, or event');

-- ---------------------------------------------------------------------------
-- A begin: the response, available cards, the running row.
-- ---------------------------------------------------------------------------
select ai_test.mark();
set local role service_role;
select ai_test.snap('begin 1', ai_test.start_run('P1', 'A', 'R1'));
reset role;
select is(
  (select array_agg(k order by k) from jsonb_object_keys(ai_test.snapped('begin 1')) k),
  array['cards', 'cluster_slots', 'manual_cluster_names', 'run_id'],
  'begin returns exactly run_id, cards, manual_cluster_names, and cluster_slots'
);
select is(
  (select count(*)::int from jsonb_array_elements(ai_test.snapped('begin 1') -> 'cards') c where (select array_agg(k order by k) from jsonb_object_keys(c) k) <> array['card_id', 'category', 'text']),
  0,
  'every card has exactly card_id, category, and text'
);
select is(
  ai_test.snapped('begin 1') -> 'cards',
  (select jsonb_agg(jsonb_build_object('card_id', c.id, 'category', c.category, 'text', c.text) order by array_position(array['start', 'stop', 'continue'], c.category), c.id)
     from public.cards c where c.cycle_id = ai_test.id('P1') and c.id <> ai_test.id('m1')),
  'cards are every card that is ungrouped or in an AI cluster, ordered by category (start, stop, continue), then card_id'
);
select is(
  (select array_agg(c ->> 'category' order by o) from jsonb_array_elements(ai_test.snapped('begin 1') -> 'cards') with ordinality x(c, o)),
  array['start', 'start', 'start', 'stop', 'stop', 'stop', 'continue', 'continue'],
  'start cards come first, then stop, then continue'
);
select is(
  array[
    (ai_test.snapped('begin 1') -> 'cards') @> jsonb_build_array(jsonb_build_object('card_id', ai_test.id('t1'))),
    (ai_test.snapped('begin 1') -> 'cards') @> jsonb_build_array(jsonb_build_object('card_id', ai_test.id('s1'))),
    (ai_test.snapped('begin 1') -> 'cards') @> jsonb_build_array(jsonb_build_object('card_id', ai_test.id('m1')))
  ],
  array[true, true, false],
  'the card in the AI cluster and an ungrouped card are available; the card in the manual cluster is not'
);
select is(ai_test.snapped('begin 1') -> 'manual_cluster_names', '["process"]'::jsonb, 'manual_cluster_names lists the manual cluster');
select is(ai_test.snapped('begin 1') -> 'cluster_slots', '49'::jsonb, 'cluster_slots is 50 minus the manual cluster count');
select is(
  ai_test.run('R1'),
  jsonb_build_object(
    'function_name', 'cluster-feedback', 'model', 'claude-opus-5-5', 'response_model', null, 'prompt_version', 'cluster-feedback/v1',
    'status', 'running', 'error_code', null, 'provider_called', false, 'provider_request_id', null, 'provider_status', null,
    'input_tokens', null, 'output_tokens', null, 'duration_ms', null, 'card_count', 8, 'cluster_count', null
  ),
  'a running row exists with the model and prompt version passed in, card_count, and provider_called false'
);

-- ---------------------------------------------------------------------------
-- In progress and abandoned runs.
-- ---------------------------------------------------------------------------
set local role service_role;
select is(ai_test.begin('P1', 'A'), ai_test.e('ai_run_in_progress'), 'a second begin while the first run is running gets ai_run_in_progress');
reset role;
select is((select count(*)::int from public.ai_runs), 1, 'the refused second begin inserted no row');
update public.ai_runs set started_at = now() - interval '6 minutes' where id = ai_test.id('R1');
set local role service_role;
select is(ai_test.start_run('P1', 'A', 'R2') ? 'run_id', true, 'a begin after 5 minutes starts a new run');
reset role;
select is(ai_test.run('R1') ->> 'status' || '/' || (ai_test.run('R1') ->> 'error_code'), 'failed/run_abandoned', 'the old run is marked failed with run_abandoned');
select is(ai_test.run('R2') ->> 'status', 'running', 'the new run is running');
select is(ai_test.new_events(), '[]'::jsonb, 'begin records no event');

-- ---------------------------------------------------------------------------
-- A successful replace.
-- ---------------------------------------------------------------------------
select ai_test.snap('manual', to_jsonb(ai_test.manual_state()));
select ai_test.snap('cards', (select jsonb_agg(to_jsonb(c) order by c.id) from public.cards c));
select ai_test.mark();
set local role service_role;
select is(
  ai_test.replace('R2', 'A',
    jsonb_build_array(ai_test.cl('Tools', 'start', array['s2', 's1']), ai_test.cl('Blockers', 'stop', array['t1', 't3', 't2'])),
    '{"provider_called": true, "response_model": "claude-opus-5-5", "provider_request_id": "req_test_1", "provider_status": 200, "input_tokens": 1200, "output_tokens": 300, "duration_ms": 4321, "cluster_count": 2}'),
  '{"cluster_count": 2, "clustered_card_count": 5}'::jsonb,
  'replace with two clusters succeeds and returns the counts'
);
reset role;
select is((select count(*)::int from public.clusters where id = ai_test.id('Old AI')), 0, 'the old AI cluster is deleted');
select is(
  array[ai_test.cluster('Tools'), ai_test.cluster('Blockers')],
  array['{"source": "ai", "sort_order": 2}'::jsonb, '{"source": "ai", "sort_order": 3}'::jsonb],
  'the new clusters are ai, appended after the max sort_order of the remaining clusters in payload order'
);
select is(
  (select array_agg(c.text || ':' || cc.sort_order order by cl.sort_order, cc.sort_order) from public.cluster_cards cc join public.clusters cl on cl.id = cc.cluster_id join public.cards c on c.id = cc.card_id where cl.source = 'ai'),
  array['s2:0', 's1:1', 't1:0', 't3:1', 't2:2'],
  'cluster_cards.sort_order is 0 ... n-1 in payload order'
);
select is(
  ai_test.run('R2'),
  jsonb_build_object(
    'function_name', 'cluster-feedback', 'model', 'claude-opus-5-5', 'response_model', 'claude-opus-5-5', 'prompt_version', 'cluster-feedback/v1',
    'status', 'succeeded', 'error_code', null, 'provider_called', true, 'provider_request_id', 'req_test_1', 'provider_status', 200,
    'input_tokens', 1200, 'output_tokens', 300, 'duration_ms', 4321, 'card_count', 8, 'cluster_count', 2
  ),
  'the run is succeeded with the metrics'
);
select is((select finished_at is not null from public.ai_runs where id = ai_test.id('R2')), true, 'the run has finished_at');
select is(to_jsonb(ai_test.manual_state()), ai_test.snapped('manual'), 'every manual cluster row and its cluster_cards rows are byte-identical');
select is((select jsonb_agg(to_jsonb(c) order by c.id) from public.cards c), ai_test.snapped('cards'), 'no card row changes');
select is(
  (select count(*)::int from public.cluster_cards cc where cc.card_id in (ai_test.id('s3'), ai_test.id('k1'), ai_test.id('k2'))),
  0,
  'cards not in the payload are ungrouped'
);
set local role authenticated;
select is(
  (select jsonb_agg(jsonb_build_object('name', c ->> 'name', 'source', c ->> 'source', 'cards', jsonb_array_length(c -> 'card_ids'))) from jsonb_array_elements(ai_test.board('B') -> 'clusters') c),
  '[{"name": "process", "source": "manual", "cards": 1}, {"name": "Tools", "source": "ai", "cards": 2}, {"name": "Blockers", "source": "ai", "cards": 3}]'::jsonb,
  'get_cycle_board shows the new AI clusters after the manual one'
);
reset role;
select is(jsonb_array_length(ai_test.new_events()) >= 1, true, 'a successful replace records at least one event');
select is(
  (select count(*)::int from jsonb_array_elements(ai_test.new_events()) e where e is distinct from jsonb_build_object('type', 'clusters_changed', 'from_status', 'cluster', 'to_status', 'cluster', 'actor_id', null, 'payload', '{}'::jsonb)),
  0,
  'every event is clusters_changed with actor_id null and payload {}, and none is stage_changed'
);

-- Replaying a finished run, and an unknown run.
set local role service_role;
select is(ai_test.replace('R2', 'A', '[]'), ai_test.e('run_not_active'), 'replaying a succeeded run gets run_not_active');
select is(ai_test.replace('R1', 'A', '[]'), ai_test.e('run_not_active'), 'replace on an abandoned run gets run_not_active');
select is(ai_test.replace_raw(gen_random_uuid(), ai_test.id('A'), '[]'), ai_test.e('run_not_active'), 'replace on an unknown run gets run_not_active');
reset role;

-- ---------------------------------------------------------------------------
-- Suffixes.
-- ---------------------------------------------------------------------------
set local role service_role;
select ai_test.start_run('P1', 'A', 'R3');
select is(
  ai_test.replace('R3', 'A', jsonb_build_array(
    ai_test.cl('Process', 'start', array['s1']),
    ai_test.cl('Tools', 'start', array['s2']),
    ai_test.cl('  Tools ', 'stop', array['t1']),
    ai_test.cl(repeat('L', 100), 'stop', array['t2']),
    ai_test.cl(repeat('l', 100), 'continue', array['k1'])
  ), '{"provider_called": true}') ->> 'cluster_count',
  '5',
  'replace with clashing names succeeds'
);
reset role;
select is(
  (select array_agg(cl.name order by cl.sort_order) from public.clusters cl where cl.cycle_id = ai_test.id('P1') and cl.source = 'ai'),
  array['Process (2)', 'Tools', 'Tools (2)', repeat('L', 100), repeat('l', 96) || ' (2)'],
  'Process next to manual process becomes Process (2); two Tools become Tools and Tools (2); a clashing 100-character name is cut to fit " (2)"'
);
select is((select max(char_length(cl.name)) from public.clusters cl where cl.cycle_id = ai_test.id('P1')), 100, 'the cut name is exactly 100 characters');

-- An empty payload deletes the AI clusters and keeps the manual ones.
select ai_test.mark();
set local role service_role;
select ai_test.start_run('P1', 'A', 'R4');
select is(ai_test.replace('R4', 'A', '[]', '{"provider_called": true}'), '{"cluster_count": 0, "clustered_card_count": 0}'::jsonb, 'an empty payload succeeds with cluster_count 0');
reset role;
select is((select array_agg(cl.name order by cl.sort_order) from public.clusters cl where cl.cycle_id = ai_test.id('P1')), array['process'], 'the AI clusters are gone and the manual one stays');
select is(ai_test.run('R4') ->> 'status' || '/' || (ai_test.run('R4') ->> 'cluster_count'), 'succeeded/0', 'the empty run is succeeded with cluster_count 0');
select is(to_jsonb(ai_test.manual_state()), ai_test.snapped('manual'), 'the manual cluster is still byte-identical');

-- With a manual "Tools (2)", two AI Tools become Tools and Tools (3).
set local role authenticated;
select is(ai_test.as_user('A', 'create', ai_test.id('P1'), p_name => 'Tools (2)'), 'ok', 'A creates the manual cluster Tools (2)');
reset role;
set local role service_role;
select ai_test.start_run('P1', 'A', 'R5');
select is(
  ai_test.replace('R5', 'A', jsonb_build_array(ai_test.cl('Tools', 'start', array['s1']), ai_test.cl('tools', 'stop', array['t1'])), '{"provider_called": true}') ->> 'cluster_count',
  '2',
  'replace succeeds next to Tools (2)'
);
reset role;
select is(
  (select array_agg(cl.name order by cl.sort_order) from public.clusters cl where cl.cycle_id = ai_test.id('P1') and cl.source = 'ai'),
  array['Tools', 'tools (3)'],
  'with Tools (2) taken, the second Tools gets the lowest free suffix (3)'
);

-- ---------------------------------------------------------------------------
-- Stale and race checks: each writes nothing and leaves the run running.
-- ---------------------------------------------------------------------------
-- A create_cluster by the facilitator between begin and replace.
set local role service_role;
select ai_test.start_run('P1', 'A', 'S1');
reset role;
set local role authenticated;
select ai_test.as_user('A', 'create', ai_test.id('P1'), p_name => 'Fresh') = 'ok' as done;
reset role;
select ai_test.snap('state', to_jsonb(ai_test.state()));
set local role service_role;
select is(ai_test.replace('S1', 'A', jsonb_build_array(ai_test.cl('New', 'start', array['s3']))), ai_test.e('clusters_changed_during_run'), 'a create_cluster during the run gives clusters_changed_during_run');
reset role;
select is(to_jsonb(ai_test.state()), ai_test.snapped('state'), 'the stale replace wrote nothing');
select is(ai_test.run('S1') ->> 'status', 'running', 'the stale replace leaves the run running');
set local role service_role;
select is(ai_test.finish('S1', 'failed', 'clusters_changed_during_run', '{"provider_called": true}'), to_jsonb('ok'::text), 'the caller fails the stale run');
reset role;

-- A move_card by the facilitator.
set local role service_role;
select ai_test.start_run('P1', 'A', 'S2');
reset role;
set local role authenticated;
select ai_test.as_user('A', 'move', ai_test.id('k2'), ai_test.id('Fresh')) = 'ok' as done;
reset role;
select ai_test.snap('state', to_jsonb(ai_test.state()));
set local role service_role;
select is(ai_test.replace('S2', 'A', '[]'), ai_test.e('clusters_changed_during_run'), 'a move_card during the run gives clusters_changed_during_run');
reset role;
select is(to_jsonb(ai_test.state()) || to_jsonb(ai_test.run('S2') ->> 'status'), ai_test.snapped('state') || to_jsonb('running'::text), 'the stale replace wrote nothing and the run is still running');
set local role service_role;
select ai_test.finish('S2', 'failed', 'clusters_changed_during_run');
reset role;

-- A rename of an AI cluster by the facilitator (it becomes manual).
set local role service_role;
select ai_test.start_run('P1', 'A', 'S3');
reset role;
insert into ai_test.ids (label, id)
select 'tools (3)', cl.id from public.clusters cl where cl.cycle_id = ai_test.id('P1') and cl.name = 'tools (3)';
set local role authenticated;
select ai_test.as_user('A', 'rename', ai_test.id('tools (3)'), p_name => 'Renamed AI') = 'ok' as done;
reset role;
select ai_test.snap('state', to_jsonb(ai_test.state()));
set local role service_role;
select is(ai_test.replace('S3', 'A', '[]'), ai_test.e('clusters_changed_during_run'), 'a rename of an AI cluster during the run gives clusters_changed_during_run');
reset role;
select is(to_jsonb(ai_test.state()) || to_jsonb(ai_test.run('S3') ->> 'status'), ai_test.snapped('state') || to_jsonb('running'::text), 'the stale replace wrote nothing and the run is still running');
set local role service_role;
select ai_test.finish('S3', 'failed', 'clusters_changed_during_run');
reset role;

-- A rename of a manual cluster is not stale.
set local role service_role;
select ai_test.start_run('P1', 'A', 'S4');
reset role;
set local role authenticated;
select ai_test.as_user('A', 'rename', ai_test.id('Fresh'), p_name => 'Fresh renamed') = 'ok' as done;
reset role;
set local role service_role;
select is(ai_test.replace('S4', 'A', jsonb_build_array(ai_test.cl('Fresh renamed', 'start', array['s3']))) ->> 'cluster_count', '1', 'a rename of a manual cluster during the run is not stale');
reset role;
select is(
  (select array_agg(cl.name order by cl.sort_order) from public.clusters cl where cl.cycle_id = ai_test.id('P1') and cl.source = 'ai'),
  array['Fresh renamed (2)'],
  'the new manual name is re-read under the lock for suffixing'
);

-- The role moves to B during the run.
set local role service_role;
select ai_test.start_run('P1', 'A', 'S5');
reset role;
set local role authenticated;
select is(ai_test.as_user('A', 'transfer', ai_test.id('P'), ai_test.id('B')), 'ok', 'A makes B the facilitator');
reset role;
select ai_test.snap('state', to_jsonb(ai_test.state()));
set local role service_role;
select is(ai_test.replace('S5', 'A', '[]'), ai_test.e('not_project_facilitator'), 'after the role moves to B, replace for A gets not_project_facilitator');
select is(ai_test.begin('P1', 'A'), ai_test.e('not_project_facilitator'), 'the former facilitator cannot begin a run');
reset role;
select is(to_jsonb(ai_test.state()) || to_jsonb(ai_test.run('S5') ->> 'status'), ai_test.snapped('state') || to_jsonb('running'::text), 'the refused replace wrote nothing and the run is still running');
set local role authenticated;
select ai_test.as_user('A', 'transfer', ai_test.id('P'), ai_test.id('A')) = 'ok' as done;
reset role;
set local role service_role;
select ai_test.finish('S5', 'failed', 'not_project_facilitator');
reset role;

-- ---------------------------------------------------------------------------
-- Skipped runs.
-- ---------------------------------------------------------------------------
set local role service_role;
select ai_test.start_run('P1', 'A', 'R6');
select is(ai_test.replace('R6', 'A', jsonb_build_array(ai_test.cl('X', 'start', array['s3'])), '{"status": "skipped"}'), ai_test.e('invalid_ai_payload'), 'a skipped run with clusters is invalid_ai_payload');
select is(ai_test.replace('R6', 'A', '[]', '{"status": "skipped", "duration_ms": 3}') ->> 'cluster_count', '0', 'a skipped run with an empty payload succeeds');
reset role;
select is(ai_test.run('R6') ->> 'status' || '/' || (ai_test.run('R6') ->> 'provider_called'), 'skipped/false', 'the run is recorded skipped without a provider call');

-- ---------------------------------------------------------------------------
-- invalid_ai_payload: nothing is written.
-- ---------------------------------------------------------------------------
set local role service_role;
select ai_test.start_run('P1', 'A', 'V1');
reset role;
select ai_test.snap('state', to_jsonb(ai_test.state()));
select ai_test.mark();
set local role service_role;
select is(ai_test.replace('V1', 'A', jsonb_build_array(ai_test.cl('Q', 'start', array['q card']))), ai_test.e('invalid_ai_payload'), 'a card of another cycle is invalid_ai_payload');
select is(ai_test.replace('V1', 'A', jsonb_build_array(ai_test.cl('M', 'start', array['m1']))), ai_test.e('invalid_ai_payload'), 'a card in a manual cluster is invalid_ai_payload');
select is(ai_test.replace('V1', 'A', jsonb_build_array(ai_test.cl('Twice', 'start', array['s1', 's1']))), ai_test.e('invalid_ai_payload'), 'a card twice in one cluster is invalid_ai_payload');
select is(ai_test.replace('V1', 'A', jsonb_build_array(ai_test.cl('One', 'start', array['s1']), ai_test.cl('Two', 'start', array['s1']))), ai_test.e('invalid_ai_payload'), 'a card in two clusters is invalid_ai_payload');
select is(ai_test.replace('V1', 'A', jsonb_build_array(ai_test.cl(E' \t\n ', 'start', array['s1']))), ai_test.e('invalid_ai_payload'), 'a name that is empty after trimming is invalid_ai_payload');
select is(ai_test.replace('V1', 'A', jsonb_build_array(ai_test.cl(E'Line\none', 'start', array['s1']))), ai_test.e('invalid_ai_payload'), 'a name with a control character is invalid_ai_payload');
select is(ai_test.replace('V1', 'A', jsonb_build_array(ai_test.cl(repeat('x', 101), 'start', array['s1']))), ai_test.e('invalid_ai_payload'), 'a 101-character name is invalid_ai_payload');
select is(ai_test.replace('V1', 'A', jsonb_build_array(ai_test.cl('Mixed', 'start', array['s1', 't1']))), ai_test.e('invalid_ai_payload'), 'a card of another category is invalid_ai_payload');
select is(ai_test.replace('V1', 'A', jsonb_build_array(jsonb_build_object('name', 'Empty', 'category', 'start', 'card_ids', '[]'::jsonb))), ai_test.e('invalid_ai_payload'), 'an empty cluster is invalid_ai_payload');
select is(ai_test.replace('V1', 'A', jsonb_build_array(jsonb_build_object('name', 'Bad', 'category', 'start', 'card_ids', '["not-a-uuid"]'::jsonb))), ai_test.e('invalid_ai_payload'), 'a card id that is not a UUID is invalid_ai_payload');
select is(ai_test.replace('V1', 'A', jsonb_build_array(ai_test.cl('Extra', 'start', array['s1']) || '{"refs": []}')), ai_test.e('invalid_ai_payload'), 'an extra key is invalid_ai_payload');
select is(
  ai_test.replace('V1', 'A', (select jsonb_agg(ai_test.cl('Slot ' || i, 'start', array['s1'])) from generate_series(1, 48) i)),
  ai_test.e('invalid_ai_payload'),
  'more clusters than the 47 slots left is invalid_ai_payload'
);
select is(ai_test.replace('V1', 'A', '{}'), ai_test.e('invalid_ai_payload'), 'a payload that is not an array is invalid_ai_payload');
select is(ai_test.replace('V1', 'A', '[]', '{"user_id": "x"}'), ai_test.e('invalid_ai_payload'), 'an unknown metrics key is invalid_ai_payload');
reset role;
select is(to_jsonb(ai_test.state()), ai_test.snapped('state'), 'no invalid payload changed a cluster, card, or event');
select is(ai_test.new_events(), '[]'::jsonb, 'the failed replaces recorded no event');
select is(ai_test.run('V1') ->> 'status', 'running', 'the run is still running');

-- ---------------------------------------------------------------------------
-- finish_ai_run.
-- ---------------------------------------------------------------------------
set local role service_role;
select is(ai_test.finish('V1', 'running', null), ai_test.e('invalid_ai_payload'), 'finish_ai_run refuses the status running');
select is(ai_test.finish('V1', 'failed', null), ai_test.e('invalid_ai_payload'), 'finish_ai_run refuses failed without an error code');
select is(
  ai_test.finish('V1', 'failed', 'ai_unavailable', '{"provider_called": true, "provider_status": 529, "provider_request_id": "req_test_2", "duration_ms": 61000}'),
  to_jsonb('ok'::text),
  'finish_ai_run fails a running run'
);
reset role;
select is(
  ai_test.run('V1'),
  jsonb_build_object(
    'function_name', 'cluster-feedback', 'model', 'claude-opus-5-5', 'response_model', null, 'prompt_version', 'cluster-feedback/v1',
    'status', 'failed', 'error_code', 'ai_unavailable', 'provider_called', true, 'provider_request_id', 'req_test_2', 'provider_status', 529,
    'input_tokens', null, 'output_tokens', null, 'duration_ms', 61000, 'card_count', ai_test.run('V1') -> 'card_count', 'cluster_count', null
  ),
  'finish_ai_run sets status, error_code, and the metrics'
);
select is((select finished_at is not null from public.ai_runs where id = ai_test.id('V1')), true, 'finish_ai_run sets finished_at');
set local role service_role;
select is(ai_test.finish('V1', 'failed', 'internal_error'), ai_test.e('run_not_active'), 'finish_ai_run on a finished run gets run_not_active');
select is(ai_test.finish_raw(gen_random_uuid(), 'failed', 'internal_error'), ai_test.e('run_not_active'), 'finish_ai_run on an unknown run gets run_not_active');
reset role;
select is(ai_test.new_events(), '[]'::jsonb, 'finish_ai_run records no event');

-- ---------------------------------------------------------------------------
-- Limits on Q1: 301 available cards, 50 manual clusters, 20 model runs.
-- ---------------------------------------------------------------------------
insert into public.cards (cycle_id, category, text)
select ai_test.id('Q1'), 'stop', 'bulk card ' || i from generate_series(1, 300) i;
set local role service_role;
select is(ai_test.begin('Q1', 'C'), ai_test.e('too_many_cards'), '301 available cards give too_many_cards');
reset role;
insert into public.clusters (cycle_id, name, sort_order)
select ai_test.id('Q1'), 'Manual ' || i, i from generate_series(1, 50) i;
set local role service_role;
select is(ai_test.begin('Q1', 'C'), ai_test.e('cluster_limit_reached'), '50 manual clusters give cluster_limit_reached');
reset role;
insert into public.ai_runs (cycle_id, function_name, model, prompt_version, status, provider_called)
select ai_test.id('Q1'), 'cluster-feedback', 'claude-opus-5-5', 'cluster-feedback/v1', case when i % 2 = 0 then 'succeeded' else 'failed' end, true
  from generate_series(1, 19) i;
insert into public.ai_runs (cycle_id, function_name, model, prompt_version, status, provider_called)
select ai_test.id('Q1'), 'cluster-feedback', 'claude-opus-5-5', 'cluster-feedback/v1', s, false
  from unnest(array['skipped', 'skipped', 'failed']) s;
set local role service_role;
select is(ai_test.begin('Q1', 'C'), ai_test.e('cluster_limit_reached'), '19 model runs plus skipped and uncalled runs do not reach the run limit');
reset role;
insert into public.ai_runs (cycle_id, function_name, model, prompt_version, status, provider_called)
values (ai_test.id('Q1'), 'cluster-feedback', 'claude-opus-5-5', 'cluster-feedback/v1', 'failed', true);
set local role service_role;
select is(ai_test.begin('Q1', 'C'), ai_test.e('ai_run_limit_reached'), '20 runs that reached the model give ai_run_limit_reached');
reset role;
select is((select count(*)::int from public.ai_runs where cycle_id = ai_test.id('Q1') and status = 'running'), 0, 'no limit refusal inserted a running row');

-- ---------------------------------------------------------------------------
-- Stage change during a run, then the later stages.
-- ---------------------------------------------------------------------------
set local role service_role;
select ai_test.start_run('P1', 'A', 'S6');
reset role;
set local role authenticated;
select is(ai_test.as_user('A', 'advance', ai_test.id('P1'), p_name => 'cluster'), 'ok', 'A moves P1 to vote during the run');
reset role;
select ai_test.snap('state', to_jsonb(ai_test.state()));
set local role service_role;
select is(ai_test.replace('S6', 'A', '[]'), ai_test.e('cycle_not_clustering'), 'after advance_stage to vote, replace gets cycle_not_clustering');
select is(ai_test.finish('S6', 'failed', 'cycle_not_clustering'), to_jsonb('ok'::text), 'the caller fails the run');
select is(ai_test.begin('P1', 'A'), ai_test.e('cycle_not_clustering'), 'vote: begin gets cycle_not_clustering');
reset role;
select is(to_jsonb(ai_test.state()), ai_test.snapped('state'), 'the refused replace and begin wrote nothing');
update public.feedback_cycles set status = 'discuss', voting_closed_at = now() where id = ai_test.id('P1');
set local role service_role;
select is(ai_test.begin('P1', 'A'), ai_test.e('cycle_not_clustering'), 'discuss: begin gets cycle_not_clustering');
reset role;
update public.feedback_cycles set status = 'closed', closed_at = now() where id = ai_test.id('P1');
set local role service_role;
select is(ai_test.begin('P1', 'A'), ai_test.e('cycle_not_clustering'), 'closed: begin gets cycle_not_clustering');
reset role;
select is((select count(*)::int from public.ai_runs where cycle_id = ai_test.id('P1') and status = 'running'), 0, 'no refused begin inserted a row');

select * from finish();
rollback;
