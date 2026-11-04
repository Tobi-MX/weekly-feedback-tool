-- pgTAP tests for #24: close_voting, the automatic close at the end of
-- cast_vote (private.close_voting_if_complete), the voting_closed_at CHECK
-- and guard, and the actor rule for vote -> discuss events.
--
-- Everything runs in one transaction and is rolled back at the end. The seed
-- user is never used as a fixture. now() is the transaction time, so every
-- voting_closed_at set here has the same value; the RLS suite checks
-- idempotency across real transactions.
--
-- Fixtures: owner and facilitator A, members B and D, non-member C, E (joins
-- P during vote in P7), and S (the only member of project S). P is A's with B
-- and D joined; Q is C's with Q1 in vote; W is C's and holds the invariant
-- cycles written as postgres. P's cycles run one after another, each closed
-- before the next is created:
--   P1  auto-close by an interleaved series, with clusters X, Y (cards), Empty
--       (no cards), and AI (source ai); then close_cycle from discuss
--   P2  no early close, and a remove + re-cast at 3
--   P3  access, and the facilitator's close with B at 1 vote and D at 0
--   P4  all-zero close
--   P5  zero clusters
--   P6  close_voting in every wrong stage, and close_cycle from vote
--   P7  a member joins during vote
--   P8  a voter's auth user is deleted while holding 3 votes

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(121);

-- ---------------------------------------------------------------------------
-- Test-only helpers.
-- ---------------------------------------------------------------------------
create schema cv;

create table cv.ids (label text primary key, id uuid not null);
create table cv.snaps (label text primary key, body jsonb);

insert into cv.ids (label, id)
values
  ('A', 'cc000000-0000-4000-8000-000000000001'),
  ('B', 'cc000000-0000-4000-8000-000000000002'),
  ('C', 'cc000000-0000-4000-8000-000000000003'),
  ('D', 'cc000000-0000-4000-8000-000000000004'),
  ('E', 'cc000000-0000-4000-8000-000000000005'),
  ('S', 'cc000000-0000-4000-8000-000000000006'),
  ('P', 'cd000000-0000-4000-8000-000000000001'),
  ('Q', 'cd000000-0000-4000-8000-000000000002'),
  ('PS', 'cd000000-0000-4000-8000-000000000003'),
  ('W', 'cd000000-0000-4000-8000-000000000004'),
  ('Q1', 'ce000000-0000-4000-8000-000000000011'),
  ('random', 'cf000000-0000-4000-8000-000000000099');

create function cv.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from cv.ids i where i.label = p_label;
$$;

create function cv.label(p_id uuid)
returns text
language sql
stable
as $$
  select coalesce((select i.label from cv.ids i where i.id = p_id order by i.label limit 1), 'null');
$$;

create function cv.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', cv.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- The error a refused call gets, with empty detail and hint.
create function cv.e(p_message text)
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

-- close_voting as the user with a raw id: the returned rows, or the error.
create function cv.close_raw(p_user text, p_cycle uuid)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform cv.become(p_user);
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into result from public.close_voting(p_cycle) r;
  return result;
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

create function cv.close(p_user text, p_cycle text)
returns jsonb
language sql
as $$
  select cv.close_raw(p_user, cv.id(p_cycle));
$$;

-- cast_vote or remove_vote: [vote_count, votes_remaining], or the error.
create function cv.vote(p_fn text, p_user text, p_cycle text, p_cluster text)
returns jsonb
language plpgsql
as $$
declare
  r record;
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform cv.become(p_user);
  if p_fn = 'cast' then
    select * into strict r from public.cast_vote(cv.id(p_cycle), cv.id(p_cluster));
  else
    select * into strict r from public.remove_vote(cv.id(p_cycle), cv.id(p_cluster));
  end if;
  return jsonb_build_array(r.vote_count, r.votes_remaining);
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

create function cv.cast(p_user text, p_cycle text, p_cluster text)
returns jsonb
language sql
as $$
  select cv.vote('cast', p_user, p_cycle, p_cluster);
$$;

create function cv.remove(p_user text, p_cycle text, p_cluster text)
returns jsonb
language sql
as $$
  select cv.vote('remove', p_user, p_cycle, p_cluster);
$$;

