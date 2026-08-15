// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { HttpPlatform } from '@sooya/core/platform';
import { synthesizeNativeVoicePreview } from './NativeLocalCore.js';

describe('synthesizeNativeVoicePreview', () => {
  it('使用已保存的 Fish 配置走 native HTTP，并返回带正确 MIME 的 base64 音频', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
      body: new Uint8Array([0x49, 0x44, 0x33, 0x01])
    }));
    const http: HttpPlatform = {
      request,
      stream: vi.fn(async () => ({ status: 200, headers: {} }))
    };
    const config = {
      capability: 'tts',
      provider: 'fish',
      baseUrl: 'https://api.fish.audio',
      model: 's2.1-pro-free',
      secretRef: 'keychain:fish',
      enabled: true,
      options: { format: 'mp3', referenceId: 'sooya-voice' },
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z'
    };

    const result = await synthesizeNativeVoicePreview(http, config as any, ' 你好呀 ', 'shy');

    expect(result).toEqual({ dataBase64: 'SUQzAQ==', mime: 'audio/mpeg', format: 'mp3' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toMatchObject({
      url: 'https://api.fish.audio/v1/tts',
      method: 'POST',
      secretRef: 'keychain:fish'
    });
  });

  it('空试听文字回退默认文案，且配置不完整时直接拒绝', async () => {
    const request = vi.fn(async () => ({ status: 200, headers: { 'content-type': 'audio/mpeg' }, body: new Uint8Array([1]) }));
    const http: HttpPlatform = { request, stream: vi.fn(async () => ({ status: 200, headers: {} })) };
    const base = {
      capability: 'tts', provider: 'fish', baseUrl: 'https://api.fish.audio', model: 's2.1-pro-free',
      secretRef: 'keychain:fish', enabled: true, options: {}, createdAt: '', updatedAt: ''
    };

    await synthesizeNativeVoicePreview(http, base as any, '   ', 'neutral');
    const sent = request.mock.calls[0]![0];
    expect(typeof sent.body).toBe('string');
    expect(sent.body).toContain('你好呀，我刚刚想到你了。');

    await expect(synthesizeNativeVoicePreview(http, { ...base, secretRef: null } as any, '你好')).rejects.toThrow('这个能力还没配全');
  });
});
