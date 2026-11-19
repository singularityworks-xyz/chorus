"use client";

import type { BoardViewMode } from "@chorus/contracts";
import { BellIcon, CheckIcon, FolderIcon, MenuIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  sharedDropdownContentClass,
  sharedDropdownItemClass,
} from "@/components/ui/dropdown-aesthetics";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getPendingNotifications,
  NotificationPane,
} from "@/features/notifications/notification-pane";
import { SettingsMenu } from "@/features/settings/settings-menu";
import { MobileMenuDrawer } from "@/features/workspace/components/mobile-menu-drawer";
import { useWorkspace } from "@/features/workspace/workspace-context";
import { cn } from "@/lib/utils";

const islandChrome =
  "pointer-events-auto relative rounded-sm border border-white/10 bg-zinc-950/68 shadow-[0_18px_50px_rgba(0,0,0,0.42)] backdrop-blur-2xl";
const headerMenuContentClass = cn(sharedDropdownContentClass, "min-w-72 p-1.5");
const headerSubmenuContentClass = cn(
  sharedDropdownContentClass,
  "min-w-80 p-1.5"
);
const headerMenuItemClass = cn(
  sharedDropdownItemClass,
  "focus:!text-white cursor-pointer px-3 py-2 text-sm text-white/85"
);
const headerMenuSubTriggerClass = cn(
  headerMenuItemClass,
  "data-[popup-open]:!text-white data-[popup-open]:**:!text-white data-[popup-open]:bg-white/10"
);
const headerMenuEmptyStateLabelClass = "px-3 py-2 text-[12px] text-white/40";
const headerMenuSectionLabelClass =
  "px-3 pb-1 pt-2 text-[10px] uppercase tracking-[0.2em] text-white/34";
