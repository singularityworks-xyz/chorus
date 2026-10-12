import { describe, expect, test } from "bun:test";
import { generateVAPIDKeys } from "web-push-neo";
import { type PushConfigStore, resolvePushConfiguration } from "./config";

function memoryStore(): PushConfigStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    getMeta: (key) => values.get(key) ?? null,
    persistMetaChanges: (changes) =>
      Promise.resolve().then(() => {
        for (const change of changes) {
          if (change.value === null) {
            values.delete(change.key);
          } else {
            values.set(change.key, change.value);
          }
        }
      }),
    values,
  };
}

describe("web push key lifecycle", () => {
  test("push is disabled by default and explicit disablement does not create keys", async () => {
    const store = memoryStore();
    expect(await resolvePushConfiguration({}, store)).toMatchObject({
      enabled: false,
      publicKey: null,
    });
    expect(
      await resolvePushConfiguration({ enabled: "false" }, store)
    ).toMatchObject({ enabled: false, privateKey: null });
    expect(store.values.size).toBe(0);
  });

  test("explicit enable generates once and reuses the persisted pair after restart", async () => {
    const store = memoryStore();
    const first = await resolvePushConfiguration(
      { enabled: "true", subject: "mailto:admin@example.test" },
      store
    );
    const second = await resolvePushConfiguration(
      { enabled: "true", subject: "mailto:admin@example.test" },
      store
    );

    expect(first.enabled).toBe(true);
    expect(first.publicKey).toBe(second.publicKey);
    expect(first.privateKey).toBe(second.privateKey);
    expect(first.keyId).toBe(second.keyId);
    expect(store.values.size).toBe(1);
  });

  test("concurrent key initialization shares the persisted active pair", async () => {
    const store = memoryStore();
    const environment = {
      enabled: "true",
      subject: "mailto:admin@example.test",
    };
    const [first, second] = await Promise.all([
      resolvePushConfiguration(environment, store),
      resolvePushConfiguration(environment, store),
    ]);

    expect(first.keyId).toBe(second.keyId);
    expect(first.publicKey).toBe(second.publicKey);
    expect(first.privateKey).toBe(second.privateKey);
    expect(store.values.size).toBe(1);
  });

  test("a configured complete key pair enables push when PUSH_ENABLED is unset", async () => {
    const keys = await generateVAPIDKeys();
    const result = await resolvePushConfiguration(
      {
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
        subject: "https://example.test/contact",
      },
      memoryStore()
    );
    expect(result.enabled).toBe(true);
    expect(result.publicKey).toBe(keys.publicKey);
  });

  test("incomplete pairs, invalid subjects, corrupt storage, and silent rotation fail closed", async () => {
    const keys = await generateVAPIDKeys();
    await expect(
      resolvePushConfiguration(
        { enabled: "true", publicKey: keys.publicKey },
        memoryStore()
      )
    ).rejects.toThrow("configured together");
    await expect(
      resolvePushConfiguration(
        { enabled: "true", subject: "javascript:alert(1)" },
        memoryStore()
      )
    ).rejects.toThrow("VAPID_SUBJECT");

    const store = memoryStore();
    const config = {
      enabled: "true",
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      subject: "mailto:admin@example.test",
    };
    await resolvePushConfiguration(config, store);
    await expect(
      resolvePushConfiguration(
        { ...config, publicKey: (await generateVAPIDKeys()).publicKey },
        store
      )
    ).rejects.toThrow("rotation procedure");

    store.values.set("push:v1:vapid-keys", "malformed");
    await expect(
      resolvePushConfiguration(
        { enabled: "true", subject: "mailto:a@b.test" },
        store
      )
    ).rejects.toThrow("metadata is invalid");
  });
});
