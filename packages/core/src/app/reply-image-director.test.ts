import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, MessagePart } from '../db/types.js';
import type { MessageRepo } from '../db/message.repo.js';
import type { ReplyBatchRepo } from '../db/reply-batch.repo.js';
import type { MemoryProvider } from '../memory/types.js';
import type { BinaryData, ChatProvider, ChatRequest, ChatResult, GeneratedImage, HealthStatus, ImageProvider } from '../providers/types.js';
import { ImageEditUnsupportedError } from '../providers/types.js';
import type { MediaPlatform, MediaRecord } from '../platform/media.js';
import { installReplyFeatureRuntime, type ReplyFeatureRuntime } from './reply-feature-runtime.js';
import { ReplyCoordinator } from './reply-coordinator.js';
import { DirectorClient } from './director/client.js';
import { MediaDirector } from './media-director.js';
import { StaleGenerationError } from './stale-generation.js';

function message(id: string, role: ChatMessage['role'], parts: MessagePart[]): ChatMessage {
  return {
    id,
    conversationId: 'main',
    role,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    seq: Number(id.replace(/\D/gu, '')) || 1,
    status: 'sent',
    clientMsgId: null,
    replyTo: null,
    error: null,
    content: parts,
    meta: {}
  };
}

const text = (id: string, value: string): MessagePart =>
  ({ id, type: 'text', text: value, mediaId: null, status: 'sent', error: null, duration: null, transcript: null, meta: {} });
const image = (id: string, mediaId: string): MessagePart =>
  ({ id, type: 'image', text: null, mediaId, status: 'sent', error: null, duration: null, transcript: null, meta: {} });

class FakeMessages {
  readonly messages = new Map<string, ChatMessage>();
  readonly appended: Array<{ messageId: string; part: MessagePart }> = [];
  readonly statusCalls: Array<{ id: string; status: string; error?: string | null }> = [];

  constructor(initial: ChatMessage[]) { for (const item of initial) this.messages.set(item.id, item); }

  async create(input: { role: 'assistant'; parts: Array<{ type: MessagePart['type']; text?: string | null }>; meta?: Record<string, unknown> }) {
    const created: ChatMessage = message('assistant-1', 'assistant', input.parts.map((part, index) => ({ ...text(`a-p-${index}`, part.text ?? ''), type: part.type })));
    created.status = 'sending';
    created.meta = input.meta ?? {};
    this.messages.set(created.id, created);
    return { message: created, created: true };
  }
  async get(id: string) { return this.messages.get(id); }
  async recent() { return [...this.messages.values()]; }
  async updatePart() {}
  async appendPart(messageId: string, input: { type: MessagePart['type']; status?: MessagePart['status']; mediaId?: string | null; meta?: Record<string, unknown>; error?: string | null }) {
    const target = this.messages.get(messageId)!;
    const created: MessagePart = { id: `part-${target.content.length + 1}`, type: input.type, text: null, mediaId: input.mediaId ?? null, status: input.status ?? 'sent', error: input.error ?? null, duration: null, transcript: null, meta: input.meta ?? {} };
    target.content.push(created);
    this.appended.push({ messageId, part: created });
    return created.id;
  }
  async setStatus(id: string, status: string, error?: string | null) {
    const target = this.messages.get(id);
    if (target) { target.status = status as ChatMessage['status']; target.error = error ?? null; }
    this.statusCalls.push({ id, status, error });
  }
  async updateMeta() {}
}

class FakeBatches {
  revision = 1;
  readonly superseded: string[] = [];
  readonly failed: Array<{ batchId: string; message: string }> = [];
  completed = false;

  async get() { return { id: 'batch-1', revision: this.revision, status: 'queued', attempts: 0 }; }
  async markRunning(_id: string, revision: number) { return { id: 'batch-1', revision, status: 'generating', attempts: 1 }; }
  async messageIds() { return this.batchMessageIds; }
  readonly batchMessageIds: string[] = [];
  async currentRevision() { return this.revision; }
  async complete() { this.completed = true; return true; }
  async fail(batchId: string, message: string) { this.failed.push({ batchId, message }); }
  async supersede(_batchId: string, revision: number) { this.superseded.push(String(revision)); }
  async latestOpen() { return undefined; }
}

class FakeMemory { async search() { return []; } async commit() {} }

