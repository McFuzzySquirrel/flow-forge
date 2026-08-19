import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileVectorStore,
  InMemoryVectorStore,
  MemoryService,
  MockEmbeddingProvider,
  type VectorStore,
} from './index.js';

// ---------------------------------------------------------------------------
// Shared VectorStore contract test suite
// ---------------------------------------------------------------------------

function vectorStoreContract(label: string, makeStore: () => VectorStore): void {
  describe(`VectorStore contract — ${label}`, () => {
    it('adds and lists items in the correct collection', async () => {
      const store = makeStore();
      await store.add('col/a', { id: '1', text: 'linear equations', createdAt: new Date().toISOString() });
      await store.add('col/b', { id: '2', text: 'fractions lesson', createdAt: new Date().toISOString() });

      const a = await store.list('col/a');
      expect(a).toHaveLength(1);
      expect(a[0]!.text).toBe('linear equations');

      // col/b must not leak into col/a
      const b = await store.list('col/b');
      expect(b).toHaveLength(1);
      expect(b[0]!.text).toBe('fractions lesson');
    });

    it('queries return relevant items only from the target collection', async () => {
      const store = makeStore();
      await store.add('ns/coach', { id: '1', text: 'struggles with fractions', createdAt: new Date().toISOString() });
      await store.add('ns/coach', { id: '2', text: 'confident with algebra', createdAt: new Date().toISOString() });
      await store.add('ns/assessment', { id: '3', text: 'struggles with fractions', createdAt: new Date().toISOString() });

      const results = await store.query('ns/coach', 'fractions difficulty', 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.relevance > 0)).toBe(true);
      // Must not return items from ns/assessment
      expect(results.every((r) => r.id !== '3')).toBe(true);
    });

    it('removes an item so it no longer appears in list or query', async () => {
      const store = makeStore();
      await store.add('ns/a', { id: 'del-me', text: 'temporary algebra notes', createdAt: new Date().toISOString() });
      await store.remove('ns/a', 'del-me');

      expect(await store.list('ns/a')).toEqual([]);
      const q = await store.query('ns/a', 'algebra notes', 5);
      expect(q).toEqual([]);
    });

    it('returns empty list/query for an empty collection', async () => {
      const store = makeStore();
      expect(await store.list('empty/ns')).toEqual([]);
      expect(await store.query('empty/ns', 'anything', 5)).toEqual([]);
    });

    it('respects the limit in query results', async () => {
      const store = makeStore();
      for (let i = 0; i < 6; i++) {
        await store.add('lim/ns', {
          id: String(i),
          text: `algebra equation step ${i}`,
          createdAt: new Date().toISOString(),
        });
      }
      const results = await store.query('lim/ns', 'algebra equation', 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });
}

// Run the contract against both concrete implementations.
vectorStoreContract('InMemoryVectorStore', () => new InMemoryVectorStore());

describe('VectorStore contract — FileVectorStore', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'ff-mem-test-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });
  vectorStoreContract('FileVectorStore', () => new FileVectorStore(tmpDir));
});

// ---------------------------------------------------------------------------
// MemoryService tests
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Namespace isolation tests (3.3.4)
// ---------------------------------------------------------------------------

describe('MemoryService — namespace isolation', () => {
  it('agent A memory is never visible to agent B', async () => {
    const memory = new MemoryService();
    await memory.remember('pkg/agent-a', 'Agent A secret: fractions feedback');
    await memory.remember('pkg/agent-b', 'Agent B note: algebra assessment');

    const aRecall = await memory.recall('pkg/agent-a', 'algebra assessment');
    expect(aRecall.every((r) => r.text.includes('Agent A'))).toBe(true);

    const bRecall = await memory.recall('pkg/agent-b', 'fractions feedback');
    expect(bRecall.every((r) => r.text.includes('Agent B'))).toBe(true);

    // Cross-namespace: agent-b list must not contain agent-a's item
    const bList = await memory.list('pkg/agent-b');
    expect(bList.every((r) => !r.text.includes('Agent A'))).toBe(true);
  });

  it('replacing agent A preserves agent B memory', async () => {
    const memory = new MemoryService();
    const nsA = MemoryService.namespace('pkg', 'agent-a');
    const nsB = MemoryService.namespace('pkg', 'agent-b');

    await memory.remember(nsA, 'Agent A learning note: curriculum pacing');
    await memory.remember(nsB, 'Agent B coaching note: revision strategy');

    // "Replace" agent A by forgetting all its items.
    for (const item of await memory.list(nsA)) {
      await memory.forget(nsA, item.id);
    }
    expect(await memory.list(nsA)).toEqual([]);

    // Agent B memory must be unaffected.
    const bItems = await memory.list(nsB);
    expect(bItems).toHaveLength(1);
    expect(bItems[0]!.text).toContain('Agent B coaching note');
  });
});

// ---------------------------------------------------------------------------
// Retention / decay tests (3.3.5)
// ---------------------------------------------------------------------------

describe('MemoryService — retention and decay (3.3.5)', () => {
  it('prunes oldest items when maxItems is exceeded', async () => {
    const memory = new MemoryService();
    memory.setPolicy('retention/ns', { maxItems: 3 });

    for (let i = 0; i < 5; i++) {
      await memory.remember('retention/ns', `note ${i}`);
    }

    const items = await memory.list('retention/ns');
    expect(items.length).toBe(3);
    // The three most recent notes (2, 3, 4) should survive.
    expect(items.map((x) => x.text).sort()).toEqual(['note 2', 'note 3', 'note 4']);
  });

  it('excludes aged-out items from recall and list', async () => {
    const memory = new MemoryService();
    const ns = 'decay/ns';
    memory.setPolicy(ns, { maxAgeMs: 100 }); // 100 ms window

    // Add an item that is backdated to well outside the window.
    const old = await memory.remember(ns, 'old algebra note');
    // Manually age the item by overwriting its createdAt via forget+re-add through the raw store.
    // Instead, add a second item normally (it will be fresh).
    await memory.remember(ns, 'fresh curriculum note');

    // Force the old item to appear outdated: we back-date it in the store directly.
    // Retrieve it, forget it, re-add with an old timestamp.
    await memory.forget(ns, old.id);
    // Add the old item back to the underlying store with a past createdAt.
    const store = (memory as unknown as { store: InMemoryVectorStore }).store;
    await store.add(ns, {
      id: old.id,
      text: old.text,
      createdAt: new Date(Date.now() - 10_000).toISOString(), // 10 s ago
    });

    const items = await memory.list(ns);
    expect(items.every((item) => !item.text.includes('old algebra'))).toBe(true);
    expect(items.some((item) => item.text.includes('fresh'))).toBe(true);

    const recalled = await memory.recall(ns, 'algebra curriculum', 10);
    expect(recalled.every((r) => !r.text.includes('old algebra'))).toBe(true);
  });

  it('maxItems and maxAgeMs can be combined', async () => {
    const memory = new MemoryService();
    const ns = 'combo/ns';
    memory.setPolicy(ns, { maxItems: 5, maxAgeMs: 50 });

    // Add 6 items (maxItems=5 prunes oldest after each add).
    for (let i = 0; i < 6; i++) {
      await memory.remember(ns, `item ${i}`);
    }
    const items = await memory.list(ns);
    expect(items.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// EmbeddingProvider smoke test
// ---------------------------------------------------------------------------

describe('MockEmbeddingProvider', () => {
  it('returns a vector of the expected vocabulary length', async () => {
    const ep = new MockEmbeddingProvider();
    const v = await ep.embed('learner struggles with fractions');
    expect(Array.isArray(v)).toBe(true);
    expect(v.every((x) => x === 0 || x === 1)).toBe(true);
    // At least 'fractions' and 'struggles' should be set.
    expect(v.some((x) => x === 1)).toBe(true);
  });

  it('similar texts produce more overlapping vectors than dissimilar ones', async () => {
    const ep = new MockEmbeddingProvider();
    const a = await ep.embed('learner struggles with fractions');
    const b = await ep.embed('fractions are difficult for learner');
    const c = await ep.embed('curriculum pacing for grade maths');

    function dot(x: number[], y: number[]): number {
      return x.reduce((s, v, i) => s + v * (y[i] ?? 0), 0);
    }
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
  });
});
