import { describe, expect, it } from 'vitest';
import type { ConfigRepository, ProviderConfig } from '../db/config.repo.js';
import type { HttpPlatform } from '../platform/http.js';
import { createConfiguredProviders } from './provider-factory.js';
import { BuiltinImageProvider as ProtocolAwareImageProvider } from './media-providers.js';

const imageConfig: ProviderConfig = {
  capability: 'image',
  provider: 'anuma',
  baseUrl: 'https://api.example.test',
  model: 'test-image-model',
  secretRef: 'provider.image.key',
  enabled: true,
  options: { protocol: 'anuma-input-images' },
  createdAt: '2026-08-15T00:00:00.000Z',
  updatedAt: '2026-08-15T00:00:00.000Z'
};

describe('configured provider runtime dispatch', () => {
  it('uses the protocol-aware image provider for IPA runtime factory calls', async () => {
    const config = {
      getProvider: async (capability: ProviderConfig['capability']) => capability === 'image' ? imageConfig : undefined
    } as unknown as ConfigRepository;
    const http = {} as HttpPlatform;

    const providers = await createConfiguredProviders(http, config);

    expect(providers.image).toBeInstanceOf(ProtocolAwareImageProvider);
  });
});
