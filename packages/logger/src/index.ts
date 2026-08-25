import { ConsoleLogger } from "./console-logger";
import { PostHogLogger } from "./posthog-logger";
import type { Logger, LoggerConfig } from "./types";

export function createLogger(config: LoggerConfig, source?: string): Logger {
  if (config.env === "development") {
    return new ConsoleLogger(source);
  }

  if (!(config.postHogApiKey || process.env.POSTHOG_API_KEY)) {
    return new ConsoleLogger(source);
  }

  return new PostHogLogger(config);
}

// biome-ignore lint/performance/noBarrelFile: Package boundary re-exports for clean API surface
export { ConsoleLogger } from "./console-logger";
export { PostHogLogger } from "./posthog-logger";
export type { LogEntry, Logger, LoggerConfig, LogLevel } from "./types";
