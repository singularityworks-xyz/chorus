import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostVault } from "../hosting/vault";

export const TOKEN_FILE_NAME = "chorus.token";

const TOKEN_BYTES = 32;

export type TokenSource =
  | "environment"
  | "generated"
  | "persisted"
  | "host-vault";

export interface ResolvedToken {
  source: TokenSource;

  token: string;

  tokenPath: string;
}

export interface TokenEnvironment {
  dataDir: string;
  envToken?: string | undefined;
  isProduction: boolean;

  managedLocalEntry?: boolean;
}

export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function tokenFilePath(dataDir: string): string {
  return join(dataDir, TOKEN_FILE_NAME);
}

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

export class MissingTokenError extends Error {
  constructor() {
    super("CHORUS_TOKEN must be set in production. See .env.example.");
    this.name = "MissingTokenError";
  }
}

export async function resolveToken(
  env: TokenEnvironment
): Promise<ResolvedToken> {
  const fromEnv = env.envToken?.trim();

  if (env.isProduction && !fromEnv && !env.managedLocalEntry) {
    throw new MissingTokenError();
  }

  if (fromEnv) {
    return {
      source: "environment",
      token: fromEnv,
      tokenPath: tokenFilePath(env.dataDir),
    };
  }

  if (env.isProduction && env.managedLocalEntry) {
    const vault = await HostVault.open(join(env.dataDir, "host"));
    try {
      return {
        source: "host-vault",
        token: vault.sessionSigningSecret(),
        tokenPath: join(env.dataDir, "host", "vault.db"),
      };
    } finally {
      vault.close();
    }
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
