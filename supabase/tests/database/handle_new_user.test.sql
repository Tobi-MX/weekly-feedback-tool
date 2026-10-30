-- pgTAP tests for private.handle_new_user(): display-name fallbacks, avatar
-- precedence, malformed metadata, idempotency, and auth updates.
--
-- Everything runs in one transaction and is rolled back at the end, including
-- the pgTAP extension itself. The seed user is never used as a fixture.

begin;

create extension if not exists pgtap with schema extensions;

set local search_path = public, extensions;

select plan(52);

-- ---------------------------------------------------------------------------
-- Fixtures. Inserting auth.users rows fires private.handle_new_user().
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000'::uuid, v.id, 'authenticated', 'authenticated', v.email, v.metadata
from (values
  ('10000000-0000-4000-8000-000000000001'::uuid, 'fixture-a@example.com'::text, '{"display_name":"Alice"}'::jsonb),
  ('10000000-0000-4000-8000-000000000005'::uuid, 'fixture-e@example.com'::text, '{"display_name":"Echo"}'::jsonb),
  ('20000000-0000-4000-8000-000000000001'::uuid, 'f1@example.com'::text, '{"display_name":"Dev User","full_name":"Other"}'::jsonb),
  ('20000000-0000-4000-8000-000000000002'::uuid, 'f2@example.com'::text, '{"display_name":"   ","full_name":"Full Name"}'::jsonb),
  ('20000000-0000-4000-8000-000000000003'::uuid, 'f3@example.com'::text, '{"display_name":null,"full_name":null,"name":"Name User"}'::jsonb),
  ('20000000-0000-4000-8000-000000000004'::uuid, 'f4@example.com'::text, '{"display_name":42,"full_name":"Full Fallback"}'::jsonb),
  ('20000000-0000-4000-8000-000000000005'::uuid, 'f5@example.com'::text, '{"full_name":"  ","name":"Name Fallback"}'::jsonb),
  ('20000000-0000-4000-8000-000000000006'::uuid, 'local@f6.example'::text, '{"name":"   "}'::jsonb),
  ('20000000-0000-4000-8000-000000000007'::uuid, 'dev@f7.example'::text, '{}'::jsonb),
  ('20000000-0000-4000-8000-000000000008'::uuid, NULL::text, '{}'::jsonb),
  ('20000000-0000-4000-8000-000000000009'::uuid, '@example.com'::text, '{}'::jsonb),
  ('20000000-0000-4000-8000-000000000010'::uuid, '   @example.com'::text, '{}'::jsonb),
  ('20000000-0000-4000-8000-000000000011'::uuid, 'f11@example.com'::text, jsonb_build_object('display_name', E'\t Dev \n User \r')),
  ('20000000-0000-4000-8000-000000000012'::uuid, 'f12@example.com'::text, jsonb_build_object('display_name', repeat('a', 150))),
  ('20000000-0000-4000-8000-000000000013'::uuid, 'f13@example.com'::text, jsonb_build_object('display_name', repeat('b', 100))),
  ('20000000-0000-4000-8000-000000000014'::uuid, 'f14@example.com'::text, jsonb_build_object('display_name', repeat('é', 101))),
  ('20000000-0000-4000-8000-000000000015'::uuid, 'local@f15.example'::text, '{}'::jsonb),
  ('20000000-0000-4000-8000-000000000016'::uuid, 'local@f16.example'::text, '{"display_name":"","full_name":"","name":""}'::jsonb),
  ('20000000-0000-4000-8000-000000000017'::uuid, 'local@f17.example'::text, '{"display_name":null,"full_name":null,"name":null}'::jsonb),
  ('20000000-0000-4000-8000-000000000018'::uuid, 'local@f18.example'::text, '{"display_name":true,"full_name":123,"name":["x"]}'::jsonb),
  ('20000000-0000-4000-8000-000000000019'::uuid, 'local@f19.example'::text, '{"display_name":{"a":1},"full_name":[1],"name":false}'::jsonb),
  ('20000000-0000-4000-8000-000000000026'::uuid, '  spaced@example.com'::text, '{}'::jsonb),
  ('20000000-0000-4000-8000-000000000027'::uuid, 'f27@example.com'::text, jsonb_build_object('display_name', E'Tab\tInside')),
  ('21000000-0000-4000-8000-000000000001'::uuid, 'g1@example.com'::text, '{"display_name":"G1","avatar_url":"https://a.example/avatar.png","picture":"https://a.example/picture.png"}'::jsonb),
  ('21000000-0000-4000-8000-000000000002'::uuid, 'g2@example.com'::text, '{"display_name":"G2","avatar_url":"   ","picture":"https://a.example/picture.png"}'::jsonb),
  ('21000000-0000-4000-8000-000000000003'::uuid, 'g3@example.com'::text, '{"display_name":"G3","avatar_url":42,"picture":" https://a.example/picture.png "}'::jsonb),
  ('21000000-0000-4000-8000-000000000004'::uuid, 'g4@example.com'::text, '{"display_name":"G4","avatar_url":"  https://a.example/avatar.png  "}'::jsonb),
  ('21000000-0000-4000-8000-000000000005'::uuid, 'g5@example.com'::text, '{"display_name":"G5","avatar_url":"","picture":""}'::jsonb),
  ('21000000-0000-4000-8000-000000000006'::uuid, 'g6@example.com'::text, '{"display_name":"G6"}'::jsonb),
  ('21000000-0000-4000-8000-000000000007'::uuid, 'g7@example.com'::text, '{"display_name":"G7","avatar_url":null,"picture":null}'::jsonb),
  ('21000000-0000-4000-8000-000000000008'::uuid, 'g8@example.com'::text, '{"display_name":"G8","avatar_url":["x"],"picture":false}'::jsonb)
) as v(id, email, metadata);

