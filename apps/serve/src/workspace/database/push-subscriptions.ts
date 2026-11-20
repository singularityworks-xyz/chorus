import type { Database } from "bun:sqlite";
import type { PushSubscriptionRow, StoredPushSubscription } from "./types";

interface PushSubscriptionSqlRow {
  created_at: number | null;
  device_id: string | null;
  endpoint: string;
  expiration_at: number | null;
  key_id: string | null;
  keys: string;
  updated_at: number | null;
}

export class PushSubscriptionStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  upsert(
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

  list(deviceId?: string): StoredPushSubscription[] {
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
    return rows.map(toStoredSubscription);
  }

  get(endpoint: string): StoredPushSubscription | null {
    const row = this.#db
      .query<PushSubscriptionSqlRow, [string]>(
        `SELECT endpoint, keys, device_id, created_at, updated_at, expiration_at, key_id
         FROM push_subs WHERE endpoint = ?`
      )
      .get(endpoint);
    return row ? toStoredSubscription(row) : null;
  }

  delete(endpoint: string, deviceId?: string): boolean {
    const result = deviceId
      ? this.#db
          .query("DELETE FROM push_subs WHERE endpoint = ? AND device_id = ?")
          .run(endpoint, deviceId)
      : this.#db
          .query("DELETE FROM push_subs WHERE endpoint = ?")
          .run(endpoint);
    return result.changes > 0;
  }

  deleteIfMatches(subscription: StoredPushSubscription): boolean {
    return (
      this.#db
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
        ).changes > 0
    );
  }

  deleteDevice(deviceId: string): number {
    return this.#db
      .query("DELETE FROM push_subs WHERE device_id = ?")
      .run(deviceId).changes;
  }
}

function toStoredSubscription(
  row: PushSubscriptionSqlRow
): StoredPushSubscription {
  return {
    createdAt: row.created_at,
    deviceId: row.device_id,
    endpoint: row.endpoint,
    expirationAt: row.expiration_at,
    keyId: row.key_id,
    keys: row.keys,
    updatedAt: row.updated_at,
  };
}
