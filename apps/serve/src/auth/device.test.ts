import { describe, expect, test } from "bun:test";
import {
  buildDeviceCookieHeader,
  issueDeviceCookie,
  newDeviceId,
  verifyDeviceCookie,
} from "./device";

const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/;

describe("signed device identity", () => {
  test("mints a random stable identity and verifies it under the token", async () => {
    const first = newDeviceId();
    expect(first).toMatch(DEVICE_ID_PATTERN);
    expect(newDeviceId()).not.toBe(first);

    const cookie = await issueDeviceCookie("operator-token", first);
    expect(await verifyDeviceCookie(cookie, "operator-token")).toEqual({
      deviceId: first,
      ok: true,
    });
  });

  test("rejects tampered cookies, malformed ids, and signatures from another token", async () => {
    const cookie = await issueDeviceCookie("operator-token");
    const [version, deviceId, signature] = cookie.split(".");

    expect(
      await verifyDeviceCookie(`${version}.${deviceId}.bad`, "operator-token")
    ).toEqual({
      ok: false,
    });
    expect(await verifyDeviceCookie(cookie, "different-token")).toEqual({
      ok: false,
    });
    expect(
      await verifyDeviceCookie("v1.not-an-id.signature", "operator-token")
    ).toEqual({
      ok: false,
    });
    expect(signature).toBeTruthy();
  });

  test("cookie is HttpOnly, strict, scoped to root, and secure in production", () => {
    const cookie = buildDeviceCookieHeader("v1.value.signature", true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
  });
});
