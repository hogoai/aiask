import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "../../../../lib/supabase/server";
import { isSupabaseConfigured } from "../../../../lib/supabase/config";
import { AIConfigurationError, AIProviderError, rephraseDailyQuestion, runPartnerFollowUpWithOpenAI, runPartnerWithOpenAI, summarizeWeeklyReview } from "../../../../lib/ai/openai";
import { isAppLocale } from "../../../../i18n/config";
import { isObject } from "../../../../lib/workspace/browser-records";
import { isDailyQuestionKind } from "../../../../lib/workspace/daily-question";
import { parseWeeklyCoachFacts } from "../../../../lib/workspace/weekly-coach";
import { getAuthorizedWorkspaceIdeas, MAX_AUTHORIZED_WORKSPACE_IDEAS } from "../../../../lib/workspace/authorized-ideas";
import { WorkspaceResolutionError } from "../../../../lib/workspace/server";
import { formatPartnerResponse, titleFromIdea } from "../../../../lib/ai/conversations";
import {
  PARTNER_ROLE_ID,
  parseAIASKRunRequest,
  partnerRoleFromStoredId,
  partnerRoleToStoredId,
  validateAIASKOutput,
  type PartnerFollowUpMessage,
  type NotesChatAction,
  type PartnerRole,
  validateNotesChatActions,
  verifiedNotesContextNoteIds,
} from "../../../../lib/ai/contracts";

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 72 * 1024;
const RATE_LIMIT_COUNT = 60;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const requestsByUser = new Map<string, number[]>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestLimitForAccount(email: string | undefined) {
  if (!email) return RATE_LIMIT_COUNT;
  try {
    const overrides: unknown = JSON.parse(process.env.AI_RATE_LIMIT_OVERRIDES || "{}");
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return RATE_LIMIT_COUNT;
    const accountEmail = email.trim().toLowerCase();
    const entry = Object.entries(overrides).find(([key]) => key.trim().toLowerCase() === accountEmail);
    const limit: unknown = entry?.[1];
    return typeof limit === "number" && Number.isInteger(limit) && limit > 0 && limit <= 1000
      ? limit
      : RATE_LIMIT_COUNT;
  } catch {
    return RATE_LIMIT_COUNT;
  }
}

class RequestTooLargeError extends Error {}

function jsonError(status: number, code: string, message: string, headers?: HeadersInit, details?: Record<string, unknown>) {
  return NextResponse.json({ error: { code, message }, ...details }, { status, headers });
}

async function readLimitedBody(request: NextRequest) {
  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_REQUEST_BYTES) throw new RequestTooLargeError();
  if (!request.body) throw new SyntaxError("Missing request body");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RequestTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function consumeRateLimit(userId: string, requestLimit: number) {
  const now = Date.now();
  const recent = (requestsByUser.get(userId) ?? []).filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= requestLimit) {
    requestsByUser.set(userId, recent);
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - recent[0])) / 1000)) };
  }
  recent.push(now);
  requestsByUser.set(userId, recent);
  return { allowed: true, retryAfter: 0 };
}

function isMissingConversationSchema(error: { code?: string; message?: string } | null) {
  return Boolean(error && (error.code === "42P01" || error.code === "PGRST205" || error.message?.includes("ai_conversation")));
}

function noteIdsInContext(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isObject(parsed) || !Array.isArray(parsed.records)) return new Set<string>();
    return new Set(parsed.records.flatMap(record => isObject(record) && typeof record.id === "string" ? [record.id] : []));
  } catch {
    return new Set<string>();
  }
}

async function setUserMessageStatus(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, messageId: string, status: "pending" | "completed" | "failed" | "save_failed") {
  return supabase.from("ai_conversation_messages")
    .update({ status })
    .eq("id", messageId)
    .eq("user_id", userId);
}

