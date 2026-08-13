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
  embedding: Uint8Array | null;
  embedding_dim: number | null;
  embedding_model: string | null;
}

export interface MemorySearchRow extends MemoryRow {
  fts_score?: number;
  score?: number;
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
  embedding?: number[];
  embeddingModel?: string | null;
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

export interface MirroredMemoryInput {
  kind: MemoryKind;
  content: string;
  importance: number;
  confidence: number;
  createdAt?: string;
  updatedAt?: string;
  sourceId: string;
  sourceHash?: string | null;
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

  async findBySourceId(sourceId: string): Promise<MemoryRow | undefined> {
    return await queryOne<MemoryRow>(this.db, 'SELECT * FROM memories WHERE active=1 AND source_id=? ORDER BY updated_at DESC LIMIT 1', [sourceId]);
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
        const normalized = normalizeds[index]!;
        const existingId = existingByNormalized.get(normalized);
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
            `INSERT INTO memories(id,kind,content,normalized,importance,confidence,created_at,updated_at,expires_at,hits,embedding,embedding_dim,embedding_model,active,source,source_hash)
             VALUES(?,?,?,?,?,?,?,?,NULL,0,?,?,?,1,'local',?)`,
            [id, candidate.kind, candidate.content, normalizeds[index]!, candidate.importance ?? 0.5, candidate.confidence ?? 0.6, ts, ts,
              candidate.embedding ? encodeFloat32(candidate.embedding) : null,
              candidate.embedding?.length ?? null,
              candidate.embeddingModel ?? null,
              candidate.sourceHash ?? null]
          ));
          existingByNormalized.set(normalized, id);
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
      const rows = await this.db.query<{ id: string; content: string }>(
        `SELECT m.id, m.content FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? ORDER BY f.rowid DESC LIMIT ?`,
        [match, limit]
      );
      if (rows.length) await this.db.run(`UPDATE memories SET hits=hits+1 WHERE id IN (${placeholders(rows.length)})`, rows.map((row) => row.id));
      return rows;
    } catch {
      return [];
    }
  }

  async searchFtsRows(query: string, limit = 50): Promise<MemorySearchRow[]> {
    const normalized = query.trim();
    if (!normalized) return [];
    const match = normalized.replace(/["'*^()]/gu, ' ').split(/\s+/u).filter(Boolean).map((term) => `"${term}"`).join(' OR ');
    try {
      return await this.db.query<MemorySearchRow>(
        `SELECT m.*, bm25(memories_fts) AS fts_score
         FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE m.active=1 AND memories_fts MATCH ?
         ORDER BY bm25(memories_fts) LIMIT ?`,
        [match, Math.max(1, Math.min(500, Math.trunc(limit)))]
      );
    } catch {
      return [];
    }
  }

  async embedded(limit = 1000): Promise<MemoryRow[]> {
    return await this.db.query<MemoryRow>(
      'SELECT * FROM memories WHERE active=1 AND embedding IS NOT NULL ORDER BY importance DESC,updated_at DESC LIMIT ?',
      [Math.max(1, Math.min(5000, Math.trunc(limit)))]
    );
  }

  /** Local hybrid retrieval. SQLite stays authoritative; vector math is done in JS. */
  async hybridSearch(query: string, queryEmbedding: number[] | undefined, limit = 20): Promise<Array<MemorySearchRow>> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const fts = await this.searchFtsRows(query, boundedLimit * 6);
    const candidates = new Map<string, MemorySearchRow>();
    for (const row of fts) candidates.set(row.id, { ...row, score: lexicalScore(row.fts_score) });
    if (fts.length === 0 && query.trim()) {
      const like = `%${query.trim().slice(0, 120)}%`;
      const fallback = await this.db.query<MemorySearchRow>(
        `SELECT * FROM memories WHERE active=1 AND (content LIKE ? OR normalized LIKE ?)
         ORDER BY importance DESC,updated_at DESC LIMIT ?`,
        [like, like.toLocaleLowerCase(), boundedLimit * 6]
      );
      for (const row of fallback) candidates.set(row.id, { ...row, score: 0.35 });
    }
    if (queryEmbedding?.length) {
      for (const row of await this.embedded(5000)) {
        const vector = decodeFloat32(row.embedding);
        const cosine = vector.length === queryEmbedding.length ? cosineSimilarity(queryEmbedding, vector) : 0;
        if (cosine > 0) candidates.set(row.id, { ...row, score: Math.max(candidates.get(row.id)?.score ?? 0, cosine) });
      }
    }
    const now = Date.now();
    return [...candidates.values()]
      .map((row) => ({
        ...row,
        score: (row.score ?? 0) * 0.68
          + row.importance * 0.14
          + row.confidence * 0.10
          + recencyScore(row.updated_at, now) * 0.08
      }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, boundedLimit);
  }

  async list(options: { limit?: number; offset?: number; kind?: MemoryKind } = {}): Promise<MemoryRow[]> {
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    return options.kind
      ? await this.db.query<MemoryRow>('SELECT * FROM memories WHERE active=1 AND kind=? ORDER BY updated_at DESC LIMIT ? OFFSET ?', [options.kind, limit, offset])
      : await this.db.query<MemoryRow>('SELECT * FROM memories WHERE active=1 ORDER BY updated_at DESC LIMIT ? OFFSET ?', [limit, offset]);
  }

  async update(id: string, patch: { content?: string; importance?: number; confidence?: number }): Promise<MemoryRow | null> {
    const current = await this.get(id);
    if (!current || current.active !== 1) return null;
    const content = patch.content?.trim() || current.content;
    const normalized = normalizeMemoryText(content);
    await this.db.run('UPDATE memories SET content=?,normalized=?,importance=?,confidence=?,updated_at=? WHERE id=? AND active=1', [content, normalized, patch.importance ?? current.importance, patch.confidence ?? current.confidence, nowIso(this.now), id]);
    return await this.get(id) ?? null;
  }

  /** Upserts an Ombre mirror without creating a local-to-remote sync loop. */
  async upsertMirrored(input: MirroredMemoryInput): Promise<{ record: MemoryRow; merged: boolean }> {
    const normalized = normalizeMemoryText(input.content);
    const bySource = await queryOne<MemoryRow>(this.db, 'SELECT * FROM memories WHERE active=1 AND source=? AND source_id=? LIMIT 1', ['ombre', input.sourceId]);
    const byHash = input.sourceHash
      ? await queryOne<MemoryRow>(this.db, 'SELECT * FROM memories WHERE active=1 AND source_hash=? LIMIT 1', [input.sourceHash])
      : undefined;
    const byNormalized = await queryOne<MemoryRow>(this.db, 'SELECT * FROM memories WHERE active=1 AND normalized=? LIMIT 1', [normalized]);
    const existing = bySource ?? byHash ?? byNormalized;
    const timestamp = input.updatedAt ?? nowIso(this.now);
    if (existing) {
      await this.db.run(
        `UPDATE memories SET kind=?,content=?,normalized=?,importance=?,confidence=?,updated_at=?,
         source='ombre',source_id=?,source_hash=?,active=1 WHERE id=?`,
        [input.kind, input.content, normalized, input.importance, input.confidence, timestamp, input.sourceId, input.sourceHash ?? null, existing.id]
      );
      return { record: (await this.get(existing.id))!, merged: true };
    }
    const id = newId('mem');
    await this.db.run(
      `INSERT INTO memories(id,kind,content,normalized,importance,confidence,created_at,updated_at,expires_at,hits,active,source,source_id,source_hash)
       VALUES(?,?,?,?,?,?,?,?,NULL,0,1,'ombre',?,?)`,
      [id, input.kind, input.content, normalized, input.importance, input.confidence, input.createdAt ?? timestamp, timestamp, input.sourceId, input.sourceHash ?? null]
    );
    return { record: (await this.get(id))!, merged: false };
  }

  async forget(id: string): Promise<boolean> {
    return (await this.db.run('UPDATE memories SET active=0,updated_at=? WHERE id=? AND active=1', [nowIso(this.now), id])).changes > 0;
  }

  async maintain(): Promise<{ removed: number; reembedded: number }> {
    const removed = (await this.db.run('UPDATE memories SET active=0,updated_at=? WHERE active=1 AND expires_at IS NOT NULL AND expires_at<=?', [nowIso(this.now), nowIso(this.now)])).changes;
    return { removed, reembedded: 0 };
  }

  async setEmbedding(id: string, embedding: Uint8Array, dimensions: number, model: string): Promise<void> {
    await this.db.run('UPDATE memories SET embedding=?,embedding_dim=?,embedding_model=?,updated_at=? WHERE id=?', [embedding, dimensions, model, nowIso(this.now), id]);
  }
}

function lexicalScore(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? 1 / (1 + Math.abs(value)) : 0.45;
}

function recencyScore(value: string, nowMs: number): number {
  const age = Math.max(0, nowMs - Date.parse(value));
  return Number.isFinite(age) ? Math.exp(-age / (45 * 86_400_000)) : 0;
}

function decodeFloat32(value: unknown): number[] {
  if (!value) return [];
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) bytes = value;
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else return [];
  if (bytes.length < 4 || bytes.length % 4 !== 0) return [];
  return [...new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))];
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0; let aa = 0; let bb = 0;
  for (let index = 0; index < a.length; index += 1) { dot += a[index]! * b[index]!; aa += a[index]! ** 2; bb += b[index]! ** 2; }
  return aa && bb ? Math.max(0, dot / Math.sqrt(aa * bb)) : 0;
}

function encodeFloat32(values: number[]): Uint8Array {
  const output = new Float32Array(values.length);
  output.set(values.map((value) => Number.isFinite(value) ? value : 0));
  return new Uint8Array(output.buffer);
}
