import { randomUUID } from 'node:crypto';

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

/**
 * Memory service: every agent owns its own memory, namespaced by package and
 * agent id. Replacing an agent never loses another agent's memory.
 * Memory (accumulated knowledge) is deliberately separate from workflow state.
 */
export class MemoryService {
  constructor(private readonly store: VectorStore = new InMemoryVectorStore()) {}

  static namespace(packageId: string, agentId: string): string {
    return `${packageId}/${agentId}`;
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
    return item;
  }

  async recall(namespace: string, query: string, limit = 5): Promise<RecallResult[]> {
    return this.store.query(namespace, query, limit);
  }

  async forget(namespace: string, id: string): Promise<void> {
    return this.store.remove(namespace, id);
  }

  async list(namespace: string): Promise<MemoryItem[]> {
    return this.store.list(namespace);
  }
}
