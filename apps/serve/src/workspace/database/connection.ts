import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const CHORUS_DB_FILENAME = "chorus.db";
export const HEAD_SEQ_KEY = "head_seq";
export const WORKSPACE_ID_KEY = "workspace_id";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  board_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_board_idx ON events(board_id);
CREATE INDEX IF NOT EXISTS events_type_idx ON events(type);
CREATE INDEX IF NOT EXISTS events_ts_idx ON events(ts);

CREATE TABLE IF NOT EXISTS snapshots (
  seq INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  blob TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  keys TEXT NOT NULL,
  device_id TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  expiration_at INTEGER,
  key_id TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_receipts (
  receipt_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_receipts_time_idx
  ON agent_receipts(received_at);
`;

function migratePushSubscriptions(db: Database): void {
  const columns = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(push_subs)")
      .all()
      .map((column) => column.name)
  );
  const additions = [
    ["device_id", "TEXT"],
    ["updated_at", "INTEGER"],
    ["expiration_at", "INTEGER"],
    ["key_id", "TEXT"],
  ] as const;

  for (const [name, type] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE push_subs ADD COLUMN ${name} ${type}`);
    }
  }
}

export function resolveDbPath(dataDir: string): string {
  return join(dataDir, CHORUS_DB_FILENAME);
}

export function openChorusDatabase(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = resolveDbPath(dataDir);
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migratePushSubscriptions(db);
  // The database contains workspace paths and user content.
  chmodSync(dbPath, 0o600);
  return db;
}
