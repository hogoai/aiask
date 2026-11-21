import { NextResponse } from "next/server";
import { WorkspaceResolutionError } from "../../../../lib/workspace/server";
import { getAuthorizedWorkspaceIdeas } from "../../../../lib/workspace/authorized-ideas";

export const runtime = "nodejs";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  try {
    const result = await getAuthorizedWorkspaceIdeas();
    const contextCharacters = result.complete ? JSON.stringify({
      scope: "Authorized Workspace Notes",
      source: `Server-verified notes from the current personal Workspace: ${result.workspace.name}`,
      recordCount: result.notes.length,
      records: result.notes,
    }).length : null;
    return NextResponse.json({
      workspace: result.workspace,
      totalCount: result.totalCount,
      complete: result.complete,
      contextCharacters,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof WorkspaceResolutionError) {
      const status = error.code === "sign_in_required" ? 401 : 503;
      return errorResponse(status, error.code, error.message);
    }
    const dbError = error as { code?: string };
    console.error("workspace.ideas.list.failed", { code: dbError.code ?? null });
    if (dbError.code === "42P01" || dbError.code === "PGRST205" || dbError.code === "42703") {
      return errorResponse(503, "workspace_notes_unavailable", "Authorized Workspace Notes are not available in this Supabase environment yet.");
    }
    return errorResponse(503, "workspace_notes_unavailable", "Authorized Workspace Notes could not be loaded right now.");
  }
}
