import { describe, expect, test } from "bun:test";
import { mutationOriginMatches } from "./request-origin";

describe("mutation origin policy", () => {
  test("accepts the exact local or proxied HTTPS origin", () => {
    expect(
      mutationOriginMatches("http://localhost:3000", "localhost:3000", "http")
    ).toBe(true);
    expect(
      mutationOriginMatches(
        "https://h-one.hosts.example.net",
        "h-one.hosts.example.net",
        "https"
      )
    ).toBe(true);
  });

  test("rejects missing, sibling, other-port, insecure, and malformed origins", () => {
    for (const origin of [
      null,
      "null",
      "https://attacker.example",
      "https://h-two.hosts.example.net",
      "https://h-one.hosts.example.net:4000",
      "http://h-one.hosts.example.net",
      "https://user@h-one.hosts.example.net",
      "https://h-one.hosts.example.net/path",
    ]) {
      expect(
        mutationOriginMatches(origin, "h-one.hosts.example.net", "https")
      ).toBe(false);
    }
    expect(
      mutationOriginMatches("http://localhost:4000", "localhost:3000", "http")
    ).toBe(false);
  });
});
