import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CapacitorMedia } from './nativeBoot.js';

describe('SOOYAMedia bridge contract', () => {
  it('uses the Swift mimeType field and normalizes metadata/read/delete envelopes', async () => {
    const calls: Array<{ method: string; options: Record<string, unknown> }> = [];
    const media = Object.create(CapacitorMedia.prototype) as unknown as CapacitorMedia;
    Object.defineProperty(media, 'plugin', { value: {
      call: async (method: string, options: Record<string, unknown>) => {
        calls.push({ method, options });
        if (method === 'save') return { id: 'm1', kind: 'sticker', mimeType: 'image/webp', bytes: 2, originalName: 'x.webp' };
        if (method === 'read') return { metadata: { id: 'm1', kind: 'sticker', mimeType: 'image/webp', bytes: 2, originalName: 'x.webp' }, dataBase64: 'AQI=' };
        if (method === 'delete') return { deleted: true };
        return {};
      }
    }});
    expect((await media.save({ kind: 'sticker', mime: 'image/webp', name: 'x.webp', data: new Uint8Array([1, 2]) })).kind).toBe('sticker');
    expect(calls[0]?.options.mimeType).toBe('image/webp');
    expect((await media.read('m1'))?.record.mime).toBe('image/webp');
    expect(await media.remove('m1')).toBe(true);
  });

  it('persists media kind in native sidecars while remaining optional for older files', () => {
    const swift = readFileSync(path.resolve('../../ios/App/App/Plugins/SOOYAMediaPlugin.swift'), 'utf8');
    expect(swift).toContain('var kind: String? = nil');
    expect(swift).toContain('kind: call.getString("kind")');
  });
});
