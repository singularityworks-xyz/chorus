"use client";

import {
  type ModelSelection,
  type OpencodeModelSummary,
  opencodeModelCatalogSchema,
} from "@chorus/contracts";
import { ArrowUp, Mic, XIcon } from "lucide-react";
import posthog from "posthog-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette } from "@/components/command-palette";
import { ComposerDock } from "@/components/composer-dock";
import { ComposerHint } from "@/components/composer-hint";
import { createModelKey, ModelPicker } from "@/components/model-picker";
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
import { providerCatalogInvalidator } from "@/features/settings/provider-catalog-invalidator";
import { isWorkspaceSessionLive } from "@/features/workspace/session-status";
import type { WorkspaceBoard } from "@/features/workspace/types";
import { useWorkspace } from "@/features/workspace/workspace-context";
import {
  type AutocompleteItem,
  useAutocomplete,
} from "@/hooks/use-autocomplete";
import { useVoiceRecording } from "@/hooks/use-voice-recording";
import { ChorusApiError } from "@/lib/chorus-api-error";
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

function promptSubmissionErrorMessage(error: unknown): string {
  if (!(error instanceof ChorusApiError)) {
    return "We could not confirm whether the task started. Check the board before retrying; your draft is still here.";
  }
  if (error.code === "global_model_not_configured") {
    return "Choose one provider and model in Settings before starting a task.";
  }
  return error.message;
}

function modelCatalogLoadErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Loading models timed out. Check provider settings and retry.";
  }
  return "Could not load models. Check provider settings and retry.";
}

function preserveAvailableModelSelection(
  currentValue: string,
  models: OpencodeModelSummary[]
) {
  if (currentValue === "") {
    return currentValue;
  }
  return models.some((model) => createModelKey(model) === currentValue)
    ? currentValue
    : "";
}

let partIdCounter = 0;

function generatePartId(): string {
  return `part-${Date.now()}-${partIdCounter++}`;
}

