import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenCodeAdapter,
  sdkVersion,
} from "../../../packages/opencode-adapter/src";
import { OpenCodeProcessManager } from "../src/opencode/process-manager";

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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

  const results = await Promise.allSettled(servers.map(closeServer));
  const cleanupFailures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (reservationFailure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError(
      [reservationFailure, ...cleanupFailures],
      "Port reservation failed and reserved ports could not be released."
    );
  }
  if (reservationFailure !== undefined) {
    throw reservationFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "Could not release test ports.");
  }

  return ports;
}

const rootPrefix = join(tmpdir(), "chorus-opencode-sharing-smoke-");
const root = mkdtempSync(rootPrefix);
const originalEnvironment = { ...process.env };
const managers: OpenCodeProcessManager[] = [];
let failure: unknown;
let hasFailure = false;

try {
  const isolatedDirs = {
    cache: join(root, "cache"),
    config: join(root, "config"),
    data: join(root, "data"),
    home: join(root, "home"),
    state: join(root, "state"),
  };
  for (const directory of Object.values(isolatedDirs)) {
    mkdirSync(directory, { recursive: true });
  }

  // Prevent this disposable smoke from inheriting provider credentials or
  // configuration and ensure no user data can be read or written.
  for (const key of Object.keys(process.env)) {
    if (/^OPENCODE_|(_API_KEY|_TOKEN|_SECRET|PASSWORD)$/i.test(key)) {
      Reflect.deleteProperty(process.env, key);
    }
  }
  process.env.HOME = isolatedDirs.home;
  process.env.XDG_CACHE_HOME = isolatedDirs.cache;
  process.env.XDG_CONFIG_HOME = isolatedDirs.config;
  process.env.XDG_DATA_HOME = isolatedDirs.data;
  process.env.XDG_STATE_HOME = isolatedDirs.state;
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";

  const firstDirectory = join(root, "repository-a");
  const secondDirectory = join(root, "repository-b");
  mkdirSync(firstDirectory);
  mkdirSync(secondDirectory);
  const sharedDatabasePath = join(isolatedDirs.data, "opencode.db");
  const [firstPort, secondPort] = await allocateLoopbackPorts(2);
  if (firstPort === undefined || secondPort === undefined) {
    throw new Error("Could not reserve two local OpenCode test ports.");
  }

  const expectedVersion = sdkVersion();
  const firstBaseUrl = `http://127.0.0.1:${String(firstPort)}`;
  const secondBaseUrl = `http://127.0.0.1:${String(secondPort)}`;
  const firstManager = new OpenCodeProcessManager({
    baseUrl: firstBaseUrl,
    databasePath: sharedDatabasePath,
    directory: firstDirectory,
    expectedVersion,
    port: firstPort,
    readinessTimeoutMs: 45_000,
  });
  managers.push(firstManager);
  const secondManager = new OpenCodeProcessManager({
    baseUrl: secondBaseUrl,
    databasePath: sharedDatabasePath,
    directory: secondDirectory,
    expectedVersion,
    port: secondPort,
    readinessTimeoutMs: 45_000,
  });
  managers.push(secondManager);

  await firstManager.start();
  await secondManager.start();
  const first = OpenCodeAdapter.from({
    baseUrl: firstBaseUrl,
    directory: firstDirectory,
  });
  const second = OpenCodeAdapter.from({
    baseUrl: secondBaseUrl,
    directory: secondDirectory,
  });

  const before = await second.providers.listProviders();
  const anthropicBefore = before.providers.find(
    (provider) => provider.id === "anthropic"
  );
  const openAiBefore = before.providers.find(
    (provider) => provider.id === "openai"
  );
  if (!anthropicBefore || anthropicBefore.connected) {
    throw new Error(
      "The isolated second engine did not start unauthenticated."
    );
  }
  if (!openAiBefore || openAiBefore.connected) {
    throw new Error("The isolated OpenAI provider is unexpectedly connected.");
  }

  const firstWrite = await first.providers.setApiAuth({
    key: "chorus-propagation-fixture-key",
    providerID: "anthropic",
  });
  if (!firstWrite) {
    throw new Error(
      "The first engine did not acknowledge its isolated auth write."
    );
  }

  const afterSecond = await second.providers.listProviders();
  if (
    !afterSecond.providers.find(
      (provider) => provider.id === "anthropic" && provider.connected
    )
  ) {
    throw new Error(
      "The second engine did not observe credentials saved by the first engine."
    );
  }

  const secondWrite = await second.providers.setApiAuth({
    key: "chorus-propagation-reverse-fixture-key",
    providerID: "openai",
  });
  if (!secondWrite) {
    throw new Error(
      "The second engine did not acknowledge its isolated auth write."
    );
  }

  const afterFirst = await first.providers.listProviders();
  if (
    !afterFirst.providers.find(
      (provider) => provider.id === "openai" && provider.connected
    )
  ) {
    throw new Error(
      "The first engine did not observe credentials saved by the second engine."
    );
  }

  // Board engines are disposable and can be restarted independently from the
  // shared OpenCode database. Verify persisted auth remains visible after both
  // processes have exited, rather than relying on either process's memory.
  await Promise.all([firstManager.stop(), secondManager.stop()]);
  await Promise.all([firstManager.start(), secondManager.start()]);

  const [afterRestartFirst, afterRestartSecond] = await Promise.all([
    first.providers.listProviders(),
    second.providers.listProviders(),
  ]);
  for (const [engine, providerList] of [
    ["first", afterRestartFirst],
    ["second", afterRestartSecond],
  ] as const) {
    for (const providerID of ["anthropic", "openai"] as const) {
      if (
        !providerList.providers.find(
          (provider) => provider.id === providerID && provider.connected
        )
      ) {
        throw new Error(
          `The ${engine} engine did not recover shared ${providerID} credentials after restart.`
        );
      }
    }
  }

  process.stdout.write(
    `PASS: OpenCode ${expectedVersion} processes sharing OPENCODE_DB observed provider auth writes in both directions and recovered them after restart; no provider generation was requested.\n`
  );
} catch (error) {
  hasFailure = true;
  failure = error;
}

const stopResults = await Promise.allSettled(
  managers.map((manager) => manager.stop())
);
process.env = originalEnvironment;
rmSync(root, { force: true, recursive: true });

const cleanupFailures = stopResults.flatMap((result) =>
  result.status === "rejected" ? [result.reason] : []
);
if (hasFailure && cleanupFailures.length > 0) {
  throw new AggregateError(
    [failure, ...cleanupFailures],
    "Provider propagation smoke failed and cleanup was incomplete."
  );
}
if (hasFailure) {
  throw failure;
}
if (cleanupFailures.length > 0) {
  throw new AggregateError(
    cleanupFailures,
    "Provider propagation smoke passed but cleanup was incomplete."
  );
}