-- get_vote_totals as the user: [[cluster label, total], ...] in returned
-- order, or the error.
create function cv.totals(p_user text, p_cycle text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform cv.become(p_user);
  select coalesce(jsonb_agg(jsonb_build_array(cv.label(t.cluster_id), t.total_votes) order by t.n), '[]'::jsonb)
    into result
    from public.get_vote_totals(cv.id(p_cycle)) with ordinality t(cluster_id, total_votes, n);
  return result;
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

-- A new collecting cycle of a project, written as the table owner.
create function cv.new_cycle(p_label text, p_project text, p_week date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid := gen_random_uuid();
begin
  insert into public.feedback_cycles (id, project_id, title, week_start)
  values (new_id, cv.id(p_project), p_label, p_week);
  insert into cv.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

create function cv.start(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform cv.become(p_user);
  perform 1 from public.start_retrospective(cv.id(p_cycle));
end;
$$;

create function cv.advance(p_user text, p_cycle text, p_from text)
returns void
language plpgsql
as $$
begin
  perform cv.become(p_user);
  perform 1 from public.advance_stage(cv.id(p_cycle), p_from);
end;
$$;

-- A cluster made through #17's create_cluster, labelled p_cycle || '.' || name.
create function cv.mk(p_user text, p_cycle text, p_name text)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform cv.become(p_user);
  select r.cluster_id into strict new_id from public.create_cluster(cv.id(p_cycle), p_name) r;
  insert into cv.ids (label, id) values (p_cycle || '.' || p_name, new_id);
  return new_id;
end;
$$;

-- A new cycle of a project taken to vote by its facilitator, with the named
-- clusters (no cards).
create function cv.to_vote(p_user text, p_cycle text, p_project text, p_week date, p_clusters text[])
returns void
language plpgsql
as $$
declare
  name text;
begin
  perform cv.new_cycle(p_cycle, p_project, p_week);
  perform cv.start(p_user, p_cycle);
  perform cv.advance(p_user, p_cycle, 'reveal');
  foreach name in array p_clusters loop
    perform cv.mk(p_user, p_cycle, name);
  end loop;
  perform cv.advance(p_user, p_cycle, 'cluster');
end;
$$;

create function cv.close_cycle(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform cv.become(p_user);
  perform 1 from public.close_cycle(cv.id(p_cycle));
end;
$$;

create function cv.transfer(p_user text, p_to text)
returns void
language plpgsql
as $$
begin
  perform cv.become(p_user);
  perform public.transfer_facilitator(cv.id('P'), cv.id(p_to));
end;
$$;

create function cv.join(p_user text)
returns void
language plpgsql
as $$
declare
  invite text;
begin
  perform cv.become('A');
  invite := (select i.token from public.create_project_invite(cv.id('P')) i);
  perform cv.become(p_user);
  perform 1 from public.join_project(invite);
end;
$$;

create function cv.snap(p_label text, p_body jsonb)
returns void
language sql
as $$
  insert into cv.snaps (label, body) values (p_label, p_body)
  on conflict (label) do update set body = excluded.body;
$$;

create function cv.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.body from cv.snaps s where s.label = p_label;
$$;

-- Read-back helpers, security definer so they see every row.
create function cv.status(p_cycle text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select fc.status from public.feedback_cycles fc where fc.id = cv.id(p_cycle);
$$;

create function cv.vca(p_cycle text)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select fc.voting_closed_at from public.feedback_cycles fc where fc.id = cv.id(p_cycle);
$$;

create function cv.nevents(p_cycle text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.cycle_events e where e.cycle_id = cv.id(p_cycle);
$$;

-- The cycle's stage_changed events as from>to:actor, in stage order (one
-- per stage).
create function cv.events(p_cycle text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(e.from_status || '>' || e.to_status || ':' || cv.label(e.actor_id)
                            order by array_position(array['collecting', 'reveal', 'cluster', 'vote', 'discuss', 'closed'], e.from_status)),
                  '{}'::text[])
    from public.cycle_events e
   where e.cycle_id = cv.id(p_cycle)
     and e.type = 'stage_changed';
$$;

-- The cycle's vote -> discuss events, each as the agreed shape.
create function cv.close_events(p_cycle text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('type', e.type, 'from_status', e.from_status, 'to_status', e.to_status, 'actor_id', e.actor_id, 'payload', e.payload)), '[]'::jsonb)
    from public.cycle_events e
   where e.cycle_id = cv.id(p_cycle)
     and e.to_status = 'discuss';
$$;

-- Status, voting_closed_at, and event count, for "a call changed nothing" checks.
create function cv.state(p_cycle text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'row', (select md5(pg_catalog.to_jsonb(fc)::text) from public.feedback_cycles fc where fc.id = cv.id(p_cycle)),
    'events', cv.nevents(p_cycle)
  );
$$;

create function cv.cycles_md5()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(coalesce(string_agg(pg_catalog.to_jsonb(fc)::text, '|' order by fc.id), '')) from public.feedback_cycles fc;
$$;

-- The cycle row without the three columns a close may change.
create function cv.cycle_rest(p_cycle text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.to_jsonb(fc) - 'status' - 'voting_closed_at' - 'updated_at' from public.feedback_cycles fc where fc.id = cv.id(p_cycle);
$$;

create function cv.others_md5()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(
    coalesce((select string_agg(pg_catalog.to_jsonb(pm)::text, '|' order by pm.project_id, pm.user_id) from public.project_members pm), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(cl)::text, '|' order by cl.id) from public.clusters cl), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(cc)::text, '|' order by cc.card_id) from public.cluster_cards cc), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(v)::text, '|' order by v.id) from public.votes v), '')
  );
$$;

-- A cast that is expected not to close: its result, then the state after it.
create function cv.cast_open(p_user text, p_cycle text, p_cluster text)
returns jsonb
language plpgsql
as $$
declare
  before_events integer := cv.nevents(p_cycle);
  result jsonb := cv.cast(p_user, p_cycle, p_cluster);
begin
  return jsonb_build_object(
    'result', result,
    'status', cv.status(p_cycle),
    'closed_at_null', cv.vca(p_cycle) is null,
    'new_events', cv.nevents(p_cycle) - before_events
  );
end;
$$;

create function cv.still_open(p_result jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('result', p_result, 'status', 'vote', 'closed_at_null', true, 'new_events', 0);
$$;

-- The one event both close paths record.
create function cv.close_event()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_array(jsonb_build_object('type', 'stage_changed', 'from_status', 'vote', 'to_status', 'discuss', 'actor_id', null, 'payload', '{}'::jsonb));
$$;

grant usage on schema cv to authenticated, service_role;
grant select, insert, update on all tables in schema cv to authenticated, service_role;
grant execute on all functions in schema cv to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures.
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', 'cc000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'cv-a@example.com', '{"display_name":"Alice"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'cc000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'cv-b@example.com', '{"display_name":"Bob"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'cc000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'cv-c@example.com', '{"display_name":"Cara"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'cc000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'cv-d@example.com', '{"display_name":"Dan"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'cc000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'cv-e@example.com', '{"display_name":"Eve"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'cc000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'cv-s@example.com', '{"display_name":"Sam"}', '', '', '', '');

