import posthog from "posthog-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { recordFileUsage } from "@/lib/frecency";
import { loadCommandItems, loadFileItems } from "../lib/autocomplete-lookups";
import type { AutocompleteItem, AutocompleteType } from "../types";

interface AutocompleteState {
  cursorPosition: number;
  query: string;
  triggerIndex: number;
  type: AutocompleteType;
}

interface UseAutocompleteReturn {
  checkTrigger: (value: string, cursorPos: number) => void;
  close: () => void;
  error: string | null;
  expandDirectory: (item: AutocompleteItem) => void;
  isLoading: boolean;
  isOpen: boolean;
  items: AutocompleteItem[];
  onItemSelect: (item: AutocompleteItem) => void;
  retry: () => void;
  state: AutocompleteState | null;
}

type LookupRequest =
  | { kind: "command"; query: string }
  | { dirPath?: string; kind: "file"; query: string };

const SLASH_REGEX = /(^|\s)\/(\w*)$/;
const AT_REGEX = /@([^\s]*)$/;
const AUTOCOMPLETE_DEBOUNCE_MS = 120;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function reportUnexpectedLookupError(error: unknown): void {
  posthog.capture("autocomplete_unexpected_error", {
    errorType: error instanceof Error ? error.name : typeof error,
  });
}

async function settleLookup<T>(
  promise: Promise<T>,
  isCurrent: () => boolean,
  handlers: {
    onError: (error: unknown) => void;
    onFinish: () => void;
    onSuccess: (value: T) => void;
  }
): Promise<void> {
  try {
    const value = await promise;
    if (isCurrent()) {
      handlers.onSuccess(value);
    }
  } catch (error) {
    if (isCurrent()) {
      handlers.onError(error);
    }
  } finally {
    if (isCurrent()) {
      handlers.onFinish();
    }
  }
}

