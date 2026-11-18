import { isObject } from "../workspace/browser-records";
import type { WorkflowState } from "./contracts";
import { createWorkflowState } from "./engine";
import { assertOwner } from "./rules";
import { isWorkflowState } from "./validation";

export const WORKFLOW_STORAGE_PREFIX = "aiask-proactive-workflows:v1:user:";
export type WorkflowAccountScope = { status: "ready"; userId: string | null } | { status: "loading" | "unavailable" };
export type WorkflowSessionToken = { ownerId: string; generation: number };
export type WorkflowStorageResult =
  | { status: "ready"; state: WorkflowState; token: WorkflowSessionToken; changed: boolean }
  | { status: "scope_unavailable" | "account_changed" | "read_failed" | "write_failed" | "invalid_update" | "corrupt" | "unsupported_version" | "locking_unavailable"; state: null };
type LocalStorage = Pick<Storage, "getItem" | "setItem">;
type SessionOptions = { timeZone?: string; locks?: Pick<LockManager, "request"> | null };

export function workflowStorageKey(ownerId: string) {
  assertOwner(ownerId);
  return WORKFLOW_STORAGE_PREFIX + encodeURIComponent(ownerId);
}

/** Account-scoped store only; never reads legacy business keys or cloud conversations.
 * Feed setAccount from VERIFIED account state (e.g. useWorkspaceAccount). Pass loading immediately
 * on auth changes, discard the consumer's previous view, then pass ready after re-verification.
 * The store retains no case cache. Generation tokens also reject A -> B -> A stale callbacks.
 */
export function createWorkflowSession(storage: LocalStorage, options: SessionOptions = {}) {
  let ownerId: string | null = null;
  let generation = 0;
  const locks = options.locks === undefined ? (typeof navigator !== "undefined" ? navigator.locks : undefined) : options.locks;
  const matches = (token: WorkflowSessionToken) => ownerId !== null && token.ownerId === ownerId && token.generation === generation;

  function setAccount(scope: WorkflowAccountScope) {
    const next = scope.status === "ready" && typeof scope.userId === "string" && scope.userId.trim() ? scope.userId : null;
    if (next !== ownerId) { ownerId = next; generation++; }
  }
  function read(): WorkflowStorageResult {
    if (!ownerId) return { status: "scope_unavailable", state: null };
    const token = { ownerId, generation };
    let raw: string | null;
    try { raw = storage.getItem(workflowStorageKey(ownerId)); }
    catch { return { status: "read_failed", state: null }; }
    if (!matches(token)) return { status: "account_changed", state: null };
    if (raw === null) return { status: "ready", state: createWorkflowState(ownerId, options.timeZone), token, changed: false };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObject(parsed) && typeof parsed.version === "number" && parsed.version > 1) return { status: "unsupported_version", state: null };
      if (!isWorkflowState(parsed, ownerId)) return { status: "corrupt", state: null };
      return { status: "ready", state: parsed, token, changed: false };
    } catch { return { status: "corrupt", state: null }; }
  }
  async function update(token: WorkflowSessionToken, reduce: (latest: WorkflowState) => WorkflowState): Promise<WorkflowStorageResult> {
    if (!matches(token)) return { status: "account_changed", state: null };
    // Fail closed rather than risk overwriting another tab's answers on unsupported browsers.
    if (!locks) return { status: "locking_unavailable", state: null };
    try {
      return await locks.request(workflowStorageKey(token.ownerId), (): WorkflowStorageResult => {
        if (!matches(token)) return { status: "account_changed", state: null };
        const before = read();
        if (before.status !== "ready") return before;
        const previousBytes = JSON.stringify(before.state);
        let after: WorkflowState;
        try { after = reduce(before.state); }
        catch { return { status: "invalid_update", state: null }; }
        if (!matches(token)) return { status: "account_changed", state: null };
        if (!isWorkflowState(after, token.ownerId)) return { status: "corrupt", state: null };
        if (JSON.stringify(after) === previousBytes) return { ...before, changed: false };
        try { storage.setItem(workflowStorageKey(token.ownerId), JSON.stringify(after)); }
        catch { return { status: "write_failed", state: null }; }
        return { status: "ready", state: after, token, changed: true };
      });
    } catch { return { status: "write_failed", state: null }; }
  }
  return { setAccount, read, update };
}
