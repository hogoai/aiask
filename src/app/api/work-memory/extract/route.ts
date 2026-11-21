import { NextRequest, NextResponse } from "next/server";
import { AIConfigurationError, AIProviderError, extractWorkMemoryWithOpenAI } from "../../../../lib/ai/openai";
import { isSupabaseConfigured } from "../../../../lib/supabase/config";
import { createClient } from "../../../../lib/supabase/server";
import { isObject } from "../../../../lib/workspace/browser-records";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 40 * 1024;
const MAX_MEMO_CHARACTERS = 8000;
const RATE_LIMIT_COUNT = 20;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const requestsByUser = new Map<string, number[]>();

function jsonError(status: number, code: string, message: string, headers?: HeadersInit) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

async function readLimitedBody(request: NextRequest) {
  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_BODY_BYTES) throw new RangeError("Request is too large.");
  if (!request.body) throw new SyntaxError("Missing request body.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError("Request is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function consumeRateLimit(userId: string) {
  const now = Date.now();
  const recent = (requestsByUser.get(userId) ?? []).filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_COUNT) {
    requestsByUser.set(userId, recent);
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - recent[0])) / 1000)) };
  }
  recent.push(now);
  requestsByUser.set(userId, recent);
  return { allowed: true, retryAfter: 0 };
}

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) return jsonError(503, "auth_not_configured", "Connect Supabase before extracting Work Memory.");
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return jsonError(415, "content_type_required", "Send this request as JSON.");
  }

  let userId: string;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return jsonError(401, "sign_in_required", "Sign in to extract Work Memory.");
    userId = data.user.id;
  } catch {
    return jsonError(503, "auth_unavailable", "Account sign-in could not be verified right now.");
  }

  let body: unknown;
  try { body = await readLimitedBody(request); }
  catch (error) {
    return error instanceof RangeError
      ? jsonError(413, "request_too_large", "This Memo is too long to analyze. Shorten it and try again.")
      : jsonError(400, "invalid_json", "The request body must be valid JSON.");
  }
  if (!isObject(body)
    || Object.keys(body).some(key => !["memoText", "expectedUserId"].includes(key))
    || typeof body.memoText !== "string" || !body.memoText.trim() || body.memoText.length > MAX_MEMO_CHARACTERS
    || typeof body.expectedUserId !== "string") {
    return jsonError(400, "invalid_request", `Provide a Memo with up to ${MAX_MEMO_CHARACTERS} characters.`);
  }
  if (body.expectedUserId !== userId) return jsonError(409, "account_changed", "Reopen Notes & Ideas after changing accounts.");

  const limit = consumeRateLimit(userId);
  if (!limit.allowed) return jsonError(429, "rate_limited", "You've reached the current Work Memory extraction limit. Try again later.", { "Retry-After": String(limit.retryAfter) });

  const startedAt = Date.now();
  try {
    const result = await extractWorkMemoryWithOpenAI(body.memoText);
    console.info("work_memory.extract.completed", {
      userId,
      itemCount: result.items.length,
      model: result.model,
      ...result.usage,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ items: result.items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AIConfigurationError) return jsonError(503, "ai_not_configured", "Work Memory AI is not configured yet.");
    if (error instanceof AIProviderError) {
      console.warn("work_memory.extract.failed", {
        userId,
        status: error.status ?? null,
        durationMs: Date.now() - startedAt,
      });
      if (error.status === 504) return jsonError(504, "ai_timeout", "AI took too long to review this Memo. Try again.");
      if (error.status === 429) return jsonError(503, "provider_busy", "The AI provider is busy right now. Try again shortly.");
      if (error.status === 401 || error.status === 403) return jsonError(503, "provider_unavailable", "The AI provider is not available for this request.");
      if (error.status === 402) return jsonError(503, "provider_balance_required", "The AI provider is temporarily unavailable. Try again later.");
      if (error.status === 400 || error.status === 404 || error.status === 422) return jsonError(502, "provider_output_invalid", "AI could not return a valid Work Memory review. Try again.");
      return jsonError(503, "provider_unavailable", "The AI provider could not complete this review. Try again shortly.");
    }
    console.error("work_memory.extract.failed", { userId, status: "unexpected_error", durationMs: Date.now() - startedAt });
    return jsonError(500, "unexpected_error", "Work Memory could not be extracted right now. Try again.");
  }
}
