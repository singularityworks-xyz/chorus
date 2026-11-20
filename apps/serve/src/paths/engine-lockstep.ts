import { createLogger } from "@chorus/logger";

const logger = createLogger({ env: "development" }, "SERVE");

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
