"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useLocale } from "next-intl";
import { ChevronDown, Send, Sparkles } from "lucide-react";
import MarkdownContent from "../partners/MarkdownContent";
import { formatPartnerResponse } from "../../lib/ai/conversations";
import { PARTNER_ROLE_ID, type AIASKContext, type PartnerResponse } from "../../lib/ai/contracts";

type CoachIdea = {
  id: string;
  text: string;
  createdAt: string;
  updatedAt?: string;
  status?: "Saved" | "In progress" | "Done";
  nextStep?: string;
  progressUpdatedAt?: string;
};
type CoachTodo = { id: string; title: string; dueDate: string; status: "Open" | "Done"; completedAt?: string };
type CoachEvent = { id: string; title: string; scheduledDate: string; scheduledTime: string | null };
type CoachPlanner = { todos: CoachTodo[]; events: CoachEvent[] };
type CoachMessage = { id: string; role: "user" | "assistant"; content: string; status?: "pending" | "completed" | "failed"; result?: PartnerResponse };
type CoachRetry = { question: string; localMessageId: string; body: Record<string, unknown>; retryMessageId?: string; conversationId?: string };
type CoachError = { message: string; needsSignIn: boolean; retryable: boolean };
type WorkspaceCoachProps = { ideas: CoachIdea[]; planner: CoachPlanner; onShowHistory: () => void };

const coachPrompts = [
  "Which idea should I focus on now?",
  "What might be slowing my follow-through?",
  "How can I make my next step easier?",
  "What progress pattern do you notice?",
];

function localDateKey(date: Date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function shortCoachText(value: string, maxLength = 320) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength - 3).trimEnd() + "..." : normalized;
}

function ideaStatus(idea: CoachIdea) {
  return idea.status ?? "Saved";
}

function makeWorkspaceCoachContext(ideas: CoachIdea[], planner: CoachPlanner): AIASKContext {
  const recentIdeas = [...ideas]
    .sort((a, b) => (b.progressUpdatedAt ?? b.updatedAt ?? b.createdAt).localeCompare(a.progressUpdatedAt ?? a.updatedAt ?? a.createdAt))
    .slice(0, 5);
  const outcomes = ideas
    .filter(idea => ideaStatus(idea) === "Done" || Boolean(idea.progressUpdatedAt))
    .sort((a, b) => (b.progressUpdatedAt ?? b.updatedAt ?? b.createdAt).localeCompare(a.progressUpdatedAt ?? a.updatedAt ?? a.createdAt))
    .slice(0, 3);
  const openTasks = planner.todos
    .filter(todo => todo.status !== "Done")
    .sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"))
    .slice(0, 5);
  const completedTasks = planner.todos
    .filter(todo => todo.status === "Done")
    .sort((a, b) => (b.completedAt ?? b.dueDate ?? "").localeCompare(a.completedAt ?? a.dueDate ?? ""))
    .slice(0, 3);
  const today = localDateKey(new Date());
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 14);
  const endKey = localDateKey(endDate);
  const upcomingEvents = planner.events
    .filter(event => event.scheduledDate >= today && event.scheduledDate <= endKey)
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || (a.scheduledTime ?? "").localeCompare(b.scheduledTime ?? ""))
    .slice(0, 5);

  return {
    relevantNotes: recentIdeas.map(idea => "Idea: " + shortCoachText(idea.text) + " | Status: " + ideaStatus(idea) + (idea.nextStep ? " | Next step: " + shortCoachText(idea.nextStep) : "")),
    relevantDecisions: outcomes.map(idea => "Progress record: " + shortCoachText(idea.text) + " | Status: " + ideaStatus(idea) + (idea.nextStep ? " | Note: " + shortCoachText(idea.nextStep) : "")),
    relevantTasks: [
      ...openTasks.map(todo => "Open action: " + shortCoachText(todo.title) + (todo.dueDate ? " | Due: " + todo.dueDate : "")),
      ...completedTasks.map(todo => "Completed action: " + shortCoachText(todo.title) + (todo.completedAt ? " | Completed: " + todo.completedAt.slice(0, 10) : "")),
    ],
    relevantCalendarItems: upcomingEvents.map(event => "Calendar plan: " + shortCoachText(event.title) + " | Date: " + event.scheduledDate + (event.scheduledTime ? " | Time: " + event.scheduledTime : "")),
  };
}

