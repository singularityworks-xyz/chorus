import { openChorusDatabase, resolveDbPath } from "./database/connection";
import { EventLogStore } from "./database/event-log";
import { DatabaseMaintenance } from "./database/maintenance";
import { MetadataStore } from "./database/metadata";
import { PushSubscriptionStore } from "./database/push-subscriptions";
import type {
  EventToAppend,
  MetaChange,
  PushSubscriptionRow,
  StoredEvent,
  StoredPushSubscription,
  StoredSnapshot,
} from "./database/types";

export class ChorusDatabase {
  readonly dataDir: string;
  readonly path: string;
  readonly #metadata: MetadataStore;
  readonly #pushSubscriptions: PushSubscriptionStore;
  readonly #eventLog: EventLogStore;
  readonly #maintenance: DatabaseMaintenance;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.path = resolveDbPath(dataDir);
    const database = openChorusDatabase(dataDir);
    this.#metadata = new MetadataStore(database);
    this.#pushSubscriptions = new PushSubscriptionStore(database);
    this.#eventLog = new EventLogStore(database, this.#metadata);
    this.#maintenance = new DatabaseMaintenance(database, this.path);
  }

  getMeta(key: string): string | null {
    return this.#metadata.getMeta(key);
  }

  getOrCreateMeta(key: string, initialValue: string): string {
    return this.#metadata.getOrCreateMeta(key, initialValue);
  }

  hasAgentReceipt(receiptId: string): boolean {
    return this.#metadata.hasAgentReceipt(receiptId);
  }

  pruneAgentReceipts(before: number, maxRows: number): void {
    this.#metadata.pruneAgentReceipts(before, maxRows);
  }

  setMeta(key: string, value: string): void {
    this.#metadata.setMeta(key, value);
  }

  writeMetaChanges(changes: MetaChange[]): void {
    this.#metadata.writeMetaChanges(changes);
  }

  deleteMeta(key: string): void {
    this.#metadata.deleteMeta(key);
  }

  entriesWithPrefix(prefix: string): [string, string][] {
    return this.#metadata.entriesWithPrefix(prefix);
  }

  headSeq(): number {
    return this.#metadata.headSeq();
  }

  pruneMutationIds(olderThan: number): number {
    return this.#metadata.pruneMutationIds(olderThan);
  }

  mutationIdSeen(mutationId: string): boolean {
    return this.#metadata.mutationIdSeen(mutationId);
  }

  upsertPushSubscription(
    subscription: PushSubscriptionRow,
    maxPerDevice = 4
  ): "stored" | "owned-by-another-device" | "limit-reached" {
    return this.#pushSubscriptions.upsert(subscription, maxPerDevice);
  }

  listPushSubscriptions(deviceId?: string): StoredPushSubscription[] {
    return this.#pushSubscriptions.list(deviceId);
  }

  pushSubscription(endpoint: string): StoredPushSubscription | null {
    return this.#pushSubscriptions.get(endpoint);
  }

  deletePushSubscription(endpoint: string, deviceId?: string): boolean {
    return this.#pushSubscriptions.delete(endpoint, deviceId);
  }

  deletePushSubscriptionIfMatches(
    subscription: StoredPushSubscription
  ): boolean {
    return this.#pushSubscriptions.deleteIfMatches(subscription);
  }

  deleteDevicePushSubscriptions(deviceId: string): number {
    return this.#pushSubscriptions.deleteDevice(deviceId);
  }

  appendEvents(
    events: EventToAppend[],
    mutationKey: { id: string; ts: number } | null,
    metaChanges: MetaChange[] = [],
    agentReceipt?:
      | { id: string; ts: number }
      | Array<{ id: string; ts: number }>
  ): { firstSeq: number; lastSeq: number } {
    return this.#eventLog.appendEvents(
      events,
      mutationKey,
      metaChanges,
      agentReceipt
    );
  }

  readEventsSince(seq: number, limit = Number.MAX_SAFE_INTEGER): StoredEvent[] {
    return this.#eventLog.readEventsSince(seq, limit);
  }

  eventCount(): number {
    return this.#eventLog.eventCount();
  }

  latestSnapshot(): StoredSnapshot | null {
    return this.#eventLog.latestSnapshot();
  }

  writeSnapshot(seq: number, ts: number, blob: string): void {
    this.#eventLog.writeSnapshot(seq, ts, blob);
  }

  pruneEventsBefore(seq: number): number {
    return this.#eventLog.pruneEventsBefore(seq);
  }

  checkpointTruncate(): void {
    this.#maintenance.checkpointTruncate();
  }

  integrityCheck(): string {
    return this.#maintenance.integrityCheck();
  }

  dbSizeBytes(): number {
    return this.#maintenance.dbSizeBytes();
  }

  exportTo(destination: string): void {
    this.#maintenance.exportTo(destination);
  }

  createVerifiedBackup(destination: string): boolean {
    return this.#maintenance.createVerifiedBackup(destination);
  }

  close(): void {
    this.#maintenance.close();
  }
}
