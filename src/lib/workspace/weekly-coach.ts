import { isObject } from "./browser-records";

export const weeklyCountKeys = [
  "completed", "undatedCompletions", "openDue", "openUndated", "scheduled", "ideaProgress", "needsFollowUp", "nextFocus", "nextUrgent",
] as const;
export type WeeklyCounts = Record<typeof weeklyCountKeys[number], number>;
export type WeeklyCoachFacts = { weekStart: string; asOf: string; partial: boolean; counts: WeeklyCounts };
export type WeeklyCoachSummary = { reflection: string; nextStep: string };

function dateOnly(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(value + "T12:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed : null;
}

export function parseWeeklyCoachFacts(value: unknown): WeeklyCoachFacts | null {
  if (!isObject(value) || Object.keys(value).length !== 4 || typeof value.partial !== "boolean" || !isObject(value.counts)) return null;
  const start = dateOnly(value.weekStart);
  const asOf = dateOnly(value.asOf);
  if (!start || !asOf || start.getUTCDay() !== 1 || asOf < start || asOf.getTime() - start.getTime() >= 14 * 86400000 ||
    Object.keys(value.counts).length !== weeklyCountKeys.length) return null;
  const counts = {} as WeeklyCounts;
  for (const key of weeklyCountKeys) {
    const count = value.counts[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000) return null;
    counts[key] = count;
  }
  if (counts.nextUrgent > counts.nextFocus) return null;
  return { weekStart: value.weekStart as string, asOf: value.asOf as string, partial: value.partial, counts };
}

export function parseWeeklyCoachSummary(value: unknown): WeeklyCoachSummary | null {
  if (!isObject(value)) return null;
  const valid = (field: unknown): field is string => typeof field === "string" && field.trim().length > 0 && field.length <= 400;
  if (!valid(value.reflection) || !valid(value.nextStep)) return null;
  return { reflection: value.reflection.trim(), nextStep: value.nextStep.trim() };
}
