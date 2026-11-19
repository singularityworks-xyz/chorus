"use client";

import { ArrowUp, Mic, XIcon } from "lucide-react";
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
import { ModelPicker } from "@/features/models/components/model-picker/model-picker";
import { cn } from "@/lib/utils";
import { usePromptComposer } from "../hooks/use-prompt-composer";
import { getBoardRepoName } from "../lib/prompt-input";
import { CommandPalette } from "./command-palette";
import { ComposerDock } from "./composer-dock";
import { ComposerHint } from "./composer-hint";

const composerSelectTriggerClass = sharedDropdownTriggerClass;
const composerSelectContentClass = sharedDropdownContentClass;
const composerSelectItemClass = sharedDropdownItemClass;

export function PromptInput() {
  const {
    attachedFiles,
    autocomplete,
    availableModels,
    boards,
    defaultModel,
    dismissComposerHint,
    handleExpandDirectory,
    handleInput,
    handleKeyDown,
    handleModelValueChange,
    handleSelectAutocomplete,
    handleSubmit,
    handleVoiceButtonClick,
    hasActiveRun,
    isBusy,
    isLoadingModels,
    isMounted,
    isRecording,
    isTranscribing,
    modelSelectionError,
    preferences,
    prompt,
    removePart,
    selectBoard,
    selectedBoard,
    selectedModelKey,
    sessionMessage,
    submitError,
    textareaRef,
    textareaRect,
    voiceActionLabel,
    closeAutocomplete,
  } = usePromptComposer();

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
            {/* The placeholder is not an accessible name. */}
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
            {submitError ? (
              <p
                className="text-[11px] text-rose-200/90 leading-4"
                role="alert"
              >
                {submitError}
              </p>
            ) : null}

            <div className="flex items-center justify-between opacity-80 transition-opacity focus-within:opacity-100">
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

              <div className="flex items-center gap-2">
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
        onClose={closeAutocomplete}
        onExpandDirectory={handleExpandDirectory}
        onRetry={autocomplete.retry}
        onSelect={handleSelectAutocomplete}
      />
    </ComposerDock>
  );
}
