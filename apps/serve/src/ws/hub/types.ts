import type { WorkspaceEvent } from "@chorus/contracts";

export interface HubSocket {
  close?: (code?: number, reason?: string) => void;
  getBufferedAmount?: () => number;
  id: string;
  send: (data: string) => unknown;
}

export interface BufferedRecord {
  boardId: string | null;
  event: WorkspaceEvent;
  fromSeq: number;
  toSeq: number;
}

export interface HubClient {
  backpressuredFrames: number;
  capabilities: Set<string>;
  cleanSends: number;
  consecutiveDrops: number;
  controlMessagesThisMinute: number;
  controlWindowStart: number;
  criticalOnly: boolean;
  deviceId?: string;
  droppedFrames: number;
  id: string;
  lastPongAt: number;
  lastSeq: number;
  ready: boolean;
  socket: HubSocket;
  telemetryThisMinute: number;
  telemetryWindowStart: number;
}

export interface HubOptions {
  coalesceMs?: number;
  isDeviceAllowed?: (deviceId: string) => boolean;
  now?: () => number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

export interface HubStats {
  backpressuredFrames: number;
  clients: number;
  coalescerDepth: number;
  criticalOnlyClients: number;
  droppedFrames: number;
  dropReasons: Record<string, number>;
  headSeq: number;
}
