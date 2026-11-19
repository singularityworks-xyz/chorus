import { workspaceIdSchema } from "@chorus/contracts";

export const LEGACY_LAST_SEQ_KEY = "chorus:lastSeq";
export const SNAPSHOT_KEY = "chorus:snapshot";

export const MAX_PERSISTED_SNAPSHOT_BYTES = 2_000_000;

export interface SequenceStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export function readPersistedSnapshot(
  storage: SequenceStorage | null
): { seq: number; snapshot: unknown; workspaceId: string | null } | null {
  if (!storage) {
    return null;
  }

  let raw: string | null;
  try {
    raw = storage.getItem(SNAPSHOT_KEY);
  } catch {
    return null;
  }

  if (raw === null || raw.length > MAX_PERSISTED_SNAPSHOT_BYTES) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("seq" in parsed) ||
      typeof parsed.seq !== "number" ||
      !Number.isSafeInteger(parsed.seq) ||
      parsed.seq < 0 ||
      !("snapshot" in parsed)
    ) {
      return null;
    }
    if (
      typeof parsed.snapshot !== "object" ||
      parsed.snapshot === null ||
      Array.isArray(parsed.snapshot)
    ) {
      return null;
    }

    const workspaceId = workspaceIdSchema.safeParse(
      "workspaceId" in parsed ? parsed.workspaceId : undefined
    );
    return {
      seq: parsed.seq,
      snapshot: parsed.snapshot,
      workspaceId: workspaceId.success ? workspaceId.data : null,
    };
  } catch {
    return null;
  }
}

export function writePersistedSnapshot(
  storage: SequenceStorage | null,
  snapshot: unknown,
  seq: number,
  workspaceId?: string | null
): void {
  if (!(storage && Number.isSafeInteger(seq)) || seq < 0) {
    return;
  }

  let serialised: string;
  try {
    const parsedWorkspaceId = workspaceIdSchema.safeParse(workspaceId);
    serialised = JSON.stringify({
      seq,
      snapshot,
      ...(parsedWorkspaceId.success
        ? { workspaceId: parsedWorkspaceId.data }
        : {}),
    });
  } catch {
    return;
  }

  if (
    new TextEncoder().encode(serialised).byteLength >
    MAX_PERSISTED_SNAPSHOT_BYTES
  ) {
    return;
  }

  try {
    storage.setItem(SNAPSHOT_KEY, serialised);
  } catch {
    clearPersistedState(storage);
  }
}

export function clearPersistedState(storage: SequenceStorage | null): void {
  if (!storage) {
    return;
  }
  for (const key of [SNAPSHOT_KEY, LEGACY_LAST_SEQ_KEY]) {
    try {
      storage.removeItem(key);
    } catch {
      // Storage may be unavailable; keep clearing the remaining key.
    }
  }
}

export function browserStorage(): SequenceStorage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
