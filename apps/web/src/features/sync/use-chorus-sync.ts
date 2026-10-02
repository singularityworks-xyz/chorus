"use client";

import type {
  SequencedEvent,
  VersionedSnapshot,
  WorkspaceEvent,
} from "@chorus/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChorusSync,
  type ChorusSyncState,
  resolveSocketUrl,
} from "./chorus-sync";
import { eventsAfterSnapshot } from "./protocol";

/**
 * The one socket owner (plan P5 task 1).
 *
 * Everything about the WebSocket — connect, `hello`, resume from the persisted
 * cursor, backoff, gap-triggered resync, reconnect on foreground — lives in
 * `ChorusSync`. This hook is the React binding and nothing else, which is what
 * lets the whole lifecycle be unit-tested without a DOM.
 *
 * Applied events are accumulated as raw `WorkspaceEvent`s rather than mutating a
 * snapshot in place, because the plan requires the reducer to run through the
 * shared `applyEventToBoard` in `packages/contracts`. Accumulating and folding
 * keeps the client on exactly one projector — the mitigation the plan names for
 * server/client drift, and the reason it must not be bypassed here.
 */

export interface UseChorusSyncOptions {
  /** Called once when the session dies; the UI shows the login screen. */
  onAuthExpired?: () => void;
  /** Applies one event to the current boards. Called for every live event. */
  onEvent?: (event: SequencedEvent) => void;
  /** Snapshot restored from a previous page load, before any traffic. */
  onRestoredSnapshot?: (snapshot: VersionedSnapshot, seq: number) => void;
  /** Folds accumulated events onto the snapshot. */
  onSnapshot?: (snapshot: VersionedSnapshot, events: WorkspaceEvent[]) => void;
  /** Explicit socket URL; defaults to same-origin `/ws`. */
  socketUrl?: string;
}

export interface UseChorusSyncResult {
  /** Surfaces a detected gap or transport error. */
  error: string | null;
  /** True once a snapshot has arrived at least once. */
  hydrated: boolean;
  /** Highest contiguously applied sequence. */
  lastSeq: number;
  /** Asks the server for a fresh snapshot on demand. */
  resync: () => void;
  status: ChorusSyncState["status"];
}

export function useChorusSync(
  options: UseChorusSyncOptions = {}
): UseChorusSyncResult {
  const [state, setState] = useState<ChorusSyncState>(() => ({
    lastError: null,
    lastSeq: 0,
    snapshot: null,
    status: "offline",
  }));

  // Refs, not state: these are called from socket callbacks and from event
  // handlers, and a stale closure here would drop a frame or double-apply one.
  const onEventRef = useRef(options.onEvent);
  const onSnapshotRef = useRef(options.onSnapshot);
  const onAuthExpiredRef = useRef(options.onAuthExpired);
  const onRestoredRef = useRef(options.onRestoredSnapshot);

  onEventRef.current = options.onEvent;
  onSnapshotRef.current = options.onSnapshot;
  onAuthExpiredRef.current = options.onAuthExpired;
  onRestoredRef.current = options.onRestoredSnapshot;

  /**
   * Events received since the last snapshot, with their sequences.
   *
   * The sequences are load-bearing, not decorative. A snapshot is taken at the
   * server's current head, so it *already contains* every event buffered here.
   * Re-dispatching them on top of the snapshot folds each one through the
   * projector a second time: `card.created` appends unconditionally (duplicate
   * cards) and `step.delta_appended` concatenates (duplicated streamed text).
   * Filtering by `seq > snapshotSeq` is what makes the two paths disjoint.
   *
   * Bounded so a client that never receives a snapshot cannot grow this array
   * without limit while the server is down.
   */
  const pendingEvents = useRef<{ event: WorkspaceEvent; seq: number }[]>([]);
  const MAX_PENDING_EVENTS = 2000;

  const syncRef = useRef<ChorusSync | null>(null);
  const url = useMemo(
    () =>
      options.socketUrl ??
      (typeof window === "undefined"
        ? "ws://localhost:2000/ws"
        : resolveSocketUrl({
            explicit: process.env.NEXT_PUBLIC_CHORUS_WS_URL,
            isSecure: window.location.protocol === "https:",
            origin: window.location.origin,
          })),
    [options.socketUrl]
  );

  // Same-origin `/ws` only resolves when serve fronts the built app. When Next
  // is served directly there is no `/ws` route, so tell ChorusSync to report
  // that instead of retrying an origin that will never answer.
  const urlIsExplicit =
    options.socketUrl !== undefined ||
    process.env.NEXT_PUBLIC_CHORUS_WS_URL !== undefined;

  useEffect(() => {
    const sync = new ChorusSync(
      {
        createSocket: (target) =>
          new WebSocket(target) as unknown as ConstructorParameters<
            typeof ChorusSync
          >[0]["createSocket"] extends never
            ? never
            : ReturnType<
                ConstructorParameters<typeof ChorusSync>[0]["createSocket"]
              >,
        url,
        urlIsExplicit,
      },
      {
        onAuthExpired: () => onAuthExpiredRef.current?.(),
        onRestoredSnapshot: (snapshot, seq) => {
          onRestoredRef.current?.(snapshot, seq);
        },
        onEvent: (frame) => {
          pendingEvents.current.push({ event: frame.event, seq: frame.seq });
          if (pendingEvents.current.length > MAX_PENDING_EVENTS) {
            // The client is far behind and a snapshot is cheaper than replaying
            // an unbounded backlog through the projector.
            pendingEvents.current = [];
            sync.requestResync();
            return;
          }
          onEventRef.current?.(frame);
        },
        onSnapshot: (snapshot, snapshotSeq) => {
          const buffered = pendingEvents.current;
          pendingEvents.current = [];
          // Only what the snapshot does not already contain.
          const fresh = eventsAfterSnapshot(buffered, snapshotSeq);
          onSnapshotRef.current?.(
            snapshot,
            fresh.map((entry) => entry.event)
          );
        },
      }
    );

    syncRef.current = sync;
    const unsubscribe = sync.subscribe(setState);
    sync.start();

    /**
     * Foreground and connectivity triggers.
     *
     * Both are needed and both can fire together: a phone waking from sleep
     * commonly emits `visibilitychange` and `online` in the same tick. The
     * `ChorusSync` guard collapses them into one reconnect, so the client never
     * has two handshakes in flight replaying the same gap.
     */
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        sync.reconnectNow();
      }
    };
    const onOnline = () => {
      sync.reconnectNow();
    };
    const onOffline = () => {
      // Nothing to do but let the close handler run; recorded so the UI can say
      // so rather than showing a silent stall.
      setState((current) => ({ ...current, lastError: "offline" }));
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      unsubscribe();
      // Idempotent by construction, so Strict Mode's mount/unmount/mount is
      // safe and does not churn the server with a connect/close/connect.
      sync.stop();
      syncRef.current = null;
    };
  }, [url, urlIsExplicit]);

  const resync = useCallback(() => {
    syncRef.current?.requestResync();
  }, []);

  return {
    error: state.lastError,
    hydrated: state.snapshot !== null,
    lastSeq: state.lastSeq,
    resync,
    status: state.status,
  };
}
