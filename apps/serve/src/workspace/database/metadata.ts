import type { Database } from "bun:sqlite";
import { HEAD_SEQ_KEY } from "./connection";
import type { MetaChange } from "./types";

export class MetadataStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  getMeta(key: string): string | null {
    const row = this.#db
      .query<{ value: string }, [string]>(
        "SELECT value FROM meta WHERE key = ?"
      )
      .get(key);
    return row?.value ?? null;
  }

  getOrCreateMeta(key: string, initialValue: string): string {
    this.#db
      .query("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
      .run(key, initialValue);
    const value = this.getMeta(key);
    if (value === null) {
      throw new Error(`failed to initialize database metadata: ${key}`);
    }
    return value;
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

  deleteMeta(key: string): void {
    this.#db.query("DELETE FROM meta WHERE key = ?").run(key);
  }

  entriesWithPrefix(prefix: string): [string, string][] {
    const rows = this.#db
      .query<{ key: string; value: string }, [string]>(
        "SELECT key, value FROM meta WHERE key LIKE ? ESCAPE '\\'"
      )
      .all(`${prefix.replace(/[\\%_]/g, "\\$&")}%`);
    return rows.map((row) => [row.key, row.value]);
  }

  headSeq(): number {
    const raw = this.getMeta(HEAD_SEQ_KEY);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  pruneMutationIds(olderThan: number): number {
    return this.#db
      .query(
        "DELETE FROM meta WHERE key LIKE 'mut:%' AND CAST(value AS INTEGER) < ?"
      )
      .run(olderThan).changes;
  }

  mutationIdSeen(mutationId: string): boolean {
    return (
      this.#db
        .query<{ present: number }, [string]>(
          "SELECT 1 AS present FROM meta WHERE key = ?"
        )
        .get(`mut:${mutationId}`)?.present === 1
    );
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
}
