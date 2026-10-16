import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { WorkspaceStore } from "../workspace/store";
import { verifyRequestCredential } from "./guard";
import {
  issueSessionCookie,
  readSessionCookie,
  verifySessionCookie,
} from "./session";
import { DeviceLimitError, SessionRegistry } from "./session-registry";
import { issueTicket } from "./ticket";

describe("revocable host sessions", () => {
  test("bounds paired browsers and releases a slot after revocation or expiry", async () => {
    const root = mkdtempSync(join(tmpdir(), "chorus-device-limit-"));
    const store = new WorkspaceStore(root);
    let now = 1000;
    const registry = new SessionRegistry(
      store.meta,
      "test-session-root",
      () => now
    );
    try {
      const devices = Array.from({ length: 10 }, () => registry.issue(2000));
      expect(() => registry.issue(2000)).toThrow(DeviceLimitError);
      expect(registry.list()).toHaveLength(10);
      const first = devices[0];
      if (!first) {
        throw new Error("test must create a paired device");
      }
      registry.revokeDevice(first.deviceId);
      expect(registry.issue(2000).deviceId).toBeDefined();
      expect(() => registry.issue(2000)).toThrow(DeviceLimitError);
      now = 2001;
      expect(registry.issue(3000).deviceId).toBeDefined();
      expect(registry.list()).toHaveLength(1);
    } finally {
      await store.close();
      if (resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("persists only hashed credentials and rejects revoked cookies and outstanding tickets", async () => {
    const root = mkdtempSync(join(tmpdir(), "chorus-sessions-"));
    let store = new WorkspaceStore(root);
    let now = 10_000;
    const secret = "test-host-session-root";
    let registry = new SessionRegistry(store.meta, secret, () => now);
    try {
      const options = { token: secret, registry, now: () => now };
      const first = await issueSessionCookie(options, 100);
      const second = await issueSessionCookie(options, 100);
      expect(first.cookie).not.toBe(second.cookie);
      expect((await verifySessionCookie(first.cookie, options)).ok).toBe(true);
      expect(
        JSON.stringify(store.meta.entriesWithPrefix("sessions:v2:"))
      ).not.toContain(first.cookie.slice(3));
      const legacy = await issueSessionCookie({
        token: secret,
        now: () => now,
      });
      expect((await verifySessionCookie(legacy.cookie, options)).ok).toBe(
        false
      );
      await store.close();
      store = new WorkspaceStore(root);
      registry = new SessionRegistry(store.meta, secret, () => now);
      expect(
        (await verifySessionCookie(first.cookie, { ...options, registry })).ok
      ).toBe(true);
      const deviceId = first.deviceId;
      if (!deviceId) {
        throw new Error("registered session missing its device identity");
      }
      const ticket = issueTicket({
        store: store.meta,
        now: () => now,
        deviceId,
      });
      registry.revokeDevice(deviceId);
      expect(
        (await verifySessionCookie(first.cookie, { ...options, registry })).ok
      ).toBe(false);
      expect(
        (await verifySessionCookie(second.cookie, { ...options, registry })).ok
      ).toBe(true);
      expect(
        (
          await verifyRequestCredential(
            new Request(`http://localhost/ws?ticket=${ticket}`),
            {
              token: secret,
              sessionRegistry: registry,
              requireDevice: true,
              ticketOptions: { store: store.meta, now: () => now },
            }
          )
        ).ok
      ).toBe(false);
      expect(
        (
          await verifySessionCookie(second.cookie, {
            token: "rotated-secret",
            registry: new SessionRegistry(
              store.meta,
              "rotated-secret",
              () => now
            ),
          })
        ).ok
      ).toBe(false);
      now += 101_000;
      expect(
        (await verifySessionCookie(second.cookie, { ...options, registry })).ok
      ).toBe(false);
      registry.prune();
      expect(registry.list()).toEqual([]);
    } finally {
      await store.close();
      if (resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("rejects ambiguous and malformed cookies and prefers the protected name", () => {
    expect(readSessionCookie("chorus_session=%ZZ")).toBeNull();
    expect(
      readSessionCookie("chorus_session=one;chorus_session=two")
    ).toBeNull();
    expect(
      readSessionCookie(
        "chorus_session=untrusted;__Host-chorus_session=protected"
      )
    ).toBe("protected");
    expect(
      readSessionCookie("__Host-chorus_session=%ZZ;chorus_session=untrusted")
    ).toBeNull();
  });
});
