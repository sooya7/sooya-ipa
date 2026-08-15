import { describe, expect, it } from 'vitest';
import type { HttpPlatform, HttpRequest, HttpResponse, HttpResponseHead } from '@sooya/core/platform';
import { probeNativeModel } from './NativeLocalCore.js';

function providerConfig() {
  return {
    capability: 'chat' as const,
    provider: 'openai-chat',
    baseUrl: 'https://api.sooya.icu/v1',
    model: 'mimo-v2.5',
    secretRef: 'provider.chat.key',
    enabled: true,
    options: {},
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z'
  };
}

function fakeHttp(status: number, payload: unknown): { http: HttpPlatform; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const http: HttpPlatform = {
    async request(request: HttpRequest): Promise<HttpResponse> {
      requests.push(request);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return {
        status,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(payload))
      };
    },
    async stream(request: HttpRequest, onChunk: (chunk: Uint8Array) => void): Promise<HttpResponseHead> {
      const response = await this.request(request);
      onChunk(response.body);
      return { status: response.status, headers: response.headers };
    }
  };
  return { http, requests };
}

describe('native model probe', () => {
  it('really calls the saved chat endpoint and forwards the Keychain reference', async () => {
    const { http, requests } = fakeHttp(200, {
      model: 'mimo-v2.5',
      choices: [{ message: { content: '好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1 }
    });

    const result = await probeNativeModel(http, providerConfig(), 'chat');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.sooya.icu/v1/chat/completions');
    expect(requests[0]?.secretRef).toBe('provider.chat.key');
    expect(requests[0]?.secretHeader).toBe('Authorization');
    expect(requests[0]?.secretPrefix).toBe('Bearer ');
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
      model: 'mimo-v2.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: '你好' }]
    });
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('openai-chat');
    expect(result.model).toBe('mimo-v2.5');
    expect(result.detail).toBe('模型回了 1 个字');
    expect(result.latencyMs).toBeGreaterThanOrEqual(1);
  });

  it('turns a real 401 into an authentication failure instead of a fake success', async () => {
    const { http } = fakeHttp(401, { error: { message: 'invalid api key' } });

    await expect(probeNativeModel(http, providerConfig(), 'chat')).rejects.toThrow(/鉴权失败（HTTP 401）/u);
  });
});
