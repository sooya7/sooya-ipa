import { describe, expect, it, vi } from 'vitest';
import type { CreateMediaInput, MediaRow } from '../db/media.repo.js';
import type { MediaPlatform, MediaRecord } from '../platform/media.js';
import { LocalMediaResolver, type MediaLocationRow } from './media-resolver.js';

function fakeRow(partial: Partial<MediaLocationRow> = {}): MediaLocationRow {
  return { id: 'media_1', origin: 'upload', rel_path: '11111111-2222-3333-4444-555555555555', ...partial };
}

function backingStore(): MediaPlatform & { calls: Array<{ op: 'read' | 'remove' | 'save'; arg: string }> } {
  const calls: Array<{ op: 'read' | 'remove' | 'save'; arg: string }> = [];
  const record: MediaRecord = { id: 'uuid', kind: 'image', mime: 'image/png', bytes: 3 };
  return {
    calls,
    async save(request) {
      calls.push({ op: 'save', arg: request.name ?? '' });
      return { ...record, id: '11111111-2222-3333-4444-555555555555', name: request.name };
    },
    async read(id) {
      calls.push({ op: 'read', arg: id });
      return id === '' ? null : { record: { ...record, id }, data: new Uint8Array([1, 2, 3]) };
    },
    async remove(id) {
      calls.push({ op: 'remove', arg: id });
      return true;
    }
  };
}

function generatedRow(input: CreateMediaInput): MediaRow {
  return {
    id: 'media_generated_1',
    kind: input.kind,
    rel_path: input.relPath,
    mime: input.mime,
    bytes: input.bytes,
    sha256: input.sha256,
    width: input.width ?? null,
    height: input.height ?? null,
    duration: input.duration ?? null,
    origin: input.origin,
    created_at: '2026-08-16T00:00:00.000Z',
    transcript: input.transcript ?? null,
    meta_json: JSON.stringify(input.meta ?? {}),
    deleted_at: null,
    favorite: 0,
    tags_json: JSON.stringify(input.tags ?? []),
    animated: input.animated ? 1 : 0
  };
}

function repo(rows: Array<MediaLocationRow | undefined>) {
  const byId = new Map(rows.filter((row): row is MediaLocationRow => row !== undefined).map((row) => [row.id, row]));
  return {
    get: vi.fn(async (id: string) => byId.get(id)),
    create: vi.fn(async (input: CreateMediaInput) => generatedRow(input)),
    delete: vi.fn(async (id: string) => byId.delete(id))
  };
}

