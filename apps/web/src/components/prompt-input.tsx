"use client";

import {
  type ModelSelection,
  type OpencodeModelSummary,
  opencodeModelCatalogSchema,
} from "@chorus/contracts";
import { ArrowUp, Mic, MoreHorizontal, XIcon } from "lucide-react";
import posthog from "posthog-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette } from "@/components/command-palette";
import {
  createModelKey,
  DEFAULT_MODEL_KEY,
  ModelPicker,
} from "@/components/model-picker";
import { Button } from "@/components/ui/button";
import {
  sharedDropdownContentClass,
  sharedDropdownItemClass,
  sharedDropdownTriggerClass,
} from "@/components/ui/dropdown-aesthetics";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { WorkspaceBoard } from "@/features/workspace/types";
import { useWorkspace } from "@/features/workspace/workspace-context";
import {
  type AutocompleteItem,
  useAutocomplete,
} from "@/hooks/use-autocomplete";
import { useVoiceRecording } from "@/hooks/use-voice-recording";
import { extractLineRange, formatLineRange } from "@/lib/line-range";
import { cn } from "@/lib/utils";

const composerSelectTriggerClass = sharedDropdownTriggerClass;
const composerSelectContentClass = sharedDropdownContentClass;
const composerSelectItemClass = sharedDropdownItemClass;

interface PromptPart {
  filename?: string;
  id: string;
  isDirectory?: boolean;
  lineRange?: { end: number; start: number };
  mime?: string;
  name?: string;
  path?: string;
  type: "file" | "command" | "skill";
}

const PATH_SEPARATOR_RE = /[/\\]/;

function getRepoBaseName(directory: string) {
  return directory.split(PATH_SEPARATOR_RE).filter(Boolean).at(-1) ?? directory;
}

function getBoardRepoName(board: WorkspaceBoard) {
  return (
    board.repo.projectName?.trim() ||
    getRepoBaseName(board.repo.directory) ||
    board.title
  );
}

let partIdCounter = 0;

function generatePartId(): string {
  return `part-${Date.now()}-${partIdCounter++}`;
}

