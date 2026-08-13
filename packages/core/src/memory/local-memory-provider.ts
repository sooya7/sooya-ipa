import type { MemoryCandidate, MemoryCommitInput, MemoryCommitResult, MemoryEntry, MemoryProvider, MemoryRecall, MemoryRecallInput } from './types.js';

export interface LocalMemoryStore {
  receipt(batchId: string, revision: number): Promise<{ state: MemoryCommitResult['state'] } | null>;
  /** Atomically writes candidates and the completed receipt. */
  commit(input: MemoryCommitInput, candidates: MemoryCandidate[]): Promise<MemoryCommitResult>;
  search(query: string, limit?: number): Promise<MemoryEntry[]>;
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
}

export class LocalMemoryProvider implements MemoryProvider {
  constructor(private readonly options: LocalMemoryProviderOptions) {}

  async wake(): Promise<string | null> { return null; }

  async recall(input: MemoryRecallInput): Promise<MemoryRecall> {
    const entries = await this.options.store.search(input.query, input.limit);
    return { entries, strategy: entries.length ? 'fts' : 'none' };
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

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\u3000,.;:!?，。！？；：、"'()（）]+/gu, '');
}
