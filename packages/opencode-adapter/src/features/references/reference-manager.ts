import type {
  CommandV2Info,
  FileSystemEntry,
  OpencodeClient,
  SkillV2Info,
} from "@opencode-ai/sdk/v2";

export interface CommandReference {
  description?: string;
  name: string;
}

export interface FileReference {
  path: string;
  type: "file" | "directory";
}

export interface ReferenceLookupErrorOptions {
  cause?: unknown;
}

export class ReferenceLookupError extends Error {
  constructor(message: string, options?: ReferenceLookupErrorOptions) {
    super(message, options);
    this.name = "ReferenceLookupError";
  }
}

function unwrap<T>(
  result: { data?: T; error?: unknown },
  operation: string
): T {
  if (result.data !== undefined) {
    return result.data;
  }

  const detail =
    typeof result.error === "object" &&
    result.error !== null &&
    "message" in result.error &&
    typeof result.error.message === "string"
      ? result.error.message
      : "the OpenCode service returned no data";

  throw new ReferenceLookupError(`OpenCode ${operation} failed: ${detail}`);
}

async function lookup<T>(
  operation: string,
  request: () => Promise<{ data?: T; error?: unknown }>
): Promise<T> {
  try {
    return unwrap(await request(), operation);
  } catch (error) {
    if (error instanceof ReferenceLookupError) {
      throw error;
    }
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new ReferenceLookupError(`OpenCode ${operation} failed${detail}`, {
      cause: error,
    });
  }
}

function normalizeCommand(command: CommandV2Info): CommandReference {
  return {
    name: command.name,
    description: command.description,
  };
}

function normalizeSkill(skill: SkillV2Info): CommandReference {
  return {
    name: skill.name,
    description: skill.description,
  };
}

function normalizeFile(entry: FileSystemEntry): FileReference {
  return {
    path: entry.path,
    type: entry.type,
  };
}

export class WorkspaceReferenceManager {
  readonly #client: OpencodeClient;

  constructor(client: OpencodeClient) {
    this.#client = client;
  }

  async listCommands(directory: string): Promise<CommandReference[]> {
    const result = await lookup("command.list", () =>
      this.#client.v2.command.list({ location: { directory } })
    );
    return result.data.map(normalizeCommand);
  }

  async listSkills(directory: string): Promise<CommandReference[]> {
    const result = await lookup("skill.list", () =>
      this.#client.v2.skill.list({ location: { directory } })
    );
    return result.data.map(normalizeSkill);
  }

  async findFiles(query: string, directory: string): Promise<FileReference[]> {
    const result = await lookup("fs.find", () =>
      this.#client.v2.fs.find({
        location: { directory },
        query: query || ".",
        type: "file",
        limit: "50",
      })
    );
    return result.data.map(normalizeFile);
  }

  async listDirectory(
    path: string,
    directory: string
  ): Promise<FileReference[]> {
    const result = await lookup("fs.list", () =>
      this.#client.v2.fs.list({ location: { directory }, path })
    );
    return result.data.map(normalizeFile);
  }
}