async function saveAssistantMessage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  conversationId: string,
  userMessageId: string,
  kind: "structured_response" | "follow_up",
  content: string,
  metadata: Record<string, unknown>,
) {
  const { error: replyError } = await supabase.from("ai_conversation_messages").upsert({
    conversation_id: conversationId,
    user_id: userId,
    role: "assistant",
    content,
    kind,
    status: "completed",
    metadata,
    reply_to_message_id: userMessageId,
  }, { onConflict: "reply_to_message_id" });
  if (replyError) {
    await setUserMessageStatus(supabase, userId, userMessageId, "save_failed");
    return false;
  }

  const { error: userMessageError } = await setUserMessageStatus(supabase, userId, userMessageId, "completed");
  const { error: conversationError } = await supabase.from("ai_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("user_id", userId);
  if (userMessageError || conversationError) {
    await setUserMessageStatus(supabase, userId, userMessageId, "save_failed");
    return false;
  }
  return true;
}

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) {
    return jsonError(503, "auth_not_configured", "Connect Supabase before using live AI.");
  }

  let userId: string;
  let userEmail: string | undefined;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return jsonError(401, "sign_in_required", "Sign in to use the AI Team.");
    userId = data.user.id;
    userEmail = data.user.email;
  } catch {
    return jsonError(503, "auth_unavailable", "Account sign-in could not be verified right now.");
  }

  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return jsonError(415, "content_type_required", "Send this request as JSON.");
  }

  let body: unknown;
  try {
    body = await readLimitedBody(request);
  } catch (error) {
    if (error instanceof RequestTooLargeError) return jsonError(413, "request_too_large", "The idea or conversation context is too long. Shorten it and try again.");
    return jsonError(400, "invalid_json", "The request body must be valid JSON.");
  }

  if (isObject(body) && body.mode === "daily_question") {
    const { kind, locale } = body;
    if (!isDailyQuestionKind(kind) || !isAppLocale(locale) ||
      Object.keys(body).some(key => !["mode", "kind", "locale", "expectedUserId"].includes(key)) ||
      typeof body.expectedUserId !== "string") {
      return jsonError(400, "invalid_daily_question", "Choose a supported question type and language.");
    }
    if (body.expectedUserId !== userId) return jsonError(409, "account_changed", "Reopen My Workspace after changing accounts.");
    const limit = consumeRateLimit(userId, requestLimitForAccount(userEmail));
    if (!limit.allowed) {
      return jsonError(429, "rate_limited", "The current AI request limit has been reached.", { "Retry-After": String(limit.retryAfter) });
    }
    try {
      const { question, model, usage } = await rephraseDailyQuestion(kind, request.signal);
      console.info("ai.daily_question.completed", { kind, model, ...usage });
      return NextResponse.json({ question }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return jsonError(error instanceof AIConfigurationError ? 503 : 502, "daily_question_unavailable", "The original question is still available.");
    }
  }

  if (isObject(body) && body.mode === "weekly_review") {
    const facts = parseWeeklyCoachFacts(body.facts);
    const { locale } = body;
    if (!facts || !isAppLocale(locale) || typeof body.expectedUserId !== "string" ||
      !Object.values(facts.counts).some(count => count > 0) ||
      Object.keys(body).some(key => !["mode", "facts", "locale", "expectedUserId"].includes(key))) {
      return jsonError(400, "invalid_weekly_review", "The review must contain supported dates, counts, and language.");
    }
    if (body.expectedUserId !== userId) return jsonError(409, "account_changed", "Reopen My Workspace after changing accounts.");
    const limit = consumeRateLimit(userId, requestLimitForAccount(userEmail));
    if (!limit.allowed) return jsonError(429, "rate_limited", "The current AI request limit has been reached.", { "Retry-After": String(limit.retryAfter) });
    try {
      const { summary, model, usage } = await summarizeWeeklyReview(facts, request.signal);
      console.info("ai.weekly_review.completed", { model, ...usage });
      return NextResponse.json({ summary }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return jsonError(error instanceof AIConfigurationError ? 503 : 502, "weekly_review_unavailable", "Your local weekly review is still available.");
    }
  }

  // Match the existing daily/weekly guard for user-initiated Coach handoffs before any history/model writes.
  if (isObject(body) && body.expectedUserId !== undefined) {
    if (typeof body.expectedUserId !== "string") return jsonError(400, "invalid_request", "Expected account ID must be a string.");
    if (body.expectedUserId !== userId) return jsonError(409, "account_changed", "Reopen My Workspace after changing accounts.");
  }
  const parsedRequest = parseAIASKRunRequest(body);
  if (!parsedRequest.success) return jsonError(400, "invalid_request", parsedRequest.error);

  const runRequest = parsedRequest.data;
  const followUp = runRequest.kind === "follow_up" ? runRequest : null;
  const livePartnerId: PartnerRole | null = runRequest.kind === "structured" ? runRequest.input.partnerRole : null;
  let idea = followUp?.originalIdea ?? runRequest.input.userMessage;
  let notesContextMarker: string | null = followUp?.notesContextKey
    ? `AIASK context scope: ${followUp.notesContextKey}`
    : null;
  if (followUp?.workspaceNotesScope) {
    if (runRequest.input.context?.ideaId) {
      return jsonError(400, "invalid_workspace_scope", "Workspace Notes cannot be combined with a selected Note reference.");
    }
    try {
      const authorized = await getAuthorizedWorkspaceIdeas();
      if (!authorized.complete) {
        return jsonError(413, "workspace_context_too_large", `This Workspace has more than ${MAX_AUTHORIZED_WORKSPACE_IDEAS} notes. Choose Current View or Selected Note.`);
      }
      const perspectiveContext = JSON.stringify({
        scope: "Authorized Workspace Notes",
        source: `Server-verified notes from the current personal Workspace: ${authorized.workspace.name}`,
        recordCount: authorized.notes.length,
        records: authorized.notes,
      });
      if (perspectiveContext.length > 8000) {
        return jsonError(413, "workspace_context_too_large", "These Workspace Notes exceed the AI context limit. Choose Current View or Selected Note, or shorten the saved notes.");
      }
      idea = `Authorized Workspace Notes (${authorized.notes.length} records)`;
      followUp.originalIdea = idea;
      followUp.perspectiveContext = perspectiveContext;
      notesContextMarker = "AIASK context scope: authorized personal Workspace Notes.";
    } catch (error) {
      if (error instanceof WorkspaceResolutionError) {
        const status = error.code === "sign_in_required" ? 401 : 503;
        return jsonError(status, error.code, error.message);
      }
      const dbError = error as { code?: string };
      console.error("ai.workspace_notes.context.failed", { userId, code: dbError.code ?? null });
      return jsonError(503, "workspace_context_unavailable", "Authorized Workspace Notes could not be verified, so no note context was sent to the model.");
    }
  }
  if (followUp?.notesChat && !followUp.workspaceNotesScope
    && (!followUp.notesContextKey || !verifiedNotesContextNoteIds(followUp.perspectiveContext, followUp.notesContextKey))) {
    return jsonError(400, "invalid_notes_context", "The selected note or visible Notes & Ideas view could not be verified. Reload the view and try again.");
  }
  const requestRole = runRequest.input.partnerRole;
  const notesContextNoteIds = followUp?.notesChat
    ? [...noteIdsInContext(followUp.perspectiveContext)].slice(0, MAX_AUTHORIZED_WORKSPACE_IDEAS)
    : [];
  const requestedConversationId = runRequest.input.conversationId ?? null;
  const requestedIdeaId = runRequest.input.context?.ideaId ?? null;
  const linkedIdeaId = requestedIdeaId && UUID_PATTERN.test(requestedIdeaId) ? requestedIdeaId : null;
  const retryMessageId = runRequest.retryMessageId ?? null;

  let conversationId = requestedConversationId;
  let userMessageId: string | null = null;
  let createdConversation = false;
  const userMessageContent = followUp ? followUp.input.userMessage : runRequest.input.userMessage;
  try {
    if (conversationId) {
      const { data: conversation, error } = await (await createClient()).from("ai_conversations")
        .select("id,partner_role,idea_id")
        .eq("id", conversationId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      if (!conversation) return jsonError(404, "conversation_not_found", "This conversation could not be found.");
      if (partnerRoleFromStoredId(conversation.partner_role) !== requestRole) return jsonError(409, "conversation_partner_mismatch", "This conversation belongs to a different AI Team role.");
      if (linkedIdeaId && conversation.idea_id !== linkedIdeaId) return jsonError(409, "conversation_note_mismatch", "This conversation belongs to a different note. Start a new AI Team chat for this note.");
      if (notesContextMarker) {
        const { data: scopeMessage, error: scopeError } = await (await createClient()).from("ai_conversation_messages")
          .select("content")
          .eq("conversation_id", conversationId)
          .eq("user_id", userId)
          .eq("kind", "idea")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (scopeError) throw scopeError;
        const legacySelectedNote = Boolean(linkedIdeaId && conversation.idea_id === linkedIdeaId && followUp?.notesContextKey?.startsWith("selected-note-"));
        if (scopeMessage?.content !== notesContextMarker && !legacySelectedNote) {
          return jsonError(409, "conversation_context_mismatch", "This conversation was started with a different context scope. Start a new AI Team chat for Workspace Notes.");
        }
      }
    } else {
      const supabase = await createClient();
      const { data: conversation, error } = await supabase.from("ai_conversations").insert({
        user_id: userId,
        title: titleFromIdea(idea),
        partner_role: partnerRoleToStoredId(requestRole),
        ...(linkedIdeaId ? { idea_id: linkedIdeaId } : {}),
      }).select("id").single();
      if (error) throw error;
      conversationId = conversation.id;
      createdConversation = true;
    }

    const supabase = await createClient();
    if (retryMessageId) {
      const { data: message, error } = await supabase.from("ai_conversation_messages")
        .select("id,role,status")
        .eq("id", retryMessageId)
        .eq("conversation_id", conversationId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      if (!message || message.role !== "user" || (message.status !== "failed" && message.status !== "save_failed")) {
        return jsonError(409, "message_not_retryable", "This AI request is not available for retry.");
      }
      const { error: updateError } = await setUserMessageStatus(supabase, userId, message.id, "pending");
      if (updateError) throw updateError;
      userMessageId = message.id;
    } else {
      if (createdConversation && followUp && !followUp.plannerChat) {
        const { error: ideaError } = await supabase.from("ai_conversation_messages").insert({
          conversation_id: conversationId,
          user_id: userId,
          role: "user",
          content: notesContextMarker ?? idea,
          kind: "idea",
          status: "completed",
          ...(followUp.notesChat ? { metadata: { notesContext: {
            scope: followUp.workspaceNotesScope ? "authorized-workspace-notes" : followUp.notesContextKey?.startsWith("selected-note-") ? "selected-note" : "current-view",
            noteIds: notesContextNoteIds,
          } } } : {}),
        });
        if (ideaError) throw ideaError;
      }
      const { data: message, error } = await supabase.from("ai_conversation_messages").insert({
        conversation_id: conversationId,
        user_id: userId,
        role: "user",
        content: userMessageContent,
        kind: followUp || !createdConversation ? "follow_up" : "idea",
        status: "pending",
      }).select("id").single();
      if (error) throw error;
      userMessageId = message.id;
    }
  } catch (error) {
    const dbError = error as { code?: string; message?: string };
    if (createdConversation && conversationId) {
      const supabase = await createClient().catch(() => null);
      if (supabase) await supabase.from("ai_conversations").delete().eq("id", conversationId).eq("user_id", userId);
    }
    if (isMissingConversationSchema(dbError)) {
      return jsonError(503, "conversation_storage_unavailable", "Apply the AI Pilot conversation migration in Supabase before using live AI.");
    }
    console.error("ai.conversation.user_message_save.failed", { userId, role: requestRole, code: dbError.code ?? null });
    return jsonError(503, "conversation_save_failed", "Your message could not be saved, so the AI request was not sent. Retry when storage is available.");
  }

  if (!conversationId || !userMessageId) {
    return jsonError(503, "conversation_save_failed", "Your message could not be saved, so the AI request was not sent.");
  }

  const supabase = await createClient();
  const limit = consumeRateLimit(userId, requestLimitForAccount(userEmail));
  if (!limit.allowed) {
    await setUserMessageStatus(supabase, userId, userMessageId, "failed");
    return jsonError(429, "rate_limited", "You've reached the current AI request limit. Your question was saved; try again later.", {
      "Retry-After": String(limit.retryAfter),
    }, { conversationId, userMessageId, historySaved: true });
  }

  const startedAt = Date.now();
  try {
    if (followUp) {
      const { data: storedMessages, error: historyError } = await supabase.from("ai_conversation_messages")
        .select("role,content,status,kind")
        .eq("conversation_id", conversationId)
        .eq("user_id", userId)
        .in("status", ["completed", "pending"])
        .order("created_at", { ascending: false })
        .limit(8);
      if (historyError) throw historyError;
      const storedHistory: PartnerFollowUpMessage[] = (storedMessages ?? [])
        .filter(message => message.kind !== "idea")
        .reverse()
        .map(message => ({ role: message.role as "user" | "assistant", content: message.content }));
      const completion = await runPartnerFollowUpWithOpenAI(
        followUp.input,
        followUp.originalIdea,
        followUp.perspectiveContext,
        storedHistory,
        followUp.plannerChat === true,
        followUp.notesChat === true,
      );
      const allowedNoteIds = noteIdsInContext(followUp.perspectiveContext);
      const notesActions: NotesChatAction[] | null = followUp.notesChat
        ? validateNotesChatActions(completion.notesActions, allowedNoteIds)
        : null;
      if (followUp.notesChat && !notesActions) throw new AIProviderError("The model provider returned an invalid Notes chat response.");
      const outputCandidate = {
        partnerRole: requestRole,
        role: requestRole,
        response: { summary: completion.answer.slice(0, 5000), content: completion.answer },
        answer: completion.answer,
        ...(followUp.plannerChat && completion.plannerChange ? { plannerChange: completion.plannerChange } : {}),
        ...(followUp.notesChat ? { suggestions: notesActions ?? [] } : {}),
        usage: completion.usage,
        model: completion.model,
        conversationId,
        userMessageId,
        saved: false,
      };
      if (!validateAIASKOutput(outputCandidate)) throw new AIProviderError("The model provider returned an invalid response.");
      const saved = await saveAssistantMessage(
        supabase,
        userId,
        conversationId,
        userMessageId,
        "follow_up",
        completion.answer,
        {
          model: completion.model,
          usage: completion.usage,
          ...(followUp.plannerChat && completion.plannerChange ? { plannerChange: completion.plannerChange } : {}),
          ...(followUp.notesChat ? { notesActions: notesActions ?? [] } : {}),
        },
      );
      console.info(`ai.request.completed ${JSON.stringify({
        userId,
        role: requestRole,
        mode: "follow_up",
        answerCharacters: completion.answer.length,
        model: completion.model,
        status: saved ? "completed" : "history_save_failed",
        ...completion.usage,
        durationMs: Date.now() - startedAt,
      })}`);
      return NextResponse.json({ ...outputCandidate, saved });
    }

    if (!livePartnerId) return jsonError(400, "invalid_partner", "Choose a supported AI Team role.");
    const completion = await runPartnerWithOpenAI(runRequest.input);
    const responseContent = formatPartnerResponse(completion.result);
    const outputCandidate = {
      partnerRole: livePartnerId,
      role: livePartnerId,
      response: { summary: completion.result.perspective, content: responseContent },
      result: completion.result,
      usage: completion.usage,
      model: completion.model,
      conversationId,
      userMessageId,
      saved: false,
    };
    if (!validateAIASKOutput(outputCandidate)) throw new AIProviderError("The model provider returned an invalid response.");
    const saved = await saveAssistantMessage(
      supabase,
      userId,
      conversationId,
      userMessageId,
      "structured_response",
      responseContent,
      { model: completion.model, usage: completion.usage, structuredResponse: completion.result },
    );
    console.info("ai.request.completed", {
      userId,
      role: livePartnerId,
      model: completion.model,
      status: saved ? "completed" : "history_save_failed",
      ...completion.usage,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ ...outputCandidate, saved });
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    await setUserMessageStatus(supabase, userId, userMessageId, "failed");
    await supabase.from("ai_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId).eq("user_id", userId);
    const retryDetails = { conversationId, userMessageId, historySaved: true };
    if (error instanceof AIConfigurationError) {
      console.warn("ai.request.unavailable", { userId, role: requestRole, status: "configuration_missing", durationMs: elapsed });
      return jsonError(503, "ai_not_configured", "The server DeepSeek API key is missing. Add DEEPSEEK_API_KEY to .env.local and restart the server.", undefined, retryDetails);
    }
    if (error instanceof AIProviderError) {
      console.warn(`ai.request.failed ${JSON.stringify({
        role: requestRole,
        providerStatus: error.status ?? null,
        providerReason: error.providerReason ?? null,
        providerDiagnostics: error.providerDiagnostics ?? null,
        providerFailure: error.message.slice(0, 180),
        durationMs: elapsed,
      })}`);
      if (error.status === 504) return jsonError(504, "ai_timeout", "The AI request took too long. Your question was saved and can be retried.", undefined, retryDetails);
      if (error.status === 429) return jsonError(503, "provider_busy", "The AI provider is busy or has reached its usage limit. Your question was saved and can be retried.", undefined, retryDetails);
      if (error.status === 401) return jsonError(502, "provider_auth_failed", "The model provider rejected the configured key. Your question was saved and can be retried after checking the provider settings.", undefined, retryDetails);
      if (error.status === 402) return jsonError(503, "provider_balance_required", "The model provider account may need balance or quota. Your question was saved and can be retried later.", undefined, retryDetails);
      if (error.status === 400) return jsonError(502, "provider_request_invalid", "The model provider rejected this request. Your question was saved; check whether the selected model supports the Responses API.", undefined, retryDetails);
      if (error.status === 404) return jsonError(502, "model_unavailable", "This model is not available on the selected API endpoint. Your question was saved and can be retried with a supported model.", undefined, retryDetails);
      if (error.status === 422 && error.providerDiagnostics?.responseStatus === "incomplete") {
        if (error.providerReason === "max_output_tokens") {
          return jsonError(502, "provider_output_limit", "DeepSeek reached its answer-length limit before finishing. Try asking for a shorter answer or narrowing the records, then retry.", undefined, retryDetails);
        }
        if (error.providerReason === "content_filter") {
          return jsonError(502, "provider_content_filter", "DeepSeek's content filter stopped this response. Rephrase the question or ask about fewer records, then retry.", undefined, retryDetails);
        }
        const reason = error.providerReason && /^[a-z0-9_-]{1,64}$/i.test(error.providerReason)
          ? ` (provider reason: ${error.providerReason})`
          : " (provider reason not reported)";
        return jsonError(502, "provider_response_incomplete", `DeepSeek returned an incomplete response${reason}. Your question was saved and can be retried.`, undefined, retryDetails);
      }
      if (error.status === 422) {
        const code = error.providerDiagnostics?.providerHttpError?.code;
        const codeSuffix = code && /^[a-z0-9_-]{1,64}$/i.test(code) ? ` (${code})` : "";
        return jsonError(502, "provider_request_invalid", `DeepSeek rejected this request${codeSuffix}. The request format was recorded for diagnosis; your question was saved.`, undefined, retryDetails);
      }
      if (error.status === 500 || error.status === 503) return jsonError(503, "provider_unavailable", "DeepSeek is temporarily unavailable. Your question was saved and can be retried shortly.", undefined, retryDetails);
      if (error.status === 403) return jsonError(502, "provider_access_denied", "DeepSeek denied this request. Check the API key and account access, then retry.", undefined, retryDetails);
      const outputErrors: Record<string, string> = {
        "The model provider could not be reached.": "DeepSeek could not be reached. Your question was saved and can be retried.",
        "The model provider returned invalid planner JSON.": "DeepSeek responded, but the Planner answer was not valid JSON. Your question was saved and can be retried.",
        "The model provider returned invalid Notes chat JSON.": "DeepSeek responded, but the Notes & Ideas answer was not valid JSON. Your question was saved and can be retried.",
        "The model provider returned no Notes chat response.": "DeepSeek returned no Notes & Ideas answer. Your question was saved and can be retried.",
        "The model provider returned an invalid Notes chat response.": "DeepSeek's Notes & Ideas answer did not match the required format. Your question was saved and can be retried.",
        "The model provider returned no planner response.": "DeepSeek responded without the required Planner answer. Your question was saved and can be retried.",
        "The model provider returned an invalid planner response.": "DeepSeek responded, but its Planner answer did not match the required format. Your question was saved and can be retried.",
        "The model provider returned no follow-up text.": "DeepSeek returned an empty answer. Your question was saved and can be retried.",
      };
      const outputError = outputErrors[error.message];
      if (outputError) return jsonError(502, "provider_output_invalid", outputError, undefined, retryDetails);
      return jsonError(502, "ai_request_failed", "The AI Team role could not complete this request. Your question was saved and can be retried.", undefined, retryDetails);
    }
    console.error("ai.request.failed", { userId, role: requestRole, status: "unexpected_error", durationMs: elapsed });
    return jsonError(500, "unexpected_error", "Something went wrong while preparing the AI response. Your question was saved and can be retried.", undefined, retryDetails);
  }
}
