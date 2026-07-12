import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditSink } from './index.js';
import { validate } from '@flowforge/core';

describe('AuditLog', () => {
  it('chains records and verifies integrity', () => {
    const log = new AuditLog();
    const first = log.record({
      actor: { type: 'agent', id: 'assessment' },
      action: 'agent.step',
      score: 82,
      confidence: 0.9
    });
    const second = log.record({
      actor: { type: 'human', id: 'teacher-1' },
      action: 'human.override',
      override: { originalValue: 82, newValue: 85, reason: 'partial credit for method' }
    });
    expect(first.previousHash).toBe('genesis');
    expect(second.previousHash).toBe(first.hash);
    expect(log.verify()).toBe(-1);
  });

  it('produces schema-valid records', () => {
    const log = new AuditLog();
    const record = log.record({ actor: { type: 'system', id: 'kernel' }, action: 'package.install' });
    expect(validate('audit-record', record).errors).toEqual([]);
  });

  it('detects tampering', () => {
    const sink = new InMemoryAuditSink();
    const log = new AuditLog(sink);
    log.record({ actor: { type: 'agent', id: 'a' }, action: 'agent.step' });
    log.record({ actor: { type: 'agent', id: 'b' }, action: 'agent.step' });
    const records = sink.all();
    // tamper with the first record via a fresh sink
    const tampered = new InMemoryAuditSink();
    tampered.append({ ...records[0]!, score: 100 });
    tampered.append(records[1]!);
    expect(new AuditLog(tampered).verify()).toBe(0);
  });
});
