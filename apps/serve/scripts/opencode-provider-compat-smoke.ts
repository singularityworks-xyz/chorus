import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Event,
  OpenCodeAdapter,
  sdkVersion,
} from "../../../packages/opencode-adapter/src";
import { OpenCodeProcessManager } from "../src/opencode/process-manager";

const providerID = "chorus-local-fixture";
const modelID = "fixture-model";
const expectedReplies = new Map([
  ["chorus-provider-smoke-alpha", "local-reply-alpha"],
  ["chorus-provider-smoke-beta", "local-reply-beta"],
]);
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

function chatChunk(content: string | undefined, finishReason: string | null) {
  return {
    id: "chatcmpl-chorus-fixture",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: modelID,
    choices: [
      {
        index: 0,
        delta: content === undefined ? {} : { content },
        finish_reason: finishReason,
      },
    ],
  };
}

function streamingResponse(reply: string): Response {
  const frames = [
    chatChunk(undefined, null),
    chatChunk("local-reply-", null),
    chatChunk(reply.slice("local-reply-".length), null),
    chatChunk(undefined, "stop"),
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
        const reply = [...expectedReplies].find(([marker]) =>
          prompt.includes(marker)
        )?.[1];
        if (!reply) {
          return Response.json(
            { error: "prompt did not include a known fixture marker" },
            { status: 422 }
          );
        }
        requests.push({ model: payload.model, prompt });
        return streamingResponse(reply);
      }

      return Response.json(
        { error: "fixture route not found" },
        { status: 404 }
      );
    },
  });
  return { port: server.port, requests, stop: () => server.stop(true) };
}

async function allocateLoopbackPorts(count: number): Promise<number[]> {
  const servers: ReturnType<typeof createServer>[] = [];
  const ports: number[] = [];
  let reservationFailure: unknown;

  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Could not reserve a local OpenCode test port.");
      }
      ports.push(address.port);
    }
  } catch (error) {
    reservationFailure = error;
  }

  const closeResults = await Promise.allSettled(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  const closeFailures = closeResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (reservationFailure !== undefined) {
    throw new AggregateError(
      [reservationFailure, ...closeFailures],
      "Could not reserve isolated OpenCode ports."
    );
  }
  if (closeFailures.length > 0) {
    throw new AggregateError(closeFailures, "Could not release test ports.");
  }
  return ports;
}

function assertFinalReply(
  messages: Awaited<ReturnType<OpenCodeAdapter["sessions"]["messages"]>>,
  expected: string,
  boardName: string
) {
  const actual = messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  if (!actual.includes(expected)) {
    throw new Error(`${boardName} did not persist the local provider reply`);
  }
}

function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    return [
      error.stack ?? error.message,
      ...error.errors.map((nested) => formatError(nested)),
    ].join("\n");
  }
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

const root = mkdtempSync(join(tmpdir(), "chorus-opencode-provider-compat-"));
const originalEnvironment = { ...process.env };
const managers: OpenCodeProcessManager[] = [];
const subscriptions: Array<{ stop: () => void }> = [];
let provider: ReturnType<typeof startLocalProvider> | undefined;
let failure: unknown;
let hasFailure = false;

