import { createClient } from "../supabase/server";
import { isSupabaseConfigured } from "../supabase/config";

export type WorkspaceResolutionErrorCode =
  | "supabase_not_configured"
  | "supabase_client_creation_failed"
  | "authentication_failed"
  | "sign_in_required"
  | "personal_workspace_lookup_failed"
  | "personal_workspace_missing"
  | "personal_workspace_ambiguous"
  | "personal_workspace_membership_lookup_failed"
  | "personal_workspace_membership_missing"
  | "personal_workspace_owner_mismatch"
  | "personal_workspace_owner_role_invalid";

export class WorkspaceResolutionError extends Error {
  constructor(readonly code: WorkspaceResolutionErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceResolutionError";
  }
}

type SupabaseResult<T> = {
  data: T;
  error: unknown;
};

async function resolveSupabaseQuery<T>(
  run: () => PromiseLike<SupabaseResult<T>>,
  code: WorkspaceResolutionErrorCode,
  message: string,
): Promise<T> {
  try {
    const { data, error } = await run();
    if (error) {
      throw new WorkspaceResolutionError(code, message);
    }
    return data;
  } catch (error) {
    if (error instanceof WorkspaceResolutionError) {
      throw error;
    }
    throw new WorkspaceResolutionError(code, message);
  }
}

/**
 * Resolve the signed-in user's personal Workspace using the current Supabase
 * cookie session. Callers cannot provide a userId or workspaceId.
 */
export async function getCurrentPersonalWorkspace() {
  if (!isSupabaseConfigured()) {
    throw new WorkspaceResolutionError(
      "supabase_not_configured",
      "Supabase is not configured.",
    );
  }

  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch {
    throw new WorkspaceResolutionError(
      "supabase_client_creation_failed",
      "The Supabase client could not be created.",
    );
  }

  const authData = await resolveSupabaseQuery<
    Awaited<ReturnType<typeof supabase.auth.getUser>>["data"]
  >(
    () => supabase.auth.getUser(),
    "authentication_failed",
    "The current account could not be verified.",
  );
  if (!authData.user) {
    throw new WorkspaceResolutionError(
      "sign_in_required",
      "Sign in to access a personal Workspace.",
    );
  }

  const workspaces = await resolveSupabaseQuery(
    () =>
      supabase
        .from("workspaces")
        .select("id,name,kind,owner_id,created_at")
        .eq("owner_id", authData.user.id)
        .eq("kind", "personal")
        .limit(2),
    "personal_workspace_lookup_failed",
    "The personal Workspace could not be loaded.",
  );

  if (!workspaces || workspaces.length === 0) {
    throw new WorkspaceResolutionError(
      "personal_workspace_missing",
      "This account does not have a personal Workspace. Apply the reviewed workspace provisioning migration first.",
    );
  }
  if (workspaces.length > 1) {
    throw new WorkspaceResolutionError(
      "personal_workspace_ambiguous",
      "This account has multiple personal Workspaces and needs administrative review.",
    );
  }

  const workspace = workspaces[0];
  if (workspace.owner_id !== authData.user.id) {
    throw new WorkspaceResolutionError(
      "personal_workspace_owner_mismatch",
      "The personal Workspace owner does not match the signed-in account.",
    );
  }

  const membership = await resolveSupabaseQuery(
    () =>
      supabase
        .from("workspace_members")
        .select("workspace_id,role")
        .eq("workspace_id", workspace.id)
        .eq("user_id", authData.user.id)
        .maybeSingle(),
    "personal_workspace_membership_lookup_failed",
    "The personal Workspace membership could not be checked.",
  );

  if (!membership) {
    throw new WorkspaceResolutionError(
      "personal_workspace_membership_missing",
      "The current account is not a member of its personal Workspace.",
    );
  }
  if (membership.role !== "owner") {
    throw new WorkspaceResolutionError(
      "personal_workspace_owner_role_invalid",
      "The personal Workspace owner must have the owner membership role.",
    );
  }

  return {
    supabase,
    userId: authData.user.id,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      kind: workspace.kind,
      ownerId: workspace.owner_id,
      createdAt: workspace.created_at,
      membershipRole: membership.role,
    },
  };
}