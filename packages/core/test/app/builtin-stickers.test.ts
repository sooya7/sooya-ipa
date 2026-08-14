import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rollbackBuiltinStickerImport, seedBuiltinStickersOnce, type BuiltinStickerSeed } from '../../src/app/builtin-stickers.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { NodeLocalDatabase } from '../db/node-local-database.js';

const fixture: BuiltinStickerSeed = {
  id: 'sticker_server_happy',
  mediaId: 'media_server_happy',
  assetPath: '/builtin-stickers/media_server_happy.gif',
  name: '开心',
  tags: ['开心', '撒花'],
  emotion: 'happy',
  description: '开心地撒花',
  imageText: '',
  mime: 'image/gif',
  bytes: 42,
  sha256: 'abc123',
  width: 128,
  height: 128,
  animated: true,
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
  nameSource: 'builtin',
  analysisStatus: 'ready',
  analysisSource: 'manual',
  analysisVersion: 1
};

describe('seedBuiltinStickers', () => {
  let db: NodeLocalDatabase;

  beforeEach(async () => {
    db = new NodeLocalDatabase();
    await migrateDatabase(db);
  });

  afterEach(async () => db.close());

  it('把服务器表情元数据和只读资源路径写入空数据库', async () => {
    const result = await seedBuiltinStickersOnce(db, 'server-2026-08-14', [fixture]);
    expect(result).toMatchObject({ applied: true, mediaIds: [fixture.mediaId], insertedMediaIds: [fixture.mediaId], insertedStickerIds: [fixture.id] });

    await expect(db.query('SELECT id,kind,rel_path,mime,origin,animated FROM media')).resolves.toEqual([{
      id: fixture.mediaId,
      kind: 'sticker',
      rel_path: fixture.assetPath,
      mime: fixture.mime,
      origin: 'builtin',
      animated: 1
    }]);
    await expect(db.query('SELECT id,media_id,name,tags_json,emotion,description FROM stickers')).resolves.toEqual([{
      id: fixture.id,
      media_id: fixture.mediaId,
      name: fixture.name,
      tags_json: JSON.stringify(fixture.tags),
      emotion: fixture.emotion,
      description: fixture.description
    }]);
  });

  it('ID 冲突时不覆盖沙盒媒体，也不写入服务器语义', async () => {
    await db.run(`INSERT INTO media(id,kind,rel_path,mime,bytes,sha256,width,height,duration,origin,created_at,transcript,meta_json,deleted_at,favorite,tags_json,animated)
      VALUES (?, 'sticker', 'sandbox/user.gif', 'image/gif', 1, 'user-sha', NULL, NULL, NULL, 'upload', ?, NULL, '{}', NULL, 0, '[]', 1)`, [fixture.mediaId, fixture.createdAt]);
    await db.run(`INSERT INTO stickers(id,media_id,name,tags_json,emotion,use_count,last_used_at,enabled,created_at,description,image_text,name_source,user_meaning,user_meaning_source,user_meaning_confidence,user_meaning_updated_at,analysis_status,analysis_source,analysis_version,analysis_model,analyzed_at,analysis_error,embedding,embedding_dim,embedding_model,favorite,user_use_count,user_last_used_at,updated_at,semantic_revision)
      VALUES (?,?, '用户表情', '[]', 'neutral',0,NULL,1,?,'用户语义','','manual','','none',NULL,NULL,'ready','manual',0,NULL,?,NULL,NULL,NULL,NULL,0,0,NULL,?,0)`, [fixture.id, fixture.mediaId, fixture.createdAt, fixture.createdAt, fixture.updatedAt]);

    const result = await seedBuiltinStickersOnce(db, 'server-2026-08-14', [fixture]);

    expect(result).toMatchObject({ applied: true, mediaIds: [], insertedMediaIds: [], insertedStickerIds: [] });
    await expect(db.query('SELECT rel_path,origin,sha256 FROM media WHERE id=?', [fixture.mediaId])).resolves.toEqual([{ rel_path: 'sandbox/user.gif', origin: 'upload', sha256: 'user-sha' }]);
    await expect(db.query('SELECT content FROM sticker_semantics_fts WHERE sticker_id=?', [fixture.id])).resolves.toEqual([]);
  });

  it('健康确认失败时只回滚本轮新增快照', async () => {
    const result = await seedBuiltinStickersOnce(db, 'server-2026-08-14', [fixture]);
    await rollbackBuiltinStickerImport(db, result);

    await expect(db.query('SELECT COUNT(*) count FROM media')).resolves.toEqual([{ count: 0 }]);
    await expect(db.query('SELECT COUNT(*) count FROM stickers')).resolves.toEqual([{ count: 0 }]);
    await expect(db.query("SELECT COUNT(*) count FROM settings WHERE key='builtin-stickers:server-2026-08-14'")).resolves.toEqual([{ count: 0 }]);
  });

  it('同一导入版本只执行一次，尊重用户后续修改和删除', async () => {
    await seedBuiltinStickersOnce(db, 'server-2026-08-14', [fixture]);
    await db.run("UPDATE stickers SET favorite=1,name='我改过的名称' WHERE id=?", [fixture.id]);

    await seedBuiltinStickersOnce(db, 'server-2026-08-14', [{ ...fixture, name: '服务器新名称' }]);

    await expect(db.query('SELECT COUNT(*) count FROM stickers')).resolves.toEqual([{ count: 1 }]);
    await expect(db.query('SELECT favorite,name FROM stickers WHERE id=?', [fixture.id])).resolves.toEqual([{ favorite: 1, name: '我改过的名称' }]);

    await db.run('DELETE FROM stickers WHERE id=?', [fixture.id]);
    await seedBuiltinStickersOnce(db, 'server-2026-08-14', [fixture]);
    await expect(db.query('SELECT COUNT(*) count FROM stickers')).resolves.toEqual([{ count: 0 }]);
  });
});