try {
  provider = startLocalProvider();
  for (const key of Object.keys(process.env)) {
    if (/^OPENCODE_|(_API_KEY|_TOKEN|_SECRET|PASSWORD)$/i.test(key)) {
      Reflect.deleteProperty(process.env, key);
    }
  }

  const xdg = {
    cache: join(root, "cache"),
    config: join(root, "config"),
    data: join(root, "data"),
    state: join(root, "state"),
  };
  for (const directory of Object.values(xdg)) {
    mkdirSync(directory, { recursive: true });
  }
  process.env.XDG_CACHE_HOME = xdg.cache;
  process.env.XDG_CONFIG_HOME = xdg.config;
  process.env.XDG_DATA_HOME = xdg.data;
  process.env.XDG_STATE_HOME = xdg.state;
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";

  const directories = [join(root, "board-alpha"), join(root, "board-beta")];
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true });
  }
  const opencodeConfigDirectory = join(xdg.config, "opencode");
  mkdirSync(opencodeConfigDirectory, { recursive: true });
  writeFileSync(
    join(opencodeConfigDirectory, "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: {
          [providerID]: {
            name: "Chorus local compatibility fixture",
            npm: "@ai-sdk/openai-compatible",
            options: {
              apiKey: "chorus-fixture-key",
              baseURL: `http://127.0.0.1:${String(provider.port)}/v1`,
            },
            models: {
              [modelID]: {
                name: "Chorus fixture model",
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

  const enginePorts = await allocateLoopbackPorts(directories.length);
  const databasePath = join(xdg.data, "opencode", "opencode.db");
  const baseUrls = enginePorts.map(
    (port) => `http://127.0.0.1:${String(port)}`
  );
  for (const [index, directory] of directories.entries()) {
    const baseUrl = baseUrls[index];
    const port = enginePorts[index];
    if (!baseUrl || port === undefined) {
      throw new Error(
        "The local compatibility fixture has an incomplete engine address."
      );
    }
    const manager = new OpenCodeProcessManager({
      baseUrl,
      databasePath,
      directory,
      expectedVersion: sdkVersion(),
      port,
      readinessTimeoutMs: 45_000,
    });
    managers.push(manager);
    await manager.start();
  }

  const adapters = directories.map((directory, index) => {
    const baseUrl = baseUrls[index];
    if (!baseUrl) {
      throw new Error("The local compatibility fixture has no engine URL.");
    }
    return OpenCodeAdapter.from({ baseUrl, directory });
  });
  const [alpha, beta] = adapters;
  const [alphaDirectory, betaDirectory] = directories;
  if (!(alpha && beta && alphaDirectory && betaDirectory)) {
    throw new Error(
      "The local compatibility fixture did not create two boards."
    );
  }

  const catalog = await alpha.providers.listModels();
  if (
    !catalog.models.some(
      (model) => model.providerID === providerID && model.modelID === modelID
    )
  ) {
    throw new Error(
      "The pinned OpenCode engine did not load the configured local model."
    );
  }

  const idleIDs = new Set<string>();
  const streamedDeltas = new Map<string, string[]>();
  const expectedSessionIDs = new Set<string>();
  let resolveAll: () => void = () => undefined;
  const allIdle = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });
  const onEngineEvent = (event: Event) => {
    if (
      event.type === "message.part.delta" &&
      event.properties.field === "text"
    ) {
      const deltas = streamedDeltas.get(event.properties.sessionID) ?? [];
      deltas.push(event.properties.delta);
      streamedDeltas.set(event.properties.sessionID, deltas);
    }
    if (event.type === "session.idle") {
      idleIDs.add(event.properties.sessionID);
      if (
        expectedSessionIDs.size === 2 &&
        [...expectedSessionIDs].every((id) => idleIDs.has(id))
      ) {
        resolveAll();
      }
    }
  };
  const alphaSubscription = await alpha.events.subscribe(onEngineEvent, {
    directory: alphaDirectory,
  });
  subscriptions.push(alphaSubscription);
  const betaSubscription = await beta.events.subscribe(onEngineEvent, {
    directory: betaDirectory,
  });
  subscriptions.push(betaSubscription);
  const alphaSession = await alpha.sessions.create({
    directory: alphaDirectory,
    title: "Provider compatibility alpha",
  });
  const betaSession = await beta.sessions.create({
    directory: betaDirectory,
    title: "Provider compatibility beta",
  });
  expectedSessionIDs.add(alphaSession.id);
  expectedSessionIDs.add(betaSession.id);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.all([
      alpha.sessions.promptAsync({
        directory: alphaDirectory,
        model: { providerID, modelID },
        sessionID: alphaSession.id,
        text: "Return the exact marker chorus-provider-smoke-alpha.",
      }),
      beta.sessions.promptAsync({
        directory: betaDirectory,
        model: { providerID, modelID },
        sessionID: betaSession.id,
        text: "Return the exact marker chorus-provider-smoke-beta.",
      }),
    ]);
    await Promise.race([
      allIdle,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `OpenCode did not finish both local provider runs within 45 seconds; idle sessions: ${[...idleIDs].join(", ") || "none"}`
              )
            ),
          45_000
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    alphaSubscription.stop();
    betaSubscription.stop();
  }

  const [alphaMessages, betaMessages] = await Promise.all([
    alpha.sessions.messages(alphaSession.id, { directory: alphaDirectory }),
    beta.sessions.messages(betaSession.id, { directory: betaDirectory }),
  ]);
  const alphaReply = expectedReplies.get("chorus-provider-smoke-alpha");
  const betaReply = expectedReplies.get("chorus-provider-smoke-beta");
  if (!(alphaReply && betaReply)) {
    throw new Error(
      "The local compatibility fixture is missing expected replies."
    );
  }
  assertFinalReply(alphaMessages, alphaReply, "Alpha board");
  assertFinalReply(betaMessages, betaReply, "Beta board");
  const alphaDeltas = streamedDeltas.get(alphaSession.id) ?? [];
  const betaDeltas = streamedDeltas.get(betaSession.id) ?? [];
  if (alphaDeltas.length < 2 || alphaDeltas.join("") !== alphaReply) {
    throw new Error(
      "Alpha board did not receive the ordered local text stream."
    );
  }
  if (betaDeltas.length < 2 || betaDeltas.join("") !== betaReply) {
    throw new Error(
      "Beta board did not receive the ordered local text stream."
    );
  }
  if (
    provider.requests.length !== 2 ||
    provider.requests.some((request) => request.model !== modelID)
  ) {
    throw new Error(
      "The local provider did not receive exactly two expected model requests."
    );
  }
} catch (error) {
  hasFailure = true;
  failure = error;
}

const cleanupTasks: Promise<unknown>[] = [
  ...managers.map((manager) => manager.stop()),
  ...subscriptions.map((subscription) =>
    Promise.resolve().then(() => subscription.stop())
  ),
];
if (provider) {
  cleanupTasks.push(Promise.resolve().then(() => provider?.stop()));
}
const stopResults = await Promise.allSettled(cleanupTasks);
process.env = originalEnvironment;
let filesystemCleanupFailure: unknown;
try {
  rmSync(root, { force: true, recursive: true });
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
  process.stderr.write(
    `${formatError(
      new AggregateError(
        [failure, ...cleanupFailures],
        "Provider compatibility failed and cleanup was incomplete."
      )
    )}\n`
  );
  process.exit(1);
}
if (hasFailure) {
  process.stderr.write(`${formatError(failure)}\n`);
  process.exit(1);
}
if (cleanupFailures.length > 0) {
  process.stderr.write(
    `${formatError(
      new AggregateError(
        cleanupFailures,
        "Provider compatibility passed but cleanup was incomplete."
      )
    )}\n`
  );
  process.exit(1);
}

process.stdout.write(
  `PASS: pinned OpenCode ${sdkVersion()} loaded ${providerID}/${modelID}, streamed and persisted replies on two isolated boards through the shared engine database, and made exactly two requests to the local fixture endpoint. No external provider was used.\n`
);
// The OpenCode SDK leaves keep-alive handles after the engine child and local
// provider are stopped. Exit only after every controlled resource is cleaned.
process.exit(0);
