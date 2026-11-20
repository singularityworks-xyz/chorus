export interface CorsPolicy {
  allowedOrigins: string[];
  isProduction: boolean;
}

export interface CorsEnvironment {
  corsAllowedOrigins?: string | undefined;
  isProduction: boolean;
}

const DEFAULT_LOCAL_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
];

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export class CorsMisconfigurationError extends Error {
  constructor() {
    super(
      "CORS_ALLOWED_ORIGINS must not be set in production: production is same-origin only. Remove it from the environment."
    );
    this.name = "CorsMisconfigurationError";
  }
}

export function resolveCorsPolicy(env: CorsEnvironment): CorsPolicy {
  const parsed = parseAllowedOrigins(env.corsAllowedOrigins);
  let allowedOrigins = parsed;

  if (env.isProduction && parsed.length > 0) {
    throw new CorsMisconfigurationError();
  }

  if (
    parsed.length === 0 &&
    env.corsAllowedOrigins === undefined &&
    !env.isProduction
  ) {
    allowedOrigins = DEFAULT_LOCAL_ORIGINS;
  }

  return {
    allowedOrigins,
    isProduction: env.isProduction,
  };
}

export function corsOptionsFor(policy: CorsPolicy) {
  if (policy.isProduction || policy.allowedOrigins.length === 0) {
    return undefined;
  }

  return {
    origin: policy.allowedOrigins,

    credentials: true,
    maxAge: 86_400,
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
  };
}
