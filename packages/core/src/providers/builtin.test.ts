import { describe, expect, it } from 'vitest';
import type { HttpPlatform, HttpRequest, HttpResponse, HttpResponseHead } from '../platform/http.js';
import type { ProviderConfig } from '../db/config.repo.js';
import { BuiltinChatProvider } from './builtin.js';
import { BuiltinTtsProvider } from './media-providers.js';

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

class StreamingHttp extends FakeHttp {
  constructor(private readonly chunks: Uint8Array[], private readonly streamHeaders: Record<string, string> = { 'content-type': 'text/event-stream' }) { super([]); }
  override async stream(request: HttpRequest, onChunk: (chunk: Uint8Array) => void): Promise<HttpResponseHead> {
    this.requests.push(request);
    for (const chunk of this.chunks) onChunk(chunk);
    return { status: 200, headers: this.streamHeaders };
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

const streamChunks = (value: string, sizes: number[] = [5, 2, 11]): Uint8Array[] => {
  const bytes = new TextEncoder().encode(value);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) { if (offset >= bytes.length) break; chunks.push(bytes.slice(offset, offset + size)); offset += size; }
  if (offset < bytes.length) chunks.push(bytes.slice(offset));
  return chunks;
};

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

  it('parses split OpenAI SSE text, tool arguments and finish metadata', async () => {
    const openAiToolDelta = JSON.stringify({ choices: [{ delta: { content: '好', tool_calls: [{ index: 0, id: 'call-1', function: { name: 'life.today', arguments: '{"day":"today"' } }] } }] });
    const body = [
      'data: {"model":"stream-model","choices":[{"delta":{"content":"你"}}]}\n\n',
      `data: ${openAiToolDelta}\n\n`,
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n'
    ].join('');
    const http = new StreamingHttp(streamChunks(body, [1, 3, 2, 7]));
    const provider = new BuiltinChatProvider(http, config('chat'));
    const chunks: Array<{ delta: string; toolCall?: unknown; finishReason?: string }> = [];
    const result = await provider.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: '今天' }] }] }, (chunk) => chunks.push(chunk));

    expect(result).toMatchObject({ text: '你好', finishReason: 'tool_calls', model: 'stream-model', usage: { promptTokens: 4, completionTokens: 3 } });
    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'life.today', arguments: { day: 'today' } }]);
    expect(chunks.map((chunk) => chunk.delta).filter(Boolean)).toEqual(['你', '好']);
    expect(http.requests[0]).toMatchObject({ secretRef: 'provider.chat.key', secretHeader: 'Authorization' });
    expect(JSON.parse(String(http.requests[0]?.body))).toMatchObject({ stream: true });
  });

  it('parses Anthropic event names and input_json_delta fragments', async () => {
    const body = [
      'event: message_start\ndata: {"message":{"model":"claude-stream","usage":{"input_tokens":5}}}\n\n',
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"tool_use","id":"tool-1","name":"life.today"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"day\\":"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"\\"today\\"}"}}\n\n',
      'event: content_block_start\ndata: {"index":1,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"index":1,"delta":{"type":"text_delta","text":"在的"}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n'
    ].join('');
    const http = new StreamingHttp(streamChunks(body, [4, 1, 9, 2]));
    const provider = new BuiltinChatProvider(http, config('chat', { provider: 'anthropic', secretRef: 'provider.chat.key' }));
    const result = await provider.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] }, () => undefined);

    expect(result).toMatchObject({ text: '在的', finishReason: 'end_turn', model: 'claude-stream', usage: { promptTokens: 5, completionTokens: 2 } });
    expect(result.toolCalls).toEqual([{ id: 'tool-1', name: 'life.today', arguments: { day: 'today' } }]);
    expect(http.requests[0]).toMatchObject({ secretHeader: 'x-api-key', secretPrefix: '' });
  });
});
