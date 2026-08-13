import type { LocalDatabase } from '../platform/database.js';
import { clampInteger, newId, nowIso, placeholders, queryOne } from './database.js';
import type { MediaRef } from './types.js';

export interface MediaRow {
  id: string;
  kind: 'image' | 'audio' | 'sticker' | 'file';
  rel_path: string;
  mime: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  origin: 'upload' | 'generated' | 'builtin' | 'remote';
  created_at: string;
  transcript: string | null;
  meta_json: string;
  deleted_at: string | null;
  favorite: number;
  tags_json: string;
  animated: number;
}

export interface CreateMediaInput {
  id?: string;
  kind: MediaRow['kind'];
  relPath: string;
  mime: string;
  bytes: number;
  sha256: string;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  origin: MediaRow['origin'];
  transcript?: string | null;
  meta?: Record<string, unknown>;
  tags?: string[];
  animated?: boolean;
}

export interface GalleryQuery {
  limit?: number;
  offset?: number;
  kind?: MediaRow['kind'];
  origin?: MediaRow['origin'];
  deleted?: boolean;
  favorite?: boolean;
  search?: string;
  from?: string;
  to?: string;
  avatar?: boolean;
}

export interface MediaReferences {
  messageParts: number;
  stickers: number;
  moments: number;
  voiceGenerations: number;
  total: number;
}

const AVATAR_META = `json_extract(CASE WHEN json_valid(m.meta_json) THEN m.meta_json ELSE '{}' END, '$.avatar')`;

