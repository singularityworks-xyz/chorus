import type {
  SequencedEvent,
  VersionedSnapshot,
  WorkspaceEvent,
} from "@chorus/contracts";
import type { ChorusSyncSocket } from "./chorus-sync";

/**
 * Test doubles for the sync layer.
 *
 * The point of keeping `ChorusSync` framework-free is that its whole lifecycle —
 * handshake, replay, gap detection, single-use reconnect, auth expiry — can be
 * driven here without a DOM, a real socket, or a real timer.
 */

export class FakeSocket implements ChorusSyncSocket {
  static instances: FakeSocket[] = [];

  readonly url: string;
  closed = false;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
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

  /** Delivers a frame as the server would. */
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

/** In-memory `Storage`. */
export class FakeStorage {
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

/** Storage that throws on every operation, like Safari private mode. */
export class HostileStorage {
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

/** Captures scheduled callbacks so reconnect timing is deterministic. */
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
    const id = handle as number;
    const index = this.pending.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      this.pending.splice(index, 1);
    }
  };

  get delays(): number[] {
    return this.pending.map((entry) => entry.delay);
  }

  /** Runs the oldest pending callback, as a timer would. */
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
      recentlyUsedModels: [],
      speechVoiceId: null,
    },
    selectedBoardId: null,
    v: 1,
    ...overrides,
  };
}

/**
 * A generic workspace-scoped frame.
 *
 * `preference.composer_hint_dismissed` is workspace-scoped, so its `boardId` is
 * legitimately `null` and the envelope's `boardIdOfEvent` superRefine is
 * satisfied. A board-scoped event would need a real board id.
 */
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
