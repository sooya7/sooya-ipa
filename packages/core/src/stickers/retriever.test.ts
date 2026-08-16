import { beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../db/migrations.js';
import { NodeLocalDatabase } from '../../test/db/node-local-database.js';
import { MediaRepo, StickerRepo } from '../db/index.js';
import { StickerRetriever } from './retriever.js';
import { StickerPicker } from './picker.js';

describe('Sticker retriever and picker', () => {
  let db: NodeLocalDatabase;
  let media: MediaRepo;
  let stickers: StickerRepo;

  beforeEach(async () => {
    db = new NodeLocalDatabase();
    await migrateDatabase(db);
    const now = new Date('2026-08-13T08:00:00.000Z');
    media = new MediaRepo(db, () => now);
    stickers = new StickerRepo(db, () => now);
  });

  async function seed(name: string, overrides: Partial<Parameters<StickerRepo['create']>[0]> = {}) {
    const row = await media.create({ kind: 'sticker', relPath: `${name}.gif`, mime: 'image/gif', bytes: 10, sha256: `sha-${name}`, origin: 'builtin' });
    return await stickers.create({ mediaId: row.id, name, emotion: 'neutral', description: name, imageText: '', tags: [], ...overrides });
  }

  it('prioritizes userMeaning before generic description matches', async () => {
    const cry = await seed('委屈柴犬', { description: '一只小狗坐着' });
    const laugh = await seed('开心猫', { description: '一只猫在大笑' });
    await stickers.setUserMeaning(cry.id, '委屈想哭', 'manual');
    await stickers.setUserMeaning(laugh.id, '开心大笑', 'manual');

    const retriever = new StickerRetriever({
      searchFts: (query, options) => stickers.searchFts(query, options),
      list: (options) => stickers.list(options)
    });
    const result = await retriever.retrieve({ query: '委屈', desiredIntent: '委屈' });

    expect(result.candidates[0]?.sticker.id).toBe(cry.id);
    expect(result.candidates[0]?.signals).toContain('userMeaning');
  });

  it('excludes recently used sticker ids from retrieval', async () => {
    const cry = await seed('委屈柴犬', { description: '委屈想哭' });
    const laugh = await seed('开心猫', { description: '开心大笑' });
    const retriever = new StickerRetriever({
      searchFts: (query, options) => stickers.searchFts(query, options),
      list: (options) => stickers.list(options),
      recentUsedIds: [cry.id]
    });

    const result = await retriever.retrieve({ query: '委屈' });
    expect(result.candidates.some((candidate) => candidate.sticker.id === cry.id)).toBe(false);
    expect(result.candidates.some((candidate) => candidate.sticker.id === laugh.id)).toBe(true);
  });

  it('falls back to FTS/semantic candidates when embedding is unavailable', async () => {
    await seed('加油鸭', { description: '给你打气' });
    const retriever = new StickerRetriever({
      searchFts: (query, options) => stickers.searchFts(query, options),
      list: (options) => stickers.list(options),
      embedQuery: async () => { throw new Error('embedding unavailable'); }
    });

    const result = await retriever.retrieve({ query: '加油' });
    expect(result.usedEmbedding).toBe(false);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('refuses low-confidence picks instead of forcing a wrong sticker', () => {
    const picker = new StickerPicker({ minConfidence: 0.3 });
    const picked = picker.pick({
      semantic: '难过',
      candidates: [{ sticker: { id: 'wrong' } as never, score: 0.05, signals: ['lexical'] }],
      recentUsedIds: []
    });
    expect(picked.stickerId).toBeNull();
    expect(picked.confidence).toBe(0);
  });

  it('skips a recent top match and takes the next eligible candidate', async () => {
    const cry = await seed('委屈柴犬', { description: '委屈想哭' });
    const laugh = await seed('开心猫', { description: '开心大笑' });
    const retriever = new StickerRetriever({
      searchFts: (query, options) => stickers.searchFts(query, options),
      list: (options) => stickers.list(options)
    });
    const result = await retriever.retrieve({ query: '委屈' });
    const picker = new StickerPicker();
    const picked = picker.pick({ semantic: '委屈', candidates: result.candidates, recentUsedIds: [cry.id] });
    expect(picked.stickerId).not.toBe(cry.id);
  });
});
