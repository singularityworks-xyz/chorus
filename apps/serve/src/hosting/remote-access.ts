import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  type HostRemoteStatus,
  relayOperatorConfigSchema,
  validateRelayConnection,
} from "@chorus/contracts";
import { z } from "zod";
import { verifiedConnectorBinaries } from "./connector-binaries";
import {
  HostEnrollmentClient,
  RemoteConnectionError,
} from "./enrollment-client";
import { NativeHostConnector } from "./native-connector";
import { HostVault } from "./vault";

const portSchema = z.number().int().min(1).max(65_535);
const installationSchema = z.strictObject({
  operator: relayOperatorConfigSchema,
  binaryDirectory: z.string().min(1).refine(isAbsolute),
  webPort: portSchema.default(3000),
  httpsPort: portSchema.default(2443),
  acmePort: portSchema.default(2080),
});

type Availability = HostRemoteStatus["availability"];

/** Local credential enrollment and connector lifecycle; never stores workspace data. */
export class HostRemoteAccess {
  readonly #availability: Availability;
  readonly #installation: z.infer<typeof installationSchema> | null;
  readonly #vault: HostVault | null;
  readonly #enrollment: HostEnrollmentClient | null;
  readonly #connector: NativeHostConnector | null;
  readonly #shutdown = new AbortController();
  #error: HostRemoteStatus["error"] = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;

  private constructor(
    availability: Availability,
    installation: z.infer<typeof installationSchema> | null = null,
    vault: HostVault | null = null,
    connector: NativeHostConnector | null = null
  ) {
    this.#availability = availability;
    this.#installation = installation;
    this.#vault = vault;
    this.#connector = connector;
    this.#enrollment =
      installation && vault
        ? new HostEnrollmentClient(
            installation.operator,
            vault,
            this.#shutdown.signal
          )
        : null;
  }

  static async open(options: {
    installationFile?: string;
    dataDir: string;
    servePort: number;
    isProduction: boolean;
  }): Promise<HostRemoteAccess> {
    if (!options.installationFile) {
      return new HostRemoteAccess("unconfigured");
    }
    // A Next development server must never be reachable through the relay.
    if (!options.isProduction) {
      return new HostRemoteAccess("production_required");
    }
    let vault: HostVault | null = null;
    try {
      const raw = await readFile(options.installationFile, "utf8");
      if (raw.length > 16_384) {
        throw new Error("installation file too large");
      }
      const installation = installationSchema.parse(JSON.parse(raw));
      const ports = [
        options.servePort,
        installation.webPort,
        installation.httpsPort,
        installation.acmePort,
      ];
      if (new Set(ports).size !== ports.length) {
        throw new Error("conflicting host listener ports");
      }
      await verifiedConnectorBinaries(installation.binaryDirectory);
      const directory = join(options.dataDir, "host");
      vault = await HostVault.open(directory);
      const saved = vault.connection();
      if (saved) {
        validateRelayConnection(
          saved,
          installation.operator,
          vault.identity().hostId
        );
      }
      const connector = new NativeHostConnector({
        directory,
        binaryDirectory: installation.binaryDirectory,
        servePort: options.servePort,
        webPort: installation.webPort,
        httpsPort: installation.httpsPort,
        acmePort: installation.acmePort,
      });
      const access = new HostRemoteAccess(
        "available",
        installation,
        vault,
        connector
      );
      access.#schedule();
      return access;
    } catch {
      vault?.close();
      return new HostRemoteAccess("installation_error");
    }
  }

  status(): HostRemoteStatus {
    const connector = this.#connector?.status();
    const challenge = this.#enrollment?.challenge() ?? null;
    return {
      availability: this.#availability,
      state: challenge ? "enrolling" : (connector?.state ?? "disabled"),
      error: this.#error ?? connector?.error ?? null,
      publicOrigin: connector?.publicOrigin ?? null,
      accountOrigin: this.#installation?.operator.accountOrigin ?? null,
      challenge,
      enrolled: this.#vault ? this.#vault.connection() !== null : false,
    };
  }

  begin(label: string): Promise<void> {
    return this.#serialize(async () => {
      if (!(this.#enrollment && this.#vault) || this.#vault.connection()) {
        throw new Error("enrollment unavailable");
      }
      await this.#enrollment.begin(label);
      this.#error = null;
    });
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.#serialize(async () => {
      if (!(this.#vault?.connection() && this.#connector)) {
        throw new Error("host not enrolled");
      }
      this.#vault.setRemoteEnabled(enabled);
      await this.#connector.stop();
      this.#started = false;
      this.#error = null;
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#shutdown.abort();
    clearTimeout(this.#timer);
    await this.#queue;
    await this.#connector?.stop();
    this.#vault?.close();
  }

  forceKill(): void {
    this.#closed = true;
    this.#shutdown.abort();
    clearTimeout(this.#timer);
    this.#connector?.forceKill();
  }

  #serialize(work: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(async () => {
      if (this.#closed) {
        throw new Error("remote access stopped");
      }
      await work();
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #schedule(): void {
    if (this.#closed) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#serialize(async () => {
        if (this.#vault?.enrollment() && this.#enrollment) {
          await this.#enrollment.poll();
          this.#error = null;
        }
        const connection = this.#vault?.connection();
        if (
          connection &&
          this.#vault?.remoteEnabled() &&
          this.#connector &&
          !this.#started
        ) {
          await this.#connector.start(connection);
          this.#started = true;
        }
      })
        .catch((error: unknown) => {
          this.#error =
            error instanceof RemoteConnectionError
              ? error.code
              : "relay_rejected";
        })
        .finally(() => this.#schedule());
    }, 3000);
    this.#timer.unref();
  }
}
