import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  OpenCodeConfigStore,
  type OpenCodeConfigStoreError,
} from "./config-store";

async function clean(root: string) {
  const target = resolve(root);
  if (!target.startsWith(`${resolve(tmpdir())}${sep}`)) {
    throw new Error("refusing non-temporary cleanup");
  }
  await rm(target, { recursive: true, force: true });
}

test("a missing OpenCode config is treated as an empty configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "chorus-config-store-"));
  try {
    const store = new OpenCodeConfigStore(root);

    await expect(store.listConfiguredProviders()).resolves.toEqual({
      providerIDs: [],
    });
    await expect(store.configureProvider("anthropic")).resolves.toEqual({
      providerIDs: ["anthropic"],
    });
  } finally {
    await clean(root);
  }
});

test("malformed config is reported and never replaced with an empty file", async () => {
  const root = await mkdtemp(join(tmpdir(), "chorus-config-store-"));
  const configPath = join(root, "opencode.json");
  const original = '{"provider":';
  try {
    await writeFile(configPath, original, "utf8");
    const store = new OpenCodeConfigStore(root);

    await expect(store.configureProvider("anthropic")).rejects.toMatchObject({
      code: "config_invalid",
      name: "OpenCodeConfigStoreError",
    } satisfies Partial<OpenCodeConfigStoreError>);
    await expect(readFile(configPath, "utf8")).resolves.toBe(original);
  } finally {
    await clean(root);
  }
});

test("non-object config data is rejected instead of being treated as empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "chorus-config-store-"));
  try {
    await writeFile(join(root, "opencode.json"), "[]", "utf8");
    const store = new OpenCodeConfigStore(root);

    await expect(store.read()).rejects.toMatchObject({
      code: "config_invalid",
    });
  } finally {
    await clean(root);
  }
});

test("filesystem read failures are reported distinctly from missing config", async () => {
  const root = await mkdtemp(join(tmpdir(), "chorus-config-store-"));
  try {
    await mkdir(join(root, "opencode.json"));
    const store = new OpenCodeConfigStore(root);

    await expect(store.read()).rejects.toMatchObject({
      code: "config_read_failed",
    });
  } finally {
    await clean(root);
  }
});
