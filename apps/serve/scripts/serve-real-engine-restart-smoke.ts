import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  boardTaskCommandResponseSchema,
  queueBoardPromptResponseSchema,
  workspaceSnapshotSchema,
} from "@chorus/contracts";
import { OpenCodeAdapter } from "@chorus/oc-adapter";
import { sdkVersion } from "../../../packages/opencode-adapter/src";
import { OpenCodeProcessManager } from "../src/opencode/process-manager/manager";
import {
  createOpenCodeEnvironment,
  resolveOpenCodeBinary,
} from "../src/opencode/process-manager/runtime";
import { DEFAULT_SESSION_TIMEOUT_MS } from "../src/tasks/session-watchdog";

const ROOT_PREFIX = "chorus-real-engine-recovery-";
const TOKEN = "serve-real-engine-recovery-fixture-token";
const PROVIDER_ID = "chorus-restart-fixture";
const MODEL_ID = "restart-model";
const PROMPT_MARKER = "chorus-real-engine-restart-marker";
const THINKING_BEFORE = "reasoning-before-serve-restart";
const THINKING_AFTER = "reasoning-after-serve-restart";
const RESPONSE_MARKER = "answer-after-serve-restart";
const NEWLINE_PATTERN = /\r?\n/;
const encoder = new TextEncoder();

interface ProcessCapture {
  child: ReturnType<typeof Bun.spawn>;
  logs: string[];
  readers: Promise<void>[];
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface ProviderRequest {
  model: string;
  prompt: string;
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userPrompt(payload: unknown): string | undefined {
  if (!(isRecord(payload) && Array.isArray(payload.messages))) {
    return undefined;
  }
  for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = payload.messages[index];
    if (
      isRecord(message) &&
      message.role === "user" &&
      typeof message.content === "string"
    ) {
      return message.content;
    }
  }
  return undefined;
}

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null,
  responseId: string
): Record<string, unknown> {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function dataFrame(value: Record<string, unknown> | string): Uint8Array {
  const data = typeof value === "string" ? value : JSON.stringify(value);
  return encoder.encode(`data: ${data}\n\n`);
}

function startStagedProvider() {
  let releaseResponse = deferred();
  const requests: ProviderRequest[] = [];
  let responseError: string | undefined;
  let responseFinished = false;
  let cancelled = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    idleTimeout: 120,
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [
            {
              id: MODEL_ID,
              object: "model",
              created: 1_700_000_000,
              owned_by: "chorus-restart-fixture",
            },
          ],
        });
      }

      if (
        request.method !== "POST" ||
        url.pathname !== "/v1/chat/completions"
      ) {
        return Response.json(
          { error: "fixture route not found" },
          { status: 404 }
        );
      }

      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json(
          { error: "request body must be JSON" },
          { status: 400 }
        );
      }
      const prompt = userPrompt(payload);
      if (
        !isRecord(payload) ||
        typeof payload.model !== "string" ||
        payload.model !== MODEL_ID ||
        !prompt?.includes(PROMPT_MARKER)
      ) {
        return Response.json(
          { error: "unexpected model or task prompt" },
          { status: 422 }
        );
      }
      requests.push({ model: payload.model, prompt });
      const responseId = `chatcmpl-chorus-restart-fixture-${String(requests.length)}`;
      const responseGate = releaseResponse;
      let responseCancelled = false;

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              dataFrame(chunk({ role: "assistant" }, null, responseId))
            );
            controller.enqueue(
              dataFrame(
                chunk({ reasoning_content: THINKING_BEFORE }, null, responseId)
              )
            );
            return responseGate.promise.then(() => {
              if (responseCancelled) {
                return;
              }
              try {
                controller.enqueue(
                  dataFrame(
                    chunk(
                      { reasoning_content: ` ${THINKING_AFTER}` },
                      null,
                      responseId
                    )
                  )
                );
                controller.enqueue(
                  dataFrame(
                    chunk({ content: RESPONSE_MARKER }, null, responseId)
                  )
                );
                controller.enqueue(dataFrame(chunk({}, "stop", responseId)));
                controller.enqueue(dataFrame("[DONE]"));
                controller.close();
                responseFinished = true;
              } catch (error) {
                responseError =
                  error instanceof Error ? error.message : String(error);
                controller.error(error);
              } finally {
                responseFinished = true;
              }
            });
          },
          cancel() {
            responseCancelled = true;
            cancelled = true;
            responseFinished = true;
            responseGate.resolve();
          },
        }),
        {
          headers: {
            "cache-control": "no-cache",
            connection: "keep-alive",
            "content-type": "text/event-stream; charset=utf-8",
          },
        }
      );
    },
  });

  return {
    cancelled: () => cancelled,
    stageNext: () => {
      releaseResponse = deferred();
      responseFinished = false;
      cancelled = false;
      responseError = undefined;
    },
    port: server.port,
    release: () => releaseResponse.resolve(),
    responseFinished: () => responseFinished,
    requests,
    responseError: () => responseError,
    stop: () => {
      releaseResponse.resolve();
      return server.stop(true);
    },
  };
}

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
  environment.HOME = join(root, "home");
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
  environment.OPENCODE_PER_WORKTREE = "false";
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
        output.push(
          ...new TextDecoder()
            .decode(value)
            .split(NEWLINE_PATTERN)
            .filter(Boolean)
        );
        if (output.length > 100) {
          output.splice(0, output.length - 100);
        }
      }
    } catch {
      // Shutdown closes child pipes after the final output has been captured.
    }
  })();
}

