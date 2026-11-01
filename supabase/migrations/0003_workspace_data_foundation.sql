-- AIASK V3 Phase 2.0B: workspace provisioning and legacy-import foundation.
-- This migration does not import, rewrite, or delete Ideas, Tasks, or Calendar rows.
-- Apply through the normal transactional migration process after reviewing the
-- preflight checks. This file is not a claim that production has been migrated.

-- Stop before any schema or data changes if existing workspace state is ambiguous.
do $$
begin
  if to_regclass('public.workspaces') is null
     or to_regclass('public.workspace_members') is null then
    raise exception 'Workspace foundation migration requires 0001_personal_workspaces.sql first.';
  end if;

  if exists (
    select 1
    from public.workspaces
    where kind = 'personal'
    group by owner_id
    having count(*) > 1
  ) then
    raise exception 'Duplicate personal workspaces exist. Review and resolve them before applying 0003; this migration will not merge or delete workspaces.';
  end if;

  if exists (
    select 1
    from public.workspaces w
    join public.workspace_members m
      on m.workspace_id = w.id and m.user_id = w.owner_id
    where w.kind = 'personal' and m.role <> 'owner'
  ) then
    raise exception 'A personal workspace owner has a non-owner membership role. Review the membership before applying 0003.';
  end if;
end;
$$;

-- Enforce at most one personal workspace per auth user. Existing duplicates
-- are rejected by the preflight above; no duplicate is selected or removed.
create unique index if not exists workspaces_one_personal_per_owner_uidx
  on public.workspaces(owner_id)
  where kind = 'personal';

-- Backfill only account-level workspace and membership records. No business
-- content rows are changed. ON CONFLICT makes reruns safe after the index exists.
insert into public.workspaces (name, kind, owner_id)
select 'Personal workspace', 'personal', u.id
from auth.users u
where not exists (
  select 1 from public.workspaces w
  where w.owner_id = u.id and w.kind = 'personal'
)
on conflict (owner_id) where kind = 'personal' do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
select w.id, w.owner_id, 'owner'
from public.workspaces w
where w.kind = 'personal'
on conflict (workspace_id, user_id) do nothing;

-- Keep future signup provisioning consistent with the one-workspace rule.
create or replace function public.create_personal_workspace_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  personal_workspace_id uuid;
begin
  insert into public.workspaces (name, kind, owner_id)
  values ('Personal workspace', 'personal', new.id)
  on conflict (owner_id) where kind = 'personal' do nothing
  returning id into personal_workspace_id;

  if personal_workspace_id is null then
    select w.id into strict personal_workspace_id
    from public.workspaces w
    where w.owner_id = new.id and w.kind = 'personal';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (personal_workspace_id, new.id, 'owner')
  on conflict (workspace_id, user_id) do nothing;

  return new;
end;
$$;

-- Preserve browser fields for a future, separately implemented import. These
-- columns do not add reminder delivery, AI access, or automatic actions.
alter table public.ideas
  add column if not exists progress_updated_at timestamptz;

alter table public.tasks
  add column if not exists due_date date,
  add column if not exists remind_at timestamptz,
  add column if not exists reminded_at timestamptz,
  add column if not exists reminder_pending boolean;

-- Calendar values originate as local date/time strings. Preserve those values
-- when their timezone cannot be established; do not invent starts_at instants.
alter table public.calendar_events
  alter column starts_at drop not null,
  add column if not exists priority text,
  add column if not exists source_local_date text,
  add column if not exists source_local_time text,
  add column if not exists timezone_name text,
  add column if not exists schedule_resolution_status text not null default 'resolved';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.calendar_events'::regclass
      and conname = 'calendar_events_priority_check'
  ) then
    alter table public.calendar_events
      add constraint calendar_events_priority_check
      check (priority is null or priority in ('urgent', 'attention', 'onTrack'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.calendar_events'::regclass
      and conname = 'calendar_events_schedule_resolution_check'
  ) then
    alter table public.calendar_events
      add constraint calendar_events_schedule_resolution_check
      check (
        (schedule_resolution_status = 'resolved' and starts_at is not null)
        or (
          schedule_resolution_status = 'needs_review'
          and starts_at is null
          and source_local_date is not null
        )
      );
  end if;
end;
$$;

-- The ledger stores source IDs, target IDs, hashes, and statuses only; it does
-- not duplicate Idea, Task, or Calendar text. Clients can read but cannot write
-- until a separately reviewed transactional importer is implemented.
create table if not exists public.workspace_import_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  initiated_by uuid not null references auth.users(id) on delete cascade,
  source text not null default 'browser_local_storage'
    check (source in ('browser_local_storage')),
  source_schema_version integer,
  manifest_hash text,
  status text not null default 'previewed'
    check (status in ('previewed', 'confirmed', 'importing', 'partial', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);

create table if not exists public.workspace_import_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  batch_id uuid not null,
  source_key text not null
    check (source_key in ('aiask-idea-box', 'aiask-planner')),
  source_record_id text not null check (char_length(source_record_id) between 1 and 200),
  record_type text not null
    check (record_type in ('idea', 'task', 'calendar_event')),
  target_id uuid,
  payload_hash text check (payload_hash is null or payload_hash ~ '^[0-9a-fA-F]{64}$'),
  status text not null default 'pending'
    check (status in ('pending', 'imported', 'failed', 'skipped', 'needs_review')),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  imported_at timestamptz,
  constraint workspace_import_items_batch_workspace_fk
    foreign key (batch_id, workspace_id)
    references public.workspace_import_batches(id, workspace_id)
    on delete restrict,
  constraint workspace_import_items_source_record_key
    unique (workspace_id, source_key, record_type, source_record_id)
);

create index if not exists workspace_import_batches_workspace_created_idx
  on public.workspace_import_batches(workspace_id, created_at desc);
create index if not exists workspace_import_items_batch_status_idx
  on public.workspace_import_items(batch_id, status);

alter table public.workspace_import_batches enable row level security;
alter table public.workspace_import_items enable row level security;

drop policy if exists "Workspace members can read their import batches"
  on public.workspace_import_batches;
create policy "Workspace members can read their import batches"
  on public.workspace_import_batches for select to authenticated using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = workspace_import_batches.workspace_id
        and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "Workspace members can read their import items"
  on public.workspace_import_items;
create policy "Workspace members can read their import items"
  on public.workspace_import_items for select to authenticated using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = workspace_import_items.workspace_id
        and m.user_id = (select auth.uid())
    )
  );

revoke all on public.workspace_import_batches, public.workspace_import_items
  from anon, authenticated;
grant select on public.workspace_import_batches, public.workspace_import_items
  to authenticated;

comment on table public.workspace_import_batches is
  'Metadata for user-confirmed browser localStorage imports; source record text is not stored here.';
comment on table public.workspace_import_items is
  'Idempotency map for legacy source records; mutations require a future authenticated transactional importer.';
