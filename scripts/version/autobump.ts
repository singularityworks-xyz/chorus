import { fileURLToPath } from "node:url";
import { Glob } from "bun";

export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name: string;
  private?: boolean;
  scripts?: Record<string, string>;
  version?: string;
  [key: string]: unknown;
}

export interface WorkspacePackage {
  currentVersion: string;
  directory: string;
  headVersion: string | null;
  manifestPath: string;
  name: string;
}

export interface VersionState {
  head: string;
  rootVersion: string;
}

const semverPattern = /^\d+\.\d+\.\d+$/;
const packageJsonSuffixPattern = /\/package\.json$/;
const rootDir = new URL("../../", import.meta.url);
const rootPath = fileURLToPath(rootDir);
const isDryRun = Bun.argv.includes("--dry-run");
const temporaryChangesetPath = ".changeset/chorus-auto-version.md";
const statePath = new URL(".git/chorus-autobump-state.json", rootDir);
const workspaceManifestGlobs = [
  new Glob("apps/*/package.json"),
  new Glob("packages/*/package.json"),
];

function runGit(args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: rootPath,
    stderr: "pipe",
    stdout: "pipe",
  });

  if (result.exitCode !== 0) {
    const error = result.stderr.toString().trim() || "git command failed";
    throw new Error(error);
  }

  return result.stdout.toString().trim();
}

export function nextVersion(version: string) {
  const parts = parseVersion(version);

  if (parts.patch < 99) {
    return `${parts.major}.${parts.minor}.${parts.patch + 1}`;
  }

  return `${parts.major}.${parts.minor + 1}.0`;
}

export function parseVersion(version: string) {
  if (!semverPattern.test(version)) {
    throw new Error(`Invalid version format: ${version}`);
  }

  const [major, minor, patch] = version.split(".").map((segment) => {
    const value = Number.parseInt(segment, 10);

    if (Number.isNaN(value)) {
      throw new Error(`Invalid numeric version segment: ${version}`);
    }

    return value;
  });

  return { major, minor, patch };
}

export function getWorkspaceDirectory(manifestPath: string) {
  return manifestPath.replace(packageJsonSuffixPattern, "");
}

function toJsonString(value: PackageManifest) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function toStateString(value: VersionState) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson(relativePath: string) {
  return (await Bun.file(
    new URL(relativePath, rootDir)
  ).json()) as PackageManifest;
}

async function writeJson(relativePath: string, value: PackageManifest) {
  await Bun.write(new URL(relativePath, rootDir), toJsonString(value));
}

function getHeadFileText(relativePath: string) {
  try {
    return runGit(["show", `HEAD:${relativePath}`]);
  } catch {
    return null;
  }
}

