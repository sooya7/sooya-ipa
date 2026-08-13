import type { MemoryCommitInput, MemoryCommitResult, MemoryEntry, MemoryProvider, MemoryRecall, MemoryRecallInput } from './types.js';
import type { MemorySyncCoordinator } from './sync-types.js';

export type MemoryMode = 'local' | 'mcp' | 'hybrid';

export class MemoryRouter implements MemoryProvider {
  readonly mode: MemoryMode;
  private readonly selected: MemoryProvider;

  constructor(options: { local: MemoryProvider; mcp?: MemoryProvider; mode?: MemoryMode; mirrorWrites?: boolean; sync?: MemorySyncCoordinator; remoteEnabled?: () => Promise<boolean> }) {
    this.mode = options.mode ?? 'local';
    if (this.mode === 'mcp') {
      if (!options.mcp) throw new Error('MCP memory provider is not configured');
      this.selected = options.mcp;
    } else if (this.mode === 'hybrid') {
      if (!options.mcp) throw new Error('MCP memory provider is not configured');
      this.selected = new HybridMemoryProvider({ local: options.local, remote: options.mcp, mirrorWrites: options.mirrorWrites, sync: options.sync, remoteEnabled: options.remoteEnabled });
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
  private remoteFailureCount = 0;
  private remoteOpenUntil = 0;

  constructor(private readonly options: { local: MemoryProvider; remote: MemoryProvider; mirrorWrites?: boolean; sync?: MemorySyncCoordinator; remoteEnabled?: () => Promise<boolean> }) {}

  async wake(signal?: AbortSignal): Promise<string | null> {
    const local = await this.options.local.wake(signal);
    if (!(await this.remoteIsAvailable())) return local;
    const remote = await Promise.allSettled([this.options.remote.wake(signal)]);
    if (remote[0]?.status === 'fulfilled') { this.markRemoteSuccess(); return local ?? remote[0].value; }
    this.markRemoteFailure();
    return local;
  }

  async recall(input: MemoryRecallInput): Promise<MemoryRecall> {
    const localPromise = this.options.local.recall(input);
    const remoteEnabled = await this.remoteIsAvailable();
    const [local, remote] = await Promise.all([
      localPromise.then((value) => ({ status: 'fulfilled' as const, value }), (reason) => ({ status: 'rejected' as const, reason })),
      remoteEnabled
        ? this.options.remote.recall(input).then((value) => ({ status: 'fulfilled' as const, value }), (reason) => ({ status: 'rejected' as const, reason }))
        : Promise.resolve({ status: 'skipped' as const })
    ]);
    if (local.status === 'rejected' && remote.status === 'rejected') throw local.reason;
    if (remote.status === 'fulfilled') this.markRemoteSuccess();
    if (remote.status === 'rejected') this.markRemoteFailure();
    const merged = dedupe([
      ...(remote.status === 'fulfilled' ? remote.value.entries : []),
      ...(local.status === 'fulfilled' ? local.value.entries : [])
    ]).slice(0, input.limit ?? 20);
    const degraded = local.status === 'rejected' || remote.status === 'rejected';
    return { entries: merged, strategy: degraded || !remoteEnabled ? 'hybrid-degraded' : 'hybrid' };
  }

  async commit(input: MemoryCommitInput): Promise<MemoryCommitResult> {
    const local = await this.options.local.commit(input);
    if (local.state === 'completed' && this.options.sync) {
      void this.options.sync.enqueueLocalChanges()
        .then(() => this.options.sync!.syncOnce(input.signal))
        .catch(() => undefined);
    }
    if (!this.options.mirrorWrites || local.state !== 'completed' || !(await this.remoteIsAvailable())) return local;
    try { await this.options.remote.commit(input); this.markRemoteSuccess(); } catch { this.markRemoteFailure(); /* local is authoritative */ }
    return local;
  }

  async search(query: string, limit?: number): Promise<MemoryEntry[]> { return (await this.recall({ query, limit })).entries; }
  list(options?: { limit?: number; offset?: number; kind?: MemoryEntry['kind'] }): Promise<MemoryEntry[]> { return this.options.local.list(options); }
  async update(id: string, patch: { content?: string; importance?: number; confidence?: number }): Promise<MemoryEntry | null> {
    const result = await this.options.local.update(id, patch);
    if (result && this.options.sync) void this.options.sync.noteLocalUpdate(id).catch(() => undefined);
    return result;
  }
  async forget(id: string): Promise<boolean> {
    const result = await this.options.local.forget(id);
    if (result && this.options.sync) void this.options.sync.noteLocalForget(id).catch(() => undefined);
    return result;
  }
  maintain(signal?: AbortSignal): Promise<{ removed: number; reembedded: number }> { return this.options.local.maintain(signal); }
  async health() {
    const local = await this.options.local.health();
    if (!(await this.remoteIsAvailable())) return { state: local.state, provider: 'hybrid', detail: 'Ombre MCP not configured' };
    const remote = await this.options.remote.health();
    if (remote.state === 'ready') this.markRemoteSuccess(); else this.markRemoteFailure();
    return { state: local.state === 'ready' ? (remote.state === 'ready' ? 'ready' as const : 'degraded' as const) : 'unavailable' as const, provider: 'hybrid', detail: remote.detail };
  }

  private async remoteIsAvailable(): Promise<boolean> {
    if (Date.now() < this.remoteOpenUntil) return false;
    if (this.options.remoteEnabled) {
      try {
        if (!(await this.options.remoteEnabled())) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private markRemoteSuccess(): void { this.remoteFailureCount = 0; this.remoteOpenUntil = 0; }
  private markRemoteFailure(): void {
    this.remoteFailureCount += 1;
    if (this.remoteFailureCount >= 3) this.remoteOpenUntil = Date.now() + 30_000;
  }
}

function dedupe(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>();
  return [...entries]
    .sort((a, b) => {
      const remotePriority = Number(b.source === 'ombre') - Number(a.source === 'ombre');
      return remotePriority || (b.score ?? b.importance) - (a.score ?? a.importance);
    })
    .filter((entry) => {
      const key = entry.sourceId ? `source:${entry.sourceId}` : entry.sourceHash ? `hash:${entry.sourceHash}` : entry.normalized || entry.content.toLocaleLowerCase().replace(/\s+/gu, '');
      const contentKey = entry.normalized || entry.content.toLocaleLowerCase().replace(/\s+/gu, '');
      if (seen.has(key) || seen.has(`content:${contentKey}`)) return false;
      seen.add(key);
      seen.add(`content:${contentKey}`);
      return true;
    });
}
