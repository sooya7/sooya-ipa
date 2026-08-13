import type { LocalDatabase } from '../platform/database.js';
import { newId, nowIso, placeholders, queryOne, runOperation, runTransaction } from './database.js';

export type MemoryKind = 'profile' | 'preference' | 'relationship' | 'project' | 'event' | 'summary';

export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  content: string;
  normalized: string;
  importance: number;
  confidence: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  hits: number;
  active: number;
  source: string;
  source_id: string | null;
  source_hash: string | null;
}

export interface UpsertMemoryInput {
  kind: MemoryKind;
  content: string;
  importance?: number;
  confidence?: number;
  expiresAt?: string | null;
  sourceMessageId?: string | null;
  sourceHash?: string | null;
}

export interface MemoryCommitCandidate {
  kind: MemoryKind;
  content: string;
  importance?: number;
  confidence?: number;
  sourceHash?: string | null;
}

export interface MemoryCommitInput {
  batchId: string;
  revision: number;
  userText?: string;
  assistantText?: string;
}

export interface MemoryCommitResult {
  state: 'completed';
  inserted: number;
  merged: number;
}

export interface MemoryReceiptRow {
  batch_id: string;
  revision: number;
  state: 'running' | 'completed' | 'uncertain' | 'failed' | 'skipped';
  inserted: number;
  merged: number;
  reason: string | null;
  started_at: string;
  completed_at: string | null;
  detail_json: string;
}

export function normalizeMemoryText(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[.,!?;:，。！？；：、"'\u201c\u201d\u2018\u2019()（）]/g, '')
      .replace(/[\s\u3000]+/g, ' ')
      // Whitespace around CJK carries no meaning; drop it so "喜欢 猫" and
      // "喜欢猫" dedupe to the same memory.
      .replace(/(?<=[\u3000-\u9fff\uf900-\ufaff])\s+(?=[\u3000-\u9fff\uf900-\ufaff])/g, '')
      .trim()
  );
}

export class MemoryRepo {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}

  async get(id: string): Promise<MemoryRow | undefined> {
    return await queryOne<MemoryRow>(this.db, 'SELECT * FROM memories WHERE id = ?', [id]);
  }

  async upsert(input: UpsertMemoryInput): Promise<{ record: MemoryRow; merged: boolean }> {
    const normalized = normalizeMemoryText(input.content);
    const existing = await queryOne<MemoryRow>(this.db, 'SELECT * FROM memories WHERE normalized = ? AND active = 1', [normalized]);
    const ts = nowIso(this.now);
    if (existing) {
      await this.db.run(
        `UPDATE memories SET importance = MAX(importance, ?), confidence = MIN(1, MAX(confidence, ?)),
           updated_at = ?, expires_at = COALESCE(?, expires_at), source = 'local',
           source_hash = COALESCE(?, source_hash) WHERE id = ?`,
        [input.importance ?? 0.5, input.confidence ?? 0.6, ts, input.expiresAt ?? null, input.sourceHash ?? null, existing.id]
      );
      if (input.sourceMessageId) {
        await this.db.run('INSERT OR IGNORE INTO memory_sources(memory_id, message_id, created_at) VALUES(?,?,?)', [existing.id, input.sourceMessageId, ts]);
      }
      return { record: (await this.get(existing.id))!, merged: true };
    }
    const id = newId('mem');
    await this.db.run(
      `INSERT INTO memories(id,kind,content,normalized,importance,confidence,created_at,updated_at,expires_at,hits,active,source,source_id,source_hash)
       VALUES(?,?,?,?,?,?,?,?,?,0,1,'local',?,?)`,
      [id, input.kind, input.content, normalized, input.importance ?? 0.5, input.confidence ?? 0.6, ts, ts, input.expiresAt ?? null, input.sourceMessageId ?? null, input.sourceHash ?? null]
    );
    if (input.sourceMessageId) {
      await this.db.run('INSERT OR IGNORE INTO memory_sources(memory_id, message_id, created_at) VALUES(?,?,?)', [id, input.sourceMessageId, ts]);
    }
    return { record: (await this.get(id))!, merged: false };
  }

  /**
   * Durable local memory commit. Inserts/merges candidates and writes the
   * receipt in a single native transaction call, so the UI can never see a
   * receipt without the memories (or the reverse).
   */
  async commit(input: MemoryCommitInput, candidates: MemoryCommitCandidate[]): Promise<MemoryCommitResult> {
    const ts = nowIso(this.now);
    let inserted = 0;
    let merged = 0;
    const ops = [];
    if (candidates.length > 0) {
      const normalizeds = candidates.map((candidate) => normalizeMemoryText(candidate.content));
      const existingRows = await this.db.query<{ id: string; normalized: string }>(
        `SELECT id, normalized FROM memories WHERE active = 1 AND normalized IN (${placeholders(normalizeds.length)})`,
        normalizeds
      );
      const existingByNormalized = new Map(existingRows.map((row) => [row.normalized, row.id]));
      for (const [index, candidate] of candidates.entries()) {
        const existingId = existingByNormalized.get(normalizeds[index]!);
        if (existingId) {
          merged += 1;
          ops.push(runOperation(
            `UPDATE memories SET importance = MAX(importance, ?), confidence = MIN(1, MAX(confidence, ?)),
               updated_at = ?, source = 'local', source_hash = COALESCE(?, source_hash) WHERE id = ?`,
            [candidate.importance ?? 0.5, candidate.confidence ?? 0.6, ts, candidate.sourceHash ?? null, existingId]
          ));
        } else {
          inserted += 1;
          const id = newId('mem');
          ops.push(runOperation(
            `INSERT INTO memories(id,kind,content,normalized,importance,confidence,created_at,updated_at,expires_at,hits,active,source,source_hash)
             VALUES(?,?,?,?,?,?,?,?,NULL,0,1,'local',?)`,
            [id, candidate.kind, candidate.content, normalizeds[index]!, candidate.importance ?? 0.5, candidate.confidence ?? 0.6, ts, ts, candidate.sourceHash ?? null]
          ));
        }
      }
    }
    ops.push(runOperation(
      `INSERT INTO local_memory_receipts(batch_id,revision,state,inserted,merged,reason,started_at,completed_at,detail_json)
       VALUES(?,?,'completed',?,?,NULL,?,?,'{}')`,
      [input.batchId, input.revision, inserted, merged, ts, ts]
    ));
    await runTransaction(this.db, ops);
    return { state: 'completed', inserted, merged };
  }

  async receipt(batchId: string, revision: number): Promise<MemoryReceiptRow | undefined> {
    return await queryOne<MemoryReceiptRow>(this.db, 'SELECT * FROM local_memory_receipts WHERE batch_id = ? AND revision = ?', [batchId, revision]);
  }

  async searchFts(query: string, limit = 20): Promise<Array<{ id: string; content: string }>> {
    const normalized = query.trim();
    if (!normalized) return [];
    const match = normalized.replace(/["'*^()]/gu, ' ').split(/\s+/u).filter(Boolean).map((term) => `"${term}"`).join(' OR ');
    try {
      return await this.db.query(
        `SELECT m.id, m.content FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? ORDER BY f.rowid DESC LIMIT ?`,
        [match, limit]
      );
    } catch {
      return [];
    }
  }
}
