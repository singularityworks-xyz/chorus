import { describe, expect, test } from "bun:test";
import { sdkVersion } from "@chorus/oc-adapter";
import { assertEngineLockstep } from "./engine-lockstep";

const SEMVER = /^1\.\d+\.\d+$/;
const VERSION_MISMATCH = /does not match/;

describe("engine lockstep", () => {
  test("the SDK version is read from the installed manifest", () => {
    expect(sdkVersion()).toMatch(SEMVER);
  });

  test("a matching engine passes", () => {
    expect(() => {
      assertEngineLockstep("1.18.29", "1.18.29");
    }).not.toThrow();
  });

  test("a mismatched engine fails the boot loudly", () => {
    expect(() => {
      assertEngineLockstep("1.18.29", "1.18.30");
    }).toThrow(VERSION_MISMATCH);
  });

  test("an engine that reports no version is a warning, not a refusal", () => {
    for (const observed of [null, undefined, ""]) {
      expect(() => {
        assertEngineLockstep("1.18.29", observed);
      }).not.toThrow();
    }
  });

  test("the installed SDK and the recorded binary are the same version", () => {
    expect(sdkVersion()).toBe("1.19.0");
  });
});
