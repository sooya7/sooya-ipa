import type { LocalDatabase } from '../platform/database.js';
import type { DbValue } from '../platform/database.js';
import { clampInteger, newId, nowIso, queryOne, runOperation, runTransaction, safeJson } from './database.js';
import type { MediaRow } from './media.repo.js';

export type StickerNameSource = 'legacy' | 'builtin' | 'manual' | 'auto';
export type StickerAnalysisStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type StickerAnalysisSource = 'legacy' | 'ai' | 'manual';
export type StickerUserMeaningSource = 'none' | 'ai' | 'manual';

interface StickerRow {
  id: string;
  media_id: string;
  name: string;
  tags_json: string;
  emotion: string;
  use_count: number;
  last_used_at: string | null;
  enabled: number;
  created_at: string;
  description: string;
  image_text: string;
  name_source: StickerNameSource;
  user_meaning: string;
  user_meaning_source: StickerUserMeaningSource;
  user_meaning_confidence: number | null;
  user_meaning_updated_at: string | null;
  analysis_status: StickerAnalysisStatus;
  analysis_source: StickerAnalysisSource;
  analysis_version: number;
  analysis_model: string | null;
  analyzed_at: string | null;
  analysis_error: string | null;
  embedding: Uint8Array | null;
  embedding_dim: number | null;
  embedding_model: string | null;
  favorite: number;
  user_use_count: number;
  user_last_used_at: string | null;
  updated_at: string;
  semantic_revision: number;
}

export interface Sticker {
  id: string;
  mediaId: string;
  name: string;
  nameSource: StickerNameSource;
  description: string;
  imageText: string;
  tags: string[];
  emotion: string;
  userMeaning: string;
  userMeaningSource: StickerUserMeaningSource;
  userMeaningConfidence: number | null;
  userMeaningUpdatedAt: string | null;
  analysisStatus: StickerAnalysisStatus;
  analysisSource: StickerAnalysisSource;
  analysisVersion: number;
  analysisModel: string | null;
  analyzedAt: string | null;
  analysisError: string | null;
  embedding: Uint8Array | null;
  embeddingDim: number | null;
  embeddingModel: string | null;
  favorite: boolean;
  useCount: number;
  lastUsedAt: string | null;
  assistantUseCount: number;
  assistantLastUsedAt: string | null;
  userUseCount: number;
  userLastUsedAt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  semanticRevision: number;
  url: string;
}

export interface StickerListOptions {
  enabledOnly?: boolean;
  enabled?: boolean;
  scope?: 'recent' | 'favorite' | 'all';
  q?: string;
  status?: StickerAnalysisStatus;
  source?: StickerAnalysisSource;
  emotion?: string;
  sort?: 'created' | 'name' | 'recent' | 'usage';
  limit?: number;
  offset?: number;
}

