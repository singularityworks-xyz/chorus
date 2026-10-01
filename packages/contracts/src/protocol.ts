import { z } from "zod";
import {
  type WorkspaceSnapshotInput,
  workspaceBoardSchema,
  workspacePreferencesSchema,
} from "./base";
import type { WorkspaceEvent } from "./events";
import { WORKSPACE_SNAPSHOT_VERSION, workspaceEventSchema } from "./events";

/**
 * Wire protocol for the native `/ws` event log (spec §4).
 *
 * Commands travel over HTTP (request/response, idempotent by `mutationId`);
 * state travels over this socket, downstream only. Auth rides the HttpOnly
 * session cookie on the upgrade, or a short-lived single-use ticket for
 * proxies that strip cookies — never a raw token in a message body.
 */

/** Largest replayable gap. Beyond this the server sends a fresh snapshot. */
export const MAX_REPLAY_GAP = 500;

// ── Client → server ─────────────────────────────────────────────────────────

export const clientHelloSchema = z.object({
  since: z.number().int().nonnegative(),
  type: z.literal("hello"),
});

export const resyncRequestSchema = z.object({
  type: z.literal("resync"),
});

export const clientPongSchema = z.object({
  type: z.literal("pong"),
});

/** Client-initiated viewport relay — the one non-sequenced message (§4). */
export const viewportSyncSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  type: z.literal("viewport.sync"),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  clientHelloSchema,
  resyncRequestSchema,
  clientPongSchema,
  viewportSyncSchema,
]);

export type ClientHello = z.infer<typeof clientHelloSchema>;
export type ResyncRequest = z.infer<typeof resyncRequestSchema>;
export type ClientPong = z.infer<typeof clientPongSchema>;
export type ViewportSync = z.infer<typeof viewportSyncSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ── Snapshot blob ───────────────────────────────────────────────────────────

/**
 * The versioned workspace blob a `snapshot` message carries (spec §5, `v: 1`).
 *
 * Fully typed rather than `unknown`: this is the client's entire resume path,
 * so an unvalidated snapshot would hand arbitrary shapes straight to the UI.
 * Bump `WORKSPACE_SNAPSHOT_VERSION` on any incompatible change.
 */
export const versionedSnapshotSchema = z.object({
  boards: workspaceBoardSchema.array(),
  preferences: workspacePreferencesSchema,
  selectedBoardId: z.string().min(1).nullable(),
  v: z.literal(WORKSPACE_SNAPSHOT_VERSION),
});

export type VersionedSnapshot = z.infer<typeof versionedSnapshotSchema>;

export function createVersionedSnapshot(
  workspace: WorkspaceSnapshotInput
): VersionedSnapshot {
  return {
    boards: workspace.boards,
    preferences: workspace.preferences,
    selectedBoardId: workspace.selectedBoardId,
    v: WORKSPACE_SNAPSHOT_VERSION,
  };
}

// ── Server → client ─────────────────────────────────────────────────────────

export const serverReadySchema = z.object({
  head: z.number().int().nonnegative(),
  type: z.literal("ready"),
});

/** The board a patch belongs to, or null when the patch is workspace-scoped. */
export function boardIdOfEvent(event: WorkspaceEvent): string | null {
  return "boardId" in event ? event.boardId : null;
}

/**
 * One sequenced event. `boardId` duplicates the event's own board so the hub
 * can fan out per-board deltas without re-diffing the workspace snapshot — so
 * the two must agree, and the schema refuses to build a message where they do
 * not. A mismatch would route a patch to the wrong board's subscribers, which
 * is unrecoverable for the client.
 */
export const sequencedEventSchema = z
  .object({
    boardId: z.string().min(1).nullable(),
    event: workspaceEventSchema,
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("event"),
  })
  .superRefine((message, ctx) => {
    const actual = boardIdOfEvent(message.event);
    if (message.boardId !== actual) {
      ctx.addIssue({
        code: "custom",
        message: `envelope boardId ${String(message.boardId)} does not match event board ${String(actual)}`,
        path: ["boardId"],
      });
    }
  });

export const snapshotMessageSchema = z.object({
  data: versionedSnapshotSchema,
  seq: z.number().int().nonnegative(),
  type: z.literal("snapshot"),
});

export const serverErrorSchema = z.object({
  detail: z.string().optional(),
  message: z.string(),
  type: z.literal("error"),
});

/**
 * Union of every downstream message. Each variant is parsed individually by the
 * hub, so this exists for tests and for any client that accepts all shapes.
 */
export const serverMessageSchema = z.union([
  serverReadySchema,
  sequencedEventSchema,
  snapshotMessageSchema,
  serverErrorSchema,
]);

export type ServerReady = z.infer<typeof serverReadySchema>;
export type SequencedEvent = z.infer<typeof sequencedEventSchema>;
export type SnapshotMessage = z.infer<typeof snapshotMessageSchema>;
export type ServerError = z.infer<typeof serverErrorSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** WebSocket close codes used by the hub. */
export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_RATE_LIMITED = 4429;

// ── Control vs coalescible ──────────────────────────────────────────────────

/**
 * Only high-frequency step traffic is coalescible. Everything else is a
 * **control** event and is delivered immediately (plan Phase 3): a pending
 * approval, a lane transition, or a session-state flip is worthless if it
 * arrives 2 s late on a phone radio — and worthless a second time if
 * critical-only backpressure drops it.
 *
 * The classification is deliberately inverted: it enumerates the two types that
 * may be batched instead of the twenty-odd that may not. A new event type added
 * later therefore defaults to *control* (delivered immediately) rather than
 * silently becoming coalescible and droppable under load.
 */
const COALESCIBLE_EVENT_TYPES = new Set<WorkspaceEvent["type"]>([
  "step.upserted",
  "step.delta_appended",
]);

export function isCoalescibleEvent(event: WorkspaceEvent): boolean {
  return COALESCIBLE_EVENT_TYPES.has(event.type);
}

export function isControlEvent(event: WorkspaceEvent): boolean {
  return !isCoalescibleEvent(event);
}