insert into public.projects (id, name, owner_id)
values
  ('cd000000-0000-4000-8000-000000000001', 'Project P', 'cc000000-0000-4000-8000-000000000001'),
  ('cd000000-0000-4000-8000-000000000002', 'Project Q', 'cc000000-0000-4000-8000-000000000003'),
  ('cd000000-0000-4000-8000-000000000003', 'Project S', 'cc000000-0000-4000-8000-000000000006'),
  ('cd000000-0000-4000-8000-000000000004', 'Project W', 'cc000000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('cd000000-0000-4000-8000-000000000001', 'cc000000-0000-4000-8000-000000000002', 'member'),
  ('cd000000-0000-4000-8000-000000000001', 'cc000000-0000-4000-8000-000000000004', 'member');

-- Q1: C's cycle in vote with one cluster.
insert into public.feedback_cycles (id, project_id, title, week_start, status, revealed_at)
values ('ce000000-0000-4000-8000-000000000011', 'cd000000-0000-4000-8000-000000000002', 'Q one', '2026-10-26', 'vote', now());

-- ---------------------------------------------------------------------------
-- Migration hardening.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'close_voting'), 1, 'close_voting has exactly one overload');
select is(
  pg_get_function_identity_arguments('public.close_voting(uuid)'::regprocedure) || ' -> ' || pg_get_function_result('public.close_voting(uuid)'::regprocedure),
  'p_cycle_id uuid -> TABLE(id uuid, status text, voting_closed_at timestamp with time zone)',
  'close_voting has the agreed signature'
);
select is((select p.prosecdef and p.proconfig = array['search_path=""']::text[] and p.provolatile = 'v' from pg_proc p where p.oid = 'public.close_voting(uuid)'::regprocedure), true, 'close_voting is volatile security definer with search_path fixed to empty');
select is(
  array[
    has_function_privilege('authenticated', 'public.close_voting(uuid)', 'EXECUTE'),
    has_function_privilege('anon', 'public.close_voting(uuid)', 'EXECUTE'),
    has_function_privilege('service_role', 'public.close_voting(uuid)', 'EXECUTE'),
    (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'public.close_voting(uuid)'::regprocedure)
  ],
  array[true, false, false, false],
  'close_voting is executable by authenticated only'
);
select is(
  (select array_agg(m[1] || ':' || m[2]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = 'public.close_voting(uuid)'::regprocedure),
  array['42501:not_project_member', '42501:not_project_member', '42501:not_project_facilitator', 'P0001:stage_out_of_date'],
  'close_voting raises exactly its codes, with errcode and message only'
);
select is((select (select count(*)::int from regexp_matches(p.prosrc, '\mraise\M', 'gi')) from pg_proc p where p.oid = 'public.close_voting(uuid)'::regprocedure), 4, 'close_voting has no other raise');
select is((select p.prosrc ~* '(detail|hint)' from pg_proc p where p.oid = 'public.close_voting(uuid)'::regprocedure), false, 'close_voting sets no detail or hint');
select is(
  (select p.prosrc ~* '(votes|cycle_events|cards|card_authors|profiles|owner_id|execute|raise\s+notice)' from pg_proc p where p.oid = 'public.close_voting(uuid)'::regprocedure),
  false,
  'close_voting mentions no votes, cycle_events, cards, card_authors, profiles, owner_id, execute, or raise notice'
);
select is(
  (select
     strpos(p.prosrc, 'from public.projects p where p.id = cycle_project for share') > 0
     and strpos(p.prosrc, 'for share') < strpos(p.prosrc, 'private.is_project_facilitator')
     and strpos(p.prosrc, 'from public.feedback_cycles fc
   where fc.id = p_cycle_id
     for update') > 0
     and strpos(p.prosrc, 'private.is_project_facilitator') < strpos(p.prosrc, 'for update')
     and strpos(p.prosrc, 'for update') < strpos(p.prosrc, 'if cycle_status = ''vote''')
     and strpos(p.prosrc, 'for update') < strpos(p.prosrc, 'update public.feedback_cycles')
     and (select count(*) from regexp_matches(p.prosrc, 'for (update|share)', 'gi')) = 2
   from pg_proc p where p.oid = 'public.close_voting(uuid)'::regprocedure),
  true,
  'close_voting locks projects FOR SHARE before the facilitator check, then the cycle FOR UPDATE before the status check and the update'
);

select is((select n.nspname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = 'close_voting_if_complete'), 'private', 'close_voting_if_complete exists, in private only');
select is(
  pg_get_function_identity_arguments('private.close_voting_if_complete(uuid)'::regprocedure) || ' -> ' || pg_get_function_result('private.close_voting_if_complete(uuid)'::regprocedure),
  'p_cycle_id uuid -> boolean',
  'close_voting_if_complete takes the cycle id and returns a boolean'
);
select is((select proconfig from pg_proc where oid = 'private.close_voting_if_complete(uuid)'::regprocedure), array['search_path=""']::text[], 'close_voting_if_complete fixes search_path to empty');
select is(
  array[
    has_function_privilege('authenticated', 'private.close_voting_if_complete(uuid)', 'EXECUTE'),
    has_function_privilege('anon', 'private.close_voting_if_complete(uuid)', 'EXECUTE'),
    has_function_privilege('service_role', 'private.close_voting_if_complete(uuid)', 'EXECUTE'),
    (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = 'private.close_voting_if_complete(uuid)'::regprocedure)
  ],
  array[false, false, false, false],
  'nobody but the owner can execute close_voting_if_complete'
);
select is(
  (select p.prosrc ~* '(cycle_events|cards|card_authors|profiles|for\s+update|for\s+share|raise)' from pg_proc p where p.oid = 'private.close_voting_if_complete(uuid)'::regprocedure),
  false,
  'close_voting_if_complete mentions no cycle_events, cards, card_authors, or profiles, takes no lock, and raises nothing'
);
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'EXECUTE')), 4, 'authenticated can still execute exactly four private functions (#28 adds two Storage policy helpers)');

-- cast_vote is #22's function plus the final helper call.
select is(
  (select md5(regexp_replace(p.prosrc, E'\n\n  -- #24:[^\n]*\n  -- [^\n]*\n  perform private\\.close_voting_if_complete\\(p_cycle_id\\);', '')) from pg_proc p where p.oid = 'public.cast_vote(uuid, uuid)'::regprocedure),
  'bba625b546e59c33390377bb10c0f108',
  'cast_vote without the helper call is byte-identical to #22''s'
);
select is(
  (select (select count(*)::int from regexp_matches(p.prosrc, 'close_voting_if_complete', 'g')) = 1
          and p.prosrc ~ E'perform private\\.close_voting_if_complete\\(p_cycle_id\\);\nend;\n$'
     from pg_proc p where p.oid = 'public.cast_vote(uuid, uuid)'::regprocedure),
  true,
  'cast_vote calls the helper once, as its last step'
);
select is((select p.prosrc ~ 'close_voting_if_complete' from pg_proc p where p.oid = 'public.remove_vote(uuid, uuid)'::regprocedure), false, 'remove_vote never closes');
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p where p.prosrc ~ 'close_voting_if_complete' and p.proname <> 'close_voting_if_complete'),
  array['cast_vote'],
  'only cast_vote calls the helper'
);

