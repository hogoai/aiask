import { createClient } from "../supabase/client";
import type { DocumentRecord } from "./types";

export type DocumentSummary = Pick<DocumentRecord, "id" | "title" | "classification" | "created_at">;

const libraryColumns = "id,user_id,title,classification,note_text,file_name,mime_type,byte_size,storage_path,created_at";
const summaryColumns = "id,title,classification,created_at";

async function assertOwner(client: ReturnType<typeof createClient>, expectedUserId: string) {
  const { data: { user }, error } = await client.auth.getUser();
  if (error) throw error;
  if (!user || user.id !== expectedUserId) {
    throw new Error("Your signed-in session could not be verified. Refresh the page and sign in again.");
  }
}

/** Load only the signed-in user's private records; Supabase RLS remains the final access check. */
export async function listPrivateDocuments(expectedUserId: string): Promise<DocumentRecord[]> {
  const client = createClient();
  await assertOwner(client, expectedUserId);
  const { data, error } = await client.from("documents")
    .select(libraryColumns)
    .eq("user_id", expectedUserId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as DocumentRecord[];
}

/** Workspace gets safe, useful metadata only; note text and storage paths stay in the library. */
export async function listPrivateDocumentSummaries(expectedUserId: string): Promise<DocumentSummary[]> {
  const client = createClient();
  await assertOwner(client, expectedUserId);
  const { data, error } = await client.from("documents")
    .select(summaryColumns)
    .eq("user_id", expectedUserId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as DocumentSummary[];
}
