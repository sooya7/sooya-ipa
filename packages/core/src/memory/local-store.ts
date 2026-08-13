import type { MemoryRepo, MemoryRow } from '../db/memory.repo.js';
import type { LocalMemoryStore } from './local-memory-provider.js';
import type { MemoryCandidate, MemoryCommitInput, MemoryCommitResult, MemoryEntry } from './types.js';

/** Adapts the SQLite repository to the provider/router contract. */
export class SqliteLocalMemoryStore implements LocalMemoryStore {
  constructor(private readonly repo: MemoryRepo) {}
  async receipt(batchId: string, revision: number): Promise<{ state: MemoryCommitResult['state'] } | null> {
    const value = await this.repo.receipt(batchId, revision);
    return value ? { state: value.state === 'completed' ? 'completed' : value.state === 'skipped' ? 'skipped' : 'uncertain' } : null;
  }
  async commit(input: MemoryCommitInput, candidates: MemoryCandidate[]): Promise<MemoryCommitResult> {
    return await this.repo.commit(input, candidates);
  }
  async search(query: string, limit = 20): Promise<MemoryEntry[]> {
    return (await this.repo.searchFts(query, limit)).flatMap((row) => [{ id: row.id, kind: 'event' as const, content: row.content, normalized: row.content.toLocaleLowerCase(), importance: 0.5, confidence: 0.6, createdAt: '', updatedAt: '', source: 'local' as const }]);
  }
  async list(options: { limit?: number; offset?: number; kind?: MemoryEntry['kind'] } = {}): Promise<MemoryEntry[]> { return (await this.repo.list(options)).map(toEntry); }
  async update(id: string, patch: { content?: string; importance?: number; confidence?: number }): Promise<MemoryEntry | null> { const row = await this.repo.update(id, patch); return row ? toEntry(row) : null; }
  async forget(id: string): Promise<boolean> { return await this.repo.forget(id); }
  async maintain(): Promise<{ removed: number; reembedded: number }> { return await this.repo.maintain(); }
}

function toEntry(row: MemoryRow): MemoryEntry {
  return { id: row.id, kind: row.kind === 'summary' ? 'event' : row.kind, content: row.content, normalized: row.normalized, importance: row.importance, confidence: row.confidence, createdAt: row.created_at, updatedAt: row.updated_at, source: row.source, sourceId: row.source_id ?? undefined, sourceHash: row.source_hash ?? undefined };
}
