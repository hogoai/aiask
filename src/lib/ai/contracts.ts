export const PARTNER_ROLE_ID = {
  guide: "guide",
  planner: "planner",
  knowledgePartner: "knowledge_partner",
  evaluator: "evaluator",
  advisor: "advisor",
  actionPartner: "action_partner",
} as const;

export const PARTNER_ROLE_IDS = [
  PARTNER_ROLE_ID.guide,
  PARTNER_ROLE_ID.planner,
  PARTNER_ROLE_ID.knowledgePartner,
  PARTNER_ROLE_ID.evaluator,
  PARTNER_ROLE_ID.advisor,
  PARTNER_ROLE_ID.actionPartner,
] as const;

export type PartnerRole = typeof PARTNER_ROLE_IDS[number];
export type ResponseMode = "normal" | "concise" | "detailed";

export type AIASKContext = {
  ideaId?: string;
  projectId?: string;
  goal?: string;
  relevantNotes?: string[];
  relevantDecisions?: string[];
  relevantTasks?: string[];
  relevantCalendarItems?: string[];
  userPreferences?: Record<string, unknown>;
};

export type AIASKInput = {
  conversationId?: string;
  userMessage: string;
  partnerRole: PartnerRole;
  context?: AIASKContext;
  responseMode?: ResponseMode;
  locale?: string;
};

export type PartnerResponse = {
  perspective: string;
  questions: string[];
  risks: string[];
  opportunities: string[];
  nextStep: string;
  uncertainty: string[];
};

export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type AIASKSuggestion = {
  title: string;
  description: string;
  rationale?: string;
};

export type AIASKRisk = {
  description: string;
  severity?: "low" | "medium" | "high";
  uncertainty?: string;
};

export type AIASKProposedAction = {
  title: string;
  description?: string;
  actionType: "create_task" | "create_calendar_event" | "save_note" | "link_idea" | "other";
  requiresConfirmation: true;
};

export type PlannerChange = {
  action: "none" | "create_task" | "update_task" | "delete_task" | "create_calendar_event" | "update_calendar_event" | "delete_calendar_event";
  targetId: string | null;
  fields: Array<"title" | "dueDate" | "scheduledDate" | "scheduledTime" | "status" | "priority" | "ideaId">;
  title: string | null;
  dueDate: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  status: "Open" | "Done" | null;
  priority: "urgent" | "attention" | "onTrack" | null;
  ideaId: string | null;
};

export type AIASKOutput = {
  conversationId?: string;
  messageId?: string;
  partnerRole: PartnerRole;
  response: {
    summary: string;
    content: string;
  };
  questions?: string[];
  suggestions?: AIASKSuggestion[];
  risks?: AIASKRisk[];
  proposedActions?: AIASKProposedAction[];
  plannerChange?: PlannerChange;
  knowledgeReferences?: Array<{
    title: string;
    url?: string;
    sourceType?: string;
  }>;
  handoff?: {
    recommendedRole?: PartnerRole;
    reason: string;
  };
  uncertainty?: string[];

  /** Existing AI Pilot response fields retained for current clients. */
  role?: PartnerRole;
  result?: PartnerResponse;
  answer?: string;
  userMessageId?: string;
  saved?: boolean;
  model?: string;
  usage?: ModelUsage;
};

export type PartnerFollowUpMessage = { role: "user" | "assistant"; content: string };

export type AIASKRunRequest =
  | {
      kind: "structured";
      input: AIASKInput;
      retryMessageId?: string;
    }
  | {
      kind: "follow_up";
      input: AIASKInput;
      originalIdea: string;
      perspectiveContext: string;
      history: PartnerFollowUpMessage[];
      plannerChat?: true;
      retryMessageId?: string;
    };

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

const LEGACY_PARTNER_ROLE_MAP = {
  knowledge: "knowledge_partner",
  accountability: "action_partner",
} as const satisfies Record<string, PartnerRole>;

const STORED_PARTNER_ROLE_MAP: Record<PartnerRole, string> = {
  guide: "guide",
  planner: "planner",
  knowledge_partner: "knowledge",
  evaluator: "evaluator",
  advisor: "advisor",
  action_partner: "accountability",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}

