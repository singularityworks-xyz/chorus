import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  applyEventToBoard,
  queueBoardPromptResponseSchema,
  serverMessageSchema,
  sessionFileDiffsSchema,
  type WorkspaceBoard,
  webSocketTicketResponseSchema,
  workspaceSnapshotSchema,
} from "@chorus/contracts";
import { Elysia } from "elysia";
import { authGuardHandler } from "../src/auth/guard";
import { createAuthRoutes } from "../src/auth/routes";
import { OpenCodeBridge } from "../src/bridge/opencode/bridge";
import { RepositoryRegistry } from "../src/projects/repository-registry";
import { WorktreeManager } from "../src/projects/worktree-manager";
import { createHttpRoutes } from "../src/routes";
import { createWorkspaceRoutes } from "../src/routes/workspace";
import { BoardTaskService } from "../src/tasks/board-task-service";
import { WorkspaceStore } from "../src/workspace/store";
import { createWsHandler } from "../src/ws/handler";
import { WorkspaceHub } from "../src/ws/hub";
import { startScriptedEngine } from "./fixtures/opencode-engine";

const SNAPSHOT_HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

interface QualificationRun {
  boardId: string;
  sessionId: string;
}

export async function waitForQualification(
  predicate: () => boolean,
  timeoutMs = 5000,
  timeoutDetails?: () => unknown
) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      const details = timeoutDetails?.();
      throw new Error(
        details === undefined
          ? "qualification condition timed out"
          : `qualification condition timed out: ${JSON.stringify(details)}`
      );
    }
    await new Promise((done) => setTimeout(done, 10));
  }
}

function wireComparable(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : JSON.parse(serialized);
}

function readSnapshotHash(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("hash" in value) ||
    typeof value.hash !== "string" ||
    !SNAPSHOT_HASH_PATTERN.test(value.hash)
  ) {
    throw new Error("snapshot tracking returned an invalid tree hash");
  }
  return value.hash;
}

