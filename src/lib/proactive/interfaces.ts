import { defaultLocale } from "../../i18n/config";
import type { InferenceProposal, ProactiveCase, ProactiveInsight, QuestionGeneratorInput, QuestionGeneratorOutput, WorkflowAnswer, WorkflowContext, WorkflowState, WorkspaceCoachHandoff } from "./contracts";
import { isQuotation, WorkflowError } from "./rules";

export const DRAWINGS_BLOCKER = "Waiting for final design drawings.";

export function buildWorkflowContext(item: ProactiveCase): WorkflowContext {
  return {
    source: { type: item.sourceType, id: item.sourceId, snapshot: { ...item.sourceSnapshot } },
    confirmedFacts: item.memory.confirmedFacts.map(fact => ({ ...fact })),
    unconfirmedInferences: item.memory.inferences.filter(entry => entry.status === "unconfirmed").map(entry => ({ ...entry })),
    answers: item.memory.answers.slice(-5).map(answer => ({ ...answer })),
    previousQuestions: item.memory.questions.slice(-5).map(question => ({ ...question })),
    blocker: item.blocker ? { ...item.blocker } : null,
  };
}

export function buildQuestionInput(item: ProactiveCase): QuestionGeneratorInput {
  if (item.workflowStatus !== "pending") throw new WorkflowError("question_not_pending");
  return {
    caseId: item.id, triggerKey: item.triggerKey, sourceRevision: item.sourceSnapshot.revision,
    triggerType: item.triggerType, partnerRole: item.assignedRoleId, locale: defaultLocale,
    context: buildWorkflowContext(item),
  };
}

/** Deterministic English fallback, persisted when asked. No model invocation or network access. */
export function generateRuleQuestion(input: QuestionGeneratorInput): QuestionGeneratorOutput {
  let question: string;
  const { context, triggerType } = input;
  if (input.locale !== defaultLocale) throw new WorkflowError("unsupported_locale");
  if (triggerType === "source_linked") {
    question = context.source.type === "calendar" ? "What needs to be ready for this event, and is anything still unconfirmed?"
      : context.source.type === "conversation" ? "Would you like to take the suggested next step, or is something holding you back?"
      : "What is your next step for this task, and is anything blocking it?";
  } else if (triggerType === "calendar_prepare") {
    question = "Your event is coming up. Are the preparations ready, or is anything still outstanding?";
  } else if (triggerType === "calendar_review") {
    question = "How did the event go, and what would you like to follow up on?";
  } else if (triggerType === "source_updated") {
    question = "You updated this item. Is the earlier question still relevant, or has the next step changed?";
  } else if (context.blocker && (triggerType === "blocker_followup" || triggerType === "followup_due")) {
    question = context.blocker.text === DRAWINGS_BLOCKER
      ? "Last time you were waiting for the design drawings for this quotation. Is there any progress?"
      : "Last time you confirmed a blocker for this item. Has anything changed?";
  } else if (triggerType === "task_needs_clarification") {
    question = isQuotation(context.source.snapshot.title)
      ? "Have the final design drawings and technical specifications for the quotation been confirmed?"
      : "What is the next concrete step for this task, and when would you like to complete it?";
  } else if (triggerType === "task_deadline_near") {
    question = "This task is approaching or past its deadline. Is anything blocking your next step?";
  } else {
    const previous = context.previousQuestions.at(-1);
    const unanswered = previous && !previous.invalidatedAt && !context.answers.some(answer => answer.questionId === previous.id);
    question = unanswered ? previous.text : "Is there any progress on this item since our last check-in?";
  }
  return { caseId: input.caseId, triggerKey: input.triggerKey, sourceRevision: input.sourceRevision, partnerRole: input.partnerRole, locale: input.locale, question };
}

/** This is only a candidate extractor. The engine never promotes these proposals to facts implicitly. */
export function proposeAnswerInferences(answer: WorkflowAnswer): InferenceProposal[] {
  if (/\b(?:missing|waiting(?:\s+for)?|not\s+(?:yet\s+)?received|still\s+need|haven't\s+received)\b[^.!?\n]*\b(?:drawings?|plans?)\b/i.test(answer.text)) {
    return [{ kind: "blocker", text: DRAWINGS_BLOCKER, derivedBy: "rule" }];
  }
  const candidate = answer.text.match(/\b(?:waiting for|blocked by|missing)\s+[^.!?\n]{2,180}/i)?.[0].trim();
  return candidate ? [{ kind: "blocker", text: candidate.charAt(0).toUpperCase() + candidate.slice(1), derivedBy: "rule" }] : [];
}

export function workflowSuggestion(item: ProactiveCase): string | null {
  if (!item.blocker || item.workflowStatus === "dismissed" || item.workflowStatus === "resolved") return null;
  return item.blocker.text === DRAWINGS_BLOCKER
    ? "Would you like help listing the questions to confirm with the designer?"
    : "Would you like help working out a small next step around this blocker?";
}

export function selectProactiveInsights(state: WorkflowState): ProactiveInsight[] {
  if (!state.settings.enabled) return [];
  return state.cases.filter(item => item.workflowStatus === "waiting_for_answer" && item.currentQuestion)
    .slice(0, 1).map(item => ({
      caseId: item.id, sourceType: item.sourceType, sourceId: item.sourceId, sourceTitle: item.sourceSnapshot.title,
      partnerRole: item.assignedRoleId, triggerReason: item.triggerReason, question: { ...item.currentQuestion! },
      lastAnswer: item.memory.answers.length ? { ...item.memory.answers[item.memory.answers.length - 1] } : null,
      nextFollowUpAt: item.nextFollowUpAt,
    }));
}

/** Data contract only: does not navigate, create a conversation, or write existing conversation history. */
export function buildWorkspaceCoachHandoff(item: ProactiveCase): WorkspaceCoachHandoff {
  return { caseId: item.id, conversationId: item.conversationId, partnerRole: item.assignedRoleId, locale: defaultLocale, context: buildWorkflowContext(item) };
}