export function isPartnerRole(value: unknown): value is PartnerRole {
  return typeof value === "string" && (PARTNER_ROLE_IDS as readonly string[]).includes(value);
}

/** Normalize IDs used by older AI Pilot clients and stored conversation rows. */
export function normalizePartnerRole(value: unknown): PartnerRole | null {
  if (isPartnerRole(value)) return value;
  if (typeof value !== "string" || !Object.hasOwn(LEGACY_PARTNER_ROLE_MAP, value)) return null;
  return LEGACY_PARTNER_ROLE_MAP[value as keyof typeof LEGACY_PARTNER_ROLE_MAP];
}

/** Keep the current database check constraint valid until a separately approved migration. */
export function partnerRoleToStoredId(role: PartnerRole): string {
  return STORED_PARTNER_ROLE_MAP[role];
}

export function partnerRoleFromStoredId(value: unknown): PartnerRole | null {
  return normalizePartnerRole(value);
}

function validateStringList(value: unknown, field: string, maximumItems = 50): ValidationResult<string[] | undefined> {
  if (value === undefined) return { success: true, data: undefined };
  if (!Array.isArray(value) || value.length > maximumItems) {
    return { success: false, error: `context.${field} must be an array of at most ${maximumItems} strings.` };
  }
  const items: string[] = [];
  for (const item of value) {
    if (!isNonEmptyString(item, 2000)) {
      return { success: false, error: `Every item in context.${field} must be a non-empty string of at most 2,000 characters.` };
    }
    items.push(item.trim());
  }
  return { success: true, data: items };
}

function validateContext(value: unknown): ValidationResult<AIASKContext | undefined> {
  if (value === undefined) return { success: true, data: undefined };
  if (!isRecord(value)) return { success: false, error: "context must be an object when provided." };

  const context: AIASKContext = {};
  for (const field of ["ideaId", "projectId", "goal"] as const) {
    const item = value[field];
    if (item === undefined) continue;
    if (!isNonEmptyString(item, field === "goal" ? 4000 : 200)) {
      return { success: false, error: `context.${field} must be a non-empty string.` };
    }
    context[field] = item.trim();
  }

  for (const field of ["relevantNotes", "relevantDecisions", "relevantTasks", "relevantCalendarItems"] as const) {
    const result = validateStringList(value[field], field, field === "relevantTasks" || field === "relevantCalendarItems" ? 100 : 50);
    if (!result.success) return result;
    if (result.data !== undefined) context[field] = result.data;
  }

  if (value.userPreferences !== undefined) {
    if (!isRecord(value.userPreferences)) {
      return { success: false, error: "context.userPreferences must be an object when provided." };
    }
    context.userPreferences = value.userPreferences;
  }

  return { success: true, data: context };
}

export function parseAIASKInput(value: unknown): ValidationResult<AIASKInput> {
  if (!isRecord(value)) return { success: false, error: "The AI request must be a JSON object." };

  const partnerRole = normalizePartnerRole(value.partnerRole);
  if (!partnerRole) return { success: false, error: "Choose one of the six supported AI Partner roles." };
  if (!isNonEmptyString(value.userMessage, 4000)) {
    return { success: false, error: "userMessage must contain between 1 and 4,000 characters." };
  }

  let conversationId: string | undefined;
  if (value.conversationId !== undefined) {
    if (typeof value.conversationId !== "string" || !UUID_PATTERN.test(value.conversationId)) {
      return { success: false, error: "conversationId must be a valid conversation ID." };
    }
    conversationId = value.conversationId;
  }

  let responseMode: ResponseMode | undefined;
  if (value.responseMode !== undefined) {
    if (value.responseMode !== "normal" && value.responseMode !== "concise" && value.responseMode !== "detailed") {
      return { success: false, error: "responseMode must be normal, concise, or detailed." };
    }
    responseMode = value.responseMode;
  }

  let locale: string | undefined;
  if (value.locale !== undefined) {
    if (typeof value.locale !== "string" || value.locale.length > 35 || !LOCALE_PATTERN.test(value.locale)) {
      return { success: false, error: "locale must be a valid language tag such as en or en-US." };
    }
    try {
      const [canonicalLocale] = Intl.getCanonicalLocales(value.locale);
      if (!canonicalLocale) return { success: false, error: "locale must be a valid language tag." };
      locale = canonicalLocale;
    } catch {
      return { success: false, error: "locale must be a valid language tag." };
    }
  }

  const context = validateContext(value.context);
  if (!context.success) return context;

  return {
    success: true,
    data: {
      ...(conversationId ? { conversationId } : {}),
      userMessage: value.userMessage.trim(),
      partnerRole,
      ...(context.data ? { context: context.data } : {}),
      ...(responseMode ? { responseMode } : {}),
      ...(locale ? { locale } : {}),
    },
  };
}

