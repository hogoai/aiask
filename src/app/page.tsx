"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Bell, Brain, BrainCircuit, CalendarCheck, CalendarDays, ChartNoAxesCombined, Check, ChevronDown, CircleCheck, Clock3, Compass, Inbox, Lightbulb, Menu, MessageCircle, MessageCircleQuestion, MoreHorizontal, Pencil, Plus, Send, Sparkles, Target, Trash2, X } from "lucide-react";
import { getTaskPriority, PriorityControl, type TaskPriority } from "./PriorityControl";
import AccountControl from "./AccountControl";
import { defaultLocale } from "../i18n/config";
import "./site-navigation.css";
import { isSupabaseConfigured } from "../lib/supabase/config";
import { createClient } from "../lib/supabase/client";
import { getHomeView, homeViewUrl, type HomeView } from "../lib/home-navigation";
import { PARTNER_ROLE_ID, validateAIASKOutput, type PartnerResponse, type PartnerRole } from "../lib/ai/contracts";

type IdeaStatus = "Saved" | "In progress" | "Done";
type IdeaInboxFilter = "All" | "Inbox" | "In progress" | "Done" | "Archived";
type IdeaRecord = { id: string; text: string; createdAt: string; updatedAt?: string; status?: IdeaStatus; nextStep?: string; progressUpdatedAt?: string };
type PlannerEvent = { id: string; ideaId: string | null; todoId: string | null; title: string; scheduledDate: string; scheduledTime: string | null; description: string; priority?: TaskPriority; createdAt: string; origin?: "calendar" | "task-deadline" };
type PlannerTodo = { id: string; ideaId: string | null; eventId: string | null; title: string; dueDate: string; status: "Open" | "Done"; priority?: TaskPriority; createdAt?: string; completedAt?: string; updatedAt?: string; remindAt?: string; remindedAt?: string; reminderPending?: boolean };
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

