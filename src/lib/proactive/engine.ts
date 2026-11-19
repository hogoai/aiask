import type { OwnedSourceObservation, ProactiveCase, WorkflowCommand, WorkflowHistoryEntry, WorkflowInference, WorkflowSettings, WorkflowState, WorkflowStatus, WorkflowTrigger } from "./contracts";
import { buildQuestionInput, DRAWINGS_BLOCKER, generateRuleQuestion, proposeAnswerInferences } from "./interfaces";
import { assertClock, assertObservations, assertOwner, detectTriggers, isTerminal, isTimeZone, normalizeFollowUpTime, sourceSnapshot, triggerRole, WorkflowError } from "./rules";

export const ALLOWED_TRANSITIONS: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
  pending: ["waiting_for_answer", "snoozed", "dismissed", "resolved"],
  waiting_for_answer: ["pending", "answered", "snoozed", "dismissed", "resolved"],
  answered: ["pending", "waiting_for_followup", "snoozed", "dismissed", "resolved"],
  waiting_for_followup: ["pending", "snoozed", "dismissed", "resolved"],
  snoozed: ["pending", "dismissed", "resolved"],
  dismissed: ["pending"], // Explicit restart after a fresh source review only; detectors still skip terminal Cases.
  resolved: ["pending"],
};
type Runtime = { newId?: () => string };
const id = (runtime: Runtime) => (runtime.newId ?? (() => crypto.randomUUID()))();

export function createWorkflowState(ownerId: string, timeZone = "UTC"): WorkflowState {
  assertOwner(ownerId);
  if (!isTimeZone(timeZone)) throw new WorkflowError("invalid_timezone");
  return { version: 1, ownerId, settings: { enabled: true, timeZone, maxVisibleQuestions: 1 }, cases: [] };
}

/** A reviewed existing task can request clarification without pretending it was just created. */
export function requestTaskCheckIn(state: WorkflowState, observation: OwnedSourceObservation, now: Date, restart = false): WorkflowState {
  assertClock(now);
  assertObservations(state.ownerId, [observation]);
  if (observation.source.type !== "task") throw new WorkflowError("task_required");
  const snapshot = sourceSnapshot(observation);
  if (snapshot.completed) return advanceWorkflows(state, [observation], now);
  const existing = state.cases.find(entry => entry.sourceType === "task" && entry.sourceId === observation.source.record.id);
  const at = now.toISOString();
  if (existing && !isTerminal(existing)) return advanceWorkflows(state, [observation], now);
  if (existing && !restart) return state;
  const trigger: WorkflowTrigger = {
    sourceType: "task", sourceId: observation.source.record.id, type: "task_needs_clarification",
    key: JSON.stringify(["task", observation.source.record.id, "user_requested_checkin", crypto.randomUUID()]),
    reason: "You reviewed this task and requested a check-in about its requirements and next step.", snapshot,
  };
  let next: WorkflowState;
  if (existing) {
    const updated = changeStatus({ ...invalidateQuestion(existing, at), sourceSnapshot: snapshot, sourceVersion: existing.sourceVersion + 1,
      triggerType: trigger.type, triggerKey: trigger.key, triggerReason: trigger.reason, assignedRoleId: existing.conversationId ? existing.assignedRoleId : triggerRole[trigger.type],
      handledTriggers: [...existing.handledTriggers, trigger.key], blocker: null, nextFollowUpAt: null, followUpKind: null,
    }, "pending", "user_restarted_after_source_review", at);
    next = replaceCase(state, updated);
  } else next = applyTrigger(state, trigger, at, {});
  return advanceWorkflows(next, [observation], now);
}

/** Free visible question capacity without consuming a trigger or changing a user's agreed follow-up time. */
export function holdQuestionsForSourceReview(state: WorkflowState, caseIds: readonly string[], now: Date): WorkflowState {
  let next = state;
  for (const item of state.cases) {
    if (!caseIds.includes(item.id) || item.workflowStatus !== "waiting_for_answer") continue;
    next = replaceCase(next, changeStatus(invalidateQuestion(item, now.toISOString()), "pending", "source_review_required", now.toISOString()));
  }
  return next;
}

