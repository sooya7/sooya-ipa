import { describe, expect, it } from 'vitest';
import type { ChatProvider, ChatRequest, ChatResult, HealthStatus } from '../../providers/types.js';
import { DirectorClient, DirectorTimeoutError } from './client.js';
import { decodeImageDirectorOutput, decodeVoiceDirectorOutput } from './schemas.js';
import type { DirectorEvent } from './types.js';

class FakeProvider implements ChatProvider {
  readonly name = 'fake';
  readonly configured: boolean;
  calls = 0;
  constructor(private readonly respond: () => Promise<ChatResult>, configured = true) {
    this.configured = configured;
  }
  async complete(request: ChatRequest): Promise<ChatResult> {
    this.calls += 1;
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('aborted');
    return await this.respond();
  }
  async stream(): Promise<ChatResult> { throw new Error('not used'); }
  async inspectHealth(): Promise<HealthStatus> { throw new Error('not used'); }
}

const chatResult = (text: string): ChatResult => ({ text, model: 'fake-model' });
const voiceRequest = { task: 'voice' as const, system: 's', input: 'i', decoder: decodeVoiceDirectorOutput, maxTokens: 10, temperature: 0.3, timeoutMs: 60_000 };

describe('DirectorClient', () => {
  it('decodes a valid response and emits started/completed', async () => {
    const events: DirectorEvent[] = [];
    const provider = new FakeProvider(async () => chatResult('{"text":"晚安","speed":1.02}'));
    const client = new DirectorClient(() => provider, { onEvent: (event) => events.push(event) });

    const result = await client.run(voiceRequest);

    expect(result?.data).toEqual({ text: '晚安', speed: 1.02 });
    expect(result?.model).toBe('fake-model');
    expect(events.map((event) => event.event)).toEqual(['started', 'completed']);
    expect(events[1]).not.toHaveProperty('input');
  });

  it('accepts fenced JSON output', async () => {
    const provider = new FakeProvider(async () => chatResult('```json\n{"text":"好","speed":2}\n```'));
    const client = new DirectorClient(() => provider);
    const result = await client.run(voiceRequest);
    expect(result?.data.speed).toBe(1.05); // clamped at the decoder boundary
  });

  it('returns null with invalid_json for undecodable output', async () => {
    const events: DirectorEvent[] = [];
    const provider = new FakeProvider(async () => chatResult('这不是 JSON'));
    const client = new DirectorClient(() => provider, { onEvent: (event) => events.push(event) });

    expect(await client.run(voiceRequest)).toBeNull();
    expect(events.at(-1)).toMatchObject({ event: 'failed', reason: 'invalid_json' });
  });

  it('maps a null resolver and an unconfigured provider to not_configured', async () => {
    const events: DirectorEvent[] = [];
    const onEvent = (event: DirectorEvent): void => { events.push(event); };
    expect(await new DirectorClient(() => null, { onEvent }).run(voiceRequest)).toBeNull();
    expect(await new DirectorClient(() => new FakeProvider(async () => chatResult(''), false), { onEvent }).run(voiceRequest)).toBeNull();
    expect(events.filter((event) => event.event === 'failed').every((event) => event.reason === 'not_configured')).toBe(true);
  });

  it('falls back (null) on its own timeout without touching the external signal', async () => {
    const events: DirectorEvent[] = [];
    const provider = new FakeProvider(() => new Promise<ChatResult>(() => undefined));
    const client = new DirectorClient(() => provider, { onEvent: (event) => events.push(event) });
    const external = new AbortController();

    const result = await client.run({ ...voiceRequest, timeoutMs: 10, signal: external.signal });

    expect(result).toBeNull();
    expect(external.signal.aborted).toBe(false);
    expect(events.at(-1)).toMatchObject({ event: 'failed', reason: 'timeout' });
  });

  it('rethrows an external abort instead of falling back', async () => {
    const provider = new FakeProvider(() => new Promise<ChatResult>(() => undefined));
    const client = new DirectorClient(() => provider);
    const external = new AbortController();
    const reason = new Error('reply superseded');
    setTimeout(() => external.abort(reason), 5);

    await expect(client.run({ ...voiceRequest, timeoutMs: 60_000, signal: external.signal })).rejects.toBe(reason);
  });

  it('rejects image prompts shorter than 10 chars at the decoder', () => {
    expect(decodeImageDirectorOutput({ prompt: '太短' })).toBeNull();
    expect(decodeImageDirectorOutput({ prompt: 'a'.repeat(4001) })).toBeNull();
    expect(decodeImageDirectorOutput({ prompt: '雨夜街边的温暖咖啡店', aspectRatio: '3:4' })).toEqual({ prompt: '雨夜街边的温暖咖啡店', aspectRatio: '3:4' });
    expect(decodeImageDirectorOutput({ prompt: '雨夜街边的温暖咖啡店', aspectRatio: 'x'.repeat(21) })).toEqual({ prompt: '雨夜街边的温暖咖啡店' });
  });
});

describe('DirectorTimeoutError', () => {
  it('carries a stable name', () => {
    expect(new DirectorTimeoutError('x').name).toBe('DirectorTimeoutError');
  });
});
