import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MemoryItem {
  id: string;
  text: string;
  metadata?: Record<string, string>;
  createdAt: string;
}

export interface RecallResult extends MemoryItem {
  relevance: number;
}

/**
 * Pluggable vector store. The in-memory implementation uses lexical similarity;
 * a Chroma adapter implements the same interface for production use.
 */
export interface VectorStore {
  add(collection: string, item: MemoryItem): Promise<void>;
  query(collection: string, text: string, limit: number): Promise<RecallResult[]>;
  remove(collection: string, id: string): Promise<void>;
  list(collection: string): Promise<MemoryItem[]>;
}

/**
 * Retention policy per namespace. Both limits are optional and may be combined.
 *   maxItems  — oldest items are pruned when the collection exceeds this count.
 *   maxAgeMs  — items older than this many milliseconds are excluded from recall and list.
 */
export interface NamespacePolicy {
  maxItems?: number;
  maxAgeMs?: number;
}

// ---------------------------------------------------------------------------
// Embedding abstraction (mirrors ModelProvider pattern)
// ---------------------------------------------------------------------------

/**
 * Provider that turns a text string into an embedding vector.
 * Implemented by MockEmbeddingProvider (deterministic, offline) and
 * OllamaEmbeddingProvider (real embeddings via a local Ollama server).
 */
export interface EmbeddingProvider {
  readonly name: string;
  embed(text: string): Promise<number[]>;
}

/** Vocabulary used by MockEmbeddingProvider — sorted for determinism. */
const MOCK_VOCAB = Array.from(
  new Set([
    // common English function words that should be ignored
    'the', 'and', 'for', 'that', 'this', 'with', 'are', 'was', 'not',
    // domain tokens that appear in the test fixtures
    'algebra', 'angles', 'assessment', 'assignment', 'coach', 'confidence',
    'curriculum', 'difficulty', 'equations', 'exemplar', 'feedback', 'formulas',
    'fractions', 'grade', 'grading', 'learner', 'linear', 'marks', 'maths',
    'memory', 'notes', 'practice', 'reflection', 'revision', 'rubric', 'skill',
    'step', 'struggles', 'substitution', 'teacher', 'temporary', 'two', 'workflow',
  ])
).sort();

/**
 * Deterministic embedding provider for tests and offline development.
 * Produces a sparse binary bag-of-words vector over a fixed vocabulary.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock-embedding';

  async embed(text: string): Promise<number[]> {
    const tokens = new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2)
    );
    return MOCK_VOCAB.map((w) => (tokens.has(w) ? 1 : 0));
  }
}

/**
 * Real embedding provider backed by an Ollama `/api/embeddings` endpoint.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama-embedding';

  constructor(
    private readonly baseUrl = 'http://localhost:11434',
    private readonly model = 'nomic-embed-text'
  ) {}

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embeddings error ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { embedding: number[] };
    return json.embedding;
  }
}

// ---------------------------------------------------------------------------
// Lexical similarity helpers (used by InMemoryVectorStore and FileVectorStore)
// ---------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)
  );
}

function similarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / Math.sqrt(ta.size * tb.size);
}

// ---------------------------------------------------------------------------
// In-memory VectorStore
// ---------------------------------------------------------------------------

export class InMemoryVectorStore implements VectorStore {
  private collections = new Map<string, MemoryItem[]>();

  private collection(name: string): MemoryItem[] {
    let c = this.collections.get(name);
    if (!c) {
      c = [];
      this.collections.set(name, c);
    }
    return c;
  }

  async add(collection: string, item: MemoryItem): Promise<void> {
    this.collection(collection).push(item);
  }

  async query(collection: string, text: string, limit: number): Promise<RecallResult[]> {
    return this.collection(collection)
      .map((item) => ({ ...item, relevance: similarity(text, item.text) }))
      .filter((r) => r.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);
  }

  async remove(collection: string, id: string): Promise<void> {
    const c = this.collection(collection);
    const index = c.findIndex((item) => item.id === id);
    if (index >= 0) c.splice(index, 1);
  }

  async list(collection: string): Promise<MemoryItem[]> {
    return [...this.collection(collection)];
  }
}

// ---------------------------------------------------------------------------
// File-backed VectorStore (persists each collection as a JSON file)
// ---------------------------------------------------------------------------

/**
 * File-backed VectorStore that persists collections to `<dataDir>/memory/<collection>.json`.
 * Collection names are URL-encoded so any namespace string is safe as a filename.
 * Uses lexical similarity for recall (same algorithm as InMemoryVectorStore).
 */
