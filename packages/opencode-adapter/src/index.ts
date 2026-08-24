import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { createOpencodeClient as createSDKClient } from "@opencode-ai/sdk/v2";
import { ConfigManager } from "./features/config/config-manager";
import { EventStream, normalizeEvent } from "./features/events/event-stream";
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
}
