import { type ChildProcess, spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type HostConnectorStatus,
  hostIdSchema,
  type RelayMachineConnection,
} from "@chorus/contracts";
import { z } from "zod";
import { verifiedConnectorBinaries } from "./connector-binaries";
import { createHostProxyConfig } from "./host-proxy-config";
import { createTunnelConfig, trustedRelayAuthorities } from "./tunnel-config";

const probeSchema = z.strictObject({ hostId: hostIdSchema });

interface ConnectorOptions {
  acmePort: number;
  binaryDirectory: string;
  directory: string;
  httpsPort: number;
  servePort: number;
  webPort: number;
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/** Runs only pinned native executables, with private configs and no shell/GUI. */
export class NativeHostConnector {
  readonly #options: ConnectorOptions;
  readonly #children: ChildProcess[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
  #running: Promise<void> = Promise.resolve();
  #abort = new AbortController();
  #state: HostConnectorStatus = {
    state: "disabled",
    error: null,
    publicOrigin: null,
  };

  constructor(options: ConnectorOptions) {
    this.#options = options;
  }

  status(): HostConnectorStatus {
    return { ...this.#state };
  }

  forceKill(): void {
    this.#generation += 1;
    this.#abort.abort();
    clearTimeout(this.#timer);
    for (const child of this.#children) {
      child.kill("SIGKILL");
    }
    this.#state = { state: "disabled", error: null, publicOrigin: null };
  }

  async start(connection: RelayMachineConnection): Promise<void> {
    await this.stop();
    const generation = this.#generation;
    this.#abort = new AbortController();
    this.#state = { state: "connecting", error: null, publicOrigin: null };
    this.#running = this.#launch(connection, generation, 0);
    await this.#running;
  }

  async stop(): Promise<void> {
    this.#generation += 1;
    this.#abort.abort();
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running;
    const children = this.#children.splice(0);
    this.#state = { state: "disabled", error: null, publicOrigin: null };
    await Promise.all(children.map(terminate));
    await rm(join(this.#options.directory, "frpc.toml"), { force: true });
  }

  async #launch(
    connection: RelayMachineConnection,
    generation: number,
    attempt: number
  ): Promise<void> {
    try {
      const binaries = await verifiedConnectorBinaries(
        this.#options.binaryDirectory
      );
      const caFile = join(this.#options.directory, "relay-roots.pem");
      const tunnelFile = join(this.#options.directory, "frpc.toml");
      const proxyFile = join(this.#options.directory, "Caddyfile");
      await writeFile(caFile, trustedRelayAuthorities(), { mode: 0o600 });
      await writeFile(
        tunnelFile,
        createTunnelConfig(connection, { ...this.#options, caFile }),
        { mode: 0o600 }
      );
      await writeFile(
        proxyFile,
        createHostProxyConfig({
          ...this.#options,
          hostname: connection.hostname,
          hostId: connection.hostId,
        }),
        { mode: 0o600 }
      );
      if (generation !== this.#generation) {
        return;
      }
      const environment = {
        // Do not give relay children provider keys, CHORUS_TOKEN, or inherited
        // proxy/TLS override variables. Windows requires its system directory.
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HOME: this.#options.directory,
        USERPROFILE: this.#options.directory,
        XDG_DATA_HOME: this.#options.directory,
        XDG_CONFIG_HOME: this.#options.directory,
      };
      const run = (binary: string, args: string[]) => {
        const child = spawn(binary, args, {
          cwd: this.#options.directory,
          env: environment,
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
        this.#children.push(child);
        return new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", () =>
            reject(new Error("connector startup failed"))
          );
        });
      };
      await run(binaries.caddy, [
        "run",
        "--config",
        proxyFile,
        "--adapter",
        "caddyfile",
      ]);
      if (generation !== this.#generation) {
        return;
      }
      await run(binaries.frpc, ["-c", tunnelFile]);
      if (generation !== this.#generation) {
        return;
      }
      this.#state = { state: "securing", error: null, publicOrigin: null };
      this.#schedule(
        () => this.#probe(connection, generation, attempt),
        2000,
        generation
      );
    } catch {
      if (generation === this.#generation) {
        await Promise.all(this.#children.splice(0).map(terminate));
        if (generation !== this.#generation) {
          return;
        }
        this.#state = {
          state: "error",
          error: "connector_unavailable",
          publicOrigin: null,
        };
      }
    }
  }

  async #probe(
    connection: RelayMachineConnection,
    generation: number,
    attempt: number
  ): Promise<void> {
    if (generation !== this.#generation) {
      return;
    }
    if (
      this.#children.some(
        (child) => child.exitCode !== null || child.signalCode !== null
      )
    ) {
      await Promise.all(this.#children.splice(0).map(terminate));
      if (generation !== this.#generation) {
        return;
      }
      this.#state = {
        state: "reconnecting",
        error: "remote_unreachable",
        publicOrigin: null,
      };
      this.#schedule(
        () => this.#launch(connection, generation, attempt + 1),
        Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5)),
        generation
      );
      return;
    }
    try {
      const localChecks = await Promise.all([
        fetch(`http://127.0.0.1:${this.#options.webPort}/login`, {
          signal: AbortSignal.any([
            this.#abort.signal,
            AbortSignal.timeout(5000),
          ]),
          redirect: "error",
        }),
        fetch(`http://127.0.0.1:${this.#options.servePort}/health`, {
          signal: AbortSignal.any([
            this.#abort.signal,
            AbortSignal.timeout(5000),
          ]),
          redirect: "error",
        }),
      ]);
      await Promise.all(localChecks.map((response) => response.body?.cancel()));
      if (localChecks.some((response) => !response.ok)) {
        throw new Error("local host unavailable");
      }
      const response = await fetch(
        `https://${connection.hostname}/auth/relay-probe`,
        {
          signal: AbortSignal.any([
            this.#abort.signal,
            AbortSignal.timeout(5000),
          ]),
          redirect: "error",
          cache: "no-store",
        }
      );
      if (
        !response.ok ||
        probeSchema.parse(await response.json()).hostId !== connection.hostId
      ) {
        throw new Error("remote host unavailable");
      }
      if (generation !== this.#generation) {
        return;
      }
      this.#state = {
        state: "ready",
        error: null,
        publicOrigin: `https://${connection.hostname}`,
      };
    } catch {
      if (generation !== this.#generation) {
        return;
      }
      this.#state = {
        state: "reconnecting",
        error: "remote_unreachable",
        publicOrigin: null,
      };
    }
    this.#schedule(
      () => this.#probe(connection, generation, 0),
      15_000,
      generation
    );
  }

  #schedule(
    work: () => Promise<void>,
    delay: number,
    generation: number
  ): void {
    if (generation !== this.#generation) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#running = work().catch(() => {
        if (generation === this.#generation) {
          this.#state = {
            state: "error",
            error: "connector_unavailable",
            publicOrigin: null,
          };
        }
      });
    }, delay);
    this.#timer.unref();
  }
}
