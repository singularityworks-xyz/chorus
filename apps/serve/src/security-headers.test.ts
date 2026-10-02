import { describe, expect, test } from "bun:test";
import {
  CONTENT_SECURITY_POLICY,
  withSecurityHeaders,
} from "./security-headers";

describe("Content-Security-Policy (plan P4.4)", () => {
  test("the policy matches the plan's directives", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain(
      "script-src 'self' 'unsafe-inline'"
    );
    expect(CONTENT_SECURITY_POLICY).toContain(
      "style-src 'self' 'unsafe-inline'"
    );
    expect(CONTENT_SECURITY_POLICY).toContain("img-src 'self' data:");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self' ws: wss:");
  });

  test("unsafe-eval is never granted", () => {
    // The plan forbids it explicitly. If a future framework change demands eval
    // that is a signal to change the framework, not to weaken this header.
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
  });

  test("the policy is not wildcard-open", () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain("*");
  });

  test("clickjacking and plugin content are closed off", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
  });

  test("headers are attached to a response", () => {
    const response = withSecurityHeaders(
      new Response("body", { headers: { "content-type": "text/html" } })
    );

    expect(response.headers.get("Content-Security-Policy")).toBe(
      CONTENT_SECURITY_POLICY
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  test("existing headers and status survive", () => {
    const response = withSecurityHeaders(
      new Response("body", {
        headers: { "cache-control": "no-store", "content-type": "text/html" },
        status: 404,
      })
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("an error response is hardened too", () => {
    // The 503 "Next.js dev server not running" page is rendered HTML and must
    // carry the policy like any other document.
    const response = withSecurityHeaders(new Response("nope", { status: 503 }));

    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Security-Policy")).toBe(
      CONTENT_SECURITY_POLICY
    );
  });
});
