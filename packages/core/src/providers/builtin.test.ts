import { describe, expect, it } from 'vitest';
import type { HttpPlatform, HttpRequest, HttpResponse, HttpResponseHead } from '../platform/http.js';
import type { ProviderConfig } from '../db/config.repo.js';
import { BuiltinChatProvider, BuiltinTtsProvider } from './builtin.js';

class FakeHttp implements HttpPlatform {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly responses: HttpResponse[]) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return this.responses.shift()!;
  }

  async stream(_request: HttpRequest, _onChunk: (chunk: Uint8Array) => void): Promise<HttpResponseHead> {
    throw new Error('stream is not used by this test');
  }
}

const config = (capability: ProviderConfig['capability'], options: Partial<ProviderConfig> = {}): ProviderConfig => ({
  capability,
  provider: 'openai-compatible',
  baseUrl: 'https://api.example.test',
  model: 'test-model',
  secretRef: 'provider.chat.key',
  enabled: true,
  options: {},
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
  ...options
});

const jsonResponse = (value: unknown): HttpResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: new TextEncoder().encode(JSON.stringify(value))
});

describe('built-in provider adapters', () => {
  it('sends opaque secret references and parses OpenAI-compatible tool calls', async () => {
    const http = new FakeHttp([jsonResponse({
      model: 'test-model',
      choices: [{ finish_reason: 'tool_calls', message: { content: '准备好了', tool_calls: [{ id: 'call-1', function: { name: 'life.today', arguments: '{"day":"today"}' } }] } }]
    })]);
    const provider = new BuiltinChatProvider(http, config('chat'));

    const result = await provider.complete({
      system: '你是本地助手',
      messages: [{ role: 'user', content: [{ type: 'text', text: '今天怎么样？' }] }],
      tools: [{ name: 'life.today', inputSchema: { type: 'object' } }]
    });

    expect(result.text).toBe('准备好了');
    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'life.today', arguments: { day: 'today' } }]);
    expect(http.requests[0]).toMatchObject({
      url: 'https://api.example.test/v1/chat/completions',
      secretRef: 'provider.chat.key',
      secretHeader: 'Authorization',
      secretPrefix: 'Bearer '
    });
    expect(JSON.parse(String(http.requests[0]?.body))).toMatchObject({ model: 'test-model' });
  });

  it('accepts native binary TTS responses', async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33]);
    const http = new FakeHttp([{ status: 200, headers: { 'content-type': 'audio/mpeg' }, body: audio }]);
    const provider = new BuiltinTtsProvider(http, config('tts', { secretRef: 'provider.tts.key', model: 'voice-model' }));

    const result = await provider.synthesize('你好', { voice: 'alloy' });

    expect(Array.from(result.data as Uint8Array)).toEqual([0x49, 0x44, 0x33]);
    expect(result.mime).toBe('audio/mpeg');
    expect(http.requests[0]?.secretRef).toBe('provider.tts.key');
  });
});