function getHeadVersion(relativePath: string) {
  const headText = getHeadFileText(relativePath);

  if (!headText) {
    return null;
  }

  try {
    const manifest = JSON.parse(headText) as PackageManifest;
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

function getStagedFiles() {
  const output = runGit([
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMR",
  ]);

  if (!output) {
    return [];
  }

  return output
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

function getHeadRootVersion() {
  return getHeadVersion("package.json");
}

async function readState() {
  const stateFile = Bun.file(statePath);

  if (!(await stateFile.exists())) {
    return null;
  }

  try {
    return (await stateFile.json()) as VersionState;
  } catch {
    return null;
  }
}

async function writeState(state: VersionState) {
  await Bun.write(statePath, toStateString(state));
}

export function createTemporaryChangeset(packages: WorkspacePackage[]) {
  const frontmatter = packages.map((pkg) => `"${pkg.name}": patch`).join("\n");

  return `---\n${frontmatter}\n---\n\nAuto-generated pre-commit changeset.\n`;
}

async function discoverWorkspacePackages() {
  const manifestPaths: string[] = [];

  for (const glob of workspaceManifestGlobs) {
    for (const manifestPath of glob.scanSync({ cwd: rootPath })) {
      manifestPaths.push(manifestPath);
    }
  }

  const packages: WorkspacePackage[] = [];

  for (const manifestPath of manifestPaths.toSorted()) {
    const manifest = await readJson(manifestPath);

    if (typeof manifest.version !== "string") {
      continue;
    }

    packages.push({
      currentVersion: manifest.version,
      directory: getWorkspaceDirectory(manifestPath),
      headVersion: getHeadVersion(manifestPath),
      manifestPath,
      name: manifest.name,
    });
  }

  return packages;
}

export function getChangedWorkspaces(
  workspacePackages: WorkspacePackage[],
  stagedFiles: string[]
) {
  return workspacePackages.filter((workspacePackage) =>
    stagedFiles.some(
      (file) =>
        file === workspacePackage.manifestPath ||
        file.startsWith(`${workspacePackage.directory}/`)
    )
  );
}

export function getWorkspacesNeedingBump(
  changedWorkspaces: WorkspacePackage[]
) {
  return changedWorkspaces.filter(
    (workspacePackage) =>
      workspacePackage.headVersion === null ||
      workspacePackage.currentVersion === workspacePackage.headVersion
  );
}

export function shouldBumpRootVersion({
  currentVersion,
  headRef,
  headVersion,
  state,
}: {
  currentVersion: string;
  headRef: string;
  headVersion: string | null;
  state: VersionState | null;
}) {
  const rootAlreadyBumpedForHead =
    state?.head === headRef && state.rootVersion === currentVersion;

  return (
    !rootAlreadyBumpedForHead &&
    (headVersion === null || currentVersion === headVersion)
  );
}

function runChangesetVersion() {
  const result = Bun.spawnSync(["bun", "x", "changeset", "version"], {
    cwd: rootPath,
    stderr: "inherit",
    stdout: "inherit",
  });

  if (result.exitCode !== 0) {
    throw new Error("changeset version failed");
  }
}

async function main() {
  const stagedFiles = getStagedFiles();
  const rootManifest = await readJson("package.json");
  const rootHeadVersion = getHeadRootVersion();
  const headRef = (() => {
    try {
      return runGit(["rev-parse", "HEAD"]);
    } catch {
      return "NO_HEAD";
    }
  })();
  const state = await readState();
  const rootNeedsBump =
    typeof rootManifest.version === "string" &&
    shouldBumpRootVersion({
      currentVersion: rootManifest.version,
      headRef,
      headVersion: rootHeadVersion,
      state,
    });

  const workspacePackages = await discoverWorkspacePackages();
  const changedWorkspaces = getChangedWorkspaces(
    workspacePackages,
    stagedFiles
  );
  const workspacesNeedingBump = getWorkspacesNeedingBump(changedWorkspaces);

  if (isDryRun) {
    const changedNames = workspacesNeedingBump.map(
      (workspace) => workspace.name
    );
    console.log(
      JSON.stringify(
        {
          rootNeedsBump,
          workspacesNeedingBump: changedNames,
        },
        null,
        2
      )
    );
    return;
  }

  if (workspacesNeedingBump.length > 0) {
    await Bun.write(
      new URL(temporaryChangesetPath, rootDir),
      createTemporaryChangeset(workspacesNeedingBump)
    );

    try {
      runChangesetVersion();
    } finally {
      const tempChangesetFile = Bun.file(
        new URL(temporaryChangesetPath, rootDir)
      );

      if (await tempChangesetFile.exists()) {
        await tempChangesetFile.delete();
      }
    }

    for (const workspace of workspacesNeedingBump) {
      const manifest = await readJson(workspace.manifestPath);

      if (typeof manifest.version === "string") {
        manifest.version = nextVersion(workspace.currentVersion);
        await writeJson(workspace.manifestPath, manifest);
      }
    }

    runGit([
      "add",
      ...workspacesNeedingBump.map((workspace) => workspace.manifestPath),
    ]);
  }

  if (rootNeedsBump && typeof rootManifest.version === "string") {
    rootManifest.version = nextVersion(rootManifest.version);
    await writeJson("package.json", rootManifest);
    runGit(["add", "package.json"]);
    await writeState({
      head: headRef,
      rootVersion: rootManifest.version,
    });
  }
}

if (import.meta.main) {
  await main();
}
