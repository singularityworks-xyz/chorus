import { z } from "zod";
import type { WorkspaceSnapshotInput } from "./base";
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

// ── Server → client ─────────────────────────────────────────────────────────

export const serverReadySchema = z.object({
  head: z.number().int().nonnegative(),
  type: z.literal("ready"),
});

/**
 * One sequenced event. `boardId` rides along so the hub can fan out per-board
 * deltas without re-diffing the workspace snapshot.
 */
export const sequencedEventSchema = z.object({
  boardId: z.string().min(1).nullable(),
  event: workspaceEventSchema,
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  type: z.literal("event"),
});

export const snapshotMessageSchema = z.object({
  data: z.object({
    boards: z.array(z.unknown()),
    preferences: z.unknown(),
    selectedBoardId: z.string().min(1).nullable(),
    v: z.literal(WORKSPACE_SNAPSHOT_VERSION),
  }),
  seq: z.number().int().nonnegative(),
  type: z.literal("snapshot"),
});

export const serverErrorSchema = z.object({
  detail: z.string().optional(),
  message: z.string(),
  type: z.literal("error"),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
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

/** The versioned blob a `snapshot` message carries (spec §5, `v: 1`). */
export const versionedSnapshotSchema = z.object({
  boards: z.array(z.unknown()),
  preferences: z.unknown(),
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

/** WebSocket close codes used by the hub. */
export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_RATE_LIMITED = 4429;

// ── Control events ──────────────────────────────────────────────────────────

/**
 * Control events must bypass coalescing (plan Phase 3): a pending approval or
 * a state transition is worthless if it arrives 2 s late on a phone radio.
 * Step/response deltas are the only things worth batching.
 */
const CONTROL_EVENT_TYPES = new Set<WorkspaceEvent["type"]>([
  "board.created",
  "board.removed",
  "board.selected",
  "board.review_mode_set",
  "board.model_set",
  "board.columns_replaced",
  "board.session_patched",
  "card.created",
  "card.queued",
  "card.started",
  "card.moved",
  "card.waiting_for_approval",
  "card.completed",
  "card.failed",
  "session.attached",
  "session.starting",
  "session.idle",
  "session.error",
  "session.timeout",
]);

export function isControlEvent(event: WorkspaceEvent): boolean {
  return CONTROL_EVENT_TYPES.has(event.type);
}

/** True when the client should keep buffered deltas for this event. */
export function isCoalescibleEvent(event: WorkspaceEvent): boolean {
  return !isControlEvent(event);
}