class FakeChat implements ChatProvider {
  readonly configured = true;
  readonly name = 'chat';
  constructor(private readonly raw: string) {}
  async complete(): Promise<ChatResult> { throw new Error('not used'); }
  async stream(_request: ChatRequest, onChunk: (chunk: { delta: string }) => void): Promise<ChatResult> {
    if (this.raw) onChunk({ delta: this.raw });
    return { text: this.raw, model: 'chat', finishReason: 'stop' };
  }
  async inspectHealth(): Promise<HealthStatus> { throw new Error('not used'); }
}

/** Director-slot chat provider: records requests, returns configured JSON. */
class FakeDirectorModel implements ChatProvider {
  readonly configured = true;
  readonly name = 'director-model';
  readonly inputs: string[] = [];
  constructor(private readonly json: string, private readonly failWith?: Error) {}
  async complete(request: ChatRequest): Promise<ChatResult> {
    this.inputs.push(request.messages.map((turn) => (turn as { content: Array<{ text?: string }> }).content.map((part) => part.text ?? '').join('')).join('|'));
    if (this.failWith) throw this.failWith;
    return { text: this.json, model: 'director-model' };
  }
  async stream(): Promise<ChatResult> { throw new Error('not used'); }
  async inspectHealth(): Promise<HealthStatus> { throw new Error('not used'); }
}

class FakeImageProvider implements ImageProvider {
  readonly configured = true;
  readonly name = 'anuma-input-images';
  readonly generateCalls: Array<{ prompt: string; references?: unknown[] }> = [];
  readonly editCalls: Array<{ prompt: string; mime?: string }> = [];
  constructor(private readonly failGenerate?: unknown, private readonly failEdit?: unknown) {}
  async generate(prompt: string, options?: { referenceImages?: Array<{ data: BinaryData; mime: string }> }): Promise<GeneratedImage> {
    this.generateCalls.push({ prompt, references: options?.referenceImages });
    if (this.failGenerate) throw this.failGenerate;
    return { data: new Uint8Array([1, 2, 3]), mime: 'image/png' };
  }
  async edit(prompt: string, _image: BinaryData, options?: { mime?: string }): Promise<GeneratedImage> {
    this.editCalls.push({ prompt, mime: options?.mime });
    if (this.failEdit) throw this.failEdit;
    return { data: new Uint8Array([4, 5, 6]), mime: 'image/png' };
  }
  async inspectHealth(): Promise<HealthStatus> { throw new Error('not used'); }
}

class RecordingMedia implements MediaPlatform {
  readonly saved: MediaRecord[] = [];
  readonly destroyed: string[] = [];
  readonly files = new Map<string, Uint8Array>([['user-img-1', new Uint8Array([9])], ['user-img-2', new Uint8Array([8])]]);
  async save(request: { kind: MediaRecord['kind']; data: BinaryData; mime?: string }) {
    const record: MediaRecord = { id: `media-${this.saved.length + 1}`, kind: request.kind, mime: request.mime ?? 'image/png', bytes: request.data instanceof Uint8Array ? request.data.byteLength : 0 };
    this.saved.push(record);
    return record;
  }
  async read(id: string) {
    const data = this.files.get(id);
    if (!data) return null;
    const record: MediaRecord = { id, kind: 'image', mime: 'image/png', bytes: data.byteLength };
    return { record, data };
  }
  async remove() { return true; }
  async destroy(id: string) { this.destroyed.push(id); return true; }
}

interface Harness {
  messages: FakeMessages;
  batches: FakeBatches;
  events: Array<{ type: string; data: Record<string, unknown> }>;
  imageProvider: FakeImageProvider;
  directorModel: FakeDirectorModel;
  media: RecordingMedia;
  referenceHints: Array<string | undefined>;
  run: () => Promise<void>;
}

