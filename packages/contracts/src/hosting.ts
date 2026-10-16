import { z } from "zod";

export const hostIdSchema = z.uuid();
export const workspaceIdSchema = z.uuid();
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** Only the public portion of a host's P-256 signing identity crosses machines. */
export const hostPublicKeySchema = z.strictObject({
  crv: z.literal("P-256"),
  kty: z.literal("EC"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const hostIdentitySchema = z.strictObject({
  hostId: hostIdSchema,
  publicKey: hostPublicKeySchema,
});

export const hostConnectionStateSchema = z.enum([
  "disabled",
  "enrolling",
  "connecting",
  "securing",
  "ready",
  "reconnecting",
  "revoked",
  "error",
]);

export const workspaceAuthoritySchema = z.strictObject({
  epoch: z.number().int().nonnegative().safe(),
  hostId: hostIdSchema,
  workspaceId: workspaceIdSchema,
});

export const handoffPhaseSchema = z.enum([
  "preparing",
  "checkpointing",
  "verifying",
  "released",
  "active",
  "cancelled",
  "recovery_required",
]);

/** A source release authorizes one prepared checkpoint on one specific host. */
export const ownershipReleasePayloadSchema = z
  .strictObject({
    checkpointHash: sha256Schema,
    epoch: z.number().int().positive().safe(),
    sourceHostId: hostIdSchema,
    targetHostId: hostIdSchema,
    targetKeyHash: sha256Schema,
    transferId: z.uuid(),
    version: z.literal(1),
    workspaceId: workspaceIdSchema,
  })
  .refine((value) => value.sourceHostId !== value.targetHostId, {
    message: "a workspace must move to a different host",
  });

export const signedOwnershipReleaseSchema = z.strictObject({
  payload: ownershipReleasePayloadSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export const preparedCheckpointPayloadSchema = z.strictObject({
  checkpointHash: sha256Schema,
  epoch: z.number().int().positive().safe(),
  sourceHostId: hostIdSchema,
  targetHostId: hostIdSchema,
  transferId: z.uuid(),
  version: z.literal(1),
  workspaceId: workspaceIdSchema,
});

export const signedPreparedCheckpointSchema = z.strictObject({
  payload: preparedCheckpointPayloadSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export type HostIdentity = z.infer<typeof hostIdentitySchema>;
export type HostPublicKey = z.infer<typeof hostPublicKeySchema>;
export function serializeHostPublicKey(input: HostPublicKey): string {
  const key = hostPublicKeySchema.parse(input);
  return JSON.stringify([key.kty, key.crv, key.x, key.y]);
}
export type WorkspaceAuthority = z.infer<typeof workspaceAuthoritySchema>;
export type OwnershipReleasePayload = z.infer<
  typeof ownershipReleasePayloadSchema
>;
export type SignedOwnershipRelease = z.infer<
  typeof signedOwnershipReleaseSchema
>;
export type PreparedCheckpointPayload = z.infer<
  typeof preparedCheckpointPayloadSchema
>;
export type SignedPreparedCheckpoint = z.infer<
  typeof signedPreparedCheckpointSchema
>;
