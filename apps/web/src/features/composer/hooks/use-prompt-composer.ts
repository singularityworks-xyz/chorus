import posthog from "posthog-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/features/workspace/workspace-context";
import { extractLineRange, formatLineRange } from "@/lib/line-range";
import { promptSubmissionErrorMessage } from "../lib/prompt-input";
import type { AutocompleteItem, ComposerPart } from "../types";
import { useAutocomplete } from "./use-autocomplete";
import { usePromptModelSelection } from "./use-prompt-model-selection";
import { useVoiceRecording } from "./use-voice-recording";

export function usePromptComposer() {
  const [isMounted, setIsMounted] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [parts, setParts] = useState<ComposerPart[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
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
  } = useWorkspace();
  const modelSelection = usePromptModelSelection();
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

  const handleTranscriptionComplete = useCallback((text: string) => {
    setPrompt((previous) => previous + (previous ? " " : "") + text);
  }, []);
  const { isRecording, isTranscribing, startRecording, stopRecording } =
    useVoiceRecording(handleTranscriptionComplete);
  const voiceActionLabel = isRecording
    ? "Stop voice input"
    : "Start voice input";

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
      const insertText = `@${displaySuffix}${formatLineRange(range)} `;
      const newPrompt = before + insertText + after;
      setPrompt(newPrompt);

      const partType = item.type === "file" ? "file" : item.type;
      setParts((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          type: partType,
          filename: displaySuffix,
          path: item.path ?? item.id,
          isDirectory: item.isDirectory,
          mime: item.isDirectory ? "application/x-directory" : "text/plain",
          lineRange: range ?? undefined,
          name: item.type === "file" ? undefined : item.label,
        },
      ]);

      autocomplete.close();
      setTextareaRect(null);

      requestAnimationFrame(() => {
        textarea.focus();
        const newPosition = triggerIndex + insertText.length;
        textarea.setSelectionRange(newPosition, newPosition);
      });
    },
    [autocomplete, prompt]
  );

  const submitPrompt = useCallback(async () => {
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

    const fileParts = parts.filter((part) => part.type === "file");
    posthog.capture("prompt_submit", {
      hasFileParts: fileParts.length > 0,
      filePartCount: fileParts.length,
      fileParts: fileParts.map((part) => ({
        filename: part.filename,
        path: part.path,
        mime: part.mime,
        isDirectory: part.isDirectory,
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
        model: modelSelection.selectedModel,
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
  }, [
    hasActiveRun,
    isBusy,
    modelSelection.selectedModel,
    parts,
    prompt,
    queuePrompt,
    selectedBoard,
    sessionCommand,
  ]);

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      return submitPrompt();
    },
    [submitPrompt]
  );

  const handleInput = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setSubmitError(null);
      setPrompt(event.target.value);
      event.target.style.height = "auto";
      event.target.style.height = `${event.target.scrollHeight}px`;
      autocomplete.checkTrigger(
        event.target.value,
        event.target.selectionStart
      );
    },
    [autocomplete]
  );

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
    (item: AutocompleteItem) => autocomplete.expandDirectory(item),
    [autocomplete]
  );

  const closeAutocomplete = useCallback(() => {
    autocomplete.close();
    setTextareaRect(null);
  }, [autocomplete]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (autocomplete.isOpen && event.key === "Escape") {
        event.preventDefault();
        autocomplete.close();
        setTextareaRect(null);
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitPrompt().catch((error: unknown) => {
          console.error("Failed to submit prompt", error);
        });
        event.currentTarget.style.height = "auto";
      }
    },
    [autocomplete, submitPrompt]
  );

  const handleVoiceButtonClick = useCallback(async () => {
    if (isRecording) {
      await stopRecording();
      return;
    }
    await startRecording();
  }, [isRecording, startRecording, stopRecording]);

  const removePart = useCallback((partId: string) => {
    setParts((previous) => previous.filter((part) => part.id !== partId));
  }, []);

  return {
    ...modelSelection,
    attachedFiles: parts.filter((part) => part.type === "file"),
    autocomplete,
    boards,
    closeAutocomplete,
    dismissComposerHint,
    handleExpandDirectory,
    handleInput,
    handleKeyDown,
    handleModelValueChange: modelSelection.handleModelValueChange,
    handleSelectAutocomplete,
    handleSubmit,
    handleVoiceButtonClick,
    hasActiveRun,
    isBusy,
    isMounted,
    isRecording,
    isTranscribing,
    preferences,
    prompt,
    removePart,
    selectBoard,
    selectedBoard,
    sessionMessage,
    submitError,
    textareaRef,
    textareaRect,
    voiceActionLabel,
  };
}
