import { randomBytes, timingSafeEqual } from "node:crypto";
import { oauthProvider } from "@better-auth/oauth-provider";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { captcha, jwt } from "better-auth/plugins";
import { z } from "zod";
import type { RelayConfig } from "./config";

export const INTERNAL_AUTH_HEADER = "x-chorus-relay-internal";

/** Accounts authorize tunnel registration, never commands on a user workspace. */
export function createRelayAuth(
  database: BetterAuthOptions["database"],
  config: RelayConfig
) {
  const internalMarker = randomBytes(32).toString("hex");
  function internalRequest(headers: Headers): boolean {
    const candidate = Buffer.from(headers.get(INTERNAL_AUTH_HEADER) ?? "");
    const expected = Buffer.from(internalMarker);
    return (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    );
  }

  const auth = betterAuth({
    database,
    secret: config.authSecret,
    baseURL: config.accountOrigin,
    basePath: "/api/auth",
    trustedOrigins: [config.accountOrigin],
    disabledPaths: ["/token"],
    logger: { disabled: true },
    emailAndPassword: { enabled: false },
    account: { accountLinking: { enabled: false } },
    session: { expiresIn: 86_400 * 7, freshAge: 600 },
    advanced: {
      // Supply the __Host- name ourselves; Better Auth would otherwise prepend
      // __Secure-. The attributes below still REQUIRE secure, host-only cookies.
      useSecureCookies: false,
      cookiePrefix: "__Host-chorus-relay",
      defaultCookieAttributes: {
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
      ipAddress: { ipAddressHeaders: ["x-real-ip"] },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    socialProviders: {
      github: {
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
        scope: ["read:user", "user:email"],
      },
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => (user.emailVerified ? { data: user } : false),
        },
      },
    },
    plugins: [
      captcha({
        provider: "cloudflare-turnstile",
        secretKey: config.turnstileSecret,
        endpoints: ["/sign-in/social"],
        allowedHostnames: [new URL(config.accountOrigin).hostname],
        expectedAction: "relay-sign-in",
      }),
      jwt({
        disableSettingJwtHeader: true,
        jwks: {
          keyPairConfig: { alg: "RS256", modulusLength: 2048 },
          rotationInterval: 86_400 * 30,
          gracePeriod: 600,
        },
        jwt: { issuer: config.issuer },
      }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/",
        scopes: ["openid", "relay:connect"],
        grantTypes: ["client_credentials"],
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        accessTokenExpiresIn: 300,
        m2mAccessTokenExpiresIn: 300,
        resources: [
          {
            identifier: config.tunnelAudience,
            allowedScopes: ["relay:connect"],
            accessTokenTtl: 300,
          },
        ],
        enforcePerClientResources: true,
        clientPrivileges: ({ headers }) => internalRequest(headers),
        resourcePrivileges: ({ headers }) => internalRequest(headers),
        customAccessTokenClaims: ({ metadata }) => {
          const hostId = z.uuid().safeParse(metadata?.hostId);
          return hostId.success
            ? { host_id: hostId.data, token_kind: "relay_host" }
            : {};
        },
      }),
    ],
  });

  function administrativeHeaders(headers: Headers): Headers {
    const result = new Headers(headers);
    result.set(INTERNAL_AUTH_HEADER, internalMarker);
    return result;
  }

  return {
    auth,
    async createMachineClient(headers: Headers, hostId: string) {
      const result = await auth.api.adminCreateOAuthClient({
        headers: administrativeHeaders(headers),
        body: {
          client_name: `Chorus host ${z.uuid().parse(hostId)}`,
          grant_types: ["client_credentials"],
          client_credentials_scopes: ["relay:connect"],
          resources: [config.tunnelAudience],
          scope: "relay:connect",
          token_endpoint_auth_method: "client_secret_basic",
          metadata: { hostId },
        },
      });
      return z
        .object({
          client_id: z.string().min(1),
          client_secret: z.string().min(1),
        })
        .parse(result);
    },
    async disableMachineClient(headers: Headers, clientId: string) {
      await auth.api.adminUpdateOAuthClient({
        headers: administrativeHeaders(headers),
        body: { client_id: clientId, update: { disabled: true } },
      });
    },
  };
}

export type RelayAuth = ReturnType<typeof createRelayAuth>;
