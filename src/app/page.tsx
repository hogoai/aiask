"use client";

import TaskCreationBridge from "./workspace/TaskCreationBridge";
import { TASK_CREATED_EVENT } from "../lib/proactive/creation";
import PlannerAIChat from "./PlannerAIChat";
import NotesAIChat from "./NotesAIChat";
import { applyPlannerChange, buildCalendarPlannerContext, buildTodoPlannerContext } from "../lib/planner/ai-planner";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, ArrowUpRight, Bell, BookOpen, CalendarDays, Check, Clock3, Compass, Inbox, Lightbulb, Menu, MessageCircleQuestion, MoreHorizontal, Pencil, Plus, Send, Sparkles, Trash2, X } from "lucide-react";
import { getTaskPriority, PriorityControl, type TaskPriority } from "./PriorityControl";
import AccountControl from "./AccountControl";
import LandingPage from "./LandingPage";
import { useWorkspaceAccount } from "./workspace/useWorkspaceAccount";
import { defaultLocale } from "../i18n/config";
import "./site-navigation.css";
import { isSupabaseConfigured } from "../lib/supabase/config";
import { createClient } from "../lib/supabase/client";
import { getHomeView, homeViewUrl, type HomeView } from "../lib/home-navigation";
import { PARTNER_ROLE_ID, validateAIASKOutput, type NotesChatAction, type PartnerResponse, type PartnerRole, type PlannerChange } from "../lib/ai/contracts";
import { IDEA_KEY, readWorkspaceRecords, synchronizePlannerData, type IdeaRecord, type IdeaStatus, type NoteType } from "../lib/workspace/browser-records";
import { readWorkMemory, validateExtractedWorkMemory, workMemoryDuplicateKey, WORK_MEMORY_KEY, type WorkMemoryItem, type WorkMemoryStatus } from "../lib/workspace/work-memory";

type IdeaInboxFilter = "All" | "Inbox" | "In progress" | "Done";
type NotesView = "daily" | "all";
type PlannerEvent = { ownerId?: string; id: string; ideaId: string | null; todoId: string | null; title: string; scheduledDate: string; scheduledTime: string | null; description: string; priority?: TaskPriority; completed?: boolean; createdAt: string; origin?: "calendar" | "task-deadline" };
type PlannerTodo = { ownerId?: string; originConversationId?: string; id: string; ideaId: string | null; eventId: string | null; title: string; dueDate: string; status: "Open" | "Done"; priority?: TaskPriority; createdAt?: string; completedAt?: string; updatedAt?: string; remindAt?: string; remindedAt?: string; reminderPending?: boolean };
type PlannerData = { events: PlannerEvent[]; todos: PlannerTodo[] };
const AI_PARTNER_OPTIONS: { id: PartnerRole; name: string }[] = [
  { id: PARTNER_ROLE_ID.guide, name: "AI Guide" },
  { id: PARTNER_ROLE_ID.planner, name: "AI Planner" },
  { id: PARTNER_ROLE_ID.knowledgePartner, name: "AI Knowledge Partner" },
  { id: PARTNER_ROLE_ID.evaluator, name: "AI Evaluator" },
  { id: PARTNER_ROLE_ID.advisor, name: "AI Advisor" },
  { id: PARTNER_ROLE_ID.actionPartner, name: "AI Action Partner" },
];

function aiPartnerName(role: PartnerRole) {
  return AI_PARTNER_OPTIONS.find(partner => partner.id === role)?.name ?? "AI Partner";
}

function ideaTitleAndSummary(text: string) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return {
    title: lines[0] ?? text.trim(),
    summary: lines.slice(1).join(" ") || "No additional details captured.",
  };
}

function toDateInputValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function toDateTimeLocalValue(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function noteType(item: IdeaRecord): NoteType { return item.type ?? "Idea"; }

function workflowTitleFromNote(item: IdeaRecord) {
  return (item.nextStep?.trim() || ideaTitleAndSummary(item.text).title.trim()).slice(0, 240);
}

function notesViewContextKey(records: IdeaRecord[]) {
  let hash = 2166136261;
  for (const char of records.map(record => record.id).sort().join("|")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${records.length}-${(hash >>> 0).toString(36)}`;
}

function addDays(dateKey: string, amount: number) {
  const date = dateFromInput(dateKey);
  date.setDate(date.getDate() + amount);
  return toDateInputValue(date);
}

function dateFromInput(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function overdueDays(dueDate: string, today: string) {
  if (!dueDate || !today || dueDate >= today) return 0;
  const dayNumber = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    return Date.UTC(year, month - 1, day) / 86_400_000;
  };
  return dayNumber(today) - dayNumber(dueDate);
}

function countEventPriorities(events: PlannerEvent[], todos: PlannerTodo[]) {
  return events.reduce((counts, event) => {
    const linkedTodo = todos.find(todo => todo.id === event.todoId || todo.eventId === event.id);
    const priority = getTaskPriority(linkedTodo?.priority ?? event.priority);
    counts[priority] += 1;
    return counts;
  }, { urgent: 0, attention: 0, onTrack: 0 });
}


export default function Home() {
  return <Suspense fallback={<main className="wrap auth-gate-loading" role="status">Opening AIASK…</main>}><HomeContent /></Suspense>;
}

function HomeContent() {
  const workflowAccount = useWorkspaceAccount();
  const workflowOwnerId = workflowAccount.status === "ready" ? workflowAccount.userId : null;
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const view = getHomeView(searchParams);
  function setView(nextView: HomeView) {
    router.push(homeViewUrl(nextView, queryString));
  }
  const [captureOpen, setCaptureOpen] = useState(false);
  const [idea, setIdea] = useState("");
  const [ideaTypeDraft, setIdeaTypeDraft] = useState<NoteType>("Quick Note");
  const [saved, setSaved] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ideas, setIdeas] = useState<IdeaRecord[]>([]);
  const [workMemory, setWorkMemory] = useState<WorkMemoryItem[]>([]);
  const [workMemoryIncomplete, setWorkMemoryIncomplete] = useState(false);
  const [extractingMemoryMemoId, setExtractingMemoryMemoId] = useState<string | null>(null);
  const [workMemoryFeedback, setWorkMemoryFeedback] = useState<{ memoId: string; message: string; error?: boolean } | null>(null);
  const [draftOrigin, setDraftOrigin] = useState<{ ownerId: string; conversationId: string } | null>(null);
  const [plannerData, setPlannerData] = useState<PlannerData>({ events: [], todos: [] });
  const [todayDate, setTodayDate] = useState("");
  const [calendarCursor, setCalendarCursor] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => toDateInputValue(new Date()));
  const [eventTitle, setEventTitle] = useState("");
  const [eventDate, setEventDate] = useState(() => toDateInputValue(new Date()));
  const [eventTime, setEventTime] = useState("");
  const [eventIdeaId, setEventIdeaId] = useState("");
  const [todoTitle, setTodoTitle] = useState("");
  const [todoDueDate, setTodoDueDate] = useState("");
  const [todoReminderAt, setTodoReminderAt] = useState("");
  const [reminderError, setReminderError] = useState("");
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">("default");
  const [activeReminderId, setActiveReminderId] = useState<string | null>(null);
  const [rescheduleReminderAt, setRescheduleReminderAt] = useState("");
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [todoIdeaId, setTodoIdeaId] = useState("");
  const [todoPriority, setNewTodoPriority] = useState<TaskPriority>("onTrack");
  const [eventPriority, setNewEventPriority] = useState<TaskPriority>("onTrack");
  const [storageReady, setStorageReady] = useState(false);
  const [ideasIncomplete, setIdeasIncomplete] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [plannerNotice, setPlannerNotice] = useState("");
  const [noteWorkflowNotice, setNoteWorkflowNotice] = useState<{ message: string; undoTodoId?: string; error?: boolean } | null>(null);
  const [selectedIdea, setSelectedIdea] = useState<IdeaRecord | null>(null);
  const [ideaAnalysis, setIdeaAnalysis] = useState<{ ideaId: string; partnerRole: PartnerRole; result: PartnerResponse; saved: boolean } | null>(null);
  const [analyzingIdeaId, setAnalyzingIdeaId] = useState<string | null>(null);
  const [ideaAnalysisError, setIdeaAnalysisError] = useState<{ ideaId: string; partnerRole: PartnerRole; message: string } | null>(null);
  const [ideaInboxFilter, setIdeaInboxFilter] = useState<IdeaInboxFilter>("All");
  const [notesView, setNotesView] = useState<NotesView>("daily");
  const [noteTypeFilter, setNoteTypeFilter] = useState<NoteType | "All">("All");
  const [selectedNoteDate, setSelectedNoteDate] = useState(() => toDateInputValue(new Date()));
  const [chatNoteId, setChatNoteId] = useState<string | null>(null);
  const [notesChatOpen, setNotesChatOpen] = useState(false);
  const [notesChatSelectionIntent, setNotesChatSelectionIntent] = useState(0);
  const [openIdeaMenuId, setOpenIdeaMenuId] = useState<string | null>(null);
  const [editingIdeaId, setEditingIdeaId] = useState<string | null>(null);
  const [pendingSection, setPendingSection] = useState<string | null>(null);
  const [homeIdea, setHomeIdea] = useState("");
  const [homeIdeaSaved, setHomeIdeaSaved] = useState(false);
  const [proactiveOpen, setProactiveOpen] = useState(false);
  const [checkInIdeaId, setCheckInIdeaId] = useState<string | null>(null);
  const [checkInStatus, setCheckInStatus] = useState<IdeaStatus>("Saved");
  const [reviewPartnerRole, setReviewPartnerRole] = useState<PartnerRole>(PARTNER_ROLE_ID.guide);
  const [nextStepDraft, setNextStepDraft] = useState("");
  const [nextStepSuggestion, setNextStepSuggestion] = useState<{ ideaId: string; partnerRole: PartnerRole; text: string; saved: boolean } | null>(null);
  const [refiningNextStep, setRefiningNextStep] = useState(false);
  const [nextStepError, setNextStepError] = useState("");
  const [checkInSaved, setCheckInSaved] = useState(false);
  const [checkInSaving, setCheckInSaving] = useState(false);
  const [checkInSaveError, setCheckInSaveError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [authReady, setAuthReady] = useState(!isSupabaseConfigured());
  const checkInIdea = ideas.find(item => item.id === checkInIdeaId) ?? null;
  const selectedChatNote = ideas.find(item => item.id === chatNoteId) ?? null;
  const selectedMemoWorkMemory = selectedIdea ? workMemory.filter(item => item.memoId === selectedIdea.id) : [];
  const checkInAnalysis = ideaAnalysis?.ideaId === checkInIdea?.id ? ideaAnalysis : null;
  const checkInAnalysisError = ideaAnalysisError && ideaAnalysisError.ideaId === checkInIdea?.id && ideaAnalysisError.partnerRole === reviewPartnerRole ? ideaAnalysisError.message : "";
  const checkInSuggestion = nextStepSuggestion?.ideaId === checkInIdea?.id ? nextStepSuggestion : null;
  const isAnalyzingCheckInIdea = analyzingIdeaId === checkInIdea?.id;
  const ideaInboxFilters: IdeaInboxFilter[] = ["All", "Inbox", "In progress", "Done"];
  const statusFilteredIdeas = ideas.filter(item => {
    const status = item.status ?? "Saved";
    if (ideaInboxFilter === "All") return true;
    if (ideaInboxFilter === "Inbox") return status === "Saved";
    return status === ideaInboxFilter;
  });
  const typeFilteredIdeas = statusFilteredIdeas.filter(item => noteTypeFilter === "All" || noteType(item) === noteTypeFilter)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const visibleInboxIdeas = notesView === "daily"
    ? typeFilteredIdeas.filter(item => toDateInputValue(new Date(item.createdAt)) === selectedNoteDate)
    : typeFilteredIdeas;
  const inboxNoteDates = Array.from(new Set(visibleInboxIdeas.map(item => toDateInputValue(new Date(item.createdAt)))));
  const inboxNoteGroups = notesView === "daily"
    ? [[selectedNoteDate, visibleInboxIdeas] as const]
    : inboxNoteDates.map(date => [date, visibleInboxIdeas.filter(item => toDateInputValue(new Date(item.createdAt)) === date)] as const);
  const currentViewKey = notesViewContextKey(visibleInboxIdeas);
  const monthStart = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), 1);
  const calendarGridStart = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1 - ((monthStart.getDay() + 6) % 7));
  const calendarDates = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(calendarGridStart.getFullYear(), calendarGridStart.getMonth(), calendarGridStart.getDate() + index);
    return { date: toDateInputValue(day), day: day.getDate(), inMonth: day.getMonth() === calendarCursor.getMonth() };
  });
  const selectedDateEvents = plannerData.events.filter(event => event.scheduledDate === selectedCalendarDate).sort((a, b) => (a.scheduledTime ?? "").localeCompare(b.scheduledTime ?? ""));
  function priorityForEvent(event: PlannerEvent) {
    return getTaskPriority(plannerData.todos.find(todo => todo.id === event.todoId || todo.eventId === event.id)?.priority ?? event.priority);
  }
  const openTodos = plannerData.todos.filter(todo => todo.status !== "Done");
  const doneTodos = plannerData.todos.filter(todo => todo.status === "Done");
  const activeReminder = plannerData.todos.find(todo => todo.id === activeReminderId && todo.status !== "Done") ?? null;
  const calendarAIContext = buildCalendarPlannerContext(selectedCalendarDate, plannerData.events, plannerData.todos, ideas);
  const todosAIContext = buildTodoPlannerContext(plannerData.todos, plannerData.events, ideas);

  function selectNoteForAIChat(id: string) {
    setChatNoteId(id);
    setNotesChatOpen(true);
    setNotesChatSelectionIntent(intent => intent + 1);
  }

  useEffect(() => {
    setHydrated(true);
    setNotificationPermission("Notification" in window ? Notification.permission : "unsupported");
  }, []);

  useEffect(() => {
    let midnightTimer: number;
    function refreshTodayDate() {
      const now = new Date();
      setTodayDate(toDateInputValue(now));
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      midnightTimer = window.setTimeout(refreshTodayDate, Math.max(1_000, nextMidnight.getTime() - now.getTime() + 50));
    }
    refreshTodayDate();
    return () => window.clearTimeout(midnightTimer);
  }, []);

  useEffect(() => {
    if (!storageReady || activeReminderId) return;
    function checkForReminder() {
      const pendingTodo = plannerData.todos.find(todo => todo.status !== "Done" && todo.reminderPending);
      if (pendingTodo) {
        setActiveReminderId(pendingTodo.id);
        return;
      }
      const now = Date.now();
      const dueTodo = plannerData.todos.find(todo => todo.status !== "Done" && todo.remindAt && !todo.remindedAt && new Date(todo.remindAt).getTime() <= now);
      if (!dueTodo) return;
      const nextPlanner: PlannerData = {
        ...plannerData,
        todos: plannerData.todos.map(todo => todo.id === dueTodo.id ? { ...todo, remindedAt: new Date().toISOString(), reminderPending: true } : todo),
      };
      try {
        window.localStorage.setItem("aiask-planner", JSON.stringify(nextPlanner));
        setPlannerData(nextPlanner);
      } catch {
        setStorageError("The reminder appeared, but its status couldn’t be saved in this browser.");
      }
      setActiveReminderId(dueTodo.id);
      if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") {
        try { new Notification("AIASK reminder", { body: `Next step: ${dueTodo.title}` }); } catch { /* The in-app reminder remains available. */ }
      }
    }
    checkForReminder();
    const timer = window.setInterval(checkForReminder, 10000);
    return () => window.clearInterval(timer);
  }, [activeReminderId, plannerData, storageReady]);

  useEffect(() => {
    const params = new URLSearchParams(queryString);
    setCaptureOpen(params.get("capture") === "1");
    if (params.get("continue") === "1" && workflowAccount.status === "loading") return;
    try {
      if (params.get("continue") === "1") {
        const nextStep = window.localStorage.getItem("aiask-next-step-draft")?.trim();
        if (nextStep) {
          setTodoTitle(nextStep);
          const rawOrigin = window.localStorage.getItem("aiask-next-step-origin");
          const origin: unknown = rawOrigin ? JSON.parse(rawOrigin) : null;
          if (origin && typeof origin === "object" && "ownerId" in origin && "conversationId" in origin &&
            typeof origin.ownerId === "string" && typeof origin.conversationId === "string" &&
            workflowAccount.status === "ready" && origin.ownerId === workflowOwnerId) {
            setDraftOrigin({ ownerId: origin.ownerId, conversationId: origin.conversationId });
          }
          window.localStorage.removeItem("aiask-next-step-origin");
          setPlannerNotice("Review this next step, choose a due date or reminder, then add it to your To-do list.");
          window.localStorage.removeItem("aiask-next-step-draft");
        }
      }
    } catch {
      setStorageError("We couldn’t read your next-step draft from this browser.");
    }
  }, [queryString, workflowAccount.status, workflowOwnerId]);

  useEffect(() => {
    try {
      const storedIdeas = readWorkspaceRecords({ getItem: key => key === IDEA_KEY ? window.localStorage.getItem(IDEA_KEY) : null }).ideas;
      setIdeas(storedIdeas.data);
      setIdeasIncomplete(storedIdeas.incomplete);
      const storedWorkMemory = readWorkMemory({ getItem: key => key === WORK_MEMORY_KEY ? window.localStorage.getItem(WORK_MEMORY_KEY) : null });
      setWorkMemory(storedWorkMemory.data);
      setWorkMemoryIncomplete(storedWorkMemory.incomplete);
      if (storedWorkMemory.incomplete) setStorageError("Some saved Work Memory could not be read safely. Editing it is paused so the original data is not overwritten.");
      if (storedIdeas.incomplete) setStorageError("Some saved notes could not be read safely. Editing is paused so the original data is not overwritten.");
      if (storedIdeas.data.length) setSelectedNoteDate(toDateInputValue(new Date(storedIdeas.data.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0].createdAt)));
      const plannerStored = window.localStorage.getItem("aiask-planner");
      if (plannerStored) {
        const parsedPlanner: unknown = JSON.parse(plannerStored);
        if (parsedPlanner && typeof parsedPlanner === "object" && "events" in parsedPlanner && "todos" in parsedPlanner && Array.isArray(parsedPlanner.events) && Array.isArray(parsedPlanner.todos)) {
          const events = [...parsedPlanner.events as PlannerEvent[]];
          let repairedLinks = 0;
          const todos = (parsedPlanner.todos as PlannerTodo[]).map(todo => {
            const existingEvent = events.find(item => item.id === todo.eventId && (!item.todoId || item.todoId === todo.id))
              ?? events.find(item => item.todoId === todo.id);
            if (existingEvent) {
              if (todo.eventId !== existingEvent.id || existingEvent.todoId !== todo.id) {
                repairedLinks += 1;
                return { ...todo, eventId: existingEvent.id };
              }
              return todo;
            }
            if (!todo.dueDate) return todo.eventId ? { ...todo, eventId: null } : todo;
            const eventId = crypto.randomUUID();
            events.push({ id: eventId, todoId: todo.id, ideaId: todo.ideaId, title: todo.title, scheduledDate: todo.dueDate, scheduledTime: null, description: todo.title, priority: getTaskPriority(todo.priority), createdAt: todo.createdAt ?? new Date().toISOString(), origin: "task-deadline", completed: todo.status === "Done" });
            repairedLinks += 1;
            return { ...todo, eventId };
          });
          const loadedPlanner = synchronizePlannerData({ events, todos });
          setPlannerData(loadedPlanner);
          if (JSON.stringify(loadedPlanner) !== JSON.stringify(parsedPlanner)) {
            try {
              window.localStorage.setItem("aiask-planner", JSON.stringify(loadedPlanner));
              setPlannerNotice(repairedLinks > 0
                ? `${repairedLinks} task${repairedLinks === 1 ? " was" : "s were"} linked or synchronized with Calendar.`
                : "Linked tasks and Calendar items were synchronized.");
            } catch {
              setStorageError("Some task and Calendar links were repaired in this session, but the update could not be saved to browser storage.");
            }
          }
        }
      }
    } catch {
      setStorageError("We couldn’t read your saved ideas from this browser.");
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured() || (view === "home" && !captureOpen)) { setAuthReady(true); return; }
    let active = true;
    setAuthReady(false);
    void createClient().auth.getUser().then(({ data }) => {
      if (!active) return;
      if (!data.user) {
        const next = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      } else setAuthReady(true);
    }).catch(() => { if (active) window.location.assign("/login"); });
    return () => { active = false; };
  }, [view, captureOpen]);

  useEffect(() => {
    if (view !== "home" || !pendingSection) return;
    const sectionId = pendingSection;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setPendingSection(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [view, pendingSection]);

  function navigateToSection(event: React.MouseEvent<HTMLAnchorElement>, sectionId: string) {
    if (view !== "home") {
      event.preventDefault();
      setView("home");
      setSelectedIdea(null);
      setMenuOpen(false);
      setPendingSection(sectionId);
    }
  }

  useEffect(() => {
    if (view !== "inbox" || !selectedIdea || captureOpen || proactiveOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedIdea(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [view, selectedIdea, captureOpen, proactiveOpen]);

  useEffect(() => {
    if (!openIdeaMenuId) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest(".idea-inbox-row-menu-wrap")) setOpenIdeaMenuId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenIdeaMenuId(null);
    };
    window.addEventListener("pointerdown", closeOnPointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [openIdeaMenuId]);

  function persistIdeas(nextIdeas: IdeaRecord[]) {
    if (ideasIncomplete) {
      setStorageError("Some saved notes could not be read safely. Editing is paused so the original data is not overwritten.");
      return false;
    }
    try {
      window.localStorage.setItem(IDEA_KEY, JSON.stringify(nextIdeas));
      setIdeas(nextIdeas);
      setStorageError("");
      return true;
    } catch {
      setStorageError("This idea couldn’t be saved. Please check your browser storage and try again.");
      return false;
    }
  }

  function persistWorkMemory(nextItems: WorkMemoryItem[]) {
    if (workMemoryIncomplete) {
      setWorkMemoryFeedback({ memoId: selectedIdea?.id ?? "", message: "Some saved Work Memory could not be read safely. Editing is paused so the original data is not overwritten.", error: true });
      return false;
    }
    try {
      window.localStorage.setItem(WORK_MEMORY_KEY, JSON.stringify(nextItems));
      setWorkMemory(nextItems);
      return true;
    } catch {
      setWorkMemoryFeedback({ memoId: selectedIdea?.id ?? "", message: "Work Memory could not be saved in this browser. Check your browser storage and try again.", error: true });
      return false;
    }
  }

  async function extractMemoWorkMemory(item: IdeaRecord) {
    if (extractingMemoryMemoId || !workflowOwnerId || workMemoryIncomplete) return;
    setExtractingMemoryMemoId(item.id);
    setWorkMemoryFeedback(null);
    try {
      const response = await fetch("/api/work-memory/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoText: item.text, expectedUserId: workflowOwnerId }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message = payload && typeof payload === "object"
          ? (payload as { error?: { message?: string } }).error?.message
          : undefined;
        throw new Error(message || "Work Memory could not be extracted. Try again.");
      }
      const extracted = validateExtractedWorkMemory(payload, item.text);
      if (!extracted) throw new Error("AI returned an incomplete Work Memory review. Try again.");

      const existingKeys = new Set(workMemory.filter(memory => memory.memoId === item.id).map(workMemoryDuplicateKey));
      const newItems: WorkMemoryItem[] = extracted.flatMap(memory => {
        const key = workMemoryDuplicateKey(memory as WorkMemoryItem);
        if (existingKeys.has(key)) return [];
        existingKeys.add(key);
        return [{ ...memory, id: crypto.randomUUID(), memoId: item.id, sourceMemoUpdatedAt: item.updatedAt ?? item.createdAt, status: "suggested" as const, createdAt: new Date().toISOString() }];
      });
      if (newItems.length && !persistWorkMemory([...newItems, ...workMemory])) return;
      setWorkMemoryFeedback({ memoId: item.id, message: newItems.length
        ? `${newItems.length} suggestion${newItems.length === 1 ? "" : "s"} ready to review. Confirm each item to add it to your Work Memory.`
        : extracted.length
          ? "These details are already in this Memo’s Work Memory."
          : "No clear people, commitments, decisions, or facts found in this Memo." });
    } catch (error) {
      setWorkMemoryFeedback({ memoId: item.id, message: error instanceof Error ? error.message : "Work Memory could not be extracted. Try again.", error: true });
    } finally {
      setExtractingMemoryMemoId(null);
    }
  }

  function updateWorkMemoryStatus(id: string, status: WorkMemoryStatus) {
    if (workMemoryIncomplete) return;
    const next = workMemory.map(item => item.id === id ? { ...item, status } : item);
    if (persistWorkMemory(next)) setWorkMemoryFeedback(null);
  }

  function deleteIdea(item: IdeaRecord) {
    if (!persistIdeas(ideas.filter(record => record.id !== item.id))) return;
    if (!workMemoryIncomplete && workMemory.some(memory => memory.memoId === item.id)) {
      persistWorkMemory(workMemory.filter(memory => memory.memoId !== item.id));
    }
    if (selectedIdea?.id === item.id) setSelectedIdea(null);
  }

  function saveIdea(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!idea.trim() || !storageReady) return;
    const record: IdeaRecord = { id: crypto.randomUUID(), text: idea.trim(), createdAt: new Date().toISOString(), status: "Saved", type: ideaTypeDraft };
    if (!persistIdeas([record, ...ideas])) return;
    if (!editingIdeaId && view === "inbox") setSelectedNoteDate(toDateInputValue(new Date(record.createdAt)));
    setEditingIdeaId(null);
    setSaved(true);
  }

  function captureFromHome(event: React.FormEvent<HTMLFormElement>, type: NoteType = "Idea") {
    event.preventDefault();
    if (!homeIdea.trim() || !storageReady) return;
    const record: IdeaRecord = { id: crypto.randomUUID(), text: homeIdea.trim(), createdAt: new Date().toISOString(), status: "Saved", type };
    if (persistIdeas([record, ...ideas])) {
      if (view === "inbox") setSelectedNoteDate(toDateInputValue(new Date(record.createdAt)));
      if (view === "inbox") selectNoteForAIChat(record.id);
      setHomeIdea("");
      setHomeIdeaSaved(true);
    }
  }

  async function requestPartnerAnalysis(partnerRole: PartnerRole, userMessage: string) {
    const response = await fetch("/api/ai/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partnerRole, userMessage, locale: defaultLocale }),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const message = payload && typeof payload === "object"
        ? (payload as { error?: { message?: string } }).error?.message
        : undefined;
      throw new Error(message || `${aiPartnerName(partnerRole)} could not complete this review. Please try again.`);
    }

    const output = validateAIASKOutput(payload);
    if (!output || output.partnerRole !== partnerRole || !output.result) {
      throw new Error(`${aiPartnerName(partnerRole)} returned an incomplete response. Please try again.`);
    }
    return { result: output.result, saved: output.saved !== false };
  }

  async function analyzeIdea(item: IdeaRecord, partnerRole: PartnerRole = PARTNER_ROLE_ID.guide) {
    if (analyzingIdeaId || refiningNextStep) return;
    setAnalyzingIdeaId(item.id);
    setIdeaAnalysisError(null);
    setIdeaAnalysis(current => current?.ideaId === item.id ? null : current);
    try {
      const output = await requestPartnerAnalysis(partnerRole, item.text);
      setIdeaAnalysis({ ideaId: item.id, partnerRole, ...output });
    } catch (error) {
      setIdeaAnalysisError({
        ideaId: item.id,
        partnerRole,
        message: error instanceof Error ? error.message : `${aiPartnerName(partnerRole)} could not complete this review. Please try again.`,
      });
    } finally {
      setAnalyzingIdeaId(null);
    }
  }

  async function refineNextStep() {
    if (!checkInIdea || analyzingIdeaId || refiningNextStep) return;
    const partnerRole = reviewPartnerRole;
    const requestText = [
      "Suggest one clear, realistic next step based on the user's idea and current draft. Do not create or schedule anything.",
      `Original Idea:\n${checkInIdea.text.slice(0, 2200)}`,
      `Current Next Step:\n${nextStepDraft.trim().slice(0, 1000) || "No next step has been written yet."}`,
    ].join("\n\n").slice(0, 3900);
    setRefiningNextStep(true);
    setNextStepError("");
    setNextStepSuggestion(null);
    try {
      const output = await requestPartnerAnalysis(partnerRole, requestText);
      setNextStepSuggestion({ ideaId: checkInIdea.id, partnerRole, text: output.result.nextStep, saved: output.saved });
    } catch (error) {
      setNextStepError(error instanceof Error ? error.message : `${aiPartnerName(partnerRole)} could not refine this step. Please try again.`);
    } finally {
      setRefiningNextStep(false);
    }
  }

  function openCheckIn(ideaId?: string) {
    if (!storageReady) return;
    const candidate = ideas.find(item => item.id === ideaId) ?? ideas.find(item => item.status === "In progress") ?? ideas.find(item => item.status !== "Done") ?? ideas[0];
    setCheckInIdeaId(candidate?.id ?? null);
    setCheckInStatus(candidate?.status ?? "Saved");
    setNextStepDraft(candidate?.nextStep ?? "");
    setNextStepSuggestion(null);
    setNextStepError("");
    setCheckInSaved(false);
    setCheckInSaveError("");
    setProactiveOpen(true);
  }

  function selectCheckIn(itemId: string) {
    const item = ideas.find(record => record.id === itemId);
    if (!item) return;
    setCheckInIdeaId(item.id);
    setCheckInStatus(item.status ?? "Saved");
    setNextStepDraft(item.nextStep ?? "");
    setNextStepSuggestion(null);
    setNextStepError("");
    setCheckInSaved(false);
    setCheckInSaveError("");
  }

  async function saveCheckIn() {
    if (!checkInIdea || checkInSaving) return;
    setCheckInSaving(true);
    setCheckInSaveError("");
    setCheckInSaved(false);
    try {
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
      const now = new Date().toISOString();
      const nextStep = nextStepDraft.trim();
      const next = ideas.map(item => item.id === checkInIdea.id
        ? { ...item, status: checkInStatus, nextStep, progressUpdatedAt: now, updatedAt: now }
        : item);
      if (!persistIdeas(next)) {
        setCheckInSaveError("Progress could not be saved. Your edits are still here; please try again after checking browser storage.");
        return;
      }
      setSelectedIdea(next.find(item => item.id === checkInIdea.id) ?? null);

      const matchingTodo = plannerData.todos.some(todo => todo.ideaId === checkInIdea.id && todo.title.trim() === nextStep);
      if (nextStep && !matchingTodo) {
        const todo: PlannerTodo = {
          id: crypto.randomUUID(),
          ideaId: checkInIdea.id,
          eventId: null,
          title: nextStep,
          dueDate: "",
          status: "Open",
          priority: "onTrack",
          createdAt: now,
          updatedAt: now,
        };
        if (!persistPlanner({ ...plannerData, todos: [todo, ...plannerData.todos] })) {
          setCheckInSaveError("Progress was saved. The next step couldn’t be added to To-do. Please check your browser storage and try saving again.");
          return;
        }
      }

      setCheckInSaved(true);
    } catch {
      setCheckInSaveError("Progress could not be saved. Your edits are still here; please try again.");
    } finally {
      setCheckInSaving(false);
    }
  }

  function persistPlanner(nextPlanner: PlannerData) {
    const synchronizedPlanner = synchronizePlannerData(nextPlanner);
    try {
      window.localStorage.setItem("aiask-planner", JSON.stringify(synchronizedPlanner));
      setPlannerData(synchronizedPlanner);
      setStorageError("");
      setPlannerNotice("");
      return true;
    } catch {
      setStorageError("This calendar or to-do change couldn’t be saved. Please check your browser storage and try again.");
      return false;
    }
  }

  function confirmNotesChatAction(action: NotesChatAction, scope: "selected-note" | "current-view" | "workspace-notes") {
    if (action.action === "create_todo") {
      const title = action.title.trim();
      if (!title) return { ok: false, message: "The suggested task has no title." };
      const linkedIdea = scope === "workspace-notes" ? null : ideas.find(item => item.id === action.noteId) ?? null;
      const dueDate = action.dueDate ?? "";
      const duplicate = plannerData.todos.some(todo => todo.status === "Open"
        && todo.title.trim().replace(/\s+/g, " ").toLocaleLowerCase() === title.replace(/\s+/g, " ").toLocaleLowerCase()
        && todo.dueDate === dueDate);
      if (duplicate) return { ok: false, message: "A matching open To-do already exists. Review it before adding another." };
      const now = new Date().toISOString();
      const todoId = crypto.randomUUID();
      const eventId = dueDate ? crypto.randomUUID() : null;
      const ownerId = workflowAccount.status === "ready" ? workflowAccount.userId ?? undefined : undefined;
      const todo: PlannerTodo = { ownerId, id: todoId, eventId, ideaId: linkedIdea?.id ?? null, title, dueDate, status: "Open", priority: "onTrack", createdAt: now, updatedAt: now };
      const event: PlannerEvent | null = eventId ? { ownerId, id: eventId, todoId, ideaId: linkedIdea?.id ?? null, title, scheduledDate: dueDate, scheduledTime: null, description: title, priority: "onTrack", createdAt: now, origin: "task-deadline" } : null;
      if (!persistPlanner({ todos: [todo, ...plannerData.todos], events: event ? [...plannerData.events, event] : plannerData.events })) {
        return { ok: false, message: "The To-do could not be saved. Check browser storage and try again." };
      }
      window.dispatchEvent(new CustomEvent(TASK_CREATED_EVENT, { detail: { record: todo, createdAt: now } }));
      if (dueDate) {
        const due = dateFromInput(dueDate);
        setSelectedCalendarDate(dueDate);
        setCalendarCursor(new Date(due.getFullYear(), due.getMonth(), 1));
      }
      return { ok: true, message: `“${title}” was added to To-do${dueDate ? ` and Calendar for ${formatScheduleDate(dueDate)}` : ""}.` };
    }

    if (action.action === "set_follow_up") {
      if (scope === "workspace-notes") return { ok: false, message: "Workspace Notes cannot be edited from this panel; the follow-up remains a suggestion." };
      if (ideasIncomplete) return { ok: false, message: "Notes are read-only because some saved records could not be verified." };
      const target = ideas.find(item => item.id === action.noteId);
      if (!target || !action.content?.trim()) return { ok: false, message: "That note is no longer available in this context. Reload the Notes view." };
      if (target.nextStep?.trim() === action.content.trim()) return { ok: true, message: "This follow-up is already saved to the note." };
      const now = new Date().toISOString();
      const next = ideas.map(item => item.id === target.id ? { ...item, nextStep: action.content!.trim(), updatedAt: now } : item);
      return persistIdeas(next)
        ? { ok: true, message: "The follow-up was saved to the note." }
        : { ok: false, message: "The follow-up could not be saved. Check browser storage and try again." };
    }

    if (action.action === "save_summary") {
      if (!action.content?.trim()) return { ok: false, message: "The suggested summary is empty." };
      if (ideasIncomplete) return { ok: false, message: "Notes are read-only because some saved records could not be verified." };
      if (ideas.some(item => item.type === "Quick Note" && item.text.trim() === action.content!.trim())) return { ok: true, message: "An identical summary is already saved as a Quick Note." };
      const now = new Date();
      const record: IdeaRecord = { id: crypto.randomUUID(), text: action.content.trim(), createdAt: now.toISOString(), status: "Saved", type: "Quick Note" };
      if (!persistIdeas([record, ...ideas])) return { ok: false, message: "The summary could not be saved. Check browser storage and try again." };
      if (view === "inbox") setSelectedNoteDate(toDateInputValue(now));
      return { ok: true, message: "The summary was saved as a new Quick Note. The source notes were left unchanged." };
    }

    return { ok: false, message: "Use the suggested question in the message box, then send it when ready." };
  }

  function confirmAIPlannerChange(change: PlannerChange, conversationId: string): string | null {
    const applied = applyPlannerChange(plannerData, change, {
      now: new Date().toISOString(),
      ownerId: workflowOwnerId ?? undefined,
      conversationId,
      createId: () => crypto.randomUUID(),
    });
    if (!applied.ok) return applied.error;
    if (!applied.changed) return "There is no change to save.";
    if (!persistPlanner(applied.planner)) return "The change could not be saved. Check browser storage and try again.";
    if (applied.createdTodo) {
      window.dispatchEvent(new CustomEvent(TASK_CREATED_EVENT, {
        detail: { record: applied.createdTodo, createdAt: applied.createdTodo.createdAt ?? new Date().toISOString() },
      }));
    }
    if (applied.selectedDate) {
      const selectedDate = dateFromInput(applied.selectedDate);
      setSelectedCalendarDate(applied.selectedDate);
      setCalendarCursor(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
    }
    return null;
  }

  function addCalendarEvent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!eventTitle.trim() || !eventDate) return;
    const now = new Date().toISOString();
    const eventId = crypto.randomUUID();
    const todoId = crypto.randomUUID();
    const ownerId = workflowAccount.status === "ready" ? workflowAccount.userId ?? undefined : undefined;
    const calendarEvent: PlannerEvent = { ownerId, id: eventId, todoId, ideaId: eventIdeaId || null, title: eventTitle.trim(), scheduledDate: eventDate, scheduledTime: eventTime || null, description: eventTitle.trim(), priority: eventPriority, createdAt: now, origin: "calendar" };
    const linkedTodo: PlannerTodo = { ownerId, id: todoId, eventId, ideaId: eventIdeaId || null, title: eventTitle.trim(), dueDate: eventDate, status: "Open", priority: eventPriority, createdAt: now };
    if (persistPlanner({ events: [...plannerData.events, calendarEvent], todos: [...plannerData.todos, linkedTodo] })) {
      setSelectedCalendarDate(eventDate);
      setCalendarCursor(new Date(dateFromInput(eventDate).getFullYear(), dateFromInput(eventDate).getMonth(), 1));
      setEventTitle(""); setEventTime(""); setEventIdeaId(""); setNewEventPriority("onTrack");
      setPlannerNotice(`“${calendarEvent.title}” was added to Calendar and To-do for ${formatScheduleDate(eventDate)}.`);
    }
  }

  function addTodo(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!todoTitle.trim()) return;
    const reminderDate = todoReminderAt ? new Date(todoReminderAt) : null;
    if (reminderDate && (!Number.isFinite(reminderDate.getTime()) || reminderDate.getTime() <= Date.now())) {
      setReminderError("Choose a reminder time in the future.");
      return;
    }
    setReminderError("");
    const now = new Date().toISOString();
    const todoId = crypto.randomUUID();
    const eventId = todoDueDate ? crypto.randomUUID() : null;
    const ownerId = workflowAccount.status === "ready" ? workflowAccount.userId ?? undefined : undefined;
    const hasDraftOrigin = workflowAccount.status === "ready" && workflowAccount.userId === draftOrigin?.ownerId;
    const todo: PlannerTodo = { ownerId, originConversationId: hasDraftOrigin ? draftOrigin?.conversationId : undefined, id: todoId, eventId, ideaId: todoIdeaId || null, title: todoTitle.trim(), dueDate: todoDueDate, status: "Open", priority: todoPriority, createdAt: now, updatedAt: now, remindAt: reminderDate?.toISOString() };
    const calendarEvent: PlannerEvent | null = eventId ? { ownerId, id: eventId, todoId, ideaId: todoIdeaId || null, title: todo.title, scheduledDate: todoDueDate, scheduledTime: null, description: todo.title, priority: todoPriority, createdAt: now, origin: "task-deadline" } : null;
    const nextPlanner: PlannerData = {
      todos: [todo, ...plannerData.todos],
      events: calendarEvent ? [...plannerData.events, calendarEvent] : plannerData.events,
    };
    if (persistPlanner(nextPlanner)) {
      window.dispatchEvent(new CustomEvent(TASK_CREATED_EVENT, { detail: { record: todo, createdAt: now } }));
      if (todoDueDate) {
        const dueDate = dateFromInput(todoDueDate);
        setSelectedCalendarDate(todoDueDate);
        setCalendarCursor(new Date(dueDate.getFullYear(), dueDate.getMonth(), 1));
      }
      setTodoTitle(""); setDraftOrigin(null); setTodoDueDate(""); setTodoReminderAt(""); setTodoIdeaId(""); setNewTodoPriority("onTrack");
      setPlannerNotice(calendarEvent
        ? `“${todo.title}” was added to To-do and Calendar for ${formatScheduleDate(todoDueDate)}${reminderDate ? `, with a reminder for ${formatDate(reminderDate.toISOString())}` : ""}.`
        : `“${todo.title}” was added to To-do${reminderDate ? `, with a reminder for ${formatDate(reminderDate.toISOString())}` : ". Add a due date to also place it on Calendar."}`);
    }
  }

  async function enableBrowserNotifications() {
    if (!("Notification" in window)) { setNotificationPermission("unsupported"); return; }
    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
    } catch {
      setNotificationPermission("unsupported");
    }
  }

  function dismissReminder() {
    setActiveReminderId(null);
    setRescheduleOpen(false);
    setRescheduleReminderAt("");
    setReminderError("");
  }

  function startReminder() {
    if (!activeReminder) return;
    const nextPlanner: PlannerData = { ...plannerData, todos: plannerData.todos.map(todo => todo.id === activeReminder.id ? { ...todo, reminderPending: false } : todo) };
    persistPlanner(nextPlanner);
    dismissReminder();
    setView("todos");
  }

  function snoozeReminder(minutes: number) {
    if (!activeReminder) return;
    const remindAt = new Date(Date.now() + minutes * 60_000).toISOString();
    const nextPlanner: PlannerData = { ...plannerData, todos: plannerData.todos.map(todo => todo.id === activeReminder.id ? { ...todo, remindAt, remindedAt: undefined, reminderPending: false } : todo) };
    if (persistPlanner(nextPlanner)) {
      setPlannerNotice(`“${activeReminder.title}” will come back in ${minutes} minutes.`);
      dismissReminder();
    }
  }

  function saveRescheduledReminder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeReminder || !rescheduleReminderAt) return;
    const nextTime = new Date(rescheduleReminderAt);
    if (!Number.isFinite(nextTime.getTime()) || nextTime.getTime() <= Date.now()) {
      setReminderError("Choose a reminder time in the future.");
      return;
    }
    const nextPlanner: PlannerData = { ...plannerData, todos: plannerData.todos.map(todo => todo.id === activeReminder.id ? { ...todo, remindAt: nextTime.toISOString(), remindedAt: undefined, reminderPending: false } : todo) };
    if (persistPlanner(nextPlanner)) {
      setPlannerNotice(`Reminder for “${activeReminder.title}” moved to ${formatDate(nextTime.toISOString())}.`);
      setReminderError("");
      dismissReminder();
    }
  }

  function deleteCalendarEvent(eventId: string) {
    const event = plannerData.events.find(item => item.id === eventId);
    if (!event) return;
    persistPlanner({
      events: plannerData.events.filter(item => item.id !== eventId),
      todos: plannerData.todos.filter(todo => todo.id !== event.todoId && todo.eventId !== eventId),
    });
  }

  function deleteTodo(todoId: string) {
    const todo = plannerData.todos.find(item => item.id === todoId);
    persistPlanner({
      todos: plannerData.todos.filter(item => item.id !== todoId),
      events: plannerData.events.filter(event => event.id !== todo?.eventId && event.todoId !== todoId),
    });
    if (activeReminderId === todoId) dismissReminder();
  }

  function changeCalendarMonth(offset: number) {
    const nextMonth = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + offset, 1);
    setCalendarCursor(nextMonth);
    setSelectedCalendarDate(toDateInputValue(nextMonth));
  }


  function togglePlannerTodo(todoId: string) {
    const currentTodo = plannerData.todos.find(todo => todo.id === todoId);
    const now = new Date().toISOString();
    const nextPlanner: PlannerData = { ...plannerData, todos: plannerData.todos.map(todo => todo.id === todoId ? { ...todo, status: todo.status === "Done" ? "Open" : "Done", completedAt: todo.status === "Done" ? undefined : now, updatedAt: now, reminderPending: todo.status === "Done" ? todo.reminderPending : false } : todo) };
    persistPlanner(nextPlanner);
    if (currentTodo?.status === "Open" && activeReminderId === todoId) dismissReminder();
  }

  function setTodoPriority(todoId: string, priority: TaskPriority) {
    const todo = plannerData.todos.find(item => item.id === todoId);
    const now = new Date().toISOString();
    const nextPlanner: PlannerData = {
      todos: plannerData.todos.map(item => item.id === todoId && item.priority !== priority ? { ...item, priority, updatedAt: now } : item),
      events: plannerData.events.map(event => event.todoId === todoId || event.id === todo?.eventId ? { ...event, priority } : event),
    };
    persistPlanner(nextPlanner);
  }

  function setEventPriority(eventId: string, priority: TaskPriority) {
    const calendarEvent = plannerData.events.find(item => item.id === eventId);
    if (!calendarEvent) return;
    const linkedTodo = plannerData.todos.find(todo => todo.id === calendarEvent.todoId || todo.eventId === eventId) ?? null;
    const now = new Date().toISOString();
    const nextPlanner: PlannerData = {
      events: plannerData.events.map(event => event.id === eventId ? { ...event, priority } : event),
      todos: linkedTodo ? plannerData.todos.map(todo => todo.id === linkedTodo.id && todo.priority !== priority ? { ...todo, priority, updatedAt: now } : todo) : plannerData.todos,
    };
    persistPlanner(nextPlanner);
  }

  function closeCapture() { setCaptureOpen(false); setSaved(false); setIdea(""); setIdeaTypeDraft("Quick Note"); setEditingIdeaId(null); }

  function saveEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingIdeaId || !idea.trim()) return;
    const next = ideas.map(item => item.id === editingIdeaId ? { ...item, text: idea.trim(), type: ideaTypeDraft, updatedAt: new Date().toISOString() } : item);
    if (persistIdeas(next)) { setSelectedIdea(next.find(item => item.id === editingIdeaId) ?? null); closeCapture(); }
  }

  function openEditor(item: IdeaRecord) { setIdea(item.text); setIdeaTypeDraft(noteType(item)); setEditingIdeaId(item.id); setSaved(false); setCaptureOpen(true); }
  function changeIdeaType(item: IdeaRecord, type: NoteType) {
    if (noteType(item) === type) return;
    const next = ideas.map(record => record.id === item.id ? { ...record, type } : record);
    if (persistIdeas(next)) setSelectedIdea(next.find(record => record.id === item.id) ?? null);
  }
  function prepareTodoFromNote(item: IdeaRecord) {
    setTodoTitle(workflowTitleFromNote(item));
    setTodoIdeaId(item.id);
    setSelectedIdea(null);
    setPlannerNotice("Review this draft and add it to To-do when ready. No task has been created yet.");
    setView("todos");
  }

  function addNoteToTodo(item: IdeaRecord) {
    setOpenIdeaMenuId(null);
    const title = workflowTitleFromNote(item);
    if (!title) {
      setNoteWorkflowNotice({ message: "This note needs a title before it can become a To-do.", error: true });
      return;
    }
    const normalizedTitle = title.replace(/\s+/g, " ").toLocaleLowerCase();
    const existing = plannerData.todos.find(todo => todo.status === "Open" && todo.ideaId === item.id
      && todo.title.trim().replace(/\s+/g, " ").toLocaleLowerCase() === normalizedTitle);
    if (existing) {
      setNoteWorkflowNotice({ message: `“${existing.title}” is already linked to this Memo.` });
      return;
    }

    const now = new Date().toISOString();
    const todo: PlannerTodo = {
      ownerId: workflowOwnerId ?? undefined,
      id: crypto.randomUUID(),
      ideaId: item.id,
      eventId: null,
      title,
      dueDate: "",
      status: "Open",
      priority: "onTrack",
      createdAt: now,
      updatedAt: now,
    };
    if (!persistPlanner({ ...plannerData, todos: [todo, ...plannerData.todos] })) {
      setNoteWorkflowNotice({ message: "This To-do could not be saved. Check browser storage and try again.", error: true });
      return;
    }
    window.dispatchEvent(new CustomEvent(TASK_CREATED_EVENT, { detail: { record: todo, createdAt: now } }));
    setNoteWorkflowNotice({ message: `“${title}” was added to To-do and linked to this Memo.`, undoTodoId: todo.id });
  }

  function undoNoteToDo() {
    const todoId = noteWorkflowNotice?.undoTodoId;
    if (!todoId) return;
    const linkedTodo = plannerData.todos.find(todo => todo.id === todoId);
    if (!linkedTodo) { setNoteWorkflowNotice(null); return; }
    const nextPlanner = {
      todos: plannerData.todos.filter(todo => todo.id !== todoId),
      events: plannerData.events.filter(event => event.todoId !== todoId && event.id !== linkedTodo.eventId),
    };
    if (persistPlanner(nextPlanner)) setNoteWorkflowNotice({ message: "The To-do was removed." });
    else setNoteWorkflowNotice({ message: "The To-do could not be undone. Check browser storage and try again.", error: true });
  }

  function scheduleNoteInCalendar(item: IdeaRecord) {
    const title = workflowTitleFromNote(item);
    if (!title) {
      setOpenIdeaMenuId(null);
      setNoteWorkflowNotice({ message: "This note needs a title before it can be scheduled.", error: true });
      return;
    }
    const date = eventDate || toDateInputValue(new Date());
    setEventTitle(title);
    setEventIdeaId(item.id);
    setEventDate(date);
    setEventTime("");
    setNewEventPriority("onTrack");
    setSelectedCalendarDate(date);
    const calendarDate = dateFromInput(date);
    setCalendarCursor(new Date(calendarDate.getFullYear(), calendarDate.getMonth(), 1));
    setPlannerNotice(`Review the date and time for “${title}”, then add it to Calendar and To-do.`);
    setOpenIdeaMenuId(null);
    setView("calendar");
  }
  function formatDate(date: string) { return new Intl.DateTimeFormat(defaultLocale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(date)); }
  function formatScheduleDate(date: string) { return new Intl.DateTimeFormat(defaultLocale, { dateStyle: "long" }).format(new Date(`${date}T00:00:00`)); }

  return <main>
    <header className="nav wrap shared-site-nav">
      <a className="brand" href="#top" aria-label="AIASK home" onClick={event => { if (view !== "home") { event.preventDefault(); setView("home"); } }}><span className="brand-mark"><Sparkles size={17} /></span>aiask<span className="brand-dot">.</span></a>
      <button className="mobile-menu" aria-label="Toggle menu" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X /> : <Menu />}</button>
      <nav className={menuOpen ? "nav-links open" : "nav-links"}>
        <a href="/partners" onClick={() => setMenuOpen(false)}>AI Team</a><a href="/workspace" onClick={() => setMenuOpen(false)}>My Workspace</a>
        <button className={view === "calendar" ? "nav-cta active" : "nav-cta"} onClick={() => { setView("calendar"); setMenuOpen(false); }}><CalendarDays size={15}/> Calendar</button>
        <button className={view === "todos" ? "nav-cta active" : "nav-cta"} onClick={() => { setView("todos"); setMenuOpen(false); }}><Check size={15}/> To-do{openTodos.length > 0 && <span className="nav-count">{openTodos.length}</span>}</button>
        <button className={view === "inbox" ? "nav-cta active" : "nav-cta"} onClick={() => { setView(view === "inbox" ? "home" : "inbox"); setSelectedIdea(null); setMenuOpen(false); }}><Inbox size={15}/> Notes &amp; Ideas{ideas.length > 0 && <span className="nav-count">{ideas.length}</span>}</button>
        <button className="nav-cta share-cta" onClick={() => { setIdeaTypeDraft("Quick Note"); setCaptureOpen(true); }}>Quick capture <Plus size={15} /></button>
        <AccountControl />
      </nav>
    </header>

    {activeReminder && <aside className="reminder-nudge wrap" role="alert" aria-live="assertive">
      <span className="reminder-nudge-icon"><Bell size={17}/></span>
      <div className="reminder-nudge-copy"><span className="section-kicker">AIASK REMINDER</span><h2>Time for your next step.</h2><p>{activeReminder.title}</p><small>Based on the reminder time you chose.</small></div>
      <div className="reminder-nudge-actions"><button type="button" className="reminder-start" onClick={startReminder}>Start now</button><button type="button" onClick={() => { togglePlannerTodo(activeReminder.id); dismissReminder(); }}>Done</button><button type="button" onClick={() => snoozeReminder(15)}>Snooze 15 min</button><button type="button" onClick={() => { if (!rescheduleOpen) setRescheduleReminderAt(toDateTimeLocalValue(new Date(Date.now() + 60 * 60_000))); setRescheduleOpen(value => !value); }}>Change time</button></div>
      {rescheduleOpen && <form className="reminder-reschedule" onSubmit={saveRescheduledReminder}><label htmlFor="reminder-reschedule-time">Choose a new time</label><input id="reminder-reschedule-time" type="datetime-local" min={toDateTimeLocalValue(new Date(Date.now() + 60_000))} value={rescheduleReminderAt} onChange={event => { setRescheduleReminderAt(event.target.value); setReminderError(""); }} required/>{reminderError && <p className="reminder-error" role="alert">{reminderError}</p>}<button type="submit">Save time</button></form>}
    </aside>}

    {!hydrated || (isSupabaseConfigured() && !authReady) ? <div className="wrap auth-gate-loading" role="status">Checking your sign-in…</div> : <>
    {isSupabaseConfigured() && (view !== "home" || captureOpen) && <div className="wrap local-data-notice" role="status"><b>Local demo data</b><span>Your Notes &amp; Ideas, To-do, and Calendar records still live in this browser. They are not yet synced to your account.</span></div>}
    {(view === "calendar" || view === "todos") && <TaskCreationBridge />}

    {view === "inbox" ? (
      <section className="idea-box wrap">
        <button className="inbox-back" type="button" onClick={() => { setView("home"); setSelectedIdea(null); setOpenIdeaMenuId(null); }}><ArrowLeft size={15}/> Back to AIASK</button>

        <div className="notes-page-heading"><div><span className="section-kicker">CAPTURE EVERYTHING. DISCOVER WHAT MATTERS.</span><h1>Notes &amp; Ideas</h1><p>Save it first. Decide what it means when you are ready.</p></div><span className="idea-inbox-count">{ideas.length} {ideas.length === 1 ? "record" : "records"}</span></div>
        {noteWorkflowNotice && <div className={`planner-sync-notice note-workflow-notice${noteWorkflowNotice.error ? " error" : ""}`} role={noteWorkflowNotice.error ? "alert" : "status"} aria-live="polite">{noteWorkflowNotice.error ? <X size={15}/> : <Check size={15}/>}<span>{noteWorkflowNotice.message}</span>{noteWorkflowNotice.undoTodoId && <button type="button" className="note-workflow-undo" onClick={undoNoteToDo}>Undo</button>}<button type="button" onClick={() => setNoteWorkflowNotice(null)} aria-label="Dismiss notification"><X size={14}/></button></div>}

        <form className="idea-quick-capture" onSubmit={event => captureFromHome(event, "Quick Note")}>
          <div className="idea-quick-capture-heading">
            <span className="quick-capture-icon"><Plus size={15}/></span>
            <div><b>Quick Capture</b><small>Start with a note. Organize it later.</small></div>
          </div>
          <label className="sr-only" htmlFor="idea-inbox-capture">Capture a note, thought, or idea</label>
          <textarea id="idea-inbox-capture" value={homeIdea} onChange={event => { setHomeIdea(event.target.value); setHomeIdeaSaved(false); }} placeholder="What's on your mind? Capture a note, thought, or idea…" rows={2}/>
          <div className="idea-quick-capture-footer">
            <span>Saved as a Quick Note. You can change its type later.</span>
            <button className="button button-dark" type="submit" disabled={!homeIdea.trim() || !storageReady || ideasIncomplete}>Save note <ArrowUpRight size={15}/></button>
          </div>
        </form>
        {homeIdeaSaved && <div className="idea-capture-confirm" role="status"><Check size={15}/> Note saved.</div>}

        <div className="notes-ai-workbench">
        <section className="idea-inbox-panel" aria-labelledby="idea-inbox-title">
          <header className="idea-inbox-panel-heading">
            <div><span className="section-kicker">YOUR PERSONAL NOTEBOOK</span><h2 id="idea-inbox-title">Browse your records</h2></div>
          </header>
          <div className="notes-view-switch" role="tablist" aria-label="Notes view">
            <button type="button" role="tab" aria-selected={notesView === "daily"} className={notesView === "daily" ? "selected" : ""} onClick={() => setNotesView("daily")}>Daily Notes</button>
            <button type="button" role="tab" aria-selected={notesView === "all"} className={notesView === "all" ? "selected" : ""} onClick={() => setNotesView("all")}>All Notes</button>
          </div>
          {notesView === "daily" && <div className="notes-date-navigation"><button type="button" aria-label="Previous day" onClick={() => setSelectedNoteDate(date => addDays(date, -1))}><ArrowLeft size={14}/></button><label><span className="sr-only">Browse notes by date</span><input type="date" value={selectedNoteDate} onChange={event => event.target.value && setSelectedNoteDate(event.target.value)}/></label><button type="button" aria-label="Next day" onClick={() => setSelectedNoteDate(date => addDays(date, 1))}><ArrowRight size={14}/></button><button type="button" onClick={() => setSelectedNoteDate(toDateInputValue(new Date()))}>Today</button></div>}
          <div className="idea-inbox-filters notes-type-filters" role="group" aria-label="Filter by record type">
            {(["All", "Quick Note", "Idea", "Reflection", "Action Item"] as const).map(filter => <button key={filter} type="button" className={(noteTypeFilter === filter ? "selected" : "")} aria-pressed={noteTypeFilter === filter} onClick={() => setNoteTypeFilter(filter)}>{filter === "Quick Note" ? "Quick Notes" : filter === "Idea" ? "Ideas" : filter === "Reflection" ? "Reflections" : filter === "Action Item" ? "Action Items" : filter}<span>{filter === "All" ? ideas.length : ideas.filter(item => noteType(item) === filter).length}</span></button>)}
          </div>
          <div className="idea-inbox-filters notes-status-filters" role="group" aria-label="Filter by progress">
            {ideaInboxFilters.map(filter => <button key={filter} type="button" className={ideaInboxFilter === filter ? "selected" : ""} aria-pressed={ideaInboxFilter === filter} onClick={() => { setIdeaInboxFilter(filter); setOpenIdeaMenuId(null); }}>{filter === "All" ? "All progress" : filter}</button>)}
          </div>

          {!storageReady ? <div className="inbox-loading" role="status">Opening Notes &amp; Ideas...</div> : visibleInboxIdeas.length === 0 ? (
            <div className="idea-inbox-empty">
              <span className="empty-icon"><Lightbulb size={21}/></span>
              <h2>{ideas.length === 0 ? "Your Notes & Ideas space is ready." : notesView === "daily" ? "No notes for this day." : "No notes match these filters."}</h2>
              <p>{ideas.length === 0 ? "Capture a thought above. It will be saved as a Quick Note." : notesView === "daily" ? "Choose another date or switch to All Notes." : "Try another record type or progress filter."}</p>
            </div>
          ) : (
            <div className="notes-date-groups">
              {inboxNoteGroups.map(([dateKey, group]) => <section className="notes-date-group" key={dateKey} aria-label={new Intl.DateTimeFormat(defaultLocale, { dateStyle: "full" }).format(dateFromInput(dateKey))}>
                <header className="notes-date-heading"><h3>{new Intl.DateTimeFormat(defaultLocale, { dateStyle: "full" }).format(dateFromInput(dateKey))}</h3><span>{group.length} {group.length === 1 ? "note" : "notes"}</span></header>
                <div className="idea-inbox-list">{group.map(item => {
                const display = ideaTitleAndSummary(item.text);
                const status = item.status ?? "Saved";
                const updatedAt = item.updatedAt ?? item.createdAt;
                const statusClass = status === "In progress" ? "in-progress" : status === "Done" ? "done" : "saved";
                return <article className="idea-inbox-row" key={item.id}>
                  <button className={`idea-inbox-row-open${chatNoteId === item.id ? " chat-selected" : ""}`} type="button" aria-pressed={chatNoteId === item.id} onClick={() => { selectNoteForAIChat(item.id); setOpenIdeaMenuId(null); }} aria-label={"Select note for AI Team chat: " + display.title}>
                    <BookOpen size={22} strokeWidth={1.8}/>
                    <span className="idea-inbox-row-main">
                      <b>{display.title}</b>
                      <small>{display.summary}</small>
                    <span className="idea-inbox-row-meta"><span className="note-type-pill">{noteType(item)}</span><span className={"idea-inbox-status-pill " + statusClass}>{status}</span><time>Created {formatDate(item.createdAt)}{updatedAt !== item.createdAt ? ` · Updated ${formatDate(updatedAt)}` : ""}</time><span className="note-ai-select-action">{chatNoteId === item.id ? "Selected for AI Team" : "Select for AI Team"}</span></span>
                    </span>
                  </button>
                  <div className="idea-inbox-row-menu-wrap">
                    <button className="idea-inbox-row-menu-trigger" type="button" aria-label={"Actions for " + display.title} aria-haspopup="menu" aria-expanded={openIdeaMenuId === item.id} onClick={() => setOpenIdeaMenuId(current => current === item.id ? null : item.id)}><MoreHorizontal size={20}/></button>
                    {openIdeaMenuId === item.id && <div className="idea-inbox-row-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => { setOpenIdeaMenuId(null); setSelectedIdea(item); }}>Open details</button>
                      <button type="button" role="menuitem" onClick={() => addNoteToTodo(item)}>Add to To-do</button>
                      <button type="button" role="menuitem" onClick={() => scheduleNoteInCalendar(item)}>Schedule in Calendar</button>
                      <button type="button" role="menuitem" onClick={() => { selectNoteForAIChat(item.id); setOpenIdeaMenuId(null); }}>Ask AI Team</button>
                      <button type="button" role="menuitem" onClick={() => { setOpenIdeaMenuId(null); setSelectedIdea(item); void analyzeIdea(item); }}>Organize with AI</button>
                      <button type="button" role="menuitem" onClick={() => { setOpenIdeaMenuId(null); openEditor(item); }}>Edit note</button>
                      <button type="button" role="menuitem" className="danger" disabled={ideasIncomplete} onClick={() => { setOpenIdeaMenuId(null); deleteIdea(item); }}>Delete note</button>
                    </div>}
                  </div>
                </article>;
                })}</div>
              </section>)}
            </div>
          )}
          {storageError && <p className="storage-error" role="alert">{storageError}</p>}
        </section>
        <NotesAIChat key={`${workflowOwnerId ?? "signed-out"}:${selectedChatNote?.id ?? "no-note"}`} note={selectedChatNote} currentViewNotes={visibleInboxIdeas} currentViewKey={currentViewKey} currentViewReady={storageReady} selectionIntent={notesChatSelectionIntent} userId={workflowOwnerId} accountStatus={workflowAccount.status} panelOpen={notesChatOpen} onTogglePanel={() => setNotesChatOpen(open => !open)} onConfirmAction={confirmNotesChatAction} />
        </div>
      </section>
    ) : view === "calendar" ? <section className="planner-page wrap">
      <button className="planner-back" onClick={() => setView("home")}><ArrowLeft size={14}/> Back to AIASK</button><div className="planner-page-heading"><div><div className="section-kicker">YOUR TIME, IN ONE PLACE</div><h1>AIASK <em>Calendar.</em></h1><p>Plans and next steps connected to the ideas behind them.</p></div><div className="planner-total"><CalendarDays size={17}/><span>{plannerData.events.length} {plannerData.events.length === 1 ? "event" : "events"}</span></div></div>
      <PlannerAIChat key={workflowOwnerId ?? "local"} scope="calendar" context={calendarAIContext} userId={workflowOwnerId} onConfirm={(change, conversationId) => confirmAIPlannerChange(change, conversationId)} />
      {plannerNotice && <div className="planner-sync-notice" role="status" aria-live="polite"><Check size={15}/><span>{plannerNotice}</span><button type="button" onClick={() => setPlannerNotice("")} aria-label="Dismiss notification"><X size={14}/></button></div>}
      <div className="calendar-layout"><section className="calendar-panel"><div className="calendar-toolbar"><button aria-label="Previous month" onClick={() => changeCalendarMonth(-1)}><ArrowLeft size={15}/></button><h2>{new Intl.DateTimeFormat(defaultLocale, { month: "long", year: "numeric" }).format(calendarCursor)}</h2><button aria-label="Next month" onClick={() => changeCalendarMonth(1)}><ArrowRight size={15}/></button><button className="calendar-today" onClick={() => { const today = new Date(); setCalendarCursor(new Date(today.getFullYear(), today.getMonth(), 1)); setSelectedCalendarDate(toDateInputValue(today)); }}>Today</button></div><div className="calendar-priority-legend" aria-label="Priority color key"><span><i className="priority-urgent"/>Urgent</span><span><i className="priority-attention"/>Attention</span><span><i className="priority-onTrack"/>On Track</span></div><div className="calendar-weekdays">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(day => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{calendarDates.map(day => { const dayEvents = plannerData.events.filter(event => event.scheduledDate === day.date); const priorityCounts = countEventPriorities(dayEvents, plannerData.todos); const prioritySummary = (["urgent", "attention", "onTrack"] as const).filter(priority => priorityCounts[priority] > 0); const accessibleSummary = prioritySummary.map(priority => `${priorityCounts[priority]} ${priority === "urgent" ? "urgent" : priority === "attention" ? "attention" : "on track"}`).join(", "); return <button key={day.date} aria-label={`${formatScheduleDate(day.date)}${dayEvents.length ? `, ${accessibleSummary}` : ", no events"}`} className={`calendar-day${day.inMonth ? "" : " outside"}${selectedCalendarDate === day.date ? " selected" : ""}${day.date === toDateInputValue(new Date()) ? " today" : ""}`} onClick={() => setSelectedCalendarDate(day.date)}><span>{day.day}</span>{prioritySummary.length > 0 ? <span className="calendar-priority-summary" aria-hidden="true">{prioritySummary.map(priority => <span className={`calendar-priority-count priority-${priority}`} key={priority}><i />{priorityCounts[priority]}</span>)}</span> : <span className="calendar-no-events" aria-hidden="true">—</span>}</button>; })}</div></section>
        <aside className="calendar-agenda">
          <div className="agenda-heading"><div><div className="section-kicker">DAY AGENDA</div><h2>{formatScheduleDate(selectedCalendarDate)}</h2></div><span>{selectedDateEvents.length}</span></div>
          {selectedDateEvents.length === 0 ? <div className="agenda-empty">Nothing planned for this day yet.</div> : selectedDateEvents.map(event => {
            const linkedTodo = plannerData.todos.find(todo => todo.id === event.todoId || todo.eventId === event.id);
            const priority = getTaskPriority(linkedTodo?.priority ?? event.priority);
            const lateDays = linkedTodo?.status === "Open" ? overdueDays(linkedTodo.dueDate, todayDate) : 0;
            return <article className={`agenda-event priority-event-${priority}`} key={event.id}>
              <div className="agenda-event-time">{event.scheduledTime ?? "ALL DAY"}</div>
              <h3>{event.title}</h3>
              <PriorityControl value={priority} onChange={value => setEventPriority(event.id, value)} label={`Priority for ${event.title}`} className="compact"/>
              {lateDays > 0 && <span className="todo-overdue-status">{lateDays} {lateDays === 1 ? "day" : "days"} overdue</span>}
              {event.description !== event.title && <p>{event.description}</p>}
              {event.ideaId && <small>Linked to: {ideas.find(item => item.id === event.ideaId)?.text.slice(0, 58) ?? "Saved idea"}</small>}
              <div className="agenda-event-actions">
                <button onClick={() => linkedTodo && togglePlannerTodo(linkedTodo.id)}><Check size={13}/> {linkedTodo?.status ?? "Open"} to-do</button>
                <button aria-label="Delete calendar event" onClick={() => deleteCalendarEvent(event.id)}><Trash2 size={13}/></button>
              </div>
            </article>;
          })}
          <form className="planner-form" onSubmit={addCalendarEvent}><div className="section-kicker">ADD TO CALENDAR</div><label htmlFor="event-title">What’s happening?</label><input id="event-title" required value={eventTitle} onChange={event => setEventTitle(event.target.value)} placeholder="e.g. Call the gallery"/><div className="planner-form-row"><label>Date<input type="date" required value={eventDate} onChange={event => setEventDate(event.target.value)}/></label><label>Time<input type="time" value={eventTime} onChange={event => setEventTime(event.target.value)}/></label></div><label htmlFor="event-idea">Related idea <span>Optional</span></label><select id="event-idea" value={eventIdeaId} onChange={event => setEventIdeaId(event.target.value)}><option value="">No linked idea</option>{ideas.map(item => <option key={item.id} value={item.id}>{item.text.replace(/\s+/g, " ").slice(0, 60)}</option>)}</select><PriorityControl value={eventPriority} onChange={setNewEventPriority} label="Priority for new calendar event" className="priority-form-control"/><button className="button button-dark" type="submit"><Plus size={14}/> Add event &amp; linked to-do</button></form>
        </aside></div>
    </section> : view === "todos" ? <section className="planner-page wrap">
      <button className="planner-back" onClick={() => setView("home")}><ArrowLeft size={14}/> Back to AIASK</button><div className="planner-page-heading"><div><div className="section-kicker">SMALL STEPS, KEPT VISIBLE</div><h1>Your <em>To-do list.</em></h1><p>Set a due date to add the task to Calendar automatically. Add a reminder and AIASK will bring the next step back at the time you choose.</p></div><div className="planner-total"><Check size={17}/><span>{openTodos.length} open</span></div></div>
      <PlannerAIChat key={workflowOwnerId ?? "local"} scope="todos" context={todosAIContext} userId={workflowOwnerId} onConfirm={(change, conversationId) => confirmAIPlannerChange(change, conversationId)} />
      {plannerNotice && <div className="planner-sync-notice" role="status" aria-live="polite"><Check size={15}/><span>{plannerNotice}</span><button type="button" onClick={() => setPlannerNotice("")} aria-label="Dismiss notification"><X size={14}/></button></div>}
      <div className="todo-layout"><form className="planner-form todo-create-form" onSubmit={addTodo}><div className="section-kicker">ADD A TO-DO</div>{openTodos.length === 0 && doneTodos.length === 0 && <p className="reminder-first-use">Start with one real task. AIASK can remind you when it is time to take the next step.</p>}<label htmlFor="todo-title">What needs doing?</label><input id="todo-title" required value={todoTitle} onChange={event => setTodoTitle(event.target.value)} placeholder="Write a clear next step"/><label htmlFor="todo-date">Due date <span>Optional</span></label><input id="todo-date" type="date" value={todoDueDate} onChange={event => setTodoDueDate(event.target.value)}/><small className="planner-sync-hint">{todoDueDate ? "This task will also appear on Calendar as an all-day item." : "Choose a date to link this task to Calendar."}</small><label htmlFor="todo-reminder">Remind me <span>Optional</span></label><input id="todo-reminder" type="datetime-local" min={toDateTimeLocalValue(new Date(Date.now() + 60_000))} value={todoReminderAt} onChange={event => { setTodoReminderAt(event.target.value); setReminderError(""); }}/><small className="planner-sync-hint">AIASK checks reminders while this page is open. You can enable browser notifications for a desktop alert.</small><div className="notification-permission-row">{notificationPermission === "default" && <button type="button" onClick={enableBrowserNotifications}><Bell size={13}/> Enable browser notifications</button>}{notificationPermission === "granted" && <span><Bell size={13}/> Browser notifications enabled</span>}{notificationPermission === "denied" && <span>Browser notifications are blocked. In-app reminders still work while AIASK is open.</span>}{notificationPermission === "unsupported" && <span>In-app reminders work while AIASK is open.</span>}</div>{reminderError && <p className="reminder-error" role="alert">{reminderError}</p>}<label htmlFor="todo-idea">Related idea <span>Optional</span></label><select id="todo-idea" value={todoIdeaId} onChange={event => setTodoIdeaId(event.target.value)}><option value="">No linked idea</option>{ideas.map(item => <option key={item.id} value={item.id}>{item.text.replace(/\s+/g, " ").slice(0, 60)}</option>)}</select><PriorityControl value={todoPriority} onChange={setNewTodoPriority} label="Priority for new to-do" className="priority-form-control"/><button className="button button-dark" type="submit"><Plus size={14}/> {todoDueDate ? "Add to-do & Calendar" : "Add to-do"}</button></form>
        <div className="todo-list-panel">
          <div className="todo-list-heading"><div><div className="section-kicker">UP NEXT</div><h2>{openTodos.length} open {openTodos.length === 1 ? "task" : "tasks"}</h2></div></div>
          {openTodos.length === 0 && doneTodos.length === 0 ? <div className="todo-empty"><span className="empty-icon"><Check size={21}/></span><h3>Your list is clear.</h3><p>Add a next step or create one from a calendar event.</p></div> : <>
            {openTodos.slice().sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999")).map(todo => {
              const lateDays = overdueDays(todo.dueDate, todayDate);
              return <article className="todo-item" key={todo.id}>
                <button className="todo-check-button" aria-label={`Mark ${todo.title} complete`} onClick={() => togglePlannerTodo(todo.id)}><span/></button>
                <div className="todo-item-copy">
                  <h3>{todo.title}</h3>
                  <div className="todo-item-meta">
                    {todo.dueDate && <span><CalendarDays size={12}/> Due {formatScheduleDate(todo.dueDate)}</span>}
                    {lateDays > 0 && <span className="todo-overdue-status">{lateDays} {lateDays === 1 ? "day" : "days"} overdue</span>}
                    {todo.remindAt && <span><Clock3 size={12}/> Reminder {formatDate(todo.remindAt)}</span>}
                    {todo.eventId && <span>Calendar linked</span>}
                    {todo.ideaId && <span>Idea: {ideas.find(item => item.id === todo.ideaId)?.text.replace(/\s+/g, " ").slice(0, 45) ?? "Saved idea"}</span>}
                  </div>
                </div>
                <PriorityControl value={todo.priority} onChange={value => setTodoPriority(todo.id, value)} label={`Priority for ${todo.title}`}/>
                <button className="todo-delete" aria-label="Delete to-do" onClick={() => deleteTodo(todo.id)}><Trash2 size={14}/></button>
              </article>;
            })}
            {doneTodos.length > 0 && <><div className="section-kicker todo-done-heading">COMPLETED · {doneTodos.length}</div>{doneTodos.map(todo => <article className="todo-item done" key={todo.id}><button className="todo-check-button checked" aria-label="Reopen to-do" onClick={() => togglePlannerTodo(todo.id)}><Check size={13}/></button><div className="todo-item-copy"><h3>{todo.title}</h3><div className="todo-item-meta"><span>Completed</span>{todo.dueDate && <span>Due {formatScheduleDate(todo.dueDate)}</span>}</div></div><PriorityControl value={todo.priority} onChange={value => setTodoPriority(todo.id, value)} label={`Priority for ${todo.title}`}/><button className="todo-delete" aria-label="Delete to-do" onClick={() => deleteTodo(todo.id)}><Trash2 size={14}/></button></article>)}</>}
          </>}
        </div>
      </div>
    </section> : <>

    <LandingPage
      onOpenView={next => { setView(next); setMenuOpen(false); }}
      capture={<>
        <form className="lp-capture-form" onSubmit={captureFromHome}>
          <label className="lp-capture-label" htmlFor="home-idea">What’s your idea?</label>
          <textarea id="home-idea" value={homeIdea} onChange={event => { setHomeIdea(event.target.value); setHomeIdeaSaved(false); }}
            placeholder="A problem you’d love to solve. Something you want to create. A possibility worth exploring…" rows={3} />
          <div><small>Keep it in Notes &amp; Ideas. Explore when you’re ready.</small><button type="submit" disabled={!homeIdea.trim() || !storageReady || ideasIncomplete}>Save my idea <ArrowUpRight size={14} aria-hidden="true" /></button></div>
        </form>
        {storageError && !captureOpen && <p className="storage-error" role="alert">{storageError}</p>}
        {homeIdeaSaved && <div className="lp-capture-confirm" role="status"><Check size={14} />Saved to Notes &amp; Ideas <button type="button" onClick={() => { setView("inbox"); setSelectedIdea(null); }}>Open Notes &amp; Ideas <ArrowRight size={13} /></button></div>}
      </>}
    />

    </>}

    {view !== "home" && <footer className="page-footer wrap"><a href="/about">About Us</a></footer>}

    {view === "inbox" && selectedIdea && (() => {
      const display = ideaTitleAndSummary(selectedIdea.text);
      const currentAnalysis = ideaAnalysis?.ideaId === selectedIdea.id && ideaAnalysis.partnerRole === PARTNER_ROLE_ID.guide ? ideaAnalysis : null;
      const currentAnalysisError = ideaAnalysisError && ideaAnalysisError.ideaId === selectedIdea.id && ideaAnalysisError.partnerRole === PARTNER_ROLE_ID.guide ? ideaAnalysisError.message : "";
      const isAnalyzing = analyzingIdeaId === selectedIdea.id;
      return <div className="idea-drawer-layer">
        <button className="idea-drawer-backdrop" type="button" aria-label="Close idea details" onClick={() => setSelectedIdea(null)} />
        <aside className="idea-drawer" role="dialog" aria-modal="true" aria-labelledby="idea-drawer-title">
            <div className="idea-drawer-heading">
            <div><span className="section-kicker">NOTES &amp; IDEAS</span><h2 id="idea-drawer-title">{display.title}</h2></div>
            <button className="modal-close" type="button" onClick={() => setSelectedIdea(null)} aria-label="Close details"><X size={18}/></button>
          </div>
          <div className="idea-drawer-scroll">
            <div className="idea-drawer-meta"><span className="idea-status"><i/> {selectedIdea.status ?? "Saved"}</span><time>Created {formatDate(selectedIdea.createdAt)}</time></div>
            <label className="note-type-control">Record type<select value={noteType(selectedIdea)} disabled={ideasIncomplete} onChange={event => changeIdeaType(selectedIdea, event.target.value as NoteType)}>{(["Quick Note", "Idea", "Reflection", "Action Item"] as NoteType[]).map(type => <option key={type} value={type}>{type}</option>)}</select></label>
            <div className="idea-drawer-original"><span>ORIGINAL NOTE</span><p>{selectedIdea.text}</p></div>

            <section className="work-memory-panel" aria-labelledby="work-memory-heading">
              <div className="work-memory-heading"><div><span className="section-kicker">WORK MEMORY</span><h3 id="work-memory-heading">From this Memo</h3></div><Sparkles size={17}/></div>
              <p className="work-memory-intro">AI suggests people, commitments, decisions, and facts from this note. Check the source and confirm each detail before it becomes work memory.</p>
              <button className="button button-dark work-memory-extract" type="button" onClick={() => void extractMemoWorkMemory(selectedIdea)} disabled={extractingMemoryMemoId !== null || workMemoryIncomplete || !workflowOwnerId || selectedIdea.text.length > 8000}>
                {extractingMemoryMemoId === selectedIdea.id ? "Reviewing Memo…" : "Extract Work Memory"}<Sparkles size={14}/>
              </button>
              {!workflowOwnerId && <p className="work-memory-hint">Sign in to extract Work Memory from this Memo.</p>}
              {selectedIdea.text.length > 8000 && <p className="work-memory-hint">This Memo is too long for extraction. Shorten it to 8,000 characters or fewer.</p>}
              {workMemoryIncomplete && <p className="work-memory-error" role="alert">Saved Work Memory could not be read safely, so changes are paused.</p>}
              {workMemoryFeedback?.memoId === selectedIdea.id && <p className={workMemoryFeedback.error ? "work-memory-error" : "work-memory-feedback"} role={workMemoryFeedback.error ? "alert" : "status"}>{workMemoryFeedback.message}</p>}

              {selectedMemoWorkMemory.filter(memory => memory.status !== "dismissed").map(memory => <article className={`work-memory-item ${memory.status}`} key={memory.id}>
                <div className="work-memory-item-heading"><span className="work-memory-type">{memory.type}</span><span className={`work-memory-status ${memory.status}`}>{memory.status === "confirmed" ? "Confirmed by you" : "AI suggestion · not confirmed"}</span></div>
                <h4>{memory.label}</h4><p className="work-memory-value">{memory.value}</p>
                <blockquote><span>Source · this Memo</span><p>“{memory.evidence}”</p></blockquote>
                {memory.sourceMemoUpdatedAt !== (selectedIdea.updatedAt ?? selectedIdea.createdAt) && <p className="work-memory-needs-confirmation">This Memo changed after extraction. Recheck the source before confirming.</p>}
                {memory.needsConfirmation && <p className="work-memory-needs-confirmation">Date, identity, or context needs your confirmation.</p>}
                {memory.status === "suggested" && <div className="work-memory-actions"><button type="button" className="button button-dark" onClick={() => updateWorkMemoryStatus(memory.id, "confirmed")} disabled={workMemoryIncomplete}><Check size={14}/> Confirm and save</button><button type="button" className="work-memory-dismiss" onClick={() => updateWorkMemoryStatus(memory.id, "dismissed")} disabled={workMemoryIncomplete}>Dismiss</button></div>}
              </article>)}
              {selectedMemoWorkMemory.filter(memory => memory.status === "dismissed").length > 0 && <details className="work-memory-dismissed"><summary>Dismissed ({selectedMemoWorkMemory.filter(memory => memory.status === "dismissed").length})</summary>{selectedMemoWorkMemory.filter(memory => memory.status === "dismissed").map(memory => <div key={memory.id}><span>{memory.type}</span><p><b>{memory.label}:</b> {memory.value}</p><button type="button" onClick={() => updateWorkMemoryStatus(memory.id, "suggested")} disabled={workMemoryIncomplete}>Restore suggestion</button></div>)}</details>}
            </section>

            {plannerData.events.filter(event => event.ideaId === selectedIdea.id).map(event => <div className="detail-schedule" key={event.id}><span><CalendarDays size={14}/> CALENDAR &amp; TO-DO</span><b>{event.title}</b><small>{formatScheduleDate(event.scheduledDate)}{event.scheduledTime ? " - " + event.scheduledTime : " - All day"} - {plannerData.todos.find(todo => todo.id === event.todoId)?.status ?? "Open"}</small></div>)}
            {plannerData.todos.filter(todo => todo.ideaId === selectedIdea.id && !todo.eventId).map(todo => <div className="detail-schedule" key={todo.id}><span><Check size={14}/> LINKED TO-DO</span><b>{todo.title}</b><small>{todo.dueDate ? "Due " + formatScheduleDate(todo.dueDate) : "No due date"} - {todo.status}</small></div>)}
            {selectedIdea.progressUpdatedAt && <p className="idea-drawer-updated">Last check-in {formatDate(selectedIdea.progressUpdatedAt)}</p>}
            {selectedIdea.updatedAt && !selectedIdea.progressUpdatedAt && <p className="idea-drawer-updated">Edited {formatDate(selectedIdea.updatedAt)}</p>}

            {noteType(selectedIdea) === "Action Item" && <div className="note-action-item-help"><p>Action Items stay in Notes &amp; Ideas until you choose to create a task.</p><button type="button" className="button button-outline-light" onClick={() => prepareTodoFromNote(selectedIdea)}>Prepare a To-do draft <ArrowRight size={14}/></button><small>Review and edit it before adding it. To set a follow-up later, connect the saved task in Workspace.</small></div>}

            <section className="idea-analysis" aria-labelledby="idea-analysis-heading">
              <div className="idea-analysis-heading"><div><span className="section-kicker">AI GUIDE</span><h3 id="idea-analysis-heading">Organize with AI</h3></div><Sparkles size={17}/></div>
              <p className="idea-analysis-intro">Ask AI Guide for a perspective, useful questions, and a possible next step. Your saved note stays unchanged.</p>
              <button className="button button-dark idea-analysis-button" type="button" onClick={() => void analyzeIdea(selectedIdea)} disabled={analyzingIdeaId !== null}>
                <Sparkles size={15}/>{isAnalyzing ? "Organizing..." : currentAnalysis ? "Organize again" : "Organize with AI"}
              </button>
              {isAnalyzing && <div className="idea-analysis-loading" role="status" aria-live="polite"><span/> AI Guide is reviewing your note...</div>}
              {currentAnalysisError && <p className="idea-analysis-error" role="alert">{currentAnalysisError}</p>}
              {currentAnalysis && <div className="idea-analysis-result">
                {!currentAnalysis.saved && <p className="idea-analysis-save-note" role="status">AI Guide responded, but the conversation could not be saved.</p>}
                <article><h4>Perspective</h4><p>{currentAnalysis.result.perspective}</p></article>
                <article><h4>Questions to consider</h4><ul>{currentAnalysis.result.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></article>
                <article><h4>Risks</h4><ul>{currentAnalysis.result.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul></article>
                <article><h4>Opportunities</h4><ul>{currentAnalysis.result.opportunities.map((opportunity, index) => <li key={index}>{opportunity}</li>)}</ul></article>

                <article><h4>Uncertainties</h4><ul>{currentAnalysis.result.uncertainty.map((item, index) => <li key={index}>{item}</li>)}</ul></article>
              </div>}
            </section>

            <div className="idea-actions idea-drawer-actions">
              <a className="button button-outline-light" href={`/partners?ideaId=${encodeURIComponent(selectedIdea.id)}`}><MessageCircleQuestion size={15}/> Ask AI Team</a>
              <button className="button button-outline-light" type="button" onClick={() => openCheckIn(selectedIdea.id)}><Sparkles size={15}/> Continue with AIASK</button>
              <button className="button button-outline-light" type="button" disabled={ideasIncomplete} onClick={() => openEditor(selectedIdea)}><Pencil size={15}/> Edit note</button>
              <button className="icon-button danger" type="button" aria-label="Delete note" disabled={ideasIncomplete} onClick={() => deleteIdea(selectedIdea)}><Trash2 size={16}/> Delete</button>
            </div>
          </div>
        </aside>
      </div>;
    })()}

    {captureOpen && <div className="modal-backdrop" onClick={closeCapture}><section className="capture-modal" role="dialog" aria-modal="true" aria-labelledby="capture-title" onClick={e => e.stopPropagation()}><button className="modal-close" onClick={closeCapture} aria-label="Close"><X size={18}/></button>{saved ? <div className="saved-state"><div className="saved-check"><Check size={23}/></div><div className="section-kicker">NOTE SAVED</div><h2>There. It’s out of your head.</h2><p>Your note is saved in Notes &amp; Ideas and will be here when you return.</p><button className="button button-dark" onClick={() => { closeCapture(); setView("inbox"); }}>Open Notes &amp; Ideas <ArrowRight size={15}/></button></div> : <><div className="modal-symbol"><Sparkles size={20}/></div><div className="section-kicker">QUICK CAPTURE</div><h2 id="capture-title">{editingIdeaId ? "Edit your note." : "What’s on your mind?"}</h2><p className="modal-copy">Capture it first. Choose a record type when you are ready.</p><form onSubmit={editingIdeaId ? saveEdit : saveIdea}><label htmlFor="idea-input">NOTE</label><textarea autoFocus id="idea-input" value={idea} onChange={e => setIdea(e.target.value)} placeholder="What's on your mind? Capture a note, thought, or idea…" rows={4}/><label className="note-type-control" htmlFor="idea-type-draft">Record type<select id="idea-type-draft" value={ideaTypeDraft} disabled={ideasIncomplete} onChange={event => setIdeaTypeDraft(event.target.value as NoteType)}>{(["Quick Note", "Idea", "Reflection", "Action Item"] as NoteType[]).map(type => <option key={type} value={type}>{type}</option>)}</select></label>{storageError && <p className="storage-error" role="alert">{storageError}</p>}<div className="form-foot"><span>New notes start as Quick Notes. You can change this later.</span><button className="button button-dark" type="submit" disabled={!idea.trim() || !storageReady || ideasIncomplete}>{editingIdeaId ? "Save changes" : "Save note"} <Send size={14}/></button></div></form></>}</section></div>}

    {proactiveOpen && <div className="modal-backdrop proactive-backdrop" onClick={() => setProactiveOpen(false)}><section className="proactive-modal checkin-modal checkin-modal-v2" role="dialog" aria-modal="true" aria-label="Idea progress check-in" onClick={event => event.stopPropagation()}>
      <button type="button" className="modal-close checkin-modal-close" onClick={() => setProactiveOpen(false)} aria-label="Close"><X size={18}/></button>
      {!storageReady ? <div className="checkin-empty"><div className="section-kicker">NOTES &amp; IDEAS</div><h2>Loading your saved notes…</h2></div> : ideas.length === 0 ? <div className="checkin-empty"><span className="empty-icon"><Compass size={22}/></span><div className="section-kicker">NOTES &amp; IDEAS</div><h2>Your saved notes will show up here.</h2><p>Capture a note, then decide whether it needs a next step.</p><button type="button" className="button button-dark" onClick={() => { setProactiveOpen(false); setView("inbox"); }}>View Notes &amp; Ideas <ArrowRight size={14}/></button></div> : checkInIdea ? <>
        <header className="checkin-modal-header">
          <div className="checkin-header-copy">
            <div className="proactive-modal-eyebrow"><span className="pulse"/> NOTES &amp; IDEAS · PROGRESS</div>
            <h2 id="proactive-title">{ideaTitleAndSummary(checkInIdea.text).title}</h2>
            <p>How is this moving along? <span>Saved {formatDate(checkInIdea.createdAt)}</span></p>
          </div>
          <span className="checkin-count">{ideas.findIndex(item => item.id === checkInIdea.id) + 1} / {ideas.length}</span>
        </header>
        <div className="checkin-scroll">
          {ideas.length > 1 && <div className="checkin-select-wrap"><label className="checkin-select-label" htmlFor="checkin-item">Choose an idea</label><select id="checkin-item" className="checkin-select" value={checkInIdea.id} onChange={event => selectCheckIn(event.target.value)}>{ideas.map(item => <option key={item.id} value={item.id}>{item.text.replace(/\s+/g, " ").slice(0, 74)}</option>)}</select></div>}
          <article className="checkin-item"><div className="checkin-item-meta"><span><Lightbulb size={14}/> ORIGINAL IDEA</span><time>Saved {formatDate(checkInIdea.createdAt)}</time></div><p>{checkInIdea.text}</p></article>

          <section className="checkin-review" aria-labelledby="checkin-review-title">
            <div className="checkin-review-head"><div><span className="section-kicker">AI TEAM</span><h3 id="checkin-review-title">AI Team Review</h3></div>
              <label className="checkin-role-picker"><span>Choose a partner</span><select aria-label="Choose an AI partner" value={reviewPartnerRole} onChange={event => setReviewPartnerRole(event.target.value as PartnerRole)}>{AI_PARTNER_OPTIONS.map(partner => <option key={partner.id} value={partner.id}>{partner.name}</option>)}</select></label>
            </div>
            {!checkInAnalysis && !isAnalyzingCheckInIdea && !checkInAnalysisError && <p className="checkin-review-intro">Ask an AI partner to help you clarify this idea, evaluate risks, or identify a useful next step.</p>}
            <button type="button" className="button button-dark checkin-ai-button" onClick={() => void analyzeIdea(checkInIdea, reviewPartnerRole)} disabled={analyzingIdeaId !== null || refiningNextStep || checkInSaving}>
              {isAnalyzingCheckInIdea ? "Reviewing…" : checkInAnalysisError ? "Retry AI Team Review" : checkInAnalysis ? "Ask AI Team again" : "Ask AI Team"}
              {!isAnalyzingCheckInIdea && <Sparkles size={14}/>}
            </button>
            {isAnalyzingCheckInIdea && <p className="checkin-ai-status" role="status">{aiPartnerName(reviewPartnerRole)} is reviewing your idea…</p>}
            {checkInAnalysisError && <p className="checkin-ai-error" role="alert">{checkInAnalysisError}</p>}
            {checkInAnalysis && <div className="checkin-review-result">
              <div className="checkin-review-result-meta">{aiPartnerName(checkInAnalysis.partnerRole)} · AI suggestion</div>
              <p className="checkin-review-perspective">{checkInAnalysis.result.perspective}</p>
              {checkInAnalysis.result.questions.length > 0 && <div className="checkin-review-detail"><b>Questions</b><ul>{checkInAnalysis.result.questions.map((item, index) => <li key={`question-${index}`}>{item}</li>)}</ul></div>}
              {checkInAnalysis.result.risks.length > 0 && <div className="checkin-review-detail"><b>Risks to consider</b><ul>{checkInAnalysis.result.risks.map((item, index) => <li key={`risk-${index}`}>{item}</li>)}</ul></div>}
              {checkInAnalysis.result.opportunities.length > 0 && <div className="checkin-review-detail"><b>Other angles</b><ul>{checkInAnalysis.result.opportunities.map((item, index) => <li key={`opportunity-${index}`}>{item}</li>)}</ul></div>}
              <div className="checkin-review-next-step"><b>Possible next step</b><p>{checkInAnalysis.result.nextStep}</p></div>
              {checkInAnalysis.result.uncertainty.length > 0 && <div className="checkin-review-detail"><b>Still unclear</b><ul>{checkInAnalysis.result.uncertainty.map((item, index) => <li key={`uncertainty-${index}`}>{item}</li>)}</ul></div>}
              {!checkInAnalysis.saved && <p className="checkin-ai-save-note" role="status">The review is shown here, but its conversation could not be saved.</p>}
            </div>}
          </section>

          <section className="checkin-field checkin-progress-field" aria-labelledby="checkin-progress-title">
            <div className="checkin-section-heading"><div><span className="checkin-label">CURRENT PROGRESS</span><h3 id="checkin-progress-title">Where is this idea now?</h3></div></div>
            <p className="checkin-field-hint">Track work progress; this is not a decision about the idea’s value.</p>
            <div className="status-options" role="group" aria-label="Current progress">{(["Saved", "In progress", "Done"] as const).map(status => <button type="button" key={status} aria-pressed={checkInStatus === status} className={checkInStatus === status ? "selected" : ""} disabled={checkInSaving} onClick={() => { setCheckInStatus(status); setCheckInSaved(false); setCheckInSaveError(""); }}>{status === "Done" && <Check size={13}/>} {status}</button>)}</div>
          </section>

          <section className="checkin-field checkin-next-step-field" aria-labelledby="checkin-next-step-title">
            <div className="checkin-next-step-heading"><label className="checkin-label" htmlFor="next-step">NEXT STEP</label><button type="button" className="checkin-refine-button" onClick={() => void refineNextStep()} disabled={!checkInIdea || refiningNextStep || analyzingIdeaId !== null || checkInSaving}>{refiningNextStep ? "Refining…" : <><Sparkles size={13}/> Refine with AI</>}</button></div>
            <textarea id="next-step" value={nextStepDraft} onChange={event => { setNextStepDraft(event.target.value); setCheckInSaved(false); setCheckInSaveError(""); }} placeholder="What’s one small action that would move this forward?" rows={3} disabled={checkInSaving}/>
            {refiningNextStep && <p className="checkin-ai-status" role="status">{aiPartnerName(reviewPartnerRole)} is drafting a suggestion…</p>}
            {nextStepError && <p className="checkin-ai-error" role="alert">{nextStepError}</p>}
            {checkInSuggestion && <aside className="checkin-suggestion"><div className="checkin-suggestion-meta">Suggestion from {aiPartnerName(checkInSuggestion.partnerRole)}</div><p>{checkInSuggestion.text}</p><div className="checkin-suggestion-actions"><button type="button" className="button button-dark" onClick={() => { setNextStepDraft(checkInSuggestion.text); setNextStepSuggestion(null); setCheckInSaved(false); setCheckInSaveError(""); }}>Use suggestion</button><button type="button" className="checkin-suggestion-dismiss" onClick={() => setNextStepSuggestion(null)}>Dismiss</button></div>{!checkInSuggestion.saved && <small>The suggestion is available, but its conversation could not be saved.</small>}</aside>}
          </section>
          {checkInIdea.progressUpdatedAt && <p className="checkin-updated">Last progress update: {formatDate(checkInIdea.progressUpdatedAt)}</p>}
          {checkInSaveError && <p className="storage-error" role="alert">{checkInSaveError}</p>}
        </div>
        <footer className="checkin-footer"><div className="proactive-modal-actions"><button type="button" className="button button-outline-light" onClick={() => { setProactiveOpen(false); setView("inbox"); setSelectedIdea(checkInIdea); }}>View in Notes &amp; Ideas <ArrowUpRight size={14}/></button><button type="button" className="button button-dark" onClick={() => void saveCheckIn()} disabled={checkInSaving || checkInSaved}>{checkInSaving ? "Saving…" : checkInSaved ? "Progress saved" : checkInSaveError ? "Try saving again" : "Save progress"} {!checkInSaving && <Check size={14}/>}</button></div>{checkInSaved && <p className="checkin-saved" role="status"><Check size={14}/> {nextStepDraft.trim() ? "Progress saved. Your next step is in To-do." : "Progress saved."}</p>}</footer>
      </> : null}
    </section></div>}
    </>}
  </main>;
}
