import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { createOpencodeClient as createSDKClient } from "@opencode-ai/sdk/v2";

export type {
  Message,
  OpencodeClient,
  Part,
  PermissionRequest,
  Session,
} from "@opencode-ai/sdk/v2";

export interface ClientOptions {
  auth?: { password: string; username: string };
  baseUrl?: string;
  directory?: string;
  experimental_workspaceID?: string;
}

export interface ClientResult {
  client: OpencodeClient;
}

interface HeaderMap {
  forEach(callback: (value: string, name: string) => void): void;
  has(name: string): boolean;
  set(name: string, value: string): void;
}

export function createClient(options?: ClientOptions): ClientResult {
  const credentials = options?.auth;
  const fetcher: typeof fetch | undefined = credentials
    ? Object.assign(
        (input: string | URL | Request, init?: BunFetchRequestInit) => {
          const headers = new Headers(
            input instanceof Request ? input.headers : undefined
          ) as unknown as HeaderMap;
          (new Headers(init?.headers) as unknown as HeaderMap).forEach(
            (value, name) => {
              headers.set(name, value);
            }
          );
          if (!headers.has("authorization")) {
            headers.set(
              "authorization",
              `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`
            );
          }
          return fetch(input, {
            ...init,
            headers: headers as unknown as BunFetchRequestInit["headers"],
          });
        },
        { preconnect: globalThis.fetch.preconnect }
      )
    : undefined;

  const client = createSDKClient({
    baseUrl: options?.baseUrl as `${string}://${string}`,
    directory: options?.directory,
    experimental_workspaceID: options?.experimental_workspaceID,
    fetch: fetcher,
  });

  return { client };
}
