import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import {
  applyEventToBoard,
  LOCAL_ENTRY_PORT,
  queueBoardPromptResponseSchema,
  serverMessageSchema,
  sessionFileDiffsSchema,
  type WorkspaceBoard,
  webSocketTicketResponseSchema,
  workspaceSnapshotSchema,
} from "@chorus/contracts";
import { OpenCodeAdapter } from "@chorus/oc-adapter";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { authGuardHandler } from "../src/auth/guard";
import { createLocalEntry } from "../src/auth/local-entry";
import { DevicePairingTokenStore } from "../src/auth/pairing";
import { createAuthRoutes } from "../src/auth/routes";
import { SessionRegistry } from "../src/auth/session-registry";
import { OpenCodeBridge } from "../src/bridge/opencode/bridge";
import { RepositoryRegistry } from "../src/projects/repository-registry";
import { ProjectService } from "../src/projects/service";
import { WorktreeManager } from "../src/projects/worktree-manager";
import { createHttpRoutes } from "../src/routes";
import { createProjectRoutes } from "../src/routes/projects";
import { createWorkspaceRoutes } from "../src/routes/workspace";
import { BoardTaskService } from "../src/tasks/board-task-service";
import { boardDirectory } from "../src/tasks/session-directory";
import { WorkspaceStore } from "../src/workspace/store";
import { createWsHandler } from "../src/ws/handler";
import { WorkspaceHub } from "../src/ws/hub";
import { startScriptedEngine } from "./fixtures/opencode-engine";

const SNAPSHOT_HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BROWSER_FIXTURE_WEB_ORIGIN =
  process.env.CHORUS_BROWSER_FIXTURE_ORIGIN ?? "http://localhost:3001";
const BROWSER_FIXTURE_ORIGINS = [
  BROWSER_FIXTURE_WEB_ORIGIN,
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];

interface QualificationRun {
  boardId: string;
  sessionId: string;
  taskId: string;
}

type QualificationRequest = (path: string, body?: unknown) => Promise<unknown>;

interface QualificationMirror {
  boards: WorkspaceBoard[];
  error?: string;
  initialized: boolean;
  ready: boolean;
  recentEventRanges: Array<{ fromSeq: number; seq: number }>;
  resyncing: boolean;
  seq: number;
  socket: WebSocket;
}

type QualificationEventFrame = Extract<
  ReturnType<typeof serverMessageSchema.parse>,
  { type: "event" }
>;

function applyQualificationEvent(
  mirror: QualificationMirror,
  frame: QualificationEventFrame,
  onEvent: (frame: QualificationEventFrame) => void
): void {
  onEvent(frame);
  if (mirror.resyncing || frame.seq <= mirror.seq) {
    return;
  }
  if (frame.fromSeq !== mirror.seq + 1) {
    mirror.resyncing = true;
    mirror.socket.send(JSON.stringify({ type: "resync" }));
    return;
  }

  mirror.boards = mirror.boards.map((board) =>
    frame.boardId === null || board.boardId === frame.boardId
      ? applyEventToBoard(board, frame.event)
      : board
  );
  mirror.seq = frame.seq;
}

