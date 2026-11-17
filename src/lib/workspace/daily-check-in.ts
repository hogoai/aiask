import { isObject, localDateKey, type Priority, type WorkspaceRecords } from "./browser-records";
import { isDailyQuestionKind, isShortQuestion, type DailyQuestionKind } from "./daily-question";
import { isAppLocale, type AppLocale } from "../../i18n/config";
import { calendarFacts, isImportant, smartFollowUps } from "./smart-follow-up";

export type BriefingItem = { key: string; title: string; source: "todos" | "calendar" | "inbox"; date?: string; time?: string; priority?: Priority; kind?: DailyQuestionKind; relatedTitles?: string[]; dateMeaning?: "lastUpdate" };
export type Candidate = BriefingItem & { kind: DailyQuestionKind; family: "deadline" | "calendar" | "idea" };

const priorityRank = { urgent: 0, attention: 1, onTrack: 2 } as const;
const kindRank: Record<DailyQuestionKind, number> = {
  calendarConflict: 0, overdue: 1, dueToday: 2, importantEvent: 2, dueSoon: 3,
  calendarFollowUp: 4, staleTodo: 5, ideaPlanNoProgress: 6, staleIdea: 7, missingNextStep: 8,
};
const rank = (item: BriefingItem) => priorityRank[item.priority ?? "onTrack"];
const compareDate = (a: BriefingItem, b: BriefingItem) => (a.date ?? "").localeCompare(b.date ?? "") || (a.time ?? "").localeCompare(b.time ?? "") || a.key.localeCompare(b.key);

export function buildDailyCheckIn(records: WorkspaceRecords, now: Date) {
  const today = localDateKey(now);
  const currentTime = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const end = new Date(now);
  end.setDate(end.getDate() + 3);
  const horizon = localDateKey(end);
  const planner = records.planner.data;
  const facts = calendarFacts(planner);
  const scheduled: BriefingItem[] = [];
  const dueSoon: BriefingItem[] = [];
  const candidates: Candidate[] = [];
  for (const item of facts.calendar) {
    const { date, time } = item;
    if (date === today && isImportant(item.priority)) scheduled.push(item);
    if (date > today && date <= horizon && isImportant(item.priority)) dueSoon.push(item);
    if (date <= horizon && date >= today && isImportant(item.priority) &&
      (date > today || !time || time >= currentTime)) {
      candidates.push({ ...item, kind: "importantEvent", family: "calendar" });
    }
  }

  const dueToday: BriefingItem[] = [];
  const followUps = smartFollowUps(planner, records.ideas.data, facts, now, today, horizon, currentTime);
  for (const todo of planner.todos) {
    if (todo.status !== "Open" || !todo.dueDate || todo.dueDate > horizon || facts.representedTodos.has(todo.id)) continue;
    const date = todo.dueDate;
    const key = JSON.stringify(["deadline", todo.id, date]);
    const item: BriefingItem = { key, title: todo.title, source: "todos", date, priority: todo.priority };
    const kind = date < today ? "overdue" : date === today ? "dueToday" : "dueSoon";
    if (kind === "overdue") followUps.push({ ...item, kind, family: "deadline" });
    else {
      (kind === "dueToday" ? dueToday : dueSoon).push(item);
      candidates.push({ ...item, kind, family: "deadline" });
    }
  }

  const ordered = (items: BriefingItem[]) => items.sort((a, b) => rank(a) - rank(b) || compareDate(a, b));
  const weight = (item: Candidate) => item.kind === "importantEvent" && item.date !== today ? kindRank.dueSoon : kindRank[item.kind];
  const compare = (a: Candidate, b: Candidate) => weight(a) - weight(b) || rank(a) - rank(b) ||
    (a.kind === "calendarFollowUp" && b.kind === "calendarFollowUp" ? compareDate(b, a) : compareDate(a, b));
  candidates.push(...followUps);
  candidates.sort(compare);
  followUps.sort(compare);
  return { today, dueToday: ordered(dueToday), scheduled: ordered(scheduled), dueSoon: ordered(dueSoon), followUps, candidates };
}

type DailyAnswer = { text: string; at: number; kind: DailyQuestionKind };
export const MAX_DAILY_ANSWER_LENGTH = 1000;

type QuestionEntry = {
  status: "pending" | "answered" | "snoozed" | "dismissed";
  snoozedUntil?: number;
  aiAttempted?: boolean;
  answer?: DailyAnswer;
  wording?: { locale: AppLocale; kind: DailyQuestionKind; question: string };
};

