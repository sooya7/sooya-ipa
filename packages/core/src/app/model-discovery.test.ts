import { describe, expect, it } from 'vitest';
import type { ConfigRepository, ProviderConfig } from '../db/config.repo.js';
import type { HttpPlatform } from '../platform/http.js';
import { ModelDiscoveryService } from './model-discovery.js';

function fakeConfig(partial: Partial<ProviderConfig>): ProviderConfig {
  return {
    capability: 'chat',
    provider: 'openai-compatible',
    baseUrl: 'https://gateway.test/v1',
    model: 'gpt-4o-mini',
    secretRef: 'provider.chat.key',
    enabled: true,
    options: {},
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...partial
  };
}

function fakeHttp(handler: (input: { url: string; headers?: Record<string, string>; secretRef?: string | null; secretHeader?: string; secretPrefix?: string }) => { status: number; body: string }): HttpPlatform {
  return {
    async request(input) {
      const result = handler({
        url: String(input.url),
        headers: (input.headers ?? {}) as Record<string, string>,
        secretRef: input.secretRef ?? null,
        secretHeader: input.secretHeader,
        secretPrefix: input.secretPrefix
      });
      return { status: result.status, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(result.body) };
    },
    async stream() { throw new Error('not used'); }
  };
}

function repo(provider: ProviderConfig | null): Pick<ConfigRepository, 'getProvider'> {
  return { getProvider: async () => provider };
}

describe('ModelDiscoveryService', () => {
  it('lists /v1/models and parses the standard { data: [{id}] } shape', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const service = new ModelDiscoveryService(fakeHttp((input) => {
      seen.push(input);
      return { status: 200, body: JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }) };
    }), repo(fakeConfig({})) as ConfigRepository);
    const result = await service.discover('chat');
    expect(result).toMatchObject({ ok: true, models: ['gpt-4o', 'gpt-4o-mini'] });
    expect(seen[0]).toMatchObject({
      url: 'https://gateway.test/v1/models',
      secretRef: 'provider.chat.key',
      secretHeader: 'authorization',
      secretPrefix: 'Bearer '
    });
  });

  it('falls back to NewAPI /api/models on 404 and parses the grouped shape', async () => {
    const urls: string[] = [];
    const service = new ModelDiscoveryService(fakeHttp((input) => {
      urls.push(input.url);
      if (input.url.endsWith('/v1/models')) return { status: 404, body: 'not found' };
      return { status: 200, body: JSON.stringify({ data: { '1': ['gpt-4o'], '2': ['gpt-image-1'] } }) };
    }), repo(fakeConfig({ options: { newApiUserId: 'user-7' } })) as ConfigRepository);
    const result = await service.discover('chat');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toEqual(['gpt-4o', 'gpt-image-1']);
      expect(result.source).toContain('/api/models');
    }
    expect(urls).toEqual(['https://gateway.test/v1/models', 'https://gateway.test/api/models']);
  });

  it('sends New-Api-User when configured', async () => {
    let headers: Record<string, string> = {};
    const service = new ModelDiscoveryService(fakeHttp((input) => {
      headers = input.headers ?? {};
      return { status: 200, body: JSON.stringify({ models: ['m1'] }) };
    }), repo(fakeConfig({ options: { newApiUserId: 'user-9' } })) as ConfigRepository);
    await service.discover('chat');
    expect(headers['New-Api-User']).toBe('user-9');
  });

  it('authenticates anthropic with x-api-key instead of bearer', async () => {
    let secretHeader = '';
    const service = new ModelDiscoveryService(fakeHttp((input) => {
      secretHeader = input.secretHeader ?? '';
      return { status: 200, body: JSON.stringify({ data: [{ id: 'claude-3-5-sonnet' }] }) };
    }), repo(fakeConfig({ provider: 'anthropic-messages' })) as ConfigRepository);
    const result = await service.discover('chat');
    expect(result.ok).toBe(true);
    expect(secretHeader).toBe('x-api-key');
  });

  it('reports unsupported providers without a network call', async () => {
    const service = new ModelDiscoveryService(fakeHttp(() => ({ status: 200, body: '{}' })), repo(fakeConfig({ provider: 'anuma-input-images' })) as ConfigRepository);
    const result = await service.discover('image');
    expect(result).toMatchObject({ ok: false, error: 'discovery_unsupported' });
  });

  it('reports HTTP failures and empty lists', async () => {
    const failing = new ModelDiscoveryService(fakeHttp(() => ({ status: 502, body: 'bad gateway' })), repo(fakeConfig({})) as ConfigRepository);
    expect((await failing.discover('chat')).ok).toBe(false);
    const empty = new ModelDiscoveryService(fakeHttp(() => ({ status: 200, body: JSON.stringify({ data: [] }) })), repo(fakeConfig({})) as ConfigRepository);
    const result = await empty.discover('chat');
    expect(result).toMatchObject({ ok: false, error: 'discovery_empty' });
  });

  it('requires a base url before requesting', async () => {
    const service = new ModelDiscoveryService(fakeHttp(() => ({ status: 200, body: '{}' })), repo(fakeConfig({ baseUrl: '' })) as ConfigRepository);
    const result = await service.discover('chat');
    expect(result).toMatchObject({ ok: false, error: 'missing_base_url' });
  });
});
