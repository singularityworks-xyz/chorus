import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ensurePrivateHostDirectory } from "../apps/serve/src/hosting/private-directory";

const IMAGE_TAG = /^chorus-host-(?:serve|web):[a-zA-Z0-9_.-]+$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const LOOPBACK_PORT = /^127\.0\.0\.1:\d+$/;

function docker(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "docker",
      args,
      {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Docker container check command failed: ${stderr.trim().slice(0, 2048)}`
            )
          );
        } else {
          resolvePromise(stdout.trim());
        }
      }
    );
  });
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
async function waitForHttp(url: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        return response;
      }
      await response.arrayBuffer();
    } catch {
      /* A booting container may not have bound its listener yet. */
    }
    await Bun.sleep(250);
  }
  throw new Error("container HTTP readiness timed out");
}
async function stop(container: string, target: "serve" | "web") {
  const started = Date.now();
  await docker(["stop", "--timeout", "5", container]);
  assert(
    Date.now() - started < 5000,
    "container shutdown exceeded five seconds"
  );
  const state = await docker([
    "inspect",
    "--format",
    "{{.State.ExitCode}} {{.State.OOMKilled}}",
    container,
  ]);
  // Installed Next 16.2.2 awaits server cleanup, then exits 143 on SIGTERM.
  // Serve handles that signal itself and must exit 0; 137/oom are never success.
  assert(
    state === "0 false" || (target === "web" && state === "143 false"),
    `container did not exit gracefully (${state})`
  );
}

async function address(container: string, port: "2000" | "3000") {
  const mapped = await docker(["port", container, port]);
  assert(
    LOOPBACK_PORT.test(mapped),
    "container port was not bound exclusively to loopback"
  );
  return `http://${mapped}`;
}

async function status(url: string, method = "GET") {
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(2000),
  });
  await response.arrayBuffer();
  return response.status;
}

async function check(target: string, image: string) {
  assert(target === "serve" || target === "web", "target must be serve or web");
  assert(IMAGE_TAG.test(image), "use an explicit local chorus-host image tag");
  const nonce = crypto.randomUUID();
  const name = `chorus-check-${nonce}`;
  const volume = `chorus-check-data-${nonce}`;
  const parent = await realpath(tmpdir());
  const directory = await ensurePrivateHostDirectory(
    await mkdtemp(join(parent, "chorus-container-check-"))
  );
  let container: string | null = null;
  let volumeCreated = false;
  try {
    const environmentFile = join(directory, "container.env");
    await writeFile(
      environmentFile,
      `OPENCODE_AUTO_START=false\nCHORUS_TOKEN=${randomBytes(32).toString("hex")}\n`,
      { mode: 0o600 }
    );
    const args = [
      "run",
      "--detach",
      "--pull=never",
      "--name",
      name,
      "--label",
      "chorus.validation=container-check",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--memory=768m",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=32m",
      "--publish",
      `127.0.0.1::${target === "serve" ? "2000" : "3000"}`,
    ];
    if (target === "serve") {
      await docker([
        "volume",
        "create",
        "--label",
        "chorus.validation=container-check",
        volume,
      ]);
      volumeCreated = true;
      args.push(
        "--env-file",
        environmentFile,
        "--mount",
        `type=volume,source=${volume},target=/data`
      );
    }
    args.push(image);
    container = await docker(args);
    assert(CONTAINER_ID.test(container), "container identity was not returned");
    let base = await address(container, target === "serve" ? "2000" : "3000");
    const response = await waitForHttp(
      `${base}${target === "serve" ? "/health" : "/"}`
    );
    await response.arrayBuffer();
    assert(
      (await docker(["exec", container, "id", "--user"])) === "10001",
      "container must run as UID 10001"
    );
    if (target === "serve") {
      assert(
        (await status(`${base}/workspace`)) === 401,
        "unauthenticated workspace access must fail"
      );
      assert(
        (await status(`${base}/auth/local-session`, "POST")) === 403,
        "main production ingress must reject bootstrap"
      );
      const engineVersion = await docker([
        "exec",
        container,
        "/app/apps/serve/node_modules/opencode-ai/bin/opencode.exe",
        "--version",
      ]);
      assert(
        engineVersion === "1.19.0",
        "container engine does not match its pinned SDK"
      );
      await docker([
        "exec",
        container,
        "bun",
        "-e",
        "import {Database} from 'bun:sqlite';import {statSync} from 'node:fs';const db=new Database('/data/chorus.db');db.query('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('container-check:v1','persisted');db.close();if(statSync('/data/chorus.db').mode%512!==384)process.exit(1);",
      ]);
      await stop(container, target);
      await docker(["start", container]);
      base = await address(container, "2000");
      await (await waitForHttp(`${base}/health`)).arrayBuffer();
      await docker([
        "exec",
        container,
        "bun",
        "-e",
        "import {Database} from 'bun:sqlite';const db=new Database('/data/chorus.db',{readonly:true});const row=db.query('SELECT value FROM meta WHERE key=?').get('container-check:v1');const integrity=db.query('PRAGMA integrity_check').get();db.close();if(row?.value!=='persisted'||integrity?.integrity_check!=='ok')process.exit(1);",
      ]);
    }
    await stop(container, target);
    process.stdout.write(
      `${target} container: non-root HTTP readiness and graceful shutdown passed${target === "serve" ? "; production auth, engine version, private DB mode, restart and integrity passed" : ""}\n`
    );
  } catch (error) {
    if (container) {
      process.stderr.write(
        `${await docker(["logs", container]).catch(() => "container logs unavailable")}\n`
      );
    }
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    await docker(["rm", "--force", name]).catch((error: unknown) => {
      if (container) {
        cleanupErrors.push(error);
      }
    });
    if (volumeCreated) {
      await docker(["volume", "rm", volume]).catch((error: unknown) =>
        cleanupErrors.push(error)
      );
    }
    const path = resolve(directory);
    if (path.startsWith(`${resolve(parent)}${sep}`)) {
      await rm(path, { recursive: true, force: true }).catch((error: unknown) =>
        cleanupErrors.push(error)
      );
    } else {
      cleanupErrors.push(
        new Error("temporary directory containment check failed")
      );
    }
    if (cleanupErrors.length) {
      process.stderr.write("container check cleanup failed\n");
      process.exitCode = 1;
    }
  }
}

if (import.meta.main) {
  check(process.argv[2] ?? "", process.argv[3] ?? "").catch(
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "host container check failed"}\n`
      );
      process.exitCode = 1;
    }
  );
}