export function setWorkflowSettings(state: WorkflowState, changes: Partial<WorkflowSettings>): WorkflowState {
  const settings = { ...state.settings, ...changes };
  if (typeof settings.enabled !== "boolean" || !isTimeZone(settings.timeZone) ||
    !Number.isInteger(settings.maxVisibleQuestions) || settings.maxVisibleQuestions < 1 || settings.maxVisibleQuestions > 3) throw new WorkflowError("invalid_settings");
  return settings.enabled === state.settings.enabled && settings.timeZone === state.settings.timeZone && settings.maxVisibleQuestions === state.settings.maxVisibleQuestions
    ? state : { ...state, settings };
}

function changeStatus(item: ProactiveCase, to: WorkflowStatus, event: string, at: string): ProactiveCase {
  if (to !== item.workflowStatus && !ALLOWED_TRANSITIONS[item.workflowStatus].includes(to)) throw new WorkflowError("invalid_transition");
  const history: WorkflowHistoryEntry = { from: item.workflowStatus, to, event, at };
  return { ...item, workflowStatus: to, updatedAt: at, memory: { ...item.memory, history: [...item.memory.history, history] } };
}
function replaceCase(state: WorkflowState, item: ProactiveCase): WorkflowState {
  return { ...state, cases: state.cases.map(existing => existing.id === item.id ? item : existing) };
}
function resolveCase(item: ProactiveCase, event: string, at: string) {
  return changeStatus({ ...item, currentQuestion: null, nextFollowUpAt: null, followUpKind: null, blocker: null }, "resolved", event, at);
}
function invalidateQuestion(item: ProactiveCase, at: string) {
  const previousQuestionId = item.currentQuestion?.id ?? item.memory.questions.at(-1)?.id;
  return { ...item, currentQuestion: null, memory: { ...item.memory,
    questions: item.memory.questions.map(question => question.id === previousQuestionId ? { ...question, invalidatedAt: at } : question),
    inferences: item.memory.inferences.map(inference => inference.status === "unconfirmed" ? { ...inference, status: "superseded" as const } : inference),
  } };
}

function applyTrigger(state: WorkflowState, trigger: WorkflowTrigger, at: string, runtime: Runtime): WorkflowState {
  const existing = state.cases.find(item => item.sourceType === trigger.sourceType && item.sourceId === trigger.sourceId);
  if (!existing) {
    const item: ProactiveCase = {
      id: id(runtime), ownerId: state.ownerId, sourceType: trigger.sourceType, sourceId: trigger.sourceId,
      sourceSnapshot: trigger.snapshot, sourceVersion: 1, triggerType: trigger.type, triggerKey: trigger.key, triggerReason: trigger.reason,
      handledTriggers: [trigger.key], assignedRoleId: triggerRole[trigger.type], workflowStatus: "pending", currentQuestion: null,
      blocker: null, nextFollowUpAt: null, followUpKind: null, lastAskedAt: null, lastAnsweredAt: null, conversationId: null,
      memory: { answers: [], confirmedFacts: [], inferences: [], questions: [], history: [{ from: null, to: "pending", event: trigger.type, at }] },
      createdAt: at, updatedAt: at,
    };
    return { ...state, cases: [...state.cases, item] };
  }
  if (isTerminal(existing) || existing.handledTriggers.includes(trigger.key)) return state;
  let item = trigger.type === "source_updated" ? invalidateQuestion(existing, at) : { ...existing, currentQuestion: null };
  item = {
    ...item, sourceSnapshot: trigger.snapshot, sourceVersion: existing.sourceVersion + (trigger.type === "source_updated" ? 1 : 0),
    triggerType: trigger.type, triggerKey: trigger.key, triggerReason: trigger.reason, assignedRoleId: triggerRole[trigger.type],
    handledTriggers: [...existing.handledTriggers, trigger.key],
  };
  const hold = trigger.type === "source_updated" && (existing.workflowStatus === "snoozed" || existing.workflowStatus === "waiting_for_followup") &&
    existing.nextFollowUpAt && existing.nextFollowUpAt > at;
  if (!hold) item = { ...item, nextFollowUpAt: null, followUpKind: null };
  return replaceCase(state, changeStatus(item, hold ? existing.workflowStatus : "pending", trigger.type, at));
}

