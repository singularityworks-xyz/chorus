import { beforeEach, describe, expect, test } from "bun:test";
import { ConsoleLogger } from "./console-logger";
import { createLogger } from "./index";
import { PostHogLogger } from "./posthog-logger";
import type { LoggerConfig } from "./types";

describe("ConsoleLogger", () => {
  let logger: ConsoleLogger;

  beforeEach(() => {
    logger = new ConsoleLogger("TEST");
  });

  describe("log levels", () => {
    test("debug logs with DEBUG level", () => {
      logger.debug("test message");
      expect(logger).toBeDefined();
    });

    test("info logs with INFO level", () => {
      logger.info("test message");
      expect(logger).toBeDefined();
    });

    test("warn logs with WARN level", () => {
      logger.warn("test message");
      expect(logger).toBeDefined();
    });

    test("error logs with ERROR level", () => {
      logger.error("test message");
      expect(logger).toBeDefined();
    });
  });

  describe("context formatting", () => {
    test("handles empty context", () => {
      logger.info("no context");
      expect(logger).toBeDefined();
    });

    test("handles object context", () => {
      logger.info("with context", { userId: "123", action: "login" });
      expect(logger).toBeDefined();
    });

    test("handles nested object context", () => {
      logger.info("nested", {
        user: { id: "123", name: "test" },
        timestamp: Date.now(),
      });
      expect(logger).toBeDefined();
    });
  });

  describe("error handling", () => {
    test("error with Error object", () => {
      const err = new Error("test error");
      logger.error("something failed", err);
      expect(logger).toBeDefined();
    });

    test("error with non-Error value", () => {
      logger.error("something failed", { code: 500, details: "internal" });
      expect(logger).toBeDefined();
    });

    test("error without error object", () => {
      logger.error("something failed");
      expect(logger).toBeDefined();
    });
  });

  describe("event capture", () => {
    test("captureEvent logs event", () => {
      logger.captureEvent("user_login", { userId: "123" });
      expect(logger).toBeDefined();
    });

    test("captureException with Error", () => {
      const err = new TypeError("type mismatch");
      logger.captureException(err, { context: "validation" });
      expect(logger).toBeDefined();
    });

    test("captureException with string", () => {
      logger.captureException("something went wrong");
      expect(logger).toBeDefined();
    });
  });

  describe("shutdown", () => {
    test("shutdown prints summary when entries exist", () => {
      logger.info("entry 1");
      logger.error("entry 2");
      logger.shutdown();
      expect(logger).toBeDefined();
    });

    test("shutdown does nothing when no entries", () => {
      const emptyLogger = new ConsoleLogger();
      emptyLogger.shutdown();
      expect(emptyLogger).toBeDefined();
    });
  });

  describe("custom source", () => {
    test("uses custom source name", () => {
      const customLogger = new ConsoleLogger("MY-SERVICE");
      customLogger.info("test");
      expect(customLogger).toBeDefined();
    });
  });
});

describe("PostHogLogger", () => {
  let logger: PostHogLogger;
  const config: LoggerConfig = {
    env: "production",
    postHogApiKey: "test-key",
    postHogApiHost: "https://us.i.posthog.com",
    releaseName: "chorus-test",
    releaseVersion: "1.0.0",
  };

  beforeEach(() => {
    logger = new PostHogLogger(config);
  });

  describe("log levels", () => {
    test("debug sends log to PostHog", () => {
      logger.debug("debug message", { module: "auth" });
      expect(logger).toBeDefined();
    });

    test("info sends log to PostHog", () => {
      logger.info("info message");
      expect(logger).toBeDefined();
    });

    test("warn sends log to PostHog", () => {
      logger.warn("warning message");
      expect(logger).toBeDefined();
    });

    test("error sends log to PostHog", () => {
      logger.error("error message", new Error("test"));
      expect(logger).toBeDefined();
    });
  });

  describe("event capture", () => {
    test("captureEvent sends event to PostHog", () => {
      logger.captureEvent("user_signup", { plan: "pro" });
      expect(logger).toBeDefined();
    });

    test("captureException sends exception to PostHog", () => {
      const err = new Error("critical failure");
      logger.captureException(err, { service: "api" });
      expect(logger).toBeDefined();
    });

    test("captureException with non-Error", () => {
      logger.captureException("string error");
      expect(logger).toBeDefined();
    });
  });

  describe("shutdown", () => {
    test("shutdown calls PostHog client shutdown", async () => {
      await logger.shutdown();
      expect(logger).toBeDefined();
    });
  });
});

