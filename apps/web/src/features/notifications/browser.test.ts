import { describe, expect, test } from "bun:test";
import {
  base64UrlToBytes,
  getPushBrowserCapability,
  pushSubscriptionNeedsRenewal,
  safeNotificationReturnTo,
  usesApplicationServerKey,
} from "./browser";

describe("notification browser helpers", () => {
  test("accepts only same-origin board and card targets", () => {
    expect(
      safeNotificationReturnTo(
        "/?board=board_1&card=task-1",
        "https://chorus.test"
      )
    ).toBe("/?board=board_1&card=task-1");
    expect(
      safeNotificationReturnTo(
        "https://evil.test/?board=a&card=b",
        "https://chorus.test"
      )
    ).toBe("/");
    expect(
      safeNotificationReturnTo(
        "/?board=a&card=b&next=https://evil.test",
        "https://chorus.test"
      )
    ).toBe("/");
    expect(safeNotificationReturnTo("//evil.test", "https://chorus.test")).toBe(
      "/"
    );
  });

  test("decodes the VAPID application key as URL-safe base64", () => {
    expect([...base64UrlToBytes("AQIDBA")]).toEqual([1, 2, 3, 4]);
  });

  test("renews a known expiry early and reconciles subscriptions without an expiry", () => {
    const now = 100_000;
    expect(pushSubscriptionNeedsRenewal(now + 60_000, now)).toBe(true);
    expect(pushSubscriptionNeedsRenewal(now + 600_000, now)).toBe(false);
    expect(pushSubscriptionNeedsRenewal(null, now)).toBe(false);
  });

  test("detects VAPID key rotation without accepting a different key", () => {
    expect(usesApplicationServerKey(new Uint8Array([1, 2, 3]), "AQID")).toBe(
      true
    );
    expect(usesApplicationServerKey(new Uint8Array([1, 2, 4]), "AQID")).toBe(
      false
    );
    expect(usesApplicationServerKey(null, "AQID")).toBe(false);
  });

  test("requires an installed iOS web app for push", () => {
    const iosInput = {
      displayModeStandalone: false,
      maxTouchPoints: 1,
      platform: "iPhone",
      pushManagerAvailable: true,
      secureContext: true,
      serviceWorkerAvailable: true,
      userAgent: "Mozilla/5.0 (iPhone)",
    };
    expect(getPushBrowserCapability(iosInput)).toEqual({
      needsHomeScreen: true,
      supported: false,
    });
    expect(
      getPushBrowserCapability({ ...iosInput, displayModeStandalone: true })
    ).toEqual({ needsHomeScreen: false, supported: true });
  });
});
