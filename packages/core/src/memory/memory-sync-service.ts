import type { MemoryRepo, MemoryRow } from '../db/memory.repo.js';
import { MemorySyncRepository, type MemorySyncOutboxRow } from '../db/memory-sync.repo.js';
import type { MemoryEntry } from './types.js';
import type { MemorySyncCoordinator, MemorySyncResult, MemorySyncStatus } from './sync-types.js';
import type { OmbreMcpMemoryProvider } from './ombre-mcp-memory-provider.js';

const TOMBSTONE_TTL_MS = 60 * 86_400_000;

/**
 * Durable, best-effort synchronizer. Local SQLite writes stay authoritative;
 * this service only adds outbox work and never makes a chat reply depend on
 * Ombre availability.
 */
export class MemorySyncService implements MemorySyncCoordinator {
  private running: Promise<MemorySyncResult> | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: {
    local: MemoryRepo;
    sync: MemorySyncRepository;
    remote: OmbreMcpMemoryProvider;
    now?: () => Date;
  }) {}

  async enqueueLocalChanges(limit = 500): Promise<void> {
    const rows = await this.options.local.list({ limit });
    for (const row of rows) {
      const state = await this.options.sync.state(row.id);
      if (state?.sync_state === 'conflict') continue;
      if (!state || state.sync_state !== 'synced' || !state.last_synced_at || row.updated_at > state.last_synced_at) {
        await this.enqueueRow(row);
      }
    }
  }

  async noteLocalUpdate(id: string): Promise<void> {
    const row = await this.options.local.get(id);
    if (row) await this.enqueueRow(row);
  }

  async noteLocalForget(id: string): Promise<void> {
    const row = await this.options.local.get(id);
    const state = await this.options.sync.state(id);
    const sourceId = state?.remote_source_id ?? row?.source_id ?? id;
    const sourceHash = state ? null : row?.source_hash ?? null;
    const now = (this.options.now ?? (() => new Date()))();
    await this.options.sync.upsertTombstone({
      sourceId,
      localMemoryId: id,
      sourceHash,
      remoteRevision: state?.remote_revision,
      expiresAt: new Date(now.getTime() + TOMBSTONE_TTL_MS).toISOString()
    });
    await this.options.sync.enqueue({
      localMemoryId: id,
      remoteSourceId: sourceId,
      operation: 'forget',
      payload: { sourceId, localMemoryId: id, sourceHash }
    });
  }

  async forgetLocal(id: string): Promise<boolean> {
    const row = await this.options.local.get(id);
    if (!row || row.active !== 1) return false;
    const state = await this.options.sync.state(id);
    const sourceId = state?.remote_source_id ?? row.source_id ?? id;
    const sourceHash = state ? null : row.source_hash ?? null;
    const now = (this.options.now ?? (() => new Date()))();
    return (await this.options.sync.forgetLocal([{
      localMemoryId: id,
      sourceId,
      sourceHash,
      remoteRevision: state?.remote_revision,
      expiresAt: new Date(now.getTime() + TOMBSTONE_TTL_MS).toISOString()
    }])) === 1;
  }

  async clearLocal(): Promise<number> {
    const rows = await this.options.local.activeRows();
    const now = (this.options.now ?? (() => new Date()))();
    const inputs = await Promise.all(rows.map(async (row) => {
      const state = await this.options.sync.state(row.id);
      return {
        localMemoryId: row.id,
        sourceId: state?.remote_source_id ?? row.source_id ?? row.id,
        sourceHash: state ? null : row.source_hash ?? null,
        remoteRevision: state?.remote_revision,
        expiresAt: new Date(now.getTime() + TOMBSTONE_TTL_MS).toISOString()
      };
    }));
    return await this.options.sync.forgetLocal(inputs);
  }

  async syncOnce(signal?: AbortSignal): Promise<MemorySyncResult> {
    if (this.running) return await this.running;
    this.running = this.run(signal).finally(() => { this.running = null; });
    return await this.running;
  }

  async status(): Promise<MemorySyncStatus> {
    const counts = await this.options.sync.status();
    const health = await this.options.remote.health();
    const state = health.state === 'ready' ? (this.lastError ? 'degraded' : 'ready') : health.state;
    return {
      state,
      provider: 'ombre-sync',
      pendingPush: counts.pendingPush,
      pendingPull: counts.pendingPull,
      conflicts: counts.conflicts,
      lastSyncAt: counts.lastSyncAt,
      ...(this.lastError ? { detail: this.lastError } : health.detail ? { detail: health.detail } : {})
    };
  }

  private async run(signal?: AbortSignal): Promise<MemorySyncResult> {
    await this.enqueueLocalChanges();
    let pulled = 0;
    let pushed = 0;
    let conflicts = 0;
    let pullError: string | null = null;
    const health = await this.options.remote.health();
    if (health.state === 'unavailable') {
      this.lastError = health.detail ?? 'Ombre MCP unavailable';
      return { state: 'unavailable', pushed: 0, pulled: 0, conflicts: 0, pending: (await this.options.sync.status()).pendingPush, detail: this.lastError };
    }

    const cursor = await this.options.sync.getCursor('ombre');
    try {
      const page = await this.options.remote.pullChanges(cursor, 100, signal);
      for (const entry of page.entries) {
        if (signal?.aborted) throw signal.reason ?? new Error('memory sync aborted');
        if (await this.options.sync.tombstone(entry.sourceId ?? entry.id)) continue;
        const applied = await this.applyRemote(entry);
        if (applied === 'conflict') conflicts += 1;
        else if (applied === 'applied') pulled += 1;
      }
      await this.options.sync.setCursor('ombre', page.nextCursor);
    } catch (error) {
      pullError = safeError(error);
    }

    for (const row of await this.options.sync.pending(50)) {
      if (signal?.aborted) throw signal.reason ?? new Error('memory sync aborted');
      const result = await this.pushRow(row, signal);
      if (result === 'pushed') pushed += 1;
    }
    await this.options.sync.pruneTombstones();
    const status = await this.options.sync.status();
    this.lastError = pullError;
    return {
      state: pullError ? 'degraded' : status.conflicts ? 'degraded' : 'ready',
      pushed,
      pulled,
      conflicts: status.conflicts + conflicts,
      pending: status.pendingPush,
      ...(pullError ? { detail: pullError } : {})
    };
  }

  private async enqueueRow(row: MemoryRow): Promise<void> {
    await this.options.sync.enqueue({
      localMemoryId: row.id,
      remoteSourceId: row.source === 'ombre' ? row.source_id : null,
      operation: 'upsert',
      payload: toEntry(row) as unknown as Record<string, unknown>
    });
  }

  private async applyRemote(entry: MemoryEntry): Promise<'applied' | 'unchanged' | 'conflict'> {
    const sourceId = entry.sourceId ?? entry.id;
    const state = await this.options.sync.stateByRemoteId(sourceId);
    const local = state ? await this.options.local.get(state.local_memory_id) : await this.options.local.findBySourceId(sourceId);
    if (local && state?.last_synced_at && local.updated_at > state.last_synced_at && local.content !== entry.content) {
      await this.options.sync.setState({ localMemoryId: local.id, remoteSourceId: sourceId, remoteRevision: entry.remoteRevision, state: 'conflict', error: 'local and Ombre changed after the last sync' });
      return 'conflict';
    }
    if (local && isUnchangedRemote(local, state?.remote_revision ?? null, entry)) return 'unchanged';
    const result = await this.options.local.upsertMirrored({
      kind: entry.kind,
      content: entry.content,
      importance: entry.importance,
      confidence: entry.confidence,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      sourceId,
      sourceHash: entry.sourceHash ?? null
    });
    await this.options.sync.setState({ localMemoryId: result.record.id, remoteSourceId: sourceId, remoteRevision: entry.remoteRevision, state: 'synced', lastSyncedAt: (this.options.now ?? (() => new Date()))().toISOString(), error: null });
    return 'applied';
  }

  private async pushRow(row: MemorySyncOutboxRow, signal?: AbortSignal): Promise<'pushed' | 'skipped'> {
    const running = await this.options.sync.markRunning(row.id);
    if (!running) return 'skipped';
    const state = await this.options.sync.state(running.local_memory_id);
    if (state?.sync_state === 'conflict') {
      await this.options.sync.markFailed(running.id, 'conflict requires manual resolution', false);
      return 'skipped';
    }
    try {
      const payload = this.options.sync.parsePayload(running);
      if (running.operation === 'forget') {
        const sourceId = running.remote_source_id ?? stringValue(payload, 'sourceId') ?? running.local_memory_id;
        await this.options.remote.forgetRemote(sourceId, signal);
        await this.options.sync.upsertTombstone({ sourceId, localMemoryId: running.local_memory_id, sourceHash: stringValue(payload, 'sourceHash'), expiresAt: new Date((this.options.now ?? (() => new Date()))().getTime() + TOMBSTONE_TTL_MS).toISOString(), synced: true });
        await this.options.sync.setState({ localMemoryId: running.local_memory_id, remoteSourceId: sourceId, state: 'synced', lastSyncedAt: (this.options.now ?? (() => new Date()))().toISOString(), error: null });
      } else {
        const entry = entryFromPayload(payload);
        if (!entry) throw new Error('invalid memory sync payload');
        const remote = await this.options.remote.upsertEntry(entry, signal);
        await this.options.sync.setState({ localMemoryId: running.local_memory_id, remoteSourceId: remote.sourceId ?? entry.sourceId ?? entry.id, remoteRevision: remote.remoteRevision, state: 'synced', lastSyncedAt: (this.options.now ?? (() => new Date()))().toISOString(), error: null });
      }
      await this.options.sync.markDone(running.id);
      return 'pushed';
    } catch (error) {
      await this.options.sync.markFailed(running.id, safeError(error));
      return 'skipped';
    }
  }
}

