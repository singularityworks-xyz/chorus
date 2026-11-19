"use client";

import type {
  SequencedEvent,
  VersionedSnapshot,
  WorkspaceEvent,
} from "@chorus/contracts";
import { LOCAL_ENTRY_PORT } from "@chorus/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserSocket } from "./browser-socket";
import { ChorusSync } from "./chorus-sync";
import { eventsAfterSnapshot } from "./protocol";
import { prepareAuthenticatedSocketUrl } from "./socket-credentials";
import { resolveSocketUrl } from "./socket-url";
import type { ChorusSyncState } from "./types";

const MAX_PENDING_EVENTS = 2000;

export interface UseChorusSyncOptions {
  onAuthExpired?: () => void;
  onEvent?: (event: SequencedEvent) => void;
  onRestoredSnapshot?: (snapshot: VersionedSnapshot, seq: number) => void;
  onSnapshot?: (snapshot: VersionedSnapshot, events: WorkspaceEvent[]) => void;
  socketUrl?: string;
}

export interface UseChorusSyncResult {
  error: string | null;
  hydrated: boolean;
  lastSeq: number;
  reportUnauthorized: () => void;
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
    workspaceId: null,
  }));
  const onEventRef = useRef(options.onEvent);
  const onSnapshotRef = useRef(options.onSnapshot);
  const onAuthExpiredRef = useRef(options.onAuthExpired);
  const onRestoredRef = useRef(options.onRestoredSnapshot);

  onEventRef.current = options.onEvent;
  onSnapshotRef.current = options.onSnapshot;
  onAuthExpiredRef.current = options.onAuthExpired;
  onRestoredRef.current = options.onRestoredSnapshot;

  const pendingEvents = useRef<{ event: WorkspaceEvent; seq: number }[]>([]);

  const syncRef = useRef<ChorusSync | null>(null);
  const url = useMemo(
    () =>
      options.socketUrl ??
      (typeof window === "undefined"
        ? "ws://localhost:2000/ws"
        : resolveSocketUrl({
            localServePort: 2000,
            allowLocalHostRebinding: process.env.NODE_ENV !== "production",
            developmentServePort:
              process.env.NODE_ENV === "production" ? undefined : 2000,
            explicit: process.env.NEXT_PUBLIC_CHORUS_WS_URL,
            isSecure: window.location.protocol === "https:",
            origin: window.location.origin,
          })),
    [options.socketUrl]
  );
  const urlIsExplicit =
    options.socketUrl !== undefined ||
    process.env.NEXT_PUBLIC_CHORUS_WS_URL !== undefined ||
    (typeof window !== "undefined" &&
      process.env.NODE_ENV !== "production" &&
      window.location.port === "3000");

  useEffect(() => {
    const sync = new ChorusSync(
      {
        createSocket: createBrowserSocket,
        prepareSocketUrl: (target) =>
          prepareAuthenticatedSocketUrl(target, {
            allowLocalBootstrap: true,
            localEntryPort:
              process.env.NODE_ENV === "production"
                ? LOCAL_ENTRY_PORT
                : undefined,
            pageOrigin: window.location.origin,
          }),
        url,
        urlIsExplicit,
      },
      {
        onAuthExpired: () => onAuthExpiredRef.current?.(),
        onRestoredSnapshot: (snapshot, seq) => {
          onRestoredRef.current?.(snapshot, seq);
        },
        onEvent: (frame) => {
          onEventRef.current?.(frame);

          pendingEvents.current.push({ event: frame.event, seq: frame.seq });

          if (pendingEvents.current.length > MAX_PENDING_EVENTS) {
            pendingEvents.current.splice(
              0,
              pendingEvents.current.length - MAX_PENDING_EVENTS
            );
          }
        },
        onSnapshot: (snapshot, snapshotSeq) => {
          const buffered = pendingEvents.current;
          pendingEvents.current = [];
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

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        sync.reconnectNow();
      }
    };
    const onOnline = () => {
      sync.reconnectNow();
    };
    const onOffline = () => {
      sync.networkOffline();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      unsubscribe();
      sync.stop();
      syncRef.current = null;
    };
  }, [url, urlIsExplicit]);

  const resync = useCallback(() => {
    syncRef.current?.requestResync();
  }, []);

  const reportUnauthorized = useCallback(() => {
    syncRef.current?.reportUnauthorized();
  }, []);

  return {
    reportUnauthorized,
    error: state.lastError,
    hydrated: state.snapshot !== null,
    lastSeq: state.lastSeq,
    resync,
    status: state.status,
  };
}
