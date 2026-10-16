import { describe, expect, test } from "bun:test";
import {
  hostIdentitySchema,
  ownershipReleasePayloadSchema,
  signedOwnershipReleaseSchema,
} from "./hosting";

const release = {
  checkpointHash: "a".repeat(64),
  epoch: 1,
  sourceHostId: crypto.randomUUID(),
  targetHostId: crypto.randomUUID(),
  targetKeyHash: "b".repeat(64),
  transferId: crypto.randomUUID(),
  version: 1,
  workspaceId: crypto.randomUUID(),
};

describe("host contracts", () => {
  test("rejects private key material and unrecognized authority fields", () => {
    expect(
      hostIdentitySchema.safeParse({
        hostId: crypto.randomUUID(),
        publicKey: {
          crv: "P-256",
          d: "private",
          kty: "EC",
          x: "A".repeat(43),
          y: "B".repeat(43),
        },
      }).success
    ).toBe(false);
    expect(
      ownershipReleasePayloadSchema.safeParse({ ...release, bypass: true })
        .success
    ).toBe(false);
  });

  test("round trips a release and rejects invalid identity/generation/digest", () => {
    const signed = { payload: release, signature: "A".repeat(86) };
    expect(signedOwnershipReleaseSchema.parse(signed)).toEqual(signed);
    for (const override of [
      { epoch: 0 },
      { epoch: Number.MAX_SAFE_INTEGER + 1 },
      { checkpointHash: "invalid" },
      { targetHostId: release.sourceHostId },
      { workspaceId: "../workspace" },
    ]) {
      expect(
        ownershipReleasePayloadSchema.safeParse({ ...release, ...override })
          .success
      ).toBe(false);
    }
  });
});