function isUnchangedRemote(local: MemoryRow, syncedRevision: string | null, entry: MemoryEntry): boolean {
  const remoteRevision = entry.remoteRevision == null ? null : String(entry.remoteRevision);
  if (syncedRevision && remoteRevision && syncedRevision === remoteRevision) return true;
  if (entry.sourceHash && local.source_hash === entry.sourceHash) return true;
  return local.source === 'ombre'
    && local.content === entry.content
    && local.normalized === entry.normalized
    && local.importance === entry.importance
    && local.confidence === entry.confidence
    && local.updated_at === entry.updatedAt;
}

function toEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    normalized: row.normalized,
    importance: row.importance,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: row.source,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    ...(row.source_hash ? { sourceHash: row.source_hash } : {})
  };
}

function entryFromPayload(value: Record<string, unknown>): MemoryEntry | null {
  if (typeof value.content !== 'string' || !value.content.trim() || typeof value.id !== 'string') return null;
  return {
    id: value.id,
    kind: value.kind === 'profile' || value.kind === 'preference' || value.kind === 'relationship' || value.kind === 'project' || value.kind === 'event' || value.kind === 'summary' ? value.kind : 'summary',
    content: value.content,
    normalized: typeof value.normalized === 'string' ? value.normalized : value.content.toLocaleLowerCase().replace(/[\s\u3000]+/gu, ''),
    importance: numberValue(value.importance, 0.6),
    confidence: numberValue(value.confidence, 0.6),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
    source: typeof value.source === 'string' ? value.source : 'local',
    ...(typeof value.sourceId === 'string' ? { sourceId: value.sourceId } : {}),
    ...(typeof value.sourceHash === 'string' ? { sourceHash: value.sourceHash } : {})
  };
}

function numberValue(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function stringValue(value: Record<string, unknown>, key: string): string | null { return typeof value[key] === 'string' ? value[key] : null; }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+[^\s]+/giu, 'Bearer [REDACTED_SECRET]').slice(0, 500); }
