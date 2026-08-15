import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, MessagePart } from '../db/types.js';
import type { MessageRepo } from '../db/message.repo.js';
import type { ReplyBatchRepo } from '../db/reply-batch.repo.js';
import type { MemoryProvider } from '../memory/types.js';
import { ImagePipelineError, ProviderRequestError, type BinaryData, type ChatProvider, type ChatRequest, type ChatResult, type GeneratedImage, type HealthStatus, type ImageProvider } from '../providers/types.js';
import { installReplyFeatureRuntime, type ReplyFeatureRuntime } from './reply-feature-runtime.js';
import { ReplyCoordinator } from './reply-coordinator.js';

const BATCH = {
  id: 'batch-1',
  conversation_id: 'main',
  status: 'queued' as const,
  trigger_message_id: 'user-1',
  assistant_message_id: null,
  opened_at: '2026-08-16T00:00:00.000Z',
  due_at: '2026-08-16T00:00:05.000Z',
  started_at: null,
  completed_at: null,
  last_error: null,
  attempts: 0,
  lease_owner: null,
  lease_expires_at: null,
  meta_json: '{}',
  revision: 1,
  last_message_at: '2026-08-16T00:00:01.000Z',
  generation_started_at: null,
  publish_started_at: null,
  visible_at: null,
  retry_count: 0,
  interrupted_count: 0,
  superseded_at: null,
  failure_code: null
};

const USER_MESSAGE: ChatMessage = {
  id: 'user-1',
  conversationId: 'main',
  role: 'user',
  createdAt: '2026-08-16T00:00:01.000Z',
  updatedAt: '2026-08-16T00:00:01.000Z',
  seq: 1,
  status: 'sent',
  clientMsgId: null,
  replyTo: null,
  error: null,
  content: [{ id: 'user-part-1', type: 'text', text: '发张现在的照片给我', mediaId: null, status: 'sent', error: null, duration: null, transcript: null, meta: {} }],
  meta: {}
};

function part(id: string, text: string): MessagePart {
  return { id, type: 'text', text, mediaId: null, status: 'sent', error: null, duration: null, transcript: null, meta: {} };
}

class FakeMessageRepo {
  messages = new Map<string, ChatMessage>();
  readonly statusCalls: Array<{ id: string; status: string; error?: string | null }> = [];
  readonly metaCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
  readonly appendedParts: Array<{ messageId: string; part: MessagePart }> = [];

  constructor(initial: ChatMessage[] = [USER_MESSAGE]) {
    for (const message of initial) this.messages.set(message.id, message);
  }

  async create(input: { id?: string; role: ChatMessage['role']; status?: ChatMessage['status']; replyTo?: string | null; batchId?: string | null; parts: Array<{ type: MessagePart['type']; text?: string | null; mediaId?: string | null; meta?: Record<string, unknown> }>; meta?: Record<string, unknown> }) {
    const message: ChatMessage = {
      id: input.id ?? 'assistant-1',
      conversationId: 'main',
      role: input.role,
      createdAt: '2026-08-16T00:00:02.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
      seq: 2,
      status: input.status ?? 'sent',
      clientMsgId: null,
      replyTo: input.replyTo ?? null,
      error: null,
      content: input.parts.map((item, index) => ({ id: `part-${index + 1}`, type: item.type, text: item.text ?? null, mediaId: item.mediaId ?? null, status: 'sent', error: null, duration: null, transcript: null, meta: item.meta ?? {} })),
      meta: input.meta ?? {}
    };
    this.messages.set(message.id, message);
    return { message, created: true };
  }

  async get(id: string) { return this.messages.get(id); }
  async recent() { return [...this.messages.values()]; }
  async updatePart(partId: string, patch: Partial<MessagePart>) {
    for (const message of this.messages.values()) {
      const target = message.content.find((item) => item.id === partId);
      if (target) Object.assign(target, patch);
    }
  }
  async appendPart(messageId: string, input: { type: MessagePart['type']; status?: MessagePart['status']; error?: string | null; mediaId?: string | null; meta?: Record<string, unknown>; transcript?: string | null; duration?: number | null }) {
    const target = this.messages.get(messageId);
    if (!target) throw new Error(`message ${messageId} not found`);
    const created: MessagePart = {
      id: `media-${target.content.length + 1}`,
      type: input.type,
      text: null,
      mediaId: input.mediaId ?? null,
      status: input.status ?? 'sent',
      error: input.error ?? null,
      duration: input.duration ?? null,
      transcript: input.transcript ?? null,
      meta: input.meta ?? {}
    };
    target.content.push(created);
    this.appendedParts.push({ messageId, part: created });
    return created.id;
  }
  async setStatus(id: string, status: 'sent' | 'failed' | 'sending' | 'pending', error?: string | null) {
    const message = this.messages.get(id);
    if (message) { message.status = status; message.error = error ?? null; }
    this.statusCalls.push({ id, status, error });
  }
  async updateMeta(id: string, patch: Record<string, unknown>) {
    const message = this.messages.get(id);
    if (message) Object.assign(message.meta, patch);
    this.metaCalls.push({ id, patch });
  }
}

