import fuzzysort from "fuzzysort";
import posthog from "posthog-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { boostByFrecency, recordFileUsage } from "@/lib/frecency";
import { removeLineRange } from "@/lib/line-range";
import {
  fetchCommands,
  fetchDirectory,
  fetchFiles,
  fetchSkills,
  type OpencodeCommand,
  type OpencodeFileNode,
  type OpencodeSkill,
} from "@/lib/opencode-client";

export type AutocompleteType = "command" | "skill" | "file" | null;

export interface AutocompleteItem {
  description?: string;
  id: string;
  isDirectory?: boolean;
  label: string;
  path?: string;
  type: AutocompleteType;
}

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

function fuzzyMatchFiles(
  items: AutocompleteItem[],
  query: string
): AutocompleteItem[] {
  if (!query) {
    return items;
  }

  const targets = items.map((item) => ({
    item,
    displayValue: item.path ?? item.label,
    description: item.description ?? "",
  }));

  const results = fuzzysort.go(query, targets, {
    keys: ["displayValue", "description"],
    limit: 50,
    threshold: -10_000,
  });

  return results.map((r) => r.obj.item);
}

function sortFilesByDepthAndFrecency(
  items: AutocompleteItem[]
): AutocompleteItem[] {
  const withDepth = items.map((item) => ({
    item,
    depth: (item.path ?? item.label).split("/").filter(Boolean).length,
  }));

  withDepth.sort((a, b) => {
    if (a.item.isDirectory !== b.item.isDirectory) {
      return a.item.isDirectory ? -1 : 1;
    }
    const depthDiff = a.depth - b.depth;
    if (depthDiff !== 0) {
      return depthDiff;
    }
    return a.item.label.localeCompare(b.item.label);
  });

  return boostByFrecency(withDepth.map((d) => d.item));
}

async function loadFileItems(
  boardId: string,
  query: string,
  dirPath: string | undefined,
  signal: AbortSignal
): Promise<AutocompleteItem[]> {
  let rawItems: AutocompleteItem[];
  if (dirPath || query.includes("/")) {
    const pathToFetch = dirPath ?? query.slice(0, query.lastIndexOf("/") + 1);
    const nodes = await fetchDirectory(boardId, pathToFetch || "/", { signal });
    posthog.capture("autocomplete_fetch_directory", {
      dirPath: pathToFetch,
      count: nodes.length,
    });
    const filterTerm = dirPath ? "" : query.slice(query.lastIndexOf("/") + 1);
    rawItems = nodes
      .filter((node: OpencodeFileNode) =>
        node.name.toLowerCase().includes(filterTerm.toLowerCase())
      )
      .map((node: OpencodeFileNode) => ({
        id: node.path,
        label: node.name,
        description: node.type === "directory" ? "Directory" : "File",
        type: "file" as const,
        isDirectory: node.type === "directory",
        path: node.path,
      }));
  } else {
    const cleanQuery = removeLineRange(query);
    const files = await fetchFiles(boardId, cleanQuery, { signal });
    posthog.capture("autocomplete_fetch_files", {
      query: cleanQuery,
      count: files.length,
    });
    rawItems = files.map((file: string) => ({
      id: file,
      label: file.split("/").pop() ?? file,
      description: file,
      type: "file" as const,
      isDirectory: false,
      path: file,
    }));
  }

  const fuzzyResults = fuzzyMatchFiles(rawItems, query.replace("#", ""));
  return sortFilesByDepthAndFrecency(fuzzyResults);
}

function createCommandItems(
  query: string,
  commands: OpencodeCommand[],
  skills: OpencodeSkill[]
): AutocompleteItem[] {
  const builtinCommands = [
    { name: "undo", description: "Undo the last repository change" },
    { name: "redo", description: "Redo a repository change" },
  ];
  const allItems: AutocompleteItem[] = [
    ...builtinCommands
      .filter((command) =>
        command.name.toLowerCase().includes(query.toLowerCase())
      )
      .map((command) => ({
        id: `builtin:${command.name}`,
        label: `/${command.name}`,
        description: command.description,
        type: "command" as const,
      })),
    ...commands
      .filter((command) =>
        command.name.toLowerCase().includes(query.toLowerCase())
      )
      .map((command) => ({
        id: `cmd:${command.name}`,
        label: `/${command.name}`,
        description: command.description ?? "",
        type: "command" as const,
      })),
    ...skills
      .filter((skill) => skill.name.toLowerCase().includes(query.toLowerCase()))
      .map((skill) => ({
        id: `skill:${skill.name}`,
        label: `/${skill.name}`,
        description: skill.description ?? "",
        type: "skill" as const,
      })),
  ];

  return fuzzysort
    .go(query.toLowerCase(), allItems, {
      keys: ["label", "description"],
      limit: 50,
      threshold: -10_000,
    })
    .map((result) => result.obj);
}

function firstRejectedResult(
  results: PromiseSettledResult<unknown>[]
): PromiseRejectedResult | undefined {
  for (const result of results) {
    if (result.status === "rejected") {
      return result;
    }
  }
  return undefined;
}

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

async function loadCommandItems(
  boardId: string | undefined,
  query: string,
  signal: AbortSignal
): Promise<{
  error: PromiseRejectedResult | undefined;
  items: AutocompleteItem[];
}> {
  const commandsPromise = boardId
    ? fetchCommands(boardId, { signal })
    : Promise.reject(new Error("Select a board to load commands."));
  const skillsPromise = boardId
    ? fetchSkills(boardId, { signal })
    : Promise.reject(new Error("Select a board to load skills."));
  const [commandsResult, skillsResult] = await Promise.allSettled([
    commandsPromise,
    skillsPromise,
  ]);
  const commands =
    commandsResult.status === "fulfilled" ? commandsResult.value : [];
  const skills = skillsResult.status === "fulfilled" ? skillsResult.value : [];

  posthog.capture("autocomplete_fetch_commands", {
    count: commands.length,
    commands: commands.map((command) => command.name),
  });
  posthog.capture("autocomplete_fetch_skills", {
    count: skills.length,
    skills: skills.map((skill) => skill.name),
  });

  return {
    error: firstRejectedResult([commandsResult, skillsResult]),
    items: createCommandItems(query, commands, skills),
  };
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
