import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type HostIdentity,
  hostIdentitySchema,
  type SignedOwnershipRelease,
  type SignedPreparedCheckpoint,
  sha256Schema,
  signedOwnershipReleaseSchema,
  signedPreparedCheckpointSchema,
  type WorkspaceAuthority,
  workspaceAuthoritySchema,
  workspaceIdSchema,
} from "@chorus/contracts";
import { z } from "zod";
import {
  publicKeyHash,
  signOwnershipRelease,
  signPreparedCheckpoint,
  verifyOwnershipRelease,
  verifyPreparedCheckpoint,
} from "./signatures";

const recordSchema = z.strictObject({
  checkpointHash: sha256Schema.nullable(),
  epoch: z.number().int().nonnegative().safe(),
  peer: hostIdentitySchema.nullable(),
  receipt: signedPreparedCheckpointSchema.nullable(),
  release: signedOwnershipReleaseSchema.nullable(),
  state: z.enum(["active", "preparing", "fenced", "released", "staged"]),
  transferId: z.uuid().nullable(),
  workspaceId: workspaceIdSchema,
});

export type AuthorityRecord = z.infer<typeof recordSchema>;

export class HostAuthorityError extends Error {
  readonly code = "host_authority_conflict";

  constructor(message: string) {
    super(message);
    this.name = "HostAuthorityError";
  }
}

/**
 * Local durable ownership journal; never replicated to the central relay.
 *
 * The caller owns engine quiescence and verified checkpoint storage. A target
 * receipt must only be issued AFTER its checkpoint is durable. `fence` must run
 * inside the source store's drained execution barrier. There are deliberately
 * no time-based ownership transitions. This journal supports a trusted pair of
 * hosts; expanding a workspace to a third host requires an authority chain.
 */
export class HostJournal {
  readonly #db: Database;
  readonly #identity: HostIdentity;
  readonly #privateKey: string;

