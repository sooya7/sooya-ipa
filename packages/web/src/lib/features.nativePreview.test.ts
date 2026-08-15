// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { featureApi } from './features.js';
import { clearSooyaClient, installSooyaClient, type SooyaClient } from './sooyaClient.js';

afterEach(() => {
  clearSooyaClient();
  vi.unstubAllGlobals();
});

describe('IPA 本地语音试听', () => {
  it('通过 LocalCore 获取 base64 音频并还原成可播放 Blob，不再走 WebView fetch', async () => {
    const adminRequest = vi.fn(async () => ({
      dataBase64: btoa('ID3preview-audio'),
      mime: 'audio/mpeg',
      format: 'mp3'
    }));
    installSooyaClient({ adminRequest } as unknown as SooyaClient);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const blob = await featureApi.previewVoice('你好呀', 'shy');

    expect(adminRequest).toHaveBeenCalledWith('/api/admin/voice/preview', {
      method: 'POST',
      body: { text: '你好呀', emotion: 'shy' }
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(blob.type).toBe('audio/mpeg');
    expect(await blob.text()).toBe('ID3preview-audio');
  });

  it('本地路由没有返回音频时给出明确错误', async () => {
    const adminRequest = vi.fn(async () => ({ mime: 'audio/mpeg' }));
    installSooyaClient({ adminRequest } as unknown as SooyaClient);

    await expect(featureApi.previewVoice('你好', 'neutral')).rejects.toThrow('语音试听没有返回音频');
  });
});