export type DailyState = {
  version: 1;
  localDataAllowed: boolean;
  enabled: boolean;
  muted: Candidate["family"][];
  lastNewDay?: string;
  lastAiDay?: string;
  questions: Record<string, QuestionEntry>;
};

export function emptyDailyState(demo: boolean): DailyState {
  return { version: 1, localDataAllowed: demo, enabled: true, muted: [], questions: {} };
}

export function decodeDailyState(raw: string | null, demo: boolean): DailyState {
  if (raw === null) return emptyDailyState(demo);
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || value.version !== 1 || typeof value.enabled !== "boolean" || typeof value.localDataAllowed !== "boolean" ||
    !Array.isArray(value.muted) || !isObject(value.questions)) throw new Error("Invalid daily check-in storage");
  const state: DailyState = {
    ...emptyDailyState(demo), localDataAllowed: value.localDataAllowed, enabled: value.enabled,
    muted: value.muted.filter((kind): kind is Candidate["family"] => kind === "deadline" || kind === "calendar" || kind === "idea"),
    lastNewDay: typeof value.lastNewDay === "string" ? value.lastNewDay : undefined,
    lastAiDay: typeof value.lastAiDay === "string" ? value.lastAiDay : undefined,
  };
  for (const [key, entry] of Object.entries(value.questions)) {
    if (!key.startsWith("[") || !isObject(entry) || (entry.status !== "pending" && entry.status !== "answered" && entry.status !== "snoozed" && entry.status !== "dismissed")) continue;
    const wording = entry.wording;
    const answer = entry.answer;
    state.questions[key] = {
      status: entry.status,
      snoozedUntil: typeof entry.snoozedUntil === "number" ? entry.snoozedUntil : undefined,
      aiAttempted: entry.aiAttempted === true,
      answer: entry.status === "answered" && isObject(answer) && typeof answer.text === "string" && answer.text.trim() &&
        answer.text.length <= MAX_DAILY_ANSWER_LENGTH && typeof answer.at === "number" && Number.isFinite(answer.at) &&
        Math.abs(answer.at) <= 8.64e15 && isDailyQuestionKind(answer.kind)
        ? { text: answer.text, at: answer.at, kind: answer.kind } : undefined,
      wording: isObject(wording) && isAppLocale(wording.locale) && isDailyQuestionKind(wording.kind) && isShortQuestion(wording.question)
        ? { locale: wording.locale, kind: wording.kind, question: wording.question } : undefined,
    };
  }
  return state;
}

export function saveDailyAnswer(state: DailyState, candidate: Candidate, text: string, now: number): DailyState {
  const entry = state.questions[candidate.key];
  const answer = text.trim();
  if (!state.localDataAllowed || !state.enabled || state.muted.includes(candidate.family) || entry?.status !== "pending" ||
    !answer || answer.length > MAX_DAILY_ANSWER_LENGTH || !Number.isFinite(now)) return state;
  return {
    ...state, questions: {
      ...state.questions,
      [candidate.key]: { ...entry, status: "answered", snoozedUntil: undefined, answer: { text: answer, at: now, kind: candidate.kind } },
    },
  };
}

export function recordedDailyAnswers(state: DailyState | null) {
  return Object.entries(state?.questions ?? {}).flatMap(([key, entry]) => entry.status === "answered" && entry.answer ? [{ key, ...entry.answer }] : [])
    .sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

export function activeQuestion(state: DailyState, candidates: Candidate[]) {
  if (!state.localDataAllowed || !state.enabled) return undefined;
  return candidates.find(item => !state.muted.includes(item.family) && state.questions[item.key]?.status === "pending");
}

export function advanceDailyState(state: DailyState, candidates: Candidate[], today: string, now: number): DailyState {
  if (!state.localDataAllowed || !state.enabled || activeQuestion(state, candidates)) return state;
  const eligible = candidates.filter(item => !state.muted.includes(item.family));
  const snoozed = eligible.find(item => {
    const entry = state.questions[item.key];
    return entry?.status === "snoozed" && (entry.snoozedUntil ?? Infinity) <= now;
  });
  if (snoozed) {
    return { ...state, questions: { ...state.questions, [snoozed.key]: { ...state.questions[snoozed.key], status: "pending", snoozedUntil: undefined } } };
  }
  const next = state.lastNewDay === today ? undefined : eligible.find(item => !state.questions[item.key]);
  return next ? { ...state, lastNewDay: today, questions: { ...state.questions, [next.key]: { status: "pending" } } } : state;
}
