import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  queueBoardPromptResponseSchema,
  workspaceSnapshotSchema,
} from "@chorus/contracts";
import { startScriptedEngine } from "./fixtures/opencode-engine";

const ROOT_PREFIX = "chorus-serve-recovery-";
const TOKEN = "serve-restart-recovery-fixture-token";
const NEWLINE_PATTERN = /\r?\n/;

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
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
    throw new Error("Could not reserve a temporary Chorus port.");
  }
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose()))
  );
  return port;
}

async function waitFor(
  description: string,
  predicate: () => Promise<boolean>,
  diagnostics: () => unknown,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `${description} timed out: ${JSON.stringify(await diagnostics())}`
  );
}

function createServeEnvironment(
  root: string,
  repository: string,
  dataDirectory: string,
  port: number,
  engineUrl: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  if (process.env.PATH) {
    environment.PATH = process.env.PATH;
  }
  if (process.env.TMPDIR) {
    environment.TMPDIR = process.env.TMPDIR;
  }

  const home = join(root, "home");
  environment.HOME = home;
  environment.XDG_CACHE_HOME = join(root, "cache");
  environment.XDG_CONFIG_HOME = join(root, "config");
  environment.XDG_DATA_HOME = join(root, "data-home");
  environment.XDG_STATE_HOME = join(root, "state");
  environment.DATA_DIR = dataDirectory;
  environment.PORT = String(port);
  environment.CHORUS_BIND_ADDRESS = "127.0.0.1";
  environment.CHORUS_REPOSITORY_ROOTS = JSON.stringify([repository]);
  environment.CHORUS_TOKEN = TOKEN;
  environment.NODE_ENV = "development";
  environment.OPENCODE_BASE_URL = engineUrl;
  environment.OPENCODE_AUTO_START = "false";
  environment.OPENCODE_DIRECTORY = repository;
  return environment;
}

function readStream(
  stream: ReadableStream<Uint8Array>,
  output: string[]
): Promise<void> {
  return (async () => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        const lines = new TextDecoder().decode(value).split(NEWLINE_PATTERN);
        output.push(...lines.filter(Boolean));
        if (output.length > 100) {
          output.splice(0, output.length - 100);
        }
      }
    } catch {
      // Process shutdown closes the pipes after the final output is captured.
    }
  })();
}

function startServe(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv
): {
  child: ReturnType<typeof Bun.spawn>;
  logs: string[];
  readers: Promise<void>[];
} {
  const child = Bun.spawn([process.execPath, "apps/serve/src/index.ts"], {
    cwd: repositoryRoot,
    env: environment,
    stdin: "ignore",
    stderr: "pipe",
    stdout: "pipe",
    windowsHide: true,
  });
  const logs: string[] = [];
  const readers = [child.stdout, child.stderr].map((stream) =>
    readStream(stream, logs)
  );
  return { child, logs, readers };
}

async function stopServe(
  processHandle: ReturnType<typeof Bun.spawn>,
  logs: string[],
  readers: Promise<void>[]
): Promise<void> {
  try {
    processHandle.kill("SIGTERM");
  } catch {
    // The process may already have exited; the awaited status below decides.
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    processHandle.exited.then((exitCode) => ({ exitCode })),
    new Promise<null>(
      (resolveTimeout) =>
        (timeout = setTimeout(() => resolveTimeout(null), 12_000))
    ),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (stopped === null) {
    processHandle.kill("SIGKILL");
    await processHandle.exited;
    await Promise.allSettled(readers);
    throw new Error(
      `Chorus did not stop within the shutdown deadline: ${logs.slice(-12).join("\n")}`
    );
  }
  await Promise.allSettled(readers);
  if (stopped.exitCode !== 0) {
    throw new Error(
      `Chorus exited with status ${String(stopped.exitCode)}: ${logs.slice(-12).join("\n")}`
    );
  }
}

async function waitForServer(
  baseUrl: string,
  child: ReturnType<typeof Bun.spawn>,
  logs: string[]
): Promise<void> {
  await waitFor(
    "Chorus health endpoint",
    async () => {
      if (child.exitCode !== null) {
        throw new Error(
          `Chorus exited during startup (${String(child.exitCode)}): ${logs.slice(-12).join("\n")}`
        );
      }
      try {
        const response = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    async () => ({ exitCode: child.exitCode, logs: logs.slice(-12) })
  );
}

async function authenticatedCookie(baseUrl: string): Promise<string> {
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN }),
  });
  const sessionCookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!(login.ok && sessionCookie)) {
    throw new Error(`Disposable Chorus login failed with ${login.status}.`);
  }

  const device = await fetch(`${baseUrl}/auth/device`, {
    method: "POST",
    headers: { cookie: sessionCookie },
  });
  const deviceCookie = device.headers.get("set-cookie")?.split(";")[0];
  if (!(device.ok && deviceCookie)) {
    throw new Error(
      `Disposable device registration failed with ${device.status}.`
    );
  }
  return `${sessionCookie}; ${deviceCookie}`;
}

