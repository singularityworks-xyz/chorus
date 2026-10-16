import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import {
  type HostPublicKey,
  hostPublicKeySchema,
  type OwnershipReleasePayload,
  ownershipReleasePayloadSchema,
  type PreparedCheckpointPayload,
  preparedCheckpointPayloadSchema,
  type SignedOwnershipRelease,
  type SignedPreparedCheckpoint,
  serializeHostPublicKey,
  signedOwnershipReleaseSchema,
  signedPreparedCheckpointSchema,
} from "@chorus/contracts";

export function generateHostKey() {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = key.publicKey.export({ format: "jwk" });
  return {
    privateKey: key.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    publicKey: hostPublicKeySchema.parse({
      crv: jwk.crv,
      kty: jwk.kty,
      x: jwk.x,
      y: jwk.y,
    }),
  };
}

export function publicKeyHash(input: HostPublicKey): string {
  // Length/alphabet validation alone does not prove a point lies on P-256.
  createPublicKey({ format: "jwk", key: hostPublicKeySchema.parse(input) });
  return createHash("sha256")
    .update(serializeHostPublicKey(input))
    .digest("hex");
}

// Explicit fields plus a purpose label prevent property-order ambiguity and
// replaying a target's preparation signature as a source's ownership release.
function releaseBytes(input: OwnershipReleasePayload): Buffer {
  const value = ownershipReleasePayloadSchema.parse(input);
  return Buffer.from(
    JSON.stringify([
      "chorus:ownership-release:v1",
      value.workspaceId,
      value.transferId,
      value.epoch,
      value.sourceHostId,
      value.targetHostId,
      value.targetKeyHash,
      value.checkpointHash,
    ])
  );
}

function preparedBytes(input: PreparedCheckpointPayload): Buffer {
  const value = preparedCheckpointPayloadSchema.parse(input);
  return Buffer.from(
    JSON.stringify([
      "chorus:prepared-checkpoint:v1",
      value.workspaceId,
      value.transferId,
      value.epoch,
      value.sourceHostId,
      value.targetHostId,
      value.checkpointHash,
    ])
  );
}

function signBytes(bytes: Buffer, privateKey: string): string {
  return sign("sha256", bytes, {
    dsaEncoding: "ieee-p1363",
    key: createPrivateKey(privateKey),
  }).toString("base64url");
}

function verifyBytes(
  bytes: Buffer,
  signature: string,
  key: HostPublicKey
): boolean {
  try {
    return verify(
      "sha256",
      bytes,
      {
        dsaEncoding: "ieee-p1363",
        key: createPublicKey({
          format: "jwk",
          key: hostPublicKeySchema.parse(key),
        }),
      },
      Buffer.from(signature, "base64url")
    );
  } catch {
    return false;
  }
}

export function signOwnershipRelease(
  input: OwnershipReleasePayload,
  privateKey: string
): SignedOwnershipRelease {
  const payload = ownershipReleasePayloadSchema.parse(input);
  return { payload, signature: signBytes(releaseBytes(payload), privateKey) };
}

export function verifyOwnershipRelease(
  input: unknown,
  key: HostPublicKey
): boolean {
  const parsed = signedOwnershipReleaseSchema.safeParse(input);
  return (
    parsed.success &&
    verifyBytes(releaseBytes(parsed.data.payload), parsed.data.signature, key)
  );
}

export function signPreparedCheckpoint(
  input: PreparedCheckpointPayload,
  privateKey: string
): SignedPreparedCheckpoint {
  const payload = preparedCheckpointPayloadSchema.parse(input);
  return { payload, signature: signBytes(preparedBytes(payload), privateKey) };
}

export function verifyPreparedCheckpoint(
  input: unknown,
  key: HostPublicKey
): boolean {
  const parsed = signedPreparedCheckpointSchema.safeParse(input);
  return (
    parsed.success &&
    verifyBytes(preparedBytes(parsed.data.payload), parsed.data.signature, key)
  );
}
