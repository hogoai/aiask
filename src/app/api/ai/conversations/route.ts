import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "../../../../lib/supabase/server";
import { isSupabaseConfigured } from "../../../../lib/supabase/config";
import { normalizePartnerRole, partnerRoleFromStoredId, partnerRoleToStoredId } from "../../../../lib/ai/contracts";

export const runtime = "nodejs";

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function isMissingConversationSchema(error: { code?: string; message?: string } | null) {
  return Boolean(error && (error.code === "42P01" || error.code === "PGRST205" || error.message?.includes("ai_conversation")));
}

export async function GET(request: NextRequest) {
  if (!isSupabaseConfigured()) return jsonError(503, "auth_not_configured", "Sign-in storage is not configured.");

  let supabase;
  let userId: string;
  try {
    supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return jsonError(401, "sign_in_required", "Sign in to view AI conversations.");
    userId = data.user.id;
  } catch {
    return jsonError(503, "auth_unavailable", "Account sign-in could not be verified right now.");
  }

  const params = request.nextUrl.searchParams;
  const query = (params.get("q") ?? "").trim().slice(0, 120);
  const rawRole = params.get("partnerRole");
  const role = rawRole ? normalizePartnerRole(rawRole) : null;
  if (rawRole && !role) return jsonError(400, "invalid_partner", "Choose a supported AI Team role.");
  const ideaId = params.get("ideaId");
  if (ideaId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ideaId)) {
    return jsonError(400, "invalid_note_reference", "Choose a valid saved note.");
  }
  const notesContext = params.get("notesContext");
  const supportedNotesContext = notesContext && (
    /^AIASK context scope: selected-note-[0-9a-f-]{1,120}$/i.test(notesContext)
    || /^AIASK context scope: current-view-[a-z0-9_-]{1,120}$/i.test(notesContext)
    || notesContext === "AIASK context scope: authorized personal Workspace Notes."
  );
  if (notesContext && (!supportedNotesContext || notesContext.length > 180)) {
    return jsonError(400, "invalid_notes_context", "Choose a valid Notes & Ideas conversation context.");
  }
  const storedRole = role ? partnerRoleToStoredId(role) : null;
  const select = "id,title,idea_id,project_id,partner_role,is_favorite,created_at,updated_at";
  const makeQuery = () => {
    let builder = supabase.from("ai_conversations").select(select).eq("user_id", userId);
    if (storedRole) builder = builder.eq("partner_role", storedRole);
    if (ideaId) builder = builder.eq("idea_id", ideaId);
    return builder;
  };

  try {
    let rows: Record<string, unknown>[];
    if (!query) {
      const result = await makeQuery().order("updated_at", { ascending: false }).limit(200);
      if (result.error) throw result.error;
      rows = result.data ?? [];
    } else {
      const pattern = "%" + query + "%";
      const [titleMatches, messageMatches] = await Promise.all([
        makeQuery().ilike("title", pattern).order("updated_at", { ascending: false }).limit(200),
        supabase.from("ai_conversation_messages").select("conversation_id").eq("user_id", userId).ilike("content", pattern).limit(1000),
      ]);
      if (titleMatches.error) throw titleMatches.error;
      if (messageMatches.error) throw messageMatches.error;
      const matchingIds = new Set<string>((titleMatches.data ?? []).map(row => row.id));
      for (const message of messageMatches.data ?? []) matchingIds.add(message.conversation_id as string);
      if (matchingIds.size === 0) rows = [];
      else {
        const result = await makeQuery().in("id", [...matchingIds].slice(0, 1000)).order("updated_at", { ascending: false }).limit(200);
        if (result.error) throw result.error;
        rows = result.data ?? [];
      }
    }

    if (notesContext && rows.length > 0) {
      const { data: markers, error: markerError } = await supabase.from("ai_conversation_messages")
        .select("conversation_id,content")
        .eq("user_id", userId)
        .eq("kind", "idea")
        .in("conversation_id", rows.map(row => row.id));
      if (markerError) throw markerError;
      const matchingIds = new Set((markers ?? []).filter(message => message.content === notesContext).map(message => message.conversation_id as string));
      rows = rows.filter(row => matchingIds.has(row.id as string));
    }

    const conversations = rows.map(row => {
      const partnerRole = partnerRoleFromStoredId(row.partner_role);
      if (!partnerRole) throw new Error("A stored conversation has an unsupported AI Partner role.");
      return {
        id: row.id,
        title: row.title,
        ideaId: row.idea_id,
        projectId: row.project_id,
        partnerRole,
        isFavorite: row.is_favorite,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
    return NextResponse.json({ conversations });
  } catch (error) {
    const dbError = error as { code?: string; message?: string };
    if (isMissingConversationSchema(dbError)) {
      return jsonError(503, "conversation_storage_unavailable", "Apply the AI Pilot conversation migration in Supabase, then reload this page.");
    }
    console.error("ai.conversations.list.failed", { userId, code: dbError.code ?? null });
    return jsonError(500, "conversation_list_failed", "AI conversation history could not be loaded.");
  }
}
