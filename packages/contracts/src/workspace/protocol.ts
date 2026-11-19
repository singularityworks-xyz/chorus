import { z } from "zod";
import {
  type WorkspaceSnapshotInput,
  workspaceBoardSchema,
  workspacePreferencesSchema,
} from "./base/boards";
import type { WorkspaceEvent } from "./events";
import { WORKSPACE_SNAPSHOT_VERSION, workspaceEventSchema } from "./events";

/** WebSocket protocol for workspace snapshots, events, and viewport updates. */

/** Largest replayable gap. Beyond this the server sends a fresh snapshot. */
export const MAX_REPLAY_GAP = 500;

export const clientHelloSchema = z.object({
  /** Identity of the database that produced the cached cursor, when known. */
  workspaceId: z.uuid().optional(),
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

/** Snapshot payload validated before it reaches client state. */
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

export const serverReadySchema = z.object({
  head: z.number().int().nonnegative(),
  /** Optional for compatibility with older Serve processes. */
  workspaceId: z.uuid().optional(),
  type: z.literal("ready"),
});

/** The board a patch belongs to, or null when the patch is workspace-scoped. */
export function boardIdOfEvent(event: WorkspaceEvent): string | null {
  return "boardId" in event ? event.boardId : null;
}

/**
 * Sequenced event envelope. The schema checks board ownership and keeps the
 * full coalesced range so clients can resume without replaying rows.
 */
export const sequencedEventSchema = z
  .object({
    boardId: z.string().min(1).nullable(),
    event: workspaceEventSchema,
    /** Lowest log sequence covered by this frame. */
    fromSeq: z.number().int().nonnegative(),
    /** Highest log sequence covered; the client's resume cursor after applying. */
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
    if (message.fromSeq > message.seq) {
      ctx.addIssue({
        code: "custom",
        message: `fromSeq ${message.fromSeq} is after seq ${message.seq}`,
        path: ["fromSeq"],
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

/** Heartbeat. Clients must answer with `pong` or be dropped. */
export const serverPingSchema = z.object({
  at: z.number().int().nonnegative(),
  type: z.literal("ping"),
});

/** Ephemeral viewport state, excluded from the persisted event log. */
export const serverViewportSyncSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  timestamp: z.number().int().nonnegative(),
  type: z.literal("viewport.sync"),
});

/** All downstream message shapes emitted by the hub. */
export const serverMessageSchema = z.union([
  serverPingSchema,
  serverReadySchema,
  serverViewportSyncSchema,
  sequencedEventSchema,
  snapshotMessageSchema,
  serverErrorSchema,
]);

export type ServerPing = z.infer<typeof serverPingSchema>;
export type ServerReady = z.infer<typeof serverReadySchema>;
export type ServerViewportSync = z.infer<typeof serverViewportSyncSchema>;
export type SequencedEvent = z.infer<typeof sequencedEventSchema>;
export type SnapshotMessage = z.infer<typeof snapshotMessageSchema>;
export type ServerError = z.infer<typeof serverErrorSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** WebSocket close codes used by the hub. */
export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_RATE_LIMITED = 4429;

/**
 * Only streamed step updates coalesce. New event types default to immediate
 * control delivery.
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