function startServe(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv
): ProcessCapture {
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

async function stopServe(processCapture: ProcessCapture): Promise<void> {
  try {
    processCapture.child.kill("SIGTERM");
  } catch {
    // The exit status below decides if the child had already stopped.
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    processCapture.child.exited.then((exitCode) => ({ exitCode })),
    new Promise<null>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(null), 12_000);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (stopped === null) {
    processCapture.child.kill("SIGKILL");
    await processCapture.child.exited;
    await Promise.allSettled(processCapture.readers);
    throw new Error(
      `Chorus did not stop within the shutdown deadline: ${processCapture.logs.slice(-12).join("\n")}`
    );
  }
  await Promise.allSettled(processCapture.readers);
  if (stopped.exitCode !== 0) {
    throw new Error(
      `Chorus exited with status ${String(stopped.exitCode)}: ${processCapture.logs.slice(-12).join("\n")}`
    );
  }
}

async function waitForServer(
  baseUrl: string,
  processCapture: ProcessCapture
): Promise<void> {
  await waitFor(
    "Chorus health endpoint",
    async () => {
      if (processCapture.child.exitCode !== null) {
        throw new Error(
          `Chorus exited during startup (${String(processCapture.child.exitCode)}): ${processCapture.logs.slice(-12).join("\n")}`
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
    () => ({
      exitCode: processCapture.child.exitCode,
      logs: processCapture.logs.slice(-12),
    })
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
    const parsed: unknown = JSON.parse(text);
    return parsed;
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

function providerRequestCount(
  stagedProvider: ReturnType<typeof startStagedProvider> | undefined
): number {
  return stagedProvider?.requests.length ?? 0;
}

const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
const repository = join(root, "repository");
const dataDirectory = join(root, "chorus-data");
const xdg = {
  cache: join(root, "cache"),
  config: join(root, "config"),
  data: join(root, "data-home"),
  home: join(root, "home"),
  state: join(root, "state"),
};
const originalEnvironment = { ...process.env };
const processes: ProcessCapture[] = [];
let provider: ReturnType<typeof startStagedProvider> | undefined;
let engine: OpenCodeProcessManager | undefined;
let engineEventProbe: { stop: () => void } | undefined;
const observedEngineEvents: string[] = [];
const observedEngineStatuses: string[] = [];
let failure: unknown;
let hasFailure = false;

try {
  mkdirSync(repository, { recursive: true });
  for (const directory of [
    dataDirectory,
    xdg.cache,
    xdg.config,
    xdg.data,
    xdg.home,
    xdg.state,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  const environment: NodeJS.ProcessEnv = {
    ...(originalEnvironment.PATH ? { PATH: originalEnvironment.PATH } : {}),
    ...(originalEnvironment.TMPDIR
      ? { TMPDIR: originalEnvironment.TMPDIR }
      : {}),
    HOME: xdg.home,
    XDG_CACHE_HOME: xdg.cache,
    XDG_CONFIG_HOME: xdg.config,
    XDG_DATA_HOME: xdg.data,
    XDG_STATE_HOME: xdg.state,
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  };
  process.env = environment;

  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.name", "Chorus restart fixture"], {
    cwd: repository,
  });
  writeFileSync(
    join(repository, "README.md"),
    "# Real engine recovery fixture\n"
  );
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: repository,
  });

  provider = startStagedProvider();
  const configDirectory = join(xdg.config, "opencode");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    join(configDirectory, "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: {
          [PROVIDER_ID]: {
            name: "Chorus real-engine restart fixture",
            npm: "@ai-sdk/openai-compatible",
            options: {
              apiKey: "chorus-restart-fixture-key",
              baseURL: `http://127.0.0.1:${String(provider.port)}/v1`,
            },
            models: {
              [MODEL_ID]: {
                name: "Chorus restart fixture model",
                tool_call: false,
                limit: { context: 4096, output: 256 },
              },
            },
          },
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const enginePort = await allocateLoopbackPort();
  const engineUrl = `http://127.0.0.1:${String(enginePort)}`;
  const databasePath = join(xdg.data, "opencode", "opencode.db");
  engine = new OpenCodeProcessManager({
    adoptExisting: false,
    baseUrl: engineUrl,
    databasePath,
    directory: repository,
    expectedVersion: sdkVersion(),
    hostname: "127.0.0.1",
    port: enginePort,
    readinessTimeoutMs: 45_000,
  });
  await engine.start();
  const adapter = OpenCodeAdapter.from({
    baseUrl: engineUrl,
    directory: repository,
  });
  await engine.assertReady(sdkVersion());

  const port = await allocateLoopbackPort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const serveEnvironment = createServeEnvironment(
    root,
    repository,
    dataDirectory,
    port,
    engineUrl
  );
  const repositoryRoot = resolve(import.meta.dir, "../../..");
  const first = startServe(repositoryRoot, serveEnvironment);
  processes.push(first);
  await waitForServer(baseUrl, first);
  const cookie = await authenticatedCookie(baseUrl);

  const afterModel = workspaceSnapshotSchema.parse(
    await request(baseUrl, cookie, "/workspace/mutations", {
      baseRevision: null,
      clientId: "real-engine-restart-smoke",
      mutationId: "select-fixture-model",
      payload: { model: { modelID: MODEL_ID, providerID: PROVIDER_ID } },
      type: "preference.default_model.set",
    })
  );
  const afterBoard = workspaceSnapshotSchema.parse(
    await request(baseUrl, cookie, "/workspace/mutations", {
      baseRevision: afterModel.revision,
      clientId: "real-engine-restart-smoke",
      mutationId: "create-recovery-board",
      payload: {
        seed: {
          repo: {
            directory: repository,
            sandboxes: [],
            worktree: repository,
          },
          title: "Real OpenCode recovery",
        },
      },
      type: "board.create",
    })
  );
  const board = afterBoard.boards.at(-1);
  if (!board) {
    throw new Error("Chorus did not create the real-engine recovery board.");
  }

  const queued = queueBoardPromptResponseSchema.parse(
    await request(baseUrl, cookie, "/tasks", {
      boardId: board.boardId,
      directory: repository,
      model: { modelID: "untrusted-model", providerID: "untrusted-provider" },
      reviewMode: "auto",
      text: `Continue this request after a Serve restart. Marker: ${PROMPT_MARKER}`,
    })
  );
  await waitFor(
    "provider request and initial thinking projection",
    async () => {
      const snapshot = workspaceSnapshotSchema.parse(
        await request(baseUrl, cookie, "/workspace")
      );
      const { task } = taskFor(snapshot, board.boardId, queued.taskId);
      const thinking = task?.run?.steps
        .filter((step) => step.kind === "thinking")
        .flatMap((step) => (step.content ? [step.content] : []))
        .join("");
      return (
        provider?.requests.length === 1 &&
        Boolean(thinking?.includes(THINKING_BEFORE))
      );
    },
    async () => ({
      providerRequests: provider?.requests,
      task: taskFor(
        workspaceSnapshotSchema.parse(
          await request(baseUrl, cookie, "/workspace")
        ),
        board.boardId,
        queued.taskId
      ),
      serveLogs: first.logs.slice(-20),
    })
  );
  if (provider?.cancelled()) {
    throw new Error(
      "OpenCode cancelled the provider stream before the restart."
    );
  }

  await stopServe(first);
  processes.splice(processes.indexOf(first), 1);
  await engine.assertReady(sdkVersion());
  provider?.release();
  await waitFor(
    "provider stream completion while Serve is down",
    async () =>
      Boolean(
        provider?.responseFinished() && provider.responseError() === undefined
      ),
    async () => ({
      cancelled: provider?.cancelled(),
      error: provider?.responseError(),
      requests: provider?.requests,
    })
  );
  await waitFor(
    "real OpenCode session to finish while Serve is down",
    async () => {
      const statuses = await adapter.sessions.status(repository);
      return (
        !statuses[queued.sessionId] ||
        statuses[queued.sessionId]?.type === "idle"
      );
    },
    async () => ({
      engineVersion: engine?.observedVersion,
      providerError: provider?.responseError(),
      statuses: await adapter.sessions.status(repository),
    })
  );

  const second = startServe(repositoryRoot, serveEnvironment);
  processes.push(second);
  await waitForServer(baseUrl, second);
  await waitFor(
    "recovered task transcript and successful outcome",
    async () => {
      const snapshot = workspaceSnapshotSchema.parse(
        await request(baseUrl, cookie, "/workspace")
      );
      const { board: restoredBoard, task } = taskFor(
        snapshot,
        board.boardId,
        queued.taskId
      );
      const thinking = task?.run?.steps
        .filter((step) => step.kind === "thinking")
        .flatMap((step) => (step.content ? [step.content] : []))
        .join("");
      const response = task?.run?.steps
        .filter((step) => step.kind === "response")
        .flatMap((step) => (step.content ? [step.content] : []))
        .join("");
      return Boolean(
        restoredBoard?.columns.done.some(
          (candidate) => candidate.id === queued.taskId
        ) &&
          task?.outcome === "succeeded" &&
          thinking?.includes(THINKING_BEFORE) &&
          thinking.includes(THINKING_AFTER) &&
          response?.includes(RESPONSE_MARKER)
      );
    },
    async () => ({
      bridge: await request(baseUrl, cookie, "/bridge/status"),
      provider: {
        cancelled: provider?.cancelled(),
        error: provider?.responseError(),
        requests: provider?.requests,
      },
      serveLogs: second.logs.slice(-30),
      task: taskFor(
        workspaceSnapshotSchema.parse(
          await request(baseUrl, cookie, "/workspace")
        ),
        board.boardId,
        queued.taskId
      ),
    })
  );
  await engine.assertReady(sdkVersion());
  if (
    provider?.requests.length !== 1 ||
    provider.requests[0]?.model !== MODEL_ID ||
    !provider.requests[0]?.prompt.includes(PROMPT_MARKER) ||
    provider.cancelled()
  ) {
    throw new Error(
      "The provider fixture observed an unexpected request or cancellation."
    );
  }

  process.stdout.write(
    `PASS: a real OpenCode ${sdkVersion()} process completed a provider stream while Chorus was stopped; the restarted Serve recovered pre-restart and post-restart reasoning, the answer, and the successful task outcome from history.\n`
  );

  const restartedAdapter = OpenCodeAdapter.from({
    baseUrl: engineUrl,
    directory: realpathSync(repository),
  });
  engineEventProbe = await restartedAdapter.events.subscribe(
    (event) => {
      observedEngineEvents.push(`${event.type}:${event.id}`);
      if (observedEngineEvents.length > 100) {
        observedEngineEvents.splice(0, observedEngineEvents.length - 100);
      }
    },
    {
      directory: realpathSync(repository),
      onStatus: (status) => observedEngineStatuses.push(status),
    }
  );

  await engine.stop();
  let supervisedEnginePid: number | undefined;
  engine = new OpenCodeProcessManager({
    adoptExisting: false,
    baseUrl: engineUrl,
    databasePath,
    directory: repository,
    expectedVersion: sdkVersion(),
    hostname: "127.0.0.1",
    maxRestarts: 2,
    port: enginePort,
    readinessTimeoutMs: 45_000,
    spawnEngine: (port, hostname) => {
      const child = Bun.spawn(
        [
          resolveOpenCodeBinary(),
          "serve",
          "--port",
          String(port),
          "--hostname",
          hostname,
        ],
        {
          cwd: repository,
          detached: true,
          env: createOpenCodeEnvironment(databasePath),
          stderr: "pipe",
          stdout: "pipe",
          windowsHide: true,
        }
      );
      supervisedEnginePid = child.pid;
      return child;
    },
  });
  await engine.start();
  await waitFor(
    "Serve event stream reconnection after engine replacement",
    async () => {
      const status = await request(baseUrl, cookie, "/bridge/status");
      return (
        typeof status === "object" &&
        status !== null &&
        "connected" in status &&
        status.connected === true
      );
    },
    async () => ({
      bridge: await request(baseUrl, cookie, "/bridge/status"),
      engineReady: engine?.ready,
      serveLogs: second.logs.slice(-30),
    })
  );
  provider?.stageNext();
  const interrupted = queueBoardPromptResponseSchema.parse(
    await request(baseUrl, cookie, "/tasks", {
      boardId: board.boardId,
      directory: repository,
      reviewMode: "auto",
      text: `Verify recovery after an OpenCode process crash. Marker: ${PROMPT_MARKER}`,
    })
  );
  await waitFor(
    "second provider request to start before the process crash",
    async () => providerRequestCount(provider) === 2,
    async () => ({
      observedEngineEvents,
      observedEngineStatuses,
      engineStatuses: await restartedAdapter.sessions.status(
        realpathSync(repository)
      ),
      providerRequests: provider?.requests,
      sessionHistory: await restartedAdapter.sessions.messages(
        interrupted.sessionId,
        {
          directory: realpathSync(repository),
          limit: 200,
        }
      ),
      serveLogs: second.logs.slice(-20),
      task: taskFor(
        workspaceSnapshotSchema.parse(
          await request(baseUrl, cookie, "/workspace")
        ),
        board.boardId,
        interrupted.taskId
      ),
    })
  );
  if (supervisedEnginePid === undefined) {
    throw new Error("The supervised real OpenCode process has no PID.");
  }
  const crashedPid = supervisedEnginePid;
  process.kill(crashedPid, "SIGKILL");
  await waitFor(
    "supervised real OpenCode process replacement",
    async () =>
      engine?.ready === true &&
      supervisedEnginePid !== undefined &&
      supervisedEnginePid !== crashedPid,
    async () => ({
      engineReady: engine?.ready,
      engineVersion: engine?.observedVersion,
      crashedPid,
      replacementPid: supervisedEnginePid,
    })
  );
  await waitFor(
    "provider cancellation after the OpenCode crash",
    async () => provider?.cancelled() === true,
    async () => ({
      providerError: provider?.responseError(),
      providerFinished: provider?.responseFinished(),
      providerRequests: provider?.requests,
    })
  );
  await waitFor(
    "interrupted task to reach an explicit failed or timed-out outcome",
    async () => {
      const snapshot = workspaceSnapshotSchema.parse(
        await request(baseUrl, cookie, "/workspace")
      );
      const { task } = taskFor(snapshot, board.boardId, interrupted.taskId);
      return task?.outcome === "failed" || task?.outcome === "timed_out";
    },
    async () => ({
      bridge: await request(baseUrl, cookie, "/bridge/status"),
      providerCancelled: provider?.cancelled(),
      serveLogs: second.logs.slice(-30),
      task: taskFor(
        workspaceSnapshotSchema.parse(
          await request(baseUrl, cookie, "/workspace")
        ),
        board.boardId,
        interrupted.taskId
      ),
    }),
    DEFAULT_SESSION_TIMEOUT_MS + 30_000
  );
  const failedSnapshot = workspaceSnapshotSchema.parse(
    await request(baseUrl, cookie, "/workspace")
  );
  const { task: failedTask } = taskFor(
    failedSnapshot,
    board.boardId,
    interrupted.taskId
  );
  if (
    !failedTask?.errorMessage?.trim() ||
    (failedTask.outcome !== "failed" && failedTask.outcome !== "timed_out")
  ) {
    throw new Error(
      "The interrupted OpenCode task did not retain a visible failure message."
    );
  }

  provider?.stageNext();
  const retry = boardTaskCommandResponseSchema.parse(
    await request(
      baseUrl,
      cookie,
      `/boards/${encodeURIComponent(board.boardId)}/tasks/${encodeURIComponent(interrupted.taskId)}/retry`,
      {}
    )
  );
  if (retry.retryOf !== interrupted.taskId) {
    throw new Error("Retry did not link back to the interrupted task.");
  }
  await waitFor(
    "retry provider request after the engine crash",
    async () => provider?.requests.length === 3,
    async () => ({
      providerRequests: provider?.requests,
      task: taskFor(
        workspaceSnapshotSchema.parse(
          await request(baseUrl, cookie, "/workspace")
        ),
        board.boardId,
        retry.taskId
      ),
    })
  );
  provider?.release();
  await waitFor(
    "retried task to complete successfully",
    async () => {
      const snapshot = workspaceSnapshotSchema.parse(
        await request(baseUrl, cookie, "/workspace")
      );
      const { board: restoredBoard, task } = taskFor(
        snapshot,
        board.boardId,
        retry.taskId
      );
      return Boolean(
        restoredBoard?.columns.done.some(
          (candidate) => candidate.id === retry.taskId
        ) &&
          task?.outcome === "succeeded" &&
          task.retryOf === interrupted.taskId
      );
    },
    async () => ({
      bridge: await request(baseUrl, cookie, "/bridge/status"),
      providerError: provider?.responseError(),
      task: taskFor(
        workspaceSnapshotSchema.parse(
          await request(baseUrl, cookie, "/workspace")
        ),
        board.boardId,
        retry.taskId
      ),
    })
  );
  await engine.assertReady(sdkVersion());
  if (
    providerRequestCount(provider) !== 3 ||
    provider.requests.some((entry) => entry.model !== MODEL_ID) ||
    !provider.requests[2]?.prompt.includes(PROMPT_MARKER)
  ) {
    throw new Error(
      "The crash recovery retry did not use the configured shared model and prompt."
    );
  }
  process.stdout.write(
    `PASS: a real OpenCode ${sdkVersion()} process crash produced a visible retryable task failure, the supervisor restored the engine, and a linked retry completed successfully.\n`
  );
} catch (error) {
  hasFailure = true;
  failure = error;
}

provider?.release();
const stopResults = await Promise.allSettled([
  ...processes.map((processCapture) => stopServe(processCapture)),
  ...(engine ? [engine.stop()] : []),
  ...(engineEventProbe ? [Promise.resolve(engineEventProbe.stop())] : []),
  ...(provider ? [provider.stop()] : []),
]);
process.env = originalEnvironment;
let filesystemCleanupFailure: unknown;
try {
  if (basename(root).startsWith(ROOT_PREFIX)) {
    rmSync(root, { force: true, recursive: true });
  }
} catch (error) {
  filesystemCleanupFailure = error;
}
const cleanupFailures = stopResults.flatMap((result) =>
  result.status === "rejected" ? [result.reason] : []
);
if (filesystemCleanupFailure !== undefined) {
  cleanupFailures.push(filesystemCleanupFailure);
}
if (hasFailure && cleanupFailures.length > 0) {
  throw new AggregateError(
    [failure, ...cleanupFailures],
    "Real-engine Serve restart smoke failed and cleanup was incomplete."
  );
}
if (hasFailure) {
  throw failure;
}
if (cleanupFailures.length > 0) {
  throw new AggregateError(
    cleanupFailures,
    "Real-engine Serve restart smoke passed but cleanup was incomplete."
  );
}

process.exit(0);