class FakeBatchRepo {
  readonly failedCalls: Array<{ batchId: string; message: string }> = [];
  completedAssistantId: string | null = null;

  async get(id: string) { return id === BATCH.id ? { ...BATCH } : undefined; }
  async markRunning(id: string, revision: number) { return { ...BATCH, status: 'generating' as const, attempts: 1, revision }; }
  async messageIds() { return ['user-1']; }
  async currentRevision() { return 1; }
  async complete(_batchId: string, assistantId: string) { this.completedAssistantId = assistantId; return true; }
  async fail(batchId: string, message: string) { this.failedCalls.push({ batchId, message }); }
  async supersede() {}
  async latestOpen() { return undefined; }
}

class FakeMemory {
  async search() { return []; }
  async commit() {}
}

class FakeChatProvider implements ChatProvider {
  readonly configured = true;
  readonly name = 'chat-test';
  constructor(private readonly raw: string) {}
  async complete(_request: ChatRequest): Promise<ChatResult> { throw new Error('complete is not used'); }
  async stream(_request: ChatRequest, onChunk: (chunk: { delta: string }) => void): Promise<ChatResult> {
    if (this.raw) onChunk({ delta: this.raw });
    return { text: this.raw, model: 'chat-test', finishReason: 'stop' };
  }
  async inspectHealth(): Promise<HealthStatus> {
    return { capability: 'chat', configured: true, ok: true, provider: this.name, checkedAt: new Date().toISOString() };
  }
}

class FakeImageProvider implements ImageProvider {
  readonly configured = true;
  readonly name = 'anuma-input-images';
  readonly generateCalls: string[] = [];
  constructor(private readonly failure?: unknown) {}
  async generate(prompt: string, _options?: { size?: string; signal?: AbortSignal; referenceImages?: Array<{ data: BinaryData; mime: string }> }): Promise<GeneratedImage> {
    this.generateCalls.push(prompt);
    if (this.failure !== undefined) throw this.failure;
    return { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' };
  }
  async edit(_prompt: string, _image: BinaryData, _options?: { mime?: string; signal?: AbortSignal }): Promise<GeneratedImage> { throw new Error('edit is not used'); }
  async inspectHealth(): Promise<HealthStatus> {
    return { capability: 'image', configured: true, ok: true, provider: this.name, checkedAt: new Date().toISOString() };
  }
}

function coordinator(options: {
  rawText: string;
  imageFailure: unknown;
  events: Array<{ type: string; data: Record<string, unknown> }>;
  runtime: ReplyFeatureRuntime;
  userText?: string;
}): { messages: FakeMessageRepo; batches: FakeBatchRepo; run: () => Promise<void> } {
  const user = options.userText ? { ...USER_MESSAGE, content: [{ ...USER_MESSAGE.content[0]!, text: options.userText }] } : USER_MESSAGE;
  const messages = new FakeMessageRepo([user]);
  const batches = new FakeBatchRepo();
  const memory = new FakeMemory();
  const provider = new FakeChatProvider(options.rawText);
  const coordinator = new ReplyCoordinator({
    messages: messages as unknown as MessageRepo,
    batches: batches as unknown as ReplyBatchRepo,
    memory: memory as unknown as MemoryProvider,
    provider,
    emit: (type, data) => options.events.push({ type, data })
  });
  return { messages, batches, run: () => coordinator.run('batch-1', 1) };
}

const failingImageRuntime = (failure?: unknown): ReplyFeatureRuntime => ({
  media: {
    async save(request) { return { id: 'media-1', kind: request.kind, mime: request.mime ?? 'image/png', bytes: request.data instanceof Uint8Array ? request.data.byteLength : 0 }; },
    async read() { return null; },
    async remove() { return false; }
  },
  imageProvider: async () => new FakeImageProvider(failure),
  referenceImages: async () => [{ data: new Uint8Array([1, 2, 3]), mime: 'image/png' }]
});

describe('reply image failure semantics', () => {
  beforeEach(() => installReplyFeatureRuntime(null));
  afterEach(() => installReplyFeatureRuntime(null));

  it('keeps generated text and completes the reply when the image API fails', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const failure = new ImagePipelineError('generation', 'upstream refused the request', 422);
    installReplyFeatureRuntime(failingImageRuntime(failure));
    const { messages, batches, run } = coordinator({ rawText: '给你拍了一张。[[image-self: 坐在窗边]]', imageFailure: failure, events, runtime: failingImageRuntime(failure) });

    await run();

    const assistant = (await messages.get('assistant-1'))!;
    expect(assistant.status).toBe('sent');
    expect(assistant.content.map((item) => item.type)).toEqual(['text', 'image']);
    expect(assistant.content[0]?.text).toBe('给你拍了一张。');
    expect(assistant.content[1]?.status).toBe('failed');
    expect(assistant.content[1]?.meta.stage).toBe('generation');
    expect(batches.completedAssistantId).toBe('assistant-1');
    expect(batches.failedCalls).toEqual([]);
    expect(events.some((event) => event.type === 'reply.completed')).toBe(true);
    expect(events.some((event) => event.type === 'reply.failed')).toBe(false);
    const failed = events.find((event) => event.type === 'reply.media.failed')?.data;
    expect(failed).toMatchObject({ type: 'image', stage: 'generation', status: 422, error: 'upstream refused the request' });
  });

  it('emits reference_read when reference selection fails and never calls generation', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const failure = new ImagePipelineError('reference_read', 'reference store unavailable');
    const imageProvider = new FakeImageProvider(failure);
    installReplyFeatureRuntime({
      ...failingImageRuntime(failure),
      imageProvider: async () => imageProvider,
      referenceImages: async () => { throw failure; }
    });
    const { messages, run } = coordinator({
      rawText: '给你拍了一张。[[image-self: 坐在窗边]]',
      imageFailure: failure,
      events,
      runtime: failingImageRuntime(failure)
    });

    await run();

    expect(imageProvider.generateCalls).toEqual([]);
    const assistant = (await messages.get('assistant-1'))!;
    expect(assistant.status).toBe('sent');
    expect(assistant.content.some((item) => item.type === 'image' && item.status === 'failed')).toBe(true);
    const failed = events.find((event) => event.type === 'reply.media.failed')?.data;
    expect(failed).toMatchObject({ type: 'image', stage: 'reference_read' });
    expect(events.some((event) => event.type === 'reply.failed')).toBe(false);
  });

