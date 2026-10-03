import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { createOpencodeClient as createSDKClient } from "@opencode-ai/sdk/v2";
import { ConfigManager } from "./features/config/config-manager";
import {
  EventStream,
  normalizeEvent,
  resetMessageTracking,
} from "./features/events/event-stream";
import { InstanceManager } from "./features/instance/instance-manager";
import { PermissionHandler } from "./features/permissions/permission-handler";
import { ProjectManager } from "./features/projects/project-manager";
import { ProviderManager } from "./features/providers/provider-manager";
import { QuestionHandler } from "./features/questions/question-handler";
import { SessionManager } from "./features/session/session-manager";
import { TuiManager } from "./features/tui/tui-manager";

export type {
  AgentPartInput,
  Event,
  FilePartInput,
  Message,
  OpencodeClient,
  Part,
  PermissionRequest,
  Session,
  SessionStatus,
  SubtaskPartInput,
  TextPartInput,
} from "@opencode-ai/sdk/v2";
export type { ClientOptions, ClientResult } from "./features/client/client";
export type {
  EventCallback,
  EventStreamHandle,
  NormalizedActivity,
  NormalizedAgentEvent,
} from "./features/events/event-stream";
export type {
  PermissionHandlerInput,
  PermissionReply,
} from "./features/permissions/permission-handler";
export type {
  ProjectLookupInput,
  RepoContext,
  RepoProject,
  RepoWorktree,
} from "./features/projects/project-manager";
export type {
  OpencodeModelCatalog,
  OpencodeModelSummary,
  OpencodeProviderAuthCatalog,
  OpencodeProviderAuthMethod,
  OpencodeProviderCatalog,
  OpencodeProviderOauthAuthorization,
  OpencodeProviderStatus,
} from "./features/providers/provider-manager";
export type {
  QuestionReplyInput,
  QuestionRequest,
} from "./features/questions/question-handler";
export type {
  SessionCommandInput,
  SessionCreateInput,
  SessionForkInput,
  SessionPromptAsyncInput,
  SessionPromptInput,
  SessionRevertInput,
} from "./features/session/session-manager";
export type { TuiLookupInput } from "./features/tui/tui-manager";

export function createClient(
  options?: import("./features/client/client").ClientOptions
): import("./features/client/client").ClientResult {
  const client = createSDKClient({
    baseUrl: options?.baseUrl as `${string}://${string}`,
    directory: options?.directory,
    experimental_workspaceID: options?.experimental_workspaceID,
  });

  return { client };
}

export class OpenCodeAdapter {
  readonly client: OpencodeClient;
  readonly config: ConfigManager;
  readonly sessions: SessionManager;
  readonly events: EventStream;
  readonly instances: InstanceManager;
  readonly permissions: PermissionHandler;
  readonly questions: QuestionHandler;
  readonly projects: ProjectManager;
  readonly providers: ProviderManager;
  readonly tui: TuiManager;

  constructor(client: OpencodeClient) {
    this.client = client;
    this.config = new ConfigManager(client);
    this.sessions = new SessionManager(client);
    this.events = new EventStream(client);
    this.instances = new InstanceManager(client);
    this.permissions = new PermissionHandler(client);
    this.questions = new QuestionHandler(client);
    this.projects = new ProjectManager(client);
    this.providers = new ProviderManager(client);
    this.tui = new TuiManager(client);
  }

  static from(options?: {
    baseUrl?: string;
    directory?: string;
    experimental_workspaceID?: string;
  }): OpenCodeAdapter {
    const { client } = createClient(options);
    return new OpenCodeAdapter(client);
  }

  normalize = normalizeEvent;
  /** The SDK version this adapter is compiled against. See decision #5. */
  sdkVersion = sdkVersion;
  resetMessageTracking = resetMessageTracking;
}

/**
 * The installed `@opencode-ai/sdk` version, read from its own package.json.
 *
 * Not a hand-maintained constant: bumping the dependency without updating a
 * version string would make the lockstep assertion confidently wrong instead of
 * merely stale.
 *
 * The bare `@opencode-ai/sdk` specifier does not resolve here — the SDK's exports
 * map has no usable CJS entry — but its manifest does.
 */
export function sdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("@opencode-ai/sdk/package.json");
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    const version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;

    if (typeof version !== "string") {
      throw new Error(`no version field in ${manifest}`);
    }

    return version;
  } catch (error) {
    throw new Error(
      `unable to determine the @opencode-ai/sdk version: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
