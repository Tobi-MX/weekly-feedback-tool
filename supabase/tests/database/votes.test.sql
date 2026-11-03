-- pgTAP tests for #22: votes, cast_vote, remove_vote, get_vote_totals, and
-- get_cycle_board's my_votes and votes_remaining. Covers the table, its
-- default-deny hardening, the RPC hardening and check order, the 3-vote
-- budget, stacking, moving, removing, the stage and cluster checks, access,
-- a mid-vote join, deleted voters, no side effects, the lock, the totals
-- gate, and the board keys.
--
-- Everything runs in one transaction and is rolled back at the end. The seed
-- user is never used as a fixture.
--
-- Fixtures: owner and facilitator A, members B and D, non-member C, and E
-- (joins P during vote). P is A's with B and D joined; Q is C's. P0 is a
-- closed cycle of P with cluster Old. P1 (P) is the main cycle: cards from A,
-- B, and D, moved through reveal and cluster by A, manual clusters X, Y, Z
-- (with cards) and Empty (no cards) made through the RPCs, and one AI
-- cluster written through #20's begin_ai_clustering + replace_ai_clusters,
-- then advanced to vote. P2 (P) is a later cycle closed from vote. Q1 (Q) is
-- C's, in vote, with cluster QX.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(149);

-- ---------------------------------------------------------------------------
-- Test-only helpers.
-- ---------------------------------------------------------------------------
create schema vt;

create table vt.ids (label text primary key, id uuid not null);
create table vt.snaps (label text primary key, body jsonb);
create table vt.results (n serial primary key, vote_count integer, votes_remaining integer);

insert into vt.ids (label, id)
values
  ('A', '1e000000-0000-4000-8000-000000000001'),
  ('B', '1e000000-0000-4000-8000-000000000002'),
  ('C', '1e000000-0000-4000-8000-000000000003'),
  ('D', '1e000000-0000-4000-8000-000000000004'),
  ('E', '1e000000-0000-4000-8000-000000000005'),
  ('P', '2e000000-0000-4000-8000-000000000001'),
  ('Q', '2e000000-0000-4000-8000-000000000002'),
  ('P0', '3e000000-0000-4000-8000-000000000000'),
  ('P1', '3e000000-0000-4000-8000-000000000001'),
  ('P2', '3e000000-0000-4000-8000-000000000002'),
  ('Q1', '3e000000-0000-4000-8000-000000000011'),
  ('Old', '4e000000-0000-4000-8000-000000000000'),
  ('QX', '4e000000-0000-4000-8000-000000000011'),
  ('P2X', '4e000000-0000-4000-8000-000000000002'),
  ('random', '9e000000-0000-4000-8000-000000000099');

create function vt.id(p_label text)
returns uuid
language sql
stable
as $$
  select i.id from vt.ids i where i.label = p_label;
$$;

create function vt.become(p_user text)
returns void
language plpgsql
as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', vt.id(p_user), 'role', 'authenticated')::text,
      true
    );
  end if;
end;
$$;

-- The error a refused call gets, with empty detail and hint.
create function vt.e(p_message text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'code', case when p_message = 'not_project_member' then '42501' else 'P0001' end,
    'message', p_message,
    'detail', '',
    'hint', ''
  );
$$;

-- cast_vote or remove_vote with raw ids: [vote_count, votes_remaining], or
-- the full error. Every success is logged in vt.results.
create function vt.vote_raw(p_fn text, p_user text, p_cycle uuid, p_cluster uuid)
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
  perform vt.become(p_user);
  if p_fn = 'cast' then
    select * into strict r from public.cast_vote(p_cycle, p_cluster);
  else
    select * into strict r from public.remove_vote(p_cycle, p_cluster);
  end if;
  if r.cluster_id is distinct from p_cluster then
    return to_jsonb('wrong cluster_id'::text);
  end if;
  insert into vt.results (vote_count, votes_remaining) values (r.vote_count, r.votes_remaining);
  return jsonb_build_array(r.vote_count, r.votes_remaining);
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

create function vt.cast(p_user text, p_cluster text, p_cycle text default 'P1')
returns jsonb
language sql
as $$
  select vt.vote_raw('cast', p_user, vt.id(p_cycle), vt.id(p_cluster));
$$;

create function vt.remove(p_user text, p_cluster text, p_cycle text default 'P1')
returns jsonb
language sql
as $$
  select vt.vote_raw('remove', p_user, vt.id(p_cycle), vt.id(p_cluster));
$$;

-- get_vote_totals as the user: an array of rows in returned order, or the
-- full error.
create function vt.totals_raw(p_user text, p_cycle uuid)
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
  perform vt.become(p_user);
  select coalesce(jsonb_agg(to_jsonb(t) - 'n' order by t.n), '[]'::jsonb)
    into result
    from public.get_vote_totals(p_cycle) with ordinality t(cluster_id, total_votes, n);
  return result;
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

create function vt.totals(p_user text, p_cycle text default 'P1')
returns jsonb
language sql
as $$
  select vt.totals_raw(p_user, vt.id(p_cycle));
$$;

create function vt.board_raw(p_user text, p_cycle uuid)
returns jsonb
language plpgsql
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform vt.become(p_user);
  return public.get_cycle_board(p_cycle);