export class MediaRepo {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}

  async create(input: CreateMediaInput): Promise<MediaRow> {
    const row: MediaRow = {
      id: input.id ?? newId('media'),
      kind: input.kind,
      rel_path: input.relPath,
      mime: input.mime,
      bytes: input.bytes,
      sha256: input.sha256,
      width: input.width ?? null,
      height: input.height ?? null,
      duration: input.duration ?? null,
      origin: input.origin,
      created_at: nowIso(this.now),
      transcript: input.transcript ?? null,
      meta_json: JSON.stringify(input.meta ?? {}),
      deleted_at: null,
      favorite: 0,
      tags_json: JSON.stringify(input.tags ?? []),
      animated: input.animated ? 1 : 0
    };
    await this.db.run(
      `INSERT INTO media (
        id,kind,rel_path,mime,bytes,sha256,width,height,duration,origin,created_at,
        transcript,meta_json,deleted_at,favorite,tags_json,animated
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.kind, row.rel_path, row.mime, row.bytes, row.sha256, row.width, row.height,
        row.duration, row.origin, row.created_at, row.transcript, row.meta_json, row.deleted_at,
        row.favorite, row.tags_json, row.animated]
    );
    return row;
  }

  async get(id: string): Promise<MediaRow | undefined> {
    return await queryOne<MediaRow>(this.db, 'SELECT * FROM media WHERE id = ?', [id]);
  }

  async getMany(ids: string[]): Promise<Map<string, MediaRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.query<MediaRow>(`SELECT * FROM media WHERE id IN (${placeholders(ids.length)})`, ids);
    return new Map(rows.map((row) => [row.id, row]));
  }

  async list(limit = 50, offset = 0, kind?: MediaRow['kind']): Promise<MediaRow[]> {
    const safeLimit = clampInteger(limit, 1, 10_000);
    const safeOffset = Math.max(0, Math.trunc(offset));
    return kind
      ? await this.db.query<MediaRow>('SELECT * FROM media WHERE kind = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?', [kind, safeLimit, safeOffset])
      : await this.db.query<MediaRow>('SELECT * FROM media WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?', [safeLimit, safeOffset]);
  }

  async listGallery(input: GalleryQuery = {}): Promise<MediaRow[]> {
    const { where, values } = galleryWhere(input);
    return await this.db.query<MediaRow>(
      `SELECT m.* FROM media m${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
      [...values, clampInteger(input.limit ?? 50, 1, 200), Math.max(0, Math.trunc(input.offset ?? 0))]
    );
  }

  async galleryStats(input: Omit<GalleryQuery, 'limit' | 'offset'> = {}): Promise<{ count: number; bytes: number }> {
    const { where, values } = galleryWhere(input);
    return (await queryOne<{ count: number; bytes: number }>(
      this.db,
      `SELECT COUNT(*) count, COALESCE(SUM(m.bytes), 0) bytes FROM media m${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      values
    )) ?? { count: 0, bytes: 0 };
  }

  async count(includeDeleted = true): Promise<number> {
    const row = await queryOne<{ c: number }>(this.db, includeDeleted ? 'SELECT COUNT(*) c FROM media' : 'SELECT COUNT(*) c FROM media WHERE deleted_at IS NULL');
    return row?.c ?? 0;
  }

  async delete(id: string): Promise<boolean> { return (await this.db.run('DELETE FROM media WHERE id = ?', [id])).changes > 0; }
  async trash(id: string): Promise<boolean> { return (await this.db.run('UPDATE media SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?', [nowIso(this.now), id])).changes > 0; }
  async restore(id: string): Promise<boolean> { return (await this.db.run('UPDATE media SET deleted_at = NULL WHERE id = ?', [id])).changes > 0; }
  async setFavorite(id: string, favorite: boolean): Promise<boolean> { return (await this.db.run('UPDATE media SET favorite = ? WHERE id = ?', [favorite ? 1 : 0, id])).changes > 0; }

  async setTags(id: string, tags: string[]): Promise<boolean> {
    const normalized = [...new Set(tags.map((value) => value.trim()).filter(Boolean))].slice(0, 30);
    return (await this.db.run('UPDATE media SET tags_json = ? WHERE id = ?', [JSON.stringify(normalized), id])).changes > 0;
  }

  async references(id: string): Promise<MediaReferences> {
    const row = await queryOne<{ message_parts: number; stickers: number; moments: number; voice_generations: number }>(this.db, `
      SELECT
        (SELECT COUNT(*) FROM message_parts WHERE media_id = ?) message_parts,
        (SELECT COUNT(*) FROM stickers WHERE media_id = ?) stickers,
        (SELECT COUNT(*) FROM moments WHERE image_media_id = ?) moments,
        (SELECT COUNT(*) FROM voice_generations WHERE media_id = ?) voice_generations
    `, [id, id, id, id]);
    const messageParts = row?.message_parts ?? 0;
    const stickers = row?.stickers ?? 0;
    const moments = row?.moments ?? 0;
    const voiceGenerations = row?.voice_generations ?? 0;
    return { messageParts, stickers, moments, voiceGenerations, total: messageParts + stickers + moments + voiceGenerations };
  }

  async allRows(): Promise<MediaRow[]> { return await this.db.query<MediaRow>('SELECT * FROM media ORDER BY created_at DESC'); }
  async listExpiredTrash(cutoff: string, limit = 500): Promise<MediaRow[]> { return await this.db.query<MediaRow>('SELECT * FROM media WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at LIMIT ?', [cutoff, clampInteger(limit, 1, 5000)]); }
  async findBySha(sha: string, kind: MediaRow['kind']): Promise<MediaRow | undefined> { return await queryOne<MediaRow>(this.db, 'SELECT * FROM media WHERE sha256 = ? AND kind = ? AND deleted_at IS NULL LIMIT 1', [sha, kind]); }
}

function galleryWhere(input: GalleryQuery): { where: string[]; values: Array<string | number | null> } {
  const where: string[] = [];
  const values: Array<string | number | null> = [];
  if (input.kind) { where.push('m.kind = ?'); values.push(input.kind); }
  if (input.origin) { where.push('m.origin = ?'); values.push(input.origin); }
  if (input.deleted === true) where.push('m.deleted_at IS NOT NULL');
  else where.push('m.deleted_at IS NULL');
  where.push(input.avatar === true ? `${AVATAR_META} IS NOT NULL` : `${AVATAR_META} IS NULL`);
  if (input.favorite) where.push('m.favorite = 1');
  if (input.from) { where.push('m.created_at >= ?'); values.push(input.from); }
  if (input.to) { where.push('m.created_at <= ?'); values.push(input.to); }
  const search = input.search?.trim();
  if (search) {
    where.push('(m.id LIKE ? OR m.rel_path LIKE ? OR m.meta_json LIKE ? OR m.tags_json LIKE ?)');
    const value = `%${search}%`;
    values.push(value, value, value, value);
  }
  return { where, values };
}

export function toMediaRef(row: MediaRow): MediaRef {
  let name: string | null = null;
  try { name = (JSON.parse(row.meta_json) as { name?: string }).name ?? null; } catch { /* invalid legacy metadata */ }
  return {
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    duration: row.duration,
    url: `local-media://${row.id}`,
    name,
    transcript: row.transcript,
    animated: row.animated === 1
  };
}