select throws_ok($$ insert into public.cycle_events (cycle_id, type, from_status, to_status) values ('ce000000-0000-4000-8000-000000000011', 'voting_closed', 'vote', 'discuss') $$, '23514', NULL, 'cycle_events_type_check still rejects voting_closed');

select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.feedback_cycles'::regclass and c.conname = 'feedback_cycles_voting_closed_status_check'),
  'CHECK ((((status = ANY (ARRAY[''collecting''::text, ''reveal''::text, ''cluster''::text, ''vote''::text])) AND (voting_closed_at IS NULL)) OR ((status = ''discuss''::text) AND (voting_closed_at IS NOT NULL)) OR (status = ''closed''::text)))',
  'the CHECK: null before discuss, set in discuss, either in closed'
);
select trigger_is('public', 'feedback_cycles', 'feedback_cycles_guard_voting_closed', 'private', 'guard_feedback_cycle_voting_closed', 'the voting_closed_at guard trigger exists');
select is((select tgtype::int from pg_trigger where tgrelid = 'public.feedback_cycles'::regclass and tgname = 'feedback_cycles_guard_voting_closed'), 19, 'the guard is BEFORE UPDATE FOR EACH ROW');
select is('feedback_cycles_guard_voting_closed' > 'feedback_cycles_guard_update', true, 'the guard fires after #10''s feedback_cycles_guard_update');
select is(
  array[
    (select proconfig = array['search_path=""']::text[] from pg_proc where oid = 'private.guard_feedback_cycle_voting_closed()'::regprocedure),
    has_function_privilege('authenticated', 'private.guard_feedback_cycle_voting_closed()', 'EXECUTE'),
    has_function_privilege('anon', 'private.guard_feedback_cycle_voting_closed()', 'EXECUTE')
  ],
  array[true, false, false],
  'the guard function fixes search_path and is not executable by clients'
);

-- ---------------------------------------------------------------------------
-- P1: auto-close by an interleaved series.
-- ---------------------------------------------------------------------------
select cv.new_cycle('P1', 'P', '2026-09-07');
insert into cv.ids (label, id) values ('P1.s1', gen_random_uuid()), ('P1.s2', gen_random_uuid()), ('P1.t1', gen_random_uuid()), ('P1.k1', gen_random_uuid());
insert into public.cards (id, cycle_id, category, text, is_anonymous)
values
  (cv.id('P1.s1'), cv.id('P1'), 'start', 'Pair more', false),
  (cv.id('P1.s2'), cv.id('P1'), 'start', 'Demo weekly', true),
  (cv.id('P1.t1'), cv.id('P1'), 'stop', 'Late merges', false),
  (cv.id('P1.k1'), cv.id('P1'), 'continue', 'Retro notes', false);
insert into public.card_authors (card_id, author_id)
values (cv.id('P1.s1'), cv.id('A')), (cv.id('P1.s2'), cv.id('B')), (cv.id('P1.t1'), cv.id('D')), (cv.id('P1.k1'), cv.id('B'));

set local role authenticated;
select cv.start('A', 'P1');
select cv.advance('A', 'P1', 'reveal');
select cv.mk('A', 'P1', 'X');
select cv.mk('A', 'P1', 'Y');
select cv.mk('A', 'P1', 'Empty');
select cv.become('A');
select public.move_card(cv.id('P1.s1'), cv.id('P1.X'), null);
select public.move_card(cv.id('P1.s2'), cv.id('P1.X'), null);
select public.move_card(cv.id('P1.t1'), cv.id('P1.Y'), null);
reset role;

set local role service_role;
do $$
declare
  run uuid;
begin
  run := (public.begin_ai_clustering(cv.id('P1'), cv.id('A'), 'claude-opus-5-5', 'cluster-feedback/v1') ->> 'run_id')::uuid;
  perform public.replace_ai_clusters(
    run, cv.id('A'),
    jsonb_build_array(jsonb_build_object('name', 'AI', 'category', 'continue', 'card_ids', jsonb_build_array(cv.id('P1.k1')))),
    '{}'::jsonb
  );
end;
$$;
reset role;
insert into cv.ids (label, id) select 'P1.AI', cl.id from public.clusters cl where cl.cycle_id = cv.id('P1') and cl.source = 'ai';
select is(
  (select array_agg(cv.label(cl.id) || ':' || cl.source || ':' || (select count(*) from public.cluster_cards cc where cc.cluster_id = cl.id) order by cl.sort_order) from public.clusters cl where cl.cycle_id = cv.id('P1')),
  array['P1.X:manual:2', 'P1.Y:manual:1', 'P1.Empty:manual:0', 'P1.AI:ai:1'],
  'P1 has X, Y, a zero-card cluster, and an ai cluster, in that board order'
);

set local role authenticated;
select cv.advance('A', 'P1', 'cluster');
select is(cv.status('P1'), 'vote', 'P1 is in vote');
select is(cv.close('B', 'P1'), cv.e('not_project_facilitator'), 'B''s close_voting on P1 gets not_project_facilitator');

-- Around a non-final cast every feedback_cycles row is byte-identical.
select cv.snap('cycles', to_jsonb(cv.cycles_md5()));
select is(cv.cast_open('B', 'P1', 'P1.X'), cv.still_open('[1, 2]'), 'B casts on X; P1 stays open');
select is(to_jsonb(cv.cycles_md5()), cv.snapped('cycles'), 'a non-final cast leaves feedback_cycles byte-identical');