export default function WorkspaceCoach({ ideas, planner, onShowHistory }: WorkspaceCoachProps) {
  const locale = useLocale();
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [contextEnabled, setContextEnabled] = useState(true);
  const [contextDetailsOpen, setContextDetailsOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<CoachError | null>(null);
  const [retry, setRetry] = useState<CoachRetry | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const snapshot = useMemo(() => makeWorkspaceCoachContext(ideas, planner), [ideas, planner]);
  const counts = {
    ideas: snapshot.relevantNotes?.length ?? 0,
    actions: snapshot.relevantTasks?.length ?? 0,
    calendar: snapshot.relevantCalendarItems?.length ?? 0,
    outcomes: snapshot.relevantDecisions?.length ?? 0,
  };
  const snapshotTotal = counts.ideas + counts.actions + counts.calendar + counts.outcomes;

  async function sendRequest(question: string, localMessageId: string, retryRequest?: CoachRetry) {
    const isFollowUp = messages.some(message => message.role === "assistant");
    const sharedContext = contextEnabled && snapshotTotal > 0 ? snapshot : undefined;
    let body: Record<string, unknown>;
    if (retryRequest) {
      body = { ...retryRequest.body, locale };
      if (retryRequest.conversationId) body.conversationId = retryRequest.conversationId;
      if (retryRequest.retryMessageId) body.retryMessageId = retryRequest.retryMessageId;
    } else if (isFollowUp) {
      const firstQuestion = messages.find(message => message.role === "user" && message.status !== "failed")?.content ?? question;
      const firstResponse = messages.find(message => message.role === "assistant");
      const history = [
        ...messages.filter(message => message.status !== "failed").map(message => ({ role: message.role, content: shortCoachText(message.content, 1200) })),
        { role: "user", content: question },
      ].slice(-8);
      body = {
        mode: "follow_up",
        locale,
        partnerRole: PARTNER_ROLE_ID.actionPartner,
        userMessage: question,
        originalIdea: firstQuestion,
        perspectiveContext: firstResponse?.result ? formatPartnerResponse(firstResponse.result) : (firstResponse?.content ?? ""),
        history,
        ...(sharedContext ? { context: sharedContext } : {}),
        ...(conversationId ? { conversationId } : {}),
      };
    } else {
      body = {
        partnerRole: PARTNER_ROLE_ID.actionPartner,
        userMessage: question,
        responseMode: "normal",
        locale,
        ...(sharedContext ? { context: sharedContext } : {}),
      };
    }

    setLoading(true);
    setError(null);
    setRetry(null);
    setSaveStatus("saving");
    try {
      const response = await fetch("/api/ai/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json();
      const data = payload && typeof payload === "object" ? payload as {
        answer?: string;
        conversationId?: string;
        error?: { code?: string; message?: string };
        historySaved?: boolean;
        result?: PartnerResponse;
        saved?: boolean;
        userMessageId?: string;
      } : {};
      if (data.conversationId) setConversationId(data.conversationId);
      if (!response.ok) {
        const code = data.error?.code ?? "";
        const needsSignIn = code === "sign_in_required";
        const retryable = !needsSignIn && code !== "auth_not_configured" && code !== "conversation_storage_unavailable";
        setMessages(current => current.map(message => message.id === localMessageId ? { ...message, status: "failed" } : message));
        setError({
          message: needsSignIn ? "Sign in to use Workspace AI Coach." : retryable ? (data.error?.message || "The Coach could not complete this request.") : "AI Team conversation storage is not ready for the Coach yet.",
          needsSignIn,
          retryable,
        });
        setSaveStatus(data.historySaved ? "saved" : "idle");
        if (retryable) {
          setRetry({
            question,
            localMessageId,
            body: { ...body, ...(data.conversationId ? { conversationId: data.conversationId } : {}) },
            ...(data.historySaved && data.userMessageId ? { retryMessageId: data.userMessageId } : {}),
            ...(data.conversationId ? { conversationId: data.conversationId } : {}),
          });
        }
        return;
      }

      const result = data.result && typeof data.result === "object" ? data.result : undefined;
      const answer = typeof data.answer === "string" ? data.answer : result?.perspective;
      if (!answer) throw new Error("The Coach returned an empty response. Please try again.");
      setMessages(current => [
        ...current.map(message => message.id === localMessageId ? { ...message, status: "completed" as const } : message),
        { id: "coach-ai-" + Date.now(), role: "assistant", content: answer, ...(result ? { result } : {}) },
      ]);
      setSaveStatus(data.saved === false ? "failed" : "saved");
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "The Coach could not complete this request.";
      setMessages(current => current.map(item => item.id === localMessageId ? { ...item, status: "failed" } : item));
      setError({ message, needsSignIn: false, retryable: true });
      setSaveStatus("idle");
      setRetry({ question, localMessageId, body });
    } finally {
      setLoading(false);
    }
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || loading) return;
    const localMessageId = "coach-user-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    setMessages(current => [...current, { id: localMessageId, role: "user", content: question, status: "pending" }]);
    setDraft("");
    void sendRequest(question, localMessageId);
  }

  function retryRequest() {
    if (!retry || loading) return;
    void sendRequest(retry.question, retry.localMessageId, retry);
  }

  function startNewConversation() {
    if (loading) return;
    setMessages([]);
    setDraft("");
    setConversationId(null);
    setError(null);
    setRetry(null);
    setSaveStatus("idle");
  }

  return <section className="workspace-coach" aria-labelledby="workspace-coach-title">
    <div className="workspace-coach-heading">
      <div className="workspace-coach-identity">
        <span className="workspace-coach-icon"><Sparkles size={17} /></span>
        <div><span className="panel-kicker">WORKSPACE AI COACH</span><h2 id="workspace-coach-title">Find a clear, doable next move.</h2><p>Ask about your ideas, actions, upcoming plans, or progress.</p></div>
      </div>
      <div className="workspace-coach-actions">
        {messages.length > 0 && <button type="button" onClick={startNewConversation} disabled={loading}>New chat</button>}
        <button type="button" onClick={onShowHistory}>History</button>
      </div>
    </div>
    <p className="workspace-coach-boundary">Advice only. Nothing will be added to Actions or Calendar.</p>
    <div className="workspace-coach-context-controls">
      <label><input type="checkbox" checked={contextEnabled} onChange={event => setContextEnabled(event.target.checked)} /><span>Use my Workspace snapshot</span></label>
      <button type="button" aria-expanded={contextDetailsOpen} onClick={() => setContextDetailsOpen(open => !open)}>What's shared? <ChevronDown size={13} /></button>
      {contextEnabled && snapshotTotal > 0 && <span className="workspace-coach-context-count">{counts.ideas} ideas | {counts.actions} actions | {counts.calendar} plans | {counts.outcomes} progress records</span>}
      {contextEnabled && snapshotTotal === 0 && <span className="workspace-coach-context-count">No Workspace records to include yet</span>}
    </div>
    {contextDetailsOpen && <p className="workspace-coach-privacy">When enabled, up to 5 recent ideas, 8 actions, 5 plans in the next 14 days, and 3 progress records are sent with each question. Your question and Coach replies are saved in AI Team Conversations; your Workspace records remain in this browser.</p>}
    <div className="workspace-coach-prompts" role="group" aria-label="Suggested questions">
      {coachPrompts.map(prompt => <button type="button" key={prompt} onClick={() => setDraft(prompt)} disabled={loading}>{prompt}</button>)}
    </div>
    <div className="workspace-coach-thread" role="log" aria-label="Workspace AI Coach conversation" aria-live="polite">
      {messages.length === 0 && !loading && <p className="workspace-coach-empty">Your Workspace follows your lead. Ask for a reflection, or choose a question above.</p>}
      {messages.map(message => <article className={"workspace-coach-message " + message.role} key={message.id}>
        <div className="workspace-coach-message-meta"><b>{message.role === "user" ? "You" : "AI Action Coach"}</b>{message.role === "user" && message.status === "pending" && <span>Sending...</span>}{message.role === "user" && message.status === "failed" && <span>Not completed</span>}</div>
        {message.role === "user" ? <p className="workspace-coach-user-text">{message.content}</p> : message.result ? <div className="workspace-coach-result">
          <section><h3>What I notice</h3><p>{message.result.perspective}</p></section>
          {message.result.opportunities.length > 0 && <section><h3>Ways to improve</h3><ul>{message.result.opportunities.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
          {message.result.risks.length > 0 && <section><h3>What may get in the way</h3><ul>{message.result.risks.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
          <section className="workspace-coach-next-step"><h3>A possible next step</h3><p>{message.result.nextStep}</p></section>
          {message.result.questions.length > 0 && <details><summary>Questions to consider</summary><ul>{message.result.questions.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
          {message.result.uncertainty.length > 0 && <details><summary>What I cannot infer yet</summary><ul>{message.result.uncertainty.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
        </div> : <MarkdownContent content={message.content} />}
      </article>)}
      {loading && <p className="workspace-coach-loading" role="status"><span /> Reading your shared Workspace snapshot...</p>}
    </div>
    <form className="workspace-coach-form" onSubmit={submitQuestion}>
      <label className="sr-only" htmlFor="workspace-coach-input">Ask the Workspace AI Coach</label>
      <textarea id="workspace-coach-input" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} maxLength={1200} rows={2} placeholder="Ask about your Workspace..." disabled={loading} />
      <div className="workspace-coach-form-footer"><span>{draft.length}/1200 | Enter to send, Shift+Enter for a new line</span><button type="submit" disabled={!draft.trim() || loading}>{loading ? "Thinking..." : "Ask Coach"}<Send size={14} /></button></div>
    </form>
    {error && <p className="workspace-coach-error" role="alert">{error.message}{error.needsSignIn && <> <Link href="/login?next=%2Fworkspace">Sign in</Link></>}{error.retryable && retry && <button type="button" onClick={retryRequest} disabled={loading}>Try again</button>}</p>}
    {saveStatus !== "idle" && <p className="workspace-coach-save-status" role="status">{saveStatus === "saving" ? "Saving this conversation..." : saveStatus === "saved" ? "Saved in AI Team Conversations" : "The reply is ready, but the conversation may not have been saved."}</p>}
    <div className="workspace-coach-footer"><Sparkles size={12} /><span>Suggestions reflect only the records shared with this question.</span><Link href="/about">How AIASK thinks</Link></div>
  </section>;
}
