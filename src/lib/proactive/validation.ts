import { PARTNER_ROLE_IDS } from "../ai/contracts";
import { isObject } from "../workspace/browser-records";
import { TRIGGER_TYPES, WORKFLOW_STATUSES, type ProactiveCase, type WorkflowState, type WorkflowStatus } from "./contracts";
import { ALLOWED_TRANSITIONS } from "./engine";
import { isDateKey, isInstant, isTimeZone } from "./rules";

const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const nullableInstant = (value: unknown) => value === null || isInstant(value);
const nullableText = (value: unknown) => value === null || text(value);
const member = (values: readonly unknown[], value: unknown) => values.includes(value);
function rows(value: unknown, check: (row: Record<string, unknown>) => boolean): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(row => isObject(row) && check(row));
}
const uniqueIds = (values: Record<string, unknown>[]) => new Set(values.map(row => row.id)).size === values.length;
function question(value: unknown): value is Record<string, unknown> {
  return isObject(value) && text(value.id) && text(value.text) && value.text.length <= 500 && isInstant(value.askedAt) &&
    text(value.triggerKey) && text(value.sourceRevision) && nullableInstant(value.invalidatedAt);
}

function validCase(value: unknown, ownerId: string): value is ProactiveCase {
  if (!isObject(value) || !text(value.id) || value.ownerId !== ownerId || !member(["task", "calendar", "idea"], value.sourceType) ||
    !text(value.sourceId) || !Number.isInteger(value.sourceVersion) || (value.sourceVersion as number) < 1 ||
    !member(TRIGGER_TYPES, value.triggerType) || !text(value.triggerKey) || !text(value.triggerReason) ||
    !Array.isArray(value.handledTriggers) || !value.handledTriggers.every(text) || !value.handledTriggers.includes(value.triggerKey) ||
    new Set(value.handledTriggers).size !== value.handledTriggers.length || !member(PARTNER_ROLE_IDS, value.assignedRoleId) ||
    !member(WORKFLOW_STATUSES, value.workflowStatus) || !nullableInstant(value.nextFollowUpAt) ||
    !member([null, "blocker", "user_requested"], value.followUpKind) || !nullableInstant(value.lastAskedAt) || !nullableInstant(value.lastAnsweredAt) ||
    !nullableText(value.conversationId) || !isInstant(value.createdAt) || !isInstant(value.updatedAt)) return false;
  const source = value.sourceSnapshot;
  if (!isObject(source) || typeof source.title !== "string" || !(source.dueDate === null || isDateKey(source.dueDate)) ||
    typeof source.completed !== "boolean" || !text(source.revision)) return false;
  const memory = value.memory;
  if (!isObject(memory) ||
    !rows(memory.questions, question) || !uniqueIds(memory.questions) ||
    !rows(memory.answers, row => text(row.id) && text(row.questionId) && text(row.text) && row.text.length <= 4000 && isInstant(row.answeredAt)) || !uniqueIds(memory.answers) ||
    !rows(memory.inferences, row => text(row.id) && text(row.answerId) && member(["blocker", "fact"], row.kind) && text(row.text) && row.text.length <= 1000 &&
      member(["rule", "ai"], row.derivedBy) && member(["unconfirmed", "confirmed", "rejected", "superseded"], row.status) && isInstant(row.createdAt)) || !uniqueIds(memory.inferences) ||
    !rows(memory.confirmedFacts, row => text(row.id) && text(row.answerId) && nullableText(row.inferenceId) && text(row.text) && isInstant(row.confirmedAt)) || !uniqueIds(memory.confirmedFacts) ||
    !rows(memory.history, row => (row.from === null || member(WORKFLOW_STATUSES, row.from)) && member(WORKFLOW_STATUSES, row.to) && text(row.event) && isInstant(row.at))) return false;
  const { questions, answers, inferences, confirmedFacts, history } = memory;
  if (!history.length || history[0].from !== null || history[0].to !== "pending" ||
    history[history.length - 1].to !== value.workflowStatus || history[history.length - 1].at !== value.updatedAt ||
    history.some((entry, index) => index > 0 && (entry.from !== history[index - 1].to ||
      (entry.from !== entry.to && !ALLOWED_TRANSITIONS[entry.from as WorkflowStatus].includes(entry.to as WorkflowStatus))))) return false;
  const questionIds = new Set(questions.map(row => row.id));
  const answerIds = new Set(answers.map(row => row.id));
  if (answers.some(row => !questionIds.has(row.questionId)) || new Set(answers.map(row => row.questionId)).size !== answers.length ||
    inferences.some(row => !answerIds.has(row.answerId)) || confirmedFacts.some(row => !answerIds.has(row.answerId) ||
      (row.inferenceId !== null && !inferences.some(inference => inference.id === row.inferenceId && inference.answerId === row.answerId && inference.status === "confirmed" && inference.text === row.text))) ||
    inferences.some(inference => inference.status === "confirmed" && confirmedFacts.filter(fact => fact.inferenceId === inference.id).length !== 1)) return false;
  if (value.blocker !== null && (!isObject(value.blocker) || !text(value.blocker.factId) || !text(value.blocker.text) ||
    !confirmedFacts.some(fact => fact.id === (value.blocker as Record<string, unknown>).factId && fact.text === (value.blocker as Record<string, unknown>).text))) return false;
  const active = value.workflowStatus === "waiting_for_answer";
  if (active) {
    if (!question(value.currentQuestion) || value.currentQuestion.invalidatedAt !== null || value.currentQuestion.sourceRevision !== source.revision ||
      value.currentQuestion.triggerKey !== value.triggerKey || value.currentQuestion.askedAt !== value.lastAskedAt ||
      !questions.some(row => ["id", "text", "askedAt", "triggerKey", "sourceRevision", "invalidatedAt"].every(key => row[key] === (value.currentQuestion as Record<string, unknown>)[key])) ||
      answers.some(row => row.questionId === (value.currentQuestion as Record<string, unknown>).id)) return false;
  } else if (value.currentQuestion !== null) return false;
  const paused = value.workflowStatus === "snoozed" || value.workflowStatus === "waiting_for_followup";
  if (paused ? value.nextFollowUpAt === null || value.followUpKind === null : value.nextFollowUpAt !== null || value.followUpKind !== null) return false;
  return true;
}

/** Reject the entire malformed envelope. Callers must preserve the original bytes rather than overwrite them. */
export function isWorkflowState(value: unknown, ownerId: string): value is WorkflowState {
  if (!isObject(value) || value.version !== 1 || value.ownerId !== ownerId || !isObject(value.settings) ||
    typeof value.settings.enabled !== "boolean" || !isTimeZone(value.settings.timeZone) ||
    !Number.isInteger(value.settings.maxVisibleQuestions) || (value.settings.maxVisibleQuestions as number) < 1 ||
    (value.settings.maxVisibleQuestions as number) > 3 || !Array.isArray(value.cases) || !value.cases.every(item => validCase(item, ownerId))) return false;
  return new Set(value.cases.map(item => item.id)).size === value.cases.length &&
    new Set(value.cases.map(item => JSON.stringify([item.sourceType, item.sourceId]))).size === value.cases.length;
}
