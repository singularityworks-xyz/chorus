import { type ExecFileOptions, execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_BUFFER = 50 * 1024 * 1024;

export interface ExecFileResult {
  stderr: string;
  stdout: string;
}

function execFileText(
  file: string,
  args: string[],
  options: ExecFileOptions
): Promise<ExecFileResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      file,
      args,
      { ...options, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise({ stderr: String(stderr), stdout: String(stdout) });
      }
    );
  });
}

function getSnapshotDir(projectPath: string): string {
  const sanitizedName = projectPath.replace(/[^a-zA-Z0-9]/g, "_");
  return join(homedir(), ".chorus", "snapshots", sanitizedName);
}

function getGitDir(projectPath: string): string {
  return join(getSnapshotDir(projectPath), ".git");
}

export async function ensureSnapshotRepo(projectPath: string): Promise<void> {
  const snapshotDir = getSnapshotDir(projectPath);
  const gitDir = getGitDir(projectPath);

  if (!existsSync(gitDir)) {
    mkdirSync(snapshotDir, { recursive: true });
    await execFileText("git", ["init", "--bare", gitDir], {
      cwd: snapshotDir,
    });

    const gitEnv = { ...process.env, GIT_DIR: gitDir };
    await execFileText("git", ["config", "core.autocrlf", "false"], {
      cwd: projectPath,
      env: gitEnv,
    });
    await execFileText("git", ["config", "core.longpaths", "true"], {
      cwd: projectPath,
      env: gitEnv,
    });

    const excludePath = join(gitDir, "info", "exclude");
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(
      excludePath,
      "*.log\nnode_modules/\ndist/\n.turbo/\n.git/\n.chorus/\n"
    );
  }
}

export function runGit(
  projectPath: string,
  args: string[]
): Promise<ExecFileResult> {
  const gitDir = getGitDir(projectPath);
  const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: projectPath };
  return execFileText("git", args, {
    cwd: projectPath,
    env,
    maxBuffer: MAX_BUFFER,
  });
}

export function runRealGit(
  projectPath: string,
  args: string[]
): Promise<ExecFileResult> {
  return execFileText("git", args, {
    cwd: projectPath,
    maxBuffer: MAX_BUFFER,
  });
}
