import type { AppLocale } from "../../i18n/config";
import type { PartnerRole } from "../ai/contracts";
import type { IdeaRecord, PlannerEvent, PlannerTodo } from "../workspace/browser-records";

export const WORKFLOW_STATUSES = [
  "pending", "waiting_for_answer", "answered", "waiting_for_followup", "snoozed", "dismissed", "resolved",
] as const;
export type WorkflowStatus = typeof WORKFLOW_STATUSES[number];
export const TRIGGER_TYPES = [
  "task_needs_clarification", "task_deadline_near", "blocker_followup", "followup_due", "source_updated",
] as const;
export type TriggerType = typeof TRIGGER_TYPES[number];

export type WorkflowSource =
  | { type: "task"; record: PlannerTodo & { createdAt?: string } }
  | { type: "calendar"; record: PlannerEvent }
  | { type: "idea"; record: IdeaRecord };

/** A trusted caller must establish ownership BEFORE supplying a source. This label is not authentication.
 * Never wrap unowned aiask-planner / aiask-idea-box records with the current account ID automatically.
 * taskCreated must come from an actual creation event, not from first observing an older record.
 */
export type OwnedSourceObservation = {
  ownerId: string;
  ownership: "verified_owner";
  source: WorkflowSource;
  taskCreated?: boolean;
};

export type SourceSnapshot = {
  title: string;
  dueDate: string | null;
  completed: boolean;
  revision: string;
};
export type WorkflowSettings = {
  enabled: boolean;
  timeZone: string;
  maxVisibleQuestions: number;
};
export type WorkflowAnswer = { id: string; questionId: string; text: string; answeredAt: string };
export type WorkflowInference = {
  id: string;
  answerId: string;
  kind: "blocker" | "fact";
  text: string;
  derivedBy: "rule" | "ai";
  status: "unconfirmed" | "confirmed" | "rejected" | "superseded";
  createdAt: string;
};
export type ConfirmedFact = { id: string; answerId: string; inferenceId: string | null; text: string; confirmedAt: string };
export type WorkflowQuestion = {
  id: string;
  text: string;
  askedAt: string;
  triggerKey: string;
  sourceRevision: string;
  invalidatedAt: string | null;
};
export type WorkflowHistoryEntry = {
  from: WorkflowStatus | null;
  to: WorkflowStatus;
  event: string;
  at: string;
};
export type WorkflowMemory = {
  answers: WorkflowAnswer[];
  confirmedFacts: ConfirmedFact[];
  inferences: WorkflowInference[];
  questions: WorkflowQuestion[];
  history: WorkflowHistoryEntry[];
};

export type ProactiveCase = {
  id: string;
  ownerId: string;
  sourceType: WorkflowSource["type"];
  sourceId: string;
  sourceSnapshot: SourceSnapshot;
  sourceVersion: number;
  triggerType: TriggerType;
  triggerKey: string;
  triggerReason: string;
  handledTriggers: string[];
  assignedRoleId: PartnerRole;
  workflowStatus: WorkflowStatus;
  currentQuestion: WorkflowQuestion | null;
  blocker: { factId: string; text: string } | null;
  nextFollowUpAt: string | null;
  followUpKind: "blocker" | "user_requested" | null;
  lastAskedAt: string | null;
  lastAnsweredAt: string | null;
  conversationId: string | null;
  memory: WorkflowMemory;
  createdAt: string;
  updatedAt: string;
};
export type WorkflowState = {
  version: 1;
  ownerId: string;
  settings: WorkflowSettings;
  cases: ProactiveCase[];
};

export type WorkflowTrigger = {
  sourceType: WorkflowSource["type"];
  sourceId: string;
  type: TriggerType;
  key: string;
  reason: string;
  snapshot: SourceSnapshot;
};
export type TriggerDetection = { triggers: WorkflowTrigger[]; completedCaseIds: string[] };

/** Only this case's context is included; inferred information is explicitly separate from confirmed facts. */
export type WorkflowContext = {
  source: { type: ProactiveCase["sourceType"]; id: string; snapshot: SourceSnapshot };
  confirmedFacts: ConfirmedFact[];
  unconfirmedInferences: WorkflowInference[];
  answers: WorkflowAnswer[];
  previousQuestions: WorkflowQuestion[];
  blocker: ProactiveCase["blocker"];
};
export type QuestionGeneratorInput = {
  caseId: string;
  triggerKey: string;
  sourceRevision: string;
  triggerType: TriggerType;
  partnerRole: PartnerRole;
  locale: AppLocale;
  context: WorkflowContext;
};
export type QuestionGeneratorOutput = {
  caseId: string;
  triggerKey: string;
  sourceRevision: string;
  partnerRole: PartnerRole;
  locale: AppLocale;
  question: string;
};
export interface AIQuestionGenerator {
  generate(input: QuestionGeneratorInput, signal: AbortSignal): Promise<QuestionGeneratorOutput>;
}
export type InferenceProposal = Pick<WorkflowInference, "kind" | "text" | "derivedBy">;
export interface UserAnswerProcessor {
  process(input: { locale: AppLocale; context: WorkflowContext; answer: WorkflowAnswer }, signal: AbortSignal): Promise<InferenceProposal[]>;
}
export type WorkflowCommand = { caseId: string } & (
  | { type: "ask"; output: QuestionGeneratorOutput }
  | { type: "answer"; questionId: string; text: string; proposals?: InferenceProposal[] }
  | { type: "confirm_inference" | "reject_inference"; inferenceId: string }
  | { type: "schedule_followup"; at: string }
  | { type: "snooze"; until: string }
  | { type: "dismiss" | "resolve" }
  | { type: "followup_result"; questionId: string; outcome: "received" | "still_waiting" }
);

/** Read-only boundary for a future Proactive Insights panel and Workspace Coach handoff. */
export type ProactiveInsight = {
  caseId: string;
  sourceType: ProactiveCase["sourceType"];
  sourceId: string;
  sourceTitle: string;
  partnerRole: PartnerRole;
  triggerReason: string;
  question: WorkflowQuestion;
  lastAnswer: WorkflowAnswer | null;
  nextFollowUpAt: string | null;
};
export type WorkspaceCoachHandoff = {
  caseId: string;
  conversationId: string | null;
  partnerRole: PartnerRole;
  locale: AppLocale;
  context: WorkflowContext;
};
