import {
  ENGINE_PID_FILE,
  OPENCODE_PORT,
  SERVE_PID_FILE,
  SERVE_PORT,
} from "./serve-env";
import { stop } from "./serve-process";

export default async function globalTeardown(): Promise<void> {
  try {
    await stop(SERVE_PORT, SERVE_PID_FILE);
  } finally {
    await stop(OPENCODE_PORT, ENGINE_PID_FILE, "engine");
  }
}
