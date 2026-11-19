import type {
  SequencedEvent,
  VersionedSnapshot,
  WorkspaceEvent,
} from "@chorus/contracts";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useChorusSync } from "@/features/sync/use-chorus-sync";
import {
  DRAG_TIMEOUT_MS,
  INITIAL_WORKSPACE_STATE,
  workspaceReducer,
} from "../reducer";

export function useWorkspaceSession() {
  const [state, dispatch] = useReducer(
    workspaceReducer,
    INITIAL_WORKSPACE_STATE
  );
  const [authExpired, setAuthExpired] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const revisionRef = useRef(0);

  const applySnapshot = useCallback(
    (snapshot: VersionedSnapshot, buffered: WorkspaceEvent[]) => {
      revisionRef.current = 0;
      dispatch({
        boards: snapshot.boards,
        preferences: snapshot.preferences,
        selectedBoardId: snapshot.selectedBoardId,
        type: "server/snapshot",
      });

      // The sync hook filters buffered frames against the snapshot sequence.
      if (buffered.length > 0) {
        dispatch({ events: buffered, type: "server/events" });
      }
      setConnectionError(null);
    },
    []
  );

  const applyEvent = useCallback((frame: SequencedEvent) => {
    dispatch({ events: [frame.event], type: "server/events" });
  }, []);

  const {
    error: syncError,
    hydrated,
    lastSeq,
    reportUnauthorized: reportSyncUnauthorized,
    status,
  } = useChorusSync({
    onAuthExpired: () => setAuthExpired(true),
    onEvent: applyEvent,
    onRestoredSnapshot: (snapshot) => {
      dispatch({
        boards: snapshot.boards,
        preferences: snapshot.preferences,
        selectedBoardId: snapshot.selectedBoardId,
        type: "server/snapshot",
      });
    },
    onSnapshot: applySnapshot,
  });

  useEffect(() => {
    setConnectionError(syncError);
  }, [syncError]);

  const hasPendingDrags = state.pendingDrags.size > 0;
  const pendingDragsRef = useRef(hasPendingDrags);
  pendingDragsRef.current = hasPendingDrags;

  // Keep one interval so new drags do not restart the expiry sweep.
  useEffect(() => {
    const timer = setInterval(
      () => {
        if (pendingDragsRef.current) {
          dispatch({ now: Date.now(), type: "optimistic/expire-drags" });
        }
      },
      Math.max(1000, Math.floor(DRAG_TIMEOUT_MS / 2))
    );

    return () => clearInterval(timer);
  }, []);

  const reportUnauthorized = useCallback(
    (response: Response): boolean => {
      if (response.status !== 401) {
        return false;
      }

      // HTTP auth failures must stop the socket's reconnect loop as well.
      reportSyncUnauthorized();
      setAuthExpired(true);
      return true;
    },
    [reportSyncUnauthorized]
  );

  return {
    authExpired,
    connectionError,
    dispatch,
    hydrated,
    lastSeq,
    reportUnauthorized,
    revisionRef,
    state,
    status,
  };
}
