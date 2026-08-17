import { describe, expect, it } from 'vitest';
import type { HttpPlatform, HttpRequest, HttpResponse, HttpResponseHead } from '@sooya/core/platform';
import { probeNativeSelfieImage, type NativeProbeReferenceImage } from './NativeLocalCore.js';

const REFERENCE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageConfig() {
  return {
    capability: 'image' as const,
    provider: 'anuma',
    baseUrl: 'https://anuma.sooya.icu',
    model: 'sooya-image-v1',
    secretRef: 'provider.image.key',
    enabled: true,
    options: { protocol: 'anuma-input-images', size: '1920x1920' },
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z'
  };
}

function json(status: number, payload: unknown): HttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(payload)) };
}

function routingHttp(mode: 'ok' | 'generation-error'): { http: HttpPlatform; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const http: HttpPlatform = {
    async request(request: HttpRequest): Promise<HttpResponse> {
      requests.push(request);
      if (request.url.endsWith('/media/upload')) return json(200, { url: 'https://cdn.sooya.icu/ref.png' });
      if (request.url.endsWith('/images/generations')) {
        return mode === 'ok' ? json(200, { data: [{ b64_json: 'AQID', mime_type: 'image/png' }] }) : json(400, { error: 'bad generation request' });
      }
      return json(404, { error: 'unexpected route' });
    },
    async stream(request: HttpRequest, onChunk: (chunk: Uint8Array) => void): Promise<HttpResponseHead> {
      const response = await this.request(request);
      onChunk(response.body);
      return { status: response.status, headers: response.headers };
    }
  };
  return { http, requests };
}

function referenceImages(): Promise<NativeProbeReferenceImage[]> {
  return Promise.resolve([{ data: REFERENCE_PNG, mime: 'image/png', framing: 'front' }]);
}

describe('native selfie probe', () => {
  it('uploads exactly one selected reference and reuses the image pipeline', async () => {
    const { http, requests } = routingHttp('ok');
    const seenHints: string[] = [];
    const references = async (hint?: string): Promise<NativeProbeReferenceImage[]> => {
      seenHints.push(hint ?? '');
      return await referenceImages();
    };

    const result = await probeNativeSelfieImage(http, imageConfig(), { referenceImages: references });

    expect(seenHints).toHaveLength(1);
    expect(requests.map((request) => request.url)).toEqual([
      'https://anuma.sooya.icu/media/upload',
      'https://anuma.sooya.icu/images/generations'
    ]);
    const generation = JSON.parse(String(requests[1]?.body)) as Record<string, unknown>;
    expect(generation.input_images).toEqual(['https://cdn.sooya.icu/ref.png']);
    expect(generation).not.toHaveProperty('size');
    expect(result.mode).toBe('selfie');
    expect(result.framing).toBe('front');
    expect(result.detail).toContain('自拍链路正常');
  });

  it('surfaces the pipeline stage and HTTP status when selfie generation fails', async () => {
    const { http } = routingHttp('generation-error');
    await expect(probeNativeSelfieImage(http, imageConfig(), { referenceImages }))
      .rejects.toThrow(/图片自拍链路失败 · 阶段：图片生成 · HTTP 400/u);
  });
});
