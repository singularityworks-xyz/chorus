import { describe, expect, test } from "bun:test";
import {
  CorsMisconfigurationError,
  corsOptionsFor,
  parseAllowedOrigins,
  resolveCorsPolicy,
} from "./cors";

describe("CORS policy (spec §6.3, plan P4.5)", () => {
  test("production emits no CORS configuration at all", () => {
    const policy = resolveCorsPolicy({ isProduction: true });

    expect(policy.allowedOrigins).toEqual([]);
    // The plugin is not mounted: absence of `Access-Control-Allow-Origin` is what
    // makes a browser refuse, and there is no header for "only my own origin".
    expect(corsOptionsFor(policy)).toBeUndefined();
  });

  test("production refuses to start with the allowlist set", () => {
    expect(() =>
      resolveCorsPolicy({
        corsAllowedOrigins: "http://localhost:3000",
        isProduction: true,
      })
    ).toThrow(CorsMisconfigurationError);
  });

  test("the misconfiguration error explains the fix", () => {
    try {
      resolveCorsPolicy({
        corsAllowedOrigins: "http://evil.example",
        isProduction: true,
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CorsMisconfigurationError);
      expect((error as Error).message).toContain("CORS_ALLOWED_ORIGINS");
      expect((error as Error).message).toContain("same-origin only");
    }
  });

  test("a hard failure beats silently ignoring the variable", () => {
    // An operator who set the var and got silence would conclude cross-origin
    // access was broken and "fix" it by widening the policy.
    expect(() =>
      resolveCorsPolicy({
        corsAllowedOrigins: "http://localhost:3000",
        isProduction: true,
      })
    ).toThrow();
  });

  test("a dev allowlist becomes credentialed CORS", () => {
    const policy = resolveCorsPolicy({
      corsAllowedOrigins: "http://localhost:3000",
      isProduction: false,
    });

    const options = corsOptionsFor(policy);

    expect(options).toBeDefined();
    // `origin` is the real option name; `allow` is silently ignored and the
    // plugin reflects any caller-supplied Origin instead.
    expect(options).not.toHaveProperty("allow");
    expect(options?.origin).toEqual(["http://localhost:3000"]);
    // The session cookie is the credential, so it must travel for the dev
    // frontend on :3000 talking to serve on :2000.
    expect(options?.credentials).toBe(true);
  });

  test("an unset or empty allowlist means no plugin in development too", () => {
    expect(
      corsOptionsFor(resolveCorsPolicy({ isProduction: false }))
    ).toBeUndefined();
    expect(
      corsOptionsFor(
        resolveCorsPolicy({
          corsAllowedOrigins: "  , ,",
          isProduction: false,
        })
      )
    ).toBeUndefined();
  });

  test("multiple origins are parsed and trimmed", () => {
    expect(
      parseAllowedOrigins(" http://localhost:3000 , http://127.0.0.1:3000 ")
    ).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
  });

  test("an absent variable parses to an empty list", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
  });
});
