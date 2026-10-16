import { expect, test } from "bun:test";
import { createPostgresFixture } from "./postgres";

test("PostgreSQL qualification refuses remote, operator and overridden-schema connections", async () => {
  for (const url of [
    "postgres://user:fixture@example.com/chorus_relay_test",
    "postgres://user:fixture@127.0.0.1/relay",
    "https://127.0.0.1/chorus_relay_test",
    "postgres://user:fixture@127.0.0.1/chorus_relay_test?options=-c%20search_path=public",
    "postgres://user:fixture@127.0.0.1/chorus_relay_test#fragment",
  ]) {
    await expect(createPostgresFixture(url)).rejects.toThrow(
      "PostgreSQL tests require"
    );
  }
});
