import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  OpenCodeCredentialStore,
  type OpenCodeCredentialStoreError,
} from "./credential-store";

async function clean(root: string) {
  const target = resolve(root);
  if (!target.startsWith(`${resolve(tmpdir())}${sep}`)) {
    throw new Error("refusing non-temporary cleanup");
  }
  await rm(target, { recursive: true, force: true });
}

test("missing OpenCode auth data is an empty credential list", async () => {
  const root = await mkdtemp(join(tmpdir(), "chorus-credential-store-"));
  try {
    const store = new OpenCodeCredentialStore(join(root, "auth.json"));
    await expect(store.listCredentials()).resolves.toEqual({ credentials: [] });
  } finally {
    await clean(root);
  }
});

test("invalid auth data is reported instead of appearing as no credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "chorus-credential-store-"));
  try {
    await writeFile(join(root, "auth.json"), "{", "utf8");
    const store = new OpenCodeCredentialStore(join(root, "auth.json"));

    await expect(store.listCredentials()).rejects.toMatchObject({
      code: "credentials_invalid",
      name: "OpenCodeCredentialStoreError",
    } satisfies Partial<OpenCodeCredentialStoreError>);
  } finally {
    await clean(root);
  }
});

test("auth filesystem failures are reported separately from a missing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "chorus-credential-store-"));
  try {
    await mkdir(join(root, "auth.json"));
    const store = new OpenCodeCredentialStore(join(root, "auth.json"));

    await expect(store.listCredentials()).rejects.toMatchObject({
      code: "credentials_read_failed",
    });
  } finally {
    await clean(root);
  }
});
