import type {
  SequencedEvent,
  VersionedSnapshot,
  WorkspaceEvent,
} from "@chorus/contracts";
import type { SequenceStorage } from "./snapshot-storage";
import type { ChorusSyncSocket } from "./types";

export class FakeSocket implements ChorusSyncSocket {
  static instances: FakeSocket[] = [];

  readonly url: string;
  closed = false;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  static reset(): void {
    FakeSocket.instances = [];
  }

  static get last(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    if (!socket) {
      throw new Error("no socket was created");
    }
    return socket;
  }

  close(): void {
    this.closed = true;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  get sentTypes(): string[] {
    return this.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);
  }

  emit(payload: unknown): void {
    this.onmessage?.({
      data: JSON.stringify(payload),
    });
  }

  open(): void {
    this.onopen?.();
  }

  remoteClose(code: number, reason?: string): void {
    this.onclose?.({ code, reason });
  }
}

export class FakeStorage implements SequenceStorage {
  readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

export class HostileStorage implements SequenceStorage {
  getItem(): string | null {
    throw new DOMException("denied", "SecurityError");
  }

  removeItem(): void {
    throw new DOMException("denied", "SecurityError");
  }

  setItem(): void {
    throw new DOMException("quota", "QuotaExceededError");
  }
}

export class FakeScheduler {
  readonly pending: { delay: number; fn: () => void; id: number }[] = [];
  #nextId = 1;

  schedule = (fn: () => void, delay: number): unknown => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.pending.push({ delay, fn, id });
    return id;
  };

  cancel = (handle: unknown): void => {
    if (typeof handle !== "number") {
      return;
    }
    const id = handle;
    const index = this.pending.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      this.pending.splice(index, 1);
    }
  };

  get delays(): number[] {
    return this.pending.map((entry) => entry.delay);
  }

  flushOne(): void {
    const entry = this.pending.shift();
    entry?.fn();
  }

  flushAll(): void {
    while (this.pending.length > 0) {
      this.flushOne();
    }
  }
}

export function snapshotFixture(
  overrides: Partial<VersionedSnapshot> = {}
): VersionedSnapshot {
  return {
    boards: [],
    preferences: {
      boardViewMode: "relaxed",
      composerHintDismissed: false,
      defaultModelSelection: null,
      recentlyUsedModels: [],
      speechVoiceId: null,
    },
    selectedBoardId: null,
    v: 1,
    ...overrides,
  };
}

export function eventFrame(
  fromSeq: number,
  seq: number,
  event?: Partial<WorkspaceEvent>
): SequencedEvent {
  return {
    boardId: null,
    event: {
      boardId: null,
      ts: 1000,
      type: "preference.composer_hint_dismissed",
      ...event,
    } as WorkspaceEvent,
    fromSeq,
    seq,
    ts: 1000,
    type: "event",
  };
}

export function approvalEvent(boardId = "board-1"): WorkspaceEvent {
  return {
    boardId,
    kind: "permission",
    taskId: "task-1",
    ts: 1000,
    type: "card.waiting_for_approval",
  };
}
