import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../src/db/config.repo.js';
import type {
  HttpPlatform,
  HttpRequest,
  HttpResponse,
  HttpResponseHead
} from '../src/platform/http.js';
import {
  BuiltinImageProvider,
  BuiltinTtsProvider,
  decodeVolcStream
} from '../src/providers/index.js';

class FakeHttp implements HttpPlatform {
  readonly requests: HttpRequest[] = [];

  constructor(private readonly responses: HttpResponse[]) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error(`unexpected request: ${request.method ?? 'GET'} ${request.url}`);
    return response;
  }

  async stream(): Promise<HttpResponseHead> {
    throw new Error('stream is not used by media provider tests');
  }
}

function response(status: number, body: Uint8Array, headers: Record<string, string> = {}): HttpResponse {
  return { status, body, headers };
}

function jsonResponse(value: unknown): HttpResponse {
  return response(200, new TextEncoder().encode(JSON.stringify(value)), { 'content-type': 'application/json' });
}

function config(
  capability: 'image' | 'tts',
  provider: string,
  baseUrl: string,
  model: string,
  options: Record<string, unknown> = {}
): ProviderConfig {
  return {
    capability,
    provider,
    baseUrl,
    model,
    secretRef: `provider.${capability}.key`,
    enabled: true,
    options,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z'
  };
}

function jsonBody(request: HttpRequest): Record<string, unknown> {
  if (typeof request.body !== 'string') throw new Error('expected JSON string body');
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe('protocol-aware image provider', () => {
  it('keeps OpenAI images on /v1/images/generations', async () => {
    const http = new FakeHttp([jsonResponse({ data: [{ b64_json: 'AQID', mime_type: 'image/png' }] })]);
    const provider = new BuiltinImageProvider(
      http,
      config('image', 'openai-images', 'https://api.openai.com', 'gpt-image-1', { size: '1024x1024' })
    );

    const image = await provider.generate('test');
    expect([...new Uint8Array(image.data)]).toEqual([1, 2, 3]);
    expect(http.requests[0]?.url).toBe('https://api.openai.com/v1/images/generations');
    expect(jsonBody(http.requests[0]!).model).toBe('gpt-image-1');
  });

  it('uploads references and sends input_images for Anuma', async () => {
    const http = new FakeHttp([
      jsonResponse({ url: 'https://cdn.example.com/reference.png' }),
      jsonResponse({ data: [{ b64_json: 'AQID', mime_type: 'image/png' }] })
    ]);
    const provider = new BuiltinImageProvider(
      http,
      config('image', 'anuma-input-images', 'https://anuma.example.com/v1', 'image-2')
    );

    await provider.generate('keep the same face', {
      referenceImages: [{ data: new Uint8Array([10, 20, 30]), mime: 'image/png' }]
    });

    expect(http.requests.map((request) => request.url)).toEqual([
      'https://anuma.example.com/v1/media/upload',
      'https://anuma.example.com/v1/images/generations'
    ]);
    const upload = jsonBody(http.requests[0]!);
    expect(upload.content_type).toBe('image/png');
    expect(upload.data).toBe('ChQe');

    const generation = jsonBody(http.requests[1]!);
    expect(generation.model).toBe('image-2');
    expect(generation.input_images).toEqual(['https://cdn.example.com/reference.png']);
    expect(generation).not.toHaveProperty('image');
  });
});

describe('protocol-aware TTS provider', () => {
  it('sends Fish to /v1/tts with model in the HTTP header', async () => {
    const http = new FakeHttp([response(200, new Uint8Array([1, 2, 3]), { 'content-type': 'audio/mpeg' })]);
    const provider = new BuiltinTtsProvider(
      http,
      config('tts', 'fish', 'https://api.fish.audio', 's2.1-pro-free', {
        referenceId: 'voice-123',
        format: 'mp3',
        speed: 1
      })
    );

    await provider.synthesize('你好');

    const request = http.requests[0]!;
    expect(request.url).toBe('https://api.fish.audio/v1/tts');
    expect(request.headers?.model).toBe('s2.1-pro-free');
    expect(request.secretRef).toBe('provider.tts.key');
    expect(request.secretHeader).toBe('Authorization');
    expect(request.secretPrefix).toBe('Bearer ');

    const body = jsonBody(request);
    expect(body.text).toBe('你好');
    expect(body.reference_id).toBe('voice-123');
    expect(body.format).toBe('mp3');
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('input');
  });

  it('keeps OpenAI TTS on /v1/audio/speech', async () => {
    const http = new FakeHttp([response(200, new Uint8Array([1, 2, 3]), { 'content-type': 'audio/mpeg' })]);
    const provider = new BuiltinTtsProvider(
      http,
      config('tts', 'openai-tts', 'https://api.openai.com', 'gpt-4o-mini-tts', { voice: 'alloy', format: 'mp3' })
    );

    await provider.synthesize('你好');
    expect(http.requests[0]?.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(jsonBody(http.requests[0]!).input).toBe('你好');
  });

  it('uses Volc X-Api headers and decodes JSON-lines audio', async () => {
    const raw = `${JSON.stringify({ code: 20_000_000, data: 'AQID' })}\n`;
    const http = new FakeHttp([
      response(200, new TextEncoder().encode(raw), { 'content-type': 'application/json' })
    ]);
    const provider = new BuiltinTtsProvider(
      http,
      config('tts', 'volc-tts', 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', 'unused-by-wire', {
        voice: 'zh_female_xiaohe_moon_bigtts',
        resourceId: 'seed-tts-2.0',
        format: 'mp3',
        emotionMode: 'auto'
      })
    );

    const audio = await provider.synthesize('你好');
    expect([...new Uint8Array(audio.data)]).toEqual([1, 2, 3]);

    const request = http.requests[0]!;
    expect(request.url).toBe('https://openspeech.bytedance.com/api/v3/tts/unidirectional');
    expect(request.secretHeader).toBe('X-Api-Key');
    expect(request.secretPrefix).toBe('');
    expect(request.headers?.['X-Api-Resource-Id']).toBe('seed-tts-2.0');

    const body = jsonBody(request);
    expect(body).not.toHaveProperty('model');
    expect(body.user).toEqual({ uid: 'sooya' });
    expect(body.req_params).toMatchObject({
      text: '你好',
      speaker: 'zh_female_xiaohe_moon_bigtts'
    });
  });

  it('rejects Volc error lines instead of returning truncated audio', () => {
    expect(() => decodeVolcStream(`${JSON.stringify({ code: 45_000_001, message: 'InvalidModel' })}\n`))
      .toThrow(/InvalidModel/u);
  });
});
