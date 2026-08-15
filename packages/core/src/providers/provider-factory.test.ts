import { describe, expect, it } from 'vitest';
import type { ConfigRepository, ProviderConfig } from '../db/config.repo.js';
import type { HttpPlatform, HttpRequest, HttpResponse, HttpResponseHead } from '../platform/http.js';
import { createConfiguredProviders } from './provider-factory.js';

const imageConfig: ProviderConfig = {
  capability: 'image',
  provider: 'anuma',
  baseUrl: 'https://anuma.example.test/v1',
  model: 'image-2',
  secretRef: 'provider.image.key',
  enabled: true,
  options: { protocol: 'anuma-input-images' },
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-08-16T00:00:00.000Z'
};

class FakeHttp implements HttpPlatform {
  readonly requests: HttpRequest[] = [];

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ data: [{ b64_json: 'AQID', mime_type: 'image/png' }] }))
    };
  }

  async stream(_request: HttpRequest, _onChunk: (chunk: Uint8Array) => void): Promise<HttpResponseHead> {
    throw new Error('stream is not used');
  }
}

describe('public provider factory image protocol routing', () => {
  it('honors options.protocol for persisted Anuma configs', async () => {
    const config = {
      getProvider: async (capability: ProviderConfig['capability']) => capability === 'image' ? imageConfig : undefined
    } as unknown as ConfigRepository;
    const http = new FakeHttp();

    const providers = await createConfiguredProviders(http, config);
    expect(providers.image?.configured).toBe(true);

    await providers.image!.generate('窗边暖黄灯下的生活照');

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.url).toBe('https://anuma.example.test/v1/images/generations');
    expect(JSON.parse(String(http.requests[0]?.body))).toMatchObject({
      model: 'image-2',
      prompt: '窗边暖黄灯下的生活照'
    });
  });
});