exception
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('code', v_state, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;

create function vt.board(p_user text, p_cycle text default 'P1')
returns jsonb
language sql
as $$
  select vt.board_raw(p_user, vt.id(p_cycle));
$$;

-- The caller-specific part of a board.
create function vt.mine(p_board jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('my_votes', p_board -> 'my_votes', 'votes_remaining', p_board -> 'votes_remaining');
$$;

-- A board without my_votes, votes_remaining, and is_mine on cards.
create function vt.shared(p_board jsonb)
returns jsonb
language sql
immutable
as $$
  select (p_board - 'my_votes' - 'votes_remaining')
    || jsonb_build_object('cards', coalesce((select jsonb_agg(c - 'is_mine' order by o) from jsonb_array_elements(p_board -> 'cards') with ordinality x(c, o)), '[]'::jsonb));
$$;

-- An expected my_votes array from cluster labels and counts.
create function vt.mv(p_labels text[], p_counts integer[])
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object('cluster_id', vt.id(l), 'vote_count', c) order by o), '[]'::jsonb)
    from unnest(p_labels, p_counts) with ordinality u(l, c, o);
$$;

create function vt.add_card(p_user text, p_category text, p_label text, p_anonymous boolean)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform vt.become(p_user);
  select c.id into strict new_id
    from public.create_card(vt.id('P1'), p_category, p_label, p_anonymous) c;
  insert into vt.ids (label, id) values (p_label, new_id);
  return new_id;
end;
$$;

create function vt.mk(p_user text, p_name text)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  perform vt.become(p_user);
  select r.cluster_id into strict new_id from public.create_cluster(vt.id('P1'), p_name) r;
  insert into vt.ids (label, id) values (p_name, new_id);
  return new_id;
end;
$$;

create function vt.move(p_user text, p_card text, p_cluster text)
returns void
language plpgsql
as $$
begin
  perform vt.become(p_user);
  perform public.move_card(vt.id(p_card), vt.id(p_cluster), null);
end;
$$;

create function vt.start(p_user text)
returns void
language plpgsql
as $$
begin
  perform vt.become(p_user);
  perform 1 from public.start_retrospective(vt.id('P1'));
end;
$$;

create function vt.advance(p_user text, p_from text)
returns void
language plpgsql
as $$
begin
  perform vt.become(p_user);
  perform 1 from public.advance_stage(vt.id('P1'), p_from);
end;
$$;

create function vt.close(p_user text, p_cycle text)
returns void
language plpgsql
as $$
begin
  perform vt.become(p_user);
  perform 1 from public.close_cycle(vt.id(p_cycle));
end;
$$;

create function vt.transfer(p_user text, p_to text)
returns void
language plpgsql
as $$
begin
  perform vt.become(p_user);
  perform public.transfer_facilitator(vt.id('P'), vt.id(p_to));
end;
$$;

create function vt.invite(p_user text)
returns text
language plpgsql
as $$
begin
  perform vt.become(p_user);
  return (select i.token from public.create_project_invite(vt.id('P')) i);
end;
$$;

create function vt.join(p_user text, p_token text)
returns void
language plpgsql
as $$
begin
  perform vt.become(p_user);
  perform 1 from public.join_project(p_token);
end;
$$;

create function vt.snap(p_label text, p_body jsonb)
returns void
language sql
as $$
  insert into vt.snaps (label, body) values (p_label, p_body)
  on conflict (label) do update set body = excluded.body;
$$;

create function vt.snapped(p_label text)
returns jsonb
language sql
stable
as $$
  select s.body from vt.snaps s where s.label = p_label;
$$;

-- Read-back helpers, security definer so they see every row.
create function vt.nvotes(p_cycle uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.votes v where v.cycle_id = p_cycle;
$$;

create function vt.votes_state()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(string_agg(pg_catalog.to_jsonb(v)::text, '|' order by v.id), '') from public.votes v;
$$;

create function vt.nvotes_of(p_cycle uuid, p_voter uuid, p_cluster uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.votes v
   where v.cycle_id = p_cycle and v.voter_id is not distinct from p_voter and v.cluster_id = p_cluster;
$$;

-- Every row of the tables a vote write must not touch, as an md5, plus the
-- number of cycle_events rows.
create function vt.others_state()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(
    coalesce((select string_agg(pg_catalog.to_jsonb(fc)::text, '|' order by fc.id) from public.feedback_cycles fc), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(pm)::text, '|' order by pm.project_id, pm.user_id) from public.project_members pm), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(cl)::text, '|' order by cl.id) from public.clusters cl), '')
    || '#' || coalesce((select string_agg(pg_catalog.to_jsonb(cc)::text, '|' order by cc.card_id) from public.cluster_cards cc), '')
  ) || ':' || (select count(*) from public.cycle_events)::text;
$$;

-- P1's per-cluster row counts in votes, by cluster id, as a jsonb object.
create function vt.row_totals()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_object_agg(cl.id::text, (select count(*) from public.votes v where v.cluster_id = cl.id)), '{}'::jsonb)
    from public.clusters cl
   where cl.cycle_id = '3e000000-0000-4000-8000-000000000001';
$$;

grant usage on schema vt to authenticated, service_role;
grant select, insert, update on all tables in schema vt to authenticated, service_role;
grant usage on all sequences in schema vt to authenticated, service_role;
grant execute on all functions in schema vt to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures.
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', '1e000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'vt-a@example.com', '{"display_name":"Alice"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '1e000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'vt-b@example.com', '{"display_name":"Bob"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '1e000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'vt-c@example.com', '{"display_name":"Cara"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '1e000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'vt-d@example.com', '{"display_name":"Dan"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '1e000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'vt-e@example.com', '{"display_name":"Eve"}', '', '', '', '');

insert into public.projects (id, name, owner_id)
values
  ('2e000000-0000-4000-8000-000000000001', 'Project P', '1e000000-0000-4000-8000-000000000001'),
  ('2e000000-0000-4000-8000-000000000002', 'Project Q', '1e000000-0000-4000-8000-000000000003');

