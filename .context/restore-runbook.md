# Chorus — Restore & Backup Runbook

> Phase 2 deliverable. Covers `chorus.db` backup, export, and restore.
> Commands assume Bun. `$DATA_DIR` defaults to `~/.chorus`.

## What is durable, and where

| Data | Location | Notes |
|---|---|---|
| Event log | `chorus.db` → `events` | Append-only, sequenced by `seq` |
| Full-state snapshots | `chorus.db` → `snapshots` | Written every `SNAPSHOT_INTERVAL` events (default 1000) and on every shutdown |
| Sequence head | `chorus.db` → `meta` (`head_seq`) | Survives event pruning |
| Mutation idempotency keys | `chorus.db` → `meta` (`mut:<id>`) | Pruned after 24 h at boot |
| Terminal-run detail | compacted in place | Step transcripts older than `RETENTION_DAYS` collapse to one summary line |
| Push subscriptions | `chorus.db` → `push_subs` | Wired in Phase 2, populated in Phase 7 |

`chorus.db` is `chmod 0600` on creation: it contains every repo path the operator
has open. The `-wal` / `-shm` sidecars are **not** secrets, but they are not a
complete backup on their own either.

## Backup

A cold copy of `chorus.db` is complete **only if the WAL has been folded in**.
Either use the in-process export, or copy the file while serve is stopped.

### Preferred — export while running

```ts
import { WorkspaceStore } from "@chorus/serve/src/workspace/store";

const store = new WorkspaceStore(process.env.DATA_DIR);
await store.load();
store.exportTo("/backup/chorus-2026-10-01.db");
await store.close();
```

`exportTo` is `VACUUM INTO`, so the copy is compacted and needs no sidecars. The
destination is passed as a bound parameter, not interpolated into SQL.

### Alternative — copy from a stopped process

```bash
# SIGTERM drains the queue, writes a final snapshot, and checkpoints the WAL
kill -TERM "$(pgrep -f 'apps/serve/src/index.ts')"
cp "$DATA_DIR/chorus.db" /backup/chorus.db
```

Copying `chorus.db` while serve is *running* can miss recent commits that are
still only in the `-wal`.

## Restore

Restores are **offline**. Order matters: a stale `-wal` from the previous
database will be replayed on top of the replacement if you leave it in place.

```ts
import { restoreDatabaseFile } from "@chorus/serve/src/workspace/db";

const { integrity, path } = restoreDatabaseFile("/data", "/backup/chorus.db");

if (integrity !== "ok") {
  throw new Error(`refusing to start: restored database reports ${integrity}`);
}
console.log(`restored into ${path}`);
```

`restoreDatabaseFile` performs, in order:

1. `mkdir -p` the target data dir
2. delete `<db>-wal` and `<db>-shm` sidecars
3. copy the source over `chorus.db`
4. `chmod 0600`
5. open read-only and run `PRAGMA integrity_check`
6. return the report — it does **not** throw on corruption, so the caller decides

Then start serve normally and confirm:

```bash
curl -s localhost:2000/health
curl -s localhost:2000/workspace | head -c 200
```

## Recovery

Serve refuses to start rather than starting on bad data:

| Symptom | Cause | What to do |
|---|---|---|
| `corrupt workspace snapshot in <path>` | `snapshots` blob is unparseable or an unknown `v` | Restore from backup; the raw file is preserved as-is |
| `corrupt event at seq <n> in <path>` | an `events.payload` will not JSON-parse | Restore from backup. Do not hand-edit; the replay order depends on intact rows |
| `refusing to start: legacy workspace snapshot at <path> is corrupt` | `workspace.json` import found unparseable JSON | Move the file aside to start empty, or repair it. Never ignored automatically — a silent empty workspace is indistinguishable from data loss |
| `unsupported workspace snapshot version <n>` | blob written by a newer Chorus | Upgrade Chorus; do not force |

## Live debugging

`chorus.db` is safe to inspect read-only while serve runs:

```bash
sqlite3 "$DATA_DIR/chorus.db" "SELECT seq, type, board_id FROM events ORDER BY seq DESC LIMIT 20;"
sqlite3 "$DATA_DIR/chorus.db" "SELECT value FROM meta WHERE key = 'head_seq';"
sqlite3 "$DATA_DIR/chorus.db" "PRAGMA integrity_check;"
```

## Retention

Terminal-run **detail** (agent thinking, tool calls, streamed deltas) is
compacted after `RETENTION_DAYS` (default 30) in the `done` and `approve` lanes.
The card, its title, and its last summary line survive. Active lanes (`queue`,
`in_progress`) are never pruned.

`RETENTION_DAYS` cannot be set to 0 to disable this — a non-positive value is a
boot error. Raise it to a large number if you want compaction effectively off.

## Litestream

Continuous replication to S3 is supported by pointing litestream at the file and
letting `SIGTERM` handle checkpoints:

```bash
litestream replicate "$DATA_DIR/chorus.db" "s3://mybucket/chorus?region=us-east-1"
```