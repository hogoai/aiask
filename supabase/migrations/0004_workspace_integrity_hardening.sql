-- AIASK V3 Phase 2.0D: follow-up integrity hardening.
-- Keep 0001-0003 unchanged because their shared/production application state
-- has not been verified. Apply this after 0003 through the normal transactional
-- migration process. This migration does not delete or rewrite user messages.

-- Fail closed if the expected prior schema differs, or if existing message
-- replies cross a user/conversation boundary. Resolve such rows manually first.
do $$
declare
  v_message_id_attnum smallint;
  v_message_user_attnum smallint;
  v_message_conversation_attnum smallint;
  v_message_reply_attnum smallint;
  v_batch_id_attnum smallint;
  v_batch_workspace_attnum smallint;
  v_batch_initiated_by_attnum smallint;
  v_item_batch_attnum smallint;
  v_item_workspace_attnum smallint;
  v_workspace_id_attnum smallint;
  v_auth_user_id_attnum smallint;
  v_constraint_count integer;
begin
  if to_regclass('public.ai_conversations') is null
     or to_regclass('public.ai_conversation_messages') is null
     or to_regclass('public.workspaces') is null
     or to_regclass('public.workspace_import_batches') is null
     or to_regclass('public.workspace_import_items') is null then
    raise exception '0004 requires the expected 0001, 0002, and 0003 tables.';
  end if;

  select attnum into v_message_id_attnum from pg_attribute
    where attrelid = 'public.ai_conversation_messages'::regclass
      and attname = 'id' and attnum > 0 and not attisdropped;
  select attnum into v_message_user_attnum from pg_attribute
    where attrelid = 'public.ai_conversation_messages'::regclass
      and attname = 'user_id' and attnum > 0 and not attisdropped;
  select attnum into v_message_conversation_attnum from pg_attribute
    where attrelid = 'public.ai_conversation_messages'::regclass
      and attname = 'conversation_id' and attnum > 0 and not attisdropped;
  select attnum into v_message_reply_attnum from pg_attribute
    where attrelid = 'public.ai_conversation_messages'::regclass
      and attname = 'reply_to_message_id' and attnum > 0 and not attisdropped;

  select attnum into v_batch_id_attnum from pg_attribute
    where attrelid = 'public.workspace_import_batches'::regclass
      and attname = 'id' and attnum > 0 and not attisdropped;
  select attnum into v_batch_workspace_attnum from pg_attribute
    where attrelid = 'public.workspace_import_batches'::regclass
      and attname = 'workspace_id' and attnum > 0 and not attisdropped;
  select attnum into v_batch_initiated_by_attnum from pg_attribute
    where attrelid = 'public.workspace_import_batches'::regclass
      and attname = 'initiated_by' and attnum > 0 and not attisdropped;

  select attnum into v_item_batch_attnum from pg_attribute
    where attrelid = 'public.workspace_import_items'::regclass
      and attname = 'batch_id' and attnum > 0 and not attisdropped;
  select attnum into v_item_workspace_attnum from pg_attribute
    where attrelid = 'public.workspace_import_items'::regclass
      and attname = 'workspace_id' and attnum > 0 and not attisdropped;

  select attnum into v_workspace_id_attnum from pg_attribute
    where attrelid = 'public.workspaces'::regclass
      and attname = 'id' and attnum > 0 and not attisdropped;
  select attnum into v_auth_user_id_attnum from pg_attribute
    where attrelid = 'auth.users'::regclass
      and attname = 'id' and attnum > 0 and not attisdropped;

  if v_message_id_attnum is null
     or v_message_user_attnum is null
     or v_message_conversation_attnum is null
     or v_message_reply_attnum is null
     or v_batch_id_attnum is null
     or v_batch_workspace_attnum is null
     or v_batch_initiated_by_attnum is null
     or v_item_batch_attnum is null
     or v_item_workspace_attnum is null
     or v_workspace_id_attnum is null
     or v_auth_user_id_attnum is null then
    raise exception '0004 expected columns are missing; inspect schema drift before applying.';
  end if;

  select count(*) into v_constraint_count
  from pg_constraint c
  where c.conrelid = 'public.ai_conversation_messages'::regclass
    and c.conname = 'ai_conversation_messages_reply_to_message_id_fkey'
    and c.contype = 'f'
    and c.confrelid = 'public.ai_conversation_messages'::regclass
    and c.conkey = array[v_message_reply_attnum]::smallint[]
    and c.confkey = array[v_message_id_attnum]::smallint[]
    and c.confdeltype = 'c';
  if v_constraint_count <> 1 then
    raise exception 'Expected reply_to_message_id foreign key is missing or differs from 0002.';
  end if;

  if exists (
    select 1
    from public.ai_conversation_messages reply
    join public.ai_conversation_messages target
      on target.id = reply.reply_to_message_id
    where reply.reply_to_message_id is not null
      and (
        reply.user_id is distinct from target.user_id
        or reply.conversation_id is distinct from target.conversation_id
      )
  ) then
    raise exception 'Cross-user or cross-conversation message replies exist. Review them before applying 0004; no messages were changed.';
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_conversation_messages'::regclass
      and conname in (
        'ai_conversation_messages_reply_scope_key',
        'ai_conversation_messages_reply_scope_fk'
      )
  ) then
    raise exception 'Reply-scope constraints already exist. Inspect migration history and schema before applying 0004.';
  end if;

  select count(*) into v_constraint_count
  from pg_constraint c
  where c.conrelid = 'public.workspace_import_batches'::regclass
    and c.conname = 'workspace_import_batches_workspace_id_fkey'
    and c.contype = 'f'
    and c.confrelid = 'public.workspaces'::regclass
    and c.conkey = array[v_batch_workspace_attnum]::smallint[]
    and c.confkey = array[v_workspace_id_attnum]::smallint[]
    and c.confdeltype = 'c';
  if v_constraint_count <> 1 then
    raise exception 'Expected batch-to-workspace cascade foreign key differs from 0003.';
  end if;

  select count(*) into v_constraint_count
  from pg_constraint c
  where c.conrelid = 'public.workspace_import_batches'::regclass
    and c.conname = 'workspace_import_batches_initiated_by_fkey'
    and c.contype = 'f'
    and c.confrelid = 'auth.users'::regclass
    and c.conkey = array[v_batch_initiated_by_attnum]::smallint[]
    and c.confkey = array[v_auth_user_id_attnum]::smallint[]
    and c.confdeltype = 'c';
  if v_constraint_count <> 1 then
    raise exception 'Expected batch-to-auth-user cascade foreign key differs from 0003.';
  end if;

  select count(*) into v_constraint_count
  from pg_constraint c
  where c.conrelid = 'public.workspace_import_items'::regclass
    and c.conname = 'workspace_import_items_workspace_id_fkey'
    and c.contype = 'f'
    and c.confrelid = 'public.workspaces'::regclass
    and c.conkey = array[v_item_workspace_attnum]::smallint[]
    and c.confkey = array[v_workspace_id_attnum]::smallint[]
    and c.confdeltype = 'c';
  if v_constraint_count <> 1 then
    raise exception 'Expected item-to-workspace cascade foreign key differs from 0003.';
  end if;

  select count(*) into v_constraint_count
  from pg_constraint c
  where c.conrelid = 'public.workspace_import_items'::regclass
    and c.conname = 'workspace_import_items_batch_workspace_fk'
    and c.contype = 'f'
    and c.confrelid = 'public.workspace_import_batches'::regclass
    and c.conkey = array[v_item_batch_attnum, v_item_workspace_attnum]::smallint[]
    and c.confkey = array[v_batch_id_attnum, v_batch_workspace_attnum]::smallint[]
    and c.confdeltype = 'r';
  if v_constraint_count <> 1 then
    raise exception 'Expected batch-to-item RESTRICT foreign key differs from 0003.';
  end if;