-- ---------------------------------------------------------------------------
-- display_name source precedence and trimming.
-- ---------------------------------------------------------------------------
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000001'), 'Dev User', 'display_name metadata wins over full_name');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000002'), 'Full Name', 'blank display_name falls back to full_name');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000003'), 'Name User', 'null display_name and full_name fall back to name');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000004'), 'Full Fallback', 'non-string display_name falls back to full_name');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000005'), 'Name Fallback', 'blank full_name falls back to name');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000006'), 'local', 'blank name falls back to the email local part');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000007'), 'dev', 'email-only signup uses the full local part, not the domain');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000008'), 'Member', 'null email produces Member');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000009'), 'Member', '@example.com produces Member');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000010'), 'Member', 'a local part blank after trimming produces Member');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000011'), E'Dev \n User', 'surrounding ASCII whitespace is trimmed and internal whitespace is preserved');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000012'), repeat('a', 100), 'a source longer than 100 ASCII characters truncates to 100');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000013'), repeat('b', 100), 'a source of exactly 100 characters is preserved');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000014'), repeat('é', 100), 'a 101-character multibyte source truncates to 100 characters');
select is((select char_length(display_name) from public.profiles where id = '20000000-0000-4000-8000-000000000014'), 100, 'the truncated multibyte value is 100 characters');
select is((select octet_length(display_name) from public.profiles where id = '20000000-0000-4000-8000-000000000014'), 200, 'the multibyte truncation did not split a character');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000015'), 'local', 'missing metadata keys fall through to the email local part');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000016'), 'local', 'empty metadata strings fall through to the email local part');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000017'), 'local', 'JSON null metadata values fall through to the email local part');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000018'), 'local', 'boolean, number, and array metadata values are skipped');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000019'), 'local', 'object and boolean metadata values are skipped');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000026'), 'spaced', 'the email local part is trimmed before use');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000027'), E'Tab\tInside', 'an internal tab in display_name is preserved');

-- ---------------------------------------------------------------------------
-- Malformed, non-object, and absent raw_user_meta_data never fail signup.
-- ---------------------------------------------------------------------------
select lives_ok($$ insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000020', 'authenticated', 'authenticated', 'local@f20.example', '"just a string"'::jsonb) $$, 'a non-object string raw_user_meta_data does not fail signup');
select lives_ok($$ insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000021', 'authenticated', 'authenticated', 'local@f21.example', '[1,2,3]'::jsonb) $$, 'a non-object array raw_user_meta_data does not fail signup');
select lives_ok($$ insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000022', 'authenticated', 'authenticated', 'local@f22.example', '42'::jsonb) $$, 'a non-object number raw_user_meta_data does not fail signup');
select lives_ok($$ insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000023', 'authenticated', 'authenticated', 'local@f23.example', 'true'::jsonb) $$, 'a non-object boolean raw_user_meta_data does not fail signup');
select lives_ok($$ insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000024', 'authenticated', 'authenticated', 'local@f24.example', 'null'::jsonb) $$, 'a JSON null raw_user_meta_data does not fail signup');
select lives_ok($$ insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000025', 'authenticated', 'authenticated', 'local@f25.example', null) $$, 'a null raw_user_meta_data does not fail signup');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000020'), 'local', 'a non-object string metadata signup still gets a profile');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000021'), 'local', 'a non-object array metadata signup still gets a profile');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000022'), 'local', 'a non-object number metadata signup still gets a profile');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000023'), 'local', 'a non-object boolean metadata signup still gets a profile');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000024'), 'local', 'a JSON null metadata signup still gets a profile');
select is((select display_name from public.profiles where id = '20000000-0000-4000-8000-000000000025'), 'local', 'a null metadata signup still gets a profile');

