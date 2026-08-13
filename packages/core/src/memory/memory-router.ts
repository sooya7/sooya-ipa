import type { MemoryCommitInput, MemoryCommitResult, MemoryEntry, MemoryProvider, MemoryRecall, MemoryRecallInput } from './types.js';

export type MemoryMode = 'local' | 'mcp' | 'hybrid';

export class MemoryRouter implements MemoryProvider {
  readonly mode: MemoryMode;
  private readonly selected: MemoryProvider;

  constructor(options: { local: MemoryProvider; mcp?: MemoryProvider; mode?: MemoryMode; mirrorWrites?: boolean }) {
    this.mode = options.mode ?? 'local';
    if (this.mode === 'mcp') {
      if (!options.mcp) throw new Error('MCP memory provider is not configured');
      this.selected = options.mcp;
    } else if (this.mode === 'hybrid') {
      if (!options.mcp) throw new Error('MCP memory provider is not configured');
      this.selected = new HybridMemoryProvider({ local: options.local, remote: options.mcp, mirrorWrites: options.mirrorWrites });
    } else this.selected = options.local;
  }

  wake(signal?: AbortSignal) { return this.selected.wake(signal); }
  recall(input: MemoryRecallInput) { return this.selected.recall(input); }
  commit(input: MemoryCommitInput) { return this.selected.commit(input); }
  search(query: string, limit?: number) { return this.selected.search(query, limit); }
  list(options?: { limit?: number; offset?: number; kind?: MemoryEntry['kind'] }) { return this.selected.list(options); }
  update(id: string, patch: { content?: string; importance?: number; confidence?: number }) { return this.selected.update(id, patch); }
  forget(id: string) { return this.selected.forget(id); }
  maintain(signal?: AbortSignal) { return this.selected.maintain(signal); }
  health() { return this.selected.health(); }
}

export class HybridMemoryProvider implements MemoryProvider {
  constructor(private readonly options: { local: MemoryProvider; remote: MemoryProvider; mirrorWrites?: boolean }) {}

  async wake(signal?: AbortSignal): Promise<string | null> {
    const [local, remote] = await Promise.allSettled([this.options.local.wake(signal), this.options.remote.wake(signal)]);
    return local.status === 'fulfilled' && local.value ? local.value : remote.status === 'fulfilled' ? remote.value : null;
  }

  async recall(input: MemoryRecallInput): Promise<MemoryRecall> {
    const [local, remote] = await Promise.allSettled([this.options.local.recall(input), this.options.remote.recall(input)]);
    if (local.status === 'rejected' && remote.status === 'rejected') throw local.reason;
    const merged = dedupe([
      ...(local.status === 'fulfilled' ? local.value.entries : []),
      ...(remote.status === 'fulfilled' ? remote.value.entries : [])
    ]).slice(0, input.limit ?? 20);
    const degraded = local.status === 'rejected' || remote.status === 'rejected';
    return { entries: merged, strategy: degraded ? 'hybrid-degraded' : 'hybrid' };
  }

  async commit(input: MemoryCommitInput): Promise<MemoryCommitResult> {
    const local = await this.options.local.commit(input);
    if (!this.options.mirrorWrites || local.state !== 'completed') return local;
    try { await this.options.remote.commit(input); } catch { /* local is authoritative */ }
    return local;
  }

  async search(query: string, limit?: number): Promise<MemoryEntry[]> { return (await this.recall({ query, limit })).entries; }
  list(options?: { limit?: number; offset?: number; kind?: MemoryEntry['kind'] }): Promise<MemoryEntry[]> { return this.options.local.list(options); }
  update(id: string, patch: { content?: string; importance?: number; confidence?: number }): Promise<MemoryEntry | null> { return this.options.local.update(id, patch); }
  forget(id: string): Promise<boolean> { return this.options.local.forget(id); }
  maintain(signal?: AbortSignal): Promise<{ removed: number; reembedded: number }> { return this.options.local.maintain(signal); }
  async health() {
    const [local, remote] = await Promise.allSettled([this.options.local.health(), this.options.remote.health()]);
    return { state: local.status === 'fulfilled' ? (remote.status === 'fulfilled' ? 'ready' as const : 'degraded' as const) : 'unavailable' as const, provider: 'hybrid' };
  }
}

function dedupe(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>();
  return [...entries]
    .sort((a, b) => (b.score ?? b.importance) - (a.score ?? a.importance))
    .filter((entry) => {
      const key = entry.normalized || entry.content.toLocaleLowerCase().replace(/\s+/gu, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
