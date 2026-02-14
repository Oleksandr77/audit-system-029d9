-- File-level comments support
alter table public.comments
  add column if not exists file_id uuid null references public.document_files(id) on delete cascade;

create index if not exists idx_comments_file on public.comments(file_id, created_at desc);
