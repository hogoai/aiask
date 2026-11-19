import type { PlannerTodo } from "../workspace/browser-records";
import type { ProactiveController } from "./controller";
import type { WorkflowStorageResult } from "./storage";

export const TASK_CREATED_EVENT = "aiask:task-created";
export type TaskCreatedEvent = { record: PlannerTodo; createdAt: string };

/** The caller supplies fresh verified auth, never a user ID inferred from a shared browser task. */
export async function captureCreatedTaskAfterVerification(controller: ProactiveController, event: TaskCreatedEvent, verifyOwner: () => Promise<string | null>): Promise<WorkflowStorageResult> {
  const before = controller.snapshot();
  if (before.status !== "ready") return before;
  const verifiedOwner = await verifyOwner();
  if (verifiedOwner !== before.token.ownerId) return { status: "account_changed", state: null };
  return controller.captureCreatedTask(before.token, event);
}
