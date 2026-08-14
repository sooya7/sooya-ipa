import { describe, expect, it, vi } from 'vitest';
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

function repo(rows: Array<MediaLocationRow | undefined>) {
  const byId = new Map(rows.filter((row): row is MediaLocationRow => row !== undefined).map((row) => [row.id, row]));
  return { get: vi.fn(async (id: string) => byId.get(id)) };
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

  it('passes saves through to the backing store (native save returns the UUID)', async () => {
    const backing = backingStore();
    const resolver = new LocalMediaResolver(repo([]), backing);
    const saved = await resolver.save({ kind: 'image', data: new Uint8Array([1]), mime: 'image/jpeg', name: 'a.jpg' });
    expect(saved.id).toBe('11111111-2222-3333-4444-555555555555');
    expect(backing.calls).toEqual([{ op: 'save', arg: 'a.jpg' }]);
  });
});
