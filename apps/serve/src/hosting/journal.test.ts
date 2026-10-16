import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { HostIdentity } from "@chorus/contracts";
import { HostAuthorityError, HostJournal } from "./journal";
import {
  generateHostKey,
  signPreparedCheckpoint,
  verifyOwnershipRelease,
} from "./signatures";

const roots: string[] = [];
const journals: HostJournal[] = [];
const hash = "a".repeat(64);

function host() {
  const keys = generateHostKey();
  const identity: HostIdentity = {
    hostId: crypto.randomUUID(),
    publicKey: keys.publicKey,
  };
  const root = mkdtempSync(join(tmpdir(), "chorus-authority-"));
  roots.push(root);
  const reopen = () => {
    const journal = new HostJournal(root, identity, keys.privateKey);
    journals.push(journal);
    return journal;
  };
  return { identity, keys, reopen, journal: reopen() };
}

function close(journal: HostJournal) {
  journal.close();
  journals.splice(journals.indexOf(journal), 1);
}

function pair() {
  const source = host();
  const target = host();
  source.journal.approvePeer(target.identity);
  target.journal.approvePeer(source.identity);
  const workspaceId = crypto.randomUUID();
  source.journal.claimLocal(workspaceId);
  return { source, target, workspaceId };
}

afterEach(() => {
  for (const journal of journals.splice(0)) {
    journal.close();
  }
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) {
      throw new Error(
        "refusing to clean up outside the test temporary directory"
      );
    }
    rmSync(root, { force: true, recursive: true });
  }
});

