export const IDEA_KEY = "aiask-idea-box";
export const PLANNER_KEY = "aiask-planner";

export type IdeaStatus = "Saved" | "In progress" | "Done";
export type Priority = "urgent" | "attention" | "onTrack";
export type IdeaRecord = { id: string; text: string; createdAt: string; updatedAt?: string; status?: IdeaStatus; nextStep?: string; progressUpdatedAt?: string };
export type CalendarOrigin = "calendar" | "task-deadline";
export type PlannerEvent = { ownerId?: string; completed?: boolean; id: string; ideaId: string | null; todoId: string | null; title: string; scheduledDate: string; scheduledTime: string | null; priority?: Priority; origin?: CalendarOrigin };
export type PlannerTodo = { ownerId?: string; originConversationId?: string; id: string; ideaId: string | null; eventId: string | null; title: string; dueDate: string; status: "Open" | "Done"; priority?: Priority; completedAt?: string; updatedAt?: string };
export type PlannerData = { events: PlannerEvent[]; todos: PlannerTodo[] };
type Read<T> = { data: T; incomplete: boolean };
export type WorkspaceRecords = { ideas: Read<IdeaRecord[]>; planner: Read<PlannerData> };

export const emptyPlanner: PlannerData = { events: [], todos: [] };
export const emptyIdeas: IdeaRecord[] = [];

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function localDateKey(value: Date) {
  return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, "0"), String(value.getDate()).padStart(2, "0")].join("-");
}

function dateKey(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  return localDateKey(new Date(value + "T12:00:00")) === value ? value : "";
}

function optionalText(value: unknown) { return typeof value === "string" ? value : undefined; }
function priority(value: unknown): Priority | undefined {
  return value === "urgent" || value === "attention" || value === "onTrack" ? value : undefined;
}

function readIdea(value: unknown): IdeaRecord | null {
  if (!isObject(value) || typeof value.id !== "string" || !value.id || typeof value.text !== "string" || typeof value.createdAt !== "string") return null;
  const { id, text, createdAt, status } = value;
  if (status !== undefined && status !== "Saved" && status !== "In progress" && status !== "Done") return null;
  if ([value.updatedAt, value.nextStep, value.progressUpdatedAt].some(field => field != null && typeof field !== "string")) return null;
  return { id, text, createdAt, status, updatedAt: optionalText(value.updatedAt), nextStep: optionalText(value.nextStep), progressUpdatedAt: optionalText(value.progressUpdatedAt) };
}

function readEvent(value: unknown): PlannerEvent | null {
  if (!isObject(value) || typeof value.id !== "string" || !value.id || typeof value.title !== "string") return null;
  const scheduledDate = dateKey(value.scheduledDate);
  const time = value.scheduledTime;
  if (!scheduledDate || (time != null && (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)))) return null;
  const origin = value.origin === "calendar" || value.origin === "task-deadline" ? value.origin : undefined;
  return { ownerId: optionalText(value.ownerId), completed: typeof value.completed === "boolean" ? value.completed : undefined, id: value.id, title: value.title, scheduledDate, scheduledTime: typeof time === "string" ? time : null, todoId: optionalText(value.todoId) ?? null, ideaId: optionalText(value.ideaId) ?? null, priority: priority(value.priority), origin };
}

function readTodo(value: unknown): PlannerTodo | null {
  if (!isObject(value) || typeof value.id !== "string" || !value.id || typeof value.title !== "string" || (value.status !== "Open" && value.status !== "Done")) return null;
  const dueDate = dateKey(value.dueDate);
  if (value.dueDate && !dueDate) return null;
  return { ownerId: optionalText(value.ownerId), originConversationId: optionalText(value.originConversationId), id: value.id, title: value.title, dueDate, status: value.status, eventId: optionalText(value.eventId) ?? null, ideaId: optionalText(value.ideaId) ?? null, priority: priority(value.priority), completedAt: optionalText(value.completedAt), updatedAt: optionalText(value.updatedAt) };
}

function readRows<T extends { id: string }>(value: unknown, read: (row: unknown) => T | null): Read<T[]> {
  const data: T[] = [];
  if (!Array.isArray(value)) return { data, incomplete: true };
  const seen = new Set<string>();
  for (const entry of value) {
    const row = read(entry);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    data.push(row);
  }
  return { data, incomplete: data.length !== value.length };
}

export function readWorkspaceRecords(storage: Pick<Storage, "getItem">): WorkspaceRecords {
  const ideas: Read<IdeaRecord[]> = { data: emptyIdeas, incomplete: false };
  const planner: Read<PlannerData> = { data: emptyPlanner, incomplete: false };
  const records = { ideas, planner };
  try {
    const raw = storage.getItem(IDEA_KEY);
    if (raw !== null) records.ideas = readRows(JSON.parse(raw), readIdea);
  } catch { ideas.incomplete = true; }
  try {
    const raw = storage.getItem(PLANNER_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) planner.incomplete = true;
      else {
        const events = readRows(parsed.events, readEvent);
        const todos = readRows(parsed.todos, readTodo);
        records.planner = { data: { events: events.data, todos: todos.data }, incomplete: events.incomplete || todos.incomplete };
      }
    }
  } catch { planner.incomplete = true; }
  return records;
}

// The existing manual toggle must write back the original storage shape, never the briefing's projection.
export function toggleStoredTodo(storage: Pick<Storage, "getItem" | "setItem">, id: string) {
  const raw = storage.getItem(PLANNER_KEY);
  const parsed: unknown = raw === null ? null : JSON.parse(raw);
  if (!isObject(parsed) || !Array.isArray(parsed.todos) || !Array.isArray(parsed.events)) return false;
  const matches = parsed.todos.filter(row => isObject(row) && row.id === id);
  if (matches.length !== 1 || !readTodo(matches[0])) return false;
  const row = matches[0];
  const isDone = row.status === "Done";
  const now = new Date().toISOString();
  const todos = parsed.todos.map(item => item === row ? { ...row, status: isDone ? "Open" : "Done", completedAt: isDone ? undefined : now, updatedAt: now } : item);
  storage.setItem(PLANNER_KEY, JSON.stringify({ ...parsed, todos }));
  return true;
}