export function PromptInput() {
  const [isMounted, setIsMounted] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [parts, setParts] = useState<PromptPart[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [modelSelectionError, setModelSelectionError] = useState<string | null>(
    null
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
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
    sessionStatus,
    selectedBoard,
    setDefaultModelSelection,
    addRecentModel,
  } = useWorkspace();

  const autocomplete = useAutocomplete(selectedBoard?.boardId);

  useEffect(() => {
    if (restoredPrompt) {
      setPrompt(restoredPrompt);
      textareaRef.current?.focus();
      restorePrompt("");
    }
  }, [restoredPrompt, restorePrompt]);

  useEffect(() => {
    if (!autocomplete.isOpen) {
      setTextareaRect(null);
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const rect = textarea.getBoundingClientRect();
    setTextareaRect({ top: rect.top, left: rect.left, width: rect.width });
  }, [autocomplete.isOpen]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const isBusy =
    isQueueingPrompt || selectedBoard?.session.state === "starting";
  const hasActiveRun = selectedBoard?.session.currentTaskId !== undefined;
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
  const voiceActionLabel = isRecording
    ? "Stop voice input"
    : "Start voice input";

  useEffect(() => {
    if (!isWorkspaceSessionLive(sessionStatus)) {
      return;
    }

    let isCancelled = false;
    let activeController: AbortController | undefined;

    async function loadModels() {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      setIsLoadingModels(true);

      try {
        const response = await fetch("/api/models", {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10_000),
          ]),
        });

        if (!response.ok) {
          throw new Error(`model_catalog_http_${String(response.status)}`);
        }
        const payload = opencodeModelCatalogSchema.parse(await response.json());
        if (isCancelled || controller.signal.aborted) {
          return;
        }

        setAvailableModels(payload.models);
        setDefaultModel(payload.defaultModel);
        setModelSelectionError(null);
        setSelectedModelKey((currentValue) =>
          preserveAvailableModelSelection(currentValue, payload.models)
        );
      } catch (error) {
        if (isCancelled || controller.signal.aborted) {
          return;
        }
        setModelSelectionError(modelCatalogLoadErrorMessage(error));
      } finally {
        if (!(isCancelled || controller.signal.aborted)) {
          setIsLoadingModels(false);
        }
      }
    }

    function refreshModels() {
      loadModels().catch((error: unknown) => {
        if (!isCancelled) {
          setModelSelectionError(modelCatalogLoadErrorMessage(error));
        }
      });
    }

    const unsubscribe = providerCatalogInvalidator.subscribe(() => {
      refreshModels();
    });
    refreshModels();

    return () => {
      isCancelled = true;
      activeController?.abort();
      unsubscribe();
    };
  }, [sessionStatus]);

  useEffect(() => {
    const defaultSelection = preferences.defaultModelSelection;
    setSelectedModelKey(
      defaultSelection
        ? `${defaultSelection.providerID}/${defaultSelection.modelID}`
        : ""
    );
  }, [preferences.defaultModelSelection]);

  const selectedModel = useMemo(() => {
    const [providerID, modelID] = selectedModelKey.split("/");
    if (!(providerID && modelID)) {
      return undefined;
    }

    return {
      providerID,
      modelID,
    } satisfies ModelSelection;
  }, [selectedModelKey]);

  const handleModelValueChange = async (value: string) => {
    setSelectedModelKey(value);
    setModelSelectionError(null);
    try {
      const model = availableModels.find(
        (candidate) => createModelKey(candidate) === value
      );
      if (!model) {
        throw new Error("model_unavailable");
      }
      if (!model.connected) {
        throw new Error("provider_not_connected");
      }
      const selection = {
        providerID: model.providerID,
        modelID: model.modelID,
      };
      await setDefaultModelSelection(selection);
      addRecentModel(selection);
    } catch (error) {
      const savedSelection = preferences.defaultModelSelection;
      setSelectedModelKey(
        savedSelection
          ? `${savedSelection.providerID}/${savedSelection.modelID}`
          : ""
      );
      setModelSelectionError(
        error instanceof Error && error.message === "provider_not_connected"
          ? "Connect this provider in Settings before selecting its model."
          : "Could not save the application model. Try again in Settings."
      );
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
    setSubmitError(null);

    if (trimmedPrompt === "/undo" || trimmedPrompt === "/redo") {
      const command = trimmedPrompt === "/undo" ? "undo" : "redo";
      const result = await sessionCommand(selectedBoard.boardId, command);
      if (result.ok) {
        setPrompt("");
        setParts([]);
      } else {
        setSubmitError(
          result.error ??
            `Could not ${command} repository changes. Your prompt is unchanged; check the board connection and try again.`
        );
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

    let result: Awaited<ReturnType<typeof queuePrompt>>;
    try {
      result = await queuePrompt({
        text: trimmedPrompt,
        model: selectedModel,
        parts: structuredParts,
      });
    } catch (error) {
      setSubmitError(promptSubmissionErrorMessage(error));
      return;
    }

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
  };

  const handleSelectAutocomplete = useCallback(
    async (item: AutocompleteItem) => {
      if (item.id === "builtin:undo" || item.id === "builtin:redo") {
        const command = item.id === "builtin:undo" ? "undo" : "redo";
        setSubmitError(null);
        if (!selectedBoard) {
          setSubmitError("Select a board before changing repository history.");
          return;
        }
        const result = await sessionCommand(selectedBoard.boardId, command);
        if (result.ok) {
          autocomplete.close();
          setTextareaRect(null);
          setPrompt("");
        } else {
          setSubmitError(
            result.error ??
              `Could not ${command} repository changes. Your prompt is unchanged; check the board connection and try again.`
          );
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
    [autocomplete, insertPart, selectedBoard, sessionCommand]
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
    <ComposerDock
      hint={
        preferences.composerHintDismissed ? null : (
          <ComposerHint
            onDismiss={dismissComposerHint}
            selectedBoardTitle={selectedBoard?.title}
            sessionMessage={sessionMessage}
          />
        )
      }
    >
      <form className="pointer-events-auto relative" onSubmit={handleSubmit}>
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
                      aria-label={`Remove ${part.filename} attachment`}
                      className="ml-0.5 rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-white/10 group-hover:opacity-100"
                      onClick={() => removePart(part.id)}
                      title={`Remove ${part.filename}`}
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
              onChange={(event) => {
                setSubmitError(null);
                handleInput(event);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Ask Chorus to build something..."
              ref={textareaRef}
              rows={1}
              value={prompt}
            />
            {submitError ? (
              <p
                className="text-[11px] text-rose-200/90 leading-4"
                role="alert"
              >
                {submitError}
              </p>
            ) : null}
            {/* Bottom toolbar — single row always */}
            <div className="flex items-center justify-between opacity-80 transition-opacity focus-within:opacity-100">
              {/* Left: model picker */}
              <div className="flex min-w-0 items-center gap-2">
                <ModelPicker
                  allowDefaultOption={false}
                  availableModels={availableModels}
                  className={composerSelectTriggerClass}
                  defaultModel={defaultModel}
                  loading={isLoadingModels}
                  onValueChange={handleModelValueChange}
                  previousModelSelection={preferences.defaultModelSelection}
                  recentlyUsedModels={preferences.recentlyUsedModels}
                  value={selectedModelKey}
                />
                {modelSelectionError ? (
                  <span
                    aria-live="polite"
                    className="text-[10px] text-rose-300"
                    role="alert"
                  >
                    {modelSelectionError}
                  </span>
                ) : null}
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
                  aria-label={voiceActionLabel}
                  className={`h-7 w-7 rounded-xs hover:text-white/90 dark:hover:text-white/90 ${
                    isRecording
                      ? "bg-red-500/20 text-red-400 hover:bg-red-500/30 dark:bg-red-500/20 dark:text-red-400 dark:hover:bg-red-500/30"
                      : "text-white/50 hover:bg-white/10 dark:text-white/50 dark:hover:bg-white/10"
                  }`}
                  disabled={isTranscribing}
                  onClick={handleVoiceButtonClick}
                  size="icon"
                  title={voiceActionLabel}
                  type="button"
                  variant="ghost"
                >
                  <Mic
                    className={`h-4 w-4 ${isRecording ? "animate-pulse" : ""}`}
                  />
                </Button>
                <button
                  aria-label="Send prompt"
                  className="h-7 w-7 rounded-xs bg-[#0f0f0f]/90 text-white/70 shadow-none transition-colors hover:bg-[#161616]/95 hover:text-white/90 focus:outline-none disabled:opacity-30"
                  disabled={
                    !(prompt.trim() && selectedBoard) || isBusy || hasActiveRun
                  }
                  title="Send prompt"
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
        error={autocomplete.error}
        isLoading={autocomplete.isLoading}
        items={autocomplete.items}
        onClose={() => {
          autocomplete.close();
          setTextareaRect(null);
        }}
        onExpandDirectory={handleExpandDirectory}
        onRetry={autocomplete.retry}
        onSelect={handleSelectAutocomplete}
      />
    </ComposerDock>
  );
}
