import type { Database } from "bun:sqlite";
import { HEAD_SEQ_KEY } from "./connection";
import type { MetadataStore } from "./metadata";
import type {
  EventToAppend,
  MetaChange,
  StoredEvent,
  StoredSnapshot,
} from "./types";

export class EventLogStore {
  readonly #db: Database;
  readonly #metadata: MetadataStore;

  constructor(db: Database, metadata: MetadataStore) {
    this.#db = db;
    this.#metadata = metadata;
  }

  appendEvents(
    events: EventToAppend[],
    mutationKey: { id: string; ts: number } | null,
    metaChanges: MetaChange[] = [],
    agentReceipt?:
      | { id: string; ts: number }
      | Array<{ id: string; ts: number }>
  ): { firstSeq: number; lastSeq: number } {
    let agentReceipts: Array<{ id: string; ts: number }> = [];
    if (Array.isArray(agentReceipt)) {
      agentReceipts = agentReceipt;
    } else if (agentReceipt) {
      agentReceipts = [agentReceipt];
    }
    if (events.length === 0 && agentReceipts.length === 0) {
      const head = this.#metadata.headSeq();
      return { firstSeq: head + 1, lastSeq: head };
    }

    return this.#db
      .transaction(() => {
        let seq = this.#metadata.headSeq();
        if (agentReceipts.length > 0) {
          const insertReceipt = this.#db.query(
            "INSERT INTO agent_receipts (receipt_id, received_at) VALUES (?, ?)"
          );
          for (const receipt of agentReceipts) {
            insertReceipt.run(receipt.id, receipt.ts);
          }
        }

        if (events.length > 0) {
          const insertEvent = this.#db.query(
            "INSERT INTO events (seq, ts, board_id, type, payload) VALUES (?, ?, ?, ?, ?)"
          );
          for (const event of events) {
            seq += 1;
            insertEvent.run(
              seq,
              event.ts,
              event.boardId,
              event.type,
              event.payload
            );
          }
        }

        this.#metadata.setMeta(HEAD_SEQ_KEY, String(seq));
        if (mutationKey) {
          this.#metadata.setMeta(
            `mut:${mutationKey.id}`,
            String(mutationKey.ts)
          );
        }
        for (const change of metaChanges) {
          if (change.value === null) {
            this.#metadata.deleteMeta(change.key);
          } else {
            this.#metadata.setMeta(change.key, change.value);
          }
        }

        return events.length === 0
          ? { firstSeq: seq + 1, lastSeq: seq }
          : { firstSeq: seq - events.length + 1, lastSeq: seq };
      })
      .immediate();
  }

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
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events")
        .get()?.count ?? 0
    );
  }

  latestSnapshot(): StoredSnapshot | null {
    return (
      this.#db
        .query<{ blob: string; seq: number; ts: number }, []>(
          "SELECT seq, ts, blob FROM snapshots ORDER BY seq DESC LIMIT 1"
        )
        .get() ?? null
    );
  }

  writeSnapshot(seq: number, ts: number, blob: string): void {
    this.#db
      .query(
        "INSERT OR REPLACE INTO snapshots (seq, ts, blob) VALUES (?, ?, ?)"
      )
      .run(seq, ts, blob);
  }

  pruneEventsBefore(seq: number): number {
    return this.#db.query("DELETE FROM events WHERE seq < ?").run(seq).changes;
  }
}
