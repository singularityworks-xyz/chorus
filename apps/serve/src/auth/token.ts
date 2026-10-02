import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Token file inside the data dir (spec §6.1). */
export const TOKEN_FILE_NAME = "chorus.token";

/** 32 bytes → 64 hex chars → 256 bits of entropy (plan P4.1). */
const TOKEN_BYTES = 32;

export type TokenSource = "environment" | "generated" | "persisted";

export interface ResolvedToken {
  source: TokenSource;
  /** The token value. Never log this. */
  token: string;
  /** Absolute path to the token file, for the bootstrap message. */
  tokenPath: string;
}

export interface TokenEnvironment {
  dataDir: string;
  envToken?: string | undefined;
  isProduction: boolean;
}

/**
 * 256 bits from the CSPRNG, hex encoded.
 *
 * Deliberately not `crypto.randomUUID()` (122 bits) and not `Math.random()`:
 * this value is the only thing standing between a public URL and an operator's
 * shell.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function tokenFilePath(dataDir: string): string {
  return join(dataDir, TOKEN_FILE_NAME);
}

/**
 * Writes the token with `0600` before returning.
 *
 * The chmod is not a follow-up nicety: the token is written first because the
 * value has to exist, and the window between write and chmod is a window where
 * the file is world-readable. Creating it with `mode` and then chmodding is
 * still racy on an existing file, so both are done and the mode is asserted by
 * the caller-facing test.
 */
export async function persistToken(
  dataDir: string,
  token: string
): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const target = tokenFilePath(dataDir);
  await writeFile(target, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600);
  return target;
}

/**
 * Production hard-fails without a token (decision #4).
 *
 * Never auto-generates in production: a server that silently invents its own
 * credential on a public URL is a server nobody can log into, and one that logs
 * the path of a file nobody will find.
 */
export class MissingTokenError extends Error {
  constructor() {
    super("CHORUS_TOKEN must be set in production. See .env.example.");
    this.name = "MissingTokenError";
  }
}

/**
 * Resolves the token for this boot.
 *
 * Order: production requires the env var outright; otherwise the env var wins,
 * then an already-persisted file is reused (so restarts do not orphan the token
 * the operator already has), and only then is one generated.
 */
export async function resolveToken(
  env: TokenEnvironment
): Promise<ResolvedToken> {
  const fromEnv = env.envToken?.trim();

  if (env.isProduction && !fromEnv) {
    throw new MissingTokenError();
  }

  if (fromEnv) {
    return {
      source: "environment",
      token: fromEnv,
      tokenPath: tokenFilePath(env.dataDir),
    };
  }

  const target = tokenFilePath(env.dataDir);

  try {
    const existing = (await readFile(target, "utf8")).trim();
    if (existing.length > 0) {
      return { source: "persisted", token: existing, tokenPath: target };
    }
  } catch {
    // No token yet — fall through and generate one.
  }

  const generated = generateToken();
  await persistToken(env.dataDir, generated);

  return { source: "generated", token: generated, tokenPath: target };
}
