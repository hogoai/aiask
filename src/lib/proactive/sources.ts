import type { AIConversation } from "../ai/conversations";
import { isObject, PLANNER_KEY, readWorkspaceRecords, type PlannerTodo, type WorkspaceRecords } from "../workspace/browser-records";
import type { OwnedSourceObservation, ReviewedTaskSource, TeamSource, WorkflowSource, WorkflowState } from "./contracts";
import { advanceWorkflows, applyWorkflowCommand } from "./engine";
import { isInstant, taskSnapshot, WorkflowError } from "./rules";

export type TaskReview = { record: PlannerTodo; revision: string };
export type TaskSourceView = {
  sourceId: string;
  title: string;
  status: "current" | "changed" | "completed" | "missing" | "unavailable";
  type?: WorkflowSource["type"];
};
type Reader = Pick<Storage, "getItem">;

export function readBrowserTasksForReview(storage: Reader): PlannerTodo[] {
  // Do not read Idea Box or any other account/feature's storage.
  const result = readWorkspaceRecords({ getItem: key => key === PLANNER_KEY ? storage.getItem(key) : null }).planner;
  if (result.incomplete) throw new WorkflowError("browser_tasks_unavailable");
  return result.data.todos;
}

function normalizedTask(value: unknown): PlannerTodo | null {
  if (!isObject(value)) return null;
  try {
    const parsed = readWorkspaceRecords({ getItem: key => key === PLANNER_KEY ? JSON.stringify({ events: [], todos: [value] }) : null }).planner;
    return parsed.incomplete ? null : parsed.data.todos[0] ?? null;
  } catch { return null; }
}

export function isReviewedTaskSource(value: unknown, ownerId: string): value is ReviewedTaskSource {
  if (!isObject(value) || value.ownerId !== ownerId || typeof value.approvalId !== "string" || !value.approvalId || !isInstant(value.approvedAt)) return false;
  if (value.provenance !== undefined && value.provenance !== "user_reviewed" && value.provenance !== "user_created") return false;
  const record = normalizedTask(value.record);
  return Boolean(record && value.revision === taskSnapshot(record).revision);
}

/** User approval is an attestation about this exact snapshot, not a new ownership field on legacy data. */
export function approveTaskSnapshot(ownerId: string, review: TaskReview, now: Date): ReviewedTaskSource {
  const record = normalizedTask(review.record);
  if (!record || taskSnapshot(record).revision !== review.revision) throw new WorkflowError("invalid_task_review");
  return { ownerId, record, revision: review.revision, approvalId: crypto.randomUUID(), approvedAt: now.toISOString(), provenance: "user_reviewed" };
}

export function ownedTaskObservation(source: ReviewedTaskSource): OwnedSourceObservation {
  return { ownerId: source.ownerId, ownership: "verified_owner", source: { type: "task", record: { ...source.record } }, taskCreated: source.provenance === "user_created" };
}

export function plannerObservations(ownerId: string, records: WorkspaceRecords, trackedCalendarIds: ReadonlySet<string>): OwnedSourceObservation[] {
  if (records.planner.incomplete) throw new WorkflowError("planner_unavailable");
  const { todos, events } = records.planner.data;
  const calendar = events.filter(event => trackedCalendarIds.has(event.id) && event.ownerId === ownerId && event.origin !== "task-deadline");
  const observations: OwnedSourceObservation[] = calendar.map(event => ({
    ownerId, ownership: "verified_owner",
    source: { type: "calendar", record: { ...event, completed: todos.some(todo => todo.ownerId === ownerId && todo.id === event.todoId && todo.status === "Done") } },
  }));
  return observations;
}

export function adoptPlannerItem(storage: Pick<Storage, "getItem" | "setItem">, ownerId: string, type: "task" | "calendar", id: string) {
  if (readWorkspaceRecords(storage).planner.incomplete) throw new WorkflowError("planner_unavailable");
  const raw = storage.getItem(PLANNER_KEY);
  const data: unknown = raw ? JSON.parse(raw) : null;
  if (!isObject(data) || !Array.isArray(data.todos) || !Array.isArray(data.events)) throw new WorkflowError("planner_unavailable");
  const rows = type === "task" ? data.todos : data.events;
  const matches = rows.filter(row => isObject(row) && row.id === id);
  if (matches.length !== 1) throw new WorkflowError("source_unavailable");
  const selected = matches[0] as Record<string, unknown>;
  const todoIds = new Set<string>();
  const eventIds = new Set<string>();
  if (type === "task") todoIds.add(id);
  else if (typeof selected.todoId === "string") todoIds.add(selected.todoId);
  if (type === "calendar") eventIds.add(id);
  else if (typeof selected.eventId === "string") eventIds.add(selected.eventId);
  const related = [
    ...data.todos.filter(row => isObject(row) &&
      ((typeof row.id === "string" && todoIds.has(row.id)) || (typeof row.eventId === "string" && eventIds.has(row.eventId)))),
    ...data.events.filter(row => isObject(row) &&
      ((typeof row.id === "string" && eventIds.has(row.id)) || (typeof row.todoId === "string" && todoIds.has(row.todoId)))),
  ];
  if (related.some(row => isObject(row) && row.ownerId && row.ownerId !== ownerId)) throw new WorkflowError("source_owned_by_another_account");
  const tag = (row: unknown) => related.includes(row) && isObject(row) ? { ...row, ownerId } : row;
  storage.setItem(PLANNER_KEY, JSON.stringify({ ...data, todos: data.todos.map(tag), events: data.events.map(tag) }));
}

