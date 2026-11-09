-- Test-only stand-in for the subset of Supabase Auth read by the application's migrations.
-- Loaded into a fresh in-memory PGlite database by npm run test:sql, never a deployed database.
-- RLS, SQL functions, triggers, constraints and grants run in real PostgreSQL. These simplified
-- Auth tables do NOT test token signatures, Auth API permissions, MFA enrollment, OAuth code
-- exchange, Supabase's internal constraints, extension versions, or concurrent requests.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth, public to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
-- Match the grants existing migrations explicitly narrow in Supabase's public schema.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create table auth.users (
  instance_id uuid, id uuid primary key, aud text, role text, email text, encrypted_password text,
  email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  created_at timestamptz, updated_at timestamptz
);
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  provider text not null, provider_id text not null, identity_data jsonb not null, last_sign_in_at timestamptz
);
create table auth.mfa_factors (
  id uuid primary key, user_id uuid references auth.users on delete cascade,
  friendly_name text, factor_type text, status text, created_at timestamptz, updated_at timestamptz, secret text
);
create table auth.oauth_clients (
  id uuid primary key, registration_type text, redirect_uris text, grant_types text,
  client_name text, client_type text, token_endpoint_auth_method text, deleted_at timestamptz
);
create table auth.sessions (
  id uuid primary key, user_id uuid references auth.users on delete cascade,
  created_at timestamptz, updated_at timestamptz, aal text, factor_id uuid,
  not_after timestamptz, oauth_client_id uuid
);
create table auth.oauth_authorizations (
  id uuid primary key, authorization_id text, client_id uuid,
  user_id uuid references auth.users on delete cascade, redirect_uri text, scope text,
  status text, created_at timestamptz, expires_at timestamptz
);
create table auth.oauth_consents (
  id uuid primary key default gen_random_uuid(), user_id uuid references auth.users on delete cascade,
  client_id uuid, revoked_at timestamptz
);
