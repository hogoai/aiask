import type { AIASKContext, PartnerRole } from "../ai/contracts";
import type { WorkspaceCoachHandoff } from "./contracts";

export const workflowRoleNames: Record<PartnerRole, string> = {
  guide: "AI Guide", planner: "AI Planner", knowledge_partner: "AI Knowledge Partner",
  evaluator: "AI Evaluator", advisor: "AI Advisor", action_partner: "AI Action Partner",
};
export type WorkflowCoachRequest = { requestId: string; ownerId: string; handoff: WorkspaceCoachHandoff; draft: string };
export type WorkflowConversationLink = { requestId: string; ownerId: string; caseId: string; conversationId: string };

/** Context stays limited to the reviewed task. Proposals are explicitly labelled and never promoted to facts. */
export function workflowCoachContext(handoff: WorkspaceCoachHandoff): AIASKContext {
  const context = handoff.context;
  return {
    relevantTasks: [(context.source.snapshot.title + (context.source.snapshot.dueDate ? ` | Due: ${context.source.snapshot.dueDate}` : "")).slice(0, 1200)],
    relevantDecisions: context.confirmedFacts.slice(-5).map(fact => `User-confirmed fact (recorded ${fact.confirmedAt}): ${fact.text}`.slice(0, 1200)),
    relevantNotes: [
      "Workflow context: offer advice and questions only. Do not execute actions or treat proposals as confirmed facts.",
      ...(handoff.teamSource ? [
        `AI Team suggested next step (not approved): ${handoff.teamSource.record.nextStep}`,
        `AI Team perspective: ${handoff.teamSource.record.perspective}`,
      ] : []),
      ...context.unconfirmedInferences.slice(-3).map(inference => `UNCONFIRMED ${inference.derivedBy} proposal: ${inference.text}`),
      ...context.answers.slice(-3).map(answer => `User's original workflow reply: ${answer.text}`),
    ].map(text => text.slice(0, 1200)),
  };
}
