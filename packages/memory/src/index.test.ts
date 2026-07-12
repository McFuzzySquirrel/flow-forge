import { describe, expect, it } from 'vitest';
import { MemoryService } from './index.js';

describe('MemoryService', () => {
  it('namespaces memory per package and agent', () => {
    expect(MemoryService.namespace('dev.flowforge.grade7-maths', 'coach')).toBe(
      'dev.flowforge.grade7-maths/coach'
    );
  });

  it('remembers and recalls semantically related items per namespace', async () => {
    const memory = new MemoryService();
    await memory.remember('pkg/coach', 'Learner struggles with two-step linear equations');
    await memory.remember('pkg/coach', 'Learner is confident with substitution into formulas');
    await memory.remember('pkg/assessment', 'Grading exemplar: full marks requires verification step');

    const results = await memory.recall('pkg/coach', 'linear equations difficulty');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.text).toContain('two-step linear equations');

    // isolation: coach memories are invisible to assessment namespace
    const other = await memory.recall('pkg/assessment', 'linear equations difficulty');
    expect(other.every((r) => !r.text.includes('struggles'))).toBe(true);
  });

  it('forgets items', async () => {
    const memory = new MemoryService();
    const item = await memory.remember('pkg/a', 'temporary note about algebra');
    await memory.forget('pkg/a', item.id);
    expect(await memory.list('pkg/a')).toEqual([]);
  });
});
