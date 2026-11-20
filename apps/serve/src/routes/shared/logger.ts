import { createLogger } from "@chorus/logger";

export const routeLogger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "ROUTES"
);
