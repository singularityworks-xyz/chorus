import { relayOperatorConfigSchema } from "@chorus/contracts";
import { z } from "zod";

/** Parse failures intentionally omit raw environment values (which include credentials). */
export function loadRelayConfig(
  env: Record<string, string | undefined> = process.env
) {
  const schema = relayOperatorConfigSchema.extend({
    authSecret: z.string().min(32),
    databaseUrl: z
      .url()
      .refine(
        (value) =>
          value.startsWith("postgres:") || value.startsWith("postgresql:")
      ),
    githubClientId: z.string().min(1),
    githubClientSecret: z.string().min(1),
    googleClientId: z.string().min(1),
    googleClientSecret: z.string().min(1),
    maxOnlineHosts: z.coerce.number().int().min(1).max(1000),
    maxHostsPerAccount: z.coerce.number().int().min(1).max(20),
    turnstileSecret: z.string().min(1),
    turnstileSiteKey: z.string().min(1),
  });
  const parsed = schema.safeParse({
    accountOrigin: env.RELAY_ACCOUNT_ORIGIN,
    authSecret: env.RELAY_AUTH_SECRET,
    databaseUrl: env.RELAY_DATABASE_URL,
    githubClientId: env.RELAY_GITHUB_CLIENT_ID,
    githubClientSecret: env.RELAY_GITHUB_CLIENT_SECRET,
    googleClientId: env.RELAY_GOOGLE_CLIENT_ID,
    googleClientSecret: env.RELAY_GOOGLE_CLIENT_SECRET,
    hostsDomain: env.RELAY_HOSTS_DOMAIN,
    tunnelOrigin: env.RELAY_TUNNEL_ORIGIN,
    maxOnlineHosts: env.RELAY_MAX_ONLINE_HOSTS ?? 100,
    maxHostsPerAccount: env.RELAY_MAX_HOSTS_PER_ACCOUNT ?? 3,
    turnstileSecret: env.RELAY_TURNSTILE_SECRET,
    turnstileSiteKey: env.RELAY_TURNSTILE_SITE_KEY,
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid relay configuration: ${[...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].join(", ")}`
    );
  }
  const config = parsed.data;
  if (
    new URL(config.accountOrigin).hostname.endsWith(`.${config.hostsDomain}`) ||
    new URL(config.accountOrigin).hostname === config.hostsDomain
  ) {
    throw new Error(
      "Relay account and untrusted host origins must be isolated"
    );
  }
  return {
    ...config,
    issuer: `${config.accountOrigin}/api/auth`,
    tunnelAudience: `${config.accountOrigin}/tunnel`,
  };
}

export type RelayConfig = ReturnType<typeof loadRelayConfig>;
