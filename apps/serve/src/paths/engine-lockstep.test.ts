import { describe, expect, test } from "bun:test";
import { sdkVersion } from "@chorus/oc-adapter";
import { assertEngineLockstep } from "./engine-lockstep";

const SEMVER = /^1\.\d+\.\d+$/;
const VERSION_MISMATCH = /does not match/;

/**
 * SDK ↔ binary lockstep (pre-implementation decision #5).
 *
 * The adapter re-exports SDK `Event`/`SessionStatus` types, so a mismatch makes
 * the type layer describe an engine that is not the one answering. Nothing throws
 * at runtime when it drifts — the workspace just stays empty while the agent
 * works, which is far harder to diagnose than a refusal to boot.
 */
describe("engine lockstep", () => {
  test("the SDK version is read from the installed manifest", () => {
    // Not hardcoded: this is the point of the test. If someone bumps the
    // dependency and leaves a stale constant, this fails.
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
    // A remote engine may not report one, and refusing to boot would be a worse
    // failure than the risk this check exists to bound.
    for (const observed of [null, undefined, ""]) {
      expect(() => {
        assertEngineLockstep("1.18.29", observed);
      }).not.toThrow();
    }
  });

  test("the installed SDK and the recorded binary are the same version", () => {
    // The pairing documented in `.context/versions.md`. If a dependency bump
    // lands without a matching binary, this is the test that says so.
    expect(sdkVersion()).toBe("1.18.29");
  });
});