function validateFollowUpHistory(value: unknown): ValidationResult<PartnerFollowUpMessage[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    return { success: false, error: "The follow-up conversation must contain between 1 and 8 messages." };
  }
  const history: PartnerFollowUpMessage[] = [];
  for (const item of value) {
    if (!isRecord(item) || (item.role !== "user" && item.role !== "assistant") || !isNonEmptyString(item.content, 1200)) {
      return { success: false, error: "Each follow-up message must have a valid role and 1 to 1,200 characters." };
    }
    history.push({ role: item.role, content: item.content.trim() });
  }
  if (history[history.length - 1].role !== "user") {
    return { success: false, error: "A follow-up question is required." };
  }
  return { success: true, data: history };
}

/** Accept both the Phase 1 shape and the existing { role, idea } AI Pilot payload. */
export function parseAIASKRunRequest(value: unknown): ValidationResult<AIASKRunRequest> {
  if (!isRecord(value)) return { success: false, error: "The AI request must be a JSON object." };

  const isFollowUp = value.mode === "follow_up" || value.role === "partner_follow_up";
  if (value.plannerChat !== undefined && value.plannerChat !== true) {
    return { success: false, error: "plannerChat must be true when provided." };
  }
  if (value.plannerChat === true && !isFollowUp) {
    return { success: false, error: "Planner chat must use the existing follow-up conversation mode." };
  }
  const historyResult = isFollowUp ? validateFollowUpHistory(value.history) : null;
  if (historyResult && !historyResult.success) return historyResult;

  const rawPartnerRole = value.partnerRole ?? (isFollowUp ? value.partnerId : value.role);
  const legacyMessage = isFollowUp
    ? (historyResult?.success ? historyResult.data[historyResult.data.length - 1].content : value.userMessage)
    : value.idea;
  const parsedInput = parseAIASKInput({
    conversationId: value.conversationId,
    userMessage: value.userMessage ?? legacyMessage,
    partnerRole: rawPartnerRole,
    context: value.context,
    responseMode: value.responseMode,
    locale: value.locale,
  });
  if (!parsedInput.success) return parsedInput;

  let retryMessageId: string | undefined;
  if (value.retryMessageId !== undefined) {
    if (typeof value.retryMessageId !== "string" || !UUID_PATTERN.test(value.retryMessageId)) {
      return { success: false, error: "retryMessageId must be a valid message ID." };
    }
    retryMessageId = value.retryMessageId;
  }
  if (retryMessageId && !parsedInput.data.conversationId) {
    return { success: false, error: "A conversation is required to retry this message." };
  }

  if (!isFollowUp) {
    return { success: true, data: { kind: "structured", input: parsedInput.data, ...(retryMessageId ? { retryMessageId } : {}) } };
  }

  const originalIdea = value.originalIdea ?? value.idea;
  if (!isNonEmptyString(originalIdea, 4000)) {
    return { success: false, error: "originalIdea must contain between 1 and 4,000 characters." };
  }
  if (typeof value.perspectiveContext !== "string" || value.perspectiveContext.length > 8000) {
    return { success: false, error: "perspectiveContext must be a string of at most 8,000 characters." };
  }
  if (value.plannerChat === true && parsedInput.data.partnerRole !== PARTNER_ROLE_ID.planner) {
    return { success: false, error: "Planner chat requires the AI Planner role." };
  }

  return {
    success: true,
    data: {
      kind: "follow_up",
      input: parsedInput.data,
      originalIdea: originalIdea.trim(),
      perspectiveContext: value.perspectiveContext,
      history: historyResult && historyResult.success ? historyResult.data : [],
      ...(value.plannerChat === true ? { plannerChat: true } : {}),
      ...(retryMessageId ? { retryMessageId } : {}),
    },
  };
}

