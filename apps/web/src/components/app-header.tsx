"use client";

import type { BoardViewMode, WorkspaceBoard } from "@chorus/contracts";
import { BellIcon, CheckIcon, FolderIcon, MenuIcon, XIcon } from "lucide-react";
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
import { PushSettings } from "@/features/notifications/push-settings";
import { SettingsMenu } from "@/features/settings/settings-menu";
import { useWorkspace } from "@/features/workspace/workspace-context";
import { cn } from "@/lib/utils";

const menuItems = ["Edit", "Window", "Help"];
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
type NotifType = "permission" | "question";

interface Notification {
  boardId: string;
  boardTitle: string;
  body: string;
  cardId: string;
  id: string;
  kind: NotifType;
  title: string;
}

function getPendingNotifications(
  boards: readonly WorkspaceBoard[]
): Notification[] {
  return boards.flatMap((board) =>
    Object.values(board.columns).flatMap((tasks) =>
      tasks.flatMap((task) => {
        const pending =
          task.pendingApprovals ??
          (task.pendingApproval ? [task.pendingApproval] : []);
        return pending.map((request) => ({
          boardId: board.boardId,
          boardTitle: board.title,
          body: task.title,
          cardId: task.id,
          id:
            board.boardId +
            ":" +
            task.id +
            ":" +
            (request.requestId ?? request.kind),
          kind: request.kind,
          title:
            request.kind === "permission"
              ? "Permission needed"
              : "Answer requested",
        }));
      })
    )
  );
}
function NotificationPane({ onClose }: { onClose: () => void }) {
  const { boards } = useWorkspace();
  const notifications = getPendingNotifications(boards);

  return (
    <div
      className={cn(
        "absolute top-[calc(100%+8px)] right-0",
        "w-[calc(100vw-1.5rem)] max-w-[360px] sm:w-[360px]",
        "overflow-hidden rounded-sm",
        "border border-white/10 bg-zinc-950/90 shadow-[0_24px_60px_rgba(0,0,0,0.55)] backdrop-blur-2xl"
      )}
    >
      <div className="flex items-center gap-2 border-white/6 border-b px-4 py-3">
        <span className="flex-1 font-semibold text-[0.78rem] text-white/80 tracking-wide">
          Pending approvals
        </span>
        <button
          aria-label="Close notifications"
          className="flex size-6 items-center justify-center rounded-xs text-white/30 transition-colors hover:bg-white/6 hover:text-white/60"
          onClick={onClose}
          type="button"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      <PushSettings />

      <div className="max-h-[min(360px,calc(100dvh-12rem))] overflow-y-auto">
        {notifications.length === 0 ? (
          <p className="px-4 py-8 text-center text-[0.68rem] text-white/30">
            No pending approval requests.
          </p>
        ) : (
          notifications.map((notification) => {
            const target = new URLSearchParams({
              board: notification.boardId,
              card: notification.cardId,
            });
            return (
              <Link
                className="block border-white/[0.04] border-b px-4 py-3 transition-colors hover:bg-white/[0.04]"
                href={`/?${target.toString()}`}
                key={notification.id}
                onClick={onClose}
              >
                <span className="block font-medium text-[0.68rem] text-white/80">
                  {notification.title}
                </span>
                <span className="mt-1 block truncate text-[0.62rem] text-white/45">
                  {notification.body}
                </span>
                <span className="mt-1 block truncate text-[0.58rem] text-white/25">
                  {notification.boardTitle}
                </span>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
// ─── MobileMenuDrawer ──────────────────────────────────────────────────────────
function MobileMenuDrawer({
  open,
  onClose,
  onOpenFolder,
  boardViewMode,
  isOpeningFolder,
  isLoadingRecentProjects,
  recentProjectsError,
  recentProjectsLoaded,
  loadProjects,
  previousWorkspaces,
  recentProjects,
  createBoardFromHistory,
  createBoardFromProject,
  setBoardViewMode,
}: {
  open: boolean;
  onClose: () => void;
  onOpenFolder: () => void;
  boardViewMode: BoardViewMode;
  isOpeningFolder: boolean;
  isLoadingRecentProjects: boolean;
  recentProjectsError: string | null;
  recentProjectsLoaded: boolean;
  loadProjects: ReturnType<typeof useWorkspace>["loadProjects"];
  previousWorkspaces: ReturnType<typeof useWorkspace>["previousWorkspaces"];
  recentProjects: ReturnType<typeof useWorkspace>["recentProjects"];
  createBoardFromHistory: ReturnType<
    typeof useWorkspace
  >["createBoardFromHistory"];
  createBoardFromProject: ReturnType<
    typeof useWorkspace
  >["createBoardFromProject"];
  setBoardViewMode: ReturnType<typeof useWorkspace>["setBoardViewMode"];
}) {
  // Lock body scroll while drawer is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const allMenuItems = ["Edit", "Window", "Help"];

  return (
    <>
      {/* Backdrop — full-screen button so keyboard/SR users can also close the drawer */}
      <button
        aria-label="Close menu"
        className="fixed inset-0 z-60 cursor-default bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        type="button"
      />
      {/* Drawer panel */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-61 flex w-72 flex-col",
          "border-white/10 border-r bg-zinc-950/95 shadow-[4px_0_40px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
        )}
      >
        {/* Drawer header */}
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-white/8 border-b px-4">
          <Link
            aria-label="Go to Chorus home"
            className="flex items-center gap-2 rounded-xs transition-colors hover:text-white/90"
            href="/"
            onClick={onClose}
          >
            <Image
              alt="Chorus logo"
              className="h-5 w-6 invert"
              height={19}
              loading="eager"
              src="/chorus.svg"
              width={24}
            />
            <span className="select-none font-semibold text-sm text-white tracking-[0.02em]">
              Chorus
            </span>
          </Link>
          <button
            className="flex size-7 items-center justify-center rounded-xs text-white/30 transition-colors hover:bg-white/8 hover:text-white/70"
            onClick={onClose}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {/* Drawer content */}
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
          {/* File section */}
          <div className="mb-1">
            <p className="mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
              File
            </p>
            <button
              className="flex w-full items-center gap-2.5 rounded-xs px-3 py-2.5 text-sm text-white/70 transition-colors hover:bg-white/6 hover:text-white"
              onClick={() => {
                onOpenFolder();
                onClose();
              }}
              type="button"
            >
              <span className="text-white/40">
                <FolderIcon className="size-4" />
              </span>
              {isOpeningFolder ? "Opening…" : "Open Folder…"}
            </button>

            {previousWorkspaces.length > 0 && (
              <>
                <p className="mt-3 mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
                  Previous Working
                </p>
                {previousWorkspaces.map((entry) => (
                  <button
                    className="flex w-full flex-col rounded-xs px-3 py-2 transition-colors hover:bg-white/6"
                    key={entry.id}
                    onClick={() => {
                      createBoardFromHistory(entry);
                      onClose();
                    }}
                    type="button"
                  >
                    <span className="truncate font-medium text-sm text-white/85">
                      {entry.title}
                    </span>
                    <span className="truncate text-[0.67rem] text-white/35">
                      {entry.repo.directory}
                    </span>
                  </button>
                ))}
              </>
            )}

            <p className="mt-3 mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
              Known Projects
            </p>
            {(isLoadingRecentProjects ||
              !(recentProjectsLoaded || recentProjectsError)) && (
              <p
                className="px-3 py-2 text-[0.67rem] text-white/40"
                role="status"
              >
                {recentProjects.length > 0
                  ? "Refreshing known projects…"
                  : "Loading known projects…"}
              </p>
            )}
            {recentProjectsError && (
              <div
                className="flex flex-col gap-2 rounded-xs border border-rose-500/15 bg-rose-500/[0.03] px-3 py-2 text-[0.67rem] text-rose-200/80"
                role="alert"
              >
                <span>{recentProjectsError}</span>
                <button
                  className="self-start underline underline-offset-2 disabled:opacity-50"
                  disabled={isLoadingRecentProjects}
                  onClick={loadProjects}
                  type="button"
                >
                  {isLoadingRecentProjects ? "Retrying…" : "Retry"}
                </button>
              </div>
            )}
            {recentProjects.length === 0 &&
              recentProjectsLoaded &&
              !isLoadingRecentProjects &&
              !recentProjectsError && (
                <p className="px-3 py-2 text-[0.67rem] text-white/40">
                  No known projects yet
                </p>
              )}
            {recentProjects.map((project) => (
              <button
                className="flex w-full flex-col rounded-xs px-3 py-2 transition-colors hover:bg-white/6"
                key={`${project.projectId ?? project.directory}`}
                onClick={() => {
                  createBoardFromProject(project);
                  onClose();
                }}
                type="button"
              >
                <span className="truncate font-medium text-sm text-white/85">
                  {project.projectName ??
                    project.directory.split("/").filter(Boolean).at(-1) ??
                    project.directory}
                </span>
                <span className="truncate text-[0.67rem] text-white/35">
                  {project.directory}
                </span>
              </button>
            ))}
          </div>

          <div className="my-1 h-px bg-white/6" />

          <div>
            <p className="mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
              View
            </p>
            <button
              className={cn(
                "flex w-full flex-col items-start rounded-xs px-3 py-2.5 text-left transition-colors",
                boardViewMode === "stacked"
                  ? "bg-white/8 text-white"
                  : "text-white/65 hover:bg-white/6 hover:text-white"
              )}
              onClick={() => {
                setBoardViewMode("stacked");
                onClose();
              }}
              type="button"
            >
              <span className="font-medium text-sm">Stacked</span>
              <span className="text-[0.67rem] text-white/40">
                Layer boards into a card stack with visible title bars.
              </span>
            </button>
            <button
              className={cn(
                "mt-1 flex w-full flex-col items-start rounded-xs px-3 py-2.5 text-left transition-colors",
                boardViewMode === "relaxed"
                  ? "bg-white/8 text-white"
                  : "text-white/65 hover:bg-white/6 hover:text-white"
              )}
              onClick={() => {
                setBoardViewMode("relaxed");
                onClose();
              }}
              type="button"
            >
              <span className="font-medium text-sm">Relaxed</span>
              <span className="text-[0.67rem] text-white/40">
                Auto-arrange boards into a clean grid with no overlap.
              </span>
            </button>
          </div>

          <div className="my-1 h-px bg-white/6" />

          {/* Other menu items */}
          <div>
            <p className="mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
              Menu
            </p>
            {allMenuItems.map((item) => {
              if (item === "Help") {
                return (
                  <Link
                    className="flex w-full items-center rounded-xs px-3 py-2.5 text-sm text-white/60 transition-colors hover:bg-white/6 hover:text-white"
                    href="/help"
                    key={item}
                    onClick={onClose}
                  >
                    {item}
                  </Link>
                );
              }
              return (
                <button
                  className="flex w-full items-center rounded-xs px-3 py-2.5 text-sm text-white/60 transition-colors hover:bg-white/6 hover:text-white"
                  key={item}
                  onClick={onClose}
                  type="button"
                >
                  {item}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

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

// ─── AppHeader ─────────────────────────────────────────────────────────────────
export function AppHeader() {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
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
      {/* ── Mobile drawer ── */}
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
          {/* ── Left island: logo + nav ── */}
          <div className={cn(islandChrome, "min-w-0 shrink")}>
            <div className="relative flex h-12 min-w-0 items-center gap-2 px-2">
              {/* Logo pill — always visible */}
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
                {/* Hide the wordmark on very small screens (<480px) */}
                <span className="hidden select-none font-medium text-sm text-white tracking-[0.01em] min-[480px]:inline">
                  Chorus
                </span>
              </Link>

              {/* ── Mobile: hamburger button ── */}
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

              {/* ── Desktop: divider + nav items ── */}
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

                {menuItems.map((item) => {
                  const isActive = activeMenu === item;

                  if (item === "Help") {
                    return (
                      <Link
                        className={cn(
                          "group relative inline-block shrink-0 rounded-xs px-3 py-2 text-sm text-zinc-300 transition duration-300 hover:text-white"
                        )}
                        href="/help"
                        key={item}
                      >
                        <span className="relative z-10">{item}</span>
                        <div className="absolute inset-0 rounded-xs border border-transparent bg-zinc-900/85 opacity-0 transition duration-300 group-hover:opacity-100" />
                      </Link>
                    );
                  }

                  return (
                    <button
                      className={cn(
                        "group relative shrink-0 rounded-xs px-3 py-2 text-sm text-zinc-300 transition duration-300 hover:text-white",
                        isActive && "text-white"
                      )}
                      key={item}
                      onClick={() => setActiveMenu(isActive ? null : item)}
                      onMouseEnter={() => activeMenu && setActiveMenu(item)}
                      type="button"
                    >
                      <span className="relative z-10">{item}</span>
                      <div
                        className={cn(
                          "absolute inset-0 rounded-xs border border-transparent bg-zinc-900/85 opacity-0 transition duration-300 group-hover:opacity-100",
                          isActive &&
                            "border-cyan-300/18 bg-zinc-900 opacity-100"
                        )}
                      />
                    </button>
                  );
                })}
              </nav>
            </div>
          </div>

          {/* ── Right island: notifications + settings ── */}
          <div className={cn(islandChrome, "shrink-0")}>
            <div className="flex h-12 items-center divide-x divide-white/8">
              {/* Notification button */}
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
                  {/* Unread badge */}
                  {unreadCount > 0 && (
                    <span className="absolute top-2.5 right-2.5 flex size-3.5 items-center justify-center rounded-full bg-cyan-500 font-semibold text-[0.5rem] text-white shadow-[0_0_6px_rgba(6,182,212,0.6)]">
                      {unreadCount}
                    </span>
                  )}
                </button>

                {/* Floating notification pane */}
                {notifOpen && (
                  <NotificationPane onClose={() => setNotifOpen(false)} />
                )}
              </div>

              {/* Settings button with OpenCode provider management */}
              <SettingsMenu />
            </div>
          </div>
        </div>
      </header>
    </>
  );
}
