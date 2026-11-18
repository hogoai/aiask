import { PARTNER_ROLE_ID, type PartnerRole } from "../ai/contracts";
import { dailyQuestionRole } from "../workspace/daily-question";
import type { OwnedSourceObservation, ProactiveCase, SourceSnapshot, TriggerDetection, TriggerType, WorkflowState } from "./contracts";

export const DEADLINE_HORIZON_DAYS = 3;
export const QUESTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const triggerRole = {
  task_needs_clarification: PARTNER_ROLE_ID.guide,
  task_deadline_near: dailyQuestionRole.dueSoon,
  blocker_followup: PARTNER_ROLE_ID.actionPartner,
  followup_due: PARTNER_ROLE_ID.actionPartner,
  source_updated: PARTNER_ROLE_ID.evaluator,
} as const satisfies Record<TriggerType, PartnerRole>;

export class WorkflowError extends Error {
  constructor(readonly code: string) { super(code); this.name = "WorkflowError"; }
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}
export function isDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function isInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
/** Require an explicit UTC/offset time. Browser-local, ambiguous DST times are never silently guessed. */
export function normalizeFollowUpTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !isDateKey(value.slice(0, 10)) || !Number.isFinite(Date.parse(value)) ||
    Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19) || 0) > 59) {
    throw new WorkflowError("invalid_followup_time");
  }
  return new Date(value).toISOString();
}
export function zonedDateKey(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function assertClock(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new WorkflowError("invalid_clock");
}
export function assertOwner(ownerId: string) {
  if (typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 200) throw new WorkflowError("invalid_owner");
}
export function assertObservations(ownerId: string, observations: readonly OwnedSourceObservation[]) {
  assertOwner(ownerId);
  const seen = new Set<string>();
  for (const observation of observations) {
    if (observation.ownerId !== ownerId || observation.ownership !== "verified_owner") throw new WorkflowError("source_owner_unverified");
    const source = observation.source;
    const record = source.record;
    if (!record.id || typeof record.id !== "string" || !["task", "calendar", "idea"].includes(source.type)) throw new WorkflowError("invalid_source");
    if (source.type === "task" && (typeof source.record.title !== "string" ||
      !["Open", "Done"].includes(source.record.status) || (source.record.dueDate !== "" && !isDateKey(source.record.dueDate)))) throw new WorkflowError("invalid_task");
    if (source.type === "calendar" && (typeof source.record.title !== "string" || !isDateKey(source.record.scheduledDate) ||
      (source.record.scheduledTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(source.record.scheduledTime)))) throw new WorkflowError("invalid_calendar");
    if (source.type === "idea" && (typeof source.record.text !== "string" || ![undefined, "Saved", "In progress", "Done"].includes(source.record.status))) throw new WorkflowError("invalid_idea");
    const key = JSON.stringify([source.type, record.id]);
    if (seen.has(key)) throw new WorkflowError("duplicate_source_observation");
    seen.add(key);
  }
}
export function sourceSnapshot({ source }: OwnedSourceObservation): SourceSnapshot {
  if (source.type === "task") {
    const { title, dueDate, status, priority } = source.record;
    return { title, dueDate: dueDate || null, completed: status === "Done", revision: JSON.stringify([title, dueDate, status, priority ?? null]) };
  }
  if (source.type === "idea") {
    const { text, nextStep, status } = source.record;
    return { title: text, dueDate: null, completed: status === "Done", revision: JSON.stringify([text, nextStep ?? null, status ?? "Saved"]) };
  }
  const { title, scheduledDate, scheduledTime } = source.record;
  return { title, dueDate: scheduledDate, completed: false, revision: JSON.stringify([title, scheduledDate, scheduledTime]) };
}
export function isQuotation(title: string) { return /\b(?:quote|quotation)\b/i.test(title); }
export function isTerminal(item: ProactiveCase) { return item.workflowStatus === "resolved" || item.workflowStatus === "dismissed"; }

/** Pure, deterministic detector: no storage, model, wall clock, or business-data writes. */
export function detectTriggers(state: WorkflowState, observations: readonly OwnedSourceObservation[], now: Date): TriggerDetection {
  assertClock(now);
  assertObservations(state.ownerId, observations);
  const triggers: TriggerDetection["triggers"] = [];
  const completedCaseIds: string[] = [];
  const today = Date.parse(zonedDateKey(now, state.settings.timeZone));
  for (const observation of observations) {
    const { source } = observation;
    const snapshot = sourceSnapshot(observation);
    const existing = state.cases.find(item => item.sourceId === source.record.id && item.sourceType === source.type);
    if (snapshot.completed) {
      if (existing && !isTerminal(existing)) completedCaseIds.push(existing.id);
      continue;
    }
    if (existing && isTerminal(existing)) continue;
    const add = (type: TriggerType, identity: unknown, reason: string) => {
      const key = JSON.stringify([source.type, source.record.id, type, identity]);
      if (!existing?.handledTriggers.includes(key)) triggers.push({ sourceType: source.type, sourceId: source.record.id, type, key, reason, snapshot });
    };
    // Reconcile source changes even when proactive prompts are disabled. Do not wake a future snooze.
    if (existing && snapshot.revision !== existing.sourceSnapshot.revision) {
      add("source_updated", existing.sourceVersion + 1, "The linked source changed; the previous question may no longer apply.");
      continue;
    }
    if (!state.settings.enabled) continue;
    if (existing) {
      if (existing.workflowStatus === "snoozed" || existing.workflowStatus === "waiting_for_followup") {
        if (existing.nextFollowUpAt && existing.nextFollowUpAt <= now.toISOString()) {
          add(existing.followUpKind === "blocker" ? "blocker_followup" : "followup_due", existing.nextFollowUpAt,
            existing.followUpKind === "blocker" ? "The agreed follow-up time for a confirmed blocker has arrived." : "The user's selected follow-up or snooze time has arrived.");
        }
        continue;
      }
      if (existing.workflowStatus !== "answered" || !existing.lastAskedAt || now.getTime() - Date.parse(existing.lastAskedAt) < QUESTION_COOLDOWN_MS) continue;
    }
    if (source.type !== "task") continue; // Calendar/Idea contracts are reserved; Phase 1 initial triggers are task-only.
    if (!existing && observation.taskCreated && (!source.record.dueDate || isQuotation(source.record.title))) {
      add("task_needs_clarification", "created", isQuotation(source.record.title)
        ? "A newly created quotation task may need its drawings and technical requirements clarified."
        : "A newly created task has no recorded deadline; clarify the next step and timing.");
      continue;
    }
    if (snapshot.dueDate && Date.parse(snapshot.dueDate) - today <= DEADLINE_HORIZON_DAYS * 86_400_000) {
      add("task_deadline_near", snapshot.dueDate, "The task is overdue or due within three calendar days in the user's time zone.");
    }
  }
  return { triggers, completedCaseIds };
}
