import { createLogger } from "@chorus/logger";

const logger = createLogger({ env: "development" }, "SERVE");

/**
 * Fails boot when the SDK and the engine disagree (decision #5).
 *
 * The adapter re-exports SDK `Event`/`SessionStatus` types, so a mismatch makes
 * the type layer describe an engine that is not the one answering. Nothing
 * throws at runtime; the workspace simply stays empty while the agent works,
 * which is far harder to diagnose than a refusal to start.
 *
 * An unknown engine version is not fatal: a remote engine may not report one, and
 * refusing to boot would be worse than the risk.
 */
export function assertEngineLockstep(
  expected: string,
  observed: string | null | undefined
): void {
  if (!observed) {
    logger.warn("engine-version-unknown", {
      note: "engine did not report a version; lockstep not verified",
    });
    return;
  }

  if (observed !== expected) {
    throw new Error(
      `opencode engine version ${observed} does not match the @opencode-ai/sdk version ${expected}. ` +
        "They must be identical — see .context/versions.md and pre-implementation decision #5."
    );
  }

  logger.info("engine-lockstep-verified", { version: observed });
}