/** Reconcile only explicitly owned observations. A missing observation is never interpreted as deletion. */
export function advanceWorkflows(state: WorkflowState, observations: readonly OwnedSourceObservation[], now: Date, runtime: Runtime = {}): WorkflowState {
  const detected = detectTriggers(state, observations, now);
  const at = now.toISOString();
  let next = state;
  for (const caseId of detected.completedCaseIds) {
    const item = next.cases.find(entry => entry.id === caseId)!;
    const observation = observations.find(entry => entry.source.type === item.sourceType && entry.source.record.id === item.sourceId)!;
    next = replaceCase(next, resolveCase({ ...item, sourceSnapshot: sourceSnapshot(observation), sourceVersion: item.sourceVersion + 1 }, "source_completed", at));
  }
  for (const trigger of detected.triggers) {
    next = applyTrigger(next, trigger, at, runtime);
    const source = observations.find(entry => entry.source.type === trigger.sourceType && entry.source.record.id === trigger.sourceId)?.source;
    if (source?.type === "calendar" && trigger.type === "source_linked") next = { ...next, cases: next.cases.map(item => item.sourceType === "calendar" && item.sourceId === source.record.id && !item.conversationId ? { ...item, assignedRoleId: "planner" } : item) };
    if (source?.type === "conversation") next = { ...next, cases: next.cases.map(item => item.sourceType === "conversation" && item.sourceId === source.record.id ? { ...item, assignedRoleId: source.record.partnerRole } : item) };
  }
  if (!next.settings.enabled) return next;
  let available = next.settings.maxVisibleQuestions - next.cases.filter(item => item.workflowStatus === "waiting_for_answer").length;
  for (const item of next.cases) {
    if (available <= 0) break;
    if (item.workflowStatus !== "pending") continue;
    // Do not ask from a cached snapshot without a current, owned source observation.
    if (!observations.some(observation => observation.source.type === item.sourceType && observation.source.record.id === item.sourceId)) continue;
    next = applyWorkflowCommand(next, { type: "ask", caseId: item.id, output: generateRuleQuestion(buildQuestionInput(item)) }, now, runtime);
    available--;
  }
  return next;
}