describe('LocalMediaResolver', () => {
  it('resolves uploaded media through rel_path (native UUID), not the logical id', async () => {
    const backing = backingStore();
    const resolver = new LocalMediaResolver(repo([fakeRow()]), backing);
    const result = await resolver.read('media_1');
    expect(result).not.toBeNull();
    expect(backing.calls).toEqual([{ op: 'read', arg: '11111111-2222-3333-4444-555555555555' }]);
  });

  it('routes builtin media to the bundle asset key (logical id)', async () => {
    const backing = backingStore();
    const resolver = new LocalMediaResolver(repo([fakeRow({ id: 'builtin_sticker_1', origin: 'builtin', rel_path: '/stickers/x.gif' })]), backing);
    await resolver.read('builtin_sticker_1');
    expect(backing.calls).toEqual([{ op: 'read', arg: 'builtin_sticker_1' }]);
  });

  it('returns null for missing rows instead of hitting the backing store', async () => {
    const backing = backingStore();
    const resolver = new LocalMediaResolver(repo([undefined]), backing);
    expect(await resolver.read('media_missing')).toBeNull();
    expect(await resolver.remove('media_missing')).toBe(false);
    expect(backing.calls).toEqual([]);
  });

  it('removes the physical location (UUID / bundle key) when removing a logical id', async () => {
    const backing = backingStore();
    const resolver = new LocalMediaResolver(repo([fakeRow(), fakeRow({ id: 'builtin_sticker_2', origin: 'builtin', rel_path: '/stickers/y.gif' })]), backing);
    await resolver.remove('media_1');
    await resolver.remove('builtin_sticker_2');
    expect(backing.calls).toEqual([
      { op: 'remove', arg: '11111111-2222-3333-4444-555555555555' },
      { op: 'remove', arg: 'builtin_sticker_2' }
    ]);
  });

  it('passes normal uploads through to the backing store (native save returns the UUID)', async () => {
    const backing = backingStore();
    const catalog = repo([]);
    const resolver = new LocalMediaResolver(catalog, backing);
    const saved = await resolver.save({ kind: 'image', data: new Uint8Array([1]), mime: 'image/jpeg', name: 'a.jpg' });
    expect(saved.id).toBe('11111111-2222-3333-4444-555555555555');
    expect(catalog.create).not.toHaveBeenCalled();
    expect(backing.calls).toEqual([{ op: 'save', arg: 'a.jpg' }]);
  });

  it('registers generated reply media and returns the logical media id used by message_parts', async () => {
    const backing = backingStore();
    const catalog = repo([]);
    const resolver = new LocalMediaResolver(catalog, backing);
    const saved = await resolver.save({
      kind: 'image',
      data: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
      name: 'sooya.image',
      metadata: { generated: true, provider: 'anuma-input-images', prompt: '窗边自拍' }
    });

    expect(saved.id).toBe('media_generated_1');
    expect(catalog.create).toHaveBeenCalledTimes(1);
    expect(catalog.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image',
      relPath: '11111111-2222-3333-4444-555555555555',
      mime: 'image/png',
      bytes: 3,
      origin: 'generated',
      meta: { generated: true, provider: 'anuma-input-images', prompt: '窗边自拍', name: 'sooya.image' }
    }));
    const createInput = catalog.create.mock.calls[0]?.[0];
    expect(createInput?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(backing.calls).toEqual([{ op: 'save', arg: 'sooya.image' }]);
  });

  it('removes the physical generated file when media row persistence fails', async () => {
    const backing = backingStore();
    const catalog = repo([]);
    catalog.create.mockRejectedValueOnce(new Error('database write failed'));
    const resolver = new LocalMediaResolver(catalog, backing);

    await expect(resolver.save({
      kind: 'audio',
      data: new Uint8Array([1, 2, 3]),
      mime: 'audio/mpeg',
      name: 'sooya.mp3',
      metadata: { generated: true }
    })).rejects.toThrow('database write failed');

    expect(backing.calls).toEqual([
      { op: 'save', arg: 'sooya.mp3' },
      { op: 'remove', arg: '11111111-2222-3333-4444-555555555555' }
    ]);
  });

  it('destroy removes both the backing file and the catalog row (orphan cleanup)', async () => {
    const backing = backingStore();
    const catalog = repo([fakeRow()]);
    const resolver = new LocalMediaResolver(catalog, backing);

    expect(await resolver.destroy('media_1')).toBe(true);
    expect(backing.calls).toEqual([{ op: 'remove', arg: '11111111-2222-3333-4444-555555555555' }]);
    expect(catalog.delete).toHaveBeenCalledWith('media_1');
    expect(await resolver.destroy('media_missing')).toBe(false);
    expect(catalog.delete).toHaveBeenCalledTimes(1);
  });

  it('persists the spoken transcript on generated audio rows', async () => {
    const backing = backingStore();
    const catalog = repo([]);
    const resolver = new LocalMediaResolver(catalog, backing);

    await resolver.save({ kind: 'audio', data: new Uint8Array([1]), mime: 'audio/mpeg', name: 'sooya.mp3', transcript: '早点休息', metadata: { generated: true } });

    expect(catalog.create).toHaveBeenCalledWith(expect.objectContaining({ transcript: '早点休息' }));
  });
});
