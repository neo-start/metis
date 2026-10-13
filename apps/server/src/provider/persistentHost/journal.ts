import { appendFileSync, closeSync, constants, fsyncSync, openSync } from "node:fs";
import path from "node:path";
import type { ProviderEvent } from "@synara/contracts";
import type { PersistentHostEvent } from "@synara/contracts/persistentProviderHost";
import { writePrivateFile } from "./storage.ts";

/** Durable until projection explicitly acknowledges a contiguous prefix. No socket ACKs. */
export class PersistentHostJournal {
  readonly entries: PersistentHostEvent[] = [];
  acknowledgedSequence = 0;
  latestSequence = 0;
  private bytes = 0;
  private readonly file: string;
  constructor(
    directory: string,
    readonly maxBytes = 32 * 1024 * 1024,
  ) {
    this.file = path.join(directory, "events.ndjson");
    writePrivateFile(this.file, "");
  }
  append(event: ProviderEvent): void {
    const entry = { sequence: this.latestSequence + 1, event };
    const line = `${JSON.stringify(entry)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > 1024 * 1024 || this.bytes + bytes > this.maxBytes) {
      throw new Error(
        "Persistent host event journal is full; provider stopped without dropping acknowledged boundaries",
      );
    }
    const fd = openSync(this.file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      appendFileSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.entries.push(entry);
    this.bytes += bytes;
    this.latestSequence = entry.sequence;
  }
  read(after: number): PersistentHostEvent[] {
    if (
      !Number.isSafeInteger(after) ||
      after < this.acknowledgedSequence ||
      after > this.latestSequence
    ) {
      throw new Error("Event cursor is outside the retained journal");
    }
    const batch: PersistentHostEvent[] = [];
    let bytes = 0;
    for (const entry of this.entries) {
      if (entry.sequence <= after) continue;
      bytes += Buffer.byteLength(JSON.stringify(entry));
      if (bytes > 2 * 1024 * 1024 || batch.length >= 128) break;
      batch.push(entry);
    }
    return batch;
  }
  acknowledge(sequence: number): void {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < this.acknowledgedSequence ||
      sequence > this.latestSequence
    ) {
      throw new Error("Invalid event acknowledgement");
    }
    const remaining = this.entries.filter((entry) => entry.sequence > sequence);
    const content = remaining.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    // Persist the cursor before compacting. Host loss is never a promise of protocol resurrection.
    writePrivateFile(
      path.join(path.dirname(this.file), "cursor.json"),
      JSON.stringify({ sequence }),
    );
    writePrivateFile(this.file, content);
    this.entries.splice(0, this.entries.length, ...remaining);
    this.bytes = Buffer.byteLength(content);
    this.acknowledgedSequence = sequence;
  }
}
