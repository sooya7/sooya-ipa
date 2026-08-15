import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../db/config.repo.js';
import type { HttpPlatform, HttpRequest, HttpResponse, HttpResponseHead } from '../platform/http.js';
import { BuiltinTtsProvider } from './media-providers.js';

class BinaryHttp implements HttpPlatform {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly contentType: string) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return {
      status: 200,
      headers: { 'content-type': this.contentType },
      body: new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00])
    };
  }

  async stream(_request: HttpRequest, _onChunk: (chunk: Uint8Array) => void): Promise<HttpResponseHead> {
    throw new Error('stream is not used by TTS tests');
  }
}

function ttsConfig(provider: string): ProviderConfig {
  return {
    capability: 'tts',
    provider,
    baseUrl: 'https://tts.example.test',
    model: 'voice-model',
    secretRef: 'provider.tts.key',
    enabled: true,
    options: { format: 'mp3', voice: 'voice-id' },
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z'
  };
}

describe('BuiltinTtsProvider MIME normalization', () => {
  it('maps Fish application/octet-stream replies back to the requested mp3 MIME', async () => {
    const provider = new BuiltinTtsProvider(new BinaryHttp('application/octet-stream'), ttsConfig('fish'));
    const audio = await provider.synthesize('晚安');

    expect(audio.mime).toBe('audio/mpeg');
    expect(audio.format).toBe('mp3');
  });

  it('maps OpenAI-compatible generic binary replies back to the requested mp3 MIME', async () => {
    const provider = new BuiltinTtsProvider(new BinaryHttp('application/binary; charset=binary'), ttsConfig('openai-tts'));
    const audio = await provider.synthesize('晚安');

    expect(audio.mime).toBe('audio/mpeg');
  });

  it('preserves an explicit audio MIME from the provider', async () => {
    const provider = new BuiltinTtsProvider(new BinaryHttp('audio/mpeg; charset=binary'), ttsConfig('fish'));
    const audio = await provider.synthesize('晚安');

    expect(audio.mime).toBe('audio/mpeg');
  });
});
