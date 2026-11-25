-- Private Letters & Documents storage. Files are always stored in a private
-- bucket under an authenticated user's UUID folder.

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 180),
  classification text not null check (classification in ('Letter', 'Document', 'Note & Idea')),
  note_text text check (note_text is null or char_length(note_text) <= 4000),
  file_name text,
  mime_type text,
  byte_size bigint,
  storage_path text unique,
  created_at timestamptz not null default now(),
  constraint documents_file_metadata_complete check (
    (storage_path is null and file_name is null and mime_type is null and byte_size is null
      and classification = 'Note & Idea' and nullif(btrim(note_text), '') is not null)
    or
    (storage_path is not null and file_name is not null and char_length(file_name) between 1 and 240
      and mime_type is not null and byte_size is not null and mime_type in (
      'application/pdf', 'image/jpeg', 'image/png', 'image/webp'
    ) and byte_size between 1 and 10485760)
  ),
  constraint documents_storage_path_matches_owner check (
    storage_path is null or storage_path like user_id::text || '/%'
  ),
  constraint documents_file_name_is_plain check (
    file_name is null or (position('/' in file_name) = 0 and position(chr(92) in file_name) = 0)
  )
);

create index if not exists documents_user_created_idx
  on public.documents(user_id, created_at desc);

alter table public.documents enable row level security;

drop policy if exists "Users can read their documents" on public.documents;
create policy "Users can read their documents" on public.documents
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Users can create their documents" on public.documents;
create policy "Users can create their documents" on public.documents
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "Users can delete their documents" on public.documents;
create policy "Users can delete their documents" on public.documents
  for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.documents from anon, authenticated;
grant select, insert, delete on public.documents to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'aiask-private-documents',
  'aiask-private-documents',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read their private document files" on storage.objects;
create policy "Users can read their private document files" on storage.objects
  for select to authenticated using (
    bucket_id = 'aiask-private-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can upload their private document files" on storage.objects;
create policy "Users can upload their private document files" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'aiask-private-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete their private document files" on storage.objects;
create policy "Users can delete their private document files" on storage.objects
  for delete to authenticated using (
    bucket_id = 'aiask-private-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
