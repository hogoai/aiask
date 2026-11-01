"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, BookOpen, CalendarDays, Check, ChevronDown, Circle, Compass, Lightbulb, ListTodo, MessageSquare, Search, Sparkles, Target, TrendingUp, X } from "lucide-react";
import SiteNavigation from "../SiteNavigation";
import MarkdownContent from "../partners/MarkdownContent";
import type { AIConversation, ConversationListItem } from "../../lib/ai/conversations";
import { PARTNER_ROLE_ID, type PartnerRole } from "../../lib/ai/contracts";
import "./workspace.css";
import WorkspaceCoach from "./WorkspaceCoach";

type IdeaStatus = "Saved" | "In progress" | "Done";
type IdeaRecord = { id: string; text: string; createdAt: string; updatedAt?: string; status?: IdeaStatus; nextStep?: string; progressUpdatedAt?: string };
type PlannerEvent = { id: string; ideaId: string | null; todoId: string | null; title: string; scheduledDate: string; scheduledTime: string | null; description: string; createdAt: string };
type PlannerTodo = { id: string; ideaId: string | null; eventId: string | null; title: string; dueDate: string; status: "Open" | "Done"; createdAt?: string; completedAt?: string };
type PlannerData = { events: PlannerEvent[]; todos: PlannerTodo[] };
type WorkspaceTab = "Overview" | "Ideas" | "Actions" | "Outcomes" | "Conversations";
type IdeaFilter = "All" | IdeaStatus;

const emptyPlanner: PlannerData = { events: [], todos: [] };
const tabs: { label: WorkspaceTab; icon: typeof Compass }[] = [
  { label: "Overview", icon: Compass },
  { label: "Ideas", icon: Lightbulb },
  { label: "Actions", icon: ListTodo },
  { label: "Outcomes", icon: TrendingUp },
  { label: "Conversations", icon: MessageSquare },
];
const conversationRoles: { id: PartnerRole; label: string }[] = [
  { id: PARTNER_ROLE_ID.guide, label: "AI Guide" },
  { id: PARTNER_ROLE_ID.planner, label: "AI Planner" },
  { id: PARTNER_ROLE_ID.knowledgePartner, label: "AI Knowledge Specialist" },
  { id: PARTNER_ROLE_ID.evaluator, label: "AI Evaluator" },
  { id: PARTNER_ROLE_ID.advisor, label: "AI Advisor" },
  { id: PARTNER_ROLE_ID.actionPartner, label: "AI Action Coach" },
];

function formatDate(value: string, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function formatEventDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "Date to be confirmed";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date);
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDateOnly(value: string) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function ideaStatus(idea: IdeaRecord): IdeaStatus { return idea.status ?? "Saved"; }