function validateStringArray(value: unknown, maximumItems = 50): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems && value.every(item => isNonEmptyString(item, 5000));
}

function validateAIASKSuggestion(value: unknown): value is AIASKSuggestion {
  return isRecord(value)
    && isNonEmptyString(value.title, 300)
    && isNonEmptyString(value.description, 5000)
    && (value.rationale === undefined || isNonEmptyString(value.rationale, 3000));
}

function validateAIASKRisk(value: unknown): value is AIASKRisk {
  return isRecord(value)
    && isNonEmptyString(value.description, 5000)
    && (value.severity === undefined || value.severity === "low" || value.severity === "medium" || value.severity === "high")
    && (value.uncertainty === undefined || isNonEmptyString(value.uncertainty, 3000));
}

function validateProposedAction(value: unknown): value is AIASKProposedAction {
  return isRecord(value)
    && isNonEmptyString(value.title, 300)
    && (value.description === undefined || isNonEmptyString(value.description, 5000))
    && (value.actionType === "create_task" || value.actionType === "create_calendar_event" || value.actionType === "save_note" || value.actionType === "link_idea" || value.actionType === "other")
    && value.requiresConfirmation === true;
}

export function validatePlannerChange(value: unknown): PlannerChange | null {
  if (!isRecord(value)
    || !["none", "create_task", "update_task", "delete_task", "create_calendar_event", "update_calendar_event", "delete_calendar_event"].includes(String(value.action))) return null;
  const nullableText = (item: unknown, maximumLength: number) => item === null || isNonEmptyString(item, maximumLength);
  const nullableDate = (item: unknown) => item === null || (
    typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item)
    && Number.isFinite(Date.parse(`${item}T12:00:00`))
    && new Date(`${item}T12:00:00`).toISOString().slice(0, 10) === item
  );
  const nullableTime = (item: unknown) => item === null || (typeof item === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(item));
  if (!nullableText(value.targetId, 200)
    || !Array.isArray(value.fields)
    || value.fields.some(field => !["title", "dueDate", "scheduledDate", "scheduledTime", "status", "priority", "ideaId"].includes(String(field)))
    || new Set(value.fields).size !== value.fields.length
    || !nullableText(value.title, 300)
    || !nullableDate(value.dueDate)
    || !nullableDate(value.scheduledDate)
    || !nullableTime(value.scheduledTime)
    || (value.status !== null && value.status !== "Open" && value.status !== "Done")
    || (value.priority !== null && value.priority !== "urgent" && value.priority !== "attention" && value.priority !== "onTrack")
    || !nullableText(value.ideaId, 200)) return null;

  const action = value.action as PlannerChange["action"];
  if (action === "none") {
    if (value.fields.length !== 0 || [value.targetId, value.title, value.dueDate, value.scheduledDate, value.scheduledTime, value.status, value.priority, value.ideaId].some(item => item !== null)) return null;
  } else if (action === "create_task" || action === "create_calendar_event") {
    if (value.targetId !== null || value.fields.length !== 0 || !isNonEmptyString(value.title, 300)) return null;
    if (action === "create_calendar_event" && !nullableDate(value.scheduledDate)) return null;
  } else if (action === "delete_task" || action === "delete_calendar_event") {
    if (value.fields.length !== 0 || !isNonEmptyString(value.targetId, 200)) return null;
  } else {
    if (!isNonEmptyString(value.targetId, 200)) return null;
    if (value.fields.length === 0) return null;
    const applicableFields = action === "update_task"
      ? ["title", "dueDate", "status", "priority", "ideaId"]
      : ["title", "scheduledDate", "scheduledTime", "priority", "ideaId"];
    if (value.fields.some(field => !applicableFields.includes(field))) return null;
    if (value.fields.includes("title") && !isNonEmptyString(value.title, 300)) return null;
    if (value.fields.includes("dueDate") && !nullableDate(value.dueDate)) return null;
    if (value.fields.includes("scheduledDate") && !nullableDate(value.scheduledDate)) return null;
    if (value.fields.includes("scheduledTime") && !nullableTime(value.scheduledTime)) return null;
    if (value.fields.includes("status") && value.status === null) return null;
    if (value.fields.includes("priority") && value.priority === null) return null;
    if (action === "update_calendar_event" && value.fields.includes("scheduledDate") && value.scheduledDate === null) return null;
  }

  return { ...value, fields: value.fields as PlannerChange["fields"] } as PlannerChange;
}