export class FileVectorStore implements VectorStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'memory');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private filePath(collection: string): string {
    return join(this.dir, `${encodeURIComponent(collection)}.json`);
  }

  private read(collection: string): MemoryItem[] {
    const p = this.filePath(collection);
    if (!existsSync(p)) return [];
    return JSON.parse(readFileSync(p, 'utf-8')) as MemoryItem[];
  }

  private write(collection: string, items: MemoryItem[]): void {
    writeFileSync(this.filePath(collection), JSON.stringify(items, null, 2), 'utf-8');
  }

  async add(collection: string, item: MemoryItem): Promise<void> {
    const items = this.read(collection);
    items.push(item);
    this.write(collection, items);
  }

  async query(collection: string, text: string, limit: number): Promise<RecallResult[]> {
    return this.read(collection)
      .map((item) => ({ ...item, relevance: similarity(text, item.text) }))
      .filter((r) => r.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);
  }

  async remove(collection: string, id: string): Promise<void> {
    const items = this.read(collection).filter((item) => item.id !== id);
    this.write(collection, items);
  }

  async list(collection: string): Promise<MemoryItem[]> {
    return this.read(collection);
  }
}

// ---------------------------------------------------------------------------
// Chroma VectorStore adapter
// ---------------------------------------------------------------------------

interface ChromaCollection {
  id: string;
  name: string;
}

interface ChromaGetResult {
  ids: string[];
  documents: string[];
  metadatas: Array<Record<string, string> | null>;
}

interface ChromaQueryResult {
  ids: string[][];
  documents: string[][];
  metadatas: Array<Array<Record<string, string> | null>>;
  distances: number[][];
}

/**
 * VectorStore adapter backed by a Chroma HTTP server.
 * Requires an `EmbeddingProvider` to embed documents before storage.
 *
 * Usage:
 *   const store = new ChromaVectorStore(new OllamaEmbeddingProvider());
 *   // or for testing:
 *   const store = new ChromaVectorStore(new MockEmbeddingProvider());
 */
export class ChromaVectorStore implements VectorStore {
  private readonly collectionIds = new Map<string, string>();

  constructor(
    private readonly embedder: EmbeddingProvider,
    private readonly baseUrl = 'http://localhost:8000'
  ) {}

