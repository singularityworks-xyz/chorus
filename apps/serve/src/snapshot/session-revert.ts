import { createLogger } from "@chorus/logger";
import { getDiff, restore, track } from "./operations";

const logger = createLogger(
  { env: process.env.NODE_ENV === "production" ? "production" : "development" },
  "SESSION-REVERT"
);

export interface RevertInput {
  directory: string;
  sessionID: string;
}

export interface RevertState {
  diff?: string;
  snapshotHash?: string;
  timestamp: number;
}

const revertStates = new Map<string, RevertState>();

export async function revertSession(input: RevertInput): Promise<RevertState> {
  const { sessionID, directory } = input;

  logger.info("reverting-session", { sessionID, directory });

  const currentHash = await track(directory);

  const diff = await getDiff(directory, currentHash);

  const state: RevertState = {
    snapshotHash: currentHash,
    diff,
    timestamp: Date.now(),
  };

  revertStates.set(sessionID, state);

  logger.info("session-reverted", { sessionID, diff });

  return state;
}

export async function unrevertSession(input: RevertInput): Promise<void> {
  const { sessionID, directory } = input;

  const state = revertStates.get(sessionID);
  if (!state?.snapshotHash) {
    throw new Error("No revert state found for session");
  }

  logger.info("unreverting-session", { sessionID, directory });

  await restore(directory, state.snapshotHash);

  revertStates.delete(sessionID);

  logger.info("session-unreverted", { sessionID });
}

export function getRevertState(sessionID: string): RevertState | undefined {
  return revertStates.get(sessionID);
}

export function clearRevertState(sessionID: string): void {
  revertStates.delete(sessionID);
}
