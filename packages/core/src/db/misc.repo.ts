import type { LocalDatabase } from '../platform/database.js';
import { clampInteger, newId, nowIso, queryOne, runOperation, runTransaction, safeJson } from './database.js';
import type { StreamEvent } from './types.js';

export class SettingsRepo {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}
  async get<T>(key: string, fallback: T): Promise<T> { const row = await queryOne<{ value_json: string }>(this.db, 'SELECT value_json FROM settings WHERE key = ?', [key]); return row ? safeJson(row.value_json, fallback) : fallback; }
  async has(key: string): Promise<boolean> { return !!(await queryOne(this.db, 'SELECT 1 present FROM settings WHERE key = ?', [key])); }
  async set<T>(key: string, value: T): Promise<void> { await this.db.run(`INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`, [key, JSON.stringify(value), nowIso(this.now)]); }
  async all(): Promise<Record<string, unknown>> { const rows = await this.db.query<{ key: string; value_json: string }>('SELECT key,value_json FROM settings'); return Object.fromEntries(rows.map((row) => [row.key, safeJson(row.value_json, null)])); }
  async delete(key: string): Promise<void> { await this.db.run('DELETE FROM settings WHERE key = ?', [key]); }
}

export interface SummaryRow { id: string; conversation_id: string; version: number; from_seq: number; to_seq: number; content: string; created_at: string; model: string | null; active: number; }
export class SummaryRepo {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}
  async create(input: { fromSeq: number; toSeq: number; content: string; model?: string | null }): Promise<SummaryRow> {
    const id = newId('summary');
    const timestamp = nowIso(this.now);
    await this.db.run(`INSERT INTO summaries(id,conversation_id,version,from_seq,to_seq,content,created_at,model,active)
      VALUES(?,'main',(SELECT COALESCE(MAX(version),0)+1 FROM summaries WHERE conversation_id='main'),?,?,?,?,?,1)`,
      [id, input.fromSeq, input.toSeq, input.content, timestamp, input.model ?? null]);
    return (await queryOne<SummaryRow>(this.db, 'SELECT * FROM summaries WHERE id = ?', [id]))!;
  }
  async coveredUpTo(): Promise<number> { return (await queryOne<{ s: number }>(this.db, "SELECT COALESCE(MAX(to_seq),0) s FROM summaries WHERE conversation_id='main' AND active=1"))?.s ?? 0; }
  async active(limit = 8): Promise<SummaryRow[]> { return await this.db.query("SELECT * FROM summaries WHERE conversation_id='main' AND active=1 ORDER BY to_seq DESC LIMIT ?", [limit]); }
  async all(): Promise<SummaryRow[]> { return await this.db.query('SELECT * FROM summaries ORDER BY from_seq'); }
  async count(): Promise<number> { return (await queryOne<{ c: number }>(this.db, 'SELECT COUNT(*) c FROM summaries'))?.c ?? 0; }
  async clear(): Promise<void> { await this.db.run('DELETE FROM summaries'); }
}

export interface JobRow { id: string; type: string; payload_json: string; status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'; attempts: number; max_attempts: number; last_error: string | null; created_at: string; updated_at: string; run_after: string | null; priority: number; }
export class JobRepo {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}
  async enqueue(type: string, payload: Record<string, unknown>, options: { maxAttempts?: number; runAfter?: string; priority?: number } = {}): Promise<JobRow> {
    const id = newId('job'); const timestamp = nowIso(this.now); const priority = clampInteger(options.priority ?? priorityForJob(type), 0, 100);
    await this.db.run(`INSERT INTO jobs(id,type,payload_json,status,attempts,max_attempts,created_at,updated_at,run_after,priority) VALUES(?,?,?,'pending',0,?,?,?,?,?)`, [id, type, JSON.stringify(payload), options.maxAttempts ?? 3, timestamp, timestamp, options.runAfter ?? null, priority]);
    return (await this.get(id))!;
  }
  async get(id: string): Promise<JobRow | undefined> { return await queryOne(this.db, 'SELECT * FROM jobs WHERE id = ?', [id]); }
  async claimNext(): Promise<JobRow | undefined> {
    const timestamp = nowIso(this.now); const claimId = newId('claim');
    await runTransaction(this.db, [
      runOperation(`UPDATE jobs SET status='running',attempts=attempts+1,updated_at=?,last_error=NULL,
        payload_json=json_set(payload_json,'$.__claimId',?) WHERE id=(SELECT id FROM jobs WHERE status='pending'
        AND (run_after IS NULL OR run_after<=?) ORDER BY priority DESC,created_at ASC,id ASC LIMIT 1)`, [timestamp, claimId, timestamp])
    ]);
    const row = await queryOne<JobRow>(this.db, "SELECT * FROM jobs WHERE status='running' AND json_extract(payload_json,'$.__claimId')=? LIMIT 1", [claimId]);
    if (!row) return undefined;
    await this.db.run("UPDATE jobs SET payload_json=json_remove(payload_json,'$.__claimId') WHERE id=?", [row.id]);
    return (await this.get(row.id))!;
  }
  async complete(id: string): Promise<void> { await this.db.run("UPDATE jobs SET status='done',updated_at=?,last_error=NULL WHERE id=?", [nowIso(this.now), id]); }
  async fail(id: string, error: string): Promise<void> { const row = await this.get(id); if (!row) return; const status = row.attempts >= row.max_attempts ? 'failed' : 'pending'; const runAfter = status === 'pending' ? new Date(this.now().getTime() + 2000 * row.attempts).toISOString() : null; await this.db.run('UPDATE jobs SET status=?,last_error=?,updated_at=?,run_after=? WHERE id=?', [status, error.slice(0, 2000), nowIso(this.now), runAfter, id]); }
  async failTerminal(id: string, error: string): Promise<void> { await this.db.run("UPDATE jobs SET status='failed',last_error=?,updated_at=? WHERE id=?", [error.slice(0, 2000), nowIso(this.now), id]); }