function receiveQualificationFrame(
  mirror: QualificationMirror,
  data: unknown,
  onEvent: (frame: QualificationEventFrame) => void
): void {
  const raw = String(data);
  try {
    const frame = serverMessageSchema.parse(JSON.parse(raw));
    switch (frame.type) {
      case "snapshot":
        mirror.boards = frame.data.boards;
        mirror.seq = frame.seq;
        mirror.initialized = true;
        mirror.resyncing = false;
        return;
      case "ready":
        mirror.ready = true;
        return;
      case "event":
        applyQualificationEvent(mirror, frame, onEvent);
        return;
      case "ping":
        mirror.socket.send(JSON.stringify({ type: "pong" }));
        return;
      case "error":
        mirror.error = JSON.stringify(frame);
        return;
      default:
        return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mirror.error = `${message}; frame=${raw.slice(0, 200)}`;
  }
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

interface TransportFaultProxy {
  baseUrl: string;
  breakConnections(): void;
  close(): Promise<void>;
}

function disconnectQualificationMirror(
  socket: WebSocket,
  proxy: TransportFaultProxy | undefined
): void {
  if (proxy) {
    proxy.breakConnections();
    return;
  }
  socket.close(1000, "qualification network flap");
}

function validateTcpFaultProxyCount(count: number): void {
  if (!Number.isInteger(count) || count < 0 || count > 10) {
    throw new Error("tcpFaultProxyMirrors must be an integer from 0 to 10.");
  }
}

function validateTcpFaultProxyLatency(latencyMs: number): void {
  if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 2000) {
    throw new Error(
      "tcpFaultProxyLatencyMs must be an integer from 0 to 2000."
    );
  }
}

function qualificationWebSocketUrl(
  base: string,
  ticket: string,
  proxy: TransportFaultProxy | undefined
): string {
  const socketBase = proxy?.baseUrl ?? base.replace("http:", "ws:");
  return `${socketBase}/ws?ticket=${encodeURIComponent(ticket)}`;
}

async function startTransportFaultProxies(
  count: number,
  destinationPort: number,
  latencyMs: number
): Promise<Map<number, TransportFaultProxy>> {
  const proxies = new Map<number, TransportFaultProxy>();
  try {
    for (let index = 0; index < count; index += 1) {
      proxies.set(
        index,
        await startTransportFaultProxy(destinationPort, latencyMs)
      );
    }
    return proxies;
  } catch (error) {
    await Promise.allSettled(
      [...proxies.values()].map((proxy) => proxy.close())
    );
    throw error;
  }
}

async function startTransportFaultProxy(
  destinationPort: number,
  latencyMs: number
): Promise<TransportFaultProxy> {
  const connections = new Set<{ client: Socket; upstream: Socket }>();
  const server: Server = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port: destinationPort });
    const clientToServer = createTransportDelayStream(latencyMs);
    const serverToClient = createTransportDelayStream(latencyMs);
    const connection = { client, upstream };
    connections.add(connection);
    let closed = false;
    const closePeer = (socket: Socket) => {
      if (closed) {
        return;
      }
      closed = true;
      connections.delete(connection);
      clientToServer.destroy();
      serverToClient.destroy();
      (socket === client ? upstream : client).destroy();
    };

    client.on("close", () => closePeer(client));
    client.on("error", () => closePeer(client));
    upstream.on("close", () => closePeer(upstream));
    upstream.on("error", () => closePeer(upstream));
    client.pipe(clientToServer).pipe(upstream);
    upstream.pipe(serverToClient).pipe(client);
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.removeAllListeners("error");
      resolveListen();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose()))
    );
    throw new Error("Could not start the qualification transport proxy.");
  }

  const breakConnections = () => {
    for (const connection of connections) {
      connections.delete(connection);
      connection.client.destroy();
      connection.upstream.destroy();
    }
  };

  return {
    baseUrl: `ws://127.0.0.1:${address.port}`,
    breakConnections,
    async close() {
      breakConnections();
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose()))
      );
    },
  };
}

function createTransportDelayStream(latencyMs: number): Transform {
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (latencyMs === 0) {
        callback(null, chunk);
        return;
      }
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        callback(null, chunk);
      }, latencyMs);
      pendingTimers.add(timer);
    },
    destroy(error, callback) {
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      callback(error);
    },
  });
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

function queueQualificationRuns(
  interactive: boolean,
  boardIds: string[],
  getBoard: (boardId: string) => WorkspaceBoard | undefined,
  request: QualificationRequest
): Promise<QualificationRun[]> {
  if (interactive) {
    return Promise.resolve([]);
  }
  return Promise.all(
    boardIds.map(async (boardId) => {
      const board = getBoard(boardId);
      const response = queueBoardPromptResponseSchema.parse(
        await request("/tasks", {
          boardId,
          directory: board?.repo.worktree ?? board?.repo.directory,
          text: "Scripted isolated change",
          reviewMode: "auto",
        })
      );
      return {
        boardId,
        sessionId: response.sessionId,
        taskId: response.taskId,
      };
    })
  );
}

