import { createLogger } from "@chorus/logger";

export const taskLogger = createLogger(
  { env: process.env.NODE_ENV === "production" ? "production" : "development" },
  "SERVE:TASKS"
);
