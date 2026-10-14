-- MADARA PRINTFLOW database setup
-- Run this entire file in Supabase Dashboard > SQL Editor for the MADARA PRINTFLOW project.
-- After creating your own user account, use the ADMIN BOOTSTRAP section near the end.

create extension if not exists pgcrypto;

create type public.app_role as enum ('admin', 'agent');
create type public.submission_status as enum ('submitted', 'processing', 'ready', 'printed', 'failed');

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  agent_code text unique,
  role public.app_role not null default 'agent',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  reference_code text not null unique default ('MP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  agent_id uuid not null references public.profiles(id) on delete restrict,
  town text not null,
  community text not null,
  ward text not null,
  state text not null,
  report_month date not null,
  area text not null,
  batch text not null,
  card_count integer not null default 0 check (card_count >= 0),
  file_count integer not null default 0 check (file_count >= 0),
  status public.submission_status not null default 'submitted',
  notes text,
  output_path text,
  output_card_count integer,
  output_page_count integer,
  submitted_at timestamptz not null default now(),
  processed_at timestamptz,
  printed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.submission_files (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  agent_id uuid not null references public.profiles(id) on delete restrict,
  original_name text not null,
  storage_path text not null unique,
  mime_type text not null default 'application/pdf',
  file_size_bytes bigint not null default 0 check (file_size_bytes >= 0),
  created_at timestamptz not null default now()
);

create index if not exists submissions_agent_month_idx on public.submissions(agent_id, report_month);
create index if not exists submissions_status_idx on public.submissions(status, submitted_at desc);
create index if not exists submission_files_submission_idx on public.submission_files(submission_id);

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active = true); $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and p.is_active = true); $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id, full_name, role, is_active)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), 'agent', true)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_printflow on auth.users;
create trigger on_auth_user_created_printflow after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public
as $$ begin new.updated_at = now(); return new; end; $$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles for each row execute procedure public.touch_updated_at();
drop trigger if exists submissions_touch_updated_at on public.submissions;
create trigger submissions_touch_updated_at before update on public.submissions for each row execute procedure public.touch_updated_at();

-- Keep submission counts synchronized with actual uploaded PDF file records.
create or replace function public.recount_submission_files()
returns trigger language plpgsql security definer set search_path = public
as $$
declare target_id uuid;
begin
  target_id := coalesce(new.submission_id, old.submission_id);
  update public.submissions s
  set file_count = (select count(*) from public.submission_files f where f.submission_id = target_id),
      card_count = (select count(*) from public.submission_files f where f.submission_id = target_id)
  where s.id = target_id;
  if TG_OP = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists submission_files_recount_insert on public.submission_files;
create trigger submission_files_recount_insert after insert on public.submission_files for each row execute procedure public.recount_submission_files();
drop trigger if exists submission_files_recount_delete on public.submission_files;
create trigger submission_files_recount_delete after delete on public.submission_files for each row execute procedure public.recount_submission_files();

alter table public.profiles enable row level security;
alter table public.submissions enable row level security;
alter table public.submission_files enable row level security;

drop policy if exists "profiles read self or admin" on public.profiles;
create policy "profiles read self or admin" on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
drop policy if exists "admin updates profiles" on public.profiles;
create policy "admin updates profiles" on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "agents and admins read permitted submissions" on public.submissions;
create policy "agents and admins read permitted submissions" on public.submissions for select to authenticated using (agent_id = auth.uid() or public.is_admin());
drop policy if exists "active agents create own submissions" on public.submissions;
create policy "active agents create own submissions" on public.submissions for insert to authenticated with check (agent_id = auth.uid() and public.is_active_user());
drop policy if exists "admins update submissions" on public.submissions;
create policy "admins update submissions" on public.submissions for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read own files or admin" on public.submission_files;
create policy "read own files or admin" on public.submission_files for select to authenticated using (agent_id = auth.uid() or public.is_admin());
drop policy if exists "agents add own files to own submission" on public.submission_files;
create policy "agents add own files to own submission" on public.submission_files for insert to authenticated with check (agent_id = auth.uid() and exists (select 1 from public.submissions s where s.id = submission_id and s.agent_id = auth.uid() and s.status = 'submitted'));
drop policy if exists "agents delete own files before processing" on public.submission_files;
create policy "agents delete own files before processing" on public.submission_files for delete to authenticated using (agent_id = auth.uid() and exists (select 1 from public.submissions s where s.id = submission_id and s.status = 'submitted'));
drop policy if exists "admins update file rows" on public.submission_files;
create policy "admins update file rows" on public.submission_files for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Private buckets. File access policies limit agents to their own folder; administrators can access all.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('printflow-originals', 'printflow-originals', false, 104857600, array['application/pdf','application/zip','application/x-zip-compressed','application/octet-stream'])
on conflict (id) do update set public = false;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('printflow-output', 'printflow-output', false, 524288000, array['application/pdf'])
on conflict (id) do update set public = false;

drop policy if exists "agents upload originals into own folder" on storage.objects;
create policy "agents upload originals into own folder" on storage.objects for insert to authenticated with check (
  bucket_id = 'printflow-originals' and (storage.foldername(name))[1] = auth.uid()::text and public.is_active_user()
);
drop policy if exists "read originals own folder or admin" on storage.objects;
create policy "read originals own folder or admin" on storage.objects for select to authenticated using (
  bucket_id in ('printflow-originals','printflow-output') and (public.is_admin() or (bucket_id = 'printflow-originals' and (storage.foldername(name))[1] = auth.uid()::text))
);
drop policy if exists "agents delete originals own folder" on storage.objects;
create policy "agents delete originals own folder" on storage.objects for delete to authenticated using (
  bucket_id = 'printflow-originals' and (storage.foldername(name))[1] = auth.uid()::text
);

-- ADMIN BOOTSTRAP:
-- 1) Create your user in Authentication > Users (or register through the app).
-- 2) Replace the email below with your own login email and run this statement.
-- update public.profiles p set role = 'admin', full_name = 'MADARA PRINTFLOW ADMIN'
-- from auth.users u where p.id = u.id and lower(u.email) = lower('YOUR-LOGIN-EMAIL');
