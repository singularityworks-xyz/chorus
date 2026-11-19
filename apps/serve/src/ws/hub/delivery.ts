import { isCoalescibleEvent } from "@chorus/contracts";
import type { SequencedRecord } from "../../workspace/store/types";
import { bufferOf, mergeKeyFor, mergeRecords } from "./coalescing";
import { HIGH_WATER_MARK, MAX_COALESCE_BUFFER, RECOVERY_SENDS } from "./limits";
import type { BufferedRecord, HubClient } from "./types";

interface HubEventDeliveryOptions {
  clients(): Iterable<HubClient>;
  coalesceMs: number;
  sendSequenced(client: HubClient, record: BufferedRecord): void;
}

export class HubEventDelivery {
  readonly #clients: HubEventDeliveryOptions["clients"];
  readonly #sendSequenced: HubEventDeliveryOptions["sendSequenced"];
  readonly #coalesceMs: number;
  readonly #pending: BufferedRecord[] = [];
  readonly #mergeIndex = new Map<string, BufferedRecord>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: HubEventDeliveryOptions) {
    this.#clients = options.clients;
    this.#sendSequenced = options.sendSequenced;
    this.#coalesceMs = options.coalesceMs;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  publishRecord(record: SequencedRecord): void {
    if (isCoalescibleEvent(record.event)) {
      this.#buffer(record);
      return;
    }
    if (this.#pending.length > 0) {
      // Flush older workspace sequences before an immediate event.
      this.flush();
    }

    this.#deliver(bufferOf(record));
  }

  flush(): void {
    if (this.#pending.length === 0) {
      return;
    }

    const records = this.#pending.splice(0);
    this.#mergeIndex.clear();
    // Sequence numbers are workspace-wide, even when records belong to different boards.
    const ordered = records.sort((a, b) => a.fromSeq - b.fromSeq);

    for (const record of ordered) {
      try {
        this.#deliver(record);
      } catch (error) {
        // A failed frame must not block the rest of the batch.
        console.error("[ws] delivery failed:", error);
      }
    }
  }

  close(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.flush();
  }

  #buffer(record: SequencedRecord): void {
    const buffered = bufferOf(record);
    const mergeKey = mergeKeyFor(buffered);
    const existing = this.#mergeIndex.get(mergeKey);

    if (existing && mergeRecords(existing, record)) {
      return;
    }

    if (this.#pending.length >= MAX_COALESCE_BUFFER) {
      this.flush();
    }

    this.#pending.push(buffered);
    this.#mergeIndex.set(mergeKey, buffered);
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null) {
      return;
    }
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flush();
    }, this.#coalesceMs);
    this.#flushTimer.unref?.();
  }

  #deliver(record: BufferedRecord): void {
    for (const client of this.#clients()) {
      if (!client.ready) {
        continue;
      }
      this.#deliverTo(client, record);
    }
  }

  #isCongested(client: HubClient, buffered: number): boolean {
    if (buffered > HIGH_WATER_MARK) {
      return true;
    }
    return (
      (client.backpressuredFrames > 0 || client.droppedFrames > 0) &&
      client.cleanSends === 0
    );
  }

  #hasRecovered(
    client: HubClient,
    buffered: number,
    hasGauge: boolean
  ): boolean {
    if (hasGauge) {
      return buffered < HIGH_WATER_MARK / 2;
    }
    return client.cleanSends >= RECOVERY_SENDS;
  }

  #deliverTo(client: HubClient, record: BufferedRecord): void {
    if (record.toSeq <= client.lastSeq) {
      return;
    }
    const buffered = client.socket.getBufferedAmount?.() ?? 0;
    const hasBufferGauge =
      typeof client.socket.getBufferedAmount === "function";

    if (this.#isCongested(client, buffered)) {
      client.criticalOnly = true;
    } else if (
      client.criticalOnly &&
      this.#hasRecovered(client, buffered, hasBufferGauge)
    ) {
      client.criticalOnly = false;
      client.backpressuredFrames = 0;
      client.cleanSends = 0;
    }

    if (client.criticalOnly && isCoalescibleEvent(record.event)) {
      return;
    }

    this.#sendSequenced(client, record);
  }
}
