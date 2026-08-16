import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../db/config.repo.js';
import type { HttpPlatform, HttpRequest, HttpResponse, HttpResponseHead } from '../platform/http.js';
import { BuiltinImageProvider, describeAnumaUploadResponse, imageProtocol } from './media-providers.js';
import { ImagePipelineError } from './types.js';

const REFERENCE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const imageConfig = (provider: string, options: Record<string, unknown> = {}): ProviderConfig => ({
  capability: 'image',
  provider,
  baseUrl: 'https://anuma.example.test',
  model: 'sooya-image-v1',
  secretRef: 'provider.image.key',
  enabled: true,
  options,
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-08-16T00:00:00.000Z'
});

function jsonResponse(value: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value))
  };
}

const generatedImageResponse = jsonResponse({ data: [{ b64_json: 'AQID', mime_type: 'image/png' }] });

class RoutingHttp implements HttpPlatform {
  readonly requests: HttpRequest[] = [];
  constructor(
    private readonly routes: Array<{ match: (request: HttpRequest) => boolean; response: HttpResponse }> = []
  ) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const route = this.routes.find((item) => item.match(request));
    if (route) return route.response;
    if (request.url.endsWith('/media/upload')) return uploadRoute();
    return generatedImageResponse;
  }

  async stream(_request: HttpRequest, _onChunk: (chunk: Uint8Array) => void): Promise<HttpResponseHead> {
    throw new Error('stream is not used by image tests');
  }
}

function uploadRoute(): HttpResponse {
  return jsonResponse({ url: 'https://cdn.example.test/reference.png' });
}