/** Real repositories, SDK, HTTP commands, SQLite writer and authenticated WS mirrors. */
export async function startPhase6Harness() {
  const root = mkdtempSync(join(tmpdir(), "chorus-qualification-"));
  const engine = startScriptedEngine();
  const repositories: string[] = [];
  let store: WorkspaceStore | undefined;
  let hub: WorkspaceHub | undefined;
  let bridge: OpenCodeBridge | undefined;
  let stopHttp: (() => Promise<void>) | undefined;
  const mirrors: Array<{
    socket: WebSocket;
    boards: WorkspaceBoard[];
    seq: number;
    error?: string;
    initialized: boolean;
  }> = [];
  const latencies: number[] = [];
  let latencyCursor = 0;
  let frameCount = 0;

  function git(directory: string, args: string[]) {
    return execFileSync("git", args, {
      cwd: directory,
      windowsHide: true,
      timeout: 10_000,
    }).toString();
  }

  async function close() {
    for (const mirror of mirrors) {
      mirror.socket.close();
    }
    hub?.close();
    bridge?.stop();
    await stopHttp?.();
    await store?.close();
    await engine.stop();
    const insideTemp = relative(resolve(tmpdir()), resolve(root));
    if (
      insideTemp.startsWith("..") ||
      !insideTemp.startsWith("chorus-qualification-")
    ) {
      throw new Error(
        "refusing to remove an unexpected qualification directory"
      );
    }
    rmSync(root, { recursive: true, force: true });
  }

  try {
    for (let index = 0; index < 3; index += 1) {
      const directory = join(root, `repo-${index}`);
      mkdirSync(directory);
      git(directory, ["init", "--quiet"]);
      git(directory, ["config", "user.email", "fixture@example.com"]);
      git(directory, ["config", "user.name", "Chorus fixture"]);
      writeFileSync(join(directory, "README.md"), "# Scripted fixture\n");
      git(directory, ["add", "README.md"]);
      git(directory, ["commit", "--quiet", "-m", "fixture"]);
      repositories.push(directory);
    }
    const registry = await RepositoryRegistry.fromEnvironment(
      JSON.stringify(repositories)
    );
    const workspace = new WorkspaceStore(join(root, "data"), {
      repositoryRegistry: registry,
      worktreeProvisioner: new WorktreeManager(),
    });
    store = workspace;
    await workspace.load();
    const workspaceHub = new WorkspaceHub(workspace);
    hub = workspaceHub;
    workspace.onCommit((commit) => workspaceHub.publish(commit));
    const engineBridge = new OpenCodeBridge(
      engine.baseUrl,
      repositories[0] ?? root
    );
    bridge = engineBridge;
    engineBridge.subscribe(async (event) => {
      await workspace.applyAgentEvent(event);
    });
    const boardTasks = new BoardTaskService(
      engineBridge,
      workspace,
      undefined,
      null,
      registry
    );
    const token = crypto.randomUUID();
    const ticketOptions = { store: workspace.meta, now: Date.now };
    const app = new Elysia()
      .resolve({ as: "global" }, authGuardHandler({ token, ticketOptions }))
      .use(
        createAuthRoutes({
          token,
          ticketStore: workspace.meta,
          isProduction: false,
        })
      )
      .use(createWorkspaceRoutes(workspace, boardTasks))
      .use(createHttpRoutes(engineBridge, boardTasks, workspace))
      .use(
        createWsHandler({
          boardTasks,
          bridge: engineBridge,
          hub: workspaceHub,
          workspaceStore: workspace,
          token,
          ticketOptions,
        })
      )
      .listen({ hostname: "127.0.0.1", port: 0 });
    stopHttp = async () => {
      await app.stop(true);
    };
    const base = `http://127.0.0.1:${app.server?.port}`;
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const sessionCookie = login.headers.get("set-cookie")?.split(";")[0];
    if (!(login.ok && sessionCookie)) {
      throw new Error("qualification login failed");
    }
    const device = await fetch(`${base}/auth/device`, {
      method: "POST",
      headers: { cookie: sessionCookie },
    });
    const deviceCookie = device.headers.get("set-cookie")?.split(";")[0];
    if (!(device.ok && deviceCookie)) {
      throw new Error("qualification device registration failed");
    }
    const cookie = `${sessionCookie}; ${deviceCookie}`;
    async function request(path: string, body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { cookie, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        throw new Error(
          `qualification ${path} returned ${response.status}: ${await response.text()}`
        );
      }
      const data: unknown = await response.json();
      return data;
    }

    const boardIds: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const directory = repositories[index % 3];
      const state = workspaceSnapshotSchema.parse(
        await request("/workspace/mutations", {
          type: "board.create",
          clientId: "qualification",
          mutationId: `create-${index}`,
          baseRevision: null,
          payload: {
            seed: {
              title: `Run ${index}`,
              repo: { directory, worktree: directory, sandboxes: [] },
            },
          },
        })
      );
      const board = state.boards.at(-1);
      if (!board) {
        throw new Error("qualification board creation failed");
      }
      boardIds.push(board.boardId);
    }
    const snapshotHashes = new Map<string, string>();
    for (const boardId of boardIds) {
      const board = workspace.getBoard(boardId);
      const directory = board?.repo.worktree ?? board?.repo.directory;
      if (!directory) {
        throw new Error("qualification board has no checkout");
      }
      const tracked: unknown = await request("/snapshots/track", { directory });
      snapshotHashes.set(boardId, readSnapshotHash(tracked));
    }
    for (let index = 0; index < 10; index += 1) {
      const { ticket } = webSocketTicketResponseSchema.parse(
        await request("/auth/ws-ticket")
      );
      const socket = new WebSocket(
        `${base.replace("http:", "ws:")}/ws?ticket=${encodeURIComponent(ticket)}`
      );
      const mirror = {
        socket,
        boards: [] as WorkspaceBoard[],
        seq: 0,
        initialized: false,
        error: undefined as string | undefined,
      };
      mirrors.push(mirror);
      socket.addEventListener("open", () =>
        socket.send(JSON.stringify({ type: "hello", since: 0 }))
      );
      socket.addEventListener("message", (message) => {
        try {
          const frame = serverMessageSchema.parse(
            JSON.parse(String(message.data))
          );
          if (frame.type === "snapshot") {
            mirror.boards = frame.data.boards;
            mirror.seq = frame.seq;
            mirror.initialized = true;
          }
          if (frame.type === "event") {
            mirror.boards = mirror.boards.map((board) =>
              applyEventToBoard(board, frame.event)
            );
            mirror.seq = Math.max(mirror.seq, frame.seq);
            latencies[latencyCursor++ % 20_000] = Math.max(
              0,
              Date.now() - frame.ts
            );
            frameCount += 1;
          }
          if (frame.type === "ping") {
            socket.send(JSON.stringify({ type: "pong", at: frame.at }));
          }
          if (frame.type === "error") {
            mirror.error = JSON.stringify(frame);
          }
        } catch (error) {
          mirror.error = error instanceof Error ? error.message : String(error);
        }
      });
    }
    await waitForQualification(() =>
      mirrors.every((mirror) => mirror.initialized)
    );
    const runs = await Promise.all(
      boardIds.map(async (boardId) => {
        const board = workspace.getBoard(boardId);
        const response = queueBoardPromptResponseSchema.parse(
          await request("/tasks", {
            boardId,
            directory: board?.repo.worktree ?? board?.repo.directory,
            text: "Scripted isolated change",
            reviewMode: "auto",
          })
        );
        return { boardId, sessionId: response.sessionId };
      })
    );
    await waitForQualification(
      () =>
        boardIds.every(
          (boardId) =>
            (workspace.getBoard(boardId)?.columns.approve?.length ?? 0) === 1
        ),
      5000,
      () =>
        boardIds.map((boardId) => {
          const board = workspace.getBoard(boardId);
          return {
            boardId,
            columns: board?.columns,
            session: board?.session,
          };
        })
    );
    await Promise.all(
      runs.map((run) =>
        request(`/tasks/${run.sessionId}/approve`, {
          requestID: `permission-${run.sessionId}`,
        })
      )
    );

    function completeRun(run: QualificationRun): void {
      const board = workspace.getBoard(run.boardId);
      if (!board) {
        throw new Error("qualification lost a board");
      }
      const checkout = board.repo.worktree ?? board.repo.directory;
      writeFileSync(join(checkout, "result.txt"), `${run.sessionId}\n`);
      git(checkout, ["add", "result.txt"]);
      git(checkout, ["commit", "--quiet", "-m", "scripted result"]);
      engine.complete(run.sessionId);
    }

    async function verifyRunDiff(run: QualificationRun): Promise<void> {
      const board = workspace.getBoard(run.boardId);
      const directory = board?.repo.worktree ?? board?.repo.directory;
      const fromHash = snapshotHashes.get(run.boardId);
      if (!(directory && fromHash)) {
        throw new Error("qualification lost a board snapshot baseline");
      }
      await request("/snapshots/track", { directory });
      const snapshotDiff: unknown = await request(
        `/snapshots/diff?${new URLSearchParams({ directory, fromHash })}`
      );
      if (
        typeof snapshotDiff !== "object" ||
        snapshotDiff === null ||
        !("diff" in snapshotDiff) ||
        typeof snapshotDiff.diff !== "string" ||
        !snapshotDiff.diff.includes("result.txt")
      ) {
        throw new Error("qualification snapshot diff missed result.txt");
      }
      const sessionDiff: unknown = await request(
        `/sessions/${run.sessionId}/diff`
      );
      const parsed = sessionFileDiffsSchema.parse(sessionDiff);
      if (
        parsed.length !== 1 ||
        parsed[0]?.file !== "result.txt" ||
        parsed[0].after !== `${run.sessionId}\n`
      ) {
        throw new Error(
          "qualification session diff was not routed to its checkout"
        );
      }
    }

    function assertMirrorsConverged(): void {
      const expectedBoards = workspace.getSnapshot().boards;
      const expectedBoardIds = new Set(
        expectedBoards.map((board) => board.boardId)
      );
      const mismatches = mirrors.flatMap((mirror, mirrorIndex) => {
        const missingBoardIds = expectedBoards
          .filter(
            (board) =>
              !mirror.boards.some((actual) => actual.boardId === board.boardId)
          )
          .map((board) => board.boardId);
        const unexpectedBoardIds = mirror.boards
          .filter((board) => !expectedBoardIds.has(board.boardId))
          .map((board) => board.boardId);
        const differingBoard = expectedBoards.find((expected) => {
          const actual = mirror.boards.find(
            (board) => board.boardId === expected.boardId
          );
          return !(
            actual &&
            isDeepStrictEqual(wireComparable(actual), wireComparable(expected))
          );
        });

        if (
          !mirror.error &&
          missingBoardIds.length === 0 &&
          unexpectedBoardIds.length === 0 &&
          !differingBoard
        ) {
          return [];
        }

        const actualBoard = differingBoard
          ? mirror.boards.find(
              (board) => board.boardId === differingBoard.boardId
            )
          : undefined;
        return [
          {
            actualBoard,
            differingBoard,
            error: mirror.error,
            expectedSeq: workspace.headSeq(),
            missingBoardIds,
            mirrorIndex,
            seq: mirror.seq,
            unexpectedBoardIds,
          },
        ];
      });

      if (mismatches.length > 0) {
        throw new Error(
          `qualification WS mirrors diverged: ${JSON.stringify(mismatches)}`
        );
      }
    }

    return {
      close,
      engine,
      runs,
      mirrors,
      store: workspace,
      root,
      appendBatch(count: number) {
        for (let index = 0; index < count; index += 1) {
          const run = runs[index % runs.length];
          if (run) {
            engine.appendDelta(run.sessionId, ".");
          }
        }
      },
      async complete() {
        await Promise.all(runs.map(completeRun));
        await waitForQualification(() =>
          runs.every(
            (run) => workspace.getBoard(run.boardId)?.columns.done?.length === 1
          )
        );
        await waitForQualification(() =>
          mirrors.every((mirror) => mirror.seq === workspace.headSeq())
        );
        await Promise.all(runs.map(verifyRunDiff));
        assertMirrorsConverged();
        return {
          frames: frameCount,
          p95LatencyMs:
            [...latencies].sort((a, b) => a - b)[
              Math.floor(latencies.length * 0.95)
            ] ?? 0,
          snapshotBytes: Buffer.byteLength(
            JSON.stringify(workspace.getSnapshot())
          ),
          checkouts: workspace
            .getSnapshot()
            .boards.map((board) => board.repo.worktree ?? board.repo.directory),
        };
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Phase 6 qualification setup and cleanup both failed"
      );
    }
    throw error;
  }
}
