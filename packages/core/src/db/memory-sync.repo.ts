import type { LocalDatabase } from '../platform/database.js';
import { newId, nowIso, queryOne, safeJson } from './database.js';
import type { MemorySyncOperation, MemorySyncState } from '../memory/sync-types.js';

export interface MemorySyncStateRow {
  local_memory_id: string;
  remote_source_id: string | null;
  remote_revision: string | null;
  sync_state: MemorySyncState;
  last_synced_at: string | null;
  sync_error: string | null;
  updated_at: string;
}

export interface MemorySyncOutboxRow {
  id: string;
  local_memory_id: string;
  remote_source_id: string | null;
  operation: MemorySyncOperation;
  payload_json: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryTombstoneRow {
  source_id: string;
  local_memory_id: string | null;
  source_hash: string | null;
  remote_revision: string | null;
  deleted_at: string;
  expires_at: string;
  synced: number;
}

export class MemorySyncRepository {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}

  async state(localMemoryId: string): Promise<MemorySyncStateRow | undefined> {
    return await queryOne<MemorySyncStateRow>(this.db, 'SELECT * FROM memory_sync_state WHERE local_memory_id=?', [localMemoryId]);
  }

  async stateByRemoteId(remoteSourceId: string): Promise<MemorySyncStateRow | undefined> {
    return await queryOne<MemorySyncStateRow>(this.db, 'SELECT * FROM memory_sync_state WHERE remote_source_id=?', [remoteSourceId]);
  }

  async setState(input: {
    localMemoryId: string;
    remoteSourceId?: string | null;
    remoteRevision?: string | number | null;
    state: MemorySyncState;
    lastSyncedAt?: string | null;
    error?: string | null;
  }): Promise<void> {
    const timestamp = nowIso(this.now);
    await this.db.run(
      `INSERT INTO memory_sync_state(local_memory_id,remote_source_id,remote_revision,sync_state,last_synced_at,sync_error,updated_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(local_memory_id) DO UPDATE SET remote_source_id=excluded.remote_source_id,
       remote_revision=excluded.remote_revision,sync_state=excluded.sync_state,last_synced_at=excluded.last_synced_at,
       sync_error=excluded.sync_error,updated_at=excluded.updated_at`,
      [input.localMemoryId, input.remoteSourceId ?? null, input.remoteRevision == null ? null : String(input.remoteRevision), input.state,
        input.lastSyncedAt ?? null, input.error?.slice(0, 1000) ?? null, timestamp]
    );
  }

