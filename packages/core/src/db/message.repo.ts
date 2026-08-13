import type { DbOperation, LocalDatabase } from '../platform/database.js';
import { clampInteger, newId, nowIso, placeholders, queryOne, runOperation, runTransaction, safeJson } from './database.js';
import { toMediaRef, type MediaRow } from './media.repo.js';
import type { ChatMessage, MessagePart, MessageStatus, PartStatus, PartType, Role } from './types.js';

const CONVERSATION_ID = 'main';

interface MessageRow {
  id: string;
  conversation_id: string;
  role: Role;
  created_at: string;
  updated_at: string;
  seq: number;
  status: MessageStatus;
  client_msg_id: string | null;
  reply_to: string | null;
  error: string | null;
  batch_id: string | null;
  meta_json: string;
}

interface PartRow {
  id: string;
  message_id: string;
  idx: number;
  type: PartType;
  text: string | null;
  media_id: string | null;
  status: PartStatus;
  error: string | null;
  duration: number | null;
  transcript: string | null;
  meta_json: string;
}

interface MediaTextRow { media_id: string; status: 'pending' | 'ready' | 'failed' | 'unsupported'; error: string | null; }

export interface CreatePartInput {
  type: PartType;
  text?: string | null;
  mediaId?: string | null;
  status?: PartStatus;
  error?: string | null;
  duration?: number | null;
  transcript?: string | null;
  meta?: Record<string, unknown>;
}

export interface CreateMessageInput {
  id?: string;
  role: Role;
  status?: MessageStatus;
  clientMsgId?: string | null;
  replyTo?: string | null;
  batchId?: string | null;
  parts: CreatePartInput[];
  meta?: Record<string, unknown>;
}

export interface MessageSearchHit { message: ChatMessage; snippet: string; matchedPartId: string | null; }
export interface MessageContext { target: ChatMessage; messages: ChatMessage[]; hasOlder: boolean; hasNewer: boolean; }
export type WithdrawResult =
  | { kind: 'withdrawn'; message: ChatMessage }
  | { kind: 'not_found' }
  | { kind: 'not_withdrawable' }
  | { kind: 'expired' }
  | { kind: 'already_withdrawn'; message: ChatMessage };