export default function WorkspacePage() {
  const [ready, setReady] = useState(false);
  const [ideas, setIdeas] = useState<IdeaRecord[]>([]);
  const [planner, setPlanner] = useState<PlannerData>(emptyPlanner);
  const [tab, setTab] = useState<WorkspaceTab>("Overview");
  const [ideaFilter, setIdeaFilter] = useState<IdeaFilter>("All");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [conversationSearch, setConversationSearch] = useState("");
  const [conversationRoleFilter, setConversationRoleFilter] = useState<"all" | PartnerRole>("all");
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [conversationStatus, setConversationStatus] = useState<"idle" | "loading" | "ready" | "sign_in" | "unavailable" | "error">("idle");
  const [conversationError, setConversationError] = useState("");
  const [selectedConversation, setSelectedConversation] = useState<AIConversation | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  useEffect(() => {
    try {
      const storedIdeas = window.localStorage.getItem("aiask-idea-box");
      if (storedIdeas) {
        const parsed: unknown = JSON.parse(storedIdeas);
        if (Array.isArray(parsed)) setIdeas(parsed.filter((item): item is IdeaRecord => item && typeof item.id === "string" && typeof item.text === "string" && typeof item.createdAt === "string"));
      }
      const storedPlanner = window.localStorage.getItem("aiask-planner");
      if (storedPlanner) {
        const parsed: unknown = JSON.parse(storedPlanner);
        if (parsed && typeof parsed === "object" && "events" in parsed && "todos" in parsed && Array.isArray(parsed.events) && Array.isArray(parsed.todos)) setPlanner({ events: parsed.events as PlannerEvent[], todos: parsed.todos as PlannerTodo[] });
      }
    } catch {
      setError("We couldn’t read some saved workspace data in this browser.");
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    if (tab !== "Conversations") return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setConversationStatus("loading");
      setConversationError("");
      const params = new URLSearchParams();
      if (conversationRoleFilter !== "all") params.set("partnerRole", conversationRoleFilter);
      if (conversationSearch.trim()) params.set("q", conversationSearch.trim());
      try {
        const response = await fetch("/api/ai/conversations?" + params.toString(), { signal: controller.signal });
        const payload: unknown = await response.json();
        if (!response.ok) {
          const errorPayload = payload && typeof payload === "object" && "error" in payload ? (payload as { error?: { code?: string; message?: string } }).error : undefined;
          setConversationStatus(errorPayload?.code === "sign_in_required" ? "sign_in" : errorPayload?.code === "conversation_storage_unavailable" ? "unavailable" : "error");
          setConversationError(errorPayload?.message || "AI conversation history could not be loaded.");
          return;
        }
        const results = payload && typeof payload === "object" && "conversations" in payload
          ? (payload as { conversations?: ConversationListItem[] }).conversations
          : null;
        if (!Array.isArray(results)) throw new Error("The conversation list response was invalid.");
        setConversations(results);
        setConversationStatus("ready");
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setConversationStatus("error");
        setConversationError(loadError instanceof Error ? loadError.message : "AI conversation history could not be loaded.");
      }
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [tab, conversationRoleFilter, conversationSearch]);

  const openTasks = useMemo(() => planner.todos.filter(todo => todo.status !== "Done").sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999")), [planner.todos]);
  const completedTasks = useMemo(() => planner.todos.filter(todo => todo.status === "Done"), [planner.todos]);
  const upcomingEvents = useMemo(() => planner.events.filter(event => event.scheduledDate >= localDateKey(new Date())).sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || (a.scheduledTime ?? "").localeCompare(b.scheduledTime ?? "")), [planner.events]);
  const inProgressIdeas = useMemo(() => ideas.filter(idea => ideaStatus(idea) === "In progress"), [ideas]);
  const focusIdeas = useMemo(() => {
    const candidates = inProgressIdeas.length > 0 ? inProgressIdeas : ideas.filter(idea => ideaStatus(idea) === "Saved");
    return [...candidates].sort((a, b) => (b.progressUpdatedAt ?? b.updatedAt ?? b.createdAt).localeCompare(a.progressUpdatedAt ?? a.updatedAt ?? a.createdAt)).slice(0, 5);
  }, [ideas, inProgressIdeas]);
  const outcomes = useMemo(() => ideas.filter(idea => ideaStatus(idea) === "Done" || idea.progressUpdatedAt).sort((a, b) => (b.progressUpdatedAt ?? b.updatedAt ?? b.createdAt).localeCompare(a.progressUpdatedAt ?? a.updatedAt ?? a.createdAt)), [ideas]);
  const filteredIdeas = useMemo(() => ideas.filter(idea => (ideaFilter === "All" || ideaStatus(idea) === ideaFilter) && idea.text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [ideas, ideaFilter, search]);
  async function openConversation(conversationId: string) {
    setSelectedConversation(null);
    setDetailLoading(true);
    setDetailError("");
    try {
      const response = await fetch("/api/ai/conversations/" + conversationId);
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message = payload && typeof payload === "object" && "error" in payload
          ? (payload as { error?: { message?: string } }).error?.message
          : undefined;
        throw new Error(message || "This conversation could not be opened.");
      }
      const conversation = payload && typeof payload === "object" && "conversation" in payload
        ? (payload as { conversation?: AIConversation }).conversation
        : null;
      if (!conversation || !Array.isArray(conversation.messages)) throw new Error("This conversation has an invalid history.");
      setSelectedConversation(conversation);
    } catch (openError) {
      setDetailError(openError instanceof Error ? openError.message : "This conversation could not be opened.");
    } finally {
      setDetailLoading(false);
    }
  }

  function toggleTodo(todoId: string) {
    const now = new Date().toISOString();
    const next: PlannerData = { ...planner, todos: planner.todos.map(todo => todo.id === todoId ? { ...todo, status: todo.status === "Done" ? "Open" : "Done", completedAt: todo.status === "Done" ? undefined : now } : todo) };
    try {
      window.localStorage.setItem("aiask-planner", JSON.stringify(next));
      setPlanner(next);
      setError("");
    } catch {
      setError("That action couldn’t be saved. Please check your browser storage and try again.");
    }
  }

  const linkedEvents = (ideaId: string) => planner.events.filter(event => event.ideaId === ideaId);
  const linkedTodos = (ideaId: string) => planner.todos.filter(todo => todo.ideaId === ideaId);

  return <main className="workspace-page">
    <aside className="workspace-rail">
      <Link className="workspace-brand" href="/" aria-label="AIASK home"><span className="workspace-brand-mark"><Sparkles size={16} /></span><span>aiask<span>.</span></span></Link>
      <div className="workspace-rail-label">YOUR SPACE</div>
      <nav aria-label="Workspace sections" className="workspace-rail-nav">
        {tabs.map(({ label, icon: Icon }) => <button key={label} type="button" className={tab === label ? "workspace-rail-link active" : "workspace-rail-link"} onClick={() => setTab(label)} aria-current={tab === label ? "page" : undefined}><Icon size={16} /><span>{label}</span>{label === "Ideas" && ready && <small>{ideas.length}</small>}{label === "Actions" && ready && <small>{openTasks.length}</small>}{label === "Conversations" && conversationStatus === "ready" && <small>{conversations.length}</small>}</button>)}
      </nav>
      <div className="workspace-rail-bottom"><div className="workspace-rail-note"><span><Sparkles size={14} /></span><p>A flexible space for thoughts at every stage.</p></div><Link href="/" className="workspace-back-link">Back to AIASK <ArrowUpRight size={14} /></Link></div>
    </aside>

    <div className="workspace-main">
      <div className="workspace-local-data-note" role="note"><b>Data &amp; privacy</b><span>AI conversations require sign-in and the Supabase conversation migration. Ideas, actions, and calendar plans remain browser-only demo data.</span></div>
      <SiteNavigation active="workspace" />

      <div className="workspace-content">
        <div className="workspace-heading-row"><div><p className="workspace-eyebrow">A SPACE FOR WHAT’S TAKING SHAPE</p><h1>My Workspace<span>.</span></h1><p className="workspace-subtitle">Your ideas, conversations and knowledge — all in one private space.</p></div><Link className="workspace-capture-link workspace-header-capture" href="/#top"><Lightbulb size={14} /><span>Capture a thought</span><ArrowUpRight size={13} /></Link></div>



        {error && <p className="workspace-error" role="alert">{error}</p>}
        {!ready ? <div className="workspace-loading"><span className="workspace-loading-dot" /> Gathering your thoughts and plans…</div> : <>
          {tab === "Overview" && <>
            <section className="workspace-stats" aria-label="Workspace summary">
              <article><span className="stat-icon ideas-stat"><Lightbulb size={16} /></span><p>Saved thoughts</p><strong>{ideas.length}</strong><small>Ideas, questions, and possibilities</small></article>
              <article><span className="stat-icon active-stat"><Target size={16} /></span><p>In motion</p><strong>{inProgressIdeas.length}</strong><small>Thoughts with an active next step</small></article>
              <article><span className="stat-icon action-stat"><ListTodo size={16} /></span><p>Open actions</p><strong>{openTasks.length}</strong><small>Across your plans and to-dos</small></article>
              <article><span className="stat-icon done-stat"><Check size={16} /></span><p>Completed</p><strong>{completedTasks.length + ideas.filter(idea => ideaStatus(idea) === "Done").length}</strong><small>Actions and ideas marked done</small></article>
            </section>

            <div className="workspace-overview-grid">
              <section className="workspace-panel motion-panel">
                <div className="workspace-panel-heading">
                  <div>
                    <span className="panel-kicker">{inProgressIdeas.length ? "CURRENT FOCUS" : "READY WHEN YOU ARE"}</span>
                    <h2>{inProgressIdeas.length ? "In motion" : "Ideas to revisit"}</h2>
                  </div>
                  <button type="button" className="panel-link" onClick={() => setTab("Ideas")}>All ideas <ArrowRight size={13} /></button>
                </div>
                {!focusIdeas.length ? (
                  <div className="workspace-empty-state">
                    <span><Lightbulb size={19} /></span>
                    <h3>{ideas.length === 0 ? "Start wherever you are." : "Nothing in motion right now."}</h3>
                    <p>{ideas.length === 0 ? "Save a question, a small task, or a big ambition. It does not need a plan yet." : "Your completed ideas are in Progress & outcomes. Leave space open until you are ready to pick something up."}</p>
                    {ideas.length === 0 ? (
                      <Link href="/#top">Capture a thought <ArrowRight size={13} /></Link>
                    ) : (
                      <button type="button" onClick={() => setTab("Outcomes")}>Review progress <ArrowRight size={13} /></button>
                    )}
                  </div>
                ) : (
                  <>
                    {!inProgressIdeas.length && <p className="workspace-panel-context">Saved ideas you can pick up whenever you are ready.</p>}
                    <div className="motion-list">
                      {focusIdeas.map(idea => <details className="motion-item" key={idea.id}>
                        <summary>
                          <span className={`idea-status-pill ${ideaStatus(idea).toLowerCase().replace(" ", "-")}`}><i />{ideaStatus(idea)}</span>
                          <span className="motion-item-copy"><b>{idea.text}</b><small>{idea.progressUpdatedAt ? `Updated ${formatDate(idea.progressUpdatedAt)}` : `Captured ${formatDate(idea.createdAt)}`}</small></span>
                          <ChevronDown size={15} />
                        </summary>
                        <div className="motion-detail">
                          {idea.nextStep && <p><strong>{ideaStatus(idea) === "Done" ? "Reflection" : "Next step"}</strong>{idea.nextStep}</p>}
                          <div className="motion-detail-links">
                            {linkedTodos(idea.id).length > 0 && <span><ListTodo size={12} />{linkedTodos(idea.id).filter(todo => todo.status === "Done").length}/{linkedTodos(idea.id).length} actions complete</span>}
                            {linkedEvents(idea.id).length > 0 && <span><CalendarDays size={12} />{linkedEvents(idea.id).length} calendar {linkedEvents(idea.id).length === 1 ? "plan" : "plans"}</span>}
                            {!idea.nextStep && linkedTodos(idea.id).length === 0 && linkedEvents(idea.id).length === 0 && <span><Circle size={12} />No plan attached yet. That is okay.</span>}
                          </div>
                        </div>
                      </details>)}
                    </div>
                  </>
                )}
              </section>

              <section className="workspace-panel next-panel"><div className="workspace-panel-heading"><div><span className="panel-kicker">YOUR NEXT STEPS</span><h2>Small, doable actions</h2></div><button type="button" className="panel-link" onClick={() => setTab("Actions")}>All actions <ArrowRight size={13} /></button></div>
                {openTasks.length === 0 ? <div className="workspace-empty-state compact"><span><Check size={18} /></span><h3>Nothing pressing.</h3><p>Leave room for thinking, or add a task when you’re ready.</p><button type="button" onClick={() => setTab("Actions")}>View actions <ArrowRight size={13} /></button></div> : <div className="workspace-task-list">{openTasks.slice(0, 5).map(todo => <TaskRow key={todo.id} todo={todo} ideas={ideas} onToggle={toggleTodo} />)}</div>}
              </section>

              <section className="workspace-panel workspace-calendar-panel"><div className="workspace-panel-heading"><div><span className="panel-kicker">MAKING ROOM</span><h2>Coming up</h2></div><CalendarDays size={16} /></div>
                {upcomingEvents.length === 0 ? <p className="workspace-panel-empty">No calendar plans ahead. Keep your schedule open until something needs a time.</p> : <div className="coming-list">{upcomingEvents.slice(0, 4).map(event => <div className="coming-event" key={event.id}><time>{formatEventDate(event.scheduledDate)}</time><div><b>{event.title}</b><small>{event.scheduledTime ?? "Any time"}{event.ideaId && ideas.find(idea => idea.id === event.ideaId) ? ` · ${ideas.find(idea => idea.id === event.ideaId)?.text}` : ""}</small></div></div>)}</div>}
              </section>

              <section className="workspace-panel outcome-panel"><div className="workspace-panel-heading"><div><span className="panel-kicker">LOOKING BACK</span><h2>Progress &amp; outcomes</h2></div><button type="button" className="panel-link" onClick={() => setTab("Outcomes")}>Review <ArrowRight size={13} /></button></div>
                {outcomes.length === 0 && completedTasks.length === 0 ? <p className="workspace-panel-empty">Completed work and check-ins will gather here over time. There’s no pressure to turn every thought into a finished project.</p> : <div className="outcome-list">{outcomes.slice(0, 3).map(idea => <div className="outcome-row" key={idea.id}><span className="outcome-check"><Check size={12} /></span><div><b>{idea.text}</b><small>{ideaStatus(idea) === "Done" ? "Marked complete" : "Progress check-in"}{idea.progressUpdatedAt ? ` · ${formatDate(idea.progressUpdatedAt)}` : ""}{idea.nextStep ? ` · ${idea.nextStep}` : ""}</small></div></div>)}{completedTasks.slice(0, 2).map(todo => <div className="outcome-row" key={todo.id}><span className="outcome-check"><Check size={12} /></span><div><b>{todo.title}</b><small>Action completed{todo.dueDate ? ` · Due ${formatDate(todo.dueDate)}` : ""}</small></div></div>)}</div>}
              </section>
            </div>
            <WorkspaceCoach ideas={ideas} planner={planner} onShowHistory={() => { setConversationRoleFilter(PARTNER_ROLE_ID.actionPartner); setTab("Conversations"); }} />
          </>}

          {tab === "Ideas" && <section className="workspace-list-view"><div className="list-view-heading"><div><span className="panel-kicker">YOUR IDEA BOX, WITH CONTEXT</span><h2>Ideas and intentions</h2><p>Thoughts stay connected to the plans and progress you choose to make.</p></div><Link className="workspace-add-button" href="/#top"><Lightbulb size={14} /> Capture a thought</Link></div><div className="idea-filter-bar"><div className="idea-filters" role="group" aria-label="Filter ideas">{(["All", "Saved", "In progress", "Done"] as IdeaFilter[]).map(filter => <button key={filter} type="button" className={ideaFilter === filter ? "selected" : ""} onClick={() => setIdeaFilter(filter)}>{filter}<span>{filter === "All" ? ideas.length : ideas.filter(item => ideaStatus(item) === filter).length}</span></button>)}</div><label className="workspace-search"><Search size={14} /><span className="sr-only">Search ideas</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a thought" /></label></div>
            {filteredIdeas.length === 0 ? <div className="workspace-empty-state list-empty"><span><BookOpen size={19} /></span><h3>{ideas.length ? "No thoughts match this view." : "Your Idea Box has room to grow."}</h3><p>{ideas.length ? "Try another status or a shorter search." : "You can keep a thought here before deciding what it should become."}</p>{ideas.length === 0 && <Link href="/#top">Capture a thought <ArrowRight size={13} /></Link>}</div> : <div className="workspace-idea-list">{filteredIdeas.map(idea => <details className="workspace-idea-card" key={idea.id}><summary><span className={`idea-status-pill ${ideaStatus(idea).toLowerCase().replace(" ", "-")}`}><i />{ideaStatus(idea)}</span><span className="workspace-idea-main"><b>{idea.text}</b><small>Captured {formatDate(idea.createdAt)}{idea.updatedAt && ` · Updated ${formatDate(idea.updatedAt)}`}</small></span><span className="idea-related-counts">{linkedTodos(idea.id).length > 0 && <span><ListTodo size={12} />{linkedTodos(idea.id).length}</span>}{linkedEvents(idea.id).length > 0 && <span><CalendarDays size={12} />{linkedEvents(idea.id).length}</span>}</span><ChevronDown size={15} /></summary><div className="workspace-idea-expanded">{idea.nextStep && <div className="idea-reflection"><span>{ideaStatus(idea) === "Done" ? "REFLECTION / LAST NOTE" : "NEXT STEP"}</span><p>{idea.nextStep}</p></div>}<div className="idea-linked-grid">{linkedTodos(idea.id).map(todo => <div key={todo.id}><span><ListTodo size={12} />ACTION</span><b>{todo.title}</b><small>{todo.status}{todo.dueDate && ` · ${formatDate(todo.dueDate)}`}</small></div>)}{linkedEvents(idea.id).map(event => <div key={event.id}><span><CalendarDays size={12} />ON YOUR CALENDAR</span><b>{event.title}</b><small>{formatEventDate(event.scheduledDate)}{event.scheduledTime && ` · ${event.scheduledTime}`}</small></div>)}</div>{idea.progressUpdatedAt && <p className="idea-last-review">Last progress review · {formatDate(idea.progressUpdatedAt, { dateStyle: "medium", timeStyle: "short" })}</p>}</div></details>)}</div>}</section>}

          {tab === "Actions" && <section className="workspace-list-view"><div className="list-view-heading"><div><span className="panel-kicker">PLANS YOU CHOSE TO MAKE</span><h2>Actions and calendar</h2><p>Tasks stay connected to the ideas they serve. Nothing here needs to become a rigid project plan.</p></div><Link className="workspace-add-button" href="/"><ArrowUpRight size={14} /> Back to AIASK</Link></div><div className="actions-columns"><section className="workspace-panel"><div className="workspace-panel-heading"><div><span className="panel-kicker">TO-DO</span><h3>Open actions <small>{openTasks.length}</small></h3></div></div>{openTasks.length ? <div className="workspace-task-list">{openTasks.map(todo => <TaskRow key={todo.id} todo={todo} ideas={ideas} onToggle={toggleTodo} />)}</div> : <p className="workspace-panel-empty">No open actions right now.</p>}</section><section className="workspace-panel"><div className="workspace-panel-heading"><div><span className="panel-kicker">ON YOUR CALENDAR</span><h3>Plans with a time <small>{upcomingEvents.length}</small></h3></div></div>{upcomingEvents.length ? <div className="coming-list">{upcomingEvents.map(event => <div className="coming-event" key={event.id}><time>{formatEventDate(event.scheduledDate)}</time><div><b>{event.title}</b><small>{event.scheduledTime ?? "Any time"}{event.ideaId && ideas.find(idea => idea.id === event.ideaId) ? ` · ${ideas.find(idea => idea.id === event.ideaId)?.text}` : ""}</small></div></div>)}</div> : <p className="workspace-panel-empty">No upcoming calendar plans. Your time is yours to shape.</p>}</section></div><section className="workspace-panel completed-actions"><div className="workspace-panel-heading"><div><span className="panel-kicker">ALREADY DONE</span><h3>Completed actions <small>{completedTasks.length}</small></h3></div></div>{completedTasks.length ? <div className="workspace-task-list">{completedTasks.map(todo => <TaskRow key={todo.id} todo={todo} ideas={ideas} onToggle={toggleTodo} />)}</div> : <p className="workspace-panel-empty">Small steps count. Completed tasks will appear here.</p>}</section></section>}

          {tab === "Outcomes" && <section className="workspace-list-view"><div className="list-view-heading"><div><span className="panel-kicker">NOTICE WHAT CHANGED</span><h2>Progress &amp; outcomes</h2><p>Keep a gentle record of what you finished, what you learned, and what might come next.</p></div><div className="outcomes-count"><Check size={15} />{outcomes.length + completedTasks.length} recorded</div></div>{outcomes.length === 0 && completedTasks.length === 0 ? <div className="workspace-empty-state list-empty"><span><TrendingUp size={19} /></span><h3>Progress begins with a first step.</h3><p>When you check in or complete an action, you’ll find that progress here. It’s fine if an idea remains open-ended.</p><button type="button" onClick={() => setTab("Ideas")}>Explore your ideas <ArrowRight size={13} /></button></div> : <div className="outcomes-timeline">{outcomes.map((idea, index) => <article className="outcome-timeline-item" key={idea.id}><span className="timeline-marker"><Check size={12} /></span><div className="timeline-content"><div className="timeline-meta"><span>{ideaStatus(idea) === "Done" ? "IDEA COMPLETED" : "PROGRESS REVIEW"}</span><time>{formatDate(idea.progressUpdatedAt ?? idea.updatedAt ?? idea.createdAt, { dateStyle: "medium", timeStyle: "short" })}</time></div><h3>{idea.text}</h3>{idea.nextStep && <p>{ideaStatus(idea) === "Done" ? "Reflection / note" : "Next step / note"}: {idea.nextStep}</p>}{linkedTodos(idea.id).length > 0 && <small>{linkedTodos(idea.id).filter(todo => todo.status === "Done").length} of {linkedTodos(idea.id).length} linked actions completed</small>}</div>{index < outcomes.length - 1 && <span className="timeline-connector" />}</article>)}{completedTasks.map(todo => <article className="outcome-timeline-item" key={todo.id}><span className="timeline-marker"><Check size={12} /></span><div className="timeline-content"><div className="timeline-meta"><span>ACTION COMPLETED</span><time>{todo.completedAt ? formatDate(todo.completedAt, { dateStyle: "medium", timeStyle: "short" }) : "Completion date not recorded"}</time></div><h3>{todo.title}</h3>{todo.ideaId && ideas.find(idea => idea.id === todo.ideaId) && <p>Connected to: {ideas.find(idea => idea.id === todo.ideaId)?.text}</p>}</div></article>)}</div>}</section>}
          {tab === "Conversations" && <section className="workspace-list-view conversation-history-view"><div className="list-view-heading"><div><span className="panel-kicker">AI PILOT HISTORY</span><h2>All Conversations</h2><p>Return to a question, compare perspectives from the AI Team, and continue thinking at your own pace.</p></div><Link className="workspace-add-button" href="/partners"><MessageSquare size={14} /> Start a conversation</Link></div>
            <div className="conversation-controls"><div className="conversation-role-filters" role="group" aria-label="Filter conversations by AI Team role"><button type="button" className={conversationRoleFilter === "all" ? "selected" : ""} onClick={() => setConversationRoleFilter("all")}>All Conversations</button>{conversationRoles.map(role => <button type="button" key={role.id} className={conversationRoleFilter === role.id ? "selected" : ""} onClick={() => setConversationRoleFilter(role.id)}>{role.label}</button>)}</div><label className="workspace-search"><Search size={14} /><span className="sr-only">Search conversation titles and messages</span><input value={conversationSearch} onChange={event => setConversationSearch(event.target.value)} placeholder="Search conversations" /></label></div>
            {conversationStatus === "loading" && <div className="workspace-loading"><span className="workspace-loading-dot" /> Loading conversations…</div>}
            {conversationStatus === "sign_in" && <div className="workspace-empty-state list-empty"><span><MessageSquare size={19} /></span><h3>Sign in to view your conversations.</h3><p>{conversationError}</p><Link href="/login?next=%2Fworkspace">Sign in <ArrowRight size={13} /></Link></div>}
            {conversationStatus === "unavailable" && <div className="workspace-empty-state list-empty"><span><BookOpen size={19} /></span><h3>Conversation storage needs setup.</h3><p>{conversationError} Run <code>supabase/migrations/0002_ai_pilot_conversations.sql</code> after migration 0001.</p></div>}
            {conversationStatus === "error" && <p className="workspace-error" role="alert">{conversationError}</p>}
            {conversationStatus === "ready" && conversations.length === 0 && <div className="workspace-empty-state list-empty"><span><MessageSquare size={19} /></span><h3>{conversationSearch.trim() || conversationRoleFilter !== "all" ? "No matching conversations." : "Your conversations will appear here."}</h3><p>{conversationSearch.trim() || conversationRoleFilter !== "all" ? "Try another search or AI Team role filter." : "Start with an idea, explore it with the AI Team, and return whenever you want to think further."}</p>{!conversationSearch.trim() && conversationRoleFilter === "all" && <Link href="/partners">Explore the AI Team <ArrowRight size={13} /></Link>}</div>}
            {conversationStatus === "ready" && conversations.length > 0 && <div className="conversation-history-layout"><div className="conversation-record-list">{conversations.map(conversation => { const role = conversationRoles.find(item => item.id === conversation.partnerRole); return <button type="button" className={selectedConversation?.id === conversation.id ? "conversation-record selected" : "conversation-record"} key={conversation.id} onClick={() => void openConversation(conversation.id)}><span className="conversation-record-main"><b>{conversation.title}</b><small>{role?.label ?? conversation.partnerRole}{conversation.isFavorite ? " · Favorite" : ""}</small><small>{conversation.ideaId ? "Linked idea" : "AI Pilot conversation"}{conversation.projectId ? " · Linked project" : ""}</small></span><time>{formatDate(conversation.updatedAt, { dateStyle: "medium", timeStyle: "short" })}</time><ArrowRight size={14} /></button>; })}</div><section className="workspace-panel conversation-detail-panel" aria-label="Conversation details">{detailLoading ? <div className="workspace-loading"><span className="workspace-loading-dot" /> Opening conversation…</div> : detailError ? <p className="workspace-error" role="alert">{detailError}</p> : selectedConversation ? <><div className="conversation-detail-heading"><div><span className="panel-kicker">{conversationRoles.find(role => role.id === selectedConversation.partnerRole)?.label ?? selectedConversation.partnerRole}</span><h3>{selectedConversation.title}</h3><time>Updated {formatDate(selectedConversation.updatedAt, { dateStyle: "medium", timeStyle: "short" })}</time></div><div className="conversation-detail-actions"><Link className="workspace-add-button" href={`/partners?conversationId=${encodeURIComponent(selectedConversation.id)}&partner=${encodeURIComponent(selectedConversation.partnerRole)}`}>Continue in AI Team <ArrowUpRight size={13} /></Link><button type="button" className="conversation-close" aria-label="Close conversation details" onClick={() => setSelectedConversation(null)}><X size={15} /></button></div></div><div className="conversation-transcript">{selectedConversation.messages.map(message => <article className={message.role === "user" ? "conversation-transcript-message user" : "conversation-transcript-message assistant"} key={message.id}><div className="conversation-message-meta"><b>{message.role === "user" ? "You" : conversationRoles.find(role => role.id === selectedConversation.partnerRole)?.label ?? "AI Team"}</b><time>{formatDate(message.createdAt, { dateStyle: "medium", timeStyle: "short" })}</time></div>{message.kind === "idea" && <span className="conversation-kind">Starting idea</span>}{message.role === "assistant" ? <MarkdownContent content={message.content} /> : <p className="conversation-user-content">{message.content}</p>}{message.role === "user" && message.status === "failed" && <p className="conversation-message-status failed">AI response failed. Your question is saved; open AI Team to try again.</p>}{message.role === "user" && message.status === "save_failed" && <p className="conversation-message-status failed">The AI reply could not be saved. Retry saving from the open AI Pilot page.</p>}{message.role === "user" && message.status === "pending" && <p className="conversation-message-status">Waiting for the AI response. Reopen AI Team if the request was interrupted.</p>}</article>)}</div></> : <div className="workspace-empty-state conversation-detail-empty"><span><BookOpen size={19} /></span><h3>Choose a conversation.</h3><p>Open a record to read its full exchange.</p></div>}</section></div>}
          </section>}
        </>}
      </div>
    </div>
  </main>;
}

function TaskRow({ todo, ideas, onToggle }: { todo: PlannerTodo; ideas: IdeaRecord[]; onToggle: (id: string) => void }) {
  const linkedIdea = ideas.find(idea => idea.id === todo.ideaId);
  return <div className={todo.status === "Done" ? "workspace-task-row done" : "workspace-task-row"}><button type="button" className="task-toggle" aria-label={todo.status === "Done" ? `Reopen ${todo.title}` : `Mark ${todo.title} complete`} onClick={() => onToggle(todo.id)}>{todo.status === "Done" ? <Check size={12} /> : <Circle size={15} />}</button><div className="task-row-copy"><b>{todo.title}</b><small>{todo.dueDate ? `Due ${formatDateOnly(todo.dueDate)}` : "No due date"}{linkedIdea ? ` · ${linkedIdea.text}` : ""}</small></div>{todo.status === "Done" ? <span className="task-row-status complete">Done</span> : <span className="task-row-status">Open</span>}</div>;
}
