import { getCurrentPersonalWorkspace } from "./server";

export const MAX_AUTHORIZED_WORKSPACE_IDEAS = 500;

export type AuthorizedWorkspaceIdea = {
  id: string;
  text: string;
  type: "Idea";
  status: "Saved" | "In progress" | "Done";
  nextStep?: string;
  progressUpdatedAt?: string;
  createdAt: string;
  updatedAt?: string;
};

export async function getAuthorizedWorkspaceIdeas() {
  const { supabase, workspace, userId } = await getCurrentPersonalWorkspace();
  const countResult = await supabase.from("ideas")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspace.id);
  if (countResult.error || countResult.count === null) {
    throw countResult.error ?? new Error("Workspace note count was unavailable.");
  }

  if (countResult.count > MAX_AUTHORIZED_WORKSPACE_IDEAS) {
    return {
      userId,
      workspace: { id: workspace.id, name: workspace.name },
      notes: [] as AuthorizedWorkspaceIdea[],
      totalCount: countResult.count,
      complete: false,
    };
  }

  const { data, error } = await supabase.from("ideas")
    .select("id,workspace_id,body,status,next_step,progress_updated_at,created_at,updated_at")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false })
    .limit(MAX_AUTHORIZED_WORKSPACE_IDEAS + 1);
  if (error) throw error;

  const rows = data ?? [];
  if (rows.length > MAX_AUTHORIZED_WORKSPACE_IDEAS || rows.some(row => row.workspace_id !== workspace.id)) {
    throw new Error("Workspace notes changed while they were loading.");
  }
  const notes: AuthorizedWorkspaceIdea[] = rows.map(row => ({
    id: row.id,
    text: row.body,
    type: "Idea",
    status: row.status === "in_progress" ? "In progress" : row.status === "done" ? "Done" : "Saved",
    ...(row.next_step ? { nextStep: row.next_step } : {}),
    ...(row.progress_updated_at ? { progressUpdatedAt: row.progress_updated_at } : {}),
    createdAt: row.created_at,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  }));

  return {
    userId,
    workspace: { id: workspace.id, name: workspace.name },
    notes,
    totalCount: notes.length,
    complete: true,
  };
}