export function validatePartnerResponse(value: unknown): PartnerResponse | null {
  if (!isRecord(value)
    || !isNonEmptyString(value.perspective, 1800)
    || !validateStringArray(value.questions, 3)
    || value.questions.length < 1
    || !validateStringArray(value.risks, 3)
    || value.risks.length < 1
    || !validateStringArray(value.opportunities, 3)
    || value.opportunities.length < 1
    || !isNonEmptyString(value.nextStep, 1000)
    || !validateStringArray(value.uncertainty, 3)
    || value.uncertainty.length < 1) return null;

  return {
    perspective: value.perspective.trim(),
    questions: value.questions.map(item => item.trim()),
    risks: value.risks.map(item => item.trim()),
    opportunities: value.opportunities.map(item => item.trim()),
    nextStep: value.nextStep.trim(),
    uncertainty: value.uncertainty.map(item => item.trim()),
  };
}

export function validateAIASKOutput(value: unknown): AIASKOutput | null {
  if (!isRecord(value) || !isPartnerRole(value.partnerRole) || !isRecord(value.response)) return null;
  if (!isNonEmptyString(value.response.summary, 5000) || !isNonEmptyString(value.response.content, 20000)) return null;
  if (value.role !== undefined && value.role !== value.partnerRole) return null;
  if (value.conversationId !== undefined && (typeof value.conversationId !== "string" || !UUID_PATTERN.test(value.conversationId))) return null;
  if (value.messageId !== undefined && !isNonEmptyString(value.messageId, 128)) return null;
  if (value.userMessageId !== undefined && !isNonEmptyString(value.userMessageId, 128)) return null;
  if (value.result !== undefined && !validatePartnerResponse(value.result)) return null;
  if (value.answer !== undefined && !isNonEmptyString(value.answer, 20000)) return null;
  if (value.saved !== undefined && typeof value.saved !== "boolean") return null;
  if (value.model !== undefined && !isNonEmptyString(value.model, 120)) return null;
  if (value.questions !== undefined && !validateStringArray(value.questions)) return null;
  if (value.uncertainty !== undefined && !validateStringArray(value.uncertainty)) return null;
  if (value.suggestions !== undefined && (!Array.isArray(value.suggestions) || value.suggestions.length > 50 || !value.suggestions.every(validateAIASKSuggestion))) return null;
  if (value.risks !== undefined && (!Array.isArray(value.risks) || value.risks.length > 50 || !value.risks.every(validateAIASKRisk))) return null;
  if (value.proposedActions !== undefined && (!Array.isArray(value.proposedActions) || value.proposedActions.length > 50 || !value.proposedActions.every(validateProposedAction))) return null;
  if (value.plannerChange !== undefined && !validatePlannerChange(value.plannerChange)) return null;
  if (value.knowledgeReferences !== undefined) {
    if (!Array.isArray(value.knowledgeReferences) || value.knowledgeReferences.length > 100) return null;
    for (const reference of value.knowledgeReferences) {
      if (!isRecord(reference) || !isNonEmptyString(reference.title, 500)) return null;
      if (reference.url !== undefined) {
        if (typeof reference.url !== "string") return null;
        try {
          const url = new URL(reference.url);
          if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        } catch {
          return null;
        }
      }
      if (reference.sourceType !== undefined && !isNonEmptyString(reference.sourceType, 120)) return null;
    }
  }
  if (value.handoff !== undefined) {
    if (!isRecord(value.handoff) || !isNonEmptyString(value.handoff.reason, 3000)) return null;
    if (value.handoff.recommendedRole !== undefined && !isPartnerRole(value.handoff.recommendedRole)) return null;
  }
  if (value.usage !== undefined) {
    if (!isRecord(value.usage)) return null;
    for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
      const tokens = value.usage[key];
      if (tokens !== undefined && tokens !== null && (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0)) return null;
    }
  }

  return value as AIASKOutput;
}

export function isPartnerResponse(value: unknown): value is PartnerResponse {
  return validatePartnerResponse(value) !== null;
}
