"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowDown, LoaderCircle, MessageCircle, Send, Sparkles } from "lucide-react";
import MarkdownContent from "./partners/MarkdownContent";
import { AI_ROLE_REGISTRY } from "../lib/ai/roles";
import { PARTNER_ROLE_IDS, validateNotesChatActions, type NotesChatAction, type PartnerRole } from "../lib/ai/contracts";
import { defaultLocale } from "../i18n/config";
import { isSupabaseConfigured } from "../lib/supabase/config";
import type { IdeaRecord } from "../lib/workspace/browser-records";
import "./notes-ai-chat.css";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "pending" | "completed" | "failed" | "save_failed";
  retryMessageId?: string;
  notesActions?: NotesChatAction[];
};

type ContextScope = "selected-note" | "current-view" | "workspace-notes";
type ActionResult = { ok: boolean; message: string };

type Props = {
  note: IdeaRecord | null;
  currentViewNotes: IdeaRecord[];
  currentViewKey: string;
  currentViewReady: boolean;
  selectionIntent: number;
  userId: string | null;
  accountStatus: "ready" | "loading" | "unavailable";
  panelOpen: boolean;
  onTogglePanel: () => void;
  onConfirmAction: (action: NotesChatAction, scope: ContextScope) => ActionResult;
};

type WorkspaceNoteScope = { id: string; name: string; totalCount: number; complete: boolean; contextCharacters: number | null };
type WorkspaceScopeStatus = "idle" | "loading" | "ready" | "error";

const roleOptions = PARTNER_ROLE_IDS.map(id => ({ id, name: AI_ROLE_REGISTRY[id].name }));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roleIsSupported(value: unknown): value is PartnerRole {
  return typeof value === "string" && (PARTNER_ROLE_IDS as readonly string[]).includes(value);
}

function noteConversationKey(userId: string, noteId: string, role: PartnerRole) {
  return `aiask-notes-chat:v1:${userId}:${noteId}:${role}`;
}

function noteRoleKey(userId: string) {
  return `aiask-notes-chat-role:v1:${userId}`;
}

