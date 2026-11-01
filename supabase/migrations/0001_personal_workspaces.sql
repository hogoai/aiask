-- AIASK V0.1 foundation: private personal workspaces with row-level security.
-- Run in the Supabase SQL Editor. This migration creates schema only; it does
-- not copy or upload any browser localStorage data.

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Personal workspace',
  kind text not null default 'personal' check (kind in ('personal', 'team')),
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.ideas (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  body text not null,
  status text not null default 'saved' check (status in ('saved', 'in_progress', 'done')),
  next_step text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  idea_id uuid references public.ideas(id) on delete set null,
  title text not null,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open', 'done')),
  priority text not null default 'onTrack' check (priority in ('urgent', 'attention', 'onTrack')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, id),
  constraint tasks_idea_same_workspace foreign key (workspace_id, idea_id)
    references public.ideas(workspace_id, id) on delete set null (idea_id)
);

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task_id uuid,
  idea_id uuid references public.ideas(id) on delete set null,
  title text not null,
  starts_at timestamptz not null,
  notes text,
  created_at timestamptz not null default now(),
  constraint calendar_task_same_workspace foreign key (workspace_id, task_id)
    references public.tasks(workspace_id, id) on delete set null (task_id),
  constraint calendar_idea_same_workspace foreign key (workspace_id, idea_id)
    references public.ideas(workspace_id, id) on delete set null (idea_id)
);

create index if not exists workspace_members_user_idx on public.workspace_members(user_id);
create index if not exists ideas_workspace_created_idx on public.ideas(workspace_id, created_at desc);
create index if not exists tasks_workspace_due_idx on public.tasks(workspace_id, due_at);
create index if not exists calendar_workspace_start_idx on public.calendar_events(workspace_id, starts_at);

-- A verified auth account receives one private personal workspace on creation.
create or replace function public.create_personal_workspace_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_workspace_id uuid;
begin
  insert into public.workspaces (name, kind, owner_id)
  values ('Personal workspace', 'personal', new.id)
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner');
  return new;
end;
$$;

drop trigger if exists create_personal_workspace_after_signup on auth.users;
create trigger create_personal_workspace_after_signup
  after insert on auth.users
  for each row execute procedure public.create_personal_workspace_for_new_user();

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.ideas enable row level security;
alter table public.tasks enable row level security;
alter table public.calendar_events enable row level security;

create policy "Members can read their workspaces" on public.workspaces
  for select to authenticated using (
    exists (select 1 from public.workspace_members m where m.workspace_id = id and m.user_id = (select auth.uid()))
  );
create policy "Users can read their own membership" on public.workspace_members
  for select to authenticated using (user_id = (select auth.uid()));

create policy "Members can read workspace ideas" on public.ideas for select to authenticated using (
  exists (select 1 from public.workspace_members m where m.workspace_id = ideas.workspace_id and m.user_id = (select auth.uid()))
);
create policy "Members can create workspace ideas" on public.ideas for insert to authenticated with check (
  exists (select 1 from public.workspace_members m where m.workspace_id = ideas.workspace_id and m.user_id = (select auth.uid()))
);
create policy "Members can update workspace ideas" on public.ideas for update to authenticated using (
  exists (select 1 from public.workspace_members m where m.workspace_id = ideas.workspace_id and m.user_id = (select auth.uid()))
) with check (
  exists (select 1 from public.workspace_members m where m.workspace_id = ideas.workspace_id and m.user_id = (select auth.uid()))
);
create policy "Members can delete workspace ideas" on public.ideas for delete to authenticated using (
  exists (select 1 from public.workspace_members m where m.workspace_id = ideas.workspace_id and m.user_id = (select auth.uid()))
);

create policy "Members can read workspace tasks" on public.tasks for select to authenticated using (
  exists (select 1 from public.workspace_members m where m.workspace_id = tasks.workspace_id and m.user_id = (select auth.uid()))
);
create policy "Members can create workspace tasks" on public.tasks for insert to authenticated with check (
  exists (select 1 from public.workspace_members m where m.workspace_id = tasks.workspace_id and m.user_id = (select auth.uid()))
);
create policy "Members can update workspace tasks" on public.tasks for update to authenticated using (
  exists (select 1 from public.workspace_members m where m.workspace_id = tasks.workspace_id and m.user_id = (select auth.uid()))
) with check (
  exists (select 1 from public.workspace_members m where m.workspace_id = tasks.workspace_id and m.user_id = (select auth.uid()))
);
create policy "Members can delete workspace tasks" on public.tasks for delete to authenticated using (
  exists (select 1 from public.workspace_members m where m.workspace_id = tasks.workspace_id and m.user_id = (select auth.uid()))
);

create policy "Members can read workspace calendar" on public.calendar_events for select to authenticated using (
  exists (select 1 from public.workspace_members m where m.workspace_id = calendar_events.workspace_id and m.user_id = (select auth.uid()))
);
create policy "Members can create workspace calendar events" on public.calendar_events for insert to authenticated with check (
  exists (select 1 from public.workspace_members m where m.workspace_id = calendar_events.workspace_id and m.user_id = (select auth.uid()))
);
create policy "Members can update workspace calendar events" on public.calendar_events for update to authenticated using (
  exists (select 1 from public.workspace_members m where m.workspace_id = calendar_events.workspace_id and m.user_id = (select auth.uid()))
) with check (
  exists (select 1 from public.workspace_members m where m.workspace_id = calendar_events.workspace_id and m.user_id = (select auth.uid()))
);
create policy "Members can delete workspace calendar events" on public.calendar_events for delete to authenticated using (
  exists (select 1 from public.workspace_members m where m.workspace_id = calendar_events.workspace_id and m.user_id = (select auth.uid()))
);

revoke all on public.workspaces, public.workspace_members, public.ideas, public.tasks, public.calendar_events from anon, authenticated;
grant select on public.workspaces, public.workspace_members to authenticated;
grant select, insert, update, delete on public.ideas, public.tasks, public.calendar_events to authenticated;
