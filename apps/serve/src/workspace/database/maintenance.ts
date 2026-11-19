import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export class DatabaseMaintenance {
  readonly #db: Database;
  readonly #path: string;
  #closed = false;

  constructor(db: Database, path: string) {
    this.#db = db;
    this.#path = path;
  }

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

  exportTo(destination: string): void {
    this.#db.query("VACUUM INTO ?").run(destination);
  }

  createVerifiedBackup(destination: string): boolean {
    const resolvedDestination = resolve(destination);
    if (resolvedDestination === this.#path) {
      throw new Error("A workspace backup cannot replace the active database.");
    }

    const directory = dirname(resolvedDestination);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    chmodSync(directory, 0o700);
    if (existsSync(resolvedDestination)) {
      const integrity = databaseIntegrity(resolvedDestination);
      if (integrity !== "ok") {
        throw new Error(
          `The existing workspace migration backup is invalid (${integrity}); refusing to migrate.`
        );
      }
      chmodSync(resolvedDestination, 0o600);
      return false;
    }

    const temporaryPath = join(
      directory,
      `.${basename(resolvedDestination)}.${randomUUID()}.tmp`
    );
    let destinationCreated = false;
    try {
      this.#db.query("VACUUM INTO ?").run(temporaryPath);
      chmodSync(temporaryPath, 0o600);
      const integrity = databaseIntegrity(temporaryPath);
      if (integrity !== "ok") {
        throw new Error(
          `The workspace backup failed its integrity check (${integrity}).`
        );
      }
      copyFileSync(
        temporaryPath,
        resolvedDestination,
        fsConstants.COPYFILE_EXCL
      );
      destinationCreated = true;
      chmodSync(resolvedDestination, 0o600);
      return true;
    } catch (cause) {
      if (destinationCreated) {
        rmSync(resolvedDestination, { force: true });
      }
      throw new Error(
        `Could not create a verified workspace migration backup at ${resolvedDestination}.`,
        { cause }
      );
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#db.close();
    this.#closed = true;
  }
}

function databaseIntegrity(databasePath: string): string {
  let probe: Database | null = null;
  try {
    probe = new Database(databasePath, { readonly: true, create: false });
    return (
      probe
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get()?.integrity_check ?? "unknown"
    );
  } catch (error) {
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    probe?.close();
  }
}