export class StickerRepo {
  private onChange: (() => void) | null = null;

  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}

  setOnChange(listener: () => void): void { this.onChange = listener; }

  async create(input: {
    mediaId: string;
    name: string;
    tags?: string[];
    emotion?: string;
    description?: string;
    imageText?: string;
    nameSource?: StickerNameSource;
    analysisSource?: StickerAnalysisSource;
    analysisStatus?: StickerAnalysisStatus;
    analysisVersion?: number;
    enabled?: boolean;
    id?: string;
  }): Promise<Sticker> {
    const id = input.id ?? newId('sticker');
    const timestamp = nowIso(this.now);
    const description = input.description?.trim().slice(0, 500) ?? '';
    const rowValues = [
      id, input.mediaId, input.name.trim().slice(0, 60), JSON.stringify(normalizeTags(input.tags ?? [])),
      (input.emotion ?? 'neutral').trim().slice(0, 40), 0, null, input.enabled === false ? 0 : 1,
      timestamp, description, (input.imageText ?? '').trim().slice(0, 300), input.nameSource ?? 'legacy',
      '', 'none', null, null, input.analysisStatus ?? (description ? 'ready' : 'pending'),
      input.analysisSource ?? (description ? 'manual' : 'legacy'), input.analysisVersion ?? 0, null,
      description ? timestamp : null, null, null, null, null, 0, 0, null, timestamp, 0
    ];
    await runTransaction(this.db, [
      runOperation(`INSERT INTO stickers(
        id,media_id,name,tags_json,emotion,use_count,last_used_at,enabled,created_at,
        description,image_text,name_source,user_meaning,user_meaning_source,user_meaning_confidence,
        user_meaning_updated_at,analysis_status,analysis_source,analysis_version,analysis_model,
        analyzed_at,analysis_error,embedding,embedding_dim,embedding_model,favorite,user_use_count,
        user_last_used_at,updated_at,semantic_revision
      ) VALUES (${Array.from({ length: 30 }, () => '?').join(',')})`, rowValues),
      runOperation('INSERT INTO sticker_semantics_fts(sticker_id, content) VALUES (?, ?)', [id, semanticTextFromFields(input.name, description, input.imageText ?? '', input.tags ?? [], input.emotion ?? 'neutral', '')])
    ]);
    this.onChange?.();
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Sticker | undefined> {
    const row = await queryOne<StickerRow>(this.db, 'SELECT * FROM stickers WHERE id = ?', [id]);
    return row ? toSticker(row) : undefined;
  }

  async getByMediaId(mediaId: string): Promise<Sticker | undefined> {
    const row = await queryOne<StickerRow>(this.db, 'SELECT * FROM stickers WHERE media_id = ?', [mediaId]);
    return row ? toSticker(row) : undefined;
  }

  async getByName(name: string): Promise<Sticker | undefined> {
    const row = await queryOne<StickerRow>(this.db, 'SELECT * FROM stickers WHERE name = ?', [name]);
    return row ? toSticker(row) : undefined;
  }

  async list(options: StickerListOptions = {}): Promise<Sticker[]> {
    if (options.q?.trim()) return await this.searchFts(options.q, options);
    const { where, values } = stickerWhere(options);
    let sql = `SELECT * FROM stickers${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${stickerOrder(options)}`;
    if (options.limit !== undefined) {
      sql += ' LIMIT ? OFFSET ?';
      values.push(clampInteger(options.limit, 0, 500), Math.max(0, Math.trunc(options.offset ?? 0)));
    }
    return (await this.db.query<StickerRow>(sql, values)).map(toSticker);
  }

  async count(enabledOnly = true): Promise<number> {
    return (await queryOne<{ c: number }>(this.db, enabledOnly ? 'SELECT COUNT(*) c FROM stickers WHERE enabled = 1' : 'SELECT COUNT(*) c FROM stickers'))?.c ?? 0;
  }

  async update(id: string, patch: {
    tags?: string[];
    emotion?: string;
    enabled?: boolean;
    name?: string;
    nameSource?: StickerNameSource;
    description?: string;
    imageText?: string;
    userMeaning?: string;
    userMeaningSource?: StickerUserMeaningSource;
    favorite?: boolean;
  }): Promise<Sticker | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    const timestamp = nowIso(this.now);
    const next = {
      name: patch.name?.trim().slice(0, 60) ?? current.name,
      nameSource: patch.nameSource ?? (patch.name !== undefined ? 'manual' as const : current.nameSource),
      description: patch.description?.trim().slice(0, 500) ?? current.description,
      imageText: patch.imageText?.trim().slice(0, 300) ?? current.imageText,
      tags: patch.tags ? normalizeTags(patch.tags) : current.tags,
      emotion: patch.emotion?.trim().slice(0, 40) ?? current.emotion,
      userMeaning: patch.userMeaning === undefined ? current.userMeaning : patch.userMeaning.trim().slice(0, 120),
      userMeaningSource: patch.userMeaning === undefined
        ? patch.userMeaningSource ?? current.userMeaningSource
        : patch.userMeaning.trim() ? patch.userMeaningSource ?? 'manual' as const : 'none' as const,
      enabled: patch.enabled ?? current.enabled,
      favorite: patch.favorite ?? current.favorite
    };
    const semanticChanged = patch.tags !== undefined || patch.name !== undefined || patch.emotion !== undefined
      || patch.description !== undefined || patch.imageText !== undefined || patch.userMeaning !== undefined;
    await runTransaction(this.db, [
      runOperation(`UPDATE stickers SET
        name=?,name_source=?,description=?,image_text=?,tags_json=?,emotion=?,user_meaning=?,user_meaning_source=?,
        user_meaning_confidence=CASE WHEN ?='ai' THEN user_meaning_confidence ELSE NULL END,
        user_meaning_updated_at=?,enabled=?,favorite=?,analysis_source=?,analysis_status=?,analysis_error=NULL,
        embedding=CASE WHEN ?=1 THEN NULL ELSE embedding END,
        embedding_dim=CASE WHEN ?=1 THEN NULL ELSE embedding_dim END,
        embedding_model=CASE WHEN ?=1 THEN NULL ELSE embedding_model END,
        semantic_revision=semantic_revision+?,updated_at=? WHERE id=?`, [
        next.name, next.nameSource, next.description, next.imageText, JSON.stringify(next.tags), next.emotion,
        next.userMeaning, next.userMeaningSource, next.userMeaningSource, next.userMeaning ? timestamp : null,
        next.enabled ? 1 : 0, next.favorite ? 1 : 0,
        patch.tags !== undefined || patch.description !== undefined || patch.imageText !== undefined ? 'manual' : current.analysisSource,
        patch.tags !== undefined || patch.description !== undefined || patch.imageText !== undefined ? 'ready' : current.analysisStatus,
        semanticChanged ? 1 : 0, semanticChanged ? 1 : 0, semanticChanged ? 1 : 0, semanticChanged ? 1 : 0,
        timestamp, id
      ]),
      runOperation('DELETE FROM sticker_semantics_fts WHERE sticker_id = ?', [id]),
      runOperation('INSERT INTO sticker_semantics_fts(sticker_id, content) VALUES (?, ?)', [id, semanticTextFromFields(next.name, next.description, next.imageText, next.tags, next.emotion, next.userMeaning)])
    ]);
    this.onChange?.();
    return await this.get(id);
  }

  async updateSemantics(id: string, patch: { description?: string; imageText?: string; tags?: string[]; name?: string }): Promise<Sticker | undefined> { return await this.update(id, patch); }
  async updateManualSemantics(id: string, patch: { description?: string; imageText?: string; tags?: string[] }): Promise<Sticker | undefined> { return await this.update(id, patch); }

  /** Transitions the AI-analysis lifecycle state (pending/processing/ready/failed). */
  async setAnalysisState(id: string, patch: { status: StickerAnalysisStatus; source?: StickerAnalysisSource; version?: number; model?: string | null; analyzedAt?: string | null; error?: string | null }, options: { allowManual?: boolean } = {}): Promise<Sticker | undefined> {
    const sets = ['analysis_status = ?', 'updated_at = ?'];
    const values: DbValue[] = [patch.status, nowIso(this.now)];
    if (patch.source !== undefined) { sets.push('analysis_source = ?'); values.push(patch.source); }
    if (patch.version !== undefined) { sets.push('analysis_version = ?'); values.push(patch.version); }
    if (patch.model !== undefined) { sets.push('analysis_model = ?'); values.push(patch.model); }
    if (patch.analyzedAt !== undefined) { sets.push('analyzed_at = ?'); values.push(patch.analyzedAt); }
    if (patch.error !== undefined) { sets.push('analysis_error = ?'); values.push(patch.error); }
    if (patch.status === 'ready') sets.push('analysis_error = NULL');
    values.push(id);
    const manualFence = options.allowManual ? '' : " AND analysis_source != 'manual'";
    const result = await this.db.run(`UPDATE stickers SET ${sets.join(', ')} WHERE id = ?${manualFence}`, values);
    if (result.changes === 0) return undefined;
    this.onChange?.();
    return await this.get(id);
  }

  /** Applies a vision-model analysis result, keeping manual edits protected. */
  async applyAiAnalysis(id: string, patch: { suggestedName: string; description: string; imageText: string; tags: string[] }, meta: { version: number; model: string }, options: { force?: boolean; expectedSemanticRevision?: number } = {}): Promise<Sticker | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    if (current.analysisSource === 'manual' && !options.force) return current;
    if (options.expectedSemanticRevision !== undefined && current.semanticRevision !== options.expectedSemanticRevision) return undefined;
    const timestamp = nowIso(this.now);
    const sets = [
      'description = ?', 'image_text = ?', 'tags_json = ?',
      "analysis_status = 'ready'", "analysis_source = 'ai'",
      'analysis_version = ?', 'analysis_model = ?', 'analyzed_at = ?', 'analysis_error = NULL',
      'embedding = NULL', 'embedding_dim = NULL', 'embedding_model = NULL', 'updated_at = ?'
    ];
    const values: DbValue[] = [
      patch.description.trim().slice(0, 500),
      patch.imageText.trim().slice(0, 300),
      JSON.stringify(normalizeTags(patch.tags)),
      meta.version, meta.model.trim().slice(0, 200), timestamp, timestamp
    ];
    if (current.nameSource === 'auto') {
      sets.splice(1, 0, 'name = ?');
      values.splice(1, 0, patch.suggestedName.trim().slice(0, 60));
    }
    sets.push('semantic_revision = semantic_revision + 1');
    values.push(id);
    await runTransaction(this.db, [
      runOperation(`UPDATE stickers SET ${sets.join(', ')} WHERE id = ?`, values),
      runOperation('DELETE FROM sticker_semantics_fts WHERE sticker_id = ?', [id]),
      runOperation('INSERT INTO sticker_semantics_fts(sticker_id, content) VALUES (?, ?)', [id, semanticTextFromFields(patch.suggestedName, patch.description, patch.imageText, patch.tags, current.emotion, '')])
    ]);
    this.onChange?.();
    return await this.get(id);
  }

  async setFavorite(id: string, favorite: boolean): Promise<Sticker | undefined> { return await this.update(id, { favorite }); }
  async setUserMeaning(id: string, meaning: string, source: StickerUserMeaningSource): Promise<Sticker | undefined> { return await this.update(id, { userMeaning: meaning, userMeaningSource: source }); }

  async markAssistantUsed(id: string): Promise<void> {
    const timestamp = nowIso(this.now);
    await this.db.run('UPDATE stickers SET use_count=use_count+1,last_used_at=?,updated_at=? WHERE id=?', [timestamp, timestamp, id]);
    this.onChange?.();
  }
  async markUsed(id: string): Promise<void> { await this.markAssistantUsed(id); }
  async markUserUsed(id: string): Promise<Sticker | undefined> {
    const timestamp = nowIso(this.now);
    await this.db.run('UPDATE stickers SET user_use_count=user_use_count+1,user_last_used_at=?,updated_at=? WHERE id=?', [timestamp, timestamp, id]);
    this.onChange?.();
    return await this.get(id);
  }

  async searchFts(query: string, options: StickerListOptions = {}): Promise<Sticker[]> {
    const normalized = query.trim().slice(0, 200);
    if (!normalized) return await this.list({ ...options, q: undefined });
    const { where, values } = stickerWhere(options, 's.');
    const limit = clampInteger(options.limit ?? 500, 1, 500);
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    if ([...normalized].length >= 3) {
      try {
        const rows = await this.db.query<StickerRow>(`SELECT s.* FROM sticker_semantics_fts f JOIN stickers s ON s.id=f.sticker_id
          WHERE sticker_semantics_fts MATCH ?${where.length ? ` AND ${where.join(' AND ')}` : ''}
          ORDER BY bm25(sticker_semantics_fts),s.favorite DESC,s.user_last_used_at DESC LIMIT ? OFFSET ?`,
          [escapeFtsQuery(normalized), ...values, limit, offset]);
        if (rows.length > 0) return rows.map(toSticker);
      } catch { /* portable linear fallback */ }
    }
    const all = await this.list({ ...options, q: undefined, limit: undefined, offset: undefined });
    const needle = normalized.toLocaleLowerCase();
    return all.filter((sticker) => stickerSemanticText(sticker).toLocaleLowerCase().includes(needle)).slice(offset, offset + limit);
  }

  async refreshFts(id?: string): Promise<void> {
    const stickers = id ? [await this.get(id)].filter((item): item is Sticker => !!item) : await this.list();
    const operations = id ? [runOperation('DELETE FROM sticker_semantics_fts WHERE sticker_id = ?', [id])] : [runOperation('DELETE FROM sticker_semantics_fts')];
    operations.push(...stickers.map((sticker) => runOperation('INSERT INTO sticker_semantics_fts(sticker_id,content) VALUES (?,?)', [sticker.id, stickerSemanticText(sticker)])));
    await runTransaction(this.db, operations);
  }

  async delete(id: string): Promise<boolean> {
    const results = await runTransaction<Array<{ changes: number }>>(this.db, [
      runOperation('DELETE FROM sticker_semantics_fts WHERE sticker_id = ?', [id]),
      runOperation('DELETE FROM stickers WHERE id = ?', [id])
    ]);
    const deleted = (results[1]?.changes ?? 0) > 0;
    if (deleted) this.onChange?.();
    return deleted;
  }

  async mediaFor(sticker: Sticker): Promise<MediaRow | undefined> { return await queryOne<MediaRow>(this.db, 'SELECT * FROM media WHERE id = ?', [sticker.mediaId]); }
  async semanticText(sticker: Sticker | string): Promise<string> { const resolved = typeof sticker === 'string' ? await this.get(sticker) : sticker; return resolved ? stickerSemanticText(resolved) : ''; }
}