function harness(options: {
  rawText: string;
  initialMessages: ChatMessage[];
  batchUserIds: string[];
  directorJson?: string;
  directorFailWith?: Error;
  imageFailGenerate?: unknown;
  imageProvider?: FakeImageProvider;
  mediaDirector?: MediaDirector;
}): Harness {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const messages = new FakeMessages(options.initialMessages);
  const batches = new FakeBatches();
  batches.batchMessageIds.push(...options.batchUserIds);
  const directorModel = new FakeDirectorModel(options.directorJson ?? '{"prompt":"扩写后的雨夜咖啡店摄影提示词，暖黄灯光，橱窗雾气，真实皮肤质感","aspectRatio":"3:4"}', options.directorFailWith);
  const imageProvider = options.imageProvider ?? new FakeImageProvider(options.imageFailGenerate);
  const media = new RecordingMedia();
  const referenceHints: Array<string | undefined> = [];
  const mediaDirector = options.mediaDirector ?? new MediaDirector(new DirectorClient(() => directorModel));
  const runtime: ReplyFeatureRuntime = {
    media,
    imageProvider: async () => imageProvider,
    referenceImages: async (hint?: string) => { referenceHints.push(hint); return [{ data: new Uint8Array([7]), mime: 'image/png' }]; }
  };
  installReplyFeatureRuntime(runtime);
  const coordinator = new ReplyCoordinator({
    messages: messages as unknown as MessageRepo,
    batches: batches as unknown as ReplyBatchRepo,
    memory: new FakeMemory() as unknown as MemoryProvider,
    provider: new FakeChat(options.rawText),
    mediaDirector,
    emit: (type, data) => events.push({ type, data })
  });
  return { messages, batches, events, imageProvider, directorModel, media, referenceHints, run: () => coordinator.run('batch-1', 1) };
}

describe('image intents through the media director', () => {
  beforeEach(() => installReplyFeatureRuntime(null));
  afterEach(() => installReplyFeatureRuntime(null));

  it('expands a normal image intent before it reaches the provider', async () => {
    const user = message('u1', 'user', [text('u1-p', '画一张雨夜街边的小咖啡店')]);
    const { messages, imageProvider, directorModel, media, run } = harness({ rawText: '[[image:雨夜咖啡店]]', initialMessages: [user], batchUserIds: ['u1'] });

    await run();

    expect(directorModel.inputs.join(' ')).toContain('雨夜咖啡店');
    expect(imageProvider.generateCalls).toHaveLength(1);
    expect(imageProvider.generateCalls[0]!.prompt).toContain('扩写后的雨夜咖啡店');
    expect(imageProvider.generateCalls[0]!.references).toBeUndefined();
    const assistant = await messages.get('assistant-1');
    const part = assistant!.content.find((item) => item.type === 'image')!;
    expect(part.mediaId).toBe('media-1');
    expect(part.meta.aspectRatio).toBe('3:4');
    expect(media.saved[0]!.kind).toBe('image');
  });

  it('selects selfie framing from the director-expanded prompt', async () => {
    const user = message('u1', 'user', [text('u1-p', '拍一张你站在海边的全身照')]);
    const { referenceHints, imageProvider, run } = harness({ rawText: '[[image-self:站在海边的全身照]]', initialMessages: [user], batchUserIds: ['u1'] });

    await run();

    expect(referenceHints).toHaveLength(1);
    expect(referenceHints[0]).toContain('扩写后的雨夜咖啡店'); // the expanded prompt, not the raw intent
    expect(imageProvider.generateCalls[0]!.prompt).toContain('扩写后的雨夜咖啡店');
    expect(imageProvider.generateCalls[0]!.references).toHaveLength(1);
  });

  it('uses the deterministic fallback prompt when the director model fails', async () => {
    const user = message('u1', 'user', [text('u1-p', '画一张雨夜咖啡店')]);
    const { imageProvider, messages, run } = harness({
      rawText: '[[image:雨夜咖啡店]]',
      initialMessages: [user],
      batchUserIds: ['u1'],
      directorFailWith: new Error('director endpoint down')
    });

    await run();

    expect(imageProvider.generateCalls).toHaveLength(1);
    expect(imageProvider.generateCalls[0]!.prompt).not.toContain('reference image');
    expect(imageProvider.generateCalls[0]!.prompt).toContain('雨夜咖啡店');
    const assistant = await messages.get('assistant-1');
    expect(assistant!.status).toBe('sent');
    expect(assistant!.content.some((item) => item.type === 'image' && item.status === 'sent')).toBe(true);
  });

  it('propagates an interrupted director call instead of generating a fallback image', async () => {
    const user = message('u1', 'user', [text('u1-p', '画一张雨夜咖啡店')]);
    const interrupted: MediaDirector = {
      image: () => Promise.reject(new StaleGenerationError('director lost its revision'))
    } as unknown as MediaDirector;
    const { messages, batches, imageProvider, media, run } = harness({
      rawText: '[[image:雨夜咖啡店]]',
      initialMessages: [user],
      batchUserIds: ['u1'],
      mediaDirector: interrupted
    });

    await run();

    expect(imageProvider.generateCalls).toHaveLength(0);
    expect(media.saved).toHaveLength(0);
    expect(batches.superseded).toEqual(['1']);
    expect(batches.failed).toEqual([]);
    const assistant = await messages.get('assistant-1');
    expect(assistant!.status).toBe('failed');
    expect(messages.appended.filter((entry) => entry.part.type === 'image')).toHaveLength(0);
  });
});

