import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../db/config.repo.js';
import type { HttpPlatform, HttpRequest, HttpResponse, HttpResponseHead } from '../platform/http.js';
import { BuiltinImageProvider } from './media-providers.js';

const REFERENCE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function config(): ProviderConfig {
  return {
    capability: 'image',
    provider: 'anuma-input-images',
    baseUrl: 'https://anuma.example.test',
    model: 'sooya-image-v1',
    secretRef: 'provider.image.key',
    enabled: true,
    options: {},
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z'
  };
}

function json(value: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value))
  };
}

class UploadStringHttp implements HttpPlatform {
  readonly requests: HttpRequest[] = [];

  constructor(private readonly uploadResponse: HttpResponse) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    if (request.url.endsWith('/media/upload')) return this.uploadResponse;
    if (request.url.endsWith('/images/generations')) {
      return json({ data: [{ b64_json: 'AQID', mime_type: 'image/png' }] });
    }
    throw new Error(`unexpected request: ${request.url}`);
  }

  async stream(_request: HttpRequest, _onChunk: (chunk: Uint8Array) => void): Promise<HttpResponseHead> {
    throw new Error('stream not used');
  }
}

describe('Anuma upload URL response compatibility', () => {
  it('accepts a top-level HTTPS JSON string returned by /media/upload', async () => {
    const signedUrl = `https://cdn.example.test/reference.png?signature=${'x'.repeat(1100)}`;
    const http = new UploadStringHttp(json(signedUrl));
    const provider = new BuiltinImageProvider(http, config());

    await provider.generate('窗边自拍', {
      referenceImages: [{ data: REFERENCE_PNG, mime: 'image/png' }]
    });

    expect(http.requests.map((request) => request.url)).toEqual([
      'https://anuma.example.test/media/upload',
      'https://anuma.example.test/images/generations'
    ]);
    const generation = http.requests[1];
    const body = JSON.parse(String(generation?.body)) as Record<string, unknown>;
    expect(body.input_images).toEqual([signedUrl]);
  });

  it('still rejects top-level HTTP strings and does not leak the URL', async () => {
    const insecureUrl = 'http://10.0.0.1/private/reference.png?signature=do-not-leak';
    const http = new UploadStringHttp(json(insecureUrl));
    const provider = new BuiltinImageProvider(http, config());

    let thrown: unknown;
    try {
      await provider.generate('窗边自拍', {
        referenceImages: [{ data: REFERENCE_PNG, mime: 'image/png' }]
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('type=string');
    expect((thrown as Error).message).toContain('scheme=http');
    expect((thrown as Error).message).not.toContain('10.0.0.1');
    expect((thrown as Error).message).not.toContain('do-not-leak');
  });
});