  async enqueue(input: {
    localMemoryId: string;
    remoteSourceId?: string | null;
    operation: MemorySyncOperation;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const timestamp = nowIso(this.now);
    const existing = await queryOne<{ id: string }>(this.db,
      `SELECT id FROM memory_sync_outbox WHERE local_memory_id=? AND operation=? AND status IN ('pending','running','failed') ORDER BY created_at DESC LIMIT 1`,
      [input.localMemoryId, input.operation]);
    if (existing) {
      await this.db.run(
        `UPDATE memory_sync_outbox SET remote_source_id=?,payload_json=?,status='pending',last_error=NULL,next_attempt_at=NULL,updated_at=? WHERE id=?`,
        [input.remoteSourceId ?? null, JSON.stringify(input.payload), timestamp, existing.id]
      );
    } else {
      await this.db.run(
        `INSERT INTO memory_sync_outbox(id,local_memory_id,remote_source_id,operation,payload_json,status,attempts,last_error,next_attempt_at,created_at,updated_at)
         VALUES(?,?,?,?,?,'pending',0,NULL,NULL,?,?)`,
        [newId('memory-sync'), input.localMemoryId, input.remoteSourceId ?? null, input.operation, JSON.stringify(input.payload), timestamp, timestamp]
      );
    }
    await this.setState({ localMemoryId: input.localMemoryId, remoteSourceId: input.remoteSourceId, state: 'pending_push', error: null });
  }

  async pending(limit = 50): Promise<MemorySyncOutboxRow[]> {
    return await this.db.query<MemorySyncOutboxRow>(
      `SELECT * FROM memory_sync_outbox WHERE status IN ('pending','failed')
       AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at ASC LIMIT ?`,
      [nowIso(this.now), Math.max(1, Math.min(200, Math.trunc(limit)))]
    );
  }

  async markRunning(id: string): Promise<MemorySyncOutboxRow | undefined> {
    await this.db.run("UPDATE memory_sync_outbox SET status='running',attempts=attempts+1,updated_at=? WHERE id=? AND status IN ('pending','failed')", [nowIso(this.now), id]);
    return await queryOne<MemorySyncOutboxRow>(this.db, 'SELECT * FROM memory_sync_outbox WHERE id=?', [id]);
  }

  async markDone(id: string): Promise<void> {
    await this.db.run("UPDATE memory_sync_outbox SET status='done',last_error=NULL,next_attempt_at=NULL,updated_at=? WHERE id=?", [nowIso(this.now), id]);
  }

  async markFailed(id: string, error: string, retryable = true): Promise<void> {
    const row = await queryOne<{ attempts: number; local_memory_id: string }>(this.db, 'SELECT attempts,local_memory_id FROM memory_sync_outbox WHERE id=?', [id]);
    if (!row) return;
    const delay = Math.min(60 * 60_000, Math.max(2_000, 2_000 * 2 ** Math.min(row.attempts, 8)));
    const next = retryable && row.attempts < 8
      ? new Date(this.now().getTime() + delay).toISOString()
      : new Date(this.now().getTime() + 24 * 60 * 60_000).toISOString();
    await this.db.run("UPDATE memory_sync_outbox SET status='failed',last_error=?,next_attempt_at=?,updated_at=? WHERE id=?", [error.slice(0, 1000), next, nowIso(this.now), id]);
    await this.setState({ localMemoryId: row.local_memory_id, state: 'error', error });
  }

  async setCursor(name: string, cursor: string | null): Promise<void> {
    await this.db.run(
      `INSERT INTO memory_sync_cursors(name,cursor,updated_at) VALUES(?,?,?)
       ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at`,
      [name, cursor, nowIso(this.now)]
    );
  }

  async getCursor(name: string): Promise<string | null> {
    return (await queryOne<{ cursor: string | null }>(this.db, 'SELECT cursor FROM memory_sync_cursors WHERE name=?', [name]))?.cursor ?? null;
  }

  async upsertTombstone(input: { sourceId: string; localMemoryId?: string | null; sourceHash?: string | null; remoteRevision?: string | number | null; expiresAt: string; synced?: boolean }): Promise<void> {
    await this.db.run(
      `INSERT INTO memory_tombstones(source_id,local_memory_id,source_hash,remote_revision,deleted_at,expires_at,synced)
       VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET local_memory_id=excluded.local_memory_id,
       source_hash=excluded.source_hash,remote_revision=excluded.remote_revision,deleted_at=excluded.deleted_at,
       expires_at=excluded.expires_at,synced=excluded.synced`,
      [input.sourceId, input.localMemoryId ?? null, input.sourceHash ?? null, input.remoteRevision == null ? null : String(input.remoteRevision), nowIso(this.now), input.expiresAt, input.synced ? 1 : 0]
    );
  }

  async tombstone(sourceId: string): Promise<MemoryTombstoneRow | undefined> {
    return await queryOne<MemoryTombstoneRow>(this.db, 'SELECT * FROM memory_tombstones WHERE source_id=? AND expires_at>?', [sourceId, nowIso(this.now)]);
  }

  async pruneTombstones(): Promise<number> {
    return (await this.db.run('DELETE FROM memory_tombstones WHERE expires_at<=?', [nowIso(this.now)])).changes;
  }

  async status(): Promise<{ pendingPush: number; pendingPull: number; conflicts: number; lastSyncAt: string | null }> {
    const counts = await queryOne<{ pending_push: number; conflicts: number }>(this.db,
      `SELECT COALESCE(SUM(CASE WHEN sync_state IN ('pending_push','error') THEN 1 ELSE 0 END),0) pending_push,
       COALESCE(SUM(CASE WHEN sync_state='conflict' THEN 1 ELSE 0 END),0) conflicts FROM memory_sync_state`);
    const cursor = await queryOne<{ updated_at: string }>(this.db, 'SELECT updated_at FROM memory_sync_cursors WHERE name=?', ['ombre']);
    return { pendingPush: counts?.pending_push ?? 0, pendingPull: 0, conflicts: counts?.conflicts ?? 0, lastSyncAt: cursor?.updated_at ?? null };
  }

  parsePayload(row: MemorySyncOutboxRow): Record<string, unknown> {
    return safeJson(row.payload_json, {});
  }
}