function startOptionalLocalEntry(options: {
  token: string;
  registry: SessionRegistry;
  webPort: number | undefined;
}): (() => Promise<void>) | undefined {
  if (options.webPort === undefined) {
    return undefined;
  }
  const server = createLocalEntry({
    token: options.token,
    registry: options.registry,
    webPort: options.webPort,
  })
    .onAfterHandle(({ request, set }) => {
      traceFixtureAuth(request, set.status);
    })
    .listen({ hostname: "127.0.0.1", port: LOCAL_ENTRY_PORT });
  return async () => {
    await server.stop(true);
  };
}

function traceFixtureAuth(
  request: Request,
  status: number | string | undefined
) {
  if (process.env.CHORUS_BROWSER_FIXTURE_TRACE_AUTH !== "1") {
    return;
  }
  const pathname = new URL(request.url).pathname;
  if (
    ["/auth/device", "/auth/local-session", "/projects", "/workspace"].includes(
      pathname
    )
  ) {
    process.stdout.write(
      `${JSON.stringify({ method: request.method, pathname, status: status ?? 200 })}\n`
    );
  }
}

function createQualificationRoot(rootDirectory?: string) {
  if (rootDirectory === undefined) {
    return {
      ownsRoot: true,
      root: mkdtempSync(join(tmpdir(), "chorus-qualification-")),
    };
  }

  const root = resolve(rootDirectory);
  const insideTemp = relative(resolve(tmpdir()), root);
  if (
    insideTemp.startsWith("..") ||
    !insideTemp.startsWith("chorus-qualification-")
  ) {
    throw new Error(
      "persistent qualification data must use a chorus-qualification-* directory inside the system temp directory"
    );
  }
  mkdirSync(root, { recursive: true });
  return { ownsRoot: false, root };
}

function removeOwnedQualificationRoot(root: string, ownsRoot: boolean) {
  if (!ownsRoot) {
    return;
  }
  const insideTemp = relative(resolve(tmpdir()), resolve(root));
  if (
    insideTemp.startsWith("..") ||
    !insideTemp.startsWith("chorus-qualification-")
  ) {
    throw new Error("refusing to remove an unexpected qualification directory");
  }
  rmSync(root, { recursive: true, force: true });
}

async function loadOrSeedQualificationBoards(
  request: QualificationRequest,
  workspace: WorkspaceStore,
  repositories: readonly string[]
): Promise<string[]> {
  const existingBoardIds = workspace
    .getSnapshot()
    .boards.map((board) => board.boardId);
  if (existingBoardIds.length > 0) {
    return existingBoardIds;
  }

  // Task dispatch now requires the same installation-wide model selection
  // used by the UI. Seed a deterministic fixture model in this disposable
  // workspace so the lifecycle test exercises accepted runs and streaming.
  await request("/workspace/mutations", {
    baseRevision: null,
    clientId: "qualification",
    mutationId: "select-scripted-model",
    type: "preference.default_model.set",
    payload: { model: { modelID: "scripted", providerID: "fixture" } },
  });

  const boardIds: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const directory = repositories[index % 3];
    if (!directory) {
      throw new Error("qualification repository is missing");
    }
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
  return boardIds;
}

