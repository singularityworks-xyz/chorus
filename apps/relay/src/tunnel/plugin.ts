import { randomBytes } from "node:crypto";
import { Elysia } from "elysia";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { RelayConfig } from "../config";
import type { RelayRegistry } from "../registry";
import {
  authorizeProxy,
  authorizeTunnelGrant,
  tunnelGrantSchema,
} from "./policy";

const loginSchema = z
  .object({ privilege_key: z.string().min(1).max(16_384) })
  .passthrough();
const messageSchema = z
  .object({
    user: z.object({ run_id: z.string().min(1).max(128), user: z.string() }),
  })
  .passthrough();
const requestSchema = z.object({ content: z.record(z.string(), z.unknown()) });
const TOKEN_OPERATIONS = new Set(["Ping", "NewWorkConn"]);
const CONNECTION_OPERATIONS = new Set(["NewUserConn", "CloseProxy"]);

type PluginReply =
  | { reject: true; reject_reason: string }
  | { reject: false; unchange: boolean; content?: Record<string, unknown> };
function deny(reason: string): PluginReply {
  return { reject: true, reject_reason: reason };
}

export function createTunnelVerifier(config: RelayConfig) {
  const jwks = createRemoteJWKSet(new URL(`${config.issuer}/jwks`), {
    timeoutDuration: 5000,
    cooldownDuration: 30_000,
  });
  return async (token: string) => {
    const verified = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.tunnelAudience,
      algorithms: ["RS256"],
      typ: "at+jwt",
      requiredClaims: ["sub", "exp", "iat", "jti"],
      maxTokenAge: "5m",
      clockTolerance: 5,
    });
    return tunnelGrantSchema.parse(verified.payload);
  };
}

/** Dedicated loopback listener. Never expose through the public proxy. */
export function createFrpPlugin(
  registry: Pick<RelayRegistry, "findHost" | "admit" | "connection">,
  verifyToken: ReturnType<typeof createTunnelVerifier>
) {
  async function login(content: Record<string, unknown>): Promise<PluginReply> {
    const request = loginSchema.parse(content);
    const grant = await verifyToken(request.privilege_key);
    const row = await registry.findHost(grant.host_id);
    if (!row?.client_id) {
      return deny("host unavailable");
    }
    const host = {
      hostId: row.host_id,
      clientId: row.client_id,
      hostname: row.hostname,
      revoked: row.revoked,
    };
    if (!authorizeTunnelGrant(grant, host)) {
      return deny("host unavailable");
    }
    const runId = randomBytes(16).toString("hex");
    await registry.admit(host.hostId, runId);
    return {
      reject: false,
      unchange: false,
      content: { ...content, run_id: runId, user: host.hostId },
    };
  }

  async function connected(
    op: string,
    content: Record<string, unknown>
  ): Promise<PluginReply> {
    const message = messageSchema.parse(content);
    const host = await registry.connection(message.user.run_id, op === "Ping");
    if (!host || message.user.user !== host.hostId) {
      return deny("host unavailable");
    }
    if (op === "NewProxy") {
      if (!authorizeProxy(content, host)) {
        return deny("route denied");
      }
      return {
        reject: false,
        unchange: false,
        content: {
          ...content,
          bandwidth_limit: "10MB",
          bandwidth_limit_mode: "server",
          use_compression: false,
        },
      };
    }
    if (TOKEN_OPERATIONS.has(op)) {
      const grant = await verifyToken(
        z.string().min(1).max(16_384).parse(content.privilege_key)
      );
      return authorizeTunnelGrant(grant, host)
        ? { reject: false, unchange: true }
        : deny("host unavailable");
    }
    if (CONNECTION_OPERATIONS.has(op)) {
      const known =
        content.proxy_name === `${host.hostId}.https` ||
        content.proxy_name === `${host.hostId}.acme`;
      return known ? { reject: false, unchange: true } : deny("route denied");
    }
    return deny("operation denied");
  }

  return new Elysia({ serve: { maxRequestBodySize: 65_536 } }).post(
    "/frp",
    async ({ body, query }) => {
      try {
        if (query.version !== "0.1.0") {
          return deny("unsupported protocol version");
        }
        const { content } = requestSchema.parse(body);
        return await (query.op === "Login"
          ? login(content)
          : connected(query.op ?? "", content));
      } catch {
        // Signature, schema, dependency, and database failures all fail closed.
        // Never expose JWTs or arbitrary plugin payloads in error diagnostics.
        return deny("authorization unavailable");
      }
    }
  );
}