describe('user-image edit path', () => {
  beforeEach(() => installReplyFeatureRuntime(null));
  afterEach(() => installReplyFeatureRuntime(null));

  it('skips the director and edits the single user image verbatim', async () => {
    const user = message('u1', 'user', [image('u1-img', 'user-img-1'), text('u1-p', '把背景换成海边')]);
    const { imageProvider, directorModel, messages, run } = harness({ rawText: '好，我来改。[[image:把背景换成海边]]', initialMessages: [user], batchUserIds: ['u1'] });

    await run();

    expect(directorModel.inputs).toHaveLength(0);
    expect(imageProvider.editCalls).toHaveLength(1);
    expect(imageProvider.editCalls[0]!.prompt).toBe('把背景换成海边');
    expect(imageProvider.generateCalls).toHaveLength(0);
    const assistant = await messages.get('assistant-1');
    const part = assistant!.content.find((item) => item.type === 'image')!;
    expect(part.meta.editedUserImage).toBe(true);
    expect(part.meta.referenceMediaId).toBe('user-img-1');
    expect(part.meta.aspectRatio).toBeUndefined();
  });

  it('degrades to plain generation when the provider cannot edit', async () => {
    const user = message('u1', 'user', [image('u1-img', 'user-img-1'), text('u1-p', '把背景换成海边')]);
    const imageProvider = new FakeImageProvider(undefined, new ImageEditUnsupportedError('no edit endpoint'));
    const { messages, run } = harness({ rawText: '[[image:把背景换成海边]]', initialMessages: [user], batchUserIds: ['u1'], imageProvider });

    await run();

    expect(imageProvider.editCalls).toHaveLength(1);
    expect(imageProvider.generateCalls).toEqual([{ prompt: '把背景换成海边', references: undefined }]);
    const assistant = await messages.get('assistant-1');
    expect(assistant!.content.some((item) => item.type === 'image' && item.status === 'sent')).toBe(true);
  });

  it('does not guess with multiple user images and ignores images outside the batch', async () => {
    const older = message('u0', 'user', [image('u0-img', 'user-img-1')]);
    const userA = message('u1', 'user', [image('u1-img', 'user-img-1')]);
    const userB = message('u2', 'user', [image('u2-img', 'user-img-2'), text('u2-p', '把这两张合成一张')]);
    const { imageProvider, directorModel, run } = harness({
      rawText: '[[image:合成两张图]]',
      initialMessages: [older, userA, userB],
      batchUserIds: ['u1', 'u2']
    });

    await run();

    expect(directorModel.inputs).toHaveLength(1);
    expect(imageProvider.editCalls).toHaveLength(0);
    expect(imageProvider.generateCalls[0]!.references).toBeUndefined();
  });
});

describe('revision fence and orphan cleanup', () => {
  beforeEach(() => installReplyFeatureRuntime(null));
  afterEach(() => installReplyFeatureRuntime(null));

  it('destroys the just-saved image and reports superseded when the revision moves on', async () => {
    const user = message('u1', 'user', [text('u1-p', '画一张雨夜咖啡店')]);
    const { messages, batches, media, events, run } = harness({ rawText: '[[image:雨夜咖啡店]]', initialMessages: [user], batchUserIds: ['u1'] });
    const originalSave = media.save.bind(media);
    await (async () => {
      media.save = async (request) => {
        const record = await originalSave(request);
        batches.revision = 2;
        return record;
      };
    })();

    await run();

    expect(media.destroyed).toEqual(['media-1']);
    expect(messages.appended.filter((entry) => entry.part.type === 'image')).toHaveLength(0);
    expect(batches.superseded).toEqual(['1']);
    expect(batches.failed).toEqual([]);
    expect(events.some((event) => event.type === 'reply.failed')).toBe(false);
  });
});