describe('BuiltinImageProvider Anuma server parity', () => {
  it('resolves options.protocol to the Anuma input-images pipeline', async () => {
    expect(imageProtocol(imageConfig('anuma', { protocol: 'anuma-input-images' }))).toBe('anuma-input-images');
    expect(imageProtocol(imageConfig('anuma-input-images'))).toBe('anuma-input-images');
    expect(imageProtocol(imageConfig('openai-images'))).toBe('openai-images');
  });

  it('describes upload response structure without leaking URL values', () => {
    const secretUrl = 'https://cdn.example.test/private/reference.png?token=do-not-leak';
    const diagnostic = describeAnumaUploadResponse({ success: true, data: { url: secretUrl, id: 'private-id' } });

    expect(diagnostic).toContain('keys=[success,data]');
    expect(diagnostic).toContain('data=[url,id]');
    expect(diagnostic).toContain('data.url:https');
    expect(diagnostic).not.toContain('cdn.example.test');
    expect(diagnostic).not.toContain('do-not-leak');
    expect(diagnostic).not.toContain('private-id');
  });

  it('reports an insecure top-level URL only by field and scheme', () => {
    const diagnostic = describeAnumaUploadResponse({ url: 'http://10.0.0.1/private?signature=secret' });

    expect(diagnostic).toContain('keys=[url]');
    expect(diagnostic).toContain('urls=[url:http]');
    expect(diagnostic).not.toContain('10.0.0.1');
    expect(diagnostic).not.toContain('signature');
  });

  it('routes provider=anuma + options.protocol to /media/upload and /images/generations', async () => {
    const http = new RoutingHttp([
      { match: (request) => request.url === 'https://anuma.example.test/media/upload', response: uploadRoute() },
      { match: (request) => request.url === 'https://anuma.example.test/images/generations', response: generatedImageResponse }
    ]);
    const provider = new BuiltinImageProvider(http, imageConfig('anuma', { protocol: 'anuma-input-images' }));

    await provider.generate('窗边喝咖啡的自拍', { referenceImages: [{ data: REFERENCE_PNG, mime: 'image/png' }] });

    expect(http.requests.map((request) => request.url)).toEqual([
      'https://anuma.example.test/media/upload',
      'https://anuma.example.test/images/generations'
    ]);
    expect(provider.name).toBe('anuma-input-images');
  });

  it('never sends size/quality/style/response_format to Anuma even when saved', async () => {
    const http = new RoutingHttp();
    const provider = new BuiltinImageProvider(http, imageConfig('anuma', {
      protocol: 'anuma-input-images',
      size: '1920x1920',
      quality: 'hd',
      style: 'vivid',
      response_format: 'b64_json'
    }));

    await provider.generate('窗边喝咖啡的自拍', {
      size: '1024x1024',
      referenceImages: [{ data: REFERENCE_PNG, mime: 'image/png' }]
    });

    const generation = http.requests[1];
    expect(generation?.url).toBe('https://anuma.example.test/images/generations');
    const body = JSON.parse(String(generation?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'sooya-image-v1',
      prompt: '窗边喝咖啡的自拍',
      n: 1,
      input_images: ['https://cdn.example.test/reference.png']
    });
    expect(body).not.toHaveProperty('size');
    expect(body).not.toHaveProperty('quality');
    expect(body).not.toHaveProperty('style');
    expect(body).not.toHaveProperty('response_format');
  });

  it('keeps edit() on the same Anuma upload/generation pipeline', async () => {
    const http = new RoutingHttp();
    const provider = new BuiltinImageProvider(http, imageConfig('anuma', { protocol: 'anuma-input-images' }));

    await provider.edit('改成窗边光线', REFERENCE_PNG, { mime: 'image/png' });

    expect(http.requests.map((request) => request.url)).toEqual([
      'https://anuma.example.test/media/upload',
      'https://anuma.example.test/images/generations'
    ]);
  });

  it('uses only the first reference image, even when callers pass three', async () => {
    const http = new RoutingHttp();
    const provider = new BuiltinImageProvider(http, imageConfig('anuma-input-images'));

    await provider.generate('自拍', {
      referenceImages: [
        { data: REFERENCE_PNG, mime: 'image/png' },
        { data: REFERENCE_PNG, mime: 'image/png' },
        { data: REFERENCE_PNG, mime: 'image/png' }
      ]
    });

    expect(http.requests.filter((request) => request.url.endsWith('/media/upload'))).toHaveLength(1);
    const generation = http.requests.find((request) => request.url.endsWith('/images/generations'));
    const body = JSON.parse(String(generation?.body)) as Record<string, unknown>;
    expect(body.input_images).toEqual(['https://cdn.example.test/reference.png']);
  });

  it('keeps OpenAI-compatible size handling unchanged', async () => {
    const http = new RoutingHttp();
    const provider = new BuiltinImageProvider(http, imageConfig('openai-images', { size: '1024x1024' }));

    await provider.generate('一张抽象画');

    expect(http.requests[0]?.url).toBe('https://anuma.example.test/v1/images/generations');
    const body = JSON.parse(String(http.requests[0]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ size: '1024x1024', n: 1 });
  });

  it('attaches reference_upload/generation stages and HTTP status to failures', async () => {
    const uploadProvider = new BuiltinImageProvider(http400('/media/upload'), imageConfig('anuma-input-images'));
    await expect(uploadProvider.generate('自拍', { referenceImages: [{ data: REFERENCE_PNG, mime: 'image/png' }] }))
      .rejects.toMatchObject({ name: 'ImagePipelineError', stage: 'reference_upload', status: 400 });

    const generationProvider = new BuiltinImageProvider(http422('/images/generations'), imageConfig('anuma-input-images'));
    await expect(generationProvider.generate('自拍')).rejects.toMatchObject({ name: 'ImagePipelineError', stage: 'generation', status: 422 });
  });

  it('surfaces only safe response-shape diagnostics for invalid upload JSON', async () => {
    const secretUrl = 'https://cdn.example.test/private/reference.png?token=do-not-leak';
    const http = new RoutingHttp([
      {
        match: (request) => request.url.endsWith('/media/upload'),
        response: jsonResponse({ success: true, data: { url: secretUrl } })
      }
    ]);
    const provider = new BuiltinImageProvider(http, imageConfig('anuma-input-images'));

    let thrown: unknown;
    try {
      await provider.generate('自拍', { referenceImages: [{ data: REFERENCE_PNG, mime: 'image/png' }] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ImagePipelineError);
    expect((thrown as Error).message).toContain('keys=[success,data]');
    expect((thrown as Error).message).toContain('data.url:https');
    expect((thrown as Error).message).not.toContain('cdn.example.test');
    expect((thrown as Error).message).not.toContain('do-not-leak');
  });
});

function http400(suffix: string): HttpPlatform {
  return new RoutingHttp([
    { match: (request) => request.url.endsWith(suffix), response: jsonResponse({ error: 'bad request' }, 400) }
  ]);
}

function http422(suffix: string): HttpPlatform {
  return new RoutingHttp([
    { match: (request) => request.url.endsWith(suffix), response: jsonResponse({ error: 'unprocessable' }, 422) }
  ]);
}
