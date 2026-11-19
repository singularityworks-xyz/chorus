import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  queueBoardPromptResponseSchema,
  workspaceMutationSchema,
} from "@chorus/contracts";
import { Elysia } from "elysia";
import { sdkVersion } from "../../../packages/opencode-adapter/src";
import { OpenCodeBridge } from "../src/bridge/opencode/bridge";
import { EngineRegistry } from "../src/opencode/engine-registry";
import { OpenCodeProcessManager } from "../src/opencode/process-manager/manager";
import { RepositoryRegistry } from "../src/projects/repository-registry";
import { createHttpRoutes } from "../src/routes";
import { BoardTaskService } from "../src/tasks/board-task-service";
import { WorkspaceStore } from "../src/workspace/store";

const providerID = "chorus-local-fixture";
const modelID = "fixture-model";
const markers = [
  {
    board: "alpha",
    prompt: "chorus-route-smoke-alpha",
    reasoning: "route-thinking-alpha",
    reply: "route-reply-alpha",
  },
  {
    board: "beta",
    prompt: "chorus-route-smoke-beta",
    reasoning: "route-thinking-beta",
    reply: "route-reply-beta",
  },
] as const;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userPrompt(payload: unknown): string | undefined {
  if (!(isRecord(payload) && Array.isArray(payload.messages))) {
    return undefined;
  }
  const messages = payload.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
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
  delta: { content?: string; reasoning_content?: string },
  finishReason: string | null
) {
  return {
    id: "chatcmpl-chorus-route-fixture",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: modelID,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

function streamingResponse(reply: string, reasoning: string): Response {
  const frames = [
    chunk({}, null),
    chunk({ reasoning_content: reasoning }, null),
    chunk({ content: "route-reply-" }, null),
    chunk({ content: reply.slice("route-reply-".length) }, null),
    chunk({}, "stop"),
    "data: [DONE]\n\n",
  ];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          const data =
            typeof frame === "string"
              ? frame
              : `data: ${JSON.stringify(frame)}\n\n`;
          controller.enqueue(encoder.encode(data));
        }
        controller.close();
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
}

function startLocalProvider() {
  const requests: Array<{ model: string; prompt: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [
            {
              id: modelID,
              object: "model",
              created: 1_700_000_000,
              owned_by: "chorus-fixture",
            },
          ],
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/chat/completions"
      ) {
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
          !prompt
        ) {
          return Response.json(
            { error: "request omitted the model or user prompt" },
            { status: 400 }
          );
        }
        if (payload.model !== modelID) {
          return Response.json({ error: "unexpected model" }, { status: 404 });
        }
        const expected = markers.find(({ prompt: marker }) =>
          prompt.includes(marker)
        );
        if (!expected) {
          return Response.json(
            { error: "prompt did not include a known fixture marker" },
            { status: 422 }
          );
        }
        requests.push({ model: payload.model, prompt });
        return streamingResponse(expected.reply, expected.reasoning);
      }

      return Response.json(
        { error: "fixture route not found" },
        { status: 404 }
      );
    },
  });
  return { port: server.port, requests, stop: () => server.stop(true) };
}

async function waitFor<T>(
  description: string,
  read: () => T | undefined,
  timeoutMs = 60_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    return [
      error.message,
      error.stack,
      ...error.errors.map((nested) => formatError(nested)),
    ].join("\n");
  }
  return error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
}

const root = mkdtempSync(join(tmpdir(), "chorus-provider-execution-"));
const originalEnvironment = { ...process.env };
const repos = markers.map(({ board }) => join(root, `repo-${board}`));
const cleanup: Array<() => Promise<unknown> | unknown> = [];
let failure: unknown;
let hasFailure = false;

