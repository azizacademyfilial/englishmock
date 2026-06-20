-- ENGLISH ENGLISH Mock PostgreSQL schema
-- Run manually if needed, but backend starts and creates these tables automatically.

create table if not exists app_users (
  id text primary key,
  role text not null,
  username text unique not null,
  full_name text,
  subject text,
  is_super boolean not null default false,
  is_active boolean not null default true,
  expires_at text,
  created_at timestamptz,
  session_id text,
  session_updated_at timestamptz,
  data jsonb not null
);
create index if not exists idx_app_users_role on app_users(role);
create index if not exists idx_app_users_subject on app_users(subject);

create table if not exists app_enrollments (
  id text primary key,
  user_id text,
  created_at timestamptz,
  data jsonb not null
);
create index if not exists idx_app_enrollments_user_id on app_enrollments(user_id);

create table if not exists app_progress (
  user_id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists app_certificates (
  id text primary key,
  user_id text,
  code text unique,
  language text,
  level text,
  score numeric,
  created_at timestamptz,
  data jsonb not null
);
create index if not exists idx_app_certificates_user_id on app_certificates(user_id);
create index if not exists idx_app_certificates_code on app_certificates(code);
create index if not exists idx_app_certificates_language on app_certificates(language);

create table if not exists app_meta (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