select is(
  array[
    cv.cast_open('A', 'P1', 'P1.Y'),
    cv.cast_open('D', 'P1', 'P1.X'),
    cv.cast_open('B', 'P1', 'P1.Y'),
    cv.cast_open('A', 'P1', 'P1.X'),
    cv.cast_open('D', 'P1', 'P1.Y'),
    cv.cast_open('B', 'P1', 'P1.AI'),
    cv.cast_open('A', 'P1', 'P1.Empty')
  ],
  array[
    cv.still_open('[1, 2]'),
    cv.still_open('[1, 2]'),
    cv.still_open('[1, 1]'),
    cv.still_open('[1, 1]'),
    cv.still_open('[1, 1]'),
    cv.still_open('[1, 0]'),
    cv.still_open('[1, 0]')
  ],
  'casts 2 to 8 of the series each leave P1 in vote, voting_closed_at null, and no new event'
);
select cv.snap('P1 events', to_jsonb(cv.nevents('P1')));
select is(cv.cast('D', 'P1', 'P1.AI'), '[1, 0]'::jsonb, 'the 9th cast (D''s 3rd) returns its normal row');
select is(cv.status('P1'), 'discuss', 'after the 9th cast P1 is in discuss');
select isnt(cv.vca('P1'), null, 'voting_closed_at is set');
select is(cv.nevents('P1'), (cv.snapped('P1 events') #>> '{}')::int + 1, 'exactly one new event');
select is(cv.close_events('P1'), cv.close_event(), 'the event is stage_changed vote -> discuss with actor_id null and payload {}');

-- Idempotency after the automatic close.
select cv.snap('P1 state', cv.state('P1'));
select cv.snap('P1 vca', to_jsonb(cv.vca('P1')));
select is(
  cv.close('A', 'P1'),
  jsonb_build_array(jsonb_build_object('id', cv.id('P1'), 'status', 'discuss', 'voting_closed_at', cv.snapped('P1 vca'))),
  'close_voting after the automatic close returns the current row with the same voting_closed_at'
);
select is(cv.state('P1'), cv.snapped('P1 state'), 'and changes nothing and records no event');

select is(cv.cast('A', 'P1', 'P1.Y'), cv.e('cycle_not_voting'), 'after close, cast_vote gets cycle_not_voting');
select is(cv.remove('B', 'P1', 'P1.X'), cv.e('cycle_not_voting'), 'after close, remove_vote gets cycle_not_voting');

select is(
  cv.totals('A', 'P1'),
  '[["P1.X", 3], ["P1.Y", 3], ["P1.AI", 2], ["P1.Empty", 1]]'::jsonb,
  'totals: every cluster, by total desc, then sort_order (X and Y tie at the top; AI before Empty)'
);
select is(array[cv.totals('B', 'P1'), cv.totals('D', 'P1')], array[cv.totals('A', 'P1'), cv.totals('A', 'P1')], 'B and D get identical totals to A');
select is(cv.totals('C', 'P1'), cv.e('not_project_member'), 'C gets not_project_member from get_vote_totals');

-- close_cycle from discuss keeps voting_closed_at and records its actor.
select cv.close_cycle('A', 'P1');
select is(cv.status('P1'), 'closed', 'close_cycle from discuss closes P1');
select is(to_jsonb(cv.vca('P1')), cv.snapped('P1 vca'), 'close_cycle from discuss keeps voting_closed_at');
select is(cv.events('P1'), array['collecting>reveal:A', 'reveal>cluster:A', 'cluster>vote:A', 'vote>discuss:null', 'discuss>closed:A'], 'only vote -> discuss has a null actor; start, advance_stage, and close_cycle record the facilitator');
select cv.snap('P1 closed', cv.state('P1'));
select is(cv.close('A', 'P1'), cv.e('stage_out_of_date'), 'closed (from discuss): close_voting gets stage_out_of_date');
select is(cv.state('P1'), cv.snapped('P1 closed'), 'closed (from discuss): nothing changed');
select is(cv.totals('B', 'P1'), cv.totals('A', 'P1'), 'closed: totals still identical');

-- ---------------------------------------------------------------------------
-- P2: no early close.
-- ---------------------------------------------------------------------------
select cv.to_vote('A', 'P2', 'P', '2026-09-14', array['M', 'N']);
select is(
  array[
    cv.cast_open('A', 'P2', 'P2.M'), cv.cast_open('A', 'P2', 'P2.M'), cv.cast_open('A', 'P2', 'P2.N'),
    cv.cast_open('B', 'P2', 'P2.N'), cv.cast_open('B', 'P2', 'P2.N'), cv.cast_open('B', 'P2', 'P2.N'),
    cv.cast_open('D', 'P2', 'P2.M'), cv.cast_open('D', 'P2', 'P2.M')
  ],
  array[
    cv.still_open('[1, 2]'), cv.still_open('[2, 1]'), cv.still_open('[1, 0]'),
    cv.still_open('[1, 2]'), cv.still_open('[2, 1]'), cv.still_open('[3, 0]'),
    cv.still_open('[1, 2]'), cv.still_open('[2, 1]')
  ],
  'with A and B at 3 and D at 2, P2 stays in vote'
);
select is(
  array[cv.remove('B', 'P2', 'P2.N'), cv.cast_open('B', 'P2', 'P2.N')],
  array['[2, 1]'::jsonb, cv.still_open('[3, 0]')],
  'B removes one vote and casts it again: still vote, no event'
);
select is(cv.status('P2'), 'vote', 'a remove never closes');
select is(cv.cast('D', 'P2', 'P2.N'), '[1, 0]'::jsonb, 'D''s 3rd cast returns its normal row');
select is(array[cv.status('P2'), (cv.vca('P2') is not null)::text], array['discuss', 'true'], 'D''s 3rd cast closes P2');
select is(cv.close_events('P2'), cv.close_event(), 'with one vote -> discuss event, actor null');
select cv.close_cycle('A', 'P2');

-- ---------------------------------------------------------------------------
-- P3: access, then the facilitator closes with B at 1 vote and D at 0.
-- ---------------------------------------------------------------------------
select cv.to_vote('A', 'P3', 'P', '2026-09-21', array['M', 'N']);
select is(cv.cast('B', 'P3', 'P3.N'), '[1, 2]'::jsonb, 'B casts one vote in P3');
select cv.snap('P3 state', cv.state('P3'));
select is(
  array[cv.close('B', 'P3'), cv.close('D', 'P3')],
  array[cv.e('not_project_facilitator'), cv.e('not_project_facilitator')],
  'members B and D get not_project_facilitator'
);
select cv.transfer('A', 'B');
select is(cv.close('A', 'P3'), cv.e('not_project_facilitator'), 'after transfer_facilitator to B, the owner and former facilitator A gets not_project_facilitator');
select is(cv.close('D', 'P3'), cv.e('not_project_facilitator'), 'after the transfer, D still gets not_project_facilitator');
select cv.transfer('A', 'A');
select is(
  array[cv.close('C', 'P3'), cv.close(null, 'P3'), cv.close_raw('A', null), cv.close('A', 'random'), cv.close('A', 'Q1')],
  array[cv.e('not_project_member'), cv.e('not_project_member'), cv.e('not_project_member'), cv.e('not_project_member'), cv.e('not_project_member')],
  'C, a null user, a null id, a random id, and a cycle of project Q each get not_project_member'
);
select is(cv.close('C', 'P3'), cv.close('C', 'random'), 'an existing and a random id give C the same result');
select is(cv.state('P3'), cv.snapped('P3 state'), 'every refused close changed nothing and recorded no event');

select cv.snap('P3 rest', cv.cycle_rest('P3'));
select cv.snap('others', to_jsonb(cv.others_md5()));
select cv.snap('P3 events', to_jsonb(cv.nevents('P3')));
select is(
  (select jsonb_build_array(jsonb_array_length(r), r -> 0 -> 'id', r -> 0 -> 'status', (r -> 0 -> 'voting_closed_at') <> 'null'::jsonb) from (select cv.close('A', 'P3') r) x),
  jsonb_build_array(1, cv.id('P3'), 'discuss', true),
  'A''s close_voting in vote returns one row (P3, discuss, voting_closed_at set)'
);
select is(array[cv.status('P3'), (cv.vca('P3') is not null)::text], array['discuss', 'true'], 'P3 is in discuss with voting_closed_at set');
select is(cv.nevents('P3'), (cv.snapped('P3 events') #>> '{}')::int + 1, 'the close records exactly one event');
select is(cv.close_events('P3'), cv.close_event(), 'the facilitator''s close records the same event as an automatic close (actor_id null)');
select is(cv.cycle_rest('P3'), cv.snapped('P3 rest'), 'only status, voting_closed_at, and updated_at changed on the cycle');
select is(to_jsonb(cv.others_md5()), cv.snapped('others'), 'project_members, clusters, cluster_cards, and votes are byte-identical');

select cv.snap('P3 state', cv.state('P3'));
select cv.snap('P3 vca', to_jsonb(cv.vca('P3')));
select is(
  cv.close('A', 'P3'),
  jsonb_build_array(jsonb_build_object('id', cv.id('P3'), 'status', 'discuss', 'voting_closed_at', cv.snapped('P3 vca'))),
  'a second close_voting returns the current row with the same voting_closed_at'
);
select is(cv.state('P3'), cv.snapped('P3 state'), 'the second close changes nothing and records no event');
select is(cv.totals('D', 'P3'), '[["P3.N", 1], ["P3.M", 0]]'::jsonb, 'totals include zeros, by total desc');
select is(cv.cast('D', 'P3', 'P3.M'), cv.e('cycle_not_voting'), 'a cast after the close gets cycle_not_voting');
select cv.close_cycle('A', 'P3');

-- ---------------------------------------------------------------------------
-- P4: closed with no votes at all. P5: zero clusters.
-- ---------------------------------------------------------------------------
select cv.to_vote('A', 'P4', 'P', '2026-09-28', array['U', 'V', 'W']);
select is(cv.close('A', 'P4') -> 0 ->> 'status', 'discuss', 'A closes P4 with no votes cast');
select is(
  array[cv.totals('A', 'P4'), cv.totals('B', 'P4')],
  array['[["P4.U", 0], ["P4.V", 0], ["P4.W", 0]]'::jsonb, '[["P4.U", 0], ["P4.V", 0], ["P4.W", 0]]'::jsonb],
  'an all-zero cycle lists every cluster with 0, in sort order'
);
select cv.close_cycle('A', 'P4');

select cv.to_vote('A', 'P5', 'P', '2026-10-05', array[]::text[]);
select is(cv.cast('B', 'P5', 'random'), cv.e('cluster_not_found'), 'a cycle with zero clusters takes no vote, so it never closes automatically');
select is(cv.status('P5'), 'vote', 'P5 stays in vote');
select is(cv.close('A', 'P5') -> 0 ->> 'status', 'discuss', 'the facilitator closes the zero-cluster cycle');
select is(cv.totals('D', 'P5'), '[]'::jsonb, 'its totals are empty');
select cv.close_cycle('A', 'P5');

-- ---------------------------------------------------------------------------
-- P6: close_voting in every wrong stage.
-- ---------------------------------------------------------------------------
select cv.new_cycle('P6', 'P', '2026-10-12');
select cv.snap('P6', cv.state('P6'));
select is(array[cv.close('A', 'P6'), cv.state('P6')], array[cv.e('stage_out_of_date'), cv.snapped('P6')], 'collecting: stage_out_of_date, nothing changed');
select cv.start('A', 'P6');
select cv.snap('P6', cv.state('P6'));
select is(array[cv.close('A', 'P6'), cv.state('P6')], array[cv.e('stage_out_of_date'), cv.snapped('P6')], 'reveal: stage_out_of_date, nothing changed');
select cv.advance('A', 'P6', 'reveal');
select cv.mk('A', 'P6', 'M');
select cv.snap('P6', cv.state('P6'));
select is(array[cv.close('A', 'P6'), cv.state('P6')], array[cv.e('stage_out_of_date'), cv.snapped('P6')], 'cluster: stage_out_of_date, nothing changed');
select cv.advance('A', 'P6', 'cluster');
select is(cv.cast('B', 'P6', 'P6.M'), '[1, 2]'::jsonb, 'B casts in P6');
select cv.close_cycle('A', 'P6');
select is(array[cv.status('P6'), coalesce(cv.vca('P6')::text, 'null')], array['closed', 'null'], 'close_cycle from vote leaves voting_closed_at null');
select is(cv.events('P6'), array['collecting>reveal:A', 'reveal>cluster:A', 'cluster>vote:A', 'vote>closed:A'], 'vote -> closed keeps the facilitator as actor');
select is(cv.totals('B', 'P6'), cv.e('voting_not_closed'), 'a cycle closed from vote never shows totals');
select cv.snap('P6', cv.state('P6'));
select is(array[cv.close('A', 'P6'), cv.state('P6')], array[cv.e('stage_out_of_date'), cv.snapped('P6')], 'closed (from vote): stage_out_of_date, nothing changed');

-- ---------------------------------------------------------------------------
-- Single member: project S's only member is its owner and facilitator.
-- ---------------------------------------------------------------------------
select cv.to_vote('S', 'S1', 'PS', '2026-10-19', array['M']);
select is(
  array[cv.cast_open('S', 'S1', 'S1.M'), cv.cast_open('S', 'S1', 'S1.M')],
  array[cv.still_open('[1, 2]'), cv.still_open('[2, 1]')],
  'S''s first two votes leave S1 open'
);
select is(cv.cast('S', 'S1', 'S1.M'), '[3, 0]'::jsonb, 'S''s 3rd cast returns its normal row');
select is(cv.status('S1'), 'discuss', 'and closes voting in a single-member project');

-- ---------------------------------------------------------------------------
-- P7: E joins P during vote.
-- ---------------------------------------------------------------------------
select cv.to_vote('A', 'P7', 'P', '2026-10-19', array['M', 'N']);
select cv.cast('A', 'P7', 'P7.M');
select cv.cast('A', 'P7', 'P7.M');
select cv.cast('A', 'P7', 'P7.M');
select cv.cast('B', 'P7', 'P7.N');
select cv.cast('B', 'P7', 'P7.N');
select cv.cast('B', 'P7', 'P7.N');
select cv.cast('D', 'P7', 'P7.M');
select cv.cast('D', 'P7', 'P7.N');
select cv.join('E');
select is(cv.cast_open('D', 'P7', 'P7.N'), cv.still_open('[2, 0]'), 'after E joins, D''s 3rd cast does not close');
select is(
  array[cv.cast_open('E', 'P7', 'P7.M'), cv.cast_open('E', 'P7', 'P7.N')],
  array[cv.still_open('[1, 2]'), cv.still_open('[1, 1]')],
  'E''s first two casts do not close'
);
select cv.snap('P7 events', to_jsonb(cv.nevents('P7')));
select is(cv.cast('E', 'P7', 'P7.N'), '[2, 0]'::jsonb, 'E''s 3rd cast returns its normal row');
select is(array[cv.status('P7'), (cv.nevents('P7') - (cv.snapped('P7 events') #>> '{}')::int)::text], array['discuss', '1'], 'E''s 3rd cast closes P7 with one event');
select cv.close_cycle('A', 'P7');

-- ---------------------------------------------------------------------------
-- P8: B's auth user is deleted while B holds 3 votes.
-- ---------------------------------------------------------------------------
select cv.to_vote('A', 'P8', 'P', '2026-10-26', array['M', 'N']);
select cv.cast('B', 'P8', 'P8.M');
select cv.cast('B', 'P8', 'P8.M');
select cv.cast('B', 'P8', 'P8.N');
reset role;
delete from auth.users where id = cv.id('B');
select is((select count(*)::int from public.votes v where v.cycle_id = cv.id('P8') and v.voter_id is null), 3, 'B''s 3 votes stay with voter_id null');
set local role authenticated;
select is(
  array[
    cv.cast_open('A', 'P8', 'P8.M'), cv.cast_open('A', 'P8', 'P8.M'), cv.cast_open('A', 'P8', 'P8.M'),
    cv.cast_open('D', 'P8', 'P8.N'), cv.cast_open('D', 'P8', 'P8.N'), cv.cast_open('D', 'P8', 'P8.N'),
    cv.cast_open('E', 'P8', 'P8.N'), cv.cast_open('E', 'P8', 'P8.N')
  ],
  array[
    cv.still_open('[1, 2]'), cv.still_open('[2, 1]'), cv.still_open('[3, 0]'),
    cv.still_open('[1, 2]'), cv.still_open('[2, 1]'), cv.still_open('[3, 0]'),
    cv.still_open('[1, 2]'), cv.still_open('[2, 1]')
  ],
  'B''s orphaned votes count toward nobody''s 3: with E at 2, P8 stays in vote'
);
select is(cv.cast('E', 'P8', 'P8.M'), '[1, 0]'::jsonb, 'E''s 3rd cast returns its normal row');
select is(cv.status('P8'), 'discuss', 'B is no longer a member and does not block the close');
select is(cv.totals('A', 'P8'), '[["P8.M", 6], ["P8.N", 6]]'::jsonb, 'B''s orphaned votes count in the totals');
reset role;

-- ---------------------------------------------------------------------------
-- voting_closed_at invariants, as postgres.
-- ---------------------------------------------------------------------------
select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start, voting_closed_at) values ('cd000000-0000-4000-8000-000000000004', 'Bad', '2026-10-05', now()) $$, '23514', NULL, 'a collecting cycle cannot have voting_closed_at');
select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start, status, revealed_at, voting_closed_at) values ('cd000000-0000-4000-8000-000000000004', 'Bad', '2026-10-05', 'reveal', now(), now()) $$, '23514', NULL, 'a reveal cycle cannot have voting_closed_at');
select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start, status, revealed_at, voting_closed_at) values ('cd000000-0000-4000-8000-000000000004', 'Bad', '2026-10-05', 'cluster', now(), now()) $$, '23514', NULL, 'a cluster cycle cannot have voting_closed_at');
select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start, status, revealed_at, voting_closed_at) values ('cd000000-0000-4000-8000-000000000004', 'Bad', '2026-10-05', 'vote', now(), now()) $$, '23514', NULL, 'a vote cycle cannot have voting_closed_at');
select throws_ok($$ insert into public.feedback_cycles (project_id, title, week_start, status, revealed_at) values ('cd000000-0000-4000-8000-000000000004', 'Bad', '2026-10-05', 'discuss', now()) $$, '23514', NULL, 'a discuss cycle must have voting_closed_at');