try {
  const xdg = {
    cache: join(root, "cache"),
    config: join(root, "config"),
    data: join(root, "data"),
    home: join(root, "home"),
    state: join(root, "state"),
  };
  for (const directory of [...Object.values(xdg), ...repos]) {
    mkdirSync(directory, { recursive: true });
  }

  for (const key of Object.keys(process.env)) {
    if (/^OPENCODE_|(_API_KEY|_TOKEN|_SECRET|PASSWORD)$/i.test(key)) {
      Reflect.deleteProperty(process.env, key);
    }
  }
  process.env.HOME = xdg.home;
  process.env.XDG_CACHE_HOME = xdg.cache;
  process.env.XDG_CONFIG_HOME = xdg.config;
  process.env.XDG_DATA_HOME = xdg.data;
  process.env.XDG_STATE_HOME = xdg.state;
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";

  for (const directory of repos) {
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "fixture@example.com"], {
      cwd: directory,
    });
    execFileSync("git", ["config", "user.name", "Chorus fixture"], {
      cwd: directory,
    });
    writeFileSync(join(directory, "README.md"), "# Disposable route fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: directory });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], {
      cwd: directory,
    });
  }

  const configDirectory = join(xdg.config, "opencode");
  mkdirSync(configDirectory, { recursive: true });
  const provider = startLocalProvider();
  cleanup.push(() => provider.stop());
  writeFileSync(
    join(configDirectory, "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: {
          [providerID]: {
            name: "Chorus local route fixture",
            npm: "@ai-sdk/openai-compatible",
            options: {
              apiKey: "chorus-fixture-key",
              baseURL: `http://127.0.0.1:${String(provider.port)}/v1`,
            },
            models: {
              [modelID]: {
                name: "Chorus route fixture model",
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

  const repositoryRegistry = await RepositoryRegistry.fromEnvironment(
    JSON.stringify(repos)
  );
  const workspace = new WorkspaceStore(join(root, "chorus-data"), {
    repositoryRegistry,
    restorePersistedRepositoryRoots: false,
  });
  await workspace.load();
  cleanup.push(() => workspace.close());
  await workspace.applyMutation({
    baseRevision: null,
    clientId: "provider-route-smoke",
    mutationId: "select-global-local-model",
    payload: { model: { modelID, providerID } },
    type: "preference.default_model.set",
  });

  const engineRegistry = new EngineRegistry({
    databasePath: join(xdg.data, "opencode", "opencode.db"),
    expectedVersion: sdkVersion(),
    maxEngines: repos.length,
    managerFactory: (input) =>
      new OpenCodeProcessManager({ ...input, readinessTimeoutMs: 45_000 }),
  });
  cleanup.push(() => engineRegistry.stop());
  const bridge = new OpenCodeBridge(
    "http://127.0.0.1:4096",
    repos[0] ?? root,
    undefined,
    { engineProvider: engineRegistry }
  );
  cleanup.push(() => bridge.stop());
  bridge.setRecoverySessionProvider((directory) =>
    workspace
      .getSnapshot()
      .boards.filter(
        (board) =>
          (board.repo.worktree ?? board.repo.directory) === directory &&
          board.session.currentTaskId !== undefined &&
          board.session.state === "active"
      )
      .flatMap((board) =>
        board.session.sessionId ? [board.session.sessionId] : []
      )
  );
  bridge.subscribe(async (event) => {
    await workspace.applyAgentEvent(event);
  });

  const boardTasks = new BoardTaskService(
    bridge,
    workspace,
    undefined,
    null,
    repositoryRegistry
  );
  const routeApp = new Elysia()
    .use(createHttpRoutes(bridge, boardTasks, workspace))
    .listen({ hostname: "127.0.0.1", port: 0 });
  cleanup.push(() => routeApp.stop(true));
  const routePort = routeApp.server?.port;
  if (routePort === undefined) {
    throw new Error("Chorus task route did not start.");
  }
  const routeBase = `http://127.0.0.1:${String(routePort)}`;

  const boardIDs: string[] = [];
  for (const [index, directory] of repos.entries()) {
    const mutation = workspaceMutationSchema.parse({
      baseRevision: null,
      clientId: "provider-route-smoke",
      mutationId: `create-board-${String(index)}`,
      payload: {
        seed: {
          title: `Local provider ${markers[index]?.board ?? String(index)}`,
          repo: { directory, sandboxes: [], worktree: directory },
        },
      },
      type: "board.create",
    });
    const commit = await workspace.applyMutation(mutation);
    const created = commit?.events.find(
      (event) => event.type === "board.created"
    );
    if (created?.type !== "board.created") {
      throw new Error("Chorus did not create both disposable boards.");
    }
    boardIDs.push(created.board.boardId);
  }

  const taskRequests = await Promise.all(
    boardIDs.map(async (boardId, index) => {
      const marker = markers[index];
      const board = workspace.getBoard(boardId);
      if (!(marker && board)) {
        throw new Error("A disposable board fixture is incomplete.");
      }
      const response = await fetch(`${routeBase}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          boardId,
          directory: board.repo.directory,
          model: {
            modelID: "untrusted-override",
            providerID: "wrong-provider",
          },
          reviewMode: "auto",
          text: `Return the exact marker ${marker.prompt}.`,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        throw new Error(
          `Chorus /tasks returned ${String(response.status)}: ${await response.text()}`
        );
      }
      const parsedResponse = queueBoardPromptResponseSchema.safeParse(
        await response.json()
      );
      if (!parsedResponse.success || parsedResponse.data.boardId !== boardId) {
        throw new Error("Chorus did not acknowledge the board task route.");
      }
      return {
        boardId,
        sessionId: parsedResponse.data.sessionId,
        taskId: parsedResponse.data.taskId,
        marker,
      };
    })
  );

  await Promise.all(
    taskRequests.map(async ({ boardId, taskId, marker }) =>
      waitFor(`${marker.board} board completion`, () => {
        const board = workspace.getBoard(boardId);
        const task = board?.columns.done.find(
          (candidate) => candidate.id === taskId
        );
        return task;
      })
    )
  );

  for (const { boardId, sessionId, taskId, marker } of taskRequests) {
    const board = workspace.getBoard(boardId);
    const task = board?.columns.done.find(
      (candidate) => candidate.id === taskId
    );
    if (task?.outcome !== "succeeded") {
      throw new Error(
        `${marker.board} did not finish with a successful outcome.`
      );
    }
    if (board?.session.sessionId !== sessionId) {
      throw new Error(
        `${marker.board} reply was attached to the wrong session.`
      );
    }
    const thinking = task.run?.steps
      .filter((step) => step.kind === "thinking")
      .flatMap((step) => (step.content ? [step.content] : []))
      .join("");
    const response = task.run?.steps
      .filter((step) => step.kind === "response")
      .flatMap((step) => (step.content ? [step.content] : []))
      .join("");
    if (!thinking?.includes(marker.reasoning)) {
      throw new Error(
        `${marker.board} provider reasoning was not projected into the thinking stream.`
      );
    }
    if (!response?.includes(marker.reply)) {
      throw new Error(
        `${marker.board} provider response was not projected into the response stream.`
      );
    }
  }

  if (
    workspace.getSnapshot().preferences.defaultModelSelection?.providerID !==
      providerID ||
    workspace.getSnapshot().preferences.defaultModelSelection?.modelID !==
      modelID
  ) {
    throw new Error("The shared Chorus model selection changed unexpectedly.");
  }
  if (
    provider.requests.length !== 2 ||
    provider.requests.some((request) => request.model !== modelID) ||
    markers.some(
      (marker) =>
        !provider.requests.some((request) =>
          request.prompt.includes(marker.prompt)
        )
    )
  ) {
    throw new Error(
      "The local provider did not receive exactly the two shared-model board prompts."
    );
  }

  process.stdout.write(
    `PASS: Chorus /tasks ran both boards on ${providerID}/${modelID} through pinned OpenCode ${sdkVersion()}, ignored request model overrides, streamed provider reasoning and replies into the correct completed task streams, and made exactly two local provider requests.\n`
  );
} catch (error) {
  hasFailure = true;
  failure = error;
}

const cleanupResults = await Promise.allSettled(
  cleanup.reverse().map((task) => Promise.resolve().then(task))
);
process.env = originalEnvironment;
let filesystemCleanupFailure: unknown;
try {
  rmSync(root, { force: true, recursive: true });
} catch (error) {
  filesystemCleanupFailure = error;
}
const cleanupFailures = cleanupResults.flatMap((result) =>
  result.status === "rejected" ? [result.reason] : []
);
if (filesystemCleanupFailure !== undefined) {
  cleanupFailures.push(filesystemCleanupFailure);
}
if (hasFailure && cleanupFailures.length > 0) {
  throw new AggregateError(
    [failure, ...cleanupFailures],
    "Chorus provider route smoke failed and cleanup was incomplete."
  );
}
if (hasFailure) {
  throw new Error(formatError(failure));
}
if (cleanupFailures.length > 0) {
  throw new AggregateError(
    cleanupFailures,
    "Chorus provider route smoke passed but cleanup was incomplete."
  );
}

// The SDK keeps a few idle handles alive after their owning servers close.
// Cleanup above is awaited first so an explicit exit cannot skip resource cleanup.
process.exit(0);
