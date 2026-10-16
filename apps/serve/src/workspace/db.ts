import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * SQLite layer for the Chorus event log (spec §5).
 *
 * The log is the source of truth: `events` is append-only and sequenced,
 * `snapshots` holds periodic full-state blobs so boot does not have to replay
 * forever, `meta` carries the sequence head plus mutation-idempotency keys, and
 * `push_subs` is wired here now so Phase 7 does not need a schema change.
 *
 * Nothing in this module interprets workspace state. It moves rows in and out;
 * deciding what an event *means* is the store's and projector's job.
 */

export const CHORUS_DB_FILENAME = "chorus.db";

export const HEAD_SEQ_KEY = "head_seq";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq      INTEGER PRIMARY KEY,
  ts       INTEGER NOT NULL,
  board_id TEXT,
  type     TEXT NOT NULL,
  payload  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_board_idx ON events(board_id);
CREATE INDEX IF NOT EXISTS events_type_idx  ON events(type);
CREATE INDEX IF NOT EXISTS events_ts_idx    ON events(ts);

CREATE TABLE IF NOT EXISTS snapshots (
  seq  INTEGER PRIMARY KEY,
  ts   INTEGER NOT NULL,
  blob TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint      TEXT PRIMARY KEY,
  keys          TEXT NOT NULL,
  device_id     TEXT,
  created_at    INTEGER,
  updated_at    INTEGER,
  expiration_at INTEGER,
  key_id        TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_receipts (
  receipt_id  TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_receipts_time_idx
  ON agent_receipts(received_at);
`;

export interface StoredEvent {
  boardId: string | null;
  payload: string;
  seq: number;
  ts: number;
  type: string;
}

export interface StoredSnapshot {
  blob: string;
  seq: number;
  ts: number;
}

/** Rows to append in one atomic commit. `seq` must be contiguous from the head. */
export interface EventToAppend {
  boardId: string | null;
  payload: string;
  ts: number;
  type: string;
}

export interface MetaChange {
  key: string;
  value: string | null;
}

export interface StoredPushSubscription {
  createdAt: number | null;
  deviceId: string | null;
  endpoint: string;
  expirationAt: number | null;
  keyId: string | null;
  keys: string;
  updatedAt: number | null;
}

export interface PushSubscriptionRow {
  createdAt: number;
  deviceId: string;
  endpoint: string;
  expirationAt: number | null;
  keyId: string;
  keys: string;
  updatedAt: number;
}

interface PushSubscriptionSqlRow {
  created_at: number | null;
  device_id: string | null;
  endpoint: string;
  expiration_at: number | null;
  key_id: string | null;
  keys: string;
  updated_at: number | null;
}

function migratePushSubscriptions(db: Database): void {
  const columns = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(push_subs)")
      .all()
      .map((column) => column.name)
  );
  const additions: [string, string][] = [
    ["device_id", "TEXT"],
    ["updated_at", "INTEGER"],
    ["expiration_at", "INTEGER"],
    ["key_id", "TEXT"],
  ];
  for (const [name, type] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE push_subs ADD COLUMN ${name} ${type}`);
    }
  }
}

export function resolveDbPath(dataDir: string): string {
  return join(dataDir, CHORUS_DB_FILENAME);
}

/**
 * Opens (creating if needed) the Chorus database.
 *
 * `chorus.db` holds the entire application state, so it is chmod'd to 0600 —
 * world-readable workspace state would leak every repo path the operator has
 * open. WAL plus `synchronous=NORMAL` is the spec's durability/throughput
 * trade-off: a crash can lose the most recent commits, never acknowledged ones.
 */
export function openChorusDatabase(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = resolveDbPath(dataDir);

  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migratePushSubscriptions(db);

  chmodSync(dbPath, 0o600);

  return db;
}

