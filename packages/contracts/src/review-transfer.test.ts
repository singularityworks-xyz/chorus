import { expect, test } from "bun:test";
import { reviewCheckpointSchema } from "./review-transfer";

test("review checkpoints enforce explicit unique roots and matching object format", () => {
  const value = {
    version: 1,
    objectFormat: "sha1",
    trees: ["a".repeat(40)],
    objects: { digest: "b".repeat(64), bytes: 42 },
  };
  expect(reviewCheckpointSchema.parse(value)).toEqual(value);
  for (const altered of [
    { ...value, trees: [] },
    { ...value, trees: ["--all"] },
    { ...value, trees: [value.trees[0], value.trees[0]] },
    { ...value, objectFormat: "sha256" },
    { ...value, credential: "not transferable" },
  ]) {
    expect(reviewCheckpointSchema.safeParse(altered).success).toBe(false);
  }
});