export function useAutocomplete(boardId?: string): UseAutocompleteReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [items, setItems] = useState<AutocompleteItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<AutocompleteState | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const lastLookupRef = useRef<LookupRequest | null>(null);
  const stateRef = useRef(state);
  const boardIdRef = useRef(boardId);
  stateRef.current = state;

  const startRequest = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);
    setItems([]);
    setIsOpen(true);
    return {
      controller,
      isCurrent: () =>
        requestIdRef.current === requestId && !controller.signal.aborted,
    };
  }, []);

  const cancelRequest = useCallback(() => {
    requestIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
  }, []);

  useEffect(() => {
    if (boardIdRef.current === boardId) {
      return;
    }
    boardIdRef.current = boardId;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    cancelRequest();
    lastLookupRef.current = null;
    setIsOpen(false);
    setItems([]);
    setError(null);
    setState(null);
  }, [boardId, cancelRequest]);

  const fetchFileItems = useCallback(
    (query: string, dirPath?: string) => {
      lastLookupRef.current = { kind: "file", query, dirPath };
      posthog.capture("autocomplete_fetch_start", {
        type: "file",
        query,
        boardId,
      });

      const request = startRequest();
      const lookup = boardId
        ? loadFileItems(boardId, query, dirPath, request.controller.signal)
        : Promise.reject(new Error("Select a board to load file suggestions."));
      return settleLookup(lookup, request.isCurrent, {
        onSuccess: (sortedResults) => {
          posthog.capture("autocomplete_fetch_success", {
            type: "file",
            resultCount: sortedResults.length,
          });
          setItems(sortedResults);
          setIsOpen(true);
        },
        onError: (error) => {
          posthog.capture("autocomplete_fetch_error", {
            type: "file",
            query,
            errorMessage:
              error instanceof Error ? error.message : String(error),
            errorType: error instanceof Error ? error.name : typeof error,
          });
          setItems([]);
          setError(
            errorMessage(error, "Could not load file suggestions. Try again.")
          );
          setIsOpen(true);
        },
        onFinish: () => {
          setIsLoading(false);
        },
      });
    },
    [boardId, startRequest]
  );

  const fetchCommandItems = useCallback(
    (query: string) => {
      lastLookupRef.current = { kind: "command", query };
      posthog.capture("autocomplete_fetch_start", {
        type: "command",
        query,
        boardId,
      });

      const request = startRequest();
      const lookup = loadCommandItems(
        boardId,
        query,
        request.controller.signal
      );
      return settleLookup(lookup, request.isCurrent, {
        onSuccess: ({ error, items: results }) => {
          if (error !== undefined) {
            setError(
              errorMessage(
                error.reason,
                "Some board suggestions could not be loaded. Try again."
              )
            );
          }
          posthog.capture("autocomplete_fetch_success", {
            type: "command",
            resultCount: results.length,
          });
          setItems(results);
          setIsOpen(true);
        },
        onError: (error) => {
          posthog.capture("autocomplete_fetch_error", {
            type: "command",
            query,
            errorMessage:
              error instanceof Error ? error.message : String(error),
            errorType: error instanceof Error ? error.name : typeof error,
          });
          setItems([]);
          setError(
            errorMessage(error, "Could not load board suggestions. Try again.")
          );
          setIsOpen(true);
        },
        onFinish: () => {
          setIsLoading(false);
        },
      });
    },
    [boardId, startRequest]
  );

  const scheduleLookup = useCallback(
    (lookup: LookupRequest) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      cancelRequest();
      lastLookupRef.current = lookup;
      setIsLoading(true);
      setError(null);
      setItems([]);
      setIsOpen(true);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        if (lookup.kind === "command") {
          fetchCommandItems(lookup.query).catch(reportUnexpectedLookupError);
        } else {
          fetchFileItems(lookup.query, lookup.dirPath).catch(
            reportUnexpectedLookupError
          );
        }
      }, AUTOCOMPLETE_DEBOUNCE_MS);
    },
    [cancelRequest, fetchCommandItems, fetchFileItems]
  );

  const checkTrigger = useCallback(
    (value: string, cursorPos: number) => {
      const textBeforeCursor = value.slice(0, cursorPos);

      const slashMatch = textBeforeCursor.match(SLASH_REGEX);
      const atMatch = textBeforeCursor.match(AT_REGEX);

      if (slashMatch) {
        const query = slashMatch[2] ?? "";
        const triggerIndex =
          cursorPos - slashMatch[0].length + slashMatch[1].length;

        posthog.capture("autocomplete_trigger_detected", {
          trigger: "slash",
          query,
          cursorPos,
          triggerIndex,
        });

        setState({
          type: null,
          query,
          cursorPosition: cursorPos,
          triggerIndex,
        });

        scheduleLookup({ kind: "command", query });
      } else if (atMatch) {
        const rawQuery = atMatch[1];
        const triggerIndex = cursorPos - atMatch[0].length;

        posthog.capture("autocomplete_trigger_detected", {
          trigger: "at",
          query: rawQuery,
          cursorPos,
          triggerIndex,
        });

        setState({
          type: "file",
          query: rawQuery,
          cursorPosition: cursorPos,
          triggerIndex,
        });

        scheduleLookup({ kind: "file", query: rawQuery });
      } else {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        cancelRequest();
        lastLookupRef.current = null;
        setState(null);
        setIsOpen(false);
        setItems([]);
        setError(null);
      }
    },
    [cancelRequest, scheduleLookup]
  );

  const expandDirectory = useCallback(
    (item: AutocompleteItem) => {
      if (!(item.isDirectory && item.path)) {
        return;
      }

      const currentState = stateRef.current;
      if (!currentState) {
        return;
      }

      fetchFileItems(`${item.path}/`, item.path);
    },
    [fetchFileItems]
  );

  const onItemSelect = useCallback((item: AutocompleteItem) => {
    if (item.type === "file" && item.path) {
      recordFileUsage(item.path);
    }
  }, []);

  const close = useCallback(() => {
    cancelRequest();
    setIsOpen(false);
    setState(null);
    setItems([]);
    setError(null);
    lastLookupRef.current = null;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
  }, [cancelRequest]);

  const retry = useCallback(() => {
    const lookup = lastLookupRef.current;
    if (lookup?.kind === "file") {
      fetchFileItems(lookup.query, lookup.dirPath);
    } else if (lookup?.kind === "command") {
      fetchCommandItems(lookup.query);
    }
  }, [fetchCommandItems, fetchFileItems]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  return {
    isOpen,
    items,
    isLoading,
    error,
    state,
    checkTrigger,
    close,
    expandDirectory,
    onItemSelect,
    retry,
  };
}
