import { describe, expect, test } from "bun:test";
import {
  prepareAuthenticatedSocketUrl,
  SocketAuthenticationExpiredError,
  type SocketCredentialFetcher,
} from "./socket-credentials";

describe("authenticated WebSocket URL preparation", () => {
  test("registers the device and uses cookies for same-origin sockets", async () => {
    const requests: { input: string | URL | Request; init?: RequestInit }[] =
      [];
    const url = await prepareAuthenticatedSocketUrl("ws://localhost:3000/ws", {
      fetcher: (input, init) => {
        requests.push({ input, init });
        return Promise.resolve(Response.json({ deviceId: "device-1" }));
      },
      pageOrigin: "http://localhost:3000",
    });

    expect(url).toBe("ws://localhost:3000/ws");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe("/api/auth/device");
    expect(requests[0]?.init).toMatchObject({
      cache: "no-store",
      method: "POST",
    });
  });

  test("bootstraps a local browser before registering it as a device", async () => {
    const requests: { input: string | URL | Request; init?: RequestInit }[] =
      [];
    await prepareAuthenticatedSocketUrl("ws://localhost:2000/ws", {
      allowLocalBootstrap: true,
      fetcher: (input, init) => {
        requests.push({ input, init });
        if (String(input).endsWith("/ws-ticket")) {
          return Promise.resolve(Response.json({ ticket: "ab".repeat(16) }));
        }
        return Promise.resolve(Response.json({ authenticated: true }));
      },
      pageOrigin: "http://localhost:3000",
    });

    expect(requests.map((request) => String(request.input))).toEqual([
      "http://localhost:2000/auth/local-session",
      "/api/auth/device",
      "/api/auth/ws-ticket",
    ]);
    expect(requests[0]?.init).toMatchObject({
      credentials: "include",
      headers: { "x-chorus-local-bootstrap": "1" },
      method: "POST",
    });
  });

  test("does not attempt local bootstrap from a LAN or remote browser", async () => {
    const paths: string[] = [];
    await prepareAuthenticatedSocketUrl("ws://192.168.1.8:2000/ws", {
      allowLocalBootstrap: true,
      fetcher: (input) => {
        paths.push(String(input));
        if (String(input).endsWith("/ws-ticket")) {
          return Promise.resolve(Response.json({ ticket: "ab".repeat(16) }));
        }
        return Promise.resolve(Response.json({ deviceId: "device-1" }));
      },
      pageOrigin: "http://192.168.1.8:3000",
    });

    expect(paths).toEqual(["/api/auth/device", "/api/auth/ws-ticket"]);
  });

  test("obtains a ticket for cross-origin sockets", async () => {
    const paths: string[] = [];
    const url = await prepareAuthenticatedSocketUrl(
      "wss://serve.example.test/ws",
      {
        fetcher: (input) => {
          paths.push(String(input));
          return Promise.resolve(
            String(input).endsWith("/ws-ticket")
              ? Response.json({ ticket: "ab".repeat(16) })
              : Response.json({ deviceId: "device-1" })
          );
        },
        pageOrigin: "https://web.example.test",
      }
    );

    expect(paths).toEqual(["/api/auth/device", "/api/auth/ws-ticket"]);
    expect(new URL(url).searchParams.get("ticket")).toBe("ab".repeat(16));
  });

  test("requests a fresh single-use ticket each time", async () => {
    let nextTicket = 1;
    const fetcher: SocketCredentialFetcher = (input) => {
      if (String(input).endsWith("/ws-ticket")) {
        const ticket = String(nextTicket).padStart(32, "0");
        nextTicket += 1;
        return Promise.resolve(Response.json({ ticket }));
      }
      return Promise.resolve(Response.json({ deviceId: "device-1" }));
    };
    const options = { fetcher, pageOrigin: "https://web.example.test" };

    const first = await prepareAuthenticatedSocketUrl(
      "wss://serve.example.test/ws",
      options
    );
    const second = await prepareAuthenticatedSocketUrl(
      "wss://serve.example.test/ws",
      options
    );

    expect(new URL(first).searchParams.get("ticket")).not.toBe(
      new URL(second).searchParams.get("ticket")
    );
  });

  test("treats an expired session as a terminal authentication error", async () => {
    await expect(
      prepareAuthenticatedSocketUrl("ws://localhost:3000/ws", {
        fetcher: async () => new Response(null, { status: 401 }),
        pageOrigin: "http://localhost:3000",
      })
    ).rejects.toBeInstanceOf(SocketAuthenticationExpiredError);
  });

  test("surfaces retryable HTTP and malformed-response failures", async () => {
    await expect(
      prepareAuthenticatedSocketUrl("ws://localhost:3000/ws", {
        fetcher: async () => new Response(null, { status: 503 }),
        pageOrigin: "http://localhost:3000",
      })
    ).rejects.toThrow("HTTP 503");

    await expect(
      prepareAuthenticatedSocketUrl("wss://serve.example.test/ws", {
        fetcher: async (input) =>
          String(input).endsWith("/ws-ticket")
            ? Response.json({ ticket: "bad" })
            : Response.json({ deviceId: "device-1" }),
        pageOrigin: "https://web.example.test",
      })
    ).rejects.toThrow("malformed");
  });
});
