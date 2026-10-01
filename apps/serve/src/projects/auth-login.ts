interface CommandAttempt {
  args: string[];
  command: string;
  cwd?: string;
}

const LOGIN_COMMAND = "opencode auth login";
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/;

/**
 * POSIX single-quote escaping. Everything between the quotes is literal, so
 * `$(...)`, backticks, and embedded quotes in a directory name cannot escape
 * into command substitution.
 */
function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isUsableDirectory(directory: string): boolean {
  if (directory.length === 0 || directory.includes("\0")) {
    return false;
  }

  return directory.startsWith("/") || WINDOWS_DRIVE_PATTERN.test(directory);
}

async function runDetached(
  command: string,
  args: string[],
  cwd?: string
): Promise<boolean> {
  try {
    const proc = Bun.spawn({
      cmd: [command, ...args],
      cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });

    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export class AuthLoginLauncher {
  async launch(directory: string): Promise<boolean> {
    if (!isUsableDirectory(directory)) {
      return false;
    }

    switch (process.platform) {
      case "darwin": {
        // Terminal.app has no working-directory argument, so the `cd` has to
        // stay in the script text — but it is POSIX-quoted, and the AppleScript
        // string itself is JSON-escaped.
        const script = `cd ${quotePosix(directory)} && ${LOGIN_COMMAND}`;
        return runDetached("osascript", [
          "-e",
          `tell application "Terminal" to do script ${JSON.stringify(script)}`,
        ]);
      }

      case "linux": {
        // Every attempt below runs a constant command string; the working
        // directory travels as a process argument, never as shell text.
        const attempts: CommandAttempt[] = [
          {
            command: "x-terminal-emulator",
            args: ["-e", "bash", "-lc", LOGIN_COMMAND],
            cwd: directory,
          },
          {
            command: "gnome-terminal",
            args: ["--", "bash", "-lc", LOGIN_COMMAND],
            cwd: directory,
          },
          {
            command: "konsole",
            args: ["-e", "bash", "-lc", LOGIN_COMMAND],
            cwd: directory,
          },
          {
            command: "xfce4-terminal",
            args: ["--command", `bash -lc ${quotePosix(LOGIN_COMMAND)}`],
            cwd: directory,
          },
          {
            command: "kitty",
            args: ["bash", "-lc", LOGIN_COMMAND],
            cwd: directory,
          },
          {
            command: "alacritty",
            args: ["-e", "bash", "-lc", LOGIN_COMMAND],
            cwd: directory,
          },
          {
            command: "wezterm",
            args: [
              "start",
              "--cwd",
              directory,
              "--",
              ...LOGIN_COMMAND.split(" "),
            ],
          },
        ];

        for (const attempt of attempts) {
          if (await runDetached(attempt.command, attempt.args, attempt.cwd)) {
            return true;
          }
        }

        return false;
      }

      case "win32":
        return runDetached("powershell", [
          "-NoProfile",
          "-Command",
          `Start-Process powershell -ArgumentList '-NoExit','-Command',${JSON.stringify(
            `Set-Location ${quotePowerShell(directory)}; ${LOGIN_COMMAND}`
          )}`,
        ]);

      default:
        return false;
    }
  }
}