-- ---------------------------------------------------------------------------
-- avatar_url precedence and trimming.
-- ---------------------------------------------------------------------------
select is((select avatar_url from public.profiles where id = '21000000-0000-4000-8000-000000000001'), 'https://a.example/avatar.png', 'avatar_url wins over picture');
select is((select avatar_url from public.profiles where id = '21000000-0000-4000-8000-000000000002'), 'https://a.example/picture.png', 'blank avatar_url falls back to picture');
select is((select avatar_url from public.profiles where id = '21000000-0000-4000-8000-000000000003'), 'https://a.example/picture.png', 'non-string avatar_url falls back to a trimmed picture');
select is((select avatar_url from public.profiles where id = '21000000-0000-4000-8000-000000000004'), 'https://a.example/avatar.png', 'avatar_url is trimmed before use');
select is((select avatar_url from public.profiles where id = '21000000-0000-4000-8000-000000000005'), null::text, 'blank avatar_url and picture produce null');
select is((select avatar_url from public.profiles where id = '21000000-0000-4000-8000-000000000006'), null::text, 'missing avatar metadata produces null');
select is((select avatar_url from public.profiles where id = '21000000-0000-4000-8000-000000000007'), null::text, 'JSON null avatar metadata produces null');
select is((select avatar_url from public.profiles where id = '21000000-0000-4000-8000-000000000008'), null::text, 'non-string avatar_url and picture produce null');

-- ---------------------------------------------------------------------------
-- Idempotency: conflict target is id and unrelated errors still surface.
-- ---------------------------------------------------------------------------
select matches((select prosrc from pg_proc where oid = 'private.handle_new_user()'::regprocedure), 'on conflict \(id\) do nothing', 'the profile insert uses an explicit conflict target on id');
select doesnt_match((select prosrc from pg_proc where oid = 'private.handle_new_user()'::regprocedure), 'on conflict do nothing', 'the profile insert is not a bare on conflict');
create temp table signup_idempotency_fixture (
  id uuid,
  email text,
  raw_user_meta_data jsonb
);
create trigger signup_idempotency_fixture_trigger
  after insert on signup_idempotency_fixture
  for each row execute function private.handle_new_user();
select lives_ok($$ insert into signup_idempotency_fixture (id, email, raw_user_meta_data) values ('10000000-0000-4000-8000-000000000001', 'duplicate@example.com', '{"display_name":"Should Not Replace"}') $$, 'firing the trigger for an existing profile id succeeds');
select is((select display_name from public.profiles where id = '10000000-0000-4000-8000-000000000001'), 'Alice', 'an existing profile is unchanged after an idempotent trigger fire');
select is((select count(*)::int from public.profiles where id = '10000000-0000-4000-8000-000000000001'), 1, 'an idempotent trigger fire creates no duplicate profile');
select throws_ok($$ insert into signup_idempotency_fixture (id, email, raw_user_meta_data) values ('30000000-0000-4000-8000-000000000099', 'ghost@example.com', '{"display_name":"Ghost"}') $$, '23503'::char(5), NULL, 'an unrelated profile error still fails the trigger insert');

-- ---------------------------------------------------------------------------
-- Updating auth.users never creates or changes a profile.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.profiles where id = '10000000-0000-4000-8000-000000000005'), 1, 'the fixture signup created exactly one profile');
update auth.users set email = 'fixture-e-updated@example.com', raw_user_meta_data = '{"display_name":"Should Not Apply"}'::jsonb where id = '10000000-0000-4000-8000-000000000005';
select is((select count(*)::int from public.profiles where id = '10000000-0000-4000-8000-000000000005'), 1, 'updating auth.users does not create a second profile');
select is((select display_name from public.profiles where id = '10000000-0000-4000-8000-000000000005'), 'Echo', 'updating auth.users metadata does not change the existing profile');

select * from finish();
rollback;
