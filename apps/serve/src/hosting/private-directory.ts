import { execFile } from "node:child_process";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const SID = /"(S-1-\d+(?:-\d+)+)"/;

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 5000, encoding: "utf8", maxBuffer: 65_536 },
      (error, stdout) => {
        if (error) {
          reject(
            new Error("Chorus could not protect its host credential directory")
          );
        } else {
          resolvePromise(stdout);
        }
      }
    );
  });
}

/** A dedicated app-owned subdirectory only; never alter a repository's ACL. */
export async function ensurePrivateHostDirectory(
  directory: string
): Promise<string> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Host credentials require a private directory, not a link");
  }
  if (process.platform !== "win32") {
    await chmod(root, 0o700);
    return root;
  }
  // Native utilities run hidden; no PowerShell, shell interpolation, or GUI.
  const identity = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const sid = SID.exec(identity)?.[1];
  if (!sid) {
    throw new Error("Chorus could not determine its Windows host identity");
  }
  await run("icacls.exe", [
    root,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "/remove:g",
    "*S-1-1-0",
    "*S-1-5-11",
    "*S-1-5-32-545",
  ]);
  return root;
}