function normalizeTags(tags: string[]): string[] { return [...new Set(tags.map((tag) => tag.trim().slice(0, 24)).filter(Boolean))].slice(0, 8); }
function escapeFtsQuery(query: string): string { return query.split(/\s+/u).map((term) => term.replace(/"/gu, ' ').trim()).filter(Boolean).map((term) => `"${term}"`).join(' OR ').slice(0, 240) || '""'; }
function semanticTextFromFields(name: string, description: string, imageText: string, tags: string[], emotion: string, userMeaning: string): string { return `名称：${name}\n描述：${description}\n图片文字：${imageText}\n标签：${tags.join(' ')}\n情绪：${emotion}\n用户含义：${userMeaning}`; }
function stickerSemanticText(sticker: Sticker): string { return semanticTextFromFields(sticker.name, sticker.description, sticker.imageText, sticker.tags, sticker.emotion, sticker.userMeaning); }

function toSticker(row: StickerRow): Sticker {
  const tags = safeJson<unknown>(row.tags_json, []);
  return {
    id: row.id, mediaId: row.media_id, name: row.name, nameSource: row.name_source ?? 'legacy',
    description: row.description ?? '', imageText: row.image_text ?? '',
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
    emotion: row.emotion, userMeaning: row.user_meaning ?? '', userMeaningSource: row.user_meaning_source ?? 'none',
    userMeaningConfidence: row.user_meaning_confidence ?? null, userMeaningUpdatedAt: row.user_meaning_updated_at ?? null,
    analysisStatus: row.analysis_status ?? 'pending', analysisSource: row.analysis_source ?? 'legacy',
    analysisVersion: row.analysis_version ?? 0, analysisModel: row.analysis_model ?? null,
    analyzedAt: row.analyzed_at ?? null, analysisError: row.analysis_error ?? null,
    embedding: row.embedding ?? null, embeddingDim: row.embedding_dim ?? null, embeddingModel: row.embedding_model ?? null,
    favorite: row.favorite === 1, useCount: row.use_count, lastUsedAt: row.last_used_at,
    assistantUseCount: row.use_count, assistantLastUsedAt: row.last_used_at,
    userUseCount: row.user_use_count ?? 0, userLastUsedAt: row.user_last_used_at ?? null,
    enabled: row.enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at ?? row.created_at,
    semanticRevision: row.semantic_revision ?? 0, url: `local-media://${row.media_id}`
  };
}

function stickerWhere(options: StickerListOptions, prefix = ''): { where: string[]; values: Array<string | number | null> } {
  const where: string[] = [];
  const values: Array<string | number | null> = [];
  const column = (name: string) => `${prefix}${name}`;
  if (options.enabledOnly || options.enabled === true) where.push(`${column('enabled')} = 1`);
  else if (options.enabled === false) where.push(`${column('enabled')} = 0`);
  if (options.scope === 'favorite') where.push(`${column('favorite')} = 1`);
  if (options.status) { where.push(`${column('analysis_status')} = ?`); values.push(options.status); }
  if (options.source) { where.push(`${column('analysis_source')} = ?`); values.push(options.source); }
  if (options.emotion?.trim()) { where.push(`${column('emotion')} = ?`); values.push(options.emotion.trim().slice(0, 40)); }
  return { where, values };
}

function stickerOrder(options: StickerListOptions): string {
  if (options.sort === 'name') return 'name COLLATE NOCASE,id';
  if (options.sort === 'usage') return 'use_count DESC,user_use_count DESC,created_at DESC';
  if (options.sort === 'recent' || options.scope === 'recent' || options.scope === 'favorite') return 'user_last_used_at IS NULL,user_last_used_at DESC,created_at DESC';
  return 'created_at DESC,id DESC';
}

