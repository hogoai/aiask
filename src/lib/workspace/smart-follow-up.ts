import { localDateKey, type IdeaRecord, type PlannerData, type Priority } from "./browser-records";
import type { BriefingItem, Candidate } from "./daily-check-in";

export const STALE_AFTER_DAYS = 14;
const PREVIOUS_EVENT_DAYS = 3;

type CalendarItem = BriefingItem & { calendarId: string; date: string };

export function isImportant(priority: Priority | undefined) {
  return priority === "urgent" || priority === "attention";
}

function shiftDays(now: Date, days: number) {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  return date;
}

export function calendarFacts({ events, todos }: PlannerData) {
  const byId = new Map(todos.map(todo => [todo.id, todo]));
  const byEvent = new Map(todos.filter(todo => todo.eventId).map(todo => [todo.eventId, todo]));
  const calendar: CalendarItem[] = [];
  const calendarTodos = new Set<string>();
  const representedTodos = new Set<string>();
  for (const event of events) {
    const linked = (event.todoId ? byId.get(event.todoId) : undefined) ?? byEvent.get(event.id);
    // Older untimed linked entries don't identify which view created them.
    if (event.origin === "task-deadline" ||
      (event.origin !== "calendar" && !event.scheduledTime && (linked || event.todoId))) continue;
    if (linked) {
      calendarTodos.add(linked.id);
      if (linked.dueDate === event.scheduledDate) representedTodos.add(linked.id);
    }
    const date = event.scheduledDate;
    const time = event.scheduledTime ?? undefined;
    calendar.push({
      key: JSON.stringify(["calendar", linked?.id ?? event.id, date, time ?? ""]),
      calendarId: event.id,
      title: event.title, source: "calendar", date, time, priority: linked?.priority ?? event.priority,
      sourceDocumentId: linked?.sourceDocumentId ?? event.sourceDocumentId,
      sourceDocumentTitle: linked?.sourceDocumentTitle ?? event.sourceDocumentTitle,
    });
  }
  return { calendar, calendarTodos, representedTodos };
}

export function recordedTime(value: string | undefined, now: Date) {
  // These timestamps come from explicit local actions. Date-only or future values are not evidence of an update.
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date <= now && date.toISOString() === value ? date : null;
}

export function smartFollowUps(
  planner: PlannerData, ideas: IdeaRecord[], facts: ReturnType<typeof calendarFacts>, now: Date, today: string, horizon: string, currentTime: string,
): Candidate[] {
  const oldestDay = localDateKey(shiftDays(now, -PREVIOUS_EVENT_DAYS));
  const staleBefore = shiftDays(now, -STALE_AFTER_DAYS);
  const results: Candidate[] = [];
  const byStartTime = new Map<string, CalendarItem[]>();

  for (const item of facts.calendar) {
    const { date, time } = item;
    if (date < today && date >= oldestDay) {
      results.push({ ...item, key: JSON.stringify(["calendar-follow-up", item.calendarId, date, time ?? ""]), kind: "calendarFollowUp", family: "calendar" });
    }
    if (!time || date < today || date > horizon || (date === today && time < currentTime)) continue;
    const slot = date + "T" + time;
    const entries = byStartTime.get(slot);
    if (entries) entries.push(item);
    else byStartTime.set(slot, [item]);
  }

  for (const [slot, entries] of byStartTime) {
    if (entries.length < 2) continue;
    // Keep the question's identity stable when calendar rows are in a different order.
    const unique = [...new Map(entries.map(entry => [entry.key, entry])).values()];
    if (unique.length < 2) continue;
    unique.sort((a, b) => a.calendarId.localeCompare(b.calendarId));
    const [first, ...others] = unique;
    results.push({
      ...first, key: JSON.stringify(["calendar-conflict", slot]), relatedTitles: others.map(item => item.title),
      priority: unique.some(item => item.priority === "urgent") ? "urgent" : unique.some(item => item.priority === "attention") ? "attention" : undefined,
      kind: "calendarConflict", family: "calendar",
    });
  }

  const ideasWithActions = new Set<string>();
  for (const todo of planner.todos) {
    if (facts.calendarTodos.has(todo.id)) continue;
    if (todo.ideaId) ideasWithActions.add(todo.ideaId);
    // A deadline prompt already accounts for this task inside the briefing window.
    if (todo.status !== "Open" || !isImportant(todo.priority) || (todo.dueDate && todo.dueDate <= horizon)) continue;
    const updated = recordedTime(todo.updatedAt, now);
    if (!updated || updated > staleBefore) continue;
    results.push({
      key: JSON.stringify(["task-stale", todo.id, todo.updatedAt]), title: todo.title, source: "todos",
      date: localDateKey(updated), dateMeaning: "lastUpdate", priority: todo.priority, kind: "staleTodo", family: "deadline",
      sourceDocumentId: todo.sourceDocumentId, sourceDocumentTitle: todo.sourceDocumentTitle,
    });
  }

  for (const idea of ideas) {
    if (idea.status === "Done") continue;
    const hasPlan = Boolean(idea.nextStep?.trim()) || ideasWithActions.has(idea.id);
    if (hasPlan && !idea.progressUpdatedAt?.trim()) {
      results.push({ key: JSON.stringify(["idea-plan", idea.id]), title: idea.text, source: "inbox", kind: "ideaPlanNoProgress", family: "idea" });
      continue;
    }
    if (idea.status !== "In progress") continue;
    if (!hasPlan) {
      results.push({ key: JSON.stringify(["idea", idea.id]), title: idea.text, source: "inbox", kind: "missingNextStep", family: "idea" });
      continue;
    }
    const progress = recordedTime(idea.progressUpdatedAt, now);
    const edit = recordedTime(idea.updatedAt, now);
    if (!progress || (idea.updatedAt && !edit)) continue;
    const latest = edit && edit > progress ? edit : progress;
    if (latest > staleBefore) continue;
    results.push({
      key: JSON.stringify(["idea-stale", idea.id, latest.toISOString()]), title: idea.text, source: "inbox",
      date: localDateKey(latest), dateMeaning: "lastUpdate", kind: "staleIdea", family: "idea",
    });
  }
  return results;
}