describe("host ownership journal", () => {
  test("requires both peer approval and a durable fence before release", () => {
    const { source, target, workspaceId } = pair();
    const transferId = crypto.randomUUID();
    expect(() =>
      source.journal.prepare(workspaceId, crypto.randomUUID(), transferId)
    ).toThrow(HostAuthorityError);
    source.journal.prepare(workspaceId, target.identity.hostId, transferId);
    const receipt = target.journal.stage(
      { hostId: source.identity.hostId, workspaceId, epoch: 0 },
      transferId,
      hash
    );
    expect(() => source.journal.release(receipt)).toThrow(HostAuthorityError);
    expect(() => target.journal.assertWritable(workspaceId)).toThrow(
      HostAuthorityError
    );
    expect(() => source.journal.assertWritable(workspaceId)).not.toThrow();
    source.journal.fence(workspaceId, transferId);
    expect(() => source.journal.assertWritable(workspaceId)).toThrow(
      HostAuthorityError
    );
    const release = source.journal.release(receipt);
    expect(verifyOwnershipRelease(release, source.identity.publicKey)).toBe(
      true
    );
    expect(source.journal.release(receipt)).toEqual(release);
    target.journal.activate(release);
    target.journal.activate(release);
    expect(() => target.journal.assertWritable(workspaceId)).not.toThrow();
    expect(() => source.journal.cancel(workspaceId, transferId)).toThrow(
      HostAuthorityError
    );
  });

  test("lost release acknowledgement cannot make the source writable after restart", () => {
    const { source, target, workspaceId } = pair();
    const transferId = crypto.randomUUID();
    source.journal.prepare(workspaceId, target.identity.hostId, transferId);
    const receipt = target.journal.stage(
      { hostId: source.identity.hostId, workspaceId, epoch: 0 },
      transferId,
      hash
    );
    source.journal.fence(workspaceId, transferId);
    const release = source.journal.release(receipt);
    close(source.journal);
    close(target.journal);
    const recoveredSource = source.reopen();
    const recoveredTarget = target.reopen();
    expect(recoveredSource.release(receipt)).toEqual(release);
    expect(recoveredSource.claimLocal(workspaceId).state).toBe("released");
    expect(() => recoveredSource.assertWritable(workspaceId)).toThrow(
      HostAuthorityError
    );
    expect(() => recoveredSource.cancel(workspaceId, transferId)).toThrow(
      HostAuthorityError
    );
    recoveredTarget.activate(release);
    expect(recoveredTarget.get(workspaceId)?.epoch).toBe(1);
  });

  test("a fence without a release survives restart and may be explicitly cancelled", () => {
    const { source, target, workspaceId } = pair();
    const transferId = crypto.randomUUID();
    source.journal.prepare(workspaceId, target.identity.hostId, transferId);
    source.journal.fence(workspaceId, transferId);
    close(source.journal);
    const recovered = source.reopen();
    expect(() => recovered.assertWritable(workspaceId)).toThrow(
      HostAuthorityError
    );
    recovered.cancel(workspaceId, transferId);
    recovered.assertWritable(workspaceId);
    expect(() =>
      recovered.prepare(workspaceId, target.identity.hostId, transferId)
    ).toThrow(HostAuthorityError);
  });

  test("rejects changed checkpoint, identity, generation, and forged signatures", () => {
    const { source, target, workspaceId } = pair();
    const transferId = crypto.randomUUID();
    source.journal.prepare(workspaceId, target.identity.hostId, transferId);
    const receipt = target.journal.stage(
      { hostId: source.identity.hostId, workspaceId, epoch: 0 },
      transferId,
      hash
    );
    source.journal.fence(workspaceId, transferId);
    expect(() =>
      source.journal.release({
        ...receipt,
        payload: { ...receipt.payload, checkpointHash: "b".repeat(64) },
      })
    ).toThrow(HostAuthorityError);
    const stranger = host();
    expect(() =>
      source.journal.release(
        signPreparedCheckpoint(receipt.payload, stranger.keys.privateKey)
      )
    ).toThrow(HostAuthorityError);
    expect(() =>
      source.journal.approvePeer({
        ...target.identity,
        publicKey: stranger.identity.publicKey,
      })
    ).toThrow(HostAuthorityError);
    const release = source.journal.release(receipt);
    expect(() =>
      target.journal.activate({
        ...release,
        payload: { ...release.payload, epoch: 2 },
      })
    ).toThrow(HostAuthorityError);
    expect(() =>
      target.journal.activate({
        ...release,
        payload: { ...release.payload, checkpointHash: "b".repeat(64) },
      })
    ).toThrow(HostAuthorityError);
    expect(target.journal.get(workspaceId)?.state).toBe("staged");
  });

  test("moves back with a higher generation and rejects the old release", () => {
    const { source, target, workspaceId } = pair();
    const firstId = crypto.randomUUID();
    source.journal.prepare(workspaceId, target.identity.hostId, firstId);
    const firstReceipt = target.journal.stage(
      { hostId: source.identity.hostId, workspaceId, epoch: 0 },
      firstId,
      hash
    );
    source.journal.fence(workspaceId, firstId);
    const firstRelease = source.journal.release(firstReceipt);
    target.journal.activate(firstRelease);

    const secondId = crypto.randomUUID();
    target.journal.prepare(workspaceId, source.identity.hostId, secondId);
    const secondReceipt = source.journal.stage(
      { hostId: target.identity.hostId, workspaceId, epoch: 1 },
      secondId,
      "b".repeat(64)
    );
    target.journal.fence(workspaceId, secondId);
    source.journal.activate(target.journal.release(secondReceipt));
    expect(source.journal.get(workspaceId)?.epoch).toBe(2);
    source.journal.assertWritable(workspaceId);
    expect(() => target.journal.assertWritable(workspaceId)).toThrow(
      HostAuthorityError
    );
    expect(() => target.journal.activate(firstRelease)).toThrow(
      HostAuthorityError
    );
  });

  test("blocks overlapping moves and an already-active destination", () => {
    const { source, target, workspaceId } = pair();
    const transferId = crypto.randomUUID();
    source.journal.prepare(workspaceId, target.identity.hostId, transferId);
    expect(() =>
      source.journal.prepare(
        workspaceId,
        target.identity.hostId,
        crypto.randomUUID()
      )
    ).toThrow(HostAuthorityError);
    target.journal.claimLocal(workspaceId);
    expect(() =>
      target.journal.stage(
        { hostId: source.identity.hostId, workspaceId, epoch: 0 },
        transferId,
        hash
      )
    ).toThrow(HostAuthorityError);
    expect(target.journal.get(workspaceId)?.state).toBe("active");
  });
});
