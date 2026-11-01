import { isPartnerResponse, type PartnerResponse, type PartnerRole } from "./contracts";

export type ConversationMessageRole = "user" | "assistant";
export type ConversationMessageKind = "idea" | "follow_up" | "structured_response";
export type ConversationMessageStatus = "pending" | "completed" | "failed" | "save_failed";

export type ConversationMessage = {
  id: string;
  role: ConversationMessageRole;
  content: string;
  kind: ConversationMessageKind;
  status: ConversationMessageStatus;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type ConversationListItem = {
  id: string;
  title: string;
  ideaId: string | null;
  projectId: string | null;
  partnerRole: PartnerRole;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AIConversation = ConversationListItem & { messages: ConversationMessage[] };

export function titleFromIdea(idea: string) {
  const title = idea.replace(/\s+/g, " ").trim();
  return title.length > 120 ? `${title.slice(0, 117).trimEnd()}…` : title || "AI Team conversation";
}

export function formatPartnerResponse(response: PartnerResponse) {
  const list = (items: string[]) => items.map(item => `- ${item}`).join("\n");
  return [
    `## Perspective\n\n${response.perspective}`,
    `## Questions to explore\n\n${list(response.questions)}`,
    `## Risks\n\n${list(response.risks)}`,
    `## Opportunities\n\n${list(response.opportunities)}`,
    `## Possible next step\n\n${response.nextStep}`,
    `## Uncertainty\n\n${list(response.uncertainty)}`,
  ].join("\n\n");
}

export { isPartnerResponse };
