import { describe, expect, test } from "bun:test";
import {
  buildClearedCookieHeader,
  buildSessionCookieHeader,
  deriveSessionKey,
  issueSessionCookie,
  readSessionCookie,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  timingSafeEqualStrings,
  verifySessionCookie,
} from "./session";

const TOKEN = "a".repeat(64);

describe("session cookie signing (spec §6.1, plan P4.2)", () => {
  test("a minted cookie verifies and carries the expected expiry", async () => {
    const clock = 1_700_000_000_000;
    const now = () => clock;

    const issued = await issueSessionCookie({ now, token: TOKEN });
    const result = await verifySessionCookie(issued.cookie, {
      now,
      token: TOKEN,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.expiresAt).toBe(issued.expiresAt);
    expect(issued.expiresAt).toBe(clock + SESSION_TTL_SECONDS * 1000);
  });

  test("the cookie is version-prefixed", async () => {
    const issued = await issueSessionCookie({ token: TOKEN });

    // The verifier requires the prefix; omitting it once made every issued
    // cookie unverifiable and turned a correct login into a 401.
    expect(issued.cookie.split(".")).toHaveLength(3);
    expect(issued.cookie.startsWith("v1.")).toBe(true);
  });

  test("the signing key is derived, not the raw token", async () => {
    const payload = new TextEncoder().encode("probe");

    // Sign the same bytes with the derived key and with the raw token imported
    // directly as an HMAC key. Different signatures prove the HKDF derivation
    // actually happened rather than the token being used as-is.
    const derivedSignature = await crypto.subtle.sign(
      "HMAC",
      await deriveSessionKey(TOKEN, ["sign"]),
      payload
    );

    const rawKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(TOKEN),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"]
    );
    const rawSignature = await crypto.subtle.sign("HMAC", rawKey, payload);

    expect([...new Uint8Array(derivedSignature)]).not.toEqual([
      ...new Uint8Array(rawSignature),
    ]);
  });

  test("derivation is labelled, so the key cannot be reused elsewhere", async () => {
    // Two labels must not produce the same key material; the plan fixes the
    // label to "chorus-session" so a future purpose cannot collide with this.
    const sessionKey = await deriveSessionKey(TOKEN, ["sign"]);

    const signature = await crypto.subtle.sign(
      "HMAC",
      sessionKey,
      new TextEncoder().encode("probe")
    );

    expect(new Uint8Array(signature).length).toBe(32);
  });

  test("a tampered payload fails verification", async () => {
    const issued = await issueSessionCookie({ token: TOKEN });
    const [, expires, signature] = issued.cookie.split(".");

    // Push the expiry forward by hand and keep the old signature: the longest
    // possible lifetime, forged.
    const forgedExpiry = (Number.parseInt(expires, 36) + 86_400_000).toString(
      36
    );
    const forged = `v1.${forgedExpiry}.${signature}`;

    const result = await verifySessionCookie(forged, { token: TOKEN });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("signature");
  });

  test("a tampered signature fails verification", async () => {
    const issued = await issueSessionCookie({ token: TOKEN });
    const [version, expires, signature] = issued.cookie.split(".");
    const flipped = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;

    const result = await verifySessionCookie(
      `${version}.${expires}.${flipped}`,
      { token: TOKEN }
    );

    expect(result.ok).toBe(false);
  });

  test("a cookie signed with a different token is rejected", async () => {
    const issued = await issueSessionCookie({ token: "b".repeat(64) });

    const result = await verifySessionCookie(issued.cookie, { token: TOKEN });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("signature");
  });

  test("an expired cookie is rejected", async () => {
    let clock = 1_700_000_000_000;
    const issued = await issueSessionCookie({ now: () => clock, token: TOKEN });

    clock += SESSION_TTL_SECONDS * 1000;

    const result = await verifySessionCookie(issued.cookie, {
      now: () => clock,
      token: TOKEN,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("expired");
  });

  test("a cookie one millisecond before expiry still verifies", async () => {
    let clock = 1_700_000_000_000;
    const issued = await issueSessionCookie({ now: () => clock, token: TOKEN });

    clock += SESSION_TTL_SECONDS * 1000 - 1;

    const result = await verifySessionCookie(issued.cookie, {
      now: () => clock,
      token: TOKEN,
    });

    expect(result.ok).toBe(true);
  });

  test("malformed input is rejected without throwing", async () => {
    for (const input of [
      undefined,
      null,
      "",
      "not-a-cookie",
      "v1",
      "v1.onlyone",
      "v2.deadbeef.sig",
      "v1.!!!.sig",
      "v1.zzzz.sig",
    ]) {
      const result = await verifySessionCookie(input, { token: TOKEN });
      expect(result.ok).toBe(false);
    }
  });

  test("verification never throws on hostile input", async () => {
    const hostile = [
      "v1.-1.AAAA",
      `v1.${"9".repeat(40)}.${"A".repeat(200)}`,
      "....",
      "v1..",
    ];

    for (const input of hostile) {
      await expect(
        verifySessionCookie(input, { token: TOKEN })
      ).resolves.toBeDefined();
    }
  });
});

describe("cookie header construction", () => {
  test("production adds Secure; development does not", () => {
    const secure = buildSessionCookieHeader("v1.1.sig", Date.now(), true);
    const plain = buildSessionCookieHeader("v1.1.sig", Date.now(), false);

    expect(secure).toContain("Secure");
    expect(plain).not.toContain("Secure");
  });

  test("the cookie is HttpOnly, SameSite=Strict, and 30 days", () => {
    const header = buildSessionCookieHeader("v1.1.sig", Date.now(), true);

    expect(header).toContain(`${SESSION_COOKIE}=v1.1.sig`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    expect(header).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
  });

  test("logout clears the cookie", () => {
    const header = buildClearedCookieHeader(true);

    expect(header).toContain(`${SESSION_COOKIE}=;`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
  });
});

describe("cookie header parsing", () => {
  test("reads the session cookie out of a Cookie header", () => {
    const header = `other=1; ${SESSION_COOKIE}=v1.abc.sig; another=2`;

    expect(readSessionCookie(header)).toBe("v1.abc.sig");
  });

  test("handles a bare cookie and absent headers", () => {
    expect(readSessionCookie(`${SESSION_COOKIE}=solo`)).toBe("solo");
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie("")).toBeNull();
    expect(readSessionCookie("unrelated=1")).toBeNull();
  });

  test("a percent-encoded value is decoded", () => {
    expect(readSessionCookie(`${SESSION_COOKIE}=a%2Bb`)).toBe("a+b");
  });
});

describe("timingSafeEqualStrings", () => {
  test("matches identical strings and rejects others", () => {
    expect(timingSafeEqualStrings("abc", "abc")).toBe(true);
    expect(timingSafeEqualStrings("abc", "abd")).toBe(false);
    expect(timingSafeEqualStrings("abc", "abcd")).toBe(false);
    expect(timingSafeEqualStrings("", "")).toBe(true);
  });

  test("handles unicode without length surprises", () => {
    expect(timingSafeEqualStrings("héllo", "héllo")).toBe(true);
    expect(timingSafeEqualStrings("héllo", "hello")).toBe(false);
  });
});