  it('adds a fallback text when an image-only reply loses its image', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const failure = new ProviderRequestError('image service unavailable', 503);
    installReplyFeatureRuntime(failingImageRuntime(failure));
    const { messages, run } = coordinator({ rawText: '[[image-self: 坐在窗边喝咖啡]]', imageFailure: failure, events, runtime: failingImageRuntime(failure) });

    await run();

    const assistant = (await messages.get('assistant-1'))!;
    expect(assistant.status).toBe('sent');
    expect(assistant.content[0]?.type).toBe('text');
    expect(assistant.content[0]?.text).toBe('（图片生成失败了，可以再试一次。）');
    expect(assistant.content[1]?.type).toBe('image');
    expect(assistant.content[1]?.status).toBe('failed');
    expect(events.some((event) => event.type === 'reply.completed')).toBe(true);
    expect(events.some((event) => event.type === 'reply.failed')).toBe(false);
  });

  it('end-to-end image-only selfie keeps the assistant message sent with an image part', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const referenceHints: Array<string | undefined> = [];
    installReplyFeatureRuntime({
      ...failingImageRuntime(),
      referenceImages: async (hint?: string) => {
        referenceHints.push(hint);
        return [{ data: new Uint8Array([1, 2, 3]), mime: 'image/png' }];
      }
    });
    const { messages, batches, run } = coordinator({
      rawText: '[[image-self: 我坐在窗边喝咖啡]]',
      imageFailure: undefined,
      events,
      runtime: failingImageRuntime(),
      userText: '给我自拍'
    });

    await run();

    const assistant = (await messages.get('assistant-1'))!;
    expect(assistant.status).toBe('sent');
    expect(assistant.content.map((item) => item.type)).toEqual(['text', 'image']);
    expect(assistant.content[1]?.status).toBe('sent');
    expect(assistant.meta.mediaCount).toBe(1);
    expect(referenceHints).toEqual(['我坐在窗边喝咖啡']);
    expect(batches.completedAssistantId).toBe('assistant-1');
    expect(events.some((event) => event.type === 'reply.completed')).toBe(true);
    expect(events.some((event) => event.type === 'reply.failed')).toBe(false);
  });

  it('still fails the reply for real provider/database failures outside image execution', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const messages = new FakeMessageRepo();
    const batches = new FakeBatchRepo();
    const provider: ChatProvider = {
      name: 'chat-broken',
      configured: true,
      async complete() { throw new Error('complete is not used'); },
      async stream() { throw new ProviderRequestError('chat model down', 500); },
      async inspectHealth(): Promise<HealthStatus> { return { capability: 'chat', configured: true, ok: true, provider: this.name, checkedAt: new Date().toISOString() }; }
    };
    const coordinator = new ReplyCoordinator({
      messages: messages as unknown as MessageRepo,
      batches: batches as unknown as ReplyBatchRepo,
      memory: new FakeMemory() as unknown as MemoryProvider,
      provider,
      emit: (type, data) => events.push({ type, data })
    });

    await coordinator.run('batch-1', 1);

    expect(events.some((event) => event.type === 'reply.failed')).toBe(true);
    expect(events.some((event) => event.type === 'reply.completed')).toBe(false);
  });
});