export function teamSourceFromConversation(conversation: AIConversation): TeamSource {
  const reply = conversation.messages.filter(message => message.role === "assistant" && message.kind === "structured_response" && message.status === "completed").at(-1);
  const structured = reply?.metadata?.structuredResponse;
  const nextStep = isObject(structured) && typeof structured.nextStep === "string" ? structured.nextStep : "";
  return { type: "conversation", record: {
    id: conversation.id, title: conversation.title, partnerRole: conversation.partnerRole,
    nextStep: nextStep.slice(0, 4000), perspective: (reply?.content ?? "").slice(0, 5000),
  } };
}

export function connectTeamSource(state: WorkflowState, source: TeamSource, now: Date): WorkflowState {
  const teamSources = [...(state.teamSources ?? []).filter(entry => entry.record.id !== source.record.id), source];
  if (state.cases.some(item => item.sourceType !== "conversation" && item.conversationId === source.record.id)) return { ...state, teamSources };
  let next = advanceWorkflows({ ...state, teamSources }, [{ ownerId: state.ownerId, ownership: "verified_owner", trackingRequested: true, source }], now);
  next = { ...next, cases: next.cases.map(item => item.sourceType === "conversation" && item.sourceId === source.record.id && !item.conversationId
    ? { ...item, assignedRoleId: source.record.partnerRole } : item) };
  const item = next.cases.find(entry => entry.sourceType === "conversation" && entry.sourceId === source.record.id);
  if (item && !item.conversationId && !["resolved", "dismissed"].includes(item.workflowStatus)) {
    next = applyWorkflowCommand(next, { type: "link_conversation", caseId: item.id, conversationId: source.record.id }, now);
  }
  return next;
}

export function transferTeamCasesToTasks(state: WorkflowState, observations: readonly OwnedSourceObservation[]): WorkflowState {
  const activeTeamCases = state.cases.map(item => {
    if (item.sourceType !== "conversation" || ["resolved", "dismissed"].includes(item.workflowStatus)) return item;
    const task = observations.find(entry => entry.source.type === "task" && entry.source.record.originConversationId === item.sourceId)?.source;
    if (task?.type !== "task" || state.cases.some(other => other.sourceType === "task" && other.sourceId === task.record.id)) return item;
    return { ...item, sourceType: "task" as const, sourceId: task.record.id };
  });
  return activeTeamCases.every((item, index) => item === state.cases[index]) ? state : { ...state, cases: activeTeamCases };
}

/** Never returns changed source text. Only approved snapshots and a completion signal can reach the engine. */
export function inspectTaskSources(state: WorkflowState, storage: Reader): { views: TaskSourceView[]; observations: OwnedSourceObservation[] } {
  const sources = state.taskSources ?? [];
  if (!sources.length) return { views: [], observations: [] };
  let tasks: PlannerTodo[];
  try { tasks = readBrowserTasksForReview(storage); }
  catch { return { views: sources.map(source => ({ sourceId: source.record.id, title: source.record.title, status: "unavailable", type: "task" })), observations: [] }; }
  const views: TaskSourceView[] = [];
  const observations: OwnedSourceObservation[] = [];
  for (const source of sources) {
    const current = tasks.find(task => task.id === source.record.id);
    let status: TaskSourceView["status"] = "missing";
    if (current?.status === "Done") {
      status = "completed";
      // Completion can stop follow-up, but cannot import an unreviewed title, deadline, priority or notes.
      observations.push(ownedTaskObservation({ ...source, record: { ...source.record, status: "Done" } }));
    } else if (current) {
      status = taskSnapshot(current).revision === source.revision ? "current" : "changed";
      if (status === "current") observations.push(ownedTaskObservation(source));
    }
    views.push({ sourceId: source.record.id, title: source.record.title, status, type: "task" });
  }
  return { views, observations };
}