end;
$$;

-- A reply is optional. With the default MATCH SIMPLE behavior, a NULL
-- reply_to_message_id skips this composite FK, so ordinary messages still work.
alter table public.ai_conversation_messages
  add constraint ai_conversation_messages_reply_scope_key
  unique (id, user_id, conversation_id);

alter table public.ai_conversation_messages
  add constraint ai_conversation_messages_reply_scope_fk
  foreign key (reply_to_message_id, user_id, conversation_id)
  references public.ai_conversation_messages (id, user_id, conversation_id)
  on delete cascade;

-- Keep the existing single-column UNIQUE on reply_to_message_id. Only replace
-- the old unconstrained-scope FK after the stricter FK has been installed.
alter table public.ai_conversation_messages
  drop constraint ai_conversation_messages_reply_to_message_id_fkey;

-- Import items are batch details and do not survive their batch. Workspace
-- deletion cascades through batches and items; account deletion also cascades
-- through batches initiated by that account. No audit retention is intended.
alter table public.workspace_import_items
  drop constraint workspace_import_items_batch_workspace_fk;

alter table public.workspace_import_items
  add constraint workspace_import_items_batch_workspace_fk
  foreign key (batch_id, workspace_id)
  references public.workspace_import_batches (id, workspace_id)
  on delete cascade;

-- The workspace row itself is safe for its owner to inspect. This lets the
-- helper distinguish a missing owner membership from a missing workspace.
-- No read policy is added to ideas, tasks, or calendar_events.
create policy "Owners can read their personal workspaces"
  on public.workspaces
  for select to authenticated
  using (kind = 'personal' and owner_id = (select auth.uid()));