insert into public.project_members (project_id, user_id, role)
values
  ('2e000000-0000-4000-8000-000000000001', '1e000000-0000-4000-8000-000000000002', 'member'),
  ('2e000000-0000-4000-8000-000000000001', '1e000000-0000-4000-8000-000000000004', 'member');

-- P0: an earlier, closed cycle of P with one cluster.
insert into public.feedback_cycles (id, project_id, title, week_start, status, revealed_at, closed_at)
values ('3e000000-0000-4000-8000-000000000000', '2e000000-0000-4000-8000-000000000001', 'P old', '2026-10-19', 'closed', now(), now());
insert into public.clusters (id, cycle_id, name, source, sort_order)
values ('4e000000-0000-4000-8000-000000000000', '3e000000-0000-4000-8000-000000000000', 'Old', 'manual', 1);

-- Q1: C's cycle in vote with one cluster.
insert into public.feedback_cycles (id, project_id, title, week_start, status, revealed_at)
values ('3e000000-0000-4000-8000-000000000011', '2e000000-0000-4000-8000-000000000002', 'Q one', '2026-10-26', 'vote', now());
insert into public.clusters (id, cycle_id, name, source, sort_order)
values ('4e000000-0000-4000-8000-000000000011', '3e000000-0000-4000-8000-000000000011', 'QX', 'manual', 1);

insert into public.feedback_cycles (id, project_id, title, week_start)
values ('3e000000-0000-4000-8000-000000000001', '2e000000-0000-4000-8000-000000000001', 'P main', '2026-10-26');

set local role authenticated;
select vt.add_card('A', 'start', 's1', false);
select vt.add_card('B', 'start', 's2', true);
select vt.add_card('D', 'stop', 't1', false);
select vt.add_card('B', 'continue', 'k1', false);
select vt.add_card('D', 'continue', 'a1', true);
reset role;

-- ---------------------------------------------------------------------------
-- The table.
-- ---------------------------------------------------------------------------
select is(
  (select array_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-') order by ordinal_position)
     from information_schema.columns where table_schema = 'public' and table_name = 'votes'),
  array[
    'id:uuid:NO:gen_random_uuid()',
    'cycle_id:uuid:NO:-',
    'cluster_id:uuid:NO:-',
    'voter_id:uuid:YES:-',
    'created_at:timestamp with time zone:NO:now()'
  ],
  'votes has exactly the five columns, with their types, nullability, and defaults'
);
select is(
  (select array_agg(pg_get_constraintdef(c.oid) order by c.conname) from pg_constraint c where c.conrelid = 'public.votes'::regclass and c.contype = 'f'),
  array[
    'FOREIGN KEY (cluster_id, cycle_id) REFERENCES clusters(id, cycle_id) ON DELETE CASCADE',
    'FOREIGN KEY (cycle_id) REFERENCES feedback_cycles(id) ON DELETE CASCADE',
    'FOREIGN KEY (voter_id) REFERENCES auth.users(id) ON DELETE SET NULL'
  ],
  'votes references its cycle, a cluster of that cycle, and the voter (set null)'
);
select is(
  (select array_agg(pg_get_indexdef(i.indexrelid) order by pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid = 'public.votes'::regclass and not i.indisprimary),
  array[
    'CREATE INDEX votes_cluster_id_idx ON public.votes USING btree (cluster_id)',
    'CREATE INDEX votes_cycle_id_voter_id_idx ON public.votes USING btree (cycle_id, voter_id)'
  ],
  'votes is indexed on (cycle_id, voter_id) and on cluster_id'
);
select throws_ok(
  $$ insert into public.votes (cycle_id, cluster_id, voter_id) values ('3e000000-0000-4000-8000-000000000001', '4e000000-0000-4000-8000-000000000011', '1e000000-0000-4000-8000-000000000002') $$,
  '23503', NULL,
  'a vote whose cluster is not of its cycle is a foreign-key violation'
);
select is((select relrowsecurity from pg_class where oid = 'public.votes'::regclass), true, 'votes has RLS enabled');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'votes'), 0, 'votes has no policy');
select is(
  (select array_agg(r || ':' || p order by r, p) from unnest(array['anon', 'authenticated']) r cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege(r, 'public.votes', p)),
  null,
  'anon and authenticated hold none of the seven privileges on votes'
);
select is(
  (select array_agg(p order by p) from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege('service_role', 'public.votes', p)),
  array['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  'service_role holds exactly SELECT, INSERT, UPDATE, DELETE on votes'
);
select is(
  (select count(*)::int from aclexplode((select relacl from pg_class where oid = 'public.votes'::regclass)) a where a.grantee = 0),
  0,
  'PUBLIC holds no privilege on votes'
);
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'votes'), 0, 'votes is not in supabase_realtime');
select is(
  (select count(*)::int
     from pg_depend d
     join pg_rewrite rw on rw.oid = d.objid
     join pg_class v on v.oid = rw.ev_class
     join pg_namespace n on n.oid = v.relnamespace
    where d.refobjid = 'public.votes'::regclass and n.nspname = 'public' and v.relkind in ('v', 'm')),
  0,
  'no view in public depends on votes'
);

