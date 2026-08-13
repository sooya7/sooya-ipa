import type { LocalDatabase } from '../platform/database.js';
import { newId, nowIso, queryOne, runOperation, runTransaction } from './database.js';

export type ReplyBatchStatus = 'collecting' | 'queued' | 'generating' | 'publishing' | 'running' | 'completed' | 'superseded' | 'failed' | 'cancelled';

export interface ReplyBatchRow {
  id: string;
  conversation_id: string;
  status: ReplyBatchStatus;
  trigger_message_id: string;
  assistant_message_id: string | null;
  opened_at: string;
  due_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  meta_json: string;
  revision: number;
  last_message_at: string | null;
  generation_started_at: string | null;
  publish_started_at: string | null;
  visible_at: string | null;
  retry_count: number;
  interrupted_count: number;
  superseded_at: string | null;
  failure_code: string | null;
}

export type AppendAction = 'created' | 'appended' | 'interrupt' | 'next_batch';

export interface AppendOrCreateResult {
  batch: ReplyBatchRow;
  action: AppendAction;
  revision: number;
}

export class ReplyBatchRepo {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}

  /**
   * Admission for a new user message. If the message is already part of a
   * batch it is appended (never re-created); otherwise a collecting batch is
   * created with the message as trigger, in one native transaction call.
   */
  async appendOrCreateMessage(messageId: string, dueAt: string, interruptDueAt: string): Promise<AppendOrCreateResult> {
    const existing = await queryOne<ReplyBatchRow>(
      this.db,
      `SELECT b.* FROM reply_batches b JOIN reply_batch_messages bm ON bm.batch_id = b.id WHERE bm.message_id = ?`,
      [messageId]
    );
    if (existing) return { batch: existing, action: 'appended', revision: existing.revision };
    const timestamp = nowIso(this.now);
    const open = await queryOne<ReplyBatchRow>(this.db,
      `SELECT * FROM reply_batches WHERE conversation_id='main' AND status IN ('collecting','queued','generating','publishing','running') ORDER BY opened_at DESC LIMIT 1`);
    if (open) {
      const position = (await queryOne<{ max_position: number | null }>(this.db, 'SELECT MAX(position) max_position FROM reply_batch_messages WHERE batch_id=?', [open.id]))?.max_position ?? 0;
      const revision = open.revision + 1;
      await runTransaction(this.db, [
        runOperation('INSERT INTO reply_batch_messages(batch_id,message_id,position,created_at) VALUES(?,?,?,?)', [open.id, messageId, position + 1, timestamp]),
        runOperation(`UPDATE reply_batches SET status='collecting',due_at=?,last_message_at=?,revision=?,interrupted_count=interrupted_count+1 WHERE id=?`, [dueAt || interruptDueAt, timestamp, revision, open.id])
      ]);
      const batch = (await this.get(open.id))!;
      return { batch, action: open.status === 'collecting' || open.status === 'queued' ? 'appended' : 'interrupt', revision };
    }
    const id = newId('batch');
    await runTransaction(this.db, [
      runOperation(
        `INSERT INTO reply_batches(id,conversation_id,status,trigger_message_id,opened_at,due_at,attempts,meta_json,revision,last_message_at)
         VALUES(?,'main','collecting',?,?,?,0,'{}',1,?)`,
        [id, messageId, timestamp, dueAt, timestamp]
      ),
      runOperation('INSERT INTO reply_batch_messages(batch_id,message_id,position,created_at) VALUES(?,?,?,?)', [id, messageId, 1, timestamp])
    ]);
    const batch = (await queryOne<ReplyBatchRow>(this.db, 'SELECT * FROM reply_batches WHERE id = ?', [id]))!;
    return { batch, action: 'created', revision: batch.revision };
  }

  async get(id: string): Promise<ReplyBatchRow | undefined> {
    return await queryOne<ReplyBatchRow>(this.db, 'SELECT * FROM reply_batches WHERE id = ?', [id]);
  }

  async latestOpen(): Promise<ReplyBatchRow | undefined> {
    return await queryOne<ReplyBatchRow>(
      this.db,
      "SELECT * FROM reply_batches WHERE status IN ('collecting','queued','generating','publishing','running') ORDER BY opened_at DESC LIMIT 1"
    );
  }

  async messageIds(batchId: string): Promise<string[]> {
    const rows = await this.db.query<{ message_id: string }>('SELECT message_id FROM reply_batch_messages WHERE batch_id = ? ORDER BY position ASC', [batchId]);
    return rows.map((row) => row.message_id);
  }

  async markRunning(batchId: string, revision?: number): Promise<ReplyBatchRow | undefined> {
    const timestamp = nowIso(this.now);
    await this.db.run("UPDATE reply_batches SET status='generating',started_at=COALESCE(started_at,?),generation_started_at=?,attempts=attempts+1 WHERE id=? AND status IN ('collecting','queued','generating','publishing','running') AND (? IS NULL OR revision=?)", [timestamp, timestamp, batchId, revision ?? null, revision ?? null]);
    return await this.get(batchId);
  }

  async currentRevision(batchId: string): Promise<number | null> {
    return (await queryOne<{ revision: number }>(this.db, 'SELECT revision FROM reply_batches WHERE id=?', [batchId]))?.revision ?? null;
  }

  async complete(batchId: string, assistantMessageId: string, revision?: number): Promise<boolean> {
    const result = await this.db.run("UPDATE reply_batches SET status='completed',assistant_message_id=?,completed_at=?,visible_at=?,last_error=NULL WHERE id=? AND status IN ('generating','publishing','running') AND (? IS NULL OR revision=?)", [assistantMessageId, nowIso(this.now), nowIso(this.now), batchId, revision ?? null, revision ?? null]);
    return result.changes === 1;
  }

  async fail(batchId: string, error: string, revision?: number, code?: string): Promise<void> {
    await this.db.run("UPDATE reply_batches SET status='failed',completed_at=?,last_error=?,failure_code=? WHERE id=? AND (? IS NULL OR revision=?)", [nowIso(this.now), error.slice(0, 2000), code ?? null, batchId, revision ?? null, revision ?? null]);
  }

  async supersede(batchId: string, revision: number, reason = 'newer_revision'): Promise<void> {
    await this.db.run("UPDATE reply_batches SET status='superseded',superseded_at=?,completed_at=?,last_error=?,failure_code='superseded' WHERE id=? AND revision=? AND status IN ('generating','publishing','running')", [nowIso(this.now), nowIso(this.now), reason, batchId, revision]);
  }

  async retry(batchId: string): Promise<ReplyBatchRow | undefined> {
    await this.db.run("UPDATE reply_batches SET status='collecting',due_at=?,revision=revision+1,retry_count=retry_count+1,last_error=NULL,failure_code=NULL WHERE id=? AND status IN ('failed','superseded','cancelled')", [nowIso(this.now), batchId]);
    return await this.get(batchId);
  }
}
