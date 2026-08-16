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

describe('summary and director slots', () => {
  const chatConfig: ProviderConfig = {
    capability: 'chat',
    provider: 'openai-compatible',
    baseUrl: 'https://chat.example.test/v1',
    model: 'chat-model',
    secretRef: 'provider.chat.key',
    enabled: true,
    options: {},
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z'
  };
  const directorConfig: ProviderConfig = {
    ...chatConfig,
    capability: 'director',
    model: 'director-model',
    secretRef: 'provider.director.key'
  };

  it('falls back to chat when summary/director slots are unconfigured', async () => {
    const config = {
      getProvider: async (capability: ProviderConfig['capability']) => capability === 'chat' ? chatConfig : undefined
    } as unknown as ConfigRepository;

    const providers = await createConfiguredProviders(new FakeHttp(), config);

    expect(providers.summary).toBe(providers.chat);
    expect(providers.director).toBe(providers.chat);
  });

  it('prefers an independently configured director over the chat fallback', async () => {
    const config = {
      getProvider: async (capability: ProviderConfig['capability']) =>
        capability === 'chat' ? chatConfig : capability === 'director' ? directorConfig : undefined
    } as unknown as ConfigRepository;

    const providers = await createConfiguredProviders(new FakeHttp(), config);

    expect(providers.director).not.toBe(providers.chat);
    expect(providers.director?.configured).toBe(true);
    expect(providers.summary).toBe(providers.chat);
  });

  it('stays null without any chat-capable provider', async () => {
    const config = {
      getProvider: async () => undefined
    } as unknown as ConfigRepository;

    const providers = await createConfiguredProviders(new FakeHttp(), config);

    expect(providers.chat).toBeNull();
    expect(providers.summary).toBeNull();
    expect(providers.director).toBeNull();
  });
});
