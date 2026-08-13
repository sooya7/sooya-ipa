import type { MemoryCandidate, MemoryCommitInput, MemoryCommitResult, MemoryEntry, MemoryProvider, MemoryRecall, MemoryRecallInput } from './types.js';
import type { EmbeddingProvider, RerankProvider } from '../providers/types.js';

export interface LocalMemoryStore {
  receipt(batchId: string, revision: number): Promise<{ state: MemoryCommitResult['state'] } | null>;
  /** Atomically writes candidates and the completed receipt. */
  commit(input: MemoryCommitInput, candidates: MemoryCandidate[]): Promise<MemoryCommitResult>;
  search(query: string, limit?: number): Promise<MemoryEntry[]>;
  searchHybrid?(query: string, queryEmbedding?: number[], limit?: number): Promise<MemoryEntry[]>;
  list(options?: { limit?: number; offset?: number; kind?: MemoryEntry['kind'] }): Promise<MemoryEntry[]>;
  update(id: string, patch: { content?: string; importance?: number; confidence?: number }): Promise<MemoryEntry | null>;
  forget(id: string): Promise<boolean>;
  maintain(signal?: AbortSignal): Promise<{ removed: number; reembedded: number }>;
}

export interface LocalMemoryProviderOptions {
  store: LocalMemoryStore;
  extract(input: MemoryCommitInput): Promise<MemoryCandidate[]>;
  currentRevision(batchId: string): Promise<number | null>;
  hash?: (value: string) => Promise<string> | string;
  embeddingProvider?: EmbeddingProvider | null | (() => Promise<EmbeddingProvider | null>);
  rerankProvider?: RerankProvider | null | (() => Promise<RerankProvider | null>);
}

export class LocalMemoryProvider implements MemoryProvider {
  constructor(private readonly options: LocalMemoryProviderOptions) {}

  async wake(): Promise<string | null> { return null; }

  async recall(input: MemoryRecallInput): Promise<MemoryRecall> {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error('memory recall aborted');
    const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 20)));
    const embedding = await resolve(this.options.embeddingProvider);
    let vector: number[] | undefined;
    if (embedding?.configured) {
      try { vector = (await embedding.embed([input.query], input.signal)).vectors[0]; } catch { vector = undefined; }
    }
    let entries = this.options.store.searchHybrid
      ? await this.options.store.searchHybrid(input.query, vector, limit * 2)
      : await this.options.store.search(input.query, limit * 2);
    const rerank = await resolve(this.options.rerankProvider);
    let strategy: MemoryRecall['strategy'] = vector ? 'embedding' : 'fts';
    if (rerank?.configured && entries.length > 1) {
      try {
        const matches = await rerank.rerank(input.query, entries.map((entry) => entry.content), input.signal);
        const scoreByIndex = new Map(matches.map((match) => [match.index, match.score]));
        entries = entries.map((entry, index) => ({ ...entry, score: scoreByIndex.get(index) ?? entry.score ?? 0 })).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        strategy = vector ? 'hybrid' : 'fts';
      } catch { strategy = vector ? 'embedding' : 'fts'; }
    }
    return { entries: entries.slice(0, limit), strategy: entries.length ? strategy : 'none' };
  }

  async commit(input: MemoryCommitInput): Promise<MemoryCommitResult> {
    const receipt = await this.options.store.receipt(input.batchId, input.revision);
    if (receipt?.state === 'completed' || receipt?.state === 'skipped') return { state: receipt.state, inserted: 0, merged: 0 };
    const current = await this.options.currentRevision(input.batchId);
    if (current !== null && current !== input.revision) {
      return { state: 'skipped', inserted: 0, merged: 0, reason: 'superseded_revision' };
    }
    const extracted = await this.options.extract(input);
    if (extracted.length === 0) return this.options.store.commit(input, []);
    const candidates = await Promise.all(extracted.map(async (candidate) => ({
      ...candidate,
      content: candidate.content.trim(),
      sourceHash: candidate.sourceHash ?? await this.hash(`${input.batchId}:${input.revision}:${normalize(candidate.content)}`)
    })));
    const embedding = await resolve(this.options.embeddingProvider);
    if (embedding?.configured && candidates.length > 0) {
      try {
        const result = await embedding.embed(candidates.map((candidate) => candidate.content), input.signal);
        return this.options.store.commit(input, candidates.map((candidate, index) => ({
          ...candidate,
          ...(result.vectors[index]?.length ? { embedding: result.vectors[index], embeddingModel: result.model } : {})
        })));
      } catch {
        // A provider outage must not turn a successful local memory commit into
        // a failed chat; the next maintenance pass can re-embed it.
      }
    }
    return this.options.store.commit(input, candidates);
  }

  search(query: string, limit?: number): Promise<MemoryEntry[]> { return this.options.store.search(query, limit); }
  list(options?: { limit?: number; offset?: number; kind?: MemoryEntry['kind'] }): Promise<MemoryEntry[]> { return this.options.store.list(options); }
  update(id: string, patch: { content?: string; importance?: number; confidence?: number }): Promise<MemoryEntry | null> { return this.options.store.update(id, patch); }
  forget(id: string): Promise<boolean> { return this.options.store.forget(id); }
  maintain(signal?: AbortSignal): Promise<{ removed: number; reembedded: number }> { return this.options.store.maintain(signal); }
  async health() { return { state: 'ready' as const, provider: 'local' }; }

  private async hash(value: string): Promise<string> {
    if (this.options.hash) return this.options.hash(value);
    const bytes = new TextEncoder().encode(value);
    if (globalThis.crypto?.subtle) {
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
      return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    // Stable non-secret fallback for runtimes lacking Web Crypto. Native builds have it.
    let h = 2166136261;
    for (const byte of bytes) h = Math.imul(h ^ byte, 16777619);
    return `fnv1a-${(h >>> 0).toString(16).padStart(8, '0')}`;
  }
}

async function resolve<T>(value: T | null | undefined | (() => Promise<T | null>)): Promise<T | null> {
  return typeof value === 'function' ? await (value as () => Promise<T | null>)() : value ?? null;
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\u3000,.;:!?，。！？；：、"'()（）]+/gu, '');
}