export class MessageRepo {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}

  async create(input: CreateMessageInput): Promise<{ message: ChatMessage; created: boolean }> {
    if (input.clientMsgId) {
      const existing = await this.getByClientId(input.clientMsgId);
      if (existing) return { message: existing, created: false };
    }
    const id = input.id ?? newId('message');
    const timestamp = nowIso(this.now);
    const operations: DbOperation[] = [
      runOperation("UPDATE counters SET value = value + 1 WHERE name = 'message_seq'"),
      runOperation(
        `INSERT INTO messages(
          id,conversation_id,role,created_at,updated_at,seq,status,client_msg_id,reply_to,error,batch_id,meta_json
        ) VALUES (?,?,?,?,?,(SELECT value FROM counters WHERE name = 'message_seq'),?,?,?,?,?,?)`,
        [id, CONVERSATION_ID, input.role, timestamp, timestamp, input.status ?? 'sent', input.clientMsgId ?? null,
          input.replyTo ?? null, null, input.batchId ?? null, JSON.stringify(input.meta ?? {})]
      ),
      ...input.parts.map((part, index) => partInsertOperation(id, index, part))
    ];
    try {
      await runTransaction(this.db, operations);
    } catch (error) {
      if (input.clientMsgId) {
        const existing = await this.getByClientId(input.clientMsgId);
        if (existing) return { message: existing, created: false };
      }
      throw error;
    }
    const message = await this.get(id);
    if (!message) throw new Error(`message ${id} was not persisted`);
    return { message, created: true };
  }

  async createInTransaction(input: CreateMessageInput): Promise<{ message: ChatMessage; created: boolean }> {
    return await this.create(input);
  }

  async get(id: string): Promise<ChatMessage | undefined> {
    const row = await queryOne<MessageRow>(this.db, 'SELECT * FROM messages WHERE id = ?', [id]);
    return row ? (await this.hydrate([row]))[0] : undefined;
  }

  async getByClientId(clientMsgId: string): Promise<ChatMessage | undefined> {
    const row = await queryOne<MessageRow>(this.db, 'SELECT * FROM messages WHERE conversation_id = ? AND client_msg_id = ?', [CONVERSATION_ID, clientMsgId]);
    return row ? (await this.hydrate([row]))[0] : undefined;
  }

  async findAssistantByBatchId(batchId: string): Promise<ChatMessage | undefined> {
    const row = await queryOne<MessageRow>(this.db, `SELECT * FROM messages WHERE conversation_id = ? AND batch_id = ? ORDER BY seq DESC LIMIT 1`, [CONVERSATION_ID, batchId]);
    return row ? (await this.hydrate([row]))[0] : undefined;
  }

  async appendPart(messageId: string, part: CreatePartInput): Promise<string> {
    const row = await queryOne<{ m: number }>(this.db, 'SELECT COALESCE(MAX(idx), -1) m FROM message_parts WHERE message_id = ?', [messageId]);
    const id = newId('part');
    const operation = partInsertOperation(messageId, (row?.m ?? -1) + 1, part, id);
    await runTransaction(this.db, [operation, runOperation('UPDATE messages SET updated_at = ? WHERE id = ?', [nowIso(this.now), messageId])]);
    return id;
  }

  async updatePart(partId: string, patch: Partial<CreatePartInput>): Promise<void> {
    const sets: string[] = [];
    const values: Array<string | number | null | Uint8Array> = [];
    if (patch.text !== undefined) { sets.push('text = ?'); values.push(patch.text); }
    if (patch.mediaId !== undefined) { sets.push('media_id = ?'); values.push(patch.mediaId); }
    if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
    if (patch.error !== undefined) { sets.push('error = ?'); values.push(patch.error); }
    if (patch.duration !== undefined) { sets.push('duration = ?'); values.push(patch.duration); }
    if (patch.transcript !== undefined) { sets.push('transcript = ?'); values.push(patch.transcript); }
    if (patch.meta !== undefined) { sets.push('meta_json = ?'); values.push(JSON.stringify(patch.meta)); }
    if (sets.length === 0) return;
    await this.db.run(`UPDATE message_parts SET ${sets.join(', ')} WHERE id = ?`, [...values, partId]);
  }

  async deletePart(partId: string): Promise<void> { await this.db.run('DELETE FROM message_parts WHERE id = ?', [partId]); }
  async setStatus(messageId: string, status: MessageStatus, error?: string | null): Promise<void> { await this.db.run('UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE id = ?', [status, error ?? null, nowIso(this.now), messageId]); }
  async touch(messageId: string): Promise<void> { await this.db.run('UPDATE messages SET updated_at = ? WHERE id = ?', [nowIso(this.now), messageId]); }

  async updateMeta(messageId: string, patch: Record<string, unknown>): Promise<void> {
    const row = await queryOne<{ meta_json: string }>(this.db, 'SELECT meta_json FROM messages WHERE id = ?', [messageId]);
    if (!row) return;
    await this.db.run('UPDATE messages SET meta_json = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify({ ...safeJson(row.meta_json, {}), ...patch }), nowIso(this.now), messageId
    ]);
  }

  async withdraw(id: string, currentTime: number, windowMs: number): Promise<WithdrawResult> {
    const message = await this.get(id);
    if (!message) return { kind: 'not_found' };
    if (message.role !== 'user') return { kind: 'not_withdrawable' };
    if (message.meta.withdrawnAt) return { kind: 'already_withdrawn', message };
    if (currentTime - Date.parse(message.createdAt) > windowMs) return { kind: 'expired' };
    const withdrawnAt = new Date(currentTime).toISOString();
    const mutationId = newId('withdraw');
    const meta = JSON.stringify({ ...message.meta, withdrawnAt, withdrawalMutationId: mutationId, originalPartTypes: message.content.map((part) => part.type) });
    const cutoff = new Date(currentTime - windowMs).toISOString();
    const partId = newId('part');
    const results = await runTransaction<unknown[]>(this.db, [
      runOperation(`UPDATE messages SET meta_json = ?, updated_at = ?
        WHERE id = ? AND role = 'user' AND json_extract(meta_json, '$.withdrawnAt') IS NULL AND created_at >= ?`, [meta, withdrawnAt, id, cutoff]),
      runOperation(`DELETE FROM message_parts WHERE message_id = ? AND EXISTS (
        SELECT 1 FROM messages WHERE id = ? AND json_extract(meta_json, '$.withdrawalMutationId') = ?)`, [id, id, mutationId]),
      runOperation(`INSERT INTO message_parts(id,message_id,idx,type,text,media_id,status,error,duration,transcript,meta_json)
        SELECT ?,?,0,'text','[消息已撤回]',NULL,'sent',NULL,NULL,NULL,'{}'
        WHERE EXISTS (SELECT 1 FROM messages WHERE id = ? AND json_extract(meta_json, '$.withdrawalMutationId') = ?)`, [partId, id, id, mutationId])
    ]);
    const first = results[0] as { changes?: number } | undefined;
    if (first?.changes === 1) return { kind: 'withdrawn', message: (await this.get(id))! };
    const current = await this.get(id);
    if (!current) return { kind: 'not_found' };
    if (current.meta.withdrawnAt) return { kind: 'already_withdrawn', message: current };
    if (currentTime - Date.parse(current.createdAt) > windowMs) return { kind: 'expired' };
    return { kind: 'not_withdrawable' };
  }

  async context(id: string, before = 20, after = 20): Promise<MessageContext | undefined> {
    const target = await queryOne<MessageRow>(this.db, 'SELECT * FROM messages WHERE conversation_id = ? AND id = ?', [CONVERSATION_ID, id]);
    if (!target) return undefined;
    const beforeLimit = clampInteger(before, 0, 100);
    const afterLimit = clampInteger(after, 0, 100);
    const older = await this.db.query<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', [CONVERSATION_ID, target.seq, beforeLimit + 1]);
    const newer = await this.db.query<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?', [CONVERSATION_ID, target.seq, afterLimit + 1]);
    const rows = [...older.slice(0, beforeLimit).reverse(), target, ...newer.slice(0, afterLimit)];
    const messages = await this.hydrate(rows);
    return { target: messages[beforeLimit > older.length ? older.length : beforeLimit]!, messages, hasOlder: older.length > beforeLimit, hasNewer: newer.length > afterLimit };
  }

  async page(limit: number, beforeSeq?: number | null): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const capped = clampInteger(limit, 1, 200);
    const rows = beforeSeq && beforeSeq > 0
      ? await this.db.query<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', [CONVERSATION_ID, beforeSeq, capped + 1])
      : await this.db.query<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?', [CONVERSATION_ID, capped + 1]);
    return { messages: await this.hydrate(rows.slice(0, capped).reverse()), hasMore: rows.length > capped };
  }

  async search(query: string, limit = 30, cursor?: string | null): Promise<{ hits: MessageSearchHit[]; nextCursor: string | null }> {
    const normalized = query.trim();
    if (!normalized) return { hits: [], nextCursor: null };
    const capped = clampInteger(limit, 1, 50);
    const offset = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0);
    let rows: Array<{ message_id: string; snippet: string }> = [];
    if ([...normalized].length >= 3) {
      try {
        const match = normalized.replace(/["'*^()]/gu, ' ').split(/\s+/u).filter(Boolean).map((term) => `"${term}"`).join(' OR ');
        rows = await this.db.query(`SELECT message_id, snippet(messages_fts, 2, '', '', '…', 24) snippet
          FROM messages_fts WHERE messages_fts MATCH ? AND conversation_id = ? ORDER BY rowid DESC LIMIT ? OFFSET ?`,
          [match, CONVERSATION_ID, capped + 1, offset]);
      } catch { /* use portable fallback */ }
    }
    if (rows.length === 0) {
      rows = await this.db.query(`SELECT m.id message_id,
        substr(COALESCE(group_concat(COALESCE(p.text,p.transcript,media.rel_path,media_text.text), ' '), ''), 1, 160) snippet
        FROM messages m JOIN message_parts p ON p.message_id=m.id
        LEFT JOIN media ON media.id=p.media_id LEFT JOIN media_text ON media_text.media_id=p.media_id
        WHERE m.conversation_id=? AND lower(COALESCE(p.text,p.transcript,media.rel_path,media_text.text,'')) LIKE lower('%' || ? || '%')
        GROUP BY m.id ORDER BY m.seq DESC LIMIT ? OFFSET ?`, [CONVERSATION_ID, normalized, capped + 1, offset]);
    }
    const page = rows.slice(0, capped);
    const messageRows = page.length === 0 ? [] : await this.db.query<MessageRow>(`SELECT * FROM messages WHERE id IN (${placeholders(page.length)})`, page.map((row) => row.message_id));
    const hydrated = await this.hydrate(messageRows);
    const byId = new Map(hydrated.map((message) => [message.id, message]));
    return {
      hits: page.flatMap((row) => {
        const message = byId.get(row.message_id);
        return message ? [{ message, snippet: row.snippet ?? '', matchedPartId: matchedPartId(message, normalized) }] : [];
      }),
      nextCursor: rows.length > capped ? String(offset + capped) : null
    };
  }

  async since(seq: number, limit = 200): Promise<ChatMessage[]> {
    return await this.hydrate(await this.db.query<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?', [CONVERSATION_ID, seq, limit]));
  }

  async pageSince(seq: number, limit = 200): Promise<{ messages: ChatMessage[]; hasMore: boolean; nextSince: number }> {
    const capped = clampInteger(limit, 1, 200);
    const rows = await this.db.query<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?', [CONVERSATION_ID, seq, capped + 1]);
    const page = rows.slice(0, capped);
    return { messages: await this.hydrate(page), hasMore: rows.length > capped, nextSince: page.at(-1)?.seq ?? seq };
  }

  async range(fromSeq: number, toSeq: number): Promise<ChatMessage[]> { return await this.hydrate(await this.db.query<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC', [CONVERSATION_ID, fromSeq, toSeq])); }
  async recent(limit: number): Promise<ChatMessage[]> { const rows = await this.db.query<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?', [CONVERSATION_ID, limit]); return await this.hydrate(rows.reverse()); }
  async maxSeq(): Promise<number> { return (await queryOne<{ s: number }>(this.db, 'SELECT COALESCE(MAX(seq), 0) s FROM messages WHERE conversation_id = ?', [CONVERSATION_ID]))?.s ?? 0; }
  async count(): Promise<number> { return (await queryOne<{ c: number }>(this.db, 'SELECT COUNT(*) c FROM messages'))?.c ?? 0; }
  async failInterruptedBatchShell(batchId: string): Promise<number> { return (await this.db.run("UPDATE messages SET status='failed',error='interrupted by restart',updated_at=? WHERE batch_id=? AND status='sending'", [nowIso(this.now), batchId])).changes; }

  async clearAll(): Promise<void> {
    await runTransaction(this.db, [runOperation('DELETE FROM message_parts'), runOperation('DELETE FROM messages'), runOperation('DELETE FROM summaries')]);
  }

  async hydrate(rows: MessageRow[]): Promise<ChatMessage[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const parts = await this.db.query<PartRow>(`SELECT * FROM message_parts WHERE message_id IN (${placeholders(ids.length)}) ORDER BY message_id, idx`, ids);
    const mediaIds = [...new Set(parts.flatMap((part) => part.media_id ? [part.media_id] : []))];
    const mediaRows = mediaIds.length ? await this.db.query<MediaRow>(`SELECT * FROM media WHERE id IN (${placeholders(mediaIds.length)})`, mediaIds) : [];
    const textRows = mediaIds.length ? await this.db.query<MediaTextRow>(`SELECT media_id,status,error FROM media_text WHERE media_id IN (${placeholders(mediaIds.length)})`, mediaIds) : [];
    const mediaMap = new Map(mediaRows.map((row) => [row.id, row]));
    const textMap = new Map(textRows.map((row) => [row.media_id, row]));
    const byMessage = new Map<string, MessagePart[]>();
    for (const part of parts) {
      const media = part.media_id ? mediaMap.get(part.media_id) : undefined;
      const mediaText = part.media_id ? textMap.get(part.media_id) : undefined;
      const list = byMessage.get(part.message_id) ?? [];
      list.push({
        id: part.id,
        type: part.type,
        text: part.text,
        mediaId: part.media_id,
        status: part.status,
        error: part.error,
        duration: part.duration ?? media?.duration ?? null,
        transcript: part.transcript ?? media?.transcript ?? null,
        meta: safeJson(part.meta_json, {}),
        media: media ? { ...toMediaRef(media), textStatus: mediaText?.status, textError: mediaText?.error ?? null } : null
      });
      byMessage.set(part.message_id, list);
    }
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      seq: row.seq,
      status: row.status,
      clientMsgId: row.client_msg_id,
      replyTo: row.reply_to,
      error: row.error,
      content: byMessage.get(row.id) ?? [],
      meta: safeJson(row.meta_json, {})
    }));
  }
}

function partInsertOperation(messageId: string, index: number, part: CreatePartInput, id = newId('part')): DbOperation {
  return runOperation(`INSERT INTO message_parts(id,message_id,idx,type,text,media_id,status,error,duration,transcript,meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [id, messageId, index, part.type, part.text ?? null, part.mediaId ?? null,
      part.status ?? 'sent', part.error ?? null, part.duration ?? null, part.transcript ?? null, JSON.stringify(part.meta ?? {})]);
}

function matchedPartId(message: ChatMessage, query: string): string | null {
  const needle = query.toLocaleLowerCase();
  return message.content.find((part) => [part.text, part.transcript, part.media?.name].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle))?.id ?? null;
}
