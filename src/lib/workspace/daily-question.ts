import { PARTNER_ROLE_ID } from "../ai/contracts";

export const dailyQuestionKinds = [
  "overdue", "dueToday", "dueSoon", "importantEvent", "missingNextStep",
  "calendarConflict", "calendarFollowUp", "staleTodo", "ideaPlanNoProgress", "staleIdea",
] as const;
export type DailyQuestionKind = typeof dailyQuestionKinds[number];
export const dailyQuestionRole = {
  overdue: PARTNER_ROLE_ID.actionPartner,
  dueToday: PARTNER_ROLE_ID.actionPartner,
  dueSoon: PARTNER_ROLE_ID.actionPartner,
  importantEvent: PARTNER_ROLE_ID.planner,
  missingNextStep: PARTNER_ROLE_ID.guide,
  calendarConflict: PARTNER_ROLE_ID.planner,
  calendarFollowUp: PARTNER_ROLE_ID.actionPartner,
  staleTodo: PARTNER_ROLE_ID.actionPartner,
  ideaPlanNoProgress: PARTNER_ROLE_ID.evaluator,
  staleIdea: PARTNER_ROLE_ID.evaluator,
} as const satisfies Record<DailyQuestionKind, string>;

export function isDailyQuestionKind(value: unknown): value is DailyQuestionKind {
  return typeof value === "string" && (dailyQuestionKinds as readonly string[]).includes(value);
}

export function isShortQuestion(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length <= 160 &&
    /^[^\s?!？！。.\n\r<>][^?!？！。.\n\r<>]*[?？]$/u.test(value);
}