export function PromptInput() {
  const [isMounted, setIsMounted] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [parts, setParts] = useState<PromptPart[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState(DEFAULT_MODEL_KEY);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<
    OpencodeModelSummary[]
  >([]);
  const [defaultModel, setDefaultModel] = useState<
    ModelSelection | undefined
  >();
  const [textareaRect, setTextareaRect] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    boards,
    dismissComposerHint,
    isQueueingPrompt,
    preferences,
    queuePrompt,
    restoredPrompt,
    restorePrompt,
    selectBoard,
    sessionCommand,
    selectedBoard,
    setBoardModel,
    addRecentModel,
  } = useWorkspace();

  const autocomplete = useAutocomplete(selectedBoard?.repo.directory);

  useEffect(() => {
    if (restoredPrompt) {
      setPrompt(restoredPrompt);
      textareaRef.current?.focus();
      restorePrompt("");
    }
  }, [restoredPrompt, restorePrompt]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const isBusy =
    isQueueingPrompt || selectedBoard?.session.state === "starting";
  const hasActiveRun = selectedBoard?.session.currentTaskId !== undefined;
  const selectedDirectory = selectedBoard?.repo.directory ?? null;
  let sessionMessage = "First prompt will start a new OpenCode session.";

  if (hasActiveRun) {
    sessionMessage = "Wait for the current run to finish.";
  } else if (isBusy) {
    sessionMessage = "Starting session…";
  } else if (selectedBoard?.session.sessionId) {
    sessionMessage = "Prompt will reuse the active session.";
  }

  const handleTranscriptionComplete = (text: string) => {
    setPrompt((prev) => prev + (prev ? " " : "") + text);
  };

  const { isRecording, isTranscribing, startRecording, stopRecording } =
    useVoiceRecording(handleTranscriptionComplete);

  useEffect(() => {
    let isCancelled = false;

    async function loadModels() {
      setIsLoadingModels(true);

      try {
        const query = selectedDirectory
          ? `?directory=${encodeURIComponent(selectedDirectory)}`
          : "";
        const response = await fetch(`/api/models${query}`, {
          cache: "no-store",
        });

        if (!response.ok || isCancelled) {
          return;
        }

        const payload = opencodeModelCatalogSchema.parse(await response.json());
        if (isCancelled) {
          return;
        }

        setAvailableModels(payload.models);
        setDefaultModel(payload.defaultModel);
        setSelectedModelKey((currentValue) =>
          currentValue === DEFAULT_MODEL_KEY ||
          payload.models.some((model) => createModelKey(model) === currentValue)
            ? currentValue
            : DEFAULT_MODEL_KEY
        );
      } catch (error) {
        console.error("Failed to load OpenCode models", error);
      } finally {
        if (!isCancelled) {
          setIsLoadingModels(false);
        }
      }
    }

    loadModels().catch((error) => {
      console.error("Failed to load OpenCode models", error);
    });

    return () => {
      isCancelled = true;
    };
  }, [selectedDirectory]);

  useEffect(() => {
    if (!selectedBoard || availableModels.length === 0) {
      return;
    }

    const boardModel = selectedBoard.modelSelection;
    if (boardModel) {
      const modelKey = `${boardModel.providerID}/${boardModel.modelID}`;
      const modelExists = availableModels.some(
        (m) => `${m.providerID}/${m.modelID}` === modelKey
      );
      if (modelExists && modelKey !== selectedModelKey) {
        setSelectedModelKey(modelKey);
      } else if (!modelExists && selectedModelKey !== DEFAULT_MODEL_KEY) {
        setSelectedModelKey(DEFAULT_MODEL_KEY);
      }
    } else if (selectedModelKey !== DEFAULT_MODEL_KEY) {
      setSelectedModelKey(DEFAULT_MODEL_KEY);
    }
  }, [selectedBoard, availableModels, selectedModelKey]);

  const selectedModel = useMemo(() => {
    if (selectedModelKey === DEFAULT_MODEL_KEY) {
      return undefined;
    }

    const [providerID, modelID] = selectedModelKey.split("/");
    if (!(providerID && modelID)) {
      return undefined;
    }

    return {
      providerID,
      modelID,
    } satisfies ModelSelection;
  }, [selectedModelKey]);

  const handleModelValueChange = (value: string) => {
    setSelectedModelKey(value);
    if (value !== DEFAULT_MODEL_KEY && selectedBoard) {
      const [providerID, modelID] = value.split("/");
      if (providerID && modelID) {
        const model = { providerID, modelID };
        setBoardModel(selectedBoard.boardId, model);
        addRecentModel(model);
      }
    }
  };

  const handleVoiceButtonClick = async () => {
    if (isRecording) {
      await stopRecording();
      return;
    }

    await startRecording();
  };

  const insertPart = useCallback(
    (item: AutocompleteItem) => {
      if (!(textareaRef.current && autocomplete.state)) {
        return;
      }

      const textarea = textareaRef.current;
      const { triggerIndex, cursorPosition } = autocomplete.state;

      const before = prompt.slice(0, triggerIndex);
      const after = prompt.slice(cursorPosition);

      const { range } = extractLineRange(item.id);
      const displayName = item.path
        ? (item.path.split("/").filter(Boolean).pop() ?? item.path)
        : item.label;
      const displaySuffix = item.isDirectory ? `${displayName}/` : displayName;
      const lineRangeSuffix = formatLineRange(range);
      const insertText = `@${displaySuffix}${lineRangeSuffix} `;

      const newPrompt = before + insertText + after;
      setPrompt(newPrompt);

      let partType: "file" | "command" | "skill" = "file";
      if (item.type === "command") {
        partType = "command";
      } else if (item.type === "skill") {
        partType = "skill";
      }

      const part: PromptPart = {
        id: generatePartId(),
        type: partType,
        filename: displaySuffix,
        path: item.path ?? item.id,
        isDirectory: item.isDirectory,
        mime: item.isDirectory ? "application/x-directory" : "text/plain",
        lineRange: range ?? undefined,
        name:
          item.type === "command" || item.type === "skill"
            ? item.label
            : undefined,
      };

      setParts((prev) => [...prev, part]);

      autocomplete.close();
      setTextareaRect(null);

      requestAnimationFrame(() => {
        textarea.focus();
        const newPos = triggerIndex + insertText.length;
        textarea.setSelectionRange(newPos, newPos);
      });
    },
    [prompt, autocomplete]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(prompt.trim() && selectedBoard) || isBusy || hasActiveRun) {
      return;
    }

    const trimmedPrompt = prompt.trim();

    if (trimmedPrompt === "/undo" || trimmedPrompt === "/redo") {
      const command = trimmedPrompt.replace("/", "") as "undo" | "redo";
      const success = await sessionCommand(command);
      if (success) {
        setPrompt("");
        setParts([]);
      }
      return;
    }

    const fileParts = parts.filter((p) => p.type === "file");

    posthog.capture("prompt_submit", {
      hasFileParts: fileParts.length > 0,
      filePartCount: fileParts.length,
      fileParts: fileParts.map((p) => ({
        filename: p.filename,
        path: p.path,
        mime: p.mime,
        isDirectory: p.isDirectory,
      })),
      promptLength: trimmedPrompt.length,
      directory: selectedBoard.repo.directory,
    });

    const structuredParts = [
      { type: "text" as const, text: trimmedPrompt },
      ...fileParts.map((part) => ({
        type: "file" as const,
        filename: part.filename ?? "",
        path: part.path ?? "",
        mime: part.mime,
        isDirectory: part.isDirectory,
        lineRange: part.lineRange,
      })),
    ];

    const result = await queuePrompt({
      text: trimmedPrompt,
      model: selectedModel,
      parts: structuredParts,
    });

    if (result) {
      setPrompt("");
      setParts([]);
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${e.target.scrollHeight}px`;

    const cursorPos = e.target.selectionStart;
    autocomplete.checkTrigger(e.target.value, cursorPos);

    if (autocomplete.isOpen) {
      const rect = e.target.getBoundingClientRect();
      setTextareaRect({
        top: rect.top,
        left: rect.left,
        width: rect.width,
      });
    }
  };

  const handleSelectAutocomplete = useCallback(
    async (item: AutocompleteItem) => {
      if (item.id.startsWith("builtin:")) {
        const command = item.id.replace("builtin:", "") as "undo" | "redo";
        const success = await sessionCommand(command);
        if (success) {
          autocomplete.close();
          setTextareaRect(null);
          setPrompt("");
        }
        return;
      }

      autocomplete.onItemSelect(item);

      if (item.isDirectory) {
        autocomplete.expandDirectory(item);
        return;
      }

      insertPart(item);
    },
    [autocomplete, insertPart, sessionCommand]
  );

  const handleExpandDirectory = useCallback(
    (item: AutocompleteItem) => {
      autocomplete.expandDirectory(item);
    },
    [autocomplete]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (autocomplete.isOpen && e.key === "Escape") {
      e.preventDefault();
      autocomplete.close();
      setTextareaRect(null);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e).catch((error) => {
        console.error("Failed to submit prompt", error);
      });
      const target = e.target as HTMLTextAreaElement;
      target.style.height = "auto";
    }
  };

  const removePart = useCallback((partId: string) => {
    setParts((prev) => prev.filter((p) => p.id !== partId));
  }, []);

  const attachedFiles = parts.filter((p) => p.type === "file");

  if (!isMounted) {
    return null;
  }

  return (
    <div className="fixed right-0 bottom-2 left-0 z-40 flex justify-center px-3 pb-[env(safe-area-inset-bottom)] md:bottom-8 md:px-4">
      <div className="w-full max-w-3xl">
        {!preferences.composerHintDismissed && (
          <div className="mb-2 flex items-start justify-between gap-3 rounded-xs border border-white/10 bg-black/45 px-3 py-2 text-[11px] text-white/70 leading-4 shadow-lg backdrop-blur-md">
            <span>
              Boards persist across browsers on this machine.{" "}
              {selectedBoard
                ? `${selectedBoard.title} is selected. ${sessionMessage}`
                : "Open or select a board, then send the first prompt to start its OpenCode session."}
            </span>
            <button
              aria-label="Dismiss composer hint"
              className="rounded-xs p-0.5 text-white/35 transition-colors hover:bg-white/8 hover:text-white/70"
              onClick={dismissComposerHint}
              type="button"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        )}
        <form className="relative" onSubmit={handleSubmit}>
          <div className="overflow-hidden rounded-sm border border-white/10 bg-[#0f0f0f]/90 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.8)] backdrop-blur-2xl transition-colors focus-within:border-white/20 focus-within:bg-[#161616]/95">
            {/* Mobile-only: board selector pinned to top edge of the card */}
            <div className="border-white/8 border-b px-3 py-1.5 sm:hidden">
              <Select
                onValueChange={(value) => value && selectBoard(value)}
                value={selectedBoard?.boardId ?? null}
              >
                <SelectTrigger
                  className={cn(
                    composerSelectTriggerClass,
                    "w-full border-0 bg-transparent px-0 text-white/58 shadow-none focus:ring-0"
                  )}
                  size="sm"
                >
                  <span className="min-w-0 flex-1 truncate text-left">
                    {selectedBoard
                      ? getBoardRepoName(selectedBoard)
                      : "Select a board"}
                  </span>
                </SelectTrigger>
                <SelectContent
                  align="start"
                  className={cn(
                    "w-[min(20rem,calc(100vw-2rem))] min-w-0",
                    composerSelectContentClass
                  )}
                >
                  {boards.map((board) => (
                    <SelectItem
                      className={composerSelectItemClass}
                      key={board.boardId}
                      value={board.boardId}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">
                          {getBoardRepoName(board)}
                        </span>
                        <span className="truncate text-[11px] text-white/40">
                          {board.repo.branch ?? board.repo.directory}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Main content area */}
            <div className="flex flex-col gap-2 px-3 py-2">
              {attachedFiles.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {attachedFiles.map((part) => (
                    <div
                      className="group flex items-center gap-1 rounded-md bg-white/8 px-1.5 py-0.5 text-[11px] text-white/70"
                      key={part.id}
                    >
                      <span className="max-w-32 truncate">
                        {part.isDirectory ? "📁 " : "📄 "}
                        {part.filename}
                        {part.lineRange
                          ? `#${part.lineRange.start}-${part.lineRange.end}`
                          : ""}
                      </span>
                      <button
                        className="ml-0.5 rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-white/10 group-hover:opacity-100"
                        onClick={() => removePart(part.id)}
                        type="button"
                      >
                        <XIcon className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {/*
                Named, because a placeholder is not an accessible name and this
                is the only control a user has to start work with. The agent e2e
                spec drives it by role, and an unnamed textarea is not
                addressable by one.
              */}
              <Textarea
                aria-label="Prompt Chorus"
                className="scrollbar-hide max-h-40 min-h-8 w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 font-medium text-[15px] text-white/90 shadow-none placeholder:text-white/40 focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-transparent"
                id="chorus-prompt-input"
                onChange={handleInput}
                onKeyDown={handleKeyDown}
                placeholder="Ask Chorus to build something..."
                ref={textareaRef}
                rows={1}
                value={prompt}
              />
              {/* Bottom toolbar — single row always */}
              <div className="flex items-center justify-between opacity-80 transition-opacity focus-within:opacity-100">
                {/* Left: model picker */}
                <div className="flex min-w-0 items-center gap-2">
                  <ModelPicker
                    availableModels={availableModels}
                    className={composerSelectTriggerClass}
                    defaultModel={defaultModel}
                    loading={isLoadingModels}
                    onValueChange={handleModelValueChange}
                    previousModelSelection={selectedBoard?.modelSelection}
                    recentlyUsedModels={preferences.recentlyUsedModels}
                    value={selectedModelKey}
                  />
                </div>
                {/* Right: board (desktop only) + action buttons */}
                <div className="flex items-center gap-2">
                  {/* Board selector: desktop only — hidden on mobile */}
                  <div className="hidden sm:block">
                    <Select
                      onValueChange={(value) => value && selectBoard(value)}
                      value={selectedBoard?.boardId ?? null}
                    >
                      <SelectTrigger
                        className={cn(
                          composerSelectTriggerClass,
                          "max-w-40 bg-transparent text-white/58"
                        )}
                        size="sm"
                      >
                        {isMounted && selectedBoard ? (
                          <span className="min-w-0 truncate font-medium text-white/90">
                            {selectedBoard.title}
                          </span>
                        ) : (
                          <SelectValue placeholder="Select a board" />
                        )}
                      </SelectTrigger>
                      <SelectContent
                        align="end"
                        className={cn("min-w-64", composerSelectContentClass)}
                      >
                        {boards.map((board) => (
                          <SelectItem
                            className={composerSelectItemClass}
                            key={board.boardId}
                            value={board.boardId}
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{board.title}</span>
                              <span className="truncate text-[11px] text-white/40">
                                {board.repo.branch ?? board.repo.directory}
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    className={`h-7 w-7 rounded-xs hover:text-white/90 dark:hover:text-white/90 ${
                      isRecording
                        ? "bg-red-500/20 text-red-400 hover:bg-red-500/30 dark:bg-red-500/20 dark:text-red-400 dark:hover:bg-red-500/30"
                        : "text-white/50 hover:bg-white/10 dark:text-white/50 dark:hover:bg-white/10"
                    }`}
                    disabled={isTranscribing}
                    onClick={handleVoiceButtonClick}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Mic
                      className={`h-4 w-4 ${isRecording ? "animate-pulse" : ""}`}
                    />
                  </Button>
                  <Button
                    className="h-7 w-7 rounded-xs text-white/50 hover:bg-white/10 hover:text-white/90 dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white/90"
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                  <button
                    className="h-7 w-7 rounded-xs bg-[#0f0f0f]/90 text-white/70 shadow-none transition-colors hover:bg-[#161616]/95 hover:text-white/90 focus:outline-none disabled:opacity-30"
                    disabled={
                      !(prompt.trim() && selectedBoard) ||
                      isBusy ||
                      hasActiveRun
                    }
                    type="submit"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </form>
        <CommandPalette
          anchorRect={textareaRect}
          isLoading={autocomplete.isLoading}
          items={autocomplete.items}
          onClose={() => {
            autocomplete.close();
            setTextareaRect(null);
          }}
          onExpandDirectory={handleExpandDirectory}
          onSelect={handleSelectAutocomplete}
        />
      </div>
    </div>
  );
}