/** Real repositories, SDK, HTTP commands, SQLite writer and authenticated WS mirrors. */
export async function startPhase6Harness({
  interactive = false,
  localEntryWebPort,
  questionReplyDelayMs,
  rootDirectory,
  servePort = 0,
  tcpFaultProxyMirrors = 0,
  tcpFaultProxyLatencyMs = 0,
}: {
  interactive?: boolean;
  localEntryWebPort?: number;
  questionReplyDelayMs?: number;
  /** Keep fixture data at this disposable path so a second process can reopen it. */
  rootDirectory?: string;
  servePort?: number;
  tcpFaultProxyMirrors?: number;
  tcpFaultProxyLatencyMs?: number;
} = {}) {
  validateTcpFaultProxyCount(tcpFaultProxyMirrors);
  validateTcpFaultProxyLatency(tcpFaultProxyLatencyMs);
  const { root, ownsRoot } = createQualificationRoot(rootDirectory);
  const repositories: string[] = [];
  let store: WorkspaceStore | undefined;
  let hub: WorkspaceHub | undefined;
  let bridge: OpenCodeBridge | undefined;
  let stopLocalEntry: (() => Promise<void>) | undefined;
  let stopHttp: (() => Promise<void>) | undefined;
  let stopEngine: (() => Promise<void>) | undefined;
  const mirrors: QualificationMirror[] = [];
  let transportFaultProxies = new Map<number, TransportFaultProxy>();
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
    await stopLocalEntry?.();
    stopLocalEntry = undefined;
    for (const mirror of mirrors) {
      mirror.socket.close();
    }
    await Promise.all(
      [...transportFaultProxies.values()].map((proxy) => proxy.close())
    );
    hub?.close();
    bridge?.stop();
    await stopHttp?.();
    await store?.close();
    await stopEngine?.();
    removeOwnedQualificationRoot(root, ownsRoot);
  }

  try {
    const engine = startScriptedEngine({ questionReplyDelayMs });
    stopEngine = () => engine.stop();

    for (let index = 0; index < 3; index += 1) {
      const directory = join(root, `repo-${index}`);
      if (!existsSync(directory)) {
        mkdirSync(directory);
        git(directory, ["init", "--quiet"]);
        git(directory, ["config", "user.email", "fixture@example.com"]);
        git(directory, ["config", "user.name", "Chorus fixture"]);
        writeFileSync(join(directory, "README.md"), "# Scripted fixture\n");
        git(directory, ["add", "README.md"]);
        git(directory, ["commit", "--quiet", "-m", "fixture"]);
      }
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
    engineBridge.setRecoverySessionProvider((directory) => {
      const canonicalDirectory = realpathSync(directory);
      return workspace
        .getSnapshot()
        .boards.filter((board) => {
          let boardCheckout: string;
          try {
            boardCheckout = realpathSync(boardDirectory(board));
          } catch {
            return false;
          }
          return (
            boardCheckout === canonicalDirectory &&
            board.session.currentTaskId !== undefined &&
            (board.session.state === "active" ||
              Object.values(board.columns)
                .flat()
                .some(
                  (task) =>
                    (task.pendingApprovals?.length ?? 0) > 0 ||
                    task.pendingApproval !== undefined
                ))
          );
        })
        .flatMap((board) =>
          board.session.sessionId ? [board.session.sessionId] : []
        );
    });
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
    const globalAdapter = OpenCodeAdapter.from({ baseUrl: engine.baseUrl });
    const projectService = new ProjectService(
      engine.baseUrl,
      repositories[0] ?? root,
      { pickFolder: async () => null },
      (directory) => workspace.registerPickedRepository(directory),
      undefined,
      registry,
      async (directory) =>
        OpenCodeAdapter.from({ baseUrl: engine.baseUrl, directory }),
      async (directory) => {
        await engineBridge.subscribeDirectory(directory);
      },
      globalAdapter,
      { listCredentials: async () => ({ credentials: [] }) }
    );
    const token = crypto.randomUUID();
    const ticketOptions = { store: workspace.meta, now: Date.now };
    const sessionRegistry = new SessionRegistry(workspace.meta, token);
    const app = new Elysia()
      .onAfterHandle(({ request, set }) => {
        traceFixtureAuth(request, set.status);
      })
      .use(
        cors({
          origin: BROWSER_FIXTURE_ORIGINS,
          credentials: true,
          maxAge: 86_400,
          methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
        })
      )
      .resolve(
        { as: "global" },
        authGuardHandler({ sessionRegistry, token, ticketOptions })
      )
      .use(
        createAuthRoutes({
          token,
          ticketStore: workspace.meta,
          sessionRegistry,
          isProduction: false,
          localOrigins: BROWSER_FIXTURE_ORIGINS,
          pairingTokenStore: new DevicePairingTokenStore(),
        })
      )
      .use(createWorkspaceRoutes(workspace, boardTasks))
      .use(createHttpRoutes(engineBridge, boardTasks, workspace))
      .use(createProjectRoutes(projectService))
      .use(
        createWsHandler({
          sessionRegistry,
          boardTasks,
          bridge: engineBridge,
          hub: workspaceHub,
          workspaceStore: workspace,
          token,
          ticketOptions,
        })
      )
      .listen({ hostname: "127.0.0.1", port: servePort });
    stopHttp = async () => {
      await app.stop(true);
    };
    stopLocalEntry = startOptionalLocalEntry({
      token,
      registry: sessionRegistry,
      webPort: localEntryWebPort,
    });
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
    transportFaultProxies = await startTransportFaultProxies(
      tcpFaultProxyMirrors,
      app.server?.port ?? 0,
      tcpFaultProxyLatencyMs
    );
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

    function bindMirrorSocket(
      mirror: QualificationMirror,
      socket: WebSocket
    ): void {
      socket.addEventListener("open", () =>
        socket.send(
          JSON.stringify({
            type: "hello",
            since: mirror.seq,
            workspaceId: workspace.workspaceId,
          })
        )
      );
      socket.addEventListener("message", (message) => {
        if (mirror.socket !== socket) {
          return;
        }
        receiveQualificationFrame(mirror, message.data, (frame) => {
          latencies[latencyCursor++ % 20_000] = Math.max(
            0,
            Date.now() - frame.ts
          );
          frameCount += 1;
          if (mirror.recentEventRanges.length === 64) {
            mirror.recentEventRanges.shift();
          }
          mirror.recentEventRanges.push({
            fromSeq: frame.fromSeq,
            seq: frame.seq,
          });
        });
      });
      socket.addEventListener("close", (event) => {
        if (mirror.socket === socket) {
          mirror.error ??= `socket closed (${event.code}): ${event.reason}`;
        }
      });
      socket.addEventListener("error", () => {
        if (mirror.socket === socket) {
          mirror.error ??= "socket transport error";
        }
      });
    }

    const boardIds = await loadOrSeedQualificationBoards(
      request,
      workspace,
      repositories
    );
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
      const proxy = transportFaultProxies.get(index);
      const socket = new WebSocket(
        qualificationWebSocketUrl(base, ticket, proxy)
      );
      const mirror = {
        socket,
        boards: [] as WorkspaceBoard[],
        seq: 0,
        initialized: false,
        ready: false,
        recentEventRanges: [] as Array<{ fromSeq: number; seq: number }>,
        resyncing: false,
        error: undefined as string | undefined,
      };
      mirrors.push(mirror);
      bindMirrorSocket(mirror, socket);
    }
    await waitForQualification(() =>
      mirrors.every((mirror) => mirror.initialized)
    );
    const runs = await queueQualificationRuns(
      interactive,
      boardIds,
      (boardId) => workspace.getBoard(boardId),
      request
    );
    if (!interactive) {
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
    }

    function requirePrepopulatedRuns(operation: string): void {
      if (runs.length === 0) {
        throw new Error(
          `${operation} requires prepopulated qualification runs; use the browser to dispatch interactive fixture tasks`
        );
      }
    }

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

    async function queueInteractiveTask(
      boardId: string,
      text: string,
      reviewMode: "auto" | "manual"
    ): Promise<QualificationRun> {
      if (!interactive) {
        throw new Error("queueInteractiveTask requires interactive mode");
      }
      const board = workspace.getBoard(boardId);
      const directory = board?.repo.worktree ?? board?.repo.directory;
      if (!directory) {
        throw new Error("interactive fixture board has no checkout");
      }
      const response = queueBoardPromptResponseSchema.parse(
        await request("/tasks", { boardId, directory, text, reviewMode })
      );
      return {
        boardId: response.boardId,
        sessionId: response.sessionId,
        taskId: response.taskId,
      };
    }

    return {
      close,
      async disconnectMirror(index: number) {
        const mirror = mirrors[index];
        if (!mirror) {
          throw new Error(`qualification mirror ${index} does not exist`);
        }
        const socket = mirror.socket;
        if (socket.readyState === WebSocket.OPEN) {
          disconnectQualificationMirror(
            socket,
            transportFaultProxies.get(index)
          );
        }
        await waitForQualification(
          () => socket.readyState === WebSocket.CLOSED,
          5000,
          () => ({ index, readyState: socket.readyState })
        );
      },
      engine,
      runs,
      boardIds,
      mirrors,
      store: workspace,
      root,
      serveBaseUrl: base,
      accessToken: token,
      diagnostics() {
        const recentLatencies = latencies.filter((latency) => latency > 0);
        const sortedLatencies = [...recentLatencies].sort((a, b) => a - b);
        return {
          frameCount,
          headSeq: workspace.headSeq(),
          hub: workspaceHub.stats(),
          mirrors: mirrors.map((mirror, mirrorIndex) => ({
            error: mirror.error,
            initialized: mirror.initialized,
            mirrorIndex,
            readyState: mirror.socket.readyState,
            resyncing: mirror.resyncing,
            seq: mirror.seq,
          })),
          p95LatencyMs:
            sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] ?? 0,
        };
      },
      async reconnectMirror(index: number) {
        const mirror = mirrors[index];
        if (!mirror) {
          throw new Error(`qualification mirror ${index} does not exist`);
        }
        const { ticket } = webSocketTicketResponseSchema.parse(
          await request("/auth/ws-ticket")
        );
        const proxy = transportFaultProxies.get(index);
        const socket = new WebSocket(
          qualificationWebSocketUrl(base, ticket, proxy)
        );
        mirror.socket = socket;
        mirror.ready = false;
        mirror.resyncing = false;
        mirror.error = undefined;
        mirror.recentEventRanges.length = 0;
        bindMirrorSocket(mirror, socket);
        await waitForQualification(
          () => mirror.ready,
          5000,
          () => ({
            error: mirror.error,
            index,
            readyState: socket.readyState,
            seq: mirror.seq,
          })
        );
      },
      queueInteractiveTask,
      async finalizeReview(
        boardId: string,
        taskId: string,
        plan: string,
        answers: string[] = []
      ) {
        if (!interactive) {
          throw new Error("finalizeReview requires interactive mode");
        }
        await request(
          `/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/finalize-review`,
          { plan, answers }
        );
      },
      async approvePermission(sessionId: string, requestId: string) {
        if (!interactive) {
          throw new Error("approvePermission requires interactive mode");
        }
        await request(`/tasks/${encodeURIComponent(sessionId)}/approve`, {
          requestID: requestId,
        });
      },
      replyInteractiveQuestion(
        sessionId: string,
        requestId: string,
        optionIndex = 0
      ) {
        if (!interactive) {
          throw new Error("replyInteractiveQuestion requires interactive mode");
        }
        return request(
          `/tasks/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(requestId)}/reply`,
          { answers: [{ questionIndex: 0, optionIndices: [optionIndex] }] }
        );
      },
      appendBatch(count: number) {
        requirePrepopulatedRuns("appendBatch");
        for (let index = 0; index < count; index += 1) {
          const run = runs[index % runs.length];
          if (run) {
            engine.appendDelta(run.sessionId, ".");
          }
        }
      },
      appendReasoningBatch(count: number) {
        requirePrepopulatedRuns("appendReasoningBatch");
        for (let index = 0; index < count; index += 1) {
          const run = runs[index % runs.length];
          if (run) {
            engine.appendReasoningDelta(
              run.sessionId,
              " Checking the board state."
            );
          }
        }
      },
      async complete(settleTimeoutMs = 5000) {
        requirePrepopulatedRuns("complete");
        await Promise.all(runs.map(completeRun));
        await waitForQualification(
          () =>
            runs.every(
              (run) =>
                workspace.getBoard(run.boardId)?.columns.done?.length === 1
            ),
          settleTimeoutMs,
          () =>
            runs.map((run) => {
              const board = workspace.getBoard(run.boardId);
              return {
                boardId: run.boardId,
                session: board?.session,
                taskCounts: {
                  approve: board?.columns.approve?.length ?? 0,
                  done: board?.columns.done?.length ?? 0,
                  inProgress: board?.columns.in_progress?.length ?? 0,
                  queue: board?.columns.queue?.length ?? 0,
                },
              };
            })
        );
        await waitForQualification(
          () => mirrors.every((mirror) => mirror.seq === workspace.headSeq()),
          settleTimeoutMs,
          () => ({
            expectedSeq: workspace.headSeq(),
            hub: workspaceHub.stats(),
            mirrors: mirrors.map((mirror, mirrorIndex) => ({
              error: mirror.error,
              initialized: mirror.initialized,
              mirrorIndex,
              resyncing: mirror.resyncing,
              seq: mirror.seq,
            })),
          })
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
