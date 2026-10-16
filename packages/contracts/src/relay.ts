import { z } from "zod";
import {
  hostConnectionStateSchema,
  hostIdSchema,
  hostPublicKeySchema,
  sha256Schema,
} from "./hosting";

export const relayHttpsOriginSchema = z
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) {
      return false;
    }
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      !url.port
    );
  })
  .transform((value) => new URL(value).origin);

export const relayOperatorConfigSchema = z.strictObject({
  accountOrigin: relayHttpsOriginSchema,
  tunnelOrigin: relayHttpsOriginSchema,
  hostsDomain: z
    .string()
    .min(4)
    .max(200)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
});
export type RelayOperatorConfig = z.infer<typeof relayOperatorConfigSchema>;

/** The installation pins its operator; enrollment cannot redirect to another relay. */
export function validateRelayConnection(
  input: unknown,
  operator: RelayOperatorConfig,
  hostId: string
): RelayMachineConnection {
  const config = relayOperatorConfigSchema.parse(operator);
  const connection = relayMachineConnectionSchema.parse(input);
  const issuer = `${config.accountOrigin}/api/auth`;
  const hostname = `h-${hostIdSchema.parse(hostId).replaceAll("-", "")}.${config.hostsDomain}`;
  if (
    connection.hostId !== hostId ||
    connection.hostname !== hostname ||
    connection.issuer !== issuer ||
    connection.tokenEndpoint !== `${issuer}/oauth2/token` ||
    connection.audience !== `${config.accountOrigin}/tunnel` ||
    connection.serverUrl !== config.tunnelOrigin
  ) {
    throw new Error(
      "the connection does not belong to the configured Chorus relay"
    );
  }
  return connection;
}

export const relayEnrollmentRequestSchema = z.strictObject({
  hostId: hostIdSchema,
  label: z.string().trim().min(1).max(80),
  publicKey: hostPublicKeySchema,
});

export const relayEnrollmentChallengeSchema = z.strictObject({
  enrollmentId: z.uuid(),
  expiresAt: z.number().int().positive(),
  pollSecret: z.string().regex(/^[a-f0-9]{64}$/),
  verificationUrl: z.url(),
});

export const relayEnrollmentPollSchema = z.strictObject({
  enrollmentId: z.uuid(),
  pollSecret: z.string().regex(/^[a-f0-9]{64}$/),
});

export const relayMachineConnectionSchema = z.strictObject({
  audience: z.url(),
  clientId: z.string().min(1).max(256),
  clientSecret: z.string().min(1).max(4096),
  hostId: hostIdSchema,
  hostname: z.string().min(1).max(253),
  issuer: z.url(),
  serverUrl: z.url(),
  tokenEndpoint: z.url(),
});

export const relayEnrollmentPollResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({ status: z.literal("pending") }),
    z.strictObject({
      status: z.literal("approved"),
      connection: relayMachineConnectionSchema,
    }),
    z.strictObject({ status: z.literal("complete") }),
  ]
);

export type RelayEnrollmentRequest = z.infer<
  typeof relayEnrollmentRequestSchema
>;
export const relayHostListSchema = z.strictObject({
  hosts: z.array(
    z.strictObject({
      hostId: hostIdSchema,
      hostname: z
        .string()
        .regex(/^[a-z0-9.-]+$/)
        .max(253),
      label: z.string().min(1).max(80),
      online: z.boolean(),
    })
  ),
});
export const relayEnrollmentDescriptionSchema =
  relayEnrollmentRequestSchema.extend({
    enrollmentId: z.uuid(),
    status: z.enum(["pending", "approved", "complete", "cancelled"]),
    expiresAt: z.number().int().positive(),
  });
export type RelayMachineConnection = z.infer<
  typeof relayMachineConnectionSchema
>;

export const hostEnrollmentPublicChallengeSchema = z.strictObject({
  expiresAt: z.number().int().positive(),
  verificationUrl: z
    .url()
    .refine(
      (value) => URL.canParse(value) && new URL(value).protocol === "https:"
    ),
  hostId: hostIdSchema,
  keyFingerprint: sha256Schema,
});

export const hostConnectorStatusSchema = z.strictObject({
  state: hostConnectionStateSchema.extract([
    "disabled",
    "connecting",
    "securing",
    "ready",
    "reconnecting",
    "error",
  ]),
  error: z.enum(["connector_unavailable", "remote_unreachable"]).nullable(),
  publicOrigin: relayHttpsOriginSchema.nullable(),
});
export type HostConnectorStatus = z.infer<typeof hostConnectorStatusSchema>;

export const hostRemoteStatusSchema = z.strictObject({
  availability: z.enum([
    "unconfigured",
    "production_required",
    "available",
    "installation_error",
  ]),
  state: hostConnectionStateSchema,
  error: z
    .enum([
      "connector_unavailable",
      "remote_unreachable",
      "relay_unreachable",
      "relay_rejected",
      "enrollment_expired",
    ])
    .nullable(),
  publicOrigin: relayHttpsOriginSchema.nullable(),
  accountOrigin: relayHttpsOriginSchema.nullable(),
  enrolled: z.boolean(),
  challenge: hostEnrollmentPublicChallengeSchema.nullable(),
});
export type HostRemoteStatus = z.infer<typeof hostRemoteStatusSchema>;

export const hostEnrollmentBeginSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
});

export const hostRemoteEnabledSchema = z.strictObject({ enabled: z.boolean() });