-- ---------------------------------------------------------------------------
-- RPC hardening.
-- ---------------------------------------------------------------------------
create table vt.rpcs (name text primary key, fn regprocedure not null, sig text not null, raises text[] not null);
insert into vt.rpcs (name, fn, sig, raises)
values
  ('cast_vote', 'public.cast_vote(uuid, uuid)', 'p_cycle_id uuid, p_cluster_id uuid -> TABLE(cluster_id uuid, vote_count integer, votes_remaining integer)',
    array['42501:not_project_member', '42501:not_project_member', 'P0001:cycle_not_voting', 'P0001:cluster_not_found', 'P0001:no_votes_remaining']),
  ('remove_vote', 'public.remove_vote(uuid, uuid)', 'p_cycle_id uuid, p_cluster_id uuid -> TABLE(cluster_id uuid, vote_count integer, votes_remaining integer)',
    array['42501:not_project_member', '42501:not_project_member', 'P0001:cycle_not_voting', 'P0001:cluster_not_found', 'P0001:no_vote_to_remove']),
  ('get_vote_totals', 'public.get_vote_totals(uuid)', 'p_cycle_id uuid -> TABLE(cluster_id uuid, total_votes integer)',
    array['42501:not_project_member', '42501:not_project_member', 'P0001:voting_not_closed']);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = r.name),
  1,
  r.name || ' has exactly one overload'
) from vt.rpcs r order by r.name;
select is(
  pg_get_function_identity_arguments(r.fn) || ' -> ' || pg_get_function_result(r.fn),
  r.sig,
  r.name || ' has the agreed signature and takes no user id'
) from vt.rpcs r order by r.name;
select is(
  (select p.prosecdef and p.proconfig = array['search_path=""']::text[] from pg_proc p where p.oid = r.fn),
  true,
  r.name || ' is security definer with search_path fixed to empty'
) from vt.rpcs r order by r.name;
select is(
  (select array_agg(p.provolatile::text order by p.proname) from pg_proc p where p.oid in ('public.cast_vote(uuid, uuid)'::regprocedure, 'public.remove_vote(uuid, uuid)'::regprocedure, 'public.get_vote_totals(uuid)'::regprocedure)),
  array['v', 's', 'v'],
  'cast_vote and remove_vote are volatile, get_vote_totals is stable'
);
select is(
  array[
    has_function_privilege('authenticated', r.fn, 'EXECUTE'),
    has_function_privilege('anon', r.fn, 'EXECUTE'),
    has_function_privilege('service_role', r.fn, 'EXECUTE'),
    (select (count(*) filter (where a.grantee = 0)) > 0 from pg_proc p left join lateral aclexplode(p.proacl) a on true where p.oid = r.fn)
  ],
  array[true, false, false, false],
  r.name || ' is executable by authenticated only'
) from vt.rpcs r order by r.name;
select is(
  (select array_agg(m[1] || ':' || m[2]) from pg_proc p cross join lateral regexp_matches(p.prosrc, 'raise exception using errcode = ''(42501|P0001)'', message = ''([a-z_]+)'';', 'g') m where p.oid = r.fn),
  r.raises,
  r.name || ' raises exactly its codes, with errcode and message only'
) from vt.rpcs r order by r.name;
select is(
  (select (select count(*)::int from regexp_matches(p.prosrc, '\mraise\M', 'gi')) from pg_proc p where p.oid = r.fn),
  array_length(r.raises, 1),
  r.name || ' has no other raise'
) from vt.rpcs r order by r.name;
select is(
  (select p.prosrc ~* '(detail|hint)' from pg_proc p where p.oid = r.fn),
  false,
  r.name || ' sets no detail or hint'
) from vt.rpcs r order by r.name;
select is(
  (select p.prosrc ~* '(card_authors|profiles|cycle_events|owner_id|is_project_facilitator|execute|raise\s+notice)' from pg_proc p where p.oid = r.fn),
  false,
  r.name || ' mentions no card_authors, profiles, cycle_events, owner_id, is_project_facilitator, execute, or raise notice'
) from vt.rpcs r order by r.name;
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc ~ '\mvotes\M'),
  array['cast_vote', 'get_cycle_board', 'get_vote_totals', 'remove_vote'],
  'only cast_vote, remove_vote, get_vote_totals, and get_cycle_board mention votes'
);
select is((select md5(prosrc) from pg_proc where oid = 'public.get_cycle_status(uuid)'::regprocedure), '661b0029cf574548210d6a862fadd68d', 'get_cycle_status is unchanged');

