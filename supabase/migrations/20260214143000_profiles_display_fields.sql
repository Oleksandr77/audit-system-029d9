-- Ensure profile display fields exist for comment author rendering and admin management.

alter table public.profiles
  add column if not exists full_name text,
  add column if not exists position text,
  add column if not exists phone text,
  add column if not exists company_name text;
