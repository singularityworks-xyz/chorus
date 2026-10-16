import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { OpenCodeConfigStore } from "../projects/config-store";
import { OpenCodeCredentialStore } from "../projects/credential-store";
import { openCodeStoragePaths } from "./storage-paths";

async function clean(root: string) {
  const target = resolve(root);
  if (!target.startsWith(`${resolve(tmpdir())}${sep}`)) {
    throw new Error("refusing non-temporary cleanup");
  }
  await rm(target, { recursive: true, force: true });
}

test("engine storage follows absolute XDG roots and keeps native home defaults", () => {
  const home = resolve("tmp/fixture-home");
  const fallback = {
    configDirectory: join(home, ".config", "opencode"),
    authFile: join(home, ".local", "share", "opencode", "auth.json"),
  };
  expect(openCodeStoragePaths({}, home)).toEqual(fallback);
  expect(
    openCodeStoragePaths(
      { XDG_CONFIG_HOME: "relative/config", XDG_DATA_HOME: "" },
      home
    )
  ).toEqual(fallback);
  const config = resolve("tmp/config");
  const data = resolve("tmp/data");
  expect(
    openCodeStoragePaths({ XDG_CONFIG_HOME: config, XDG_DATA_HOME: data }, home)
  ).toEqual({
    configDirectory: join(config, "opencode"),
    authFile: join(data, "opencode", "auth.json"),
  });
});

test("provider config and credential summaries read the same persistent engine roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "chorus-engine-storage-"));
  try {
    const paths = openCodeStoragePaths(
      {
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
      },
      join(root, "home")
    );
    const config = new OpenCodeConfigStore(paths.configDirectory);
    await config.configureProvider("fixture-provider");
    expect(await config.listConfiguredProviders()).toEqual({
      providerIDs: ["fixture-provider"],
    });
    await mkdir(dirname(paths.authFile), { recursive: true });
    await writeFile(
      paths.authFile,
      JSON.stringify({
        "fixture-provider": {
          type: "api",
          key: "fixture-private-must-not-be-returned",
        },
      })
    );
    const credentials = await new OpenCodeCredentialStore(
      paths.authFile
    ).listCredentials();
    expect(credentials).toEqual({
      credentials: [{ id: "fixture-provider", type: "api" }],
    });
    expect(JSON.stringify(credentials)).not.toContain("fixture-private");
  } finally {
    await clean(root);
  }
});