export default function NotesAIChat({ note, currentViewNotes, currentViewKey, currentViewReady, selectionIntent, userId, accountStatus, panelOpen, onTogglePanel, onConfirmAction }: Props) {
  const [scope, setScope] = useState<ContextScope>(note ? "selected-note" : "current-view");
  const [partnerRole, setPartnerRole] = useState<PartnerRole>(PARTNER_ROLE_IDS[0]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [workspaceScope, setWorkspaceScope] = useState<WorkspaceNoteScope | null>(null);
  const [workspaceScopeStatus, setWorkspaceScopeStatus] = useState<WorkspaceScopeStatus>("idle");
  const [workspaceScopeError, setWorkspaceScopeError] = useState("");
  const [workspaceRetry, setWorkspaceRetry] = useState(0);
  const [actionResults, setActionResults] = useState<Record<string, ActionResult>>({});
  const threadRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const handledActionsRef = useRef(new Set<string>());
  const noteId = note?.id ?? null;
  const noteType = note?.type ?? "Idea";
  const authReady = accountStatus === "ready" && Boolean(userId);
  const activeNotes = scope === "selected-note" ? (note ? [note] : [])
    : scope === "current-view" ? currentViewNotes
      : [];
  const workspaceReady = scope !== "workspace-notes" || (workspaceScopeStatus === "ready" && Boolean(workspaceScope?.complete)
    && typeof workspaceScope?.contextCharacters === "number" && workspaceScope.contextCharacters <= 8000);
  const hasContext = scope === "workspace-notes"
    ? workspaceReady && Boolean(workspaceScope && workspaceScope.totalCount > 0)
    : activeNotes.length > 0 && (scope !== "current-view" || currentViewReady);
  const activeRecordCount = scope === "workspace-notes" ? workspaceScope?.totalCount ?? 0 : activeNotes.length;
  const contextResolved = scope === "selected-note" ? Boolean(note)
    : scope === "current-view" ? currentViewReady
      : workspaceScopeStatus === "ready" && Boolean(workspaceScope);
  const activeContextKey = scope === "selected-note" ? noteId ?? "missing-note"
    : scope === "current-view" ? `current-view-${currentViewKey}`
      : `workspace-${workspaceScope?.id ?? "loading"}`;

  useEffect(() => {
    if (!userId) return;
    try {
      const storedRole = window.localStorage.getItem(noteRoleKey(userId));
      if (roleIsSupported(storedRole)) setPartnerRole(storedRole);
    } catch { /* The default AI Team role remains available when local storage is unavailable. */ }
  }, [userId]);

  useEffect(() => {
    if (selectionIntent > 0) setScope("selected-note");
  }, [selectionIntent]);

  useEffect(() => {
    if (scope !== "workspace-notes") return;
    if (!authReady || !userId) {
      setWorkspaceScope(null);
      setWorkspaceScopeStatus("error");
      setWorkspaceScopeError("Sign in to load notes from your authorized Workspace.");
      return;
    }

    const controller = new AbortController();
    let active = true;
    setWorkspaceScope(null);
    setWorkspaceScopeStatus("loading");
    setWorkspaceScopeError("");
    void (async () => {
      try {
        const response = await fetch("/api/workspace/ideas", { signal: controller.signal, cache: "no-store" });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(readApiError(payload, "Authorized Workspace Notes could not be loaded."));
        if (!isObject(payload) || !isObject(payload.workspace) || typeof payload.workspace.id !== "string"
          || typeof payload.workspace.name !== "string" || typeof payload.totalCount !== "number"
          || typeof payload.complete !== "boolean" || (payload.contextCharacters !== null && typeof payload.contextCharacters !== "number")) {
          throw new Error("Workspace Notes returned incomplete data.");
        }
        if (payload.complete && payload.contextCharacters === null) {
          throw new Error("Workspace Notes were incomplete. Reload and try again.");
        }
        if (!active) return;
        setWorkspaceScope({ id: payload.workspace.id, name: payload.workspace.name, totalCount: payload.totalCount, complete: payload.complete, contextCharacters: payload.contextCharacters });
        setWorkspaceScopeStatus("ready");
        if (!payload.complete) setWorkspaceScopeError(`This Workspace has ${payload.totalCount} notes. The safe chat limit is 500 records; choose Current View or a Selected Note.`);
        else if ((payload.contextCharacters ?? 0) > 8000) setWorkspaceScopeError("These Workspace Notes exceed the AI context limit. Choose Current View or Selected Note, or shorten the saved notes.");
      } catch (caught) {
        if (!active || (caught instanceof DOMException && caught.name === "AbortError")) return;
        setWorkspaceScopeStatus("error");
        setWorkspaceScopeError(caught instanceof Error ? caught.message : "Authorized Workspace Notes could not be loaded.");
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [scope, userId, authReady, workspaceRetry]);

  useEffect(() => {
    requestRef.current?.abort();
    setConversationId(null);
    setMessages([]);
    setHistoryLoading(false);
    setSending(false);
    setError("");
    setNotice("");
    setActionResults({});
    handledActionsRef.current.clear();

    if (!contextResolved || !userId || !authReady) return;

    const activeNoteId = scope === "selected-note" ? noteId : null;
    const activeUserId = userId;
    const controller = new AbortController();
    let active = true;
    const key = noteConversationKey(activeUserId, activeContextKey, partnerRole);

    async function restoreConversation() {
      setHistoryLoading(true);
      try {
        let savedConversationId: string | null = null;
        const contextMarker = scope === "selected-note" && activeNoteId ? `AIASK context scope: selected-note-${activeNoteId}`
          : scope === "current-view" ? `AIASK context scope: current-view-${currentViewKey}`
            : "AIASK context scope: authorized personal Workspace Notes.";
        if (!(scope === "selected-note" && (!activeNoteId || !uuidPattern.test(activeNoteId)))) {
          const params = new URLSearchParams({ partnerRole, notesContext: contextMarker });
          if (scope === "selected-note" && activeNoteId) params.set("ideaId", activeNoteId);
          const listResponse = await fetch(`/api/ai/conversations?${params.toString()}`, { signal: controller.signal, cache: "no-store" });
          const listPayload: unknown = await listResponse.json();
          if (!listResponse.ok) throw new Error(readApiError(listPayload, "Saved AI Team conversations could not be loaded."));
          if (isObject(listPayload) && Array.isArray(listPayload.conversations)) {
            const first = listPayload.conversations.find((entry): entry is Record<string, unknown> => isObject(entry)
              && typeof entry.id === "string" && entry.ideaId === activeNoteId && entry.partnerRole === partnerRole);
            if (first && typeof first.id === "string") savedConversationId = first.id;
          }
        }

        if (!savedConversationId) {
          try { savedConversationId = window.localStorage.getItem(key); } catch { /* Conversation history remains available on the server. */ }
        }
        if (!savedConversationId) return;

        const response = await fetch(`/api/ai/conversations/${encodeURIComponent(savedConversationId)}`, { signal: controller.signal, cache: "no-store" });
        const payload: unknown = await response.json();
        if (!response.ok) {
          if (response.status === 404) {
            try { window.localStorage.removeItem(key); } catch { /* Keep the panel usable if local storage is unavailable. */ }
            return;
          }
          throw new Error(readApiError(payload, "Saved AI Team conversations could not be opened."));
        }
        if (!isObject(payload) || !isObject(payload.conversation)) throw new Error("Saved AI Team conversation data was incomplete.");
        const conversation = payload.conversation;
        const linkedNoteId = scope === "selected-note" && activeNoteId && uuidPattern.test(activeNoteId) ? activeNoteId : null;
        if (conversation.id !== savedConversationId || conversation.partnerRole !== partnerRole
          || (linkedNoteId ? conversation.ideaId !== linkedNoteId : conversation.ideaId != null) || !Array.isArray(conversation.messages)) {
          throw new Error("This conversation is not linked to the current Notes & Ideas context.");
        }
        const expectedMarker = scope === "selected-note" && activeNoteId ? `AIASK context scope: selected-note-${activeNoteId}`
          : scope === "current-view" ? `AIASK context scope: current-view-${currentViewKey}`
            : "AIASK context scope: authorized personal Workspace Notes.";
        const savedMarker = conversation.messages.find((entry): entry is Record<string, unknown> => isObject(entry) && entry.kind === "idea");
        const legacySelected = scope === "selected-note" && Boolean(linkedNoteId && conversation.ideaId === linkedNoteId);
        if (savedMarker?.content !== expectedMarker && !legacySelected) throw new Error("This conversation belongs to a different Notes & Ideas context.");
        const restored = conversation.messages.flatMap((entry): ChatMessage[] => {
          if (!isObject(entry) || (entry.role !== "user" && entry.role !== "assistant")
            || typeof entry.content !== "string" || entry.kind === "idea") return [];
          const status = entry.status === "pending" || entry.status === "failed" || entry.status === "save_failed" ? entry.status : "completed";
          const id = typeof entry.id === "string" ? entry.id : crypto.randomUUID();
          const metadata = isObject(entry.metadata) ? entry.metadata : null;
          const notesActions = entry.role === "assistant" && metadata
            ? validateNotesChatActions(metadata.notesActions)
            : null;
          return [{ id, role: entry.role, content: entry.content, status, ...(notesActions?.length ? { notesActions } : {}), ...(status === "failed" || status === "save_failed" ? { retryMessageId: id } : {}) }];
        });
        if (!active) return;
        setConversationId(savedConversationId);
        setMessages(restored);
        setActionResults({});
        try { window.localStorage.setItem(key, savedConversationId); } catch { /* Server-side conversation history is still persisted. */ }
      } catch (caught) {
        if (!active || (caught instanceof DOMException && caught.name === "AbortError")) return;
        setError(caught instanceof Error ? caught.message : "Saved AI Team conversations could not be loaded.");
      } finally {
        if (active) setHistoryLoading(false);
      }
    }

    void restoreConversation();
    return () => {
      active = false;
      controller.abort();
    };
  }, [activeContextKey, scope, contextResolved, currentViewReady, noteId, userId, authReady, partnerRole]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, sending]);

  useEffect(() => () => requestRef.current?.abort(), []);

  async function sendMessage(question: string, retry?: { localId: string; messageId?: string }) {
    const activeNoteId = scope === "selected-note" ? noteId : null;
    const activeUserId = userId;
    if (!hasContext || (scope !== "workspace-notes" && !activeNotes.length) || !activeUserId || !authReady || sending || historyLoading || requestRef.current) return;
    const content = question.trim();
    if (!content) return;
    if (content.length > 1000) {
      setError("Keep each message under 1,000 characters.");
      return;
    }
    const contextRecords = activeNotes.map(item => ({
      id: item.id,
      type: item.type ?? "Idea",
      status: item.status ?? "Saved",
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      nextStep: item.nextStep,
      progressUpdatedAt: item.progressUpdatedAt,
      text: item.text,
    }));
    const contextText = scope === "workspace-notes" ? "{}" : JSON.stringify({
      scope: scope === "selected-note" ? "Selected Note" : "Current View",
      source: scope === "selected-note" ? "Selected note in Notes & Ideas" : "Notes visible in the current Notes & Ideas view",
      recordCount: activeRecordCount,
      records: contextRecords,
    });
    const contextTooLarge = scope === "workspace-notes"
      ? (workspaceScope?.contextCharacters ?? Infinity) > 8000
      : contextText.length > 8000;
    if (contextTooLarge) {
      setError(scope === "selected-note"
        ? "This note is over the AI context limit. Shorten the note, then try again."
        : "These records exceed the AI context limit. Narrow the current view, select one note, or shorten note text, then try again.");
      return;
    }

    setError("");
    setNotice("");
    setSending(true);
    const localId = retry?.localId ?? `pending-${crypto.randomUUID()}`;
    const userMessage: ChatMessage = { id: localId, role: "user", content, status: "pending" };
    const displayedMessages = retry
      ? messages.map(message => message.id === retry.localId ? { ...message, status: "pending" as const } : message)
      : [...messages, userMessage];
    setMessages(displayedMessages);
    if (!retry) setDraft("");

    const history = retry
      ? displayedMessages.slice(0, displayedMessages.findIndex(message => message.id === retry.localId) + 1)
      : displayedMessages;
    const requestHistory = history.slice(-8).map(message => ({ role: message.role, content: message.content.slice(0, 1200) }));
    const controller = new AbortController();
    requestRef.current = controller;

    try {
      const response = await fetch("/api/ai/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          mode: "follow_up",
          notesChat: true,
          partnerRole,
          expectedUserId: activeUserId,
          userMessage: content,
          locale: defaultLocale,
          originalIdea: scope === "selected-note" && note
            ? `Selected note: ${note.text.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 300) || "Untitled note"}`
            : scope === "current-view"
              ? `Current Notes & Ideas view (${activeNotes.length} records)`
              : `Authorized Workspace Notes (${activeRecordCount} records)`,
          perspectiveContext: scope === "workspace-notes" ? "{}" : contextText,
          ...(scope === "workspace-notes" ? { workspaceNotesScope: true } : {}),
          ...(scope === "selected-note" && activeNoteId ? { notesContextKey: `selected-note-${activeNoteId}` } : {}),
          ...(scope === "current-view" ? { notesContextKey: `current-view-${currentViewKey}` } : {}),
          history: requestHistory,
          ...(scope === "selected-note" && activeNoteId && uuidPattern.test(activeNoteId) ? { context: { ideaId: activeNoteId } } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(retry?.messageId ? { retryMessageId: retry.messageId } : {}),
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const apiError = readApiErrorDetails(payload);
        if (apiError.conversationId) {
          setConversationId(apiError.conversationId);
          try { window.localStorage.setItem(noteConversationKey(activeUserId, activeContextKey, partnerRole), apiError.conversationId); } catch { /* The server remains the source of conversation history. */ }
        }
        const serverMessageId = apiError.userMessageId;
        setMessages(current => current.map(message => message.id === localId ? {
          ...message,
          id: serverMessageId ?? message.id,
          status: "failed",
          ...(apiError.historySaved && serverMessageId ? { retryMessageId: serverMessageId } : {}),
        } : message));
        throw new Error(apiError.message || "The AI Team could not complete this message.");
      }
      if (!isObject(payload) || typeof payload.answer !== "string" || typeof payload.conversationId !== "string") {
        throw new Error("The AI Team returned an incomplete response.");
      }
      setConversationId(payload.conversationId);
      try { window.localStorage.setItem(noteConversationKey(activeUserId, activeContextKey, partnerRole), payload.conversationId); } catch { /* The server remains the source of conversation history. */ }
      const serverMessageId = typeof payload.userMessageId === "string" ? payload.userMessageId : localId;
      const saved = payload.saved === true;
      const notesActions = validateNotesChatActions(payload.suggestions) ?? [];
      setMessages(current => [
          ...current.map(message => message.id === localId ? { ...message, id: serverMessageId, status: saved ? "completed" as const : "save_failed" as const, ...(saved ? { retryMessageId: undefined } : { retryMessageId: serverMessageId }) } : message),
        { id: `reply-${crypto.randomUUID()}`, role: "assistant", content: payload.answer as string, status: saved ? "completed" : "save_failed", ...(notesActions.length ? { notesActions } : {}) },
      ]);
      if (!saved) setNotice("The reply was generated but could not be saved to AI Conversations.");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "The AI Team could not complete this message.");
      setMessages(current => current.map(message => message.id === localId && message.status === "pending" ? { ...message, status: "failed" } : message));
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      setSending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(draft);
  }

  function applySuggestedAction(messageId: string, actionIndex: number, action: NotesChatAction) {
    const key = `${messageId}:${actionIndex}`;
    if (actionResults[key] || handledActionsRef.current.has(key)) return;
    handledActionsRef.current.add(key);
    if (action.action === "explore_idea") {
      setDraft(action.content ?? "");
      setNotice("The suggested question is in the message box. Review it and send when ready.");
      setActionResults(current => ({ ...current, [key]: { ok: true, message: "Question added to the message box." } }));
      return;
    }
    const result = onConfirmAction(action, scope);
    if (!result.ok) handledActionsRef.current.delete(key);
    setActionResults(current => ({ ...current, [key]: result }));
  }

  const accountMessage = accountStatus === "loading"
    ? "Checking your account…"
    : accountStatus !== "ready"
      ? "Your account could not be verified. Reopen Notes & Ideas and try again."
      : !userId
        ? isSupabaseConfigured() ? "Sign in to use saved AI Team conversations." : "AI Team chat needs account sign-in to be configured."
        : "";

  return <aside className="notes-ai-chat" aria-labelledby="notes-ai-chat-title">
    <header className="notes-ai-chat-header">
      <span className="notes-ai-chat-icon"><MessageCircle size={18}/></span>
      <div className="notes-ai-chat-heading"><span className="section-kicker">AI TEAM</span><h2 id="notes-ai-chat-title">Talk through your notes</h2></div>
      <button type="button" className="notes-ai-chat-toggle" aria-expanded={panelOpen} aria-controls="notes-ai-chat-body" onClick={onTogglePanel}>{panelOpen ? "Close" : "Open AI Team"}<ArrowDown size={14}/></button>
    </header>
    <div className="notes-ai-chat-body" id="notes-ai-chat-body" data-open={panelOpen}>
      <p className="notes-ai-chat-explainer">Choose which authorized notes the AI Team may use for this conversation.</p>
      <div className="notes-ai-chat-controls">
        <label htmlFor="notes-ai-scope">Context scope</label>
        <select id="notes-ai-scope" value={scope} onChange={event => { setScope(event.target.value as ContextScope); setError(""); setNotice(""); }} disabled={sending || historyLoading}>
          <option value="selected-note" disabled={!note}>Selected Note{note ? "" : " (select a note first)"}</option>
          <option value="current-view">Current View ({currentViewNotes.length})</option>
          <option value="workspace-notes" disabled={!authReady}>Authorized Workspace Notes{workspaceScope ? ` (${workspaceScope.totalCount})` : !authReady ? " (sign in required)" : ""}</option>
        </select>
      </div>
      <div className="notes-ai-chat-controls">
        <label htmlFor="notes-ai-role">AI Team role</label>
        <select id="notes-ai-role" value={partnerRole} onChange={event => { const nextRole = event.target.value as PartnerRole; setPartnerRole(nextRole); if (userId) { try { window.localStorage.setItem(noteRoleKey(userId), nextRole); } catch { /* The conversation remains available by choosing the same role later. */ } } }} disabled={sending}>
          {roleOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </div>
      <div className="notes-ai-chat-context"><Sparkles size={14}/><span><b>{scope === "selected-note" ? `Selected Note · ${noteType}` : scope === "current-view" ? `Current View · ${currentViewNotes.length} ${currentViewNotes.length === 1 ? "record" : "records"}` : `Authorized Workspace Notes · ${workspaceScope?.name ?? "Personal Workspace"} · ${workspaceScope?.totalCount ?? "—"}`}</b><small>{scope === "selected-note" ? note?.text.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 90) || "Select a note from the list." : scope === "current-view" ? "Only notes currently visible after the view filters are included." : "Verified personal Workspace records only; browser-local Notes & Ideas are excluded."}</small></span></div>
      {scope === "workspace-notes" && workspaceScopeStatus === "loading" && <p className="notes-ai-chat-notice" role="status"><LoaderCircle className="notes-ai-chat-spinner" size={13}/> Verifying access and loading Workspace Notes…</p>}
      {scope === "workspace-notes" && workspaceScopeError && <p className="notes-ai-chat-error" role="alert">{workspaceScopeError}{workspaceScopeStatus === "error" && <button type="button" onClick={() => setWorkspaceRetry(value => value + 1)}>Retry</button>}</p>}

      <div className="notes-ai-chat-thread" ref={threadRef} aria-live="polite" aria-label="AI Team conversation">
        {historyLoading && <div className="notes-ai-chat-empty"><LoaderCircle className="notes-ai-chat-spinner" size={18}/>Loading saved conversation…</div>}
        {!historyLoading && hasContext && messages.length === 0 && <div className="notes-ai-chat-empty"><span className="notes-ai-chat-empty-icon"><MessageCircle size={18}/></span><b>{scope === "selected-note" ? "What would you like to explore?" : "What would you like to understand?"}</b><p>{scope === "selected-note" ? "Ask for a summary, a connection, or help developing this note." : scope === "current-view" ? "Ask for a summary, patterns, or follow-ups across the notes currently shown." : `Ask about the ${workspaceScope?.totalCount ?? 0} notes in your authorized Workspace.`}</p></div>}
        {!historyLoading && scope === "current-view" && !currentViewReady && <div className="notes-ai-chat-empty"><LoaderCircle className="notes-ai-chat-spinner" size={18}/>Loading the current Notes &amp; Ideas view…</div>}
        {!historyLoading && currentViewReady && !hasContext && scope === "current-view" && <div className="notes-ai-chat-empty"><span className="notes-ai-chat-empty-icon"><MessageCircle size={18}/></span><b>This view has no notes.</b><p>Change the date or filters, or select a note to ask the AI Team.</p></div>}
        {!historyLoading && !hasContext && scope === "workspace-notes" && workspaceScopeStatus === "ready" && workspaceScope?.complete && workspaceScope.totalCount === 0 && <div className="notes-ai-chat-empty"><span className="notes-ai-chat-empty-icon"><MessageCircle size={18}/></span><b>No Workspace Notes found.</b><p>Your verified personal Workspace has no notes to include.</p></div>}
        {!historyLoading && messages.map(message => <article className={`notes-ai-message ${message.role}`} key={message.id}>
          <div className="notes-ai-message-label">{message.role === "user" ? "YOU" : AI_ROLE_REGISTRY[partnerRole].name.toUpperCase()}{message.status === "pending" && <span> · SENDING</span>}</div>
          {message.role === "assistant" ? <MarkdownContent content={message.content}/> : <p>{message.content}</p>}
          {message.role === "assistant" && message.notesActions?.length ? <div className="notes-ai-actions" aria-label="Suggested actions">{message.notesActions.map((action, index) => {
            const key = `${message.id}:${index}`;
            const result = actionResults[key];
            const actionLabel = action.action === "create_todo" ? "Create To-do" : action.action === "set_follow_up" ? "Set Follow-up" : action.action === "explore_idea" ? "Explore Idea" : "Save Summary";
            const unsupported = scope === "workspace-notes" && action.action === "set_follow_up";
            const buttonLabel = action.action === "explore_idea" ? "Use suggested question" : action.action === "create_todo" ? "Confirm & create To-do" : action.action === "set_follow_up" ? "Confirm & set Follow-up" : "Confirm & save Summary";
            return <section className="notes-ai-action" key={key}>
              <div className="notes-ai-action-title"><b>{actionLabel}</b>{action.dueDate && <span>Due {action.dueDate}</span>}</div>
              <strong>{action.title}</strong>
              <p>{action.description}</p>
              <small>{action.rationale}</small>
              {action.action === "set_follow_up" && action.noteId && scope !== "workspace-notes" && <>
                <small>Note: {activeNotes.find(record => record.id === action.noteId)?.text.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 100) ?? "Selected note"}</small>
                {activeNotes.find(record => record.id === action.noteId)?.nextStep && <small>Currently saved follow-up: {activeNotes.find(record => record.id === action.noteId)?.nextStep}</small>}
              </>}
              {action.content && <blockquote>{action.content}</blockquote>}
              {unsupported ? <small className="notes-ai-action-limitation">Workspace Notes cannot be edited here; treat this as a suggestion.</small>
                : result ? <small className={result.ok ? "notes-ai-action-result" : "notes-ai-action-error"} role="status">{result.message}</small>
                  : <button type="button" disabled={sending || historyLoading} onClick={() => applySuggestedAction(message.id, index, action)}>{buttonLabel}</button>}
            </section>;
          })}</div> : null}
          {message.role === "user" && (message.status === "failed" || message.status === "save_failed") && <button type="button" className="notes-ai-retry" disabled={sending} onClick={() => void sendMessage(message.content, { localId: message.id, ...(message.retryMessageId ? { messageId: message.retryMessageId } : {}) })}>Retry message</button>}
          {message.status === "save_failed" && message.role === "assistant" && <small className="notes-ai-unsaved">This reply may not be available when you return.</small>}
        </article>)}
        {sending && <div className="notes-ai-thinking" role="status"><LoaderCircle className="notes-ai-chat-spinner" size={15}/>{AI_ROLE_REGISTRY[partnerRole].name} is thinking…</div>}
      </div>

      {accountMessage && <p className="notes-ai-chat-account" role="status">{accountMessage}{accountStatus === "ready" && !userId && isSupabaseConfigured() && <> <Link href="/login?next=%2F%3Fview%3Dinbox">Sign in</Link></>}</p>}
      {error && <p className="notes-ai-chat-error" role="alert">{error}</p>}
      {notice && <p className="notes-ai-chat-notice" role="status">{notice}</p>}
      <form className="notes-ai-chat-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="notes-ai-chat-input">Message the AI Team about your notes</label>
        <textarea id="notes-ai-chat-input" value={draft} onChange={event => { setDraft(event.target.value); setError(""); setNotice(""); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} maxLength={1000} rows={3} placeholder={scope === "selected-note" ? "Ask about this note…" : scope === "current-view" ? "Ask about the notes in this view…" : "Ask about your Workspace Notes…"} disabled={!hasContext || !authReady || sending || historyLoading}/>
        <div className="notes-ai-chat-form-footer"><span>{draft.length}/1000 · Enter to send</span><button type="submit" disabled={!hasContext || !draft.trim() || !authReady || sending || historyLoading} aria-label="Send message">{sending ? <LoaderCircle className="notes-ai-chat-spinner" size={17}/> : <Send size={17}/>}<span>{sending ? "Sending" : "Ask"}</span></button></div>
      </form>
      {conversationId && <p className="notes-ai-chat-saved" role="status">Saved in AI Conversations</p>}
    </div>
  </aside>;
}

function readApiError(value: unknown, fallback: string) {
  const details = readApiErrorDetails(value);
  return details.message || fallback;
}

function readApiErrorDetails(value: unknown) {
  if (!isObject(value)) return { message: "", conversationId: "", userMessageId: "", historySaved: false };
  const error = isObject(value.error) ? value.error : null;
  return {
    message: typeof error?.message === "string" ? error.message : "",
    conversationId: typeof value.conversationId === "string" ? value.conversationId : "",
    userMessageId: typeof value.userMessageId === "string" ? value.userMessageId : "",
    historySaved: value.historySaved === true,
  };
}
