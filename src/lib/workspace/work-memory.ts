export const WORK_MEMORY_KEY = "aiask-work-memory";

export type WorkMemoryType = "person" | "commitment" | "decision" | "fact";
export type WorkMemoryStatus = "suggested" | "confirmed" | "dismissed";

export type WorkMemoryItem = {
  id: string;
  memoId: string;
  type: WorkMemoryType;
  label: string;
  value: string;
  evidence: string;
  sourceMemoUpdatedAt: string;
  needsConfirmation: boolean;
  status: WorkMemoryStatus;
  createdAt: string;
};

export type ExtractedWorkMemory = Pick<WorkMemoryItem, "type" | "label" | "value" | "evidence" | "needsConfirmation">;

export type WorkMemoryRead = { data: WorkMemoryItem[]; incomplete: boolean };

const WORK_MEMORY_TYPES = new Set<WorkMemoryType>(["person", "commitment", "decision", "fact"]);
const WORK_MEMORY_STATUSES = new Set<WorkMemoryStatus>(["suggested", "confirmed", "dismissed"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readItem(value: unknown): WorkMemoryItem | null {
  if (!isObject(value)
    || typeof value.id !== "string" || !value.id
    || typeof value.memoId !== "string" || !value.memoId
    || typeof value.type !== "string" || !WORK_MEMORY_TYPES.has(value.type as WorkMemoryType)
    || typeof value.label !== "string" || !value.label.trim() || value.label.length > 120
    || typeof value.value !== "string" || !value.value.trim() || value.value.length > 500
    || typeof value.evidence !== "string" || !value.evidence.trim() || value.evidence.length > 500
    || typeof value.sourceMemoUpdatedAt !== "string" || !Number.isFinite(Date.parse(value.sourceMemoUpdatedAt))
    || typeof value.needsConfirmation !== "boolean"
    || typeof value.status !== "string" || !WORK_MEMORY_STATUSES.has(value.status as WorkMemoryStatus)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return null;

  return {
    id: value.id,
    memoId: value.memoId,
    type: value.type as WorkMemoryType,
    label: value.label.trim(),
    value: value.value.trim(),
    evidence: value.evidence.trim(),
    sourceMemoUpdatedAt: value.sourceMemoUpdatedAt,
    needsConfirmation: value.needsConfirmation,
    status: value.status as WorkMemoryStatus,
    createdAt: value.createdAt,
  };
}

export function readWorkMemory(storage: Pick<Storage, "getItem">): WorkMemoryRead {
  try {
    const raw = storage.getItem(WORK_MEMORY_KEY);
    if (raw === null) return { data: [], incomplete: false };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { data: [], incomplete: true };
    const data = parsed.flatMap(value => {
      const item = readItem(value);
      return item ? [item] : [];
    });
    return { data, incomplete: data.length !== parsed.length };
  } catch {
    return { data: [], incomplete: true };
  }
}

export function validateExtractedWorkMemory(value: unknown, memoText: string): ExtractedWorkMemory[] | null {
  if (!isObject(value) || !Array.isArray(value.items) || value.items.length > 12) return null;
  const items: ExtractedWorkMemory[] = [];
  for (const candidate of value.items) {
    if (!isObject(candidate)
      || typeof candidate.type !== "string" || !WORK_MEMORY_TYPES.has(candidate.type as WorkMemoryType)
      || typeof candidate.label !== "string" || !candidate.label.trim() || candidate.label.length > 120
      || typeof candidate.value !== "string" || !candidate.value.trim() || candidate.value.length > 500
      || typeof candidate.evidence !== "string" || !candidate.evidence.trim() || candidate.evidence.length > 500
      || !memoText.includes(candidate.evidence)
      || typeof candidate.needsConfirmation !== "boolean") return null;
    items.push({
      type: candidate.type as WorkMemoryType,
      label: candidate.label.trim(),
      value: candidate.value.trim(),
      evidence: candidate.evidence.trim(),
      needsConfirmation: candidate.needsConfirmation,
    });
  }
  return items;
}

export function workMemoryDuplicateKey(item: Pick<WorkMemoryItem, "type" | "label" | "value">) {
  return `${item.type}|${item.label.trim().toLocaleLowerCase()}|${item.value.trim().toLocaleLowerCase()}`;
}
