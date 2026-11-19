import { isDateKey, isTimeZone, WorkflowError } from "./rules";

function wallTime(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(entry => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** Resolve a user-entered wall time without relying on the browser/host time zone or guessing across DST. */
export function localFollowUpInstant(value: string, timeZone: string): string {
  if (!isTimeZone(timeZone) || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value) || !isDateKey(value.slice(0, 10))) throw new WorkflowError("invalid_local_followup_time");
  const nominal = Date.parse(value + ":00.000Z");
  const candidates = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = nominal + hours * 3_600_000;
    const offset = Date.parse(wallTime(new Date(sample), timeZone) + ":00.000Z") - sample;
    const candidate = nominal - offset;
    if (wallTime(new Date(candidate), timeZone) === value) candidates.add(candidate);
  }
  if (!candidates.size) throw new WorkflowError("nonexistent_local_time");
  if (candidates.size !== 1) throw new WorkflowError("ambiguous_local_time");
  return new Date([...candidates][0]).toISOString();
}

export function formatWorkflowTime(instant: string, timeZone: string) {
  return new Intl.DateTimeFormat("en", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(instant));
}
