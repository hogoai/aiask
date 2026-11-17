import { localDateKey, type IdeaStatus, type Priority, type WorkspaceRecords } from "./browser-records";
import { calendarFacts, isImportant, recordedTime, smartFollowUps } from "./smart-follow-up";
import type { WeeklyCoachFacts } from "./weekly-coach";

export type ReviewPeriod = "current" | "previous";
export type ReviewKind = "completed" | "openDue" | "openUndated" | "scheduled" | "ideaProgress" | "staleTodo" | "staleIdea" | "ideaPlanNoProgress" |
  "nextTask" | "nextEvent" | "carryOver";
export type ReviewItem = {
  key: string;
  kind: ReviewKind;
  source: "todos" | "calendar" | "inbox";
  title: string;
  date?: string;
  time?: string;
  priority?: Priority;
  ideaStatus?: IdeaStatus;
  nextStep?: string;
};

function shiftLocalDay(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function weeklyReviewRange(now: Date, period: ReviewPeriod) {
  const midday = new Date(now);
  midday.setHours(12, 0, 0, 0);
  const weekday = (midday.getDay() + 6) % 7;
  const start = shiftLocalDay(midday, -weekday - (period === "previous" ? 7 : 0));
  const range = (offset: number) => ({
    start: localDateKey(shiftLocalDay(start, offset)),
    last: localDateKey(shiftLocalDay(start, offset + 6)),
    endExclusive: localDateKey(shiftLocalDay(start, offset + 7)),
  });
  return { week: range(0), following: range(7) };
}

const sortByDate = (a: ReviewItem, b: ReviewItem) => (a.date ?? "").localeCompare(b.date ?? "") ||
  (a.time ?? "").localeCompare(b.time ?? "") || a.key.localeCompare(b.key);
const priorityRank = { urgent: 0, attention: 1, onTrack: 2 } as const;

export function buildWeeklyReview(records: WorkspaceRecords, now: Date, period: ReviewPeriod) {
  const { week, following } = weeklyReviewRange(now, period);
  const asOf = localDateKey(now);
  const planner = records.planner.data;
  const facts = calendarFacts(planner);
  const inRange = (date: string, range: typeof week) => date >= range.start && date < range.endExclusive;
  const dateOf = (value: string | undefined) => {
    const time = recordedTime(value, now);
    return time ? localDateKey(time) : null;
  };
  const completed: ReviewItem[] = [];
  const openDue: ReviewItem[] = [];
  const upcoming: ReviewItem[] = [];
  let undatedCompletions = 0;
  let openUndated = 0;
  for (const task of planner.todos) {
    if (facts.calendarTodos.has(task.id)) continue;
    const item = { key: task.id, source: "todos", title: task.title, priority: task.priority } as const;
    if (task.status === "Done") {
      const date = dateOf(task.completedAt);
      if (!date) undatedCompletions++;
      else if (inRange(date, week)) completed.push({ ...item, kind: "completed", date });
      continue;
    }
    if (!task.dueDate) {
      openUndated++;
      openDue.push({ ...item, kind: "openUndated" });
      continue;
    }
    const date = task.dueDate;
    if (date < week.endExclusive) openDue.push({ ...item, kind: "openDue", date });
    if (inRange(date, following)) upcoming.push({ ...item, kind: "nextTask", date });
    else if (date < following.start && isImportant(task.priority)) upcoming.push({ ...item, kind: "carryOver", date });
  }

  const scheduled: ReviewItem[] = [];
  const seenEvents = new Set<string>();
  for (const event of facts.calendar) {
    if (seenEvents.has(event.key)) continue;
    seenEvents.add(event.key);
    const item = { key: event.key, source: "calendar", title: event.title, date: event.date, time: event.time, priority: event.priority } as const;
    if (inRange(event.date, week)) scheduled.push({ ...item, kind: "scheduled" });
    if (inRange(event.date, following) && isImportant(event.priority)) upcoming.push({ ...item, kind: "nextEvent" });
  }

  const ideaProgress: ReviewItem[] = [];
  for (const idea of records.ideas.data) {
    const date = dateOf(idea.progressUpdatedAt);
    if (date && inRange(date, week)) ideaProgress.push({
      key: idea.id, kind: "ideaProgress", source: "inbox", title: idea.text, date, ideaStatus: idea.status ?? "Saved", nextStep: idea.nextStep?.trim() || undefined,
    });
  }
  const horizon = localDateKey(shiftLocalDay(now, 3));
  const currentTime = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const needsFollowUp: ReviewItem[] = [];
  for (const item of smartFollowUps(planner, records.ideas.data, facts, now, asOf, horizon, currentTime)) {
    if (item.kind === "staleTodo" || item.kind === "staleIdea" || item.kind === "ideaPlanNoProgress") {
      needsFollowUp.push({ key: item.key, source: item.source, title: item.title, date: item.date, priority: item.priority, kind: item.kind });
    }
  }
  const next = upcoming.sort((a, b) => priorityRank[a.priority ?? "onTrack"] - priorityRank[b.priority ?? "onTrack"] || sortByDate(a, b));
  const groups = {
    completed: completed.sort((a, b) => sortByDate(b, a)),
    openDue: openDue.sort((a, b) => Number(!a.date) - Number(!b.date) || sortByDate(a, b)),
    needsFollowUp: needsFollowUp.sort(sortByDate),
    scheduled: scheduled.sort(sortByDate),
    ideaProgress: ideaProgress.sort((a, b) => sortByDate(b, a)),
    nextFocus: next,
  };
  const summaryFacts: WeeklyCoachFacts = {
    weekStart: week.start, asOf, partial: records.planner.incomplete || records.ideas.incomplete,
    counts: {
      completed: completed.length, undatedCompletions, openDue: openDue.length - openUndated, openUndated, scheduled: scheduled.length,
      ideaProgress: ideaProgress.length, needsFollowUp: needsFollowUp.length, nextFocus: next.length, nextUrgent: next.filter(item => item.priority === "urgent").length,
    },
  };
  return { week, following, asOf, groups, summaryFacts };
}
