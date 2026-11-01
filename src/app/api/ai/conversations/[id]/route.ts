import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "../../../../../lib/supabase/server";
import { isSupabaseConfigured } from "../../../../../lib/supabase/config";
import { formatPartnerResponse, isPartnerResponse, type ConversationMessageKind } from "../../../../../lib/ai/conversations";
import { partnerRoleFromStoredId } from "../../../../../lib/ai/contracts";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingConversationSchema(error: { code?: string; message?: string } | null) {
  return Boolean(error && (error.code === "42P01" || error.code === "PGRST205" || error.message?.includes("ai_conversation")));
}

async function getUserClient() {
  if (!isSupabaseConfigured()) return { error: jsonError(503, "auth_not_configured", "Sign-in storage is not configured.") };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return { error: jsonError(401, "sign_in_required", "Sign in to view AI conversations.") };
    return { supabase, userId: data.user.id };
  } catch {
    return { error: jsonError(503, "auth_unavailable", "Account sign-in could not be verified right now.") };
  }
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const auth = await getUserClient();
  if ("error" in auth) return auth.error;
  const { id } = await context.params;

  try {
    const { data: conversation, error: conversationError } = await auth.supabase
      .from("ai_conversations")
      .select("id,title,idea_id,project_id,partner_role,is_favorite,created_at,updated_at")
      .eq("id", id)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (conversationError) throw conversationError;
    if (!conversation) return jsonError(404, "conversation_not_found", "This conversation could not be found.");
    const partnerRole = partnerRoleFromStoredId(conversation.partner_role);
    if (!partnerRole) return jsonError(500, "conversation_role_invalid", "This conversation uses an unsupported AI Partner role.");

    const { data: messages, error: messagesError } = await auth.supabase
      .from("ai_conversation_messages")
      .select("id,role,content,kind,status,metadata,created_at")
      .eq("conversation_id", id)
      .eq("user_id", auth.userId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (messagesError) throw messagesError;

    return NextResponse.json({ conversation: {
      id: conversation.id,
      title: conversation.title,
      ideaId: conversation.idea_id,
      projectId: conversation.project_id,
      partnerRole,
      isFavorite: conversation.is_favorite,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
      messages: (messages ?? []).map(message => ({
        id: message.id,
        role: message.role,
        content: message.content,
        kind: message.kind,
        status: message.status,
        metadata: message.metadata,
        createdAt: message.created_at,
      })),
    } });
  } catch (error) {
    const dbError = error as { code?: string; message?: string };
    if (isMissingConversationSchema(dbError)) {
      return jsonError(503, "conversation_storage_unavailable", "Apply the AI Pilot conversation migration in Supabase, then reload this page.");
    }
    console.error("ai.conversation.read.failed", { userId: auth.userId, code: dbError.code ?? null });
    return jsonError(500, "conversation_read_failed", "This AI conversation could not be opened.");
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await getUserClient();
  if ("error" in auth) return auth.error;
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_json", "The request body must be valid JSON.");
  }
  if (!isRecord(body) || body.action !== "retry_save" || typeof body.userMessageId !== "string" || !isRecord(body.reply)) {
    return jsonError(400, "invalid_request", "The save retry request is invalid.");
  }

  const reply = body.reply;
  const kind = reply.kind;
  let content: string;
  const metadata: Record<string, unknown> = {};
  if (kind === "structured_response" && isPartnerResponse(reply.result)) {
    content = formatPartnerResponse(reply.result);
    metadata.structuredResponse = reply.result;
  } else if (kind === "follow_up" && typeof reply.answer === "string" && reply.answer.trim().length > 0 && reply.answer.length <= 5000) {
    content = reply.answer.trim();
  } else {
    return jsonError(400, "invalid_reply", "The saved AI response is invalid.");
  }
  const model = typeof reply.model === "string" ? reply.model.trim().slice(0, 120) : "AI model";
  metadata.model = model || "AI model";
  if (isRecord(reply.usage)) {
    const usage: Record<string, number | null> = {};
    for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
      const value = reply.usage[key];
      usage[key] = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    }
    metadata.usage = usage;
  }

  try {
    const { data: conversation, error: conversationError } = await auth.supabase
      .from("ai_conversations")
      .select("id")
      .eq("id", id)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (conversationError) throw conversationError;
    if (!conversation) return jsonError(404, "conversation_not_found", "This conversation could not be found.");

    const { data: userMessage, error: userMessageError } = await auth.supabase
      .from("ai_conversation_messages")
      .select("id,role,status")
      .eq("id", body.userMessageId)
      .eq("conversation_id", id)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (userMessageError) throw userMessageError;
    if (!userMessage || userMessage.role !== "user") return jsonError(404, "message_not_found", "The question for this reply could not be found.");
    if (userMessage.status !== "save_failed" && userMessage.status !== "completed") {
      return jsonError(409, "message_not_retryable", "This response does not need a save retry.");
    }

    const { error: replyError } = await auth.supabase.from("ai_conversation_messages").upsert({
      conversation_id: id,
      user_id: auth.userId,
      role: "assistant",
      content,
      kind: kind as ConversationMessageKind,
      status: "completed",
      metadata,
      reply_to_message_id: userMessage.id,
    }, { onConflict: "reply_to_message_id" });
    if (replyError) throw replyError;

    const now = new Date().toISOString();
    const { error: updateMessageError } = await auth.supabase.from("ai_conversation_messages")
      .update({ status: "completed" })
      .eq("id", userMessage.id)
      .eq("conversation_id", id)
      .eq("user_id", auth.userId);
    if (updateMessageError) throw updateMessageError;
    const { error: updateConversationError } = await auth.supabase.from("ai_conversations")
      .update({ updated_at: now })
      .eq("id", id)
      .eq("user_id", auth.userId);
    if (updateConversationError) throw updateConversationError;

    return NextResponse.json({ saved: true, conversationId: id, userMessageId: userMessage.id });
  } catch (error) {
    const dbError = error as { code?: string; message?: string };
    if (isMissingConversationSchema(dbError)) {
      return jsonError(503, "conversation_storage_unavailable", "Apply the AI Pilot conversation migration in Supabase, then retry saving.");
    }
    console.error("ai.conversation.save_retry.failed", { userId: auth.userId, conversationId: id, code: dbError.code ?? null });
    return jsonError(503, "conversation_save_failed", "Save failed. Your generated answer is still on this page; retry when storage is available.");
  }
}