export class ChorusDatabase {
  readonly dataDir: string;
  readonly path: string;
  readonly #db: Database;
  #closed = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.path = resolveDbPath(dataDir);
    this.#db = openChorusDatabase(dataDir);
  }

  // ── meta ──────────────────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.#db
      .query<{ value: string }, [string]>(
        "SELECT value FROM meta WHERE key = ?"
      )
      .get(key);
    return row?.value ?? null;
  }

  hasAgentReceipt(receiptId: string): boolean {
    return (
      this.#db
        .query<{ present: number }, [string]>(
          "SELECT 1 AS present FROM agent_receipts WHERE receipt_id = ?"
        )
        .get(receiptId)?.present === 1
    );
  }

  pruneAgentReceipts(before: number, maxRows: number): void {
    this.#db
      .query("DELETE FROM agent_receipts WHERE received_at < ?")
      .run(before);
    this.#db
      .query(
        `DELETE FROM agent_receipts WHERE receipt_id IN (
          SELECT receipt_id FROM agent_receipts
          ORDER BY received_at DESC, receipt_id DESC
          LIMIT -1 OFFSET ?
        )`
      )
      .run(maxRows);
  }

  setMeta(key: string, value: string): void {
    this.#db
      .query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  writeMetaChanges(changes: MetaChange[]): void {
    if (changes.length === 0) {
      return;
    }
    this.#db
      .transaction(() => {
        for (const change of changes) {
          if (change.value === null) {
            this.deleteMeta(change.key);
          } else {
            this.setMeta(change.key, change.value);
          }
        }
      })
      .immediate();
  }

  upsertPushSubscription(
    subscription: PushSubscriptionRow,
    maxPerDevice = 4
  ): "stored" | "owned-by-another-device" | "limit-reached" {
    return this.#db
      .transaction(() => {
        const current = this.#db
          .query<{ device_id: string | null }, [string]>(
            "SELECT device_id FROM push_subs WHERE endpoint = ?"
          )
          .get(subscription.endpoint);
        if (current?.device_id && current.device_id !== subscription.deviceId) {
          return "owned-by-another-device" as const;
        }
        if (!current) {
          const count =
            this.#db
              .query<{ total: number }, [string]>(
                "SELECT COUNT(*) AS total FROM push_subs WHERE device_id = ?"
              )
              .get(subscription.deviceId)?.total ?? 0;
          if (count >= maxPerDevice) {
            return "limit-reached" as const;
          }
        }

        this.#db
          .query(
            `INSERT INTO push_subs
              (endpoint, keys, device_id, created_at, updated_at, expiration_at, key_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(endpoint) DO UPDATE SET
               keys = excluded.keys,
               device_id = excluded.device_id,
               updated_at = CASE
                 WHEN push_subs.keys = excluded.keys
                  AND push_subs.device_id = excluded.device_id
                  AND push_subs.key_id = excluded.key_id
                 THEN push_subs.updated_at ELSE excluded.updated_at END,
               expiration_at = excluded.expiration_at,
               key_id = excluded.key_id`
          )
          .run(
            subscription.endpoint,
            subscription.keys,
            subscription.deviceId,
            subscription.createdAt,
            subscription.updatedAt,
            subscription.expirationAt,
            subscription.keyId
          );
        return "stored" as const;
      })
      .immediate();
  }

  listPushSubscriptions(deviceId?: string): StoredPushSubscription[] {
    const rows = deviceId
      ? this.#db
          .query<PushSubscriptionSqlRow, [string]>(
            `SELECT endpoint, keys, device_id, created_at, updated_at, expiration_at, key_id
             FROM push_subs WHERE device_id = ? ORDER BY created_at ASC`
          )
          .all(deviceId)
      : this.#db
          .query<PushSubscriptionSqlRow, []>(
            `SELECT endpoint, keys, device_id, created_at, updated_at, expiration_at, key_id
             FROM push_subs ORDER BY created_at ASC`
          )
          .all();
    return rows.map((row) => ({
      createdAt: row.created_at,
      deviceId: row.device_id,
      endpoint: row.endpoint,
      expirationAt: row.expiration_at,
      keyId: row.key_id,
      keys: row.keys,
      updatedAt: row.updated_at,
    }));
  }

  pushSubscription(endpoint: string): StoredPushSubscription | null {
    const row = this.#db
      .query<PushSubscriptionSqlRow, [string]>(
        `SELECT endpoint, keys, device_id, created_at, updated_at, expiration_at, key_id
         FROM push_subs WHERE endpoint = ?`
      )
      .get(endpoint);
    return row
      ? {
          createdAt: row.created_at,
          deviceId: row.device_id,
          endpoint: row.endpoint,
          expirationAt: row.expiration_at,
          keyId: row.key_id,
          keys: row.keys,
          updatedAt: row.updated_at,
        }
      : null;
  }

  deletePushSubscription(endpoint: string, deviceId?: string): boolean {
    const result = deviceId
      ? this.#db
          .query("DELETE FROM push_subs WHERE endpoint = ? AND device_id = ?")
          .run(endpoint, deviceId)
      : this.#db
          .query("DELETE FROM push_subs WHERE endpoint = ?")
          .run(endpoint);
    return result.changes > 0;
  }

  deletePushSubscriptionIfMatches(
    subscription: StoredPushSubscription
  ): boolean {
    const result = this.#db
      .query(
        `DELETE FROM push_subs
         WHERE endpoint = ? AND device_id = ? AND key_id IS ?
           AND keys = ? AND updated_at IS ?`
      )
      .run(
        subscription.endpoint,
        subscription.deviceId,
        subscription.keyId,
        subscription.keys,
        subscription.updatedAt
      );
    return result.changes > 0;
  }

  deleteDevicePushSubscriptions(deviceId: string): number {
    const result = this.#db
      .query("DELETE FROM push_subs WHERE device_id = ?")
      .run(deviceId);
    return result.changes;
  }

  deleteMeta(key: string): void {
    this.#db.query("DELETE FROM meta WHERE key = ?").run(key);
  }

  /**
   * Every `key`/`value` pair under a prefix.
   *
   * Backs the WS-ticket janitor: `pruneMutationIds` only sweeps `mut:`, so
   * nothing else clears the `wst:` rows a client leaves behind when it fetches
   * a ticket and never upgrades.
   */
  entriesWithPrefix(prefix: string): [string, string][] {
    const rows = this.#db
      .query<{ key: string; value: string }, [string]>(
        "SELECT key, value FROM meta WHERE key LIKE ? ESCAPE '\\'"
      )
      .all(`${prefix.replace(/[\\%_]/g, "\\$&")}%`);
    return rows.map((row) => [row.key, row.value]);
  }

  /** Highest sequence ever appended. Survives event pruning (meta is the truth). */
  headSeq(): number {
    const raw = this.getMeta(HEAD_SEQ_KEY);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  /**
   * Drops mutation-idempotency keys older than the window. Runs at boot so the
   * table cannot grow without bound; 24 h comfortably covers client retries
   * after a phone sleeps.
   */
  pruneMutationIds(olderThan: number): number {
    const result = this.#db
      .query(
        "DELETE FROM meta WHERE key LIKE 'mut:%' AND CAST(value AS INTEGER) < ?"
      )
      .run(olderThan);
    return result.changes;
  }

  mutationIdSeen(mutationId: string): boolean {
    const row = this.#db
      .query<{ value: string }, [string]>(
        "SELECT value FROM meta WHERE key = ?"
      )
      .get(`mut:${mutationId}`);
    return row !== null && row !== undefined;
  }

  // ── events ────────────────────────────────────────────────────────────────

  /**
   * Appends events and advances the head atomically.
   *
   * Runs in an IMMEDIATE transaction so the write lock is taken up front: a
   * deferred transaction that upgrades later can fail with SQLITE_BUSY after
   * having done partial work. The head advance and any idempotency key land in
   * the same commit, so a crash cannot produce a committed event the store
   * believes is un-applied (or the reverse).
   */
  appendEvents(
    events: EventToAppend[],
    mutationKey: { id: string; ts: number } | null,
    metaChanges: MetaChange[] = [],
    agentReceipt?: { id: string; ts: number }
  ): { firstSeq: number; lastSeq: number } {
    if (events.length === 0 && !agentReceipt) {
      const head = this.headSeq();
      return { firstSeq: head + 1, lastSeq: head };
    }

    return this.#db
      .transaction(() => {
        let seq = this.headSeq();

        if (agentReceipt) {
          this.#db
            .query(
              "INSERT INTO agent_receipts (receipt_id, received_at) VALUES (?, ?)"
            )
            .run(agentReceipt.id, agentReceipt.ts);
        }

        for (const event of events) {
          seq += 1;
          this.#db
            .query(
              "INSERT INTO events (seq, ts, board_id, type, payload) VALUES (?, ?, ?, ?, ?)"
            )
            .run(seq, event.ts, event.boardId, event.type, event.payload);
        }

        this.setMeta(HEAD_SEQ_KEY, String(seq));

        if (mutationKey) {
          this.setMeta(`mut:${mutationKey.id}`, String(mutationKey.ts));
        }

        for (const change of metaChanges) {
          if (change.value === null) {
            this.deleteMeta(change.key);
          } else {
            this.setMeta(change.key, change.value);
          }
        }

        return events.length === 0
          ? { firstSeq: seq + 1, lastSeq: seq }
          : { firstSeq: seq - events.length + 1, lastSeq: seq };
      })
      .immediate();
  }

  /**
   * Appends a batch that deliberately fails mid-transaction.
   *
   * Exists so the rollback guarantee can be asserted rather than assumed: the
   * store's commit-then-swap invariant only holds if a thrown transaction
   * leaves zero rows behind. Every other append path is `appendEvents`.
   */
  appendFailingBatch(events: EventToAppend[]): void {
    this.#db
      .transaction(() => {
        let seq = this.headSeq();
        for (const event of events) {
          seq += 1;
          this.#db
            .query(
              "INSERT INTO events (seq, ts, board_id, type, payload) VALUES (?, ?, ?, ?, ?)"
            )
            .run(seq, event.ts, event.boardId, event.type, event.payload);
        }
        throw new Error("injected commit failure");
      })
      .immediate();
  }

  /** Events strictly after `seq`, oldest first. */
  readEventsSince(seq: number, limit = Number.MAX_SAFE_INTEGER): StoredEvent[] {
    const rows = this.#db
      .query<
        {
          board_id: string | null;
          payload: string;
          seq: number;
          ts: number;
          type: string;
        },
        [number, number]
      >(
        "SELECT seq, ts, board_id, type, payload FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?"
      )
      .all(seq, limit);

    // SQLite hands back column names verbatim; the store consumes camelCase.
    return rows.map((row) => ({
      boardId: row.board_id,
      payload: row.payload,
      seq: row.seq,
      ts: row.ts,
      type: row.type,
    }));
  }

  eventCount(): number {
    return (
      this.#db
        .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events")
        .get()?.c ?? 0
    );
  }

  // ── snapshots ─────────────────────────────────────────────────────────────

  latestSnapshot(): StoredSnapshot | null {
    const row = this.#db
      .query<{ blob: string; seq: number; ts: number }, []>(
        "SELECT seq, ts, blob FROM snapshots ORDER BY seq DESC LIMIT 1"
      )
      .get();
    return row ?? null;
  }

  writeSnapshot(seq: number, ts: number, blob: string): void {
    this.#db
      .query(
        "INSERT OR REPLACE INTO snapshots (seq, ts, blob) VALUES (?, ?, ?)"
      )
      .run(seq, ts, blob);
  }

  /** Drops events already folded into a snapshot. Snapshots are the new floor. */
  pruneEventsBefore(seq: number): number {
    const result = this.#db
      .query("DELETE FROM events WHERE seq < ? AND seq < ?")
      .run(seq, seq);
    return result.changes;
  }

  // ── maintenance ───────────────────────────────────────────────────────────

  /**
   * Folds the WAL back into the main database file so a cold copy of
   * `chorus.db` is always a complete backup. Runs after the final snapshot on
   * shutdown (spec §5).
   */
  checkpointTruncate(): void {
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  integrityCheck(): string {
    const row = this.#db
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get();
    return row?.integrity_check ?? "unknown";
  }

  dbSizeBytes(): number {
    const row = this.#db
      .query<{ page_count: number; page_size: number }, []>(
        "SELECT page_count, page_size FROM pragma_page_count(), pragma_page_size()"
      )
      .get();
    return (row?.page_count ?? 0) * (row?.page_size ?? 0);
  }

  /**
   * Writes a compacted copy via VACUUM INTO (spec §5 export path).
   *
   * The destination is bound, not interpolated. SQLite's `exec()` takes a raw
   * SQL string, so building `VACUUM INTO '${path}'` by hand would put an
   * operator-supplied path into SQL — the same injection class the Phase 0
   * audit exists to prevent, just one layer down.
   */
  exportTo(destination: string): void {
    this.#db.query("VACUUM INTO ?").run(destination);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#db.close();
    this.#closed = true;
  }
}

/**
 * Offline restore (spec §5): the database must be closed and its WAL folded in
 * before the file is swapped, otherwise a stale `-wal` sidecar from the previous
 * database would be replayed on top of the replacement.
 *
 * Returns the integrity report so a caller can refuse to continue on a corrupt
 * restore rather than booting on garbage.
 */
export function restoreDatabaseFile(
  dataDir: string,
  sourceFile: string
): { integrity: string; path: string } {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = resolveDbPath(dataDir);

  // Remove any sidecars first: a -wal left over from the *old* database would
  // otherwise be applied to the file we are about to write.
  for (const suffix of ["-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }

  copyFileSync(sourceFile, dbPath);
  chmodSync(dbPath, 0o600);

  let probe: Database | null = null;
  try {
    probe = new Database(dbPath, { readonly: true });
    const row = probe
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get();
    return { integrity: row?.integrity_check ?? "unknown", path: dbPath };
  } catch (error) {
    // A restore that cannot even be opened is a failed restore. Report it
    // instead of throwing from deep inside a boot path, so the caller can
    // decide whether to refuse to start.
    return {
      integrity: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
      path: dbPath,
    };
  } finally {
    probe?.close();
  }
}