  private async ensureCollection(name: string): Promise<string> {
    const cached = this.collectionIds.get(name);
    if (cached) return cached;

    // Try to get the collection first; create it if it doesn't exist.
    const getRes = await fetch(`${this.baseUrl}/api/v1/collections/${encodeURIComponent(name)}`);
    if (getRes.ok) {
      const col = (await getRes.json()) as ChromaCollection;
      this.collectionIds.set(name, col.id);
      return col.id;
    }

    const createRes = await fetch(`${this.baseUrl}/api/v1/collections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, get_or_create: true }),
    });
    if (!createRes.ok) {
      throw new Error(`Chroma create collection error ${createRes.status}: ${await createRes.text()}`);
    }
    const col = (await createRes.json()) as ChromaCollection;
    this.collectionIds.set(name, col.id);
    return col.id;
  }

  async add(collection: string, item: MemoryItem): Promise<void> {
    const colId = await this.ensureCollection(collection);
    const embedding = await this.embedder.embed(item.text);
    const meta: Record<string, string> = {
      ...(item.metadata ?? {}),
      createdAt: item.createdAt,
      text: item.text,
    };
    const res = await fetch(`${this.baseUrl}/api/v1/collections/${colId}/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ids: [item.id],
        embeddings: [embedding],
        documents: [item.text],
        metadatas: [meta],
      }),
    });
    if (!res.ok) {
      throw new Error(`Chroma add error ${res.status}: ${await res.text()}`);
    }
  }

  async query(collection: string, text: string, limit: number): Promise<RecallResult[]> {
    const colId = await this.ensureCollection(collection);
    const embedding = await this.embedder.embed(text);
    const res = await fetch(`${this.baseUrl}/api/v1/collections/${colId}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query_embeddings: [embedding], n_results: limit }),
    });
    if (!res.ok) {
      throw new Error(`Chroma query error ${res.status}: ${await res.text()}`);
    }
    const result = (await res.json()) as ChromaQueryResult;
    const ids = result.ids[0] ?? [];
    const docs = result.documents[0] ?? [];
    const metas = result.metadatas[0] ?? [];
    const dists = result.distances[0] ?? [];
    return ids.map((id, i) => {
      const meta = { ...(metas[i] ?? {}) };
      const createdAt = meta['createdAt'] ?? '';
      delete meta['createdAt'];
      delete meta['text'];
      return {
        id,
        text: docs[i] ?? '',
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
        createdAt,
        relevance: 1 - (dists[i] ?? 1),
      };
    });
  }

  async remove(collection: string, id: string): Promise<void> {
    const colId = await this.ensureCollection(collection);
    const res = await fetch(`${this.baseUrl}/api/v1/collections/${colId}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    if (!res.ok) {
      throw new Error(`Chroma delete error ${res.status}: ${await res.text()}`);
    }
  }

  async list(collection: string): Promise<MemoryItem[]> {
    const colId = await this.ensureCollection(collection);
    const res = await fetch(`${this.baseUrl}/api/v1/collections/${colId}/get`);
    if (!res.ok) {
      throw new Error(`Chroma get error ${res.status}: ${await res.text()}`);
    }
    const result = (await res.json()) as ChromaGetResult;
    return result.ids.map((id, i) => {
      const meta = { ...(result.metadatas[i] ?? {}) };
      const createdAt = meta['createdAt'] ?? '';
      delete meta['createdAt'];
      delete meta['text'];
      return {
        id,
        text: result.documents[i] ?? '',
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
        createdAt,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Memory service
// ---------------------------------------------------------------------------

/**
 * Memory service: every agent owns its own memory, namespaced by package and
 * agent id. Replacing an agent never loses another agent's memory.
 * Memory (accumulated knowledge) is deliberately separate from workflow state.
 *
 * Optional `policies` map lets callers declare retention rules per namespace:
 *   maxItems  — prune oldest items when the collection grows beyond this limit.
 *   maxAgeMs  — exclude items older than this many milliseconds from recall/list.
 */
export class MemoryService {
  constructor(
    private readonly store: VectorStore = new InMemoryVectorStore(),
    private readonly policies: Map<string, NamespacePolicy> = new Map()
  ) {}

  static namespace(packageId: string, agentId: string): string {
    return `${packageId}/${agentId}`;
  }

  /** Register a retention policy for a specific namespace. */
  setPolicy(namespace: string, policy: NamespacePolicy): void {
    this.policies.set(namespace, policy);
  }

  async remember(
    namespace: string,
    text: string,
    metadata?: Record<string, string>
  ): Promise<MemoryItem> {
    const item: MemoryItem = {
      id: randomUUID(),
      text,
      metadata,
      createdAt: new Date().toISOString()
    };
    await this.store.add(namespace, item);
    await this.applyRetention(namespace);
    return item;
  }

  async recall(namespace: string, query: string, limit = 5): Promise<RecallResult[]> {
    const results = await this.store.query(namespace, query, limit * 2);
    return this.applyAgeFilter(namespace, results).slice(0, limit);
  }

  async forget(namespace: string, id: string): Promise<void> {
    return this.store.remove(namespace, id);
  }

  async list(namespace: string): Promise<MemoryItem[]> {
    const items = await this.store.list(namespace);
    return this.applyAgeFilter(namespace, items);
  }

  // ---------------------------------------------------------------------------
  // Retention helpers
  // ---------------------------------------------------------------------------

  private policy(namespace: string): NamespacePolicy {
    return this.policies.get(namespace) ?? {};
  }

  private applyAgeFilter<T extends MemoryItem>(namespace: string, items: T[]): T[] {
    const { maxAgeMs } = this.policy(namespace);
    if (maxAgeMs === undefined) return items;
    const cutoff = Date.now() - maxAgeMs;
    return items.filter((item) => new Date(item.createdAt).getTime() >= cutoff);
  }

  private async applyRetention(namespace: string): Promise<void> {
    const { maxItems } = this.policy(namespace);
    if (maxItems === undefined) return;
    const items = await this.store.list(namespace);
    if (items.length <= maxItems) return;
    // Sort oldest first and remove the excess.
    const sorted = [...items].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    const toRemove = sorted.slice(0, items.length - maxItems);
    for (const item of toRemove) {
      await this.store.remove(namespace, item.id);
    }
  }
}
