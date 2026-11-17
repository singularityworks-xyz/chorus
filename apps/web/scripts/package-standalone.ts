import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface PackageStandaloneOptions {
  appDirectory: string;
  tracingRoot: string;
}

export async function packageStandaloneAssets({
  appDirectory,
  tracingRoot,
}: PackageStandaloneOptions): Promise<void> {
  const appRoot = resolve(appDirectory);
  const traceRoot = resolve(tracingRoot);
  const appFromTraceRoot = relative(traceRoot, appRoot);
  if (
    appFromTraceRoot.length === 0 ||
    isAbsolute(appFromTraceRoot) ||
    appFromTraceRoot === ".." ||
    appFromTraceRoot.startsWith(`..${sep}`)
  ) {
    throw new Error(
      "Standalone app directory must be inside the tracing root."
    );
  }

  const buildRoot = join(appRoot, ".next");
  const standaloneAppRoot = join(buildRoot, "standalone", appFromTraceRoot);
  const serverPath = join(standaloneAppRoot, "server.js");
  try {
    const server = await stat(serverPath);
    if (!server.isFile()) {
      throw new Error(`Standalone server is not a file at ${serverPath}.`);
    }
  } catch (error) {
    if (isMissingPath(error)) {
      throw new Error(
        `Standalone server is missing at ${serverPath}; run next build first.`
      );
    }
    throw error;
  }

  const staticSource = join(buildRoot, "static");
  const staticTarget = join(standaloneAppRoot, ".next", "static");
  await replaceDirectory(staticSource, staticTarget, "Next.js static assets");

  const publicSource = join(appRoot, "public");
  const publicTarget = join(standaloneAppRoot, "public");
  await rm(publicTarget, { force: true, recursive: true });
  try {
    const publicAssets = await stat(publicSource);
    if (!publicAssets.isDirectory()) {
      throw new Error(`Public assets are not a directory at ${publicSource}.`);
    }
  } catch (error) {
    if (isMissingPath(error)) {
      return;
    }
    throw error;
  }
  await cp(publicSource, publicTarget, { recursive: true, force: true });
}

async function replaceDirectory(
  source: string,
  destination: string,
  label: string
): Promise<void> {
  try {
    const assets = await stat(source);
    if (!assets.isDirectory()) {
      throw new Error(`${label} are not a directory at ${source}.`);
    }
  } catch (error) {
    if (isMissingPath(error)) {
      throw new Error(
        `${label} are missing at ${source}; run next build first.`
      );
    }
    throw error;
  }
  await rm(destination, { force: true, recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

if (import.meta.main) {
  const appDirectory = resolve(import.meta.dir, "..");
  await packageStandaloneAssets({
    appDirectory,
    tracingRoot: resolve(appDirectory, "../.."),
  });
}
