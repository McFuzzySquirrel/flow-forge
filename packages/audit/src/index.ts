import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { AuditRecord } from '@flowforge/core';

export type AuditRecordInput = Omit<AuditRecord, 'id' | 'timestamp' | 'hash' | 'previousHash'>;

/** Pluggable persistence for the audit chain. */
export interface AuditSink {
  append(record: AuditRecord): void;
  all(): AuditRecord[];
}

export class InMemoryAuditSink implements AuditSink {
  private records: AuditRecord[] = [];
  append(record: AuditRecord): void {
    this.records.push(record);
  }
  all(): AuditRecord[] {
    return [...this.records];
  }
}

/** Append-only JSONL file sink. */
export class FileAuditSink implements AuditSink {
  constructor(private readonly filePath: string) {}
  append(record: AuditRecord): void {
    appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8');
  }
  all(): AuditRecord[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditRecord);
  }
}

function contentHash(record: Omit<AuditRecord, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

/**
 * Append-only, hash-chained audit log. Every agent step and human override
 * must emit a record; the chain makes tampering detectable.
 */
export class AuditLog {
  private lastHash: string;

  constructor(private readonly sink: AuditSink = new InMemoryAuditSink()) {
    const existing = sink.all();
    this.lastHash = existing.length > 0 ? existing[existing.length - 1]!.hash : 'genesis';
  }

  record(input: AuditRecordInput): AuditRecord {
    const partial: Omit<AuditRecord, 'hash'> = {
      ...input,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      previousHash: this.lastHash
    };
    const record: AuditRecord = { ...partial, hash: contentHash(partial) };
    this.sink.append(record);
    this.lastHash = record.hash;
    return record;
  }

  all(): AuditRecord[] {
    return this.sink.all();
  }

  /** Verify the hash chain end-to-end. Returns the index of the first bad record, or -1 if intact. */
  verify(): number {
    const records = this.sink.all();
    let previous = 'genesis';
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      const { hash, ...rest } = record;
      if (record.previousHash !== previous || contentHash(rest) !== hash) return i;
      previous = hash;
    }
    return -1;
  }
}
