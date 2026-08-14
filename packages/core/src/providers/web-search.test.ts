import { describe, expect, it } from 'vitest';
import type { ConfigRepository, ProviderConfig } from '../db/config.repo.js';
import type { HttpPlatform, HttpResponse } from '../platform/http.js';
import { DoubaoSearchProvider, TavilySearchProvider, createWebSearch } from './web-search.js';

function fakeConfig(partial: Partial<ProviderConfig>): ProviderConfig {
  return {
    capability: 'webSearch',
    provider: 'doubao',
    baseUrl: 'https://example.test',
    model: '',
    secretRef: 'websearch.doubao.key',
    enabled: true,
    options: {},
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...partial
  };
}

function fakeHttp(status: number, payload: unknown, recorded: { requests: Array<Record<string, unknown>> }): HttpPlatform {
  return {
    async request(input) {
      recorded.requests.push({ url: input.url, method: input.method, headers: input.headers, body: input.body, secretRef: input.secretRef, secretHeader: input.secretHeader, secretPrefix: input.secretPrefix });
      const body = new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
      const response: HttpResponse = { status, headers: { 'content-type': 'application/json' }, body };
      return response;
    },
    async stream() { throw new Error('not used'); }
  };
}

function fakeRepo(provider: ProviderConfig | null): Pick<ConfigRepository, 'getProvider'> {
  return { getProvider: async () => provider };
}

describe('DoubaoSearchProvider', () => {
  it('posts the search query with Keychain secret ref forwarding', async () => {
    const recorded: { requests: Array<Record<string, unknown>> } = { requests: [] };
    const http = fakeHttp(200, {
      Result: {
        WebResults: [
          { Title: '示例标题', Url: 'https://example.com/a', Summary: '摘要内容', SiteName: '示例站', PublishTime: '2026-08-13' },
          { Title: '坏链接', Url: 'javascript:alert(1)' }
        ]
      }
    }, recorded);
    const provider = new DoubaoSearchProvider(http, fakeConfig({}));
    const result = await provider.search({ query: '测试', maxResults: 5 });
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({ title: '示例标题', url: 'https://example.com/a', snippet: '摘要内容', siteName: '示例站' });
    expect(recorded.requests[0]).toMatchObject({
      url: 'https://example.test/api/contents/query',
      method: 'POST',
      secretRef: 'websearch.doubao.key',
      secretHeader: 'authorization',
      secretPrefix: 'Bearer '
    });
    expect(JSON.parse(String(recorded.requests[0]!.body))).toMatchObject({ Query: '测试', SearchType: 'web' });
  });

  it('reports unconfigured state without a base url or secret ref', async () => {
    const provider = new DoubaoSearchProvider(fakeHttp(200, {}, { requests: [] }), fakeConfig({ baseUrl: '', secretRef: null }));
    expect(provider.configured).toBe(false);
    await expect(provider.search({ query: 'x', maxResults: 3 })).rejects.toThrow();
  });
});

describe('TavilySearchProvider', () => {
  it('parses tavily results and prefixes CJK-only queries', async () => {
    const recorded: { requests: Array<Record<string, unknown>> } = { requests: [] };
    const http = fakeHttp(200, { results: [{ title: 'T', url: 'https://t.example', content: 'c' }] }, recorded);
    const provider = new TavilySearchProvider(http, fakeConfig({ provider: 'tavily' }));
    const result = await provider.search({ query: '纯中文', maxResults: 3 });
    expect(result.citations).toHaveLength(1);
    expect(JSON.parse(String(recorded.requests[0]!.body))).toMatchObject({ query: 'web search: 纯中文' });
  });
});

describe('createWebSearch', () => {
  it('returns null when the webSearch provider is not configured', async () => {
    const runtime = await createWebSearch(fakeHttp(200, {}, { requests: [] }), fakeRepo(null) as ConfigRepository);
    expect(runtime).toBeNull();
  });

  it('builds a single-provider runtime from the config', async () => {
    const runtime = await createWebSearch(fakeHttp(200, {}, { requests: [] }), fakeRepo(fakeConfig({ provider: 'tavily', options: { maxResults: 7 } })) as ConfigRepository);
    expect(runtime).not.toBeNull();
    expect(runtime!.order).toEqual(['tavily']);
    expect(runtime!.maxResults).toBe(7);
  });
});
