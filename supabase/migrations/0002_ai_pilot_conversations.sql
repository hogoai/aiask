-- AI Pilot conversation history. Run after 0001_personal_workspaces.sql.
-- Idea and project IDs remain nullable until those browser-only modules are
-- migrated to database-backed records.

create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 240),
  idea_id uuid,
  project_id uuid,
  partner_role text not null check (partner_role in ('guide', 'planner', 'knowledge', 'evaluator', 'advisor', 'accountability')),
  is_favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.ai_conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 12000),
  kind text not null check (kind in ('idea', 'follow_up', 'structured_response')),
  status text not null default 'completed' check (status in ('pending', 'completed', 'failed', 'save_failed')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  reply_to_message_id uuid unique references public.ai_conversation_messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint ai_conversation_messages_owner_fk
    foreign key (conversation_id, user_id)
    references public.ai_conversations(id, user_id) on delete cascade
);

create index if not exists ai_conversations_user_updated_idx
  on public.ai_conversations(user_id, updated_at desc);
create index if not exists ai_conversations_user_partner_updated_idx
  on public.ai_conversations(user_id, partner_role, updated_at desc);
create index if not exists ai_conversation_messages_user_conversation_created_idx
  on public.ai_conversation_messages(user_id, conversation_id, created_at asc);
create index if not exists ai_conversation_messages_user_created_idx
  on public.ai_conversation_messages(user_id, created_at desc);

alter table public.ai_conversations enable row level security;
alter table public.ai_conversation_messages enable row level security;

create policy "Users can read their AI conversations" on public.ai_conversations
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Users can create their AI conversations" on public.ai_conversations
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users can update their AI conversations" on public.ai_conversations
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "Users can delete their AI conversations" on public.ai_conversations
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "Users can read their AI conversation messages" on public.ai_conversation_messages
  for select to authenticated using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.ai_conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())
    )
  );
create policy "Users can create their AI conversation messages" on public.ai_conversation_messages
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.ai_conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())
    )
  );
create policy "Users can update their AI conversation messages" on public.ai_conversation_messages
  for update to authenticated using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.ai_conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())
    )
  ) with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.ai_conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())
    )
  );
create policy "Users can delete their AI conversation messages" on public.ai_conversation_messages
  for delete to authenticated using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.ai_conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())
    )
  );

revoke all on public.ai_conversations, public.ai_conversation_messages from anon, authenticated;
grant select, insert, update, delete on public.ai_conversations, public.ai_conversation_messages to authenticated;
