-- Local development seed user.
--
-- Seed user UUID: 00000000-0000-4000-8000-000000000001
-- Email:          dev@example.com
-- Password:       password123
-- Mailpit URL:    http://127.0.0.1:54324 (local email UI, port 54324)
--
-- This user exists only for local development so the team has a stable
-- identity while building the app. The password is not a product sign-in
-- method: never reuse it outside local development.
--
-- The auth.users insert fires private.handle_new_user(), which creates the
-- matching public.profiles row. This seed deliberately does not insert into
-- public.profiles and never disables triggers. Both inserts are idempotent on
-- the real unique constraints so running the seed twice is safe.
--
-- The bcrypt hash below is for the documented local-only password above. It is
-- not a secret and must not be reused for any other environment.

begin;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  confirmation_token,
  recovery_token,
  email_change_token_new,
  email_change,
  email_change_token_current,
  reauthentication_token,
  phone_change,
  phone_change_token,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'dev@example.com',
  '$2a$10$8FjF/eaIkYiHpwute4O8.uwMPU78vePPo0ucEoRPoc3pV8yZsj0pK',
  now(),
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Dev User"}'::jsonb,
  now(),
  now()
)
on conflict (id) do nothing;

insert into auth.identities (
  provider_id,
  user_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
values (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  '{"sub":"00000000-0000-4000-8000-000000000001","email":"dev@example.com","email_verified":true}'::jsonb,
  'email',
  now(),
  now(),
  now()
)
on conflict (provider_id, provider) do nothing;

commit;