function dateFromInput(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function countEventPriorities(events: PlannerEvent[], todos: PlannerTodo[]) {
  return events.reduce((counts, event) => {
    const priority = getTaskPriority(todos.find(todo => todo.id === event.todoId)?.priority ?? event.priority);
    counts[priority] += 1;
    return counts;
  }, { urgent: 0, attention: 0, onTrack: 0 });
}

const roles = [
  { icon: MessageCircleQuestion, no: "01", name: "AI Guide", title: "Clarifies what matters", copy: "Asks thoughtful questions to understand your needs, clarify your goals, and help you find the right direction." },
  { icon: CalendarCheck, no: "02", name: "AI Planner", title: "Turns goals into plans", copy: "Breaks your goals into realistic tasks, priorities, milestones, and calendar plans." },
  { icon: BrainCircuit, no: "03", name: "AI Knowledge Specialist", title: "Connects ideas and knowledge", copy: "Connects your notes, knowledge, and related information to reveal new perspectives and useful insights." },
  { icon: ChartNoAxesCombined, no: "04", name: "AI Evaluator", title: "Evaluates progress and results", copy: "Reviews your progress, checks results against your goals, and identifies gaps, risks, and areas to improve." },
  { icon: Compass, no: "05", name: "AI Advisor", title: "Helps you make better decisions", copy: "Compares options, evaluates opportunities and risks, and recommends practical next steps." },
  { icon: Target, no: "06", name: "AI Action Coach", title: "Helps you start what matters", copy: "Turns intentions into small, user-chosen actions, helps lower starting friction, and adapts when you learn something new." },
];

export default function Home() {
  return <Suspense fallback={<main className="wrap auth-gate-loading" role="status">Opening AIASK…</main>}><HomeContent /></Suspense>;
}

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const view = getHomeView(searchParams);
  function setView(nextView: HomeView) {
    router.push(homeViewUrl(nextView, queryString));
  }
  const [captureOpen, setCaptureOpen] = useState(false);
  const [idea, setIdea] = useState("");
  const [saved, setSaved] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"day" | "tasks" | "ideas">("day");
  const [ideas, setIdeas] = useState<IdeaRecord[]>([]);
  const [plannerData, setPlannerData] = useState<PlannerData>({ events: [], todos: [] });
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
  const [storageError, setStorageError] = useState("");
  const [plannerNotice, setPlannerNotice] = useState("");
  const [selectedIdea, setSelectedIdea] = useState<IdeaRecord | null>(null);
  const [ideaAnalysis, setIdeaAnalysis] = useState<{ ideaId: string; partnerRole: PartnerRole; result: PartnerResponse; saved: boolean } | null>(null);
  const [analyzingIdeaId, setAnalyzingIdeaId] = useState<string | null>(null);
  const [ideaAnalysisError, setIdeaAnalysisError] = useState<{ ideaId: string; partnerRole: PartnerRole; message: string } | null>(null);
  const [ideaInboxFilter, setIdeaInboxFilter] = useState<IdeaInboxFilter>("All");
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
  const checkInAnalysis = ideaAnalysis?.ideaId === checkInIdea?.id ? ideaAnalysis : null;
  const checkInAnalysisError = ideaAnalysisError && ideaAnalysisError.ideaId === checkInIdea?.id && ideaAnalysisError.partnerRole === reviewPartnerRole ? ideaAnalysisError.message : "";
  const checkInSuggestion = nextStepSuggestion?.ideaId === checkInIdea?.id ? nextStepSuggestion : null;
  const isAnalyzingCheckInIdea = analyzingIdeaId === checkInIdea?.id;
  const ideaInboxFilters: IdeaInboxFilter[] = ["All", "Inbox", "In progress", "Done", "Archived"];
  const visibleInboxIdeas = ideas.filter(item => {
    const status = item.status ?? "Saved";
    if (ideaInboxFilter === "All") return true;
    if (ideaInboxFilter === "Inbox") return status === "Saved";
    if (ideaInboxFilter === "Archived") return false;
    return status === ideaInboxFilter;
  });
  const monthStart = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), 1);
  const calendarGridStart = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1 - ((monthStart.getDay() + 6) % 7));
  const calendarDates = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(calendarGridStart.getFullYear(), calendarGridStart.getMonth(), calendarGridStart.getDate() + index);
    return { date: toDateInputValue(day), day: day.getDate(), inMonth: day.getMonth() === calendarCursor.getMonth() };
  });
  const selectedDateEvents = plannerData.events.filter(event => event.scheduledDate === selectedCalendarDate).sort((a, b) => (a.scheduledTime ?? "").localeCompare(b.scheduledTime ?? ""));
  function priorityForEvent(event: PlannerEvent) {
    return getTaskPriority(plannerData.todos.find(todo => todo.id === event.todoId)?.priority ?? event.priority);
  }
  const openTodos = plannerData.todos.filter(todo => todo.status !== "Done");
  const doneTodos = plannerData.todos.filter(todo => todo.status === "Done");
  const activeReminder = plannerData.todos.find(todo => todo.id === activeReminderId && todo.status !== "Done") ?? null;

  useEffect(() => {
    setHydrated(true);
    setNotificationPermission("Notification" in window ? Notification.permission : "unsupported");
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
    try {
      if (params.get("continue") === "1") {
        const nextStep = window.localStorage.getItem("aiask-next-step-draft")?.trim();
        if (nextStep) {
          setTodoTitle(nextStep);
          setPlannerNotice("Review this next step, choose a due date or reminder, then add it to your To-do list.");
          window.localStorage.removeItem("aiask-next-step-draft");
        }
      }
    } catch {
      setStorageError("We couldn’t read your next-step draft from this browser.");
    }
  }, [queryString]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("aiask-idea-box");
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed)) setIdeas(parsed.filter((item): item is IdeaRecord => item && typeof item.id === "string" && typeof item.text === "string" && typeof item.createdAt === "string"));
      }
      const plannerStored = window.localStorage.getItem("aiask-planner");
      if (plannerStored) {
        const parsedPlanner: unknown = JSON.parse(plannerStored);
        if (parsedPlanner && typeof parsedPlanner === "object" && "events" in parsedPlanner && "todos" in parsedPlanner && Array.isArray(parsedPlanner.events) && Array.isArray(parsedPlanner.todos)) {
          const events = [...parsedPlanner.events as PlannerEvent[]];
          let linkedExistingTodos = 0;
          const todos = (parsedPlanner.todos as PlannerTodo[]).map(todo => {
            if (!todo.dueDate) return todo;
            const existingEvent = events.find(item => item.todoId === todo.id || (todo.eventId && item.id === todo.eventId));
            if (existingEvent) {
              if (todo.eventId !== existingEvent.id || existingEvent.todoId !== todo.id) {
                linkedExistingTodos += 1;
                const index = events.findIndex(item => item.id === existingEvent.id);
                events[index] = { ...existingEvent, todoId: todo.id };
                return { ...todo, eventId: existingEvent.id };
              }
              return todo;
            }
            const eventId = crypto.randomUUID();
            events.push({ id: eventId, todoId: todo.id, ideaId: todo.ideaId, title: todo.title, scheduledDate: todo.dueDate, scheduledTime: null, description: todo.title, priority: getTaskPriority(todo.priority), createdAt: todo.createdAt ?? new Date().toISOString() });
            linkedExistingTodos += 1;
            return { ...todo, eventId };
          });
          const loadedPlanner = { events, todos };
          setPlannerData(loadedPlanner);
          if (linkedExistingTodos > 0) {
            try {
              window.localStorage.setItem("aiask-planner", JSON.stringify(loadedPlanner));
              setPlannerNotice(`${linkedExistingTodos} existing dated ${linkedExistingTodos === 1 ? "to-do is" : "to-dos are"} now linked to Calendar.`);
            } catch {
              setStorageError("Some dated to-dos were linked in this session, but the update could not be saved to browser storage.");
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
    try {
      window.localStorage.setItem("aiask-idea-box", JSON.stringify(nextIdeas));
      setIdeas(nextIdeas);
      setStorageError("");
      return true;
    } catch {
      setStorageError("This idea couldn’t be saved. Please check your browser storage and try again.");
      return false;
    }
  }

  function saveIdea(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!idea.trim() || !storageReady) return;
    const record: IdeaRecord = { id: crypto.randomUUID(), text: idea.trim(), createdAt: new Date().toISOString(), status: "Saved" };
    if (!persistIdeas([record, ...ideas])) return;
    setEditingIdeaId(null);
    setSaved(true);
  }

  function captureFromHome(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!homeIdea.trim() || !storageReady) return;
    const record: IdeaRecord = { id: crypto.randomUUID(), text: homeIdea.trim(), createdAt: new Date().toISOString(), status: "Saved" };
    if (persistIdeas([record, ...ideas])) {
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
    try {
      window.localStorage.setItem("aiask-planner", JSON.stringify(nextPlanner));
      setPlannerData(nextPlanner);
      setStorageError("");
      setPlannerNotice("");
      return true;
    } catch {
      setStorageError("This calendar or to-do change couldn’t be saved. Please check your browser storage and try again.");
      return false;
    }
  }

  function addCalendarEvent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!eventTitle.trim() || !eventDate) return;
    const now = new Date().toISOString();
    const eventId = crypto.randomUUID();
    const todoId = crypto.randomUUID();
    const calendarEvent: PlannerEvent = { id: eventId, todoId, ideaId: eventIdeaId || null, title: eventTitle.trim(), scheduledDate: eventDate, scheduledTime: eventTime || null, description: eventTitle.trim(), priority: eventPriority, createdAt: now, origin: "calendar" };
    const linkedTodo: PlannerTodo = { id: todoId, eventId, ideaId: eventIdeaId || null, title: eventTitle.trim(), dueDate: eventDate, status: "Open", priority: eventPriority, createdAt: now };
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
    const todo: PlannerTodo = { id: todoId, eventId, ideaId: todoIdeaId || null, title: todoTitle.trim(), dueDate: todoDueDate, status: "Open", priority: todoPriority, createdAt: now, updatedAt: now, remindAt: reminderDate?.toISOString() };
    const calendarEvent: PlannerEvent | null = eventId ? { id: eventId, todoId, ideaId: todoIdeaId || null, title: todo.title, scheduledDate: todoDueDate, scheduledTime: null, description: todo.title, priority: todoPriority, createdAt: now, origin: "task-deadline" } : null;
    const nextPlanner: PlannerData = {
      todos: [todo, ...plannerData.todos],
      events: calendarEvent ? [...plannerData.events, calendarEvent] : plannerData.events,
    };
    if (persistPlanner(nextPlanner)) {
      if (todoDueDate) {
        const dueDate = dateFromInput(todoDueDate);
        setSelectedCalendarDate(todoDueDate);
        setCalendarCursor(new Date(dueDate.getFullYear(), dueDate.getMonth(), 1));
      }
      setTodoTitle(""); setTodoDueDate(""); setTodoReminderAt(""); setTodoIdeaId(""); setNewTodoPriority("onTrack");
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
    persistPlanner({ events: plannerData.events.filter(item => item.id !== eventId), todos: event.todoId ? plannerData.todos.filter(todo => todo.id !== event.todoId) : plannerData.todos });
  }

  function deleteTodo(todoId: string) {
    const todo = plannerData.todos.find(item => item.id === todoId);
    persistPlanner({ todos: plannerData.todos.filter(item => item.id !== todoId), events: todo?.eventId ? plannerData.events.filter(event => event.id !== todo.eventId) : plannerData.events });
    if (activeReminderId === todoId) dismissReminder();
  }

  function changeCalendarMonth(offset: number) {
    const nextMonth = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + offset, 1);
    setCalendarCursor(nextMonth);
    setSelectedCalendarDate(toDateInputValue(nextMonth));
  }

  function openCalendarDate(date: string) {
    const selected = dateFromInput(date);
    setCalendarCursor(new Date(selected.getFullYear(), selected.getMonth(), 1));
    setSelectedCalendarDate(date);
    setView("calendar");
  }

  function togglePlannerTodo(todoId: string) {
    const currentTodo = plannerData.todos.find(todo => todo.id === todoId);
    const now = new Date().toISOString();
    const nextPlanner: PlannerData = { ...plannerData, todos: plannerData.todos.map(todo => todo.id === todoId ? { ...todo, status: todo.status === "Done" ? "Open" : "Done", completedAt: todo.status === "Done" ? undefined : now, updatedAt: now, reminderPending: todo.status === "Done" ? todo.reminderPending : false } : todo) };
    persistPlanner(nextPlanner);
    if (currentTodo?.status === "Open" && activeReminderId === todoId) dismissReminder();
  }

  function setTodoPriority(todoId: string, priority: TaskPriority) {
    const now = new Date().toISOString();
    const nextPlanner: PlannerData = {
      todos: plannerData.todos.map(item => item.id === todoId && item.priority !== priority ? { ...item, priority, updatedAt: now } : item),
      events: plannerData.events.map(event => event.todoId === todoId ? { ...event, priority } : event),
    };
    persistPlanner(nextPlanner);
  }

  function setEventPriority(eventId: string, priority: TaskPriority) {
    const calendarEvent = plannerData.events.find(item => item.id === eventId);
    if (!calendarEvent) return;
    const linkedTodo = calendarEvent.todoId ? plannerData.todos.find(todo => todo.id === calendarEvent.todoId) : null;
    const now = new Date().toISOString();
    const nextPlanner: PlannerData = {
      events: plannerData.events.map(event => event.id === eventId ? { ...event, priority } : event),
      todos: linkedTodo ? plannerData.todos.map(todo => todo.id === linkedTodo.id && todo.priority !== priority ? { ...todo, priority, updatedAt: now } : todo) : plannerData.todos,
    };
    persistPlanner(nextPlanner);
  }

  function closeCapture() { setCaptureOpen(false); setSaved(false); setIdea(""); setEditingIdeaId(null); }

  function saveEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingIdeaId || !idea.trim()) return;
    const next = ideas.map(item => item.id === editingIdeaId ? { ...item, text: idea.trim(), updatedAt: new Date().toISOString() } : item);
    if (persistIdeas(next)) { setSelectedIdea(next.find(item => item.id === editingIdeaId) ?? null); closeCapture(); }
  }

  function openEditor(item: IdeaRecord) { setIdea(item.text); setEditingIdeaId(item.id); setSaved(false); setCaptureOpen(true); }
  function formatDate(date: string) { return new Intl.DateTimeFormat(defaultLocale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(date)); }
  function formatScheduleDate(date: string) { return new Intl.DateTimeFormat(defaultLocale, { dateStyle: "long" }).format(new Date(`${date}T00:00:00`)); }

  return <main>
    <header className="nav wrap shared-site-nav">
      <a className="brand" href="#top" aria-label="AIASK home" onClick={event => { if (view !== "home") { event.preventDefault(); setView("home"); } }}><span className="brand-mark"><Sparkles size={17} /></span>aiask<span className="brand-dot">.</span></a>
      <button className="mobile-menu" aria-label="Toggle menu" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X /> : <Menu />}</button>
      <nav className={menuOpen ? "nav-links open" : "nav-links"}>
        <a href="/about" onClick={() => setMenuOpen(false)}>About Us</a><a href="/partners" onClick={() => setMenuOpen(false)}>AI Team</a><a href="/workspace" onClick={() => setMenuOpen(false)}>My Workspace</a>
        <button className={view === "calendar" ? "nav-cta active" : "nav-cta"} onClick={() => { setView("calendar"); setMenuOpen(false); }}><CalendarDays size={15}/> Calendar</button>
        <button className={view === "todos" ? "nav-cta active" : "nav-cta"} onClick={() => { setView("todos"); setMenuOpen(false); }}><Check size={15}/> To-do{openTodos.length > 0 && <span className="nav-count">{openTodos.length}</span>}</button>
        <button className={view === "inbox" ? "nav-cta active" : "nav-cta"} onClick={() => { setView(view === "inbox" ? "home" : "inbox"); setSelectedIdea(null); setMenuOpen(false); }}><Inbox size={15}/> Idea Box{ideas.length > 0 && <span className="nav-count">{ideas.length}</span>}</button>
        <button className="nav-cta share-cta" onClick={() => setCaptureOpen(true)}>Capture an idea <Plus size={15} /></button>
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
    {isSupabaseConfigured() && (view !== "home" || captureOpen) && <div className="wrap local-data-notice" role="status"><b>Local demo data</b><span>Your ideas, to-dos, and calendar items still live in this browser. They are not yet synced to your account.</span></div>}

    {view === "inbox" ? (
      <section className="idea-box wrap">
        <button className="inbox-back" type="button" onClick={() => { setView("home"); setSelectedIdea(null); setOpenIdeaMenuId(null); }}><ArrowLeft size={15}/> Back to AIASK</button>

        <form className="idea-quick-capture" onSubmit={captureFromHome}>
          <div className="idea-quick-capture-heading">
            <span className="quick-capture-icon"><Plus size={15}/></span>
            <div><b>Quick capture</b><small>Save a thought before it slips away.</small></div>
          </div>
          <label className="sr-only" htmlFor="idea-inbox-capture">Capture an idea</label>
          <textarea id="idea-inbox-capture" value={homeIdea} onChange={event => { setHomeIdea(event.target.value); setHomeIdeaSaved(false); }} placeholder="What is on your mind?" rows={2}/>
          <div className="idea-quick-capture-footer">
            <span>* &nbsp;No perfect prompt needed.</span>
            <button className="button button-dark" type="submit" disabled={!homeIdea.trim() || !storageReady}>Capture <ArrowUpRight size={15}/></button>
          </div>
        </form>
        {homeIdeaSaved && <div className="idea-capture-confirm" role="status"><Check size={15}/> Saved to your Idea Box.</div>}

        <section className="idea-inbox-panel" aria-labelledby="idea-inbox-title">
          <header className="idea-inbox-panel-heading">
            <h1 id="idea-inbox-title">Your ideas</h1>
            <span className="idea-inbox-count">{ideas.length} {ideas.length === 1 ? "idea" : "ideas"}</span>
          </header>
          <div className="idea-inbox-filters" role="group" aria-label="Filter ideas">
            {ideaInboxFilters.map(filter => <button key={filter} type="button" className={ideaInboxFilter === filter ? "selected" : ""} aria-pressed={ideaInboxFilter === filter} onClick={() => { setIdeaInboxFilter(filter); setOpenIdeaMenuId(null); }}>{filter}</button>)}
          </div>

          {!storageReady ? <div className="inbox-loading" role="status">Opening your Idea Box...</div> : visibleInboxIdeas.length === 0 ? (
            <div className="idea-inbox-empty">
              <span className="empty-icon"><Lightbulb size={21}/></span>
              <h2>{ideas.length === 0 ? "Your Idea Box is ready for its first thought." : ideaInboxFilter === "Archived" ? "No archived ideas yet." : "No ideas in this view."}</h2>
              <p>{ideas.length === 0 ? "Capture a thought above and it will be waiting here when you need it." : "Try another filter to see more of your ideas."}</p>
            </div>
          ) : (
            <div className="idea-inbox-list">
              {visibleInboxIdeas.map(item => {
                const display = ideaTitleAndSummary(item.text);
                const status = item.status ?? "Saved";
                const updatedAt = item.updatedAt ?? item.createdAt;
                const statusClass = status === "In progress" ? "in-progress" : status === "Done" ? "done" : "saved";
                return <article className="idea-inbox-row" key={item.id}>
                  <button className="idea-inbox-row-open" type="button" onClick={() => { setSelectedIdea(item); setOpenIdeaMenuId(null); }} aria-label={"Open idea: " + display.title}>
                    <Lightbulb size={22} strokeWidth={1.8}/>
                    <span className="idea-inbox-row-main">
                      <b>{display.title}</b>
                      <small>{display.summary}</small>
                      <span className="idea-inbox-row-meta"><span className={"idea-inbox-status-pill " + statusClass}>{status}</span><time>{formatDate(updatedAt)}</time></span>
                    </span>
                  </button>
                  <div className="idea-inbox-row-menu-wrap">
                    <button className="idea-inbox-row-menu-trigger" type="button" aria-label={"Actions for " + display.title} aria-haspopup="menu" aria-expanded={openIdeaMenuId === item.id} onClick={() => setOpenIdeaMenuId(current => current === item.id ? null : item.id)}><MoreHorizontal size={20}/></button>
                    {openIdeaMenuId === item.id && <div className="idea-inbox-row-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => { setOpenIdeaMenuId(null); setSelectedIdea(item); }}>Open details</button>
                      <button type="button" role="menuitem" onClick={() => { setOpenIdeaMenuId(null); setSelectedIdea(item); void analyzeIdea(item); }}>Analyze with AI</button>
                      <button type="button" role="menuitem" onClick={() => { setOpenIdeaMenuId(null); openEditor(item); }}>Edit thought</button>
                      <button type="button" role="menuitem" className="danger" onClick={() => { setOpenIdeaMenuId(null); if (persistIdeas(ideas.filter(ideaItem => ideaItem.id !== item.id)) && selectedIdea?.id === item.id) setSelectedIdea(null); }}>Delete idea</button>
                    </div>}
                  </div>
                </article>;
              })}
            </div>
          )}
          {storageError && <p className="storage-error" role="alert">{storageError}</p>}
        </section>
      </section>
    ) : view === "calendar" ? <section className="planner-page wrap">
      <button className="planner-back" onClick={() => setView("home")}><ArrowLeft size={14}/> Back to AIASK</button><div className="planner-page-heading"><div><div className="section-kicker">YOUR TIME, IN ONE PLACE</div><h1>AIASK <em>Calendar.</em></h1><p>Plans and next steps connected to the ideas behind them.</p></div><div className="planner-total"><CalendarDays size={17}/><span>{plannerData.events.length} {plannerData.events.length === 1 ? "event" : "events"}</span></div></div>
      {plannerNotice && <div className="planner-sync-notice" role="status" aria-live="polite"><Check size={15}/><span>{plannerNotice}</span><button type="button" onClick={() => setPlannerNotice("")} aria-label="Dismiss notification"><X size={14}/></button></div>}
      <div className="calendar-layout"><section className="calendar-panel"><div className="calendar-toolbar"><button aria-label="Previous month" onClick={() => changeCalendarMonth(-1)}><ArrowLeft size={15}/></button><h2>{new Intl.DateTimeFormat(defaultLocale, { month: "long", year: "numeric" }).format(calendarCursor)}</h2><button aria-label="Next month" onClick={() => changeCalendarMonth(1)}><ArrowRight size={15}/></button><button className="calendar-today" onClick={() => { const today = new Date(); setCalendarCursor(new Date(today.getFullYear(), today.getMonth(), 1)); setSelectedCalendarDate(toDateInputValue(today)); }}>Today</button></div><div className="calendar-priority-legend" aria-label="Priority color key"><span><i className="priority-urgent"/>Urgent</span><span><i className="priority-attention"/>Attention</span><span><i className="priority-onTrack"/>On Track</span></div><div className="calendar-weekdays">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(day => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{calendarDates.map(day => { const dayEvents = plannerData.events.filter(event => event.scheduledDate === day.date); const priorityCounts = countEventPriorities(dayEvents, plannerData.todos); const prioritySummary = (["urgent", "attention", "onTrack"] as const).filter(priority => priorityCounts[priority] > 0); const accessibleSummary = prioritySummary.map(priority => `${priorityCounts[priority]} ${priority === "urgent" ? "urgent" : priority === "attention" ? "attention" : "on track"}`).join(", "); return <button key={day.date} aria-label={`${formatScheduleDate(day.date)}${dayEvents.length ? `, ${accessibleSummary}` : ", no events"}`} className={`calendar-day${day.inMonth ? "" : " outside"}${selectedCalendarDate === day.date ? " selected" : ""}${day.date === toDateInputValue(new Date()) ? " today" : ""}`} onClick={() => setSelectedCalendarDate(day.date)}><span>{day.day}</span>{prioritySummary.length > 0 ? <span className="calendar-priority-summary" aria-hidden="true">{prioritySummary.map(priority => <span className={`calendar-priority-count priority-${priority}`} key={priority}><i />{priorityCounts[priority]}</span>)}</span> : <span className="calendar-no-events" aria-hidden="true">—</span>}</button>; })}</div></section>
        <aside className="calendar-agenda"><div className="agenda-heading"><div><div className="section-kicker">DAY AGENDA</div><h2>{formatScheduleDate(selectedCalendarDate)}</h2></div><span>{selectedDateEvents.length}</span></div>{selectedDateEvents.length === 0 ? <div className="agenda-empty">Nothing planned for this day yet.</div> : selectedDateEvents.map(event => { const priority = priorityForEvent(event); return <article className={`agenda-event priority-event-${priority}`} key={event.id}><div className="agenda-event-time">{event.scheduledTime ?? "ALL DAY"}</div><h3>{event.title}</h3><PriorityControl value={priority} onChange={value => setEventPriority(event.id, value)} label={`Priority for ${event.title}`} className="compact"/>{event.description !== event.title && <p>{event.description}</p>}{event.ideaId && <small>Linked to: {ideas.find(item => item.id === event.ideaId)?.text.slice(0, 58) ?? "Saved idea"}</small>}<div className="agenda-event-actions"><button onClick={() => event.todoId && togglePlannerTodo(event.todoId)}><Check size={13}/> {plannerData.todos.find(todo => todo.id === event.todoId)?.status ?? "Open"} to-do</button><button aria-label="Delete calendar event" onClick={() => deleteCalendarEvent(event.id)}><Trash2 size={13}/></button></div></article>; })}
          <form className="planner-form" onSubmit={addCalendarEvent}><div className="section-kicker">ADD TO CALENDAR</div><label htmlFor="event-title">What’s happening?</label><input id="event-title" required value={eventTitle} onChange={event => setEventTitle(event.target.value)} placeholder="e.g. Call the gallery"/><div className="planner-form-row"><label>Date<input type="date" required value={eventDate} onChange={event => setEventDate(event.target.value)}/></label><label>Time<input type="time" value={eventTime} onChange={event => setEventTime(event.target.value)}/></label></div><label htmlFor="event-idea">Related idea <span>Optional</span></label><select id="event-idea" value={eventIdeaId} onChange={event => setEventIdeaId(event.target.value)}><option value="">No linked idea</option>{ideas.map(item => <option key={item.id} value={item.id}>{item.text.replace(/\s+/g, " ").slice(0, 60)}</option>)}</select><PriorityControl value={eventPriority} onChange={setNewEventPriority} label="Priority for new calendar event" className="priority-form-control"/><button className="button button-dark" type="submit"><Plus size={14}/> Add event &amp; linked to-do</button></form>
        </aside></div>
    </section> : view === "todos" ? <section className="planner-page wrap">
      <button className="planner-back" onClick={() => setView("home")}><ArrowLeft size={14}/> Back to AIASK</button><div className="planner-page-heading"><div><div className="section-kicker">SMALL STEPS, KEPT VISIBLE</div><h1>Your <em>To-do list.</em></h1><p>Set a due date to add the task to Calendar automatically. Add a reminder and AIASK will bring the next step back at the time you choose.</p></div><div className="planner-total"><Check size={17}/><span>{openTodos.length} open</span></div></div>
      {plannerNotice && <div className="planner-sync-notice" role="status" aria-live="polite"><Check size={15}/><span>{plannerNotice}</span><button type="button" onClick={() => setPlannerNotice("")} aria-label="Dismiss notification"><X size={14}/></button></div>}
      <div className="todo-layout"><form className="planner-form todo-create-form" onSubmit={addTodo}><div className="section-kicker">ADD A TO-DO</div>{openTodos.length === 0 && doneTodos.length === 0 && <p className="reminder-first-use">Start with one real task. AIASK can remind you when it is time to take the next step.</p>}<label htmlFor="todo-title">What needs doing?</label><input id="todo-title" required value={todoTitle} onChange={event => setTodoTitle(event.target.value)} placeholder="Write a clear next step"/><label htmlFor="todo-date">Due date <span>Optional</span></label><input id="todo-date" type="date" value={todoDueDate} onChange={event => setTodoDueDate(event.target.value)}/><small className="planner-sync-hint">{todoDueDate ? "This task will also appear on Calendar as an all-day item." : "Choose a date to link this task to Calendar."}</small><label htmlFor="todo-reminder">Remind me <span>Optional</span></label><input id="todo-reminder" type="datetime-local" min={toDateTimeLocalValue(new Date(Date.now() + 60_000))} value={todoReminderAt} onChange={event => { setTodoReminderAt(event.target.value); setReminderError(""); }}/><small className="planner-sync-hint">AIASK checks reminders while this page is open. You can enable browser notifications for a desktop alert.</small><div className="notification-permission-row">{notificationPermission === "default" && <button type="button" onClick={enableBrowserNotifications}><Bell size={13}/> Enable browser notifications</button>}{notificationPermission === "granted" && <span><Bell size={13}/> Browser notifications enabled</span>}{notificationPermission === "denied" && <span>Browser notifications are blocked. In-app reminders still work while AIASK is open.</span>}{notificationPermission === "unsupported" && <span>In-app reminders work while AIASK is open.</span>}</div>{reminderError && <p className="reminder-error" role="alert">{reminderError}</p>}<label htmlFor="todo-idea">Related idea <span>Optional</span></label><select id="todo-idea" value={todoIdeaId} onChange={event => setTodoIdeaId(event.target.value)}><option value="">No linked idea</option>{ideas.map(item => <option key={item.id} value={item.id}>{item.text.replace(/\s+/g, " ").slice(0, 60)}</option>)}</select><PriorityControl value={todoPriority} onChange={setNewTodoPriority} label="Priority for new to-do" className="priority-form-control"/><button className="button button-dark" type="submit"><Plus size={14}/> {todoDueDate ? "Add to-do & Calendar" : "Add to-do"}</button></form>
        <div className="todo-list-panel"><div className="todo-list-heading"><div><div className="section-kicker">UP NEXT</div><h2>{openTodos.length} open {openTodos.length === 1 ? "task" : "tasks"}</h2></div></div>{openTodos.length === 0 && doneTodos.length === 0 ? <div className="todo-empty"><span className="empty-icon"><Check size={21}/></span><h3>Your list is clear.</h3><p>Add a next step or create one from a calendar event.</p></div> : <>{openTodos.slice().sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999")).map(todo => <article className="todo-item" key={todo.id}><button className="todo-check-button" aria-label="Mark to-do complete" onClick={() => togglePlannerTodo(todo.id)}><span/></button><div className="todo-item-copy"><h3>{todo.title}</h3><div className="todo-item-meta">{todo.dueDate && <span><CalendarDays size={12}/> Due {formatScheduleDate(todo.dueDate)}</span>}{todo.remindAt && <span><Clock3 size={12}/> Reminder {formatDate(todo.remindAt)}</span>}{todo.eventId && <span>Calendar linked</span>}{todo.ideaId && <span>Idea: {ideas.find(item => item.id === todo.ideaId)?.text.replace(/\s+/g, " ").slice(0, 45) ?? "Saved idea"}</span>}</div></div><PriorityControl value={todo.priority} onChange={value => setTodoPriority(todo.id, value)} label={`Priority for ${todo.title}`}/><button className="todo-delete" aria-label="Delete to-do" onClick={() => deleteTodo(todo.id)}><Trash2 size={14}/></button></article>)}{doneTodos.length > 0 && <><div className="section-kicker todo-done-heading">COMPLETED · {doneTodos.length}</div>{doneTodos.map(todo => <article className="todo-item done" key={todo.id}><button className="todo-check-button checked" aria-label="Reopen to-do" onClick={() => togglePlannerTodo(todo.id)}><Check size={13}/></button><div className="todo-item-copy"><h3>{todo.title}</h3><div className="todo-item-meta"><span>Completed</span>{todo.dueDate && <span>Due {formatScheduleDate(todo.dueDate)}</span>}</div></div><PriorityControl value={todo.priority} onChange={value => setTodoPriority(todo.id, value)} label={`Priority for ${todo.title}`}/><button className="todo-delete" aria-label="Delete to-do" onClick={() => deleteTodo(todo.id)}><Trash2 size={14}/></button></article>)}</>}</>}</div>
      </div>
    </section> : <>

    <section className="hero wrap" id="top">
      <div className="hero-copy">
        <div className="eyebrow"><span className="pulse" /> A more proactive kind of AI</div>
        <h1>Your next good<br />move starts <em>here.</em></h1>
        <p className="hero-intro">Life doesn’t wait for the perfect prompt. AIASK helps you catch ideas, make a plan, and keep moving toward what matters.</p>
        <form className="hero-composer" onSubmit={captureFromHome}>
          <div className="composer-top"><span className="composer-avatar"><Sparkles size={14}/></span><span>AIASK <i>is listening</i></span><span className="composer-live"><i/> READY</span></div>
          <label className="sr-only" htmlFor="home-idea">Share an idea with AIASK</label>
          <textarea id="home-idea" value={homeIdea} onChange={event => { setHomeIdea(event.target.value); setHomeIdeaSaved(false); }} placeholder="What’s on your mind? Share an idea, a note, or something to remember…" rows={2}/>
          <div className="composer-bottom"><span>✳ &nbsp;Start anywhere. No perfect prompt needed.</span><button className="button button-dark" type="submit" disabled={!homeIdea.trim() || !storageReady}>Capture <ArrowUpRight size={15}/></button></div>
        </form>
        {storageError && !captureOpen && <p className="storage-error hero-storage-error" role="alert">{storageError}</p>}
        {homeIdeaSaved && <div className="home-capture-confirm" role="status"><Check size={15}/> Saved to your Idea Box <button onClick={() => { setView("inbox"); setSelectedIdea(null); }}>Open Idea Box <ArrowRight size={13}/></button></div>}
        <div className="hero-actions"><a className="text-link" href="#how">Meet your AI team <ArrowDown size={15} /></a></div>
        <div className="hero-note"><span className="avatar-stack"><i>A</i><i>✳</i><i>Y</i></span><span>Built around your life, not another chatbot window.</span></div>
      </div>
      <div className="hero-art" aria-label="AIASK proactive planning dashboard preview">
        <div className="orbit orbit-one"></div><div className="orbit orbit-two"></div><div className="orbit orbit-three"></div>
        <div className="spark-node node-a">✳</div><div className="spark-node node-b"><CalendarDays size={17}/></div><div className="spark-node node-c"><Lightbulb size={17}/></div>
        <div className="dashboard-card">
          <div className="dash-top"><span className="dash-brand"><span className="mini-mark">✳</span> your day, in focus</span><span className="dash-date">MON · 21</span></div>
          <div className="dash-greeting">A little momentum<br />goes a long way.</div>
          <div className="proactive"><span className="proactive-icon"><Sparkles size={15}/></span><div><b>A thought for today</b><p>You mentioned wanting more time to write. There’s a quiet hour open at 10.</p><span className="suggestion-link">Make it a writing hour <ArrowRight size={12}/></span></div></div>
          <div className="task-head"><span>YOUR PLAN</span><span>2 OF 4 DONE</span></div>
          <div className="task-row done"><span className="task-check"><Check size={11}/></span><span>Review project notes</span><small>9:00</small></div>
          <div className="task-row"><span className="task-check"></span><span>Focus time · draft outline</span><small>10:00</small></div>
          <div className="task-row"><span className="task-check"></span><span>Walk + clear your head</span><small>12:30</small></div>
          <div className="dash-footer"><span className="footer-spark">✳</span> You’ve got this. I’ll check in later.</div>
        </div>
        <div className="floating-note note-memory"><Brain size={15}/><span>Remembering your goals</span></div>
        <div className="floating-note note-progress"><span className="progress-ring">↗</span><span>Small steps add up</span></div>
      </div>
      <a className="scroll-cue" href="#how"><span>SCROLL TO EXPLORE</span><ChevronDown size={14}/></a>
    </section>

    <section className="ticker"><div className="ticker-inner"><span>NOTICE</span><i>✳</i><span>PLAN</span><i>✳</i><span>REMEMBER</span><i>✳</i><span>NUDGE</span><i>✳</i><span>REFLECT</span><i>✳</i><span>REPEAT</span><i>✳</i><span>NOTICE</span><i>✳</i><span>PLAN</span></div></section>

    <section className="section how-section wrap" id="how">
      <div className="section-kicker">AN AI TEAM THAT PAYS ATTENTION</div>
      <div className="section-heading"><h2>Less starting over.<br /><em>More moving forward.</em></h2><p>AIASK brings your ideas, plans, knowledge, and progress into one thoughtful loop. It can reach out with a timely nudge—and still leaves you in charge.</p></div>
      <div className="steps-grid">
        <article className="step-card step-capture"><div className="step-top"><span>01 / CAPTURE</span><span className="step-icon"><MessageCircle size={17}/></span></div><h3>Get it out<br />of your head.</h3><p>Save a passing thought, voice-note an idea, or ask AIASK to remember something for later.</p><div className="capture-demo"><span className="tiny-spark">✳</span><span>“I should call Maya about the workshop…”</span><ArrowRight size={14}/></div></article>
        <article className="step-card step-plan"><div className="step-top"><span>02 / PLAN</span><span className="step-icon"><CalendarDays size={17}/></span></div><h3>Make a plan<br />that fits real life.</h3><p>Turn good intentions into clear next steps, with your time and energy in mind.</p><div className="plan-demo"><div><span className="plan-dot"></span>Draft workshop outline <small>Tomorrow · 10:00</small></div><Check size={14}/></div></article>
        <article className="step-card step-learn"><div className="step-top"><span>03 / FOLLOW THROUGH</span><span className="step-icon"><ArrowRight size={17}/></span></div><h3>Keep going.<br />Adjust as you go.</h3><p>Get a helpful nudge, see how things went, and learn what actually works for you.</p><div className="learn-demo"><span className="learn-face">☺</span><span>Two focus blocks this week. Nice rhythm.</span></div></article>
      </div>
    </section>

    <section className="roles-section" id="roles"><div className="wrap roles-wrap"><div className="roles-intro"><div className="section-kicker">SIX WAYS AIASK SHOWS UP</div><h2>One team.<br /><em>A whole lot of range.</em></h2><p>One AI core, with six specialized roles working together behind one calm, personal experience.</p><button className="button button-outline" onClick={() => openCheckIn()}>Check in on your ideas <ArrowUpRight size={15}/></button></div><div className="roles-grid">{roles.map(({icon: Icon,no,name,title,copy})=><article className="role-card" key={no}><div className="role-top"><span>{no}</span><Icon size={19}/></div><div className="role-name">{name}</div><h3>{title}</h3><p>{copy}</p></article>)}</div></div></section>

    <section className="workspace-section wrap" id="workspace"><div className="workspace-top"><div><div className="section-kicker">YOUR LIFE, WITH A LITTLE MORE CLARITY</div><h2>One home for the<br /><em>things you’re building.</em></h2></div><p>Ideas connect to plans. Plans connect to your calendar. And your knowledge stays close when it’s time to make the next move.</p></div>
      <div className="workspace-board"><aside className="board-sidebar"><div className="sidebar-brand"><span className="mini-mark">✳</span> aiask</div>
        <button className={workspaceMode === "day" ? "side-link workspace-side-link active" : "side-link workspace-side-link"} onClick={() => setWorkspaceMode("day")}><CalendarDays size={15}/> My day</button>
        <button className={workspaceMode === "tasks" ? "side-link workspace-side-link active" : "side-link workspace-side-link"} onClick={() => setWorkspaceMode("tasks")}><Check size={15}/> Tasks <span className="side-count">{openTodos.length}</span></button>
        <button className={workspaceMode === "ideas" ? "side-link workspace-side-link active" : "side-link workspace-side-link"} onClick={() => setWorkspaceMode("ideas")}><Lightbulb size={15}/> Ideas <span className="side-count">{ideas.length}</span></button>
        <button className="side-link workspace-side-link" onClick={() => { setSelectedCalendarDate(toDateInputValue(new Date())); setCalendarCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); setView("calendar"); }}><Brain size={15}/> Calendar <span className="side-count">{plannerData.events.length}</span></button>
        <div className="sidebar-bottom"><span className="user-dot">Y</span><span>You, in the loop</span><ChevronDown size={13}/></div></aside>
        <div className="board-main"><div className="board-header"><div><span className="board-date">{new Intl.DateTimeFormat(defaultLocale, { weekday: "long", month: "long", day: "numeric" }).format(new Date()).toUpperCase()}</span><h3>{workspaceMode === "ideas" ? "Your ideas" : workspaceMode === "tasks" ? "Your to-dos" : "Good morning, Alex"} <span>✳</span></h3><p>{workspaceMode === "ideas" ? "Saved thoughts, ready for their next step." : workspaceMode === "tasks" ? "Every open and completed task, in one place." : "Your calendar and next steps, connected."}</p></div><div className="workspace-actions"><button className="board-add" onClick={() => workspaceMode === "ideas" ? setCaptureOpen(true) : setView(workspaceMode === "tasks" ? "todos" : "calendar")}><Plus size={15}/> {workspaceMode === "ideas" ? "Add a thought" : workspaceMode === "tasks" ? "Manage tasks" : "Open calendar"}</button></div></div>
          <div className="board-columns"><div className="board-column">
            {workspaceMode === "ideas" ? <><div className="column-label">SAVED IDEAS <span>{ideas.length}</span></div>{ideas.length === 0 ? <div className="workspace-empty"><p>Your Idea Box is ready for its first thought.</p><button onClick={() => setCaptureOpen(true)}>Capture an idea <ArrowRight size={13}/></button></div> : ideas.map(item => <button className="workspace-idea-row" key={item.id} onClick={() => { setSelectedIdea(item); setView("inbox"); }}><Lightbulb size={14}/><span><b>{item.text}</b><small>{item.status ?? "Saved"} · {formatDate(item.createdAt)}</small></span><ArrowUpRight size={14}/></button>)}</> : <>
              <div className="column-label">{workspaceMode === "tasks" ? "ALL TO-DOS" : "UP NEXT"} <span>{workspaceMode === "tasks" ? plannerData.todos.length : openTodos.length + plannerData.events.length}</span></div>
              {(workspaceMode === "tasks" ? [...openTodos, ...doneTodos] : [...openTodos].sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"))).length === 0 && plannerData.events.length === 0 ? <div className="workspace-empty"><p>No tasks or calendar plans here yet.</p><button onClick={() => setView("todos")}>Add your first to-do <ArrowRight size={13}/></button></div> : <>
                {(workspaceMode === "tasks" ? [...openTodos, ...doneTodos] : [...openTodos].sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"))).map(todo => { const linkedIdea = ideas.find(item => item.id === todo.ideaId); return <div className={todo.status === "Done" ? "workspace-item done" : "workspace-item"} key={todo.id}><button className="workspace-check" aria-label={todo.status === "Done" ? "Reopen task" : "Complete task"} onClick={() => togglePlannerTodo(todo.id)}>{todo.status === "Done" && <Check size={12}/>}</button><button className="workspace-item-copy" onClick={() => setView("todos")}><b>{todo.title}</b><small>{todo.dueDate ? `Due ${formatScheduleDate(todo.dueDate)}` : "No due date"}{linkedIdea ? ` · ${linkedIdea.text}` : ""}</small></button><button className="workspace-open" onClick={() => setView("todos")}>Open</button></div>; })}
                {workspaceMode === "day" && plannerData.events.length > 0 && <><div className="column-label later-label">CALENDAR <span>{plannerData.events.length}</span></div>{[...plannerData.events].sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || (a.scheduledTime ?? "").localeCompare(b.scheduledTime ?? "")).map(event => <button className="workspace-event-row" key={event.id} onClick={() => openCalendarDate(event.scheduledDate)}><CalendarDays size={14}/><span><b>{event.title}</b><small>{formatScheduleDate(event.scheduledDate)}{event.scheduledTime ? ` · ${event.scheduledTime}` : " · All day"}</small></span><ArrowUpRight size={13}/></button>)}</>}
              </>}
            </>}
          </div><div className="board-side"><div className="coach-card"><div className="coach-icon"><Sparkles size={16}/></div><span className="coach-label">YOUR WORKSPACE</span><p>{openTodos.length} open {openTodos.length === 1 ? "task" : "tasks"} · {plannerData.events.length} calendar {plannerData.events.length === 1 ? "item" : "items"} · {ideas.length} saved {ideas.length === 1 ? "idea" : "ideas"}</p><button onClick={() => openCheckIn()}>Check in on progress <ArrowRight size={13}/></button></div><div className="week-card"><span>TO-DO PROGRESS</span><div className="week-stat">{doneTodos.length}<span> / {plannerData.todos.length}</span></div><p>tasks completed</p><div className="workspace-progress"><i style={{ width: `${plannerData.todos.length ? doneTodos.length / plannerData.todos.length * 100 : 0}%` }}/></div></div><button className="workspace-calendar-link" onClick={() => setView("calendar")}><CalendarDays size={14}/> Browse full calendar <ArrowRight size={13}/></button></div></div>
        </div>
      </div>
    </section>

    <section className="quote-section"><div className="wrap quote-inner"><span className="quote-mark">“</span><blockquote>The best AI doesn’t just answer you.<br /><em>It helps you become who you meant to be.</em></blockquote><div className="quote-foot"><span>AIASK · YOUR PERSONAL AI TEAM</span><span>ALWAYS IN YOUR CORNER <span className="quote-star">✳</span></span></div></div></section>

    <section className="final-cta wrap"><span className="cta-orb orb-left">✳</span><span className="cta-orb orb-right">✳</span><div className="eyebrow"><span className="pulse"/> YOUR NEXT CHAPTER, WITH YOUR AI TEAM</div><h2>What’s on your mind?</h2><p>A big ambition, a small reminder, a “someday” idea.<br />Start anywhere. AIASK will help you find the next step.</p><button className="button button-dark" onClick={() => setCaptureOpen(true)}>Drop in a thought <ArrowUpRight size={16}/></button><span className="cta-note">No perfect prompt needed. Just you, as you are.</span></section>

    <footer className="footer wrap"><a className="brand" href="#top"><span className="brand-mark"><Sparkles size={17}/></span>aiask<span className="brand-dot">.</span></a><span>More intention. Less mental clutter.</span><div><a href="#how">How it works</a><a href="#roles">AI team</a><a href="#top">Back to top ↑</a></div><small>© 2026 AIASK</small></footer>

    </>}

    {view === "inbox" && selectedIdea && (() => {
      const display = ideaTitleAndSummary(selectedIdea.text);
      const currentAnalysis = ideaAnalysis?.ideaId === selectedIdea.id && ideaAnalysis.partnerRole === PARTNER_ROLE_ID.guide ? ideaAnalysis : null;
      const currentAnalysisError = ideaAnalysisError && ideaAnalysisError.ideaId === selectedIdea.id && ideaAnalysisError.partnerRole === PARTNER_ROLE_ID.guide ? ideaAnalysisError.message : "";
      const isAnalyzing = analyzingIdeaId === selectedIdea.id;
      return <div className="idea-drawer-layer">
        <button className="idea-drawer-backdrop" type="button" aria-label="Close idea details" onClick={() => setSelectedIdea(null)} />
        <aside className="idea-drawer" role="dialog" aria-modal="true" aria-labelledby="idea-drawer-title">
          <div className="idea-drawer-heading">
            <div><span className="section-kicker">IDEA DETAILS</span><h2 id="idea-drawer-title">{display.title}</h2></div>
            <button className="modal-close" type="button" onClick={() => setSelectedIdea(null)} aria-label="Close details"><X size={18}/></button>
          </div>
          <div className="idea-drawer-scroll">
            <div className="idea-drawer-meta"><span className="idea-status"><i/> {selectedIdea.status ?? "Saved"}</span><time>Captured {formatDate(selectedIdea.createdAt)}</time></div>
            <div className="idea-drawer-original"><span>ORIGINAL THOUGHT</span><p>{selectedIdea.text}</p></div>

            {plannerData.events.filter(event => event.ideaId === selectedIdea.id).map(event => <div className="detail-schedule" key={event.id}><span><CalendarDays size={14}/> CALENDAR &amp; TO-DO</span><b>{event.title}</b><small>{formatScheduleDate(event.scheduledDate)}{event.scheduledTime ? " - " + event.scheduledTime : " - All day"} - {plannerData.todos.find(todo => todo.id === event.todoId)?.status ?? "Open"}</small></div>)}
            {plannerData.todos.filter(todo => todo.ideaId === selectedIdea.id && !todo.eventId).map(todo => <div className="detail-schedule" key={todo.id}><span><Check size={14}/> LINKED TO-DO</span><b>{todo.title}</b><small>{todo.dueDate ? "Due " + formatScheduleDate(todo.dueDate) : "No due date"} - {todo.status}</small></div>)}
            {selectedIdea.progressUpdatedAt && <p className="idea-drawer-updated">Last check-in {formatDate(selectedIdea.progressUpdatedAt)}</p>}
            {selectedIdea.updatedAt && !selectedIdea.progressUpdatedAt && <p className="idea-drawer-updated">Edited {formatDate(selectedIdea.updatedAt)}</p>}

            <section className="idea-analysis" aria-labelledby="idea-analysis-heading">
              <div className="idea-analysis-heading"><div><span className="section-kicker">AI GUIDE</span><h3 id="idea-analysis-heading">Analyze this idea</h3></div><Sparkles size={17}/></div>
              <p className="idea-analysis-intro">Choose when you want AI Guide to look at this thought and suggest a useful perspective.</p>
              <button className="button button-dark idea-analysis-button" type="button" onClick={() => void analyzeIdea(selectedIdea)} disabled={analyzingIdeaId !== null}>
                <Sparkles size={15}/>{isAnalyzing ? "Analyzing..." : currentAnalysis ? "Analyze again" : "Analyze with AI"}
              </button>
              {isAnalyzing && <div className="idea-analysis-loading" role="status" aria-live="polite"><span/> AI Guide is reviewing your idea...</div>}
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
              <button className="button button-outline-light" type="button" onClick={() => openCheckIn(selectedIdea.id)}><Sparkles size={15}/> Continue with AIASK</button>
              <button className="button button-outline-light" type="button" onClick={() => openEditor(selectedIdea)}><Pencil size={15}/> Edit thought</button>
              <button className="icon-button danger" type="button" aria-label="Delete thought" onClick={() => { if (persistIdeas(ideas.filter(item => item.id !== selectedIdea.id))) setSelectedIdea(null); }}><Trash2 size={16}/> Delete</button>
            </div>
          </div>
        </aside>
      </div>;
    })()}

    {captureOpen && <div className="modal-backdrop" onClick={closeCapture}><section className="capture-modal" role="dialog" aria-modal="true" aria-labelledby="capture-title" onClick={e => e.stopPropagation()}><button className="modal-close" onClick={closeCapture} aria-label="Close"><X size={18}/></button>{saved ? <div className="saved-state"><div className="saved-check"><Check size={23}/></div><div className="section-kicker">THOUGHT CAPTURED</div><h2>There. It’s out of your head.</h2><p>Your thought is saved in your Idea Box and will be here when you return.</p><button className="button button-dark" onClick={() => { closeCapture(); setView("inbox"); }}>Open Idea Box <ArrowRight size={15}/></button></div> : <><div className="modal-symbol"><Sparkles size={20}/></div><div className="section-kicker">A QUICK PLACE TO START</div><h2 id="capture-title">{editingIdeaId ? "Edit your thought." : "What’s on your mind?"}</h2><p className="modal-copy">An idea, a thing to remember, something you want to figure out. Just put it here.</p><form onSubmit={editingIdeaId ? saveEdit : saveIdea}><label htmlFor="idea-input">YOUR THOUGHT</label><textarea autoFocus id="idea-input" value={idea} onChange={e => setIdea(e.target.value)} placeholder="I’ve been thinking about…" rows={4}/>{storageError && <p className="storage-error" role="alert">{storageError}</p>}<div className="form-foot"><span>✳ &nbsp;No perfect prompt needed.</span><button className="button button-dark" type="submit" disabled={!idea.trim() || !storageReady}>{editingIdeaId ? "Save changes" : "Save this thought"} <Send size={14}/></button></div></form></>}</section></div>}

    {proactiveOpen && <div className="modal-backdrop proactive-backdrop" onClick={() => setProactiveOpen(false)}><section className="proactive-modal checkin-modal checkin-modal-v2" role="dialog" aria-modal="true" aria-label="Idea progress check-in" onClick={event => event.stopPropagation()}>
      <button type="button" className="modal-close checkin-modal-close" onClick={() => setProactiveOpen(false)} aria-label="Close"><X size={18}/></button>
      {!storageReady ? <div className="checkin-empty"><div className="section-kicker">IDEA BOX</div><h2>Loading your saved ideas…</h2></div> : ideas.length === 0 ? <div className="checkin-empty"><span className="empty-icon"><Compass size={22}/></span><div className="section-kicker">IDEA BOX</div><h2>Your saved ideas will show up here.</h2><p>Save a thought in Idea Box to track its progress and decide on a next step.</p><button type="button" className="button button-dark" onClick={() => { setProactiveOpen(false); setView("inbox"); }}>View Idea Box <ArrowRight size={14}/></button></div> : checkInIdea ? <>
        <header className="checkin-modal-header">
          <div className="checkin-header-copy">
            <div className="proactive-modal-eyebrow"><span className="pulse"/> IDEA BOX · PROGRESS</div>
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
        <footer className="checkin-footer"><div className="proactive-modal-actions"><button type="button" className="button button-outline-light" onClick={() => { setProactiveOpen(false); setView("inbox"); setSelectedIdea(checkInIdea); }}>View in Idea Box <ArrowUpRight size={14}/></button><button type="button" className="button button-dark" onClick={() => void saveCheckIn()} disabled={checkInSaving || checkInSaved}>{checkInSaving ? "Saving…" : checkInSaved ? "Progress saved" : checkInSaveError ? "Try saving again" : "Save progress"} {!checkInSaving && <Check size={14}/>}</button></div>{checkInSaved && <p className="checkin-saved" role="status"><Check size={14}/> {nextStepDraft.trim() ? "Progress saved. Your next step is in To-do." : "Progress saved."}</p>}</footer>
      </> : null}
    </section></div>}
    </>}
  </main>;
}
