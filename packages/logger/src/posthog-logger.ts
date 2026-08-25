import { PostHog as PostHogClient } from "posthog-node";
import { readEnv } from "./env";
import type { Logger, LoggerConfig, LogLevel } from "./types";

const DEFAULT_CONFIG = {
  apiKey: readEnv("POSTHOG_API_KEY") ?? "",
  apiHost: "https://us.i.posthog.com",
  projectId: "368625",
  releaseName: "chorus",
  releaseVersion: "0.0.16",
};

export class PostHogLogger implements Logger {
  private readonly client: PostHogClient;
  private readonly config: LoggerConfig;
  private readonly distinctId: string;

  constructor(config: LoggerConfig) {
    this.config = config;
    this.distinctId =
      config.releaseName ?? DEFAULT_CONFIG.releaseName ?? "chorus-app";

    this.client = new PostHogClient(
      config.postHogApiKey ?? DEFAULT_CONFIG.apiKey,
      {
        host: config.postHogApiHost ?? DEFAULT_CONFIG.apiHost,
      }
    );
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.captureLog("DEBUG" as LogLevel, message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.captureLog("INFO" as LogLevel, message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.captureLog("WARN" as LogLevel, message, context);
  }

  error(
    message: string,
    error?: Error | unknown,
    context?: Record<string, unknown>
  ): void {
    const errorContext: Record<string, unknown> = {
      ...context,
      errorMessage: message,
    };

    if (error instanceof Error) {
      errorContext.errorName = error.name;
      errorContext.errorStack = error.stack;
    }

    this.captureLog("ERROR" as LogLevel, message, errorContext);
  }

  captureEvent(event: string, properties?: Record<string, unknown>): void {
    this.client.capture({
      distinctId: this.distinctId,
      event,
      properties: {
        ...properties,
        release: this.config.releaseVersion ?? DEFAULT_CONFIG.releaseVersion,
        source: "chorus-backend",
      },
    });
  }

  captureException(
    error: Error | unknown,
    context?: Record<string, unknown>
  ): void {
    const errorData: Record<string, unknown> = {
      $exception_type: error instanceof Error ? error.name : typeof error,
      $exception_message:
        error instanceof Error ? error.message : String(error),
      $exception_stack_trace: error instanceof Error ? error.stack : undefined,
      ...context,
      release: this.config.releaseVersion ?? DEFAULT_CONFIG.releaseVersion,
      source: "chorus-backend",
    };

    this.client.capture({
      distinctId: this.distinctId,
      event: "$exception",
      properties: {
        $exception_list: [errorData],
      },
    });
  }

  private captureLog(
    level: string,
    message: string,
    context?: Record<string, unknown>
  ): void {
    this.client.capture({
      distinctId: this.distinctId,
      event: "chorus_log",
      properties: {
        log_level: level,
        log_message: message,
        log_context: context,
        release: this.config.releaseVersion ?? DEFAULT_CONFIG.releaseVersion,
        source: "chorus-backend",
      },
    });
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown();
  }
}