insert into public.feedback_cycles (id, project_id, title, week_start)
values ('ce000000-0000-4000-8000-000000000041', 'cd000000-0000-4000-8000-000000000004', 'W one', '2026-10-05');
select throws_ok($$ update public.feedback_cycles set voting_closed_at = now() where id = 'ce000000-0000-4000-8000-000000000041' $$, '23514', NULL, 'collecting: setting voting_closed_at fails the CHECK');
update public.feedback_cycles set status = 'reveal', revealed_at = now() where id = 'ce000000-0000-4000-8000-000000000041';
select throws_ok($$ update public.feedback_cycles set voting_closed_at = now() where id = 'ce000000-0000-4000-8000-000000000041' $$, '23514', NULL, 'reveal: setting voting_closed_at fails the CHECK');
select throws_ok($$ update public.feedback_cycles set status = 'cluster', voting_closed_at = now() where id = 'ce000000-0000-4000-8000-000000000041' $$, '23514', NULL, 'reveal -> cluster with voting_closed_at fails the CHECK');
update public.feedback_cycles set status = 'cluster' where id = 'ce000000-0000-4000-8000-000000000041';
select throws_ok($$ update public.feedback_cycles set voting_closed_at = now() where id = 'ce000000-0000-4000-8000-000000000041' $$, '23514', NULL, 'cluster: setting voting_closed_at fails the CHECK');
update public.feedback_cycles set status = 'vote' where id = 'ce000000-0000-4000-8000-000000000041';
select throws_ok($$ update public.feedback_cycles set voting_closed_at = now() where id = 'ce000000-0000-4000-8000-000000000041' $$, '23514', NULL, 'vote: setting voting_closed_at fails the CHECK');
select throws_ok($$ update public.feedback_cycles set status = 'discuss' where id = 'ce000000-0000-4000-8000-000000000041' $$, '23514', NULL, 'vote -> discuss without voting_closed_at fails the CHECK');
select lives_ok($$ update public.feedback_cycles set status = 'discuss', voting_closed_at = '2026-10-07 10:00+00' where id = 'ce000000-0000-4000-8000-000000000041' $$, 'vote -> discuss with voting_closed_at succeeds');
select throws_ok($$ update public.feedback_cycles set voting_closed_at = '2026-10-08 10:00+00' where id = 'ce000000-0000-4000-8000-000000000041' $$, 'P0001', 'cycle_immutable_column', 'discuss: voting_closed_at cannot be moved');
select throws_ok($$ update public.feedback_cycles set voting_closed_at = null where id = 'ce000000-0000-4000-8000-000000000041' $$, 'P0001', 'cycle_immutable_column', 'discuss: voting_closed_at cannot be cleared');
select throws_ok($$ update public.feedback_cycles set status = 'vote' where id = 'ce000000-0000-4000-8000-000000000041' $$, 'P0001', 'invalid_status_transition', 'discuss -> vote is still invalid_status_transition');
select throws_ok($$ update public.feedback_cycles set status = 'vote', voting_closed_at = null where id = 'ce000000-0000-4000-8000-000000000041' $$, 'P0001', 'invalid_status_transition', 'discuss -> vote clearing voting_closed_at is still invalid_status_transition');
select throws_ok($$ update public.feedback_cycles set status = 'closed', closed_at = now(), voting_closed_at = null where id = 'ce000000-0000-4000-8000-000000000041' $$, 'P0001', 'cycle_immutable_column', 'discuss -> closed cannot clear voting_closed_at');
select lives_ok($$ update public.feedback_cycles set status = 'closed', closed_at = now() where id = 'ce000000-0000-4000-8000-000000000041' $$, 'discuss -> closed succeeds');
select is((select voting_closed_at from public.feedback_cycles where id = 'ce000000-0000-4000-8000-000000000041'), '2026-10-07 10:00+00'::timestamptz, 'discuss -> closed keeps voting_closed_at');
select throws_ok($$ update public.feedback_cycles set voting_closed_at = '2026-10-08 10:00+00' where id = 'ce000000-0000-4000-8000-000000000041' $$, 'P0001', 'cycle_immutable_column', 'closed: voting_closed_at cannot be moved');
select throws_ok($$ update public.feedback_cycles set voting_closed_at = null where id = 'ce000000-0000-4000-8000-000000000041' $$, 'P0001', 'cycle_immutable_column', 'closed: voting_closed_at cannot be cleared');

insert into public.feedback_cycles (id, project_id, title, week_start, status, revealed_at)
values ('ce000000-0000-4000-8000-000000000042', 'cd000000-0000-4000-8000-000000000004', 'W two', '2026-10-12', 'vote', now());
select throws_ok($$ update public.feedback_cycles set status = 'closed', closed_at = now(), voting_closed_at = now() where id = 'ce000000-0000-4000-8000-000000000042' $$, 'P0001', 'cycle_immutable_column', 'vote -> closed cannot set voting_closed_at');
update public.feedback_cycles set status = 'closed', closed_at = now() where id = 'ce000000-0000-4000-8000-000000000042';
select throws_ok($$ update public.feedback_cycles set voting_closed_at = now() where id = 'ce000000-0000-4000-8000-000000000042' $$, 'P0001', 'cycle_immutable_column', 'closed from vote: voting_closed_at can never be set');

select * from finish();

rollback;