-- Locking: the cycle row FOR UPDATE before the status check and before any
-- read or write of votes; no projects lock.
select is(
  (select
     strpos(p.prosrc, 'from public.feedback_cycles fc
   where fc.id = p_cycle_id
     for update') > 0
     and strpos(p.prosrc, 'for update') < strpos(p.prosrc, 'cycle_status is distinct from ''vote''')
     and strpos(p.prosrc, 'for update') < strpos(p.prosrc, 'public.votes')
     and strpos(p.prosrc, 'private.is_project_member') < strpos(p.prosrc, 'for update')
     and (select count(*) from regexp_matches(p.prosrc, 'for (update|share)', 'gi')) = 1
     and p.prosrc !~* 'public\.projects'
   from pg_proc p where p.oid = r.fn),
  true,
  r.name || ' locks only the cycle row FOR UPDATE, before the status check and any use of votes'
) from vt.rpcs r where r.name <> 'get_vote_totals' order by r.name;

-- get_cycle_board reads votes only for the caller.
select is(
  (select (select count(*)::int from regexp_matches(p.prosrc, 'public\.votes', 'g')) from pg_proc p where p.oid = 'public.get_cycle_board(uuid)'::regprocedure),
  1,
  'get_cycle_board reads votes in one place'
);
select is(
  (select p.prosrc ~ 'from public\.votes v\s+join public\.clusters cl on cl\.id = v\.cluster_id\s+where v\.cycle_id = p_cycle_id\s+and v\.voter_id = \(select auth\.uid\(\)\)' from pg_proc p where p.oid = 'public.get_cycle_board(uuid)'::regprocedure),
  true,
  'get_cycle_board reads votes only with voter_id = (select auth.uid())'
);

-- ---------------------------------------------------------------------------
-- Before vote: collecting, reveal, cluster.
-- ---------------------------------------------------------------------------
set local role authenticated;
select is(vt.cast('B', 'random'), vt.e('cycle_not_voting'), 'collecting: cast_vote gets cycle_not_voting');
select is(vt.remove('B', 'random'), vt.e('cycle_not_voting'), 'collecting: remove_vote gets cycle_not_voting');
select is(array[vt.totals('A'), vt.totals('B'), vt.totals('D')], array[vt.e('voting_not_closed'), vt.e('voting_not_closed'), vt.e('voting_not_closed')], 'collecting: A, B, D get voting_not_closed');
select is(vt.mine(vt.board('B')), jsonb_build_object('my_votes', '[]'::jsonb, 'votes_remaining', 3), 'collecting: my_votes [] and votes_remaining 3');

select vt.start('A');
select is(vt.cast('B', 'random'), vt.e('cycle_not_voting'), 'reveal: cast_vote gets cycle_not_voting');
select is(vt.remove('B', 'random'), vt.e('cycle_not_voting'), 'reveal: remove_vote gets cycle_not_voting');
select is(array[vt.totals('A'), vt.totals('B'), vt.totals('D')], array[vt.e('voting_not_closed'), vt.e('voting_not_closed'), vt.e('voting_not_closed')], 'reveal: A, B, D get voting_not_closed');
select is(vt.mine(vt.board('D')), jsonb_build_object('my_votes', '[]'::jsonb, 'votes_remaining', 3), 'reveal: my_votes [] and votes_remaining 3');

select vt.advance('A', 'reveal');
select vt.mk('A', 'X');
select vt.mk('A', 'Y');
select vt.mk('A', 'Z');
select vt.mk('A', 'Empty');
select vt.move('A', 's1', 'X');
select vt.move('A', 's2', 'X');
select vt.move('A', 't1', 'Y');
select vt.move('A', 'k1', 'Z');
reset role;

set local role service_role;
do $$
declare
  run uuid;
begin
  run := (public.begin_ai_clustering(vt.id('P1'), vt.id('A'), 'claude-opus-5-5', 'cluster-feedback/v1') ->> 'run_id')::uuid;
  perform public.replace_ai_clusters(
    run, vt.id('A'),
    jsonb_build_array(jsonb_build_object('name', 'AI', 'category', 'continue', 'card_ids', jsonb_build_array(vt.id('a1')))),
    '{}'::jsonb
  );
end;
$$;
reset role;
insert into vt.ids (label, id) select 'AI', cl.id from public.clusters cl where cl.cycle_id = vt.id('P1') and cl.source = 'ai';
select is((select count(*)::int from public.clusters where cycle_id = vt.id('P1') and source = 'ai'), 1, 'P1 has one AI cluster');
select is((select count(*)::int from public.cluster_cards where cluster_id = vt.id('Empty')), 0, 'Empty has no cards');

set local role authenticated;
select is(vt.cast('B', 'X'), vt.e('cycle_not_voting'), 'cluster: cast_vote gets cycle_not_voting');
select is(vt.remove('B', 'X'), vt.e('cycle_not_voting'), 'cluster: remove_vote gets cycle_not_voting');
select is(array[vt.totals('A'), vt.totals('B'), vt.totals('D')], array[vt.e('voting_not_closed'), vt.e('voting_not_closed'), vt.e('voting_not_closed')], 'cluster: A, B, D get voting_not_closed');
select is(vt.mine(vt.board('A')), jsonb_build_object('my_votes', '[]'::jsonb, 'votes_remaining', 3), 'cluster: my_votes [] and votes_remaining 3');
reset role;
select is(vt.nvotes(vt.id('P1')), 0, 'nothing was written before vote');

set local role authenticated;
select vt.advance('A', 'cluster');
select is(vt.board('A') ->> 'status', 'vote', 'P1 is in vote');
select is(array[vt.totals('A'), vt.totals('B'), vt.totals('D')], array[vt.e('voting_not_closed'), vt.e('voting_not_closed'), vt.e('voting_not_closed')], 'vote with no votes: A, B, D get voting_not_closed');
select is(vt.mine(vt.board('B')), jsonb_build_object('my_votes', '[]'::jsonb, 'votes_remaining', 3), 'vote: a member with no votes has my_votes [] and votes_remaining 3');

-- ---------------------------------------------------------------------------
-- Board keys.
-- ---------------------------------------------------------------------------
select is(
  (select array_agg(k order by k) from jsonb_object_keys(vt.board('B')) k),
  array['cards', 'clusters', 'cycle_id', 'is_revealed', 'my_votes', 'status', 'votes_remaining'],
  'get_cycle_board returns exactly seven top-level keys'
);
select is(
  (select bool_and((select array_agg(k order by k) from jsonb_object_keys(c) k) = array['card_ids', 'cluster_id', 'name', 'source']) from jsonb_array_elements(vt.board('B') -> 'clusters') c),
  true,
  'every cluster still has exactly cluster_id, name, source, card_ids'
);
select is(
  (select array_agg((c ->> 'cluster_id')::uuid order by o) from jsonb_array_elements(vt.board('B') -> 'clusters') with ordinality x(c, o)),
  array[vt.id('X'), vt.id('Y'), vt.id('Z'), vt.id('Empty'), vt.id('AI')],
  'clusters keep their sort order'
);

-- ---------------------------------------------------------------------------
-- No side effects, budget, and remove (B on X).
-- ---------------------------------------------------------------------------
reset role;
select vt.snap('others', to_jsonb(vt.others_state()));
set local role authenticated;
select vt.snap('board D', vt.board('D'));
select is(vt.cast('B', 'X'), '[1, 2]'::jsonb, 'B casts on X: 1 on X, 2 remaining');
reset role;
select is(to_jsonb(vt.others_state()), vt.snapped('others'), 'a cast changes no cycle, member, cluster, or cluster_cards row and records no event');
set local role authenticated;
select is(vt.cast('B', 'X'), '[2, 1]'::jsonb, 'B stacks a second vote on X: 2 on X, 1 remaining');
select is(vt.cast('B', 'X'), '[3, 0]'::jsonb, 'B stacks a third vote on X: 3 on X, 0 remaining');
reset role;
select vt.snap('votes', to_jsonb(vt.votes_state()));
set local role authenticated;
select is(vt.cast('B', 'X'), vt.e('no_votes_remaining'), 'a 4th cast on X gets no_votes_remaining');
select is(vt.cast('B', 'Y'), vt.e('no_votes_remaining'), 'a 4th cast on Y gets no_votes_remaining');
reset role;
select is(to_jsonb(vt.votes_state()), vt.snapped('votes'), 'the refused casts leave votes unchanged');
select is(vt.nvotes_of(vt.id('P1'), vt.id('B'), vt.id('X')), 3, 'B holds 3 rows on X');
set local role authenticated;
select is(vt.mine(vt.board('B')), jsonb_build_object('my_votes', vt.mv(array['X'], array[3]), 'votes_remaining', 0), 'B''s board: 3 on X, 0 remaining');
select is(vt.board('D'), vt.snapped('board D'), 'D''s board did not change while B voted');

select is(vt.remove('B', 'Y'), vt.e('no_vote_to_remove'), 'removing from Y, where B has no vote, gets no_vote_to_remove');
select is(vt.remove('B', 'X'), '[2, 1]'::jsonb, 'removing one of 3 stacked votes: 2 on X, 1 remaining');
reset role;
select is(vt.nvotes_of(vt.id('P1'), vt.id('B'), vt.id('X')), 2, 'exactly one row was deleted');
select is(to_jsonb(vt.others_state()), vt.snapped('others'), 'a remove changes no cycle, member, cluster, or cluster_cards row and records no event');
set local role authenticated;
select is(vt.remove('B', 'X'), '[1, 2]'::jsonb, 'B removes a second vote');
select is(vt.remove('B', 'X'), '[0, 3]'::jsonb, 'B removes the last vote and is back to 3 remaining');
select is(vt.remove('B', 'X'), vt.e('no_vote_to_remove'), 'a further remove gets no_vote_to_remove');
select is(vt.mine(vt.board('B')), jsonb_build_object('my_votes', '[]'::jsonb, 'votes_remaining', 3), 'B''s board: my_votes [] and 3 remaining');

-- Spread and move.
select is(vt.cast('B', 'X'), '[1, 2]'::jsonb, 'B casts on X');
select is(vt.cast('B', 'Y'), '[1, 1]'::jsonb, 'B casts on Y');
select is(vt.cast('B', 'Z'), '[1, 0]'::jsonb, 'B casts on Z');
select is(vt.remove('B', 'X'), '[0, 1]'::jsonb, 'B moves a vote: remove from X');
select is(vt.cast('B', 'Y'), '[2, 0]'::jsonb, 'B moves a vote: cast on Y');
select is(vt.mine(vt.board('B')), jsonb_build_object('my_votes', vt.mv(array['Y', 'Z'], array[2, 1]), 'votes_remaining', 0), 'B has 0 on X, 2 on Y, 1 on Z, and 0 remaining');
select is(
  (select bool_and((select array_agg(k order by k) from jsonb_object_keys(e) k) = array['cluster_id', 'vote_count']) from jsonb_array_elements(vt.board('B') -> 'my_votes') e),
  true,
  'each my_votes element has exactly cluster_id and vote_count'
);

-- ---------------------------------------------------------------------------
-- The facilitator and owner, a zero-card cluster, and an AI cluster.
-- ---------------------------------------------------------------------------
select vt.snap('board B', vt.board('B'));
select is(vt.cast('A', 'X'), '[1, 2]'::jsonb, 'A (owner and facilitator) casts on X');
select is(vt.cast('A', 'X'), '[2, 1]'::jsonb, 'A stacks on X');
select is(vt.cast('A', 'Empty'), '[1, 0]'::jsonb, 'A casts on the zero-card cluster');
select is(vt.cast('A', 'Empty'), vt.e('no_votes_remaining'), 'A''s 4th cast gets no_votes_remaining');

select is(vt.cast('D', 'AI'), '[1, 2]'::jsonb, 'D casts on the AI cluster');
select is(vt.cast('D', 'AI'), '[2, 1]'::jsonb, 'D stacks on the AI cluster');
select is(vt.remove('D', 'AI'), '[1, 2]'::jsonb, 'D removes one vote from the AI cluster');
select is(vt.cast('D', 'Empty'), '[1, 1]'::jsonb, 'D casts on the zero-card cluster');
select is(vt.cast('D', 'Empty'), '[2, 0]'::jsonb, 'D stacks on the zero-card cluster');
select is(vt.remove('D', 'Empty'), '[1, 1]'::jsonb, 'D removes one vote from the zero-card cluster');
select is(vt.cast('D', 'Empty'), '[2, 0]'::jsonb, 'D casts on the zero-card cluster again');
select is(vt.board('B'), vt.snapped('board B'), 'B''s board did not change while A and D voted');
select is(vt.mine(vt.board('D')), jsonb_build_object('my_votes', vt.mv(array['Empty', 'AI'], array[2, 1]), 'votes_remaining', 0), 'D''s my_votes are in cluster sort order');
select is(vt.mine(vt.board('A')), jsonb_build_object('my_votes', vt.mv(array['X', 'Empty'], array[2, 1]), 'votes_remaining', 0), 'A''s board: 2 on X, 1 on Empty');
select is(vt.shared(vt.board('A')), vt.shared(vt.board('B')), 'A''s and B''s boards differ only in is_mine, my_votes, and votes_remaining');
select is(vt.shared(vt.board('D')), vt.shared(vt.board('B')), 'D''s and B''s boards differ only in is_mine, my_votes, and votes_remaining');

select is(array[vt.totals('A'), vt.totals('B'), vt.totals('D')], array[vt.e('voting_not_closed'), vt.e('voting_not_closed'), vt.e('voting_not_closed')], 'vote with every member at 3 votes: A, B, D get voting_not_closed');

-- transfer_facilitator during vote changes no vote or budget.
select vt.snap('mine A', vt.mine(vt.board('A')));
select vt.snap('mine B', vt.mine(vt.board('B')));
select vt.transfer('A', 'B');
select is(vt.mine(vt.board('A')), vt.snapped('mine A'), 'after transfer_facilitator(P, B), A keeps its votes and budget');
select is(vt.mine(vt.board('B')), vt.snapped('mine B'), 'after transfer_facilitator(P, B), B keeps its votes and budget');
select is(vt.cast('A', 'Y'), vt.e('no_votes_remaining'), 'the former facilitator still has 3 votes, no more');
select is(vt.cast('B', 'Y'), vt.e('no_votes_remaining'), 'the new facilitator still has 3 votes, no more');
select vt.transfer('A', 'A');

-- ---------------------------------------------------------------------------
-- Wrong cluster and access.
-- ---------------------------------------------------------------------------
select is(vt.vote_raw('cast', 'B', vt.id('P1'), null), vt.e('cluster_not_found'), 'cast with a null cluster id gets cluster_not_found');
select is(vt.vote_raw('remove', 'B', vt.id('P1'), null), vt.e('cluster_not_found'), 'remove with a null cluster id gets cluster_not_found');
select is(vt.cast('D', 'random'), vt.e('cluster_not_found'), 'cast with a random cluster id gets cluster_not_found');
select is(vt.remove('D', 'random'), vt.e('cluster_not_found'), 'remove with a random cluster id gets cluster_not_found');
select is(vt.cast('D', 'Old'), vt.e('cluster_not_found'), 'cast on a cluster of another cycle in P gets cluster_not_found');
select is(vt.remove('D', 'Old'), vt.e('cluster_not_found'), 'remove on a cluster of another cycle in P gets cluster_not_found');
select is(vt.cast('D', 'QX'), vt.e('cluster_not_found'), 'cast on a cluster of project Q gets cluster_not_found');
select is(vt.remove('D', 'QX'), vt.e('cluster_not_found'), 'remove on a cluster of project Q gets cluster_not_found');

select is(
  array[vt.cast('C', 'X'), vt.remove('C', 'X'), vt.totals('C'), vt.board('C')],
  array[vt.e('not_project_member'), vt.e('not_project_member'), vt.e('not_project_member'), vt.e('not_project_member')],
  'non-member C gets not_project_member from all four functions'
);
select is(
  array[vt.cast(null, 'X'), vt.remove(null, 'X'), vt.totals(null), vt.board(null)],
  array[vt.e('not_project_member'), vt.e('not_project_member'), vt.e('not_project_member'), vt.e('not_project_member')],
  'a null user gets not_project_member from all four functions'
);
select is(
  array[vt.vote_raw('cast', 'B', null, vt.id('X')), vt.vote_raw('remove', 'B', null, vt.id('X')), vt.totals_raw('B', null), vt.board_raw('B', null)],
  array[vt.e('not_project_member'), vt.e('not_project_member'), vt.e('not_project_member'), vt.e('not_project_member')],
  'a null cycle id gets not_project_member from all four functions'
);
select is(
  array[vt.cast('B', 'X', 'random'), vt.remove('B', 'X', 'random'), vt.totals('B', 'random'), vt.board('B', 'random')],
  array[vt.e('not_project_member'), vt.e('not_project_member'), vt.e('not_project_member'), vt.e('not_project_member')],
  'a random cycle id gets not_project_member from all four functions'
);
select is(
  array[vt.cast('B', 'QX', 'Q1'), vt.remove('B', 'QX', 'Q1'), vt.totals('B', 'Q1'), vt.board('B', 'Q1')],
  array[vt.cast('B', 'QX', 'random'), vt.remove('B', 'QX', 'random'), vt.totals('B', 'random'), vt.board('B', 'random')],
  'a cycle of project Q answers exactly as a random id'
);

-- ---------------------------------------------------------------------------
-- Mid-vote join, and a voter deleted during vote.
-- ---------------------------------------------------------------------------
select vt.join('E', vt.invite('A'));
select is(vt.mine(vt.board('E')), jsonb_build_object('my_votes', '[]'::jsonb, 'votes_remaining', 3), 'E joins during vote with 3 votes');
select is(vt.cast('E', 'Z'), '[1, 2]'::jsonb, 'E can cast at once');
select vt.snap('mine all', jsonb_build_array(vt.mine(vt.board('A')), vt.mine(vt.board('B')), vt.mine(vt.board('D'))));
reset role;
delete from auth.users where id = vt.id('E');
select is(vt.nvotes_of(vt.id('P1'), null, vt.id('Z')), 1, 'deleting E during vote keeps E''s vote with voter_id null');
set local role authenticated;
select is(jsonb_build_array(vt.mine(vt.board('A')), vt.mine(vt.board('B')), vt.mine(vt.board('D'))), vt.snapped('mine all'), 'the orphaned vote is in nobody''s my_votes or budget');

-- ---------------------------------------------------------------------------
-- Gate open: discuss, then closed.
-- ---------------------------------------------------------------------------
reset role;
update public.feedback_cycles set status = 'discuss', voting_closed_at = now() where id = vt.id('P1');
set local role authenticated;
select vt.snap('totals', vt.totals('A'));
select is(vt.totals('B'), vt.snapped('totals'), 'discuss: B gets the same totals as A');
select is(vt.totals('D'), vt.snapped('totals'), 'discuss: D gets the same totals as A');
select is(
  (select array_agg((t ->> 'cluster_id')::uuid order by o) from jsonb_array_elements(vt.snapped('totals')) with ordinality x(t, o)),
  array[vt.id('Empty'), vt.id('X'), vt.id('Y'), vt.id('Z'), vt.id('AI')],
  'one row per cluster, by total desc, then sort_order (X, Y, Z tie at 2)'
);
select is(
  (select array_agg((t ->> 'total_votes')::int order by o) from jsonb_array_elements(vt.snapped('totals')) with ordinality x(t, o)),
  array[3, 2, 2, 2, 1],
  'the totals include the orphaned vote'
);
select is(
  (select bool_and((select array_agg(k order by k) from jsonb_object_keys(t) k) = array['cluster_id', 'total_votes']) from jsonb_array_elements(vt.snapped('totals')) t),
  true,
  'each row has exactly cluster_id and total_votes'
);
reset role;
select is(
  (select jsonb_object_agg(t ->> 'cluster_id', (t ->> 'total_votes')::int) from jsonb_array_elements(vt.snapped('totals')) t),
  vt.row_totals(),
  'each total equals that cluster''s row count in votes'
);
set local role authenticated;
select is(vt.mine(vt.board('B')), jsonb_build_object('my_votes', vt.mv(array['Y', 'Z'], array[2, 1]), 'votes_remaining', 0), 'discuss: the board still shows B''s own votes');
select is(vt.cast('A', 'Y'), vt.e('cycle_not_voting'), 'discuss: cast_vote gets cycle_not_voting');
select is(vt.remove('B', 'Y'), vt.e('cycle_not_voting'), 'discuss: remove_vote by a member holding votes gets cycle_not_voting');

reset role;
update public.feedback_cycles set status = 'closed', closed_at = now() where id = vt.id('P1');
set local role authenticated;
select is(array[vt.totals('A'), vt.totals('B'), vt.totals('D')], array[vt.snapped('totals'), vt.snapped('totals'), vt.snapped('totals')], 'closed: A, B, D get the same totals');
select is(vt.cast('A', 'Y'), vt.e('cycle_not_voting'), 'closed: cast_vote gets cycle_not_voting');
select is(vt.remove('B', 'Y'), vt.e('cycle_not_voting'), 'closed: remove_vote by a member holding votes gets cycle_not_voting');
reset role;
select is(to_jsonb(vt.votes_state()) is not null and vt.nvotes(vt.id('P1')) = 10, true, 'P1 still holds its 10 votes');

-- ---------------------------------------------------------------------------
-- P2: closed from vote with close_cycle. voting_closed_at stays null.
-- ---------------------------------------------------------------------------
insert into public.feedback_cycles (id, project_id, title, week_start, status, revealed_at)
values ('3e000000-0000-4000-8000-000000000002', '2e000000-0000-4000-8000-000000000001', 'P next', '2026-11-02', 'vote', now());
insert into public.clusters (id, cycle_id, name, source, sort_order)
values ('4e000000-0000-4000-8000-000000000002', '3e000000-0000-4000-8000-000000000002', 'P2X', 'manual', 1);
set local role authenticated;
select is(vt.cast('B', 'P2X', 'P2'), '[1, 2]'::jsonb, 'B casts in P2');
select vt.close('A', 'P2');
select is(array[vt.totals('A', 'P2'), vt.totals('B', 'P2'), vt.totals('D', 'P2')], array[vt.e('voting_not_closed'), vt.e('voting_not_closed'), vt.e('voting_not_closed')], 'a cycle closed from vote never shows totals');
reset role;
select is((select voting_closed_at from public.feedback_cycles where id = vt.id('P2')), null, 'close_cycle leaves voting_closed_at null');
delete from public.feedback_cycles where id = vt.id('P2');
select is(vt.nvotes(vt.id('P2')), 0, 'deleting a cycle removes its votes');

-- Deleting a cluster removes its votes.
set local role authenticated;
select is(vt.cast('C', 'QX', 'Q1'), '[1, 2]'::jsonb, 'C casts in Q1');
reset role;
delete from public.clusters where id = vt.id('QX');
select is(vt.nvotes(vt.id('Q1')), 0, 'deleting a cluster removes its votes');

-- ---------------------------------------------------------------------------
-- A voter deleted after close.
-- ---------------------------------------------------------------------------
delete from auth.users where id = vt.id('B');
select is(vt.nvotes_of(vt.id('P1'), null, vt.id('Y')), 2, 'deleting B keeps B''s votes on Y with voter_id null');
select is(vt.nvotes_of(vt.id('P1'), null, vt.id('Z')), 2, 'and on Z (with E''s orphaned vote)');
set local role authenticated;
select is(vt.totals('A'), vt.snapped('totals'), 'the totals still count B''s votes');
reset role;

-- No returned number was ever out of range.
select is(
  (select bool_and(r.vote_count between 0 and 3 and r.votes_remaining between 0 and 3) from vt.results r),
  true,
  'no returned vote_count or votes_remaining was below 0 or above 3'
);

select * from finish();

rollback;