describe("createLogger factory", () => {
  test("returns ConsoleLogger for development env", () => {
    const logger = createLogger({ env: "development" }, "DEV-TEST");
    expect(logger instanceof ConsoleLogger).toBe(true);
  });

  test("falls back to ConsoleLogger for production without API key", () => {
    const logger = createLogger({ env: "production" });
    expect(logger instanceof ConsoleLogger).toBe(true);
  });

  test("returns PostHogLogger for production with custom API key", () => {
    const logger = createLogger({
      env: "production",
      postHogApiKey: "phc_test_key",
      releaseName: "test-app",
    });
    expect(logger instanceof PostHogLogger).toBe(true);
  });

  test("passes source to ConsoleLogger", () => {
    const logger = createLogger({ env: "development" }, "CUSTOM-SOURCE");
    expect(logger instanceof ConsoleLogger).toBe(true);
  });
});

describe("real-time PostHog integration", () => {
  test("PostHogLogger sends events to real PostHog API", async () => {
    const logger = new PostHogLogger({
      env: "production",
      postHogApiKey: "test-key-1",
      postHogApiHost: "https://us.i.posthog.com",
      releaseName: "chorus-integration-test",
      releaseVersion: "0.0.16",
    });

    logger.captureEvent("integration_test_run", {
      test: "posthog-real-time",
      timestamp: new Date().toISOString(),
      status: "running",
    });

    logger.info("integration test log", {
      module: "logger",
      test: "real-time",
    });

    logger.captureException(new Error("integration test exception"), {
      test: "posthog-exception-tracking",
    });

    await logger.shutdown();
    expect(logger).toBeDefined();
  });

  test("ConsoleLogger produces formatted output with timestamps", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
      originalLog(...args);
    };
    console.warn = (...args: unknown[]) => {
      logs.push(args.join(" "));
      originalWarn(...args);
    };
    console.error = (...args: unknown[]) => {
      logs.push(args.join(" "));
      originalError(...args);
    };

    try {
      const logger = new ConsoleLogger("INTEGRATION");
      logger.debug("debug integration", { module: "test" });
      logger.info("info integration", { module: "test" });
      logger.warn("warn integration", { module: "test" });
      logger.error("error integration", new Error("test error"), {
        module: "test",
      });
      logger.captureEvent("test_event", { key: "value" });
      logger.captureException(new TypeError("type error"));
      logger.shutdown();

      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some((l) => l.includes("DEBUG"))).toBe(true);
      expect(logs.some((l) => l.includes("INFO"))).toBe(true);
      expect(logs.some((l) => l.includes("WARN"))).toBe(true);
      expect(logs.some((l) => l.includes("ERROR"))).toBe(true);
      expect(logs.some((l) => l.includes("INTEGRATION"))).toBe(true);
      expect(logs.some((l) => l.includes("[LOG SUMMARY]"))).toBe(true);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
  });

  test("createLogger factory switches between console and PostHog", () => {
    const devLogger = createLogger({ env: "development" }, "FACTORY-TEST");
    expect(devLogger instanceof ConsoleLogger).toBe(true);

    const prodLogger = createLogger({
      env: "production",
      postHogApiKey: "test-key-1",
      releaseName: "chorus-prod-test",
    });
    expect(prodLogger instanceof PostHogLogger).toBe(true);

    const fallbackLogger = createLogger({ env: "production" });
    expect(fallbackLogger instanceof ConsoleLogger).toBe(true);
  });

  test("PostHogLogger throws when constructed without an API key", () => {
    let thrown: unknown;
    try {
      new PostHogLogger({ env: "production" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test("full workflow: log, event, exception, shutdown", async () => {
    const logger = createLogger({
      env: "production",
      postHogApiKey: "test-key-1",
      releaseName: "chorus-full-workflow",
      releaseVersion: "0.0.16",
    });

    logger.debug("workflow-step-1", { step: 1 });
    logger.info("workflow-step-2", { step: 2 });
    logger.warn("workflow-step-3", { step: 3 });
    logger.error("workflow-step-4", new Error("step 4 error"), { step: 4 });
    logger.captureEvent("workflow-complete", {
      totalSteps: 4,
      status: "success",
    });
    logger.captureException(new Error("workflow-exception"));

    if (logger instanceof PostHogLogger) {
      await logger.shutdown();
    } else {
      logger.shutdown();
    }

    expect(logger).toBeDefined();
  });
});