function ViewMenu({
  boardViewMode,
  onValueChange,
}: {
  boardViewMode: BoardViewMode;
  onValueChange: (mode: BoardViewMode) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="group relative shrink-0 rounded-xs px-3 py-2 text-sm text-zinc-300 transition duration-300 hover:text-white">
        <span className="relative z-10">View</span>
        <div className="absolute inset-0 rounded-xs border border-transparent bg-zinc-900/85 opacity-0 transition duration-300 group-hover:opacity-100" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className={cn(headerMenuContentClass, "min-w-88")}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className={headerMenuSectionLabelClass}>
            Board Layout
          </DropdownMenuLabel>
          <DropdownMenuItem
            className={headerMenuItemClass}
            onClick={() => onValueChange("stacked")}
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium text-sm text-white/92">Stacked</span>
              <span className="text-white/42 text-xs">
                Layer boards as a deck while keeping every title bar exposed.
              </span>
            </div>
            {boardViewMode === "stacked" ? (
              <CheckIcon className="size-4 text-white/70" />
            ) : null}
          </DropdownMenuItem>
          <DropdownMenuItem
            className={headerMenuItemClass}
            onClick={() => onValueChange("relaxed")}
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium text-sm text-white/92">Relaxed</span>
              <span className="text-white/42 text-xs">
                Auto-place boards into a clean non-overlapping grid.
              </span>
            </div>
            {boardViewMode === "relaxed" ? (
              <CheckIcon className="size-4 text-white/70" />
            ) : null}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppHeader() {
  const [notifOpen, setNotifOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  const {
    boards,
    createBoardFromHistory,
    createBoardFromProject,
    isLoadingRecentProjects,
    isOpeningFolder,
    loadProjects,
    openFolder,
    preferences,
    previousWorkspaces,
    recentProjects,
    recentProjectsError,
    recentProjectsLoaded,
    setBoardViewMode,
  } = useWorkspace();

  // Close notification pane on outside click
  useEffect(() => {
    if (!notifOpen) {
      return;
    }
    function handleClick(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [notifOpen]);

  const unreadCount = getPendingNotifications(boards).length;

  return (
    <>
      <MobileMenuDrawer
        boardViewMode={preferences.boardViewMode}
        createBoardFromHistory={createBoardFromHistory}
        createBoardFromProject={createBoardFromProject}
        isLoadingRecentProjects={isLoadingRecentProjects}
        isOpeningFolder={isOpeningFolder}
        loadProjects={loadProjects}
        onClose={() => setMobileMenuOpen(false)}
        onOpenFolder={() => {
          openFolder().catch((error) => {
            console.error("Failed to open folder", error);
          });
        }}
        open={mobileMenuOpen}
        previousWorkspaces={previousWorkspaces}
        recentProjects={recentProjects}
        recentProjectsError={recentProjectsError}
        recentProjectsLoaded={recentProjectsLoaded}
        setBoardViewMode={setBoardViewMode}
      />

      <header className="pointer-events-none fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-4">
        <div className="flex items-start justify-between gap-2 sm:gap-3">
          <div className={cn(islandChrome, "min-w-0 shrink")}>
            <div className="relative flex h-12 min-w-0 items-center gap-2 px-2">
              <Link
                aria-label="Go to Chorus home"
                className="flex shrink-0 items-center gap-2 rounded-sm border border-white/8 bg-zinc-900/78 px-3 py-2 transition-colors hover:bg-zinc-900/92"
                href="/"
              >
                <Image
                  alt="Chorus logo"
                  className="h-4.75 w-6 invert"
                  height={19}
                  loading="eager"
                  src="/chorus.svg"
                  width={24}
                />
                <span className="hidden select-none font-medium text-sm text-white tracking-[0.01em] min-[480px]:inline">
                  Chorus
                </span>
              </Link>
              <button
                aria-label="Open menu"
                className={cn(
                  "group relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xs text-zinc-300 transition duration-300 hover:text-white sm:hidden"
                )}
                onClick={() => setMobileMenuOpen(true)}
                type="button"
              >
                <div className="absolute inset-0 rounded-xs border border-white/8 bg-zinc-900/80 opacity-0 transition duration-300 group-hover:opacity-100" />
                <MenuIcon className="relative z-10 size-4" />
              </button>
              <div className="hidden h-6 w-px shrink-0 bg-white/10 sm:block" />

              <nav className="hidden min-w-0 items-center gap-1 overflow-x-auto pr-1 [scrollbar-width:none] sm:flex [&::-webkit-scrollbar]:hidden">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className={cn(
                      "group relative shrink-0 rounded-xs px-3 py-2 text-sm text-zinc-300 transition duration-300 hover:text-white"
                    )}
                  >
                    <span className="relative z-10">File</span>
                    <div className="absolute inset-0 rounded-xs border border-transparent bg-zinc-900/85 opacity-0 transition duration-300 group-hover:opacity-100" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className={headerMenuContentClass}>
                    <DropdownMenuItem
                      className={headerMenuItemClass}
                      onClick={() => {
                        openFolder().catch((error) => {
                          console.error("Failed to open folder", error);
                        });
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <FolderIcon className="size-4 text-white/40" />
                        <span>
                          {isOpeningFolder ? "Opening…" : "Open Folder..."}
                        </span>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="bg-white/8" />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger
                        className={headerMenuSubTriggerClass}
                      >
                        Previous Working
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent
                        className={headerSubmenuContentClass}
                      >
                        {previousWorkspaces.length === 0 ? (
                          <DropdownMenuGroup>
                            <DropdownMenuLabel
                              className={headerMenuEmptyStateLabelClass}
                            >
                              No previous work yet
                            </DropdownMenuLabel>
                          </DropdownMenuGroup>
                        ) : (
                          previousWorkspaces.map((entry) => (
                            <DropdownMenuItem
                              className={headerMenuItemClass}
                              key={entry.id}
                              onClick={() => {
                                createBoardFromHistory(entry);
                              }}
                            >
                              <div className="flex min-w-0 flex-col">
                                <span className="truncate font-medium text-sm text-white/90">
                                  {entry.title}
                                </span>
                                <span className="truncate text-white/40 text-xs">
                                  {entry.repo.directory}
                                </span>
                              </div>
                            </DropdownMenuItem>
                          ))
                        )}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger
                        className={headerMenuSubTriggerClass}
                      >
                        Known Projects
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent
                        className={headerSubmenuContentClass}
                      >
                        {recentProjectsError && (
                          <DropdownMenuGroup>
                            <DropdownMenuLabel
                              className={headerMenuEmptyStateLabelClass}
                            >
                              {recentProjectsError}
                            </DropdownMenuLabel>
                            <DropdownMenuItem
                              className={headerMenuItemClass}
                              disabled={isLoadingRecentProjects}
                              onClick={loadProjects}
                            >
                              {isLoadingRecentProjects
                                ? "Retrying…"
                                : "Retry loading projects"}
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        )}
                        {isLoadingRecentProjects &&
                          recentProjects.length > 0 && (
                            <DropdownMenuGroup>
                              <DropdownMenuLabel
                                className={headerMenuEmptyStateLabelClass}
                                role="status"
                              >
                                Refreshing known projects…
                              </DropdownMenuLabel>
                            </DropdownMenuGroup>
                          )}
                        {recentProjects.length === 0 &&
                          !recentProjectsError && (
                            <DropdownMenuGroup>
                              <DropdownMenuLabel
                                className={headerMenuEmptyStateLabelClass}
                              >
                                {isLoadingRecentProjects ||
                                !recentProjectsLoaded
                                  ? "Loading known projects…"
                                  : "No known projects yet"}
                              </DropdownMenuLabel>
                            </DropdownMenuGroup>
                          )}
                        {recentProjects.map((project) => (
                          <DropdownMenuItem
                            className={headerMenuItemClass}
                            key={`${project.projectId ?? project.directory}`}
                            onClick={() => {
                              createBoardFromProject(project);
                            }}
                          >
                            <div className="flex min-w-0 flex-col">
                              <span className="truncate font-medium text-sm text-white/90">
                                {project.projectName ??
                                  project.directory
                                    .split("/")
                                    .filter(Boolean)
                                    .at(-1) ??
                                  project.directory}
                              </span>
                              <span className="truncate text-white/40 text-xs">
                                {project.directory}
                              </span>
                            </div>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </DropdownMenuContent>
                </DropdownMenu>
                <ViewMenu
                  boardViewMode={preferences.boardViewMode}
                  onValueChange={setBoardViewMode}
                />

                <Link
                  className={cn(
                    "group relative inline-block shrink-0 rounded-xs px-3 py-2 text-sm text-zinc-300 transition duration-300 hover:text-white"
                  )}
                  href="/help"
                >
                  <span className="relative z-10">Help</span>
                  <div className="absolute inset-0 rounded-xs border border-transparent bg-zinc-900/85 opacity-0 transition duration-300 group-hover:opacity-100" />
                </Link>
              </nav>
            </div>
          </div>
          <div className={cn(islandChrome, "shrink-0")}>
            <div className="flex h-12 items-center divide-x divide-white/8">
              <div className="relative" ref={notifRef}>
                <button
                  aria-label="Notifications"
                  className={cn(
                    "group relative flex h-12 w-12 items-center justify-center text-zinc-300 transition duration-300 hover:text-white",
                    notifOpen && "text-white"
                  )}
                  onClick={() => setNotifOpen((v) => !v)}
                  type="button"
                >
                  <div
                    className={cn(
                      "absolute inset-[5px] rounded-xs border bg-zinc-900/80 transition duration-300",
                      notifOpen
                        ? "border-cyan-300/18 bg-zinc-900"
                        : "border-white/8 group-hover:border-cyan-300/18 group-hover:bg-zinc-900"
                    )}
                  />
                  <BellIcon
                    className={cn(
                      "relative z-10 h-4 w-4 transition duration-300",
                      notifOpen && "text-white"
                    )}
                  />
                  {unreadCount > 0 && (
                    <span className="absolute top-2.5 right-2.5 flex size-3.5 items-center justify-center rounded-full bg-cyan-500 font-semibold text-[0.5rem] text-white shadow-[0_0_6px_rgba(6,182,212,0.6)]">
                      {unreadCount}
                    </span>
                  )}
                </button>
                {notifOpen && (
                  <NotificationPane onClose={() => setNotifOpen(false)} />
                )}
              </div>
              <SettingsMenu />
            </div>
          </div>
        </div>
      </header>
    </>
  );
}
