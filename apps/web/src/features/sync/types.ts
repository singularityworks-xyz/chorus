import type { SequencedEvent, VersionedSnapshot } from "@chorus/contracts";
import type { SequenceStorage } from "./snapshot-storage";

export type ChorusSyncStatus =
  | "connecting"
  | "live"
  | "offline"
  | "auth-expired";

export interface ChorusSyncState {
  lastError: string | null;
  lastSeq: number;
  snapshot: VersionedSnapshot | null;
  status: ChorusSyncStatus;
  workspaceId: string | null;
}

export type SyncListener = (state: ChorusSyncState) => void;

export interface ChorusSyncSocket {
  close: () => void;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  send: (data: string) => void;
}

export interface ChorusSyncDeps {
  cancel?: (handle: unknown) => void;
  createSocket: (url: string) => ChorusSyncSocket;
  prepareSocketUrl?: (baseUrl: string) => Promise<string>;
  random?: () => number;
  schedule?: (fn: () => void, delayMs: number) => unknown;
  storage?: SequenceStorage | null;
  url: string;
  urlIsExplicit?: boolean;
}

export interface ChorusSyncOptions {
  onAuthExpired?: () => void;
  onEvent?: (event: SequencedEvent) => void;
  onRestoredSnapshot?: (snapshot: VersionedSnapshot, seq: number) => void;
  onSnapshot?: (snapshot: VersionedSnapshot, seq: number) => void;
  onStatus?: (status: ChorusSyncStatus) => void;
}
