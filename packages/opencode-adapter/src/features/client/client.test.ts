import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "./client";

describe("OpenCode client authentication", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends configured Basic auth on engine requests without putting it in the URL", async () => {
    const observed: { authorization?: string; requestedUrl?: string } = {};
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: BunFetchRequestInit) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        observed.requestedUrl = request.url;
        observed.authorization = request.headers.get("authorization") ?? "";
        return await Promise.resolve(
          Response.json({ healthy: true, version: "1.19.0" })
        );
      },
      { preconnect: originalFetch.preconnect }
    );

    const { client } = createClient({
      auth: { password: "secret-value", username: "chorus" },
      baseUrl: "https://engine.example.com",
    });

    await client.global.health();

    expect(observed.authorization).toBe(
      `Basic ${Buffer.from("chorus:secret-value").toString("base64")}`
    );
    expect(observed.requestedUrl).toBe(
      "https://engine.example.com/global/health"
    );
  });
});
