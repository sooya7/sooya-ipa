import { describe, expect, it, vi } from 'vitest';
import type { BuiltinStickerSeed } from '@sooya/core/app';
import type { MediaPlatform, MediaSaveRequest } from '@sooya/core/platform';
import { BuiltinStickerMedia, afterAppReady, readBuiltinStickerAsset } from './builtinStickers.js';

const seed: BuiltinStickerSeed = {
  id: 'sticker_server_happy', mediaId: 'media_server_happy', assetPath: '/builtin-stickers/happy.gif',
  name: '开心', tags: ['开心'], emotion: 'happy', description: '开心', imageText: '', mime: 'image/gif',
  bytes: 3, sha256: 'unused-in-reader', width: 64, height: 64, animated: true,
  createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z',
  nameSource: 'builtin', analysisStatus: 'ready', analysisSource: 'manual', analysisVersion: 1
};

describe('readBuiltinStickerAsset', () => {
  it('按需读取随应用打包的服务器表情', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/gif' } }));
    const value = await readBuiltinStickerAsset(seed, fetcher);

    expect(fetcher).toHaveBeenCalledWith('/builtin-stickers/happy.gif');
    expect(value?.record).toMatchObject({ id: seed.mediaId, kind: 'sticker', mime: 'image/gif', bytes: 3 });
    expect(value?.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('资源不存在时返回 null', async () => {
    const value = await readBuiltinStickerAsset(seed, async () => new Response(null, { status: 404 }));
    expect(value).toBeNull();
  });
});

describe('BuiltinStickerMedia', () => {
  it('内置 ID 从应用资源读取，其他媒体继续走手机沙盒', async () => {
    const backing: MediaPlatform = {
      save: vi.fn(async (request: MediaSaveRequest) => ({ id: 'saved', kind: request.kind, mime: request.mime ?? '', bytes: request.data.byteLength })),
      read: vi.fn(async (id: string) => id === 'local' ? { record: { id, kind: 'image' as const, mime: 'image/png', bytes: 1 }, data: new Uint8Array([9]) } : null),
      remove: vi.fn(async () => true)
    };
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const media = new BuiltinStickerMedia(backing, [seed], fetcher);
    media.activate([seed.mediaId]);
    expect(media.assetUrl(seed.mediaId)).toBe(seed.assetPath);
    expect(media.assetUrl('local')).toBeNull();

    await expect(media.read(seed.mediaId)).resolves.toMatchObject({ record: { id: seed.mediaId, kind: 'sticker' } });
    await expect(media.read('local')).resolves.toMatchObject({ record: { id: 'local', kind: 'image' } });
    expect(backing.read).toHaveBeenCalledTimes(1);
    await expect(media.remove(seed.mediaId)).resolves.toBe(false);
  });
});

describe('afterAppReady', () => {
  it('先登记并激活快照，再确认 OTA bundle 健康', async () => {
    const order: string[] = [];
    await afterAppReady(
      async () => { order.push('seed'); return { applied: true, mediaIds: ['m1'], insertedMediaIds: ['m1'], insertedStickerIds: ['s1'], markerKey: 'marker' }; },
      (ids) => { order.push(`activate:${ids.join(',')}`); },
      async () => { order.push('ready'); },
      async () => { order.push('rollback'); }
    );
    expect(order).toEqual(['seed', 'activate:m1', 'ready']);
  });

  it('健康确认失败时停用并回滚本轮快照', async () => {
    const order: string[] = [];
    await expect(afterAppReady(
      async () => ({ applied: true, mediaIds: ['m1'], insertedMediaIds: ['m1'], insertedStickerIds: ['s1'], markerKey: 'marker' }),
      (ids) => { order.push(`activate:${ids.join(',')}`); },
      async () => { throw new Error('not ready'); },
      async () => { order.push('rollback'); }
    )).rejects.toThrow('not ready');
    expect(order).toEqual(['activate:m1', 'activate:', 'rollback']);
  });
});
