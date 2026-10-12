import { webSocketTicketResponseSchema } from "@chorus/contracts";

const CREDENTIAL_REQUEST_TIMEOUT_MS = 5000;

export class SocketAuthenticationExpiredError extends Error {
  constructor() {
    super("Your Chorus session has expired");
    this.name = "SocketAuthenticationExpiredError";
  }
}

export type SocketCredentialFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface SocketCredentialOptions {
  fetcher?: SocketCredentialFetcher;
  /** Browser origin, injectable so URL/auth behavior can be tested without DOM. */
  pageOrigin: string;
}

/**
 * Registers this browser as a device and prepares one socket URL.
 *
 * Same-origin sockets use the HttpOnly cookies directly. Cross-origin sockets
 * receive a fresh, single-use ticket through the authenticated same-origin API
 * proxy, because browsers do not attach these cookies to cross-origin upgrades.
 */
export async function prepareAuthenticatedSocketUrl(
  baseUrl: string,
  options: SocketCredentialOptions
): Promise<string> {
  const fetcher = options.fetcher ?? fetch;
  const deviceResponse = await fetchCredentialEndpoint(
    fetcher,
    "/api/auth/device",
    { method: "POST" }
  );
  assertCredentialResponse(deviceResponse, "device registration");

  const socketUrl = new URL(baseUrl);
  if (httpOriginForSocket(socketUrl) === new URL(options.pageOrigin).origin) {
    return socketUrl.toString();
  }

  const ticketResponse = await fetchCredentialEndpoint(
    fetcher,
    "/api/auth/ws-ticket",
    { method: "GET" }
  );
  assertCredentialResponse(ticketResponse, "WebSocket ticket request");

  let payload: unknown;
  try {
    payload = await ticketResponse.json();
  } catch {
    throw new Error("WebSocket ticket response was not valid JSON");
  }

  const parsed = webSocketTicketResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("WebSocket ticket response was malformed");
  }

  socketUrl.searchParams.set("ticket", parsed.data.ticket);
  return socketUrl.toString();
}

async function fetchCredentialEndpoint(
  fetcher: SocketCredentialFetcher,
  path: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetcher(path, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(CREDENTIAL_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `${path} failed: ${error instanceof Error ? error.message : "network error"}`
    );
  }
}

function assertCredentialResponse(response: Response, operation: string): void {
  if (response.status === 401) {
    throw new SocketAuthenticationExpiredError();
  }
  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${String(response.status)}`);
  }
}

function httpOriginForSocket(socketUrl: URL): string {
  const pageEquivalent = new URL(socketUrl);
  if (pageEquivalent.protocol === "wss:") {
    pageEquivalent.protocol = "https:";
  } else if (pageEquivalent.protocol === "ws:") {
    pageEquivalent.protocol = "http:";
  } else {
    throw new Error("WebSocket URL must use ws: or wss:");
  }
  return pageEquivalent.origin;
}