export function applyWorkflowCommand(state: WorkflowState, command: WorkflowCommand, now: Date, runtime: Runtime = {}): WorkflowState {
  assertClock(now);
  if (!["ask", "answer", "confirm_inference", "reject_inference", "schedule_followup", "snooze", "dismiss", "resolve", "followup_result", "link_conversation"].includes(command.type)) throw new WorkflowError("invalid_command");
  let item = state.cases.find(entry => entry.id === command.caseId);
  if (!item || item.ownerId !== state.ownerId) throw new WorkflowError("case_unavailable");
  if (command.type === "link_conversation") {
    if (typeof command.conversationId !== "string" || !command.conversationId.trim() || command.conversationId.length > 200) throw new WorkflowError("invalid_conversation");
    if (item.conversationId === command.conversationId) return state;
    return replaceCase(state, changeStatus({ ...item, conversationId: command.conversationId }, item.workflowStatus, "conversation_linked", now.toISOString()));
  }
  if (isTerminal(item)) throw new WorkflowError("case_closed");
  const at = now.toISOString();
  if (command.type === "ask") {
    const output = command.output;
    if (!state.settings.enabled || item.workflowStatus !== "pending" ||
      state.cases.filter(entry => entry.workflowStatus === "waiting_for_answer").length >= state.settings.maxVisibleQuestions) throw new WorkflowError("question_not_available");
    if (output.caseId !== item.id || output.triggerKey !== item.triggerKey || output.sourceRevision !== item.sourceSnapshot.revision ||
      output.partnerRole !== item.assignedRoleId || output.locale !== "en" || typeof output.question !== "string" || !output.question.trim() || output.question.length > 500) throw new WorkflowError("stale_or_invalid_question");
    const question = { id: id(runtime), text: output.question, askedAt: at, triggerKey: item.triggerKey, sourceRevision: item.sourceSnapshot.revision, invalidatedAt: null };
    item = changeStatus({ ...item, currentQuestion: question, lastAskedAt: at,
      memory: { ...item.memory, questions: [...item.memory.questions, question] } }, "waiting_for_answer", "question_asked", at);
  } else if (command.type === "answer") {
    if (item.workflowStatus !== "waiting_for_answer" || item.currentQuestion?.id !== command.questionId) throw new WorkflowError("stale_answer");
    if (typeof command.text !== "string" || !command.text.trim() || command.text.length > 4000) throw new WorkflowError("invalid_answer");
    const answer = { id: id(runtime), questionId: command.questionId, text: command.text, answeredAt: at };
    const proposals = command.proposals ?? proposeAnswerInferences(answer);
    if (proposals.length > 10 || proposals.some(proposal => !["blocker", "fact"].includes(proposal.kind) || !["rule", "ai"].includes(proposal.derivedBy) ||
      typeof proposal.text !== "string" || !proposal.text.trim() || proposal.text.length > 1000)) throw new WorkflowError("invalid_inference");
    const inferences: WorkflowInference[] = proposals.map(proposal => ({ ...proposal, id: id(runtime), answerId: answer.id, status: "unconfirmed", createdAt: at }));
    item = changeStatus({ ...item, currentQuestion: null, lastAnsweredAt: at, nextFollowUpAt: null, followUpKind: null,
      memory: { ...item.memory, answers: [...item.memory.answers, answer], inferences: [...item.memory.inferences, ...inferences] } }, "answered", "answer_recorded", at);
  } else if (command.type === "confirm_inference" || command.type === "reject_inference") {
    const inference = item.memory.inferences.find(entry => entry.id === command.inferenceId);
    if (item.workflowStatus !== "answered" || !inference || inference.status !== "unconfirmed") throw new WorkflowError("inference_not_confirmable");
    const confirmed = command.type === "confirm_inference";
    const fact = confirmed ? { id: id(runtime), answerId: inference.answerId, inferenceId: inference.id, text: inference.text, confirmedAt: at } : null;
    item = changeStatus({ ...item, blocker: fact && inference.kind === "blocker" ? { factId: fact.id, text: fact.text } : item.blocker,
      memory: { ...item.memory, confirmedFacts: fact ? [...item.memory.confirmedFacts, fact] : item.memory.confirmedFacts,
        inferences: item.memory.inferences.map(entry => entry.id === inference.id ? { ...entry, status: confirmed ? "confirmed" : "rejected" } : entry) } }, "answered", command.type, at);
  } else if (command.type === "schedule_followup" || command.type === "snooze") {
    const until = normalizeFollowUpTime(command.type === "schedule_followup" ? command.at : command.until);
    if (until <= at) throw new WorkflowError("followup_must_be_future");
    if (command.type === "schedule_followup" && item.workflowStatus !== "answered") throw new WorkflowError("answer_required_before_followup");
    if (command.type === "snooze") item = { ...item, currentQuestion: null };
    item = changeStatus({ ...item, nextFollowUpAt: until, followUpKind: item.blocker ? "blocker" : "user_requested" },
      command.type === "snooze" ? "snoozed" : "waiting_for_followup", command.type, at);
  } else if (command.type === "dismiss") {
    item = changeStatus({ ...item, currentQuestion: null, nextFollowUpAt: null, followUpKind: null }, "dismissed", "user_dismissed", at);
  } else if (command.type === "resolve") {
    item = resolveCase(item, "user_resolved", at);
  } else if (command.type === "followup_result") {
    if (!item.blocker || item.workflowStatus !== "waiting_for_answer" || item.currentQuestion?.id !== command.questionId ||
      !["received", "still_waiting"].includes(command.outcome)) throw new WorkflowError("invalid_followup_result");
    const text = command.outcome === "received" ? (item.blocker.text === DRAWINGS_BLOCKER ? "I have received the final design drawings." : "The blocker has been cleared.") : "I am still waiting.";
    const answered = applyWorkflowCommand(state, { type: "answer", caseId: item.id, questionId: command.questionId, text, proposals: [] }, now, runtime);
    item = answered.cases.find(entry => entry.id === item!.id)!;
    if (command.outcome === "received") {
      const answer = item.memory.answers[item.memory.answers.length - 1];
      const fact = { id: id(runtime), answerId: answer.id, inferenceId: null, text, confirmedAt: at };
      item = resolveCase({ ...item, memory: { ...item.memory, confirmedFacts: [...item.memory.confirmedFacts, fact] } }, "user_confirmed_blocker_cleared", at);
    }
  }
  return replaceCase(state, item);
}
