import { describe, expect, it, vi } from 'vitest';
import { withLegacyNativePluginCall } from './nativePluginAdapter.js';

describe('native plugin compatibility adapter', () => {
  it('routes legacy call(method, options) to the Capacitor direct method', async () => {
    const nativeCall = vi.fn(async () => { throw new Error('raw call should never be invoked'); });
    const open = vi.fn(async (options: Record<string, unknown>) => ({ ok: true, options }));
    const raw = { call: nativeCall, open };
    const plugin = withLegacyNativePluginCall(raw, 'SOOYADatabase');

    await expect(plugin.call<{ ok: boolean }>('open', { mode: 'rw' })).resolves.toMatchObject({ ok: true });
    expect(open).toHaveBeenCalledWith({ mode: 'rw' });
    expect(nativeCall).not.toHaveBeenCalled();
  });

  it('preserves direct callback-style methods such as HTTP stream', () => {
    const stream = vi.fn((options: Record<string, unknown>, callback: (value: unknown) => void) => {
      callback({ type: 'complete', id: options.id });
    });
    const plugin = withLegacyNativePluginCall({ stream }, 'SOOYAHttp');
    const callback = vi.fn();

    plugin.stream({ id: 'req-1' }, callback);

    expect(stream).toHaveBeenCalledWith({ id: 'req-1' }, callback);
    expect(callback).toHaveBeenCalledWith({ type: 'complete', id: 'req-1' });
  });

  it('reports a useful error when a native method is absent', async () => {
    const plugin = withLegacyNativePluginCall({}, 'SOOYADatabase');
    await expect(plugin.call('open', {})).rejects.toThrow('native plugin SOOYADatabase.open is unavailable');
  });
});