  constructor(directory: string, identity: HostIdentity, privateKey: string) {
    this.#identity = hostIdentitySchema.parse(identity);
    this.#privateKey = privateKey;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, "host-control.db");
    this.#db = new Database(filename, { create: true });
    chmodSync(filename, 0o600);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peers (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS authority (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
    `);
    try {
      this.#db
        .transaction(() => {
          const existing = this.#db
            .query<{ body: string }, []>("SELECT body FROM identity WHERE id=1")
            .get();
          if (existing) {
            const prior = hostIdentitySchema.parse(JSON.parse(existing.body));
            if (
              prior.hostId !== identity.hostId ||
              publicKeyHash(prior.publicKey) !==
                publicKeyHash(identity.publicKey)
            ) {
              throw new HostAuthorityError(
                "the journal belongs to another host identity"
              );
            }
          } else {
            this.#db
              .query("INSERT INTO identity VALUES (1, ?)")
              .run(JSON.stringify(this.#identity));
          }
        })
        .immediate();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  /** Only an authenticated, explicit approval on this host may call this. */
  approvePeer(input: HostIdentity): void {
    const peer = hostIdentitySchema.parse(input);
    if (peer.hostId === this.#identity.hostId) {
      throw new HostAuthorityError(
        "a host cannot approve itself as a destination"
      );
    }
    this.#db
      .transaction(() => {
        const existing = this.#peer(peer.hostId);
        if (
          existing &&
          publicKeyHash(existing.publicKey) !== publicKeyHash(peer.publicKey)
        ) {
          throw new HostAuthorityError("the approved host key has changed");
        }
        this.#db
          .query("INSERT OR IGNORE INTO peers VALUES (?, ?)")
          .run(peer.hostId, JSON.stringify(peer));
      })
      .immediate();
  }

  claimLocal(workspaceId: string): AuthorityRecord {
    workspaceIdSchema.parse(workspaceId);
    return this.#db
      .transaction(() => {
        const current = this.get(workspaceId);
        if (current) {
          return current;
        }
        const record: AuthorityRecord = {
          checkpointHash: null,
          epoch: 0,
          peer: null,
          receipt: null,
          release: null,
          state: "active",
          transferId: null,
          workspaceId,
        };
        this.#save(record);
        return record;
      })
      .immediate();
  }

  get(workspaceId: string): AuthorityRecord | null {
    const row = this.#db
      .query<{ body: string }, [string]>(
        "SELECT body FROM authority WHERE id=?"
      )
      .get(workspaceId);
    return row ? recordSchema.parse(JSON.parse(row.body)) : null;
  }

  assertWritable(workspaceId: string): void {
    const state = this.get(workspaceId)?.state;
    if (state !== "active" && state !== "preparing") {
      throw new HostAuthorityError(
        "this host does not own writable workspace state"
      );
    }
  }

  prepare(
    workspaceId: string,
    peerId: string,
    transferId: string
  ): AuthorityRecord {
    z.uuid().parse(transferId);
    return this.#db
      .transaction(() => {
        const current = this.#require(workspaceId);
        if (
          current.state === "preparing" &&
          current.transferId === transferId &&
          current.peer?.hostId === peerId
        ) {
          return current;
        }
        if (current.state !== "active") {
          throw new HostAuthorityError(
            "a move is already in progress or this host is passive"
          );
        }
        const peer = this.#requirePeer(peerId);
        this.#reserve(transferId, workspaceId);
        const record: AuthorityRecord = {
          ...current,
          checkpointHash: null,
          peer,
          receipt: null,
          release: null,
          state: "preparing",
          transferId,
        };
        this.#save(record);
        return record;
      })
      .immediate();
  }

  /** Call only after engines are stopped and queued workspace writes drained. */
  fence(workspaceId: string, transferId: string): void {
    this.#db
      .transaction(() => {
        const current = this.#requireTransfer(workspaceId, transferId);
        if (current.state === "fenced") {
          return;
        }
        if (current.state !== "preparing") {
          throw new HostAuthorityError("only a prepared source can be fenced");
        }
        this.#save({ ...current, state: "fenced" });
      })
      .immediate();
  }

  /** Receives a checkpoint already durably staged and verified by its importer. */
  stage(
    authorityInput: WorkspaceAuthority,
    transferId: string,
    checkpointHash: string
  ): SignedPreparedCheckpoint {
    const authority = workspaceAuthoritySchema.parse(authorityInput);
    z.uuid().parse(transferId);
    sha256Schema.parse(checkpointHash);
    return this.#db
      .transaction(() => {
        const peer = this.#requirePeer(authority.hostId);
        const current = this.get(authority.workspaceId);
        if (
          current?.state === "staged" &&
          current.transferId === transferId &&
          current.checkpointHash === checkpointHash &&
          current.peer?.hostId === authority.hostId &&
          current.epoch === authority.epoch + 1 &&
          current.receipt
        ) {
          return current.receipt;
        }
        if (
          current &&
          !(
            current.state === "released" &&
            current.release?.payload.targetHostId === authority.hostId &&
            current.release.payload.epoch === authority.epoch
          )
        ) {
          throw new HostAuthorityError(
            "the destination has conflicting workspace ownership"
          );
        }
        this.#reserve(transferId, authority.workspaceId);
        const receipt = signPreparedCheckpoint(
          {
            checkpointHash,
            epoch: authority.epoch + 1,
            sourceHostId: authority.hostId,
            targetHostId: this.#identity.hostId,
            transferId,
            version: 1,
            workspaceId: authority.workspaceId,
          },
          this.#privateKey
        );
        if (!verifyPreparedCheckpoint(receipt, this.#identity.publicKey)) {
          throw new HostAuthorityError(
            "the signing key does not match this host identity"
          );
        }
        this.#save({
          checkpointHash,
          epoch: receipt.payload.epoch,
          peer,
          receipt,
          release: null,
          state: "staged",
          transferId,
          workspaceId: authority.workspaceId,
        });
        return receipt;
      })
      .immediate();
  }

  release(input: SignedPreparedCheckpoint): SignedOwnershipRelease {
    const receipt = signedPreparedCheckpointSchema.parse(input);
    return this.#db
      .transaction(() => {
        const current = this.#requireTransfer(
          receipt.payload.workspaceId,
          receipt.payload.transferId
        );
        const peer = current.peer;
        if (
          !(peer && verifyPreparedCheckpoint(receipt, peer.publicKey)) ||
          receipt.payload.sourceHostId !== this.#identity.hostId ||
          receipt.payload.targetHostId !== peer.hostId ||
          receipt.payload.epoch !== current.epoch + 1
        ) {
          throw new HostAuthorityError(
            "the checkpoint receipt does not match this move"
          );
        }
        if (
          current.state === "released" &&
          current.release?.payload.checkpointHash ===
            receipt.payload.checkpointHash
        ) {
          return current.release;
        }
        if (current.state !== "fenced") {
          throw new HostAuthorityError(
            "ownership cannot be released before durable fencing"
          );
        }
        const release = signOwnershipRelease(
          {
            ...receipt.payload,
            targetKeyHash: publicKeyHash(peer.publicKey),
          },
          this.#privateKey
        );
        if (!verifyOwnershipRelease(release, this.#identity.publicKey)) {
          throw new HostAuthorityError(
            "the signing key does not match this host identity"
          );
        }
        // Persist the fence AND signed release before returning anything to send.
        this.#save({
          ...current,
          checkpointHash: receipt.payload.checkpointHash,
          receipt,
          release,
          state: "released",
        });
        return release;
      })
      .immediate();
  }

  activate(input: SignedOwnershipRelease): void {
    const release = signedOwnershipReleaseSchema.parse(input);
    this.#db
      .transaction(() => {
        const payload = release.payload;
        const current = this.#requireTransfer(
          payload.workspaceId,
          payload.transferId
        );
        if (
          !(
            current.peer &&
            verifyOwnershipRelease(release, current.peer.publicKey)
          ) ||
          payload.sourceHostId !== current.peer.hostId ||
          payload.targetHostId !== this.#identity.hostId ||
          payload.targetKeyHash !== publicKeyHash(this.#identity.publicKey) ||
          payload.epoch !== current.epoch ||
          payload.checkpointHash !== current.checkpointHash
        ) {
          throw new HostAuthorityError(
            "the ownership release does not match this staged checkpoint"
          );
        }
        if (current.state === "active" && current.release) {
          return;
        }
        if (current.state !== "staged") {
          throw new HostAuthorityError(
            "this checkpoint is not staged for activation"
          );
        }
        this.#save({ ...current, release, state: "active" });
      })
      .immediate();
  }

  cancel(workspaceId: string, transferId: string): void {
    this.#db
      .transaction(() => {
        const current = this.#requireTransfer(workspaceId, transferId);
        if (current.state !== "preparing" && current.state !== "fenced") {
          throw new HostAuthorityError(
            "a signed release cannot be cancelled; recover or move ownership back"
          );
        }
        this.#save({
          ...current,
          checkpointHash: null,
          peer: null,
          receipt: null,
          release: null,
          state: "active",
          transferId: null,
        });
      })
      .immediate();
  }

  #peer(id: string): HostIdentity | null {
    const row = this.#db
      .query<{ body: string }, [string]>("SELECT body FROM peers WHERE id=?")
      .get(id);
    return row ? hostIdentitySchema.parse(JSON.parse(row.body)) : null;
  }

  #requirePeer(id: string): HostIdentity {
    const peer = this.#peer(id);
    if (!peer) {
      throw new HostAuthorityError("the other host has not been approved here");
    }
    return peer;
  }

  #require(id: string): AuthorityRecord {
    const record = this.get(id);
    if (!record) {
      throw new HostAuthorityError(
        "workspace ownership has not been established"
      );
    }
    return record;
  }

  #requireTransfer(id: string, transferId: string): AuthorityRecord {
    const record = this.#require(id);
    if (record.transferId !== transferId) {
      throw new HostAuthorityError("the transfer is not current");
    }
    return record;
  }

  #reserve(transferId: string, workspaceId: string): void {
    const existing = this.#db
      .query("SELECT 1 FROM transfers WHERE id=?")
      .get(transferId);
    if (existing) {
      throw new HostAuthorityError("a transfer identity cannot be reused");
    }
    this.#db
      .query("INSERT INTO transfers VALUES (?, ?)")
      .run(transferId, workspaceId);
  }

  #save(record: AuthorityRecord): void {
    const parsed = recordSchema.parse(record);
    this.#db
      .query(
        "INSERT INTO authority VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body"
      )
      .run(parsed.workspaceId, JSON.stringify(parsed));
  }
}
