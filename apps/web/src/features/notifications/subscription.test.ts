import { afterEach, describe, expect, mock, test } from "bun:test";
import { base64UrlToBytes } from "./browser";
import {
  reconcilePushSubscription,
  setPushOptIn,
  withSubscriptionLock,
} from "./subscription";

const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function installGlobal(name: string, value: unknown) {
  if (!savedGlobals.has(name)) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
    writable: true,
  });
}

afterEach(() => {
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
  savedGlobals.clear();
});

function harness(permission: NotificationPermission = "granted") {
  const preference = new Map<string, string>();
  let current: PushSubscription | null = null;
  let saveStatus = 200;
  let deleteStatus = 200;
  let enabled = true;
  function subscription(
    expirationTime: number | null = null
  ): PushSubscription {
    const value: PushSubscription = {
      endpoint: "https://fcm.googleapis.com/subscription",
      expirationTime,
      getKey: () => null,
      options: {
        applicationServerKey: base64UrlToBytes("AQID").buffer,
        userVisibleOnly: true,
      },
      toJSON: () => ({
        endpoint: value.endpoint,
        expirationTime,
        keys: { auth: "A".repeat(22), p256dh: "A".repeat(87) },
      }),
      unsubscribe: mock(() => {
        current = null;
        return Promise.resolve(true);
      }),
    };
    return value;
  }
  const subscribe = mock(() => {
    current = subscription();
    return Promise.resolve(current);
  });
  const registration = {
    pushManager: { getSubscription: async () => current, subscribe },
  };
  const requestPermission = mock(async () => permission);
  const fetcher = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/push-config")) {
      return Promise.resolve(
        Response.json({
          deviceId: "device-1",
          enabled,
          publicKey: enabled ? "AQID" : null,
        })
      );
    }
    if (url.endsWith("/push-subscriptions")) {
      return Promise.resolve(
        Response.json(
          {},
          { status: init?.method === "DELETE" ? deleteStatus : saveStatus }
        )
      );
    }
    return Promise.resolve(Response.json({ deviceId: "device-1" }));
  });
  installGlobal("window", {
    Notification: { permission, requestPermission },
    PushManager: {},
  });
  installGlobal("navigator", {
    serviceWorker: {
      getRegistration: async () => registration,
      register: async () => registration,
      ready: Promise.resolve(registration),
    },
  });
  installGlobal("localStorage", {
    getItem: (key: string) => preference.get(key) ?? null,
    setItem: (key: string, value: string) => preference.set(key, value),
  });
  installGlobal("fetch", fetcher);
  return {
    subscribe,
    requestPermission,
    fetcher,
    subscription,
    setCurrent: (value: PushSubscription | null) => {
      current = value;
    },
    setSaveStatus: (status: number) => {
      saveStatus = status;
    },
    setDeleteStatus: (status: number) => {
      deleteStatus = status;
    },
    disableServer: () => {
      enabled = false;
    },
  };
}

describe("browser subscription lifecycle", () => {
  test("background reconciliation never requests permission or invents opt-in", async () => {
    for (const permission of ["default", "granted"] as const) {
      const browser = harness(permission);
      const result = await reconcilePushSubscription(false);
      expect(result.state).toBe("ready");
      expect(browser.subscribe).not.toHaveBeenCalled();
      expect(browser.requestPermission).not.toHaveBeenCalled();
    }
  });

  test("retains opt-in when renewal unsubscribes but server cleanup fails", async () => {
    const browser = harness();
    const old = browser.subscription(Date.now() + 1000);
    browser.setCurrent(old);
    browser.setDeleteStatus(503);
    expect((await reconcilePushSubscription(false)).state).toBe("ready");
    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    browser.setDeleteStatus(200);
    expect((await reconcilePushSubscription(false)).state).toBe("active");
    expect(browser.subscribe).toHaveBeenCalledTimes(1);
  });

  test("rolls back an unsaved subscription and retries retained intent", async () => {
    const browser = harness();
    browser.setSaveStatus(503);
    expect((await reconcilePushSubscription(true)).state).toBe("ready");
    browser.setSaveStatus(200);
    const result = await reconcilePushSubscription(false);
    expect(result.state).toBe("active");
    expect(browser.subscribe).toHaveBeenCalledTimes(2);
  });

  test("renews a browser-removed endpoint only for an opted-in device", async () => {
    const browser = harness();
    setPushOptIn(true);
    expect((await reconcilePushSubscription(false)).state).toBe("active");
    browser.setCurrent(null);
    setPushOptIn(false);
    expect((await reconcilePushSubscription(false)).state).toBe("ready");
    expect(browser.subscribe).toHaveBeenCalledTimes(1);
  });

  test("serializes competing reconciliations into one browser subscription", async () => {
    const browser = harness();
    setPushOptIn(true);
    const results = await Promise.all([
      withSubscriptionLock(() => reconcilePushSubscription(false)),
      withSubscriptionLock(() => reconcilePushSubscription(false)),
    ]);
    expect(results.map((result) => result.state)).toEqual(["active", "active"]);
    expect(browser.subscribe).toHaveBeenCalledTimes(1);
  });

  test("disabled push cannot create a subscription even after explicit opt-in", async () => {
    const browser = harness();
    browser.disableServer();
    expect((await reconcilePushSubscription(true)).state).toBe("ready");
    expect(browser.subscribe).not.toHaveBeenCalled();
  });

  test("revoked permission removes the browser and server subscriptions", async () => {
    const browser = harness("denied");
    const old = browser.subscription();
    browser.setCurrent(old);
    const result = await reconcilePushSubscription(false);
    expect(result.permission).toBe("denied");
    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    expect(
      browser.fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")
    ).toBe(true);
    expect(browser.subscribe).not.toHaveBeenCalled();
  });
});