  async recoverStuck(): Promise<number> { return (await this.db.run("UPDATE jobs SET status='pending',updated_at=? WHERE status='running'", [nowIso(this.now)])).changes; }
  async pendingCount(): Promise<number> { return (await queryOne<{ c: number }>(this.db, "SELECT COUNT(*) c FROM jobs WHERE status IN ('pending','running')"))?.c ?? 0; }
  async hasRecentDone(type: string, withinMs = 60 * 60_000): Promise<boolean> {
    return !!(await queryOne(this.db, "SELECT 1 present FROM jobs WHERE type=? AND status='done' AND updated_at>=? LIMIT 1", [type, new Date(this.now().getTime() - withinMs).toISOString()]));
  }

  async hasActive(type: string): Promise<boolean> { return !!(await queryOne(this.db, "SELECT 1 present FROM jobs WHERE type=? AND status IN ('pending','running') LIMIT 1", [type])); }
  async list(limit = 50): Promise<JobRow[]> { return await this.db.query('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', [limit]); }
  async purgeDone(keepMs = 86_400_000): Promise<number> { return (await this.db.run("DELETE FROM jobs WHERE status IN ('done','cancelled') AND updated_at<?", [new Date(this.now().getTime() - keepMs).toISOString()])).changes; }
}

export class EventRepo {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}
  async append(type: string, payload: Record<string, unknown>): Promise<StreamEvent> {
    const id = newId('event'); const createdAt = nowIso(this.now);
    const results = await runTransaction<Array<{ changes: number }>>(this.db, [
      runOperation("UPDATE counters SET value=value+1 WHERE name='event_seq'"),
      runOperation("INSERT INTO events(id,seq,type,payload_json,created_at) VALUES(?,(SELECT value FROM counters WHERE name='event_seq'),?,?,?)", [id, type, JSON.stringify(payload), createdAt])
    ]);
    if ((results[1]?.changes ?? 0) !== 1) throw new Error('event append failed');
    const row = (await queryOne<{ seq: number }>(this.db, 'SELECT seq FROM events WHERE id = ?', [id]))!;
    return { id, seq: row.seq, type, createdAt, payload };
  }
  async since(seq: number, limit = 500): Promise<StreamEvent[]> { return (await this.db.query<{ id: string; seq: number; type: string; payload_json: string; created_at: string }>('SELECT * FROM events WHERE seq>? ORDER BY seq ASC LIMIT ?', [seq, limit])).map(toEvent); }
  async recent(limit = 50): Promise<StreamEvent[]> { return (await this.db.query<{ id: string; seq: number; type: string; payload_json: string; created_at: string }>('SELECT * FROM events ORDER BY seq DESC LIMIT ?', [clampInteger(limit, 1, 500)])).map(toEvent); }
  async lastSeq(): Promise<number> { return (await queryOne<{ value: number }>(this.db, "SELECT value FROM counters WHERE name='event_seq'"))?.value ?? 0; }
  async oldestSeq(): Promise<number> { return (await queryOne<{ s: number }>(this.db, 'SELECT COALESCE(MIN(seq),0) s FROM events'))?.s ?? 0; }
  async prune(keep = 2000): Promise<number> { const cutoff = await this.lastSeq() - keep; return cutoff > 0 ? (await this.db.run('DELETE FROM events WHERE seq<=?', [cutoff])).changes : 0; }
  async clear(): Promise<void> { await this.db.run('DELETE FROM events'); }
}

export class AuditRepo {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}
  async add(category: string, action: string, target?: string | null, detail: Record<string, unknown> = {}): Promise<void> {
    await runTransaction(this.db, [
      runOperation('INSERT INTO audit_log(id,category,action,target,detail_json,created_at) VALUES(?,?,?,?,?,?)', [newId('audit'), category.slice(0, 60), action.slice(0, 80), target?.slice(0, 160) ?? null, JSON.stringify(detail), nowIso(this.now)]),
      runOperation('DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY created_at DESC LIMIT 1000)')
    ]);
  }
  async list(limit = 100): Promise<Array<{ id: string; category: string; action: string; target: string | null; detail: unknown; createdAt: string }>> {
    const rows = await this.db.query<{ id: string; category: string; action: string; target: string | null; detail_json: string; created_at: string }>('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?', [clampInteger(limit, 1, 500)]);
    return rows.map((row) => ({ id: row.id, category: row.category, action: row.action, target: row.target, detail: safeJson(row.detail_json, {}), createdAt: row.created_at }));
  }
}

function toEvent(row: { id: string; seq: number; type: string; payload_json: string; created_at: string }): StreamEvent { return { id: row.id, seq: row.seq, type: row.type, createdAt: row.created_at, payload: safeJson(row.payload_json, {}) }; }
function priorityForJob(type: string): number { return ({ reply: 100, 'media.extract_text': 90, 'life.conversation': 75, 'weather.refresh': 70, 'sticker.user-meaning.learn': 75, 'sticker.analyze': 20, 'sticker.embed': 15, 'memory.embed.backfill': 10, maintenance: 10, 'backup.create': 5 } as Record<string, number>)[type] ?? 50; }

