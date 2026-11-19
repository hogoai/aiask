"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Check, LoaderCircle, MessageCircle, Send, X } from "lucide-react";
import { defaultLocale } from "../i18n/config";
import { PARTNER_ROLE_ID, validateAIASKOutput, validatePlannerChange, type AIASKContext, type PlannerChange } from "../lib/ai/contracts";

type Props = {
  scope: "calendar" | "todos";
  context: AIASKContext;
  userId: string | null;
  onConfirm: (change: PlannerChange, conversationId: string) => string | null;
};
type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: string;
  metadata?: Record<string, unknown>;
  retry?: { userMessageId: string; model?: string; usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHistory(value: unknown): ChatMessage[] | null {
  if (!isRecord(value) || !isRecord(value.conversation) || !Array.isArray(value.conversation.messages)) return null;
  const messages: ChatMessage[] = [];
  for (const item of value.conversation.messages) {
    if (!isRecord(item) || (item.role !== "user" && item.role !== "assistant") || typeof item.content !== "string") continue;
    messages.push({
      id: typeof item.id === "string" ? item.id : `${messages.length}`,
      role: item.role,
      content: item.content,
      status: typeof item.status === "string" ? item.status : undefined,
      metadata: isRecord(item.metadata) ? item.metadata : undefined,
    });
  }
  return messages;
}

function records(context: AIASKContext, field: "relevantTasks" | "relevantCalendarItems") {
  return (context[field] ?? []).flatMap(item => {
    try {
      const record: unknown = JSON.parse(item);
      return isRecord(record) ? [record] : [];
    } catch {
      return [];
    }
  });
}

function describeChange(change: PlannerChange, context: AIASKContext) {
  const tasks = records(context, "relevantTasks");
  const events = records(context, "relevantCalendarItems");
  const target = change.action.includes("task")
    ? tasks.find(item => item.id === change.targetId)
    : events.find(item => item.id === change.targetId);
  const currentTitle = typeof target?.title === "string" ? target.title : "the selected record";
  const date = (value: string | null) => value || "no due date";

  if (change.action === "create_task") {
    return `Add task “${change.title}”${change.dueDate ? `, due ${change.dueDate}` : " without a due date"}${change.ideaId ? " and link its related idea" : ""}.`;
  }
  if (change.action === "create_calendar_event") {
    return `Add “${change.title}” to Calendar on ${change.scheduledDate}${change.scheduledTime ? ` at ${change.scheduledTime}` : " (all day)"}, with a linked task.`;
  }
  if (change.action === "delete_task") return `Delete task “${currentTitle}” and its linked calendar deadline, if any.`;
  if (change.action === "delete_calendar_event") return `Delete “${currentTitle}” and its linked task, if any.`;

  const updates: string[] = [];
  if (change.fields.includes("title")) updates.push(`title to “${change.title}”`);
  if (change.fields.includes("dueDate")) updates.push(`due date to ${date(change.dueDate)}`);
  if (change.fields.includes("scheduledDate")) updates.push(`date to ${date(change.scheduledDate)}`);
  if (change.fields.includes("scheduledTime")) updates.push(`time to ${change.scheduledTime || "all day"}`);
  if (change.fields.includes("status")) updates.push(`status to ${change.status}`);
  if (change.fields.includes("priority")) updates.push(`priority to ${change.priority}`);
  if (change.fields.includes("ideaId")) updates.push(change.ideaId ? "link the related idea" : "remove the related idea link");
  return `Update “${currentTitle}”: ${updates.join(", ")}. Linked task/calendar details will stay in sync.`;
}

function historicalChange(message: ChatMessage) {
  return message.metadata ? validatePlannerChange(message.metadata.plannerChange) : null;
}

export default function PlannerAIChat({ scope, context, userId, onConfirm }: Props) {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [savingMessageId, setSavingMessageId] = useState<string | null>(null);
  const [pendingChange, setPendingChange] = useState<PlannerChange | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const storageKey = `aiask-ai-planner-conversation:${userId ?? "local"}`;
  const preview = useMemo(() => pendingChange ? describeChange(pendingChange, context) : "", [pendingChange, context]);

  useEffect(() => {
    try {
      setConversationId(window.sessionStorage.getItem(storageKey) ?? "");
      setError("");
    } catch {
      setError("This browser could not access session storage. Conversation history may not be resumed after navigation.");
    } finally {
      setStorageReady(true);
    }
  }, [storageKey]);

  useEffect(() => {
    if (!open || !storageReady || !conversationId || !userId || messages.length > 0) return;
    let active = true;
    setLoadingHistory(true);
    void fetch(`/api/ai/conversations/${encodeURIComponent(conversationId)}`, { cache: "no-store" })
      .then(async response => {
        const payload: unknown = await response.json();
        if (!response.ok) {
          const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
            ? payload.error.message : "The AI Planner conversation could not be loaded.";
          throw new Error(message);
        }
        const history = readHistory(payload);
        if (!history) throw new Error("The AI Planner returned an invalid conversation history.");
        if (active) setMessages(history);
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "The AI Planner conversation could not be loaded."); })
      .finally(() => { if (active) setLoadingHistory(false); });
    return () => { active = false; };
  }, [open, storageReady, conversationId, userId, messages.length]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const userMessage = draft.trim();
    if (!userMessage || loading || pendingChange || !storageReady || !userId) return;
    setLoading(true);
    setError("");
    setNotice("");
    setDraft("");
    const optimisticId = `local-${Date.now()}`;
    setMessages(current => [...current, { id: optimisticId, role: "user", content: userMessage, status: "pending" }]);
    try {
      const response = await fetch("/api/ai/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "follow_up",
          plannerChat: true,
          partnerRole: PARTNER_ROLE_ID.planner,
          conversationId: conversationId || undefined,
          userMessage,
          originalIdea: `AI Planner conversation for ${scope === "calendar" ? "Calendar" : "To-do"}`,
          perspectiveContext: "The user is asking for planning help grounded in their current Calendar or To-do page.",
          history: [{ role: "user", content: userMessage }],
          context,
          locale: defaultLocale,
          expectedUserId: userId ?? undefined,
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        if (isRecord(payload) && typeof payload.conversationId === "string") saveConversationId(payload.conversationId);
        const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
          ? payload.error.message : "The AI Planner could not respond. Please try again.";
        throw new Error(message);
      }

      const output = validateAIASKOutput(payload);
      if (!output || output.partnerRole !== PARTNER_ROLE_ID.planner || !output.answer || !output.conversationId) {
        throw new Error("The AI Planner returned an incomplete response. Please try again.");
      }
      saveConversationId(output.conversationId);
      setMessages(current => [
        ...current.map(message => message.id === optimisticId ? { ...message, status: "completed" } : message),
        {
          id: output.messageId ?? `${Date.now()}-assistant`,
          role: "assistant",
          content: output.answer!,
          status: output.saved === false ? "save_failed" : "completed",
          metadata: output.plannerChange ? { plannerChange: output.plannerChange } : undefined,
          retry: output.saved === false && output.userMessageId
            ? { userMessageId: output.userMessageId, model: output.model, usage: output.usage }
            : undefined,
        },
      ]);
      setPendingChange(output.plannerChange && output.plannerChange.action !== "none" ? output.plannerChange : null);
      if (output.saved === false) setError("The reply is shown, but it could not be saved to conversation history.");
    } catch (cause) {
      setMessages(current => current.map(message => message.id === optimisticId ? { ...message, status: "failed" } : message));
      setError(cause instanceof Error ? cause.message : "The AI Planner could not respond. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function saveConversationId(id: string) {
    setConversationId(id);
    try {
      window.sessionStorage.setItem(storageKey, id);
    } catch {
      setError("The conversation is saved on the server, but this browser could not remember it for later.");
    }
  }

  async function retrySavingReply(message: ChatMessage) {
    if (!message.retry || !conversationId || savingMessageId) return;
    setSavingMessageId(message.id);
    setError("");
    try {
      const response = await fetch(`/api/ai/conversations/${encodeURIComponent(conversationId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "retry_save",
          userMessageId: message.retry.userMessageId,
          reply: {
            kind: "follow_up",
            answer: message.content,
            plannerChange: message.metadata?.plannerChange,
            model: message.retry.model,
            usage: message.retry.usage,
          },
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const messageText = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
          ? payload.error.message : "The AI reply could not be saved.";
        throw new Error(messageText);
      }
      setMessages(current => current.map(item => item.id === message.id ? { ...item, status: "completed", retry: undefined } : item));
      setNotice("The reply was saved to your AI Planner history.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The AI reply could not be saved.");
    } finally {
      setSavingMessageId(null);
    }
  }

  function confirmChange() {
    if (!pendingChange) return;
    const failure = onConfirm(pendingChange, conversationId);
    if (failure) {
      setError(failure);
      return;
    }
    setPendingChange(null);
    setError("");
    setNotice("Confirmed change saved to your Calendar and To-do.");
  }

  return <section className="planner-ai" aria-label="AI Planner">
    <button className="planner-ai-trigger" type="button" aria-expanded={open} onClick={() => { setOpen(value => !value); setError(""); }}>
      <MessageCircle size={16}/>{open ? "Close AI Planner" : "Ask AI Planner"}
    </button>
    {open && <div className="planner-ai-panel">
      <header className="planner-ai-heading">
        <div><span className="section-kicker">AI PLANNER</span><h2>Plan with your current {scope === "calendar" ? "calendar" : "tasks"}</h2><p>Questions use only relevant records from this page. Suggested changes need your confirmation.</p></div>
        <button type="button" className="planner-ai-close" aria-label="Close AI Planner" onClick={() => setOpen(false)}><X size={17}/></button>
      </header>
      <div className="planner-ai-messages" aria-live="polite">
        {loadingHistory && <p className="planner-ai-state" role="status"><LoaderCircle size={15} className="planner-ai-spin"/> Loading conversation history…</p>}
        {!userId && <p className="planner-ai-state" role="status">Verify your sign-in before starting an AI Planner conversation.</p>}
        {!loadingHistory && messages.length === 0 && <p className="planner-ai-empty">Ask about free time, overdue tasks, priorities, schedule conflicts, or a next step.</p>}
        {messages.map(message => <article className={`planner-ai-message ${message.role}`} key={message.id}>
          <div className="planner-ai-message-label">{message.role === "user" ? "You" : "AI Planner"}{message.status === "failed" && " · not sent"}{message.status === "save_failed" && " · history not saved"}</div>
          <p>{message.content}</p>
          {historicalChange(message) && <small className="planner-ai-history-preview">Past suggestion (not applied): {describeChange(historicalChange(message)!, context)}</small>}
          {message.retry && <button type="button" className="planner-ai-retry" onClick={() => void retrySavingReply(message)} disabled={savingMessageId !== null}>
            {savingMessageId === message.id ? "Saving reply…" : "Retry saving reply"}
          </button>}
        </article>)}
        {loading && <p className="planner-ai-state" role="status"><LoaderCircle size={15} className="planner-ai-spin"/> AI Planner is thinking…</p>}
      </div>
      {pendingChange && <div className="planner-ai-preview" role="group" aria-label="Proposed change preview">
        <b>Review before saving</b><p>{preview}</p>
        <div><button type="button" className="button button-dark" onClick={confirmChange}><Check size={14}/> Confirm and save</button><button type="button" className="planner-ai-cancel" onClick={() => { setPendingChange(null); setError(""); setNotice("Suggestion cancelled. No planner data was changed."); }}>Cancel</button></div>
      </div>}
      {notice && <p className="planner-ai-notice" role="status">{notice}</p>}
      {error && <p className="planner-ai-error" role="alert">{error}</p>}
      <form className="planner-ai-form" onSubmit={sendMessage}>
        <label className="sr-only" htmlFor={`planner-ai-input-${scope}`}>Ask AI Planner</label>
        <textarea id={`planner-ai-input-${scope}`} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Ask about your schedule or tasks…" rows={2} disabled={loading || Boolean(pendingChange) || loadingHistory}/>
        <button type="submit" className="button button-dark" disabled={!draft.trim() || loading || Boolean(pendingChange) || loadingHistory || !storageReady || !userId} aria-label="Send message"><Send size={15}/><span>Ask</span></button>
      </form>
    </div>}
  </section>;
}
