import type { LocalDatabase } from '../platform/database.js';
import { newId, nowIso, queryOne, runOperation, runTransaction } from './database.js';

export type ReplyBatchStatus = 'collecting' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

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
  async appendOrCreateMessage(messageId: string, dueAt: string, _interruptDueAt: string): Promise<AppendOrCreateResult> {
    const existing = await queryOne<ReplyBatchRow>(
      this.db,
      `SELECT b.* FROM reply_batches b JOIN reply_batch_messages bm ON bm.batch_id = b.id WHERE bm.message_id = ?`,
      [messageId]
    );
    if (existing) return { batch: existing, action: 'appended', revision: 0 };
    const timestamp = nowIso(this.now);
    const id = newId('batch');
    await runTransaction(this.db, [
      runOperation(
        `INSERT INTO reply_batches(id,conversation_id,status,trigger_message_id,opened_at,due_at,attempts,meta_json)
         VALUES(?,'main','collecting',?,?,?,0,'{}')`,
        [id, messageId, timestamp, dueAt]
      ),
      runOperation('INSERT INTO reply_batch_messages(batch_id,message_id,position,created_at) VALUES(?,?,?,?)', [id, messageId, 1, timestamp])
    ]);
    const batch = (await queryOne<ReplyBatchRow>(this.db, 'SELECT * FROM reply_batches WHERE id = ?', [id]))!;
    return { batch, action: 'created', revision: 0 };
  }

  async get(id: string): Promise<ReplyBatchRow | undefined> {
    return await queryOne<ReplyBatchRow>(this.db, 'SELECT * FROM reply_batches WHERE id = ?', [id]);
  }

  async latestOpen(): Promise<ReplyBatchRow | undefined> {
    return await queryOne<ReplyBatchRow>(
      this.db,
      "SELECT * FROM reply_batches WHERE status IN ('collecting','queued','running') ORDER BY opened_at DESC LIMIT 1"
    );
  }

  async messageIds(batchId: string): Promise<string[]> {
    const rows = await this.db.query<{ message_id: string }>('SELECT message_id FROM reply_batch_messages WHERE batch_id = ? ORDER BY position ASC', [batchId]);
    return rows.map((row) => row.message_id);
  }

  async markRunning(batchId: string): Promise<ReplyBatchRow | undefined> {
    await this.db.run("UPDATE reply_batches SET status='running',started_at=COALESCE(started_at,?),attempts=attempts+1 WHERE id=? AND status IN ('collecting','queued','running')", [nowIso(this.now), batchId]);
    return await this.get(batchId);
  }

  async complete(batchId: string, assistantMessageId: string): Promise<void> {
    await this.db.run("UPDATE reply_batches SET status='completed',assistant_message_id=?,completed_at=?,last_error=NULL WHERE id=?", [assistantMessageId, nowIso(this.now), batchId]);
  }

  async fail(batchId: string, error: string): Promise<void> {
    await this.db.run("UPDATE reply_batches SET status='failed',completed_at=?,last_error=? WHERE id=?", [nowIso(this.now), error.slice(0, 2000), batchId]);
  }
}
