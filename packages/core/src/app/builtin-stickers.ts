import type { LocalDatabase, RunResult } from '../platform/database.js';
import { runOperation, runTransaction } from '../db/database.js';

export interface BuiltinStickerSeed {
  id: string;
  mediaId: string;
  assetPath: string;
  name: string;
  tags: string[];
  emotion: string;
  description: string;
  imageText: string;
  mime: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  animated: boolean;
  createdAt: string;
  updatedAt: string;
  nameSource: 'legacy' | 'builtin' | 'manual' | 'auto';
  analysisStatus: 'pending' | 'processing' | 'ready' | 'failed';
  analysisSource: 'legacy' | 'ai' | 'manual';
  analysisVersion: number;
}

export interface BuiltinStickerImportResult {
  applied: boolean;
  markerKey: string;
  mediaIds: string[];
  insertedMediaIds: string[];
  insertedStickerIds: string[];
}

interface VerifiedBuiltinRow { media_id: string; }

async function verifiedMediaIds(db: LocalDatabase, seeds: readonly BuiltinStickerSeed[]): Promise<string[]> {
  const verified: string[] = [];
  for (const seed of seeds) {
    const rows = await db.query<VerifiedBuiltinRow>(`SELECT m.id media_id FROM media m
      WHERE m.id=? AND m.origin='builtin' AND m.rel_path=? AND m.sha256=?`, [seed.mediaId, seed.assetPath, seed.sha256]);
    if (rows.length > 0) verified.push(seed.mediaId);
  }
  return verified;
}

/** Imports one bundled server snapshot once without changing any existing local record. */
export async function seedBuiltinStickersOnce(db: LocalDatabase, version: string, seeds: readonly BuiltinStickerSeed[]): Promise<BuiltinStickerImportResult> {
  const markerKey = `builtin-stickers:${version}`;
  const completed = await db.query<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', [markerKey]);
  if (completed.length > 0) {
    return { applied: false, markerKey, mediaIds: await verifiedMediaIds(db, seeds), insertedMediaIds: [], insertedStickerIds: [] };
  }

  const operations = seeds.flatMap((seed) => [
    runOperation(`INSERT OR IGNORE INTO media(
      id,kind,rel_path,mime,bytes,sha256,width,height,duration,origin,created_at,
      transcript,meta_json,deleted_at,favorite,tags_json,animated
    ) SELECT ?, 'sticker', ?, ?, ?, ?, ?, ?, NULL, 'builtin', ?, NULL, ?, NULL, 0, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM stickers WHERE id=?)`, [
      seed.mediaId, seed.assetPath, seed.mime, seed.bytes, seed.sha256, seed.width, seed.height,
      seed.createdAt, JSON.stringify({ name: seed.name, builtinSticker: version }), JSON.stringify(seed.tags), seed.animated ? 1 : 0, seed.id
    ]),
    runOperation(`INSERT INTO stickers(
      id,media_id,name,tags_json,emotion,use_count,last_used_at,enabled,created_at,
      description,image_text,name_source,user_meaning,user_meaning_source,user_meaning_confidence,
      user_meaning_updated_at,analysis_status,analysis_source,analysis_version,analysis_model,
      analyzed_at,analysis_error,embedding,embedding_dim,embedding_model,favorite,user_use_count,
      user_last_used_at,updated_at,semantic_revision
    ) SELECT ?,?,?,?,?,0,NULL,1,?,?,?,?, '', 'none',NULL,NULL,?,?,?,NULL,?,NULL,NULL,NULL,NULL,0,0,NULL,?,0
      WHERE EXISTS (SELECT 1 FROM media WHERE id=? AND origin='builtin' AND rel_path=? AND sha256=?)
      AND NOT EXISTS (SELECT 1 FROM stickers WHERE id=?)`, [
      seed.id, seed.mediaId, seed.name, JSON.stringify(seed.tags), seed.emotion, seed.createdAt,
      seed.description, seed.imageText, seed.nameSource, seed.analysisStatus, seed.analysisSource,
      seed.analysisVersion, seed.analysisStatus === 'ready' ? seed.updatedAt : null, seed.updatedAt,
      seed.mediaId, seed.assetPath, seed.sha256, seed.id
    ]),
    runOperation(`INSERT INTO sticker_semantics_fts(sticker_id,content)
      SELECT ?, ? WHERE changes() > 0`, [
      seed.id, [seed.name, seed.description, seed.imageText, seed.emotion, ...seed.tags].filter(Boolean).join(' ')
    ])
  ]);
  operations.push(runOperation('INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)', [
    markerKey, JSON.stringify({ count: seeds.length }), new Date().toISOString()
  ]));
  const results = await runTransaction<Array<RunResult | unknown>>(db, operations);
  const insertedMediaIds: string[] = [];
  const insertedStickerIds: string[] = [];
  for (let index = 0; index < seeds.length; index += 1) {
    const seed = seeds[index]!;
    if ((results[index * 3] as RunResult | undefined)?.changes === 1) insertedMediaIds.push(seed.mediaId);
    if ((results[index * 3 + 1] as RunResult | undefined)?.changes === 1) insertedStickerIds.push(seed.id);
  }
  return {
    applied: true,
    markerKey,
    mediaIds: await verifiedMediaIds(db, seeds),
    insertedMediaIds,
    insertedStickerIds
  };
}

/** Removes only rows inserted by this still-unconfirmed bundle. */
export async function rollbackBuiltinStickerImport(db: LocalDatabase, result: BuiltinStickerImportResult): Promise<void> {
  if (!result.applied) return;
  const operations = [
    ...result.insertedStickerIds.flatMap((id) => [
      runOperation('DELETE FROM sticker_semantics_fts WHERE sticker_id=?', [id]),
      runOperation('DELETE FROM stickers WHERE id=?', [id])
    ]),
    ...result.insertedMediaIds.map((id) => runOperation('DELETE FROM media WHERE id=?', [id])),
    runOperation('DELETE FROM settings WHERE key=?', [result.markerKey])
  ];
  await runTransaction(db, operations);
}
