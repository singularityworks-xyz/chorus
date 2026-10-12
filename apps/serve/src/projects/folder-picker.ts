interface CommandResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

type PickAttempt =
  | { kind: "selected"; path: string }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

export interface FolderPicker {
  pickFolder: () => Promise<string | null>;
}

export class FolderPickerUnavailableError extends Error {
  constructor(message = "No supported native folder picker is available") {
    super(message);
    this.name = "FolderPickerUnavailableError";
  }
}

async function runCommand(
  command: string,
  args: string[]
): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd: [command, ...args],
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

async function tryPick(command: string, args: string[]): Promise<PickAttempt> {
  try {
    const result = await runCommand(command, args);
    if (result.exitCode !== 0) {
      return { kind: "cancelled" };
    }

    const value = result.stdout.trim();
    return value.length > 0
      ? { kind: "selected", path: value }
      : { kind: "cancelled" };
  } catch {
    return { kind: "unavailable" };
  }
}

export class NativeFolderPicker implements FolderPicker {
  pickFolder(): Promise<string | null> {
    switch (process.platform) {
      case "darwin":
        return this.#pickOrNull([
          {
            command: "osascript",
            args: [
              "-e",
              'POSIX path of (choose folder with prompt "Select a project folder for Chorus")',
            ],
          },
        ]);

      case "linux": {
        return this.#pickOrNull([
          {
            command: "zenity",
            args: [
              "--file-selection",
              "--directory",
              "--title=Select a project folder for Chorus",
            ],
          },
          {
            command: "kdialog",
            args: [
              "--getexistingdirectory",
              process.cwd(),
              "--title",
              "Select a project folder for Chorus",
            ],
          },
          {
            command: "yad",
            args: [
              "--file-selection",
              "--directory",
              "--title=Select a project folder for Chorus",
            ],
          },
        ]);
      }

      case "win32": {
        return this.#pickOrNull([
          {
            command: "powershell",
            args: [
              "-NoProfile",
              "-Command",
              "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;$dialog.Description = 'Select a project folder for Chorus';if ($dialog.ShowDialog() -eq 'OK') { Write-Output $dialog.SelectedPath }",
            ],
          },
        ]);
      }

      default:
        throw new FolderPickerUnavailableError(
          `Unsupported platform: ${process.platform}`
        );
    }
  }

  async #pickOrNull(
    commands: Array<{
      command: string;
      args: string[];
    }>
  ): Promise<string | null> {
    let sawCancellation = false;

    for (const candidate of commands) {
      const result = await tryPick(candidate.command, candidate.args);

      if (result.kind === "selected") {
        return result.path;
      }

      if (result.kind === "cancelled") {
        sawCancellation = true;
      }
    }

    if (sawCancellation) {
      return null;
    }

    throw new FolderPickerUnavailableError();
  }
}