async function request(
  baseUrl: string,
  cookie: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Disposable Chorus ${path} returned ${response.status}: ${text.slice(0, 500)}`
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Disposable Chorus ${path} returned invalid JSON.`);
  }
}

function taskFor(
  snapshot: ReturnType<typeof workspaceSnapshotSchema.parse>,
  boardId: string,
  taskId: string
) {
  const board = snapshot.boards.find(
    (candidate) => candidate.boardId === boardId
  );
  const task = board
    ? Object.values(board.columns)
        .flat()
        .find((candidate) => candidate.id === taskId)
    : undefined;
  return { board, task };
}

const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
const repository = join(root, "repository");
const dataDirectory = join(root, "chorus-data");
const engine = startScriptedEngine();
const processes: Array<{
  child: ReturnType<typeof Bun.spawn>;
  logs: string[];
  readers: Promise<void>[];
}> = [];
let failure: unknown;
let hasFailure = false;

try {
  mkdirSync(repository, { recursive: true });
  for (const directory of [
    join(root, "home"),
    join(root, "cache"),
    join(root, "config"),
    join(root, "data-home"),
    join(root, "state"),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.name", "Chorus recovery fixture"], {
    cwd: repository,
  });
  writeFileSync(join(repository, "README.md"), "# Restart recovery fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: repository,
  });

  const port = await allocateLoopbackPort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const environment = createServeEnvironment(
    root,
    repository,
    dataDirectory,
    port,
    engine.baseUrl
  );
  const first = startServe(resolve(import.meta.dir, "../../.."), environment);
  processes.push(first);
  await waitForServer(baseUrl, first.child, first.logs);
  const cookie = await authenticatedCookie(baseUrl);

  const afterModel = workspaceSnapshotSchema.parse(
    await request(baseUrl, cookie, "/workspace/mutations", {
      baseRevision: null,
      clientId: "restart-recovery-smoke",
      mutationId: "select-fixture-model",
      payload: { model: { modelID: "scripted", providerID: "fixture" } },
      type: "preference.default_model.set",
    })
  );
  const afterBoard = workspaceSnapshotSchema.parse(
    await request(baseUrl, cookie, "/workspace/mutations", {
      baseRevision: afterModel.revision,
      clientId: "restart-recovery-smoke",
      mutationId: "create-recovery-board",
      payload: {
        seed: {
          repo: {
            directory: repository,
            sandboxes: [],
            worktree: repository,
          },
          title: "Restart recovery",
        },
      },
      type: "board.create",
    })
  );
  const board = afterBoard.boards.at(-1);
  if (!board) {
    throw new Error("Chorus did not create the recovery fixture board.");
  }

  const queued = queueBoardPromptResponseSchema.parse(
    await request(baseUrl, cookie, "/tasks", {
      boardId: board.boardId,
      directory: repository,
      reviewMode: "auto",
      text: "Keep this task alive across a Chorus restart",
    })
  );
  await waitFor(
    "initial permission request",
    async () => {
      const snapshot = workspaceSnapshotSchema.parse(
        await request(baseUrl, cookie, "/workspace")
      );
      const { board: latestBoard, task } = taskFor(
        snapshot,
        board.boardId,
        queued.taskId
      );
      return Boolean(
        latestBoard?.session.state === "active" &&
          task?.pendingApprovals?.some(
            (approval) =>
              approval.requestId === `permission-${queued.sessionId}`
          )
      );
    },
    async () => ({
      task: taskFor(
        workspaceSnapshotSchema.parse(
          await request(baseUrl, cookie, "/workspace")
        ),
        board.boardId,
        queued.taskId
      ),
      serveLogs: processes.at(-1)?.logs.slice(-30),
    })
  );

  await stopServe(first.child, first.logs, first.readers);
  const second = startServe(resolve(import.meta.dir, "../../.."), environment);
  processes.push(second);
  await waitForServer(baseUrl, second.child, second.logs);

  await waitFor(
    "reconnected busy engine session",
    async () => {
      const status = await request(baseUrl, cookie, "/bridge/status");
      return (
        typeof status === "object" &&
        status !== null &&
        "connected" in status &&
        status.connected === true &&
        "activeSessions" in status &&
        status.activeSessions === 1
      );
    },
    async () => await request(baseUrl, cookie, "/bridge/status")
  );

  const afterRestart = workspaceSnapshotSchema.parse(
    await request(baseUrl, cookie, "/workspace")
  );
  const { board: restoredBoard, task: restoredTask } = taskFor(
    afterRestart,
    board.boardId,
    queued.taskId
  );
  if (
    restoredBoard?.session.sessionId !== queued.sessionId ||
    restoredBoard.session.currentTaskId !== queued.taskId ||
    !restoredTask?.pendingApprovals?.some(
      (approval) => approval.requestId === `permission-${queued.sessionId}`
    )
  ) {
    throw new Error(
      "The active task or its pending approval changed on restart."
    );
  }

  await request(
    baseUrl,
    cookie,
    `/tasks/${encodeURIComponent(queued.sessionId)}/approve`,
    { requestID: `permission-${queued.sessionId}` }
  );
  await waitFor(
    "approved task resumption after restart",
    async () => {
      const snapshot = workspaceSnapshotSchema.parse(
        await request(baseUrl, cookie, "/workspace")
      );
      const { task } = taskFor(snapshot, board.boardId, queued.taskId);
      return Boolean(
        snapshot.boards
          .find((candidate) => candidate.boardId === board.boardId)
          ?.columns.in_progress.some(
            (candidate) => candidate.id === queued.taskId
          ) &&
          task?.run?.steps.some((step) =>
            step.content?.includes("Permission restored and work resumed.")
          ) &&
          task.pendingApprovals?.length === 0
      );
    },
    async () => ({
      task: taskFor(
        workspaceSnapshotSchema.parse(
          await request(baseUrl, cookie, "/workspace")
        ),
        board.boardId,
        queued.taskId
      ),
      bridge: await request(baseUrl, cookie, "/bridge/status"),
      serveLogs: processes.at(-1)?.logs.slice(-30),
    })
  );

  engine.appendReasoningDelta(
    queued.sessionId,
    " Recovery continued over the reconnected stream."
  );
  await waitFor(
    "stream delta after restart",
    async () => {
      const snapshot = workspaceSnapshotSchema.parse(
        await request(baseUrl, cookie, "/workspace")
      );
      const { task } = taskFor(snapshot, board.boardId, queued.taskId);
      return Boolean(
        task?.run?.steps.some((step) =>
          step.content?.includes("continued over the reconnected stream")
        )
      );
    },
    async () => ({
      bridge: await request(baseUrl, cookie, "/bridge/status"),
      task: taskFor(
        workspaceSnapshotSchema.parse(
          await request(baseUrl, cookie, "/workspace")
        ),
        board.boardId,
        queued.taskId
      ),
      serveLogs: processes.at(-1)?.logs.slice(-20),
    })
  );

  engine.complete(queued.sessionId);
  await waitFor(
    "task completion after restart",
    async () => {
      const snapshot = workspaceSnapshotSchema.parse(
        await request(baseUrl, cookie, "/workspace")
      );
      return Boolean(
        snapshot.boards
          .find((candidate) => candidate.boardId === board.boardId)
          ?.columns.done.some((candidate) => candidate.id === queued.taskId)
      );
    },
    async () =>
      taskFor(
        workspaceSnapshotSchema.parse(
          await request(baseUrl, cookie, "/workspace")
        ),
        board.boardId,
        queued.taskId
      )
  );

  process.stdout.write(
    "PASS: active task and pending approval survived a real Serve process restart; approval, resumed reasoning stream, and completion all succeeded through the same scripted OpenCode engine.\n"
  );
} catch (error) {
  hasFailure = true;
  failure = error;
}

const stopResults = await Promise.allSettled([
  ...processes.map(({ child, logs, readers }) =>
    stopServe(child, logs, readers)
  ),
  engine.stop(),
]);
if (basename(root).startsWith(ROOT_PREFIX)) {
  rmSync(root, { force: true, recursive: true });
}

const cleanupFailures = stopResults.flatMap((result) =>
  result.status === "rejected" ? [result.reason] : []
);
if (hasFailure && cleanupFailures.length > 0) {
  throw new AggregateError(
    [failure, ...cleanupFailures],
    "Serve restart recovery smoke failed and cleanup was incomplete."
  );
}
if (hasFailure) {
  throw failure;
}
if (cleanupFailures.length > 0) {
  throw new AggregateError(
    cleanupFailures,
    "Serve restart recovery smoke passed but cleanup was incomplete."
  );
}
