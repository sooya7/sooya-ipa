import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, MessagePart } from '../db/types.js';
import type { MessageRepo } from '../db/message.repo.js';
import type { ReplyBatchRepo } from '../db/reply-batch.repo.js';
import type { MemoryProvider } from '../memory/types.js';
import type { VoiceGenerationInput, VoiceGenerationRow } from '../db/voice.repo.js';
import type { ChatProvider, ChatRequest, ChatResult, GeneratedImage, HealthStatus, ImageProvider, TTSProvider, SynthesizedAudio } from '../providers/types.js';
import type { MediaPlatform, MediaRecord } from '../platform/media.js';
import { installReplyFeatureRuntime, type ReplyFeatureRuntime } from './reply-feature-runtime.js';
import { ReplyCoordinator } from './reply-coordinator.js';
import { DirectorClient } from './director/client.js';
import { MediaDirector } from './media-director.js';
import { LocalVoiceService } from './voice/service.js';

function message(id: string, role: ChatMessage['role'], text: string): ChatMessage {
  return {
    id, conversationId: 'main', role,
    createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
    seq: Number(id.replace(/\D/gu, '')) || 1, status: 'sent', clientMsgId: null, replyTo: null, error: null,
    content: [{ id: `${id}-p`, type: 'text', text, mediaId: null, status: 'sent', error: null, duration: null, transcript: null, meta: {} }],
    meta: {}
  };
}
const textPart = (id: string, value: string): MessagePart =>
  ({ id, type: 'text', text: value, mediaId: null, status: 'sent', error: null, duration: null, transcript: null, meta: {} });

class FakeMessages {
  readonly messages = new Map<string, ChatMessage>();
  readonly appended: MessagePart[] = [];
  readonly deletedParts: string[] = [];
  readonly createdCalls: Array<{ parts: Array<{ type: string; text?: string | null }> }> = [];
  constructor(initial: ChatMessage[]) { for (const item of initial) this.messages.set(item.id, item); }
  async create(input: { role: 'assistant'; parts: Array<{ type: MessagePart['type']; text?: string | null }>; meta?: Record<string, unknown> }) {
    this.createdCalls.push({ parts: input.parts });
    const created: ChatMessage = {
      ...message('assistant-1', 'assistant', ''),
      content: input.parts.map((part, index) => ({ ...textPart(`a-p-${index}`, part.text ?? ''), type: part.type }))
    };
    created.status = 'sending';
    created.meta = input.meta ?? {};
    this.messages.set(created.id, created);
    return { message: created, created: true };
  }
  async get(id: string) { return this.messages.get(id); }
  async recent() { return [...this.messages.values()]; }
  async updatePart(partId: string, patch: Partial<MessagePart>) {
    for (const msg of this.messages.values()) {
      const target = msg.content.find((item) => item.id === partId);
      if (target) Object.assign(target, patch);
    }
  }
  async appendPart(messageId: string, input: { type: MessagePart['type']; text?: string | null; status?: MessagePart['status']; mediaId?: string | null; meta?: Record<string, unknown>; transcript?: string | null; duration?: number | null }) {
    const target = this.messages.get(messageId)!;
    const created: MessagePart = { id: `part-${target.content.length + 1}`, type: input.type, text: input.text ?? null, mediaId: input.mediaId ?? null, status: input.status ?? 'sent', error: null, duration: input.duration ?? null, transcript: input.transcript ?? null, meta: input.meta ?? {} };
    target.content.push(created);
    this.appended.push(created);
    return created.id;
  }
  async deletePart(partId: string) { this.deletedParts.push(partId); }
  async setStatus(id: string, status: string, error?: string | null) { const m = this.messages.get(id); if (m) { m.status = status as ChatMessage['status']; m.error = error ?? null; } }
  async updateMeta() {}
}

class FakeBatches {
  revision = 1;
  readonly superseded: string[] = [];
  readonly failed: Array<{ batchId: string; message: string }> = [];
  batchUserIds: string[] = [];
  completed = false;
  async get() { return { id: 'batch-1', revision: this.revision, status: 'queued', attempts: 0 }; }
  async markRunning(_id: string, revision: number) { return { id: 'batch-1', revision, status: 'generating', attempts: 1 }; }
  async messageIds() { return this.batchUserIds; }
  async currentRevision() { return this.revision; }
  async complete() { this.completed = true; return true; }
  async fail(batchId: string, message: string) { this.failed.push({ batchId, message }); }
  async supersede(_b: string, revision: number) { this.superseded.push(String(revision)); }
  async latestOpen() { return undefined; }
}
class FakeMemory { async search() { return []; } async commit() {} }

class FakeChat implements ChatProvider {
  readonly configured = true;
  readonly name = 'chat';
  constructor(private readonly raw: string) {}
  async complete(): Promise<ChatResult> { throw new Error('not used'); }
  async stream(_r: ChatRequest, onChunk: (chunk: { delta: string }) => void): Promise<ChatResult> {
    if (this.raw) onChunk({ delta: this.raw });
    return { text: this.raw, model: 'chat', finishReason: 'stop' };
  }
  async inspectHealth(): Promise<HealthStatus> { throw new Error('not used'); }
}

/** Director-slot model for voice scripts. */
class FakeDirectorModel implements ChatProvider {
  readonly configured = true;
  readonly name = 'director-model';
  readonly calls: string[] = [];
  private call = 0;
  constructor(private readonly scripts: string[]) {}
  async complete(request: ChatRequest): Promise<ChatResult> {
    this.calls.push(request.messages.map((t) => (t as { content: Array<{ text?: string }> }).content.map((p) => p.text ?? '').join('')).join('|'));
    const script = this.scripts[Math.min(this.call, this.scripts.length - 1)]!;
    this.call += 1;
    return { text: script, model: 'director-model' };
  }
  async stream(): Promise<ChatResult> { throw new Error('not used'); }
  async inspectHealth(): Promise<HealthStatus> { throw new Error('not used'); }
}

class FakeImageProvider implements ImageProvider {
  readonly configured = true;
  readonly name = 'anuma-input-images';
  readonly generateCalls: string[] = [];
  async generate(prompt: string): Promise<GeneratedImage> {
    this.generateCalls.push(prompt);
    return { data: new Uint8Array([3]), mime: 'image/png' };
  }
  async edit(): Promise<GeneratedImage> { throw new Error('edit not used'); }
  async inspectHealth(): Promise<HealthStatus> { throw new Error('not used'); }
}

class FakeTts implements TTSProvider {
  readonly configured = true;
  readonly inputs: Array<{ text: string; options?: Record<string, unknown> }> = [];
  constructor(readonly name: string, private readonly failWith?: Error) {}
  async synthesize(text: string, options?: Record<string, unknown>): Promise<SynthesizedAudio> {
    this.inputs.push({ text, options });
    if (this.failWith) throw this.failWith;
    return { data: new Uint8Array([1, 1]), mime: 'audio/mpeg', format: 'mp3', durationSec: 2 };
  }
  async inspectHealth(): Promise<HealthStatus> { throw new Error('not used'); }
}

class FakeVoices {
  rows = new Map<string, VoiceGenerationRow>();
  private next = 0;
  async create(input: VoiceGenerationInput): Promise<VoiceGenerationRow> {
    this.next += 1;
    const row = {
      id: `voice-${this.next}`, batch_id: input.batchId ?? null, revision: input.revision ?? 0,
      message_id: input.messageId ?? null, text_part_id: input.textPartId ?? null,
      mode: input.mode, requested_by: input.requestedBy, status: input.status ?? 'planned',
      spoken_text: input.spokenText, synthesis_text: input.synthesisText,
      delivery_json: JSON.stringify(input.delivery ?? {}), naturalness_json: JSON.stringify(input.naturalness ?? {}),
      provider: input.provider ?? null, retry_count: 0, started_at: null, completed_at: null, failed_at: null,
      failure_code: null, media_id: null, created_at: '2026-08-16T00:00:00.000Z', updated_at: '2026-08-16T00:00:00.000Z'
    } as VoiceGenerationRow;
    this.rows.set(row.id, row);
    return row;
  }
  async update(id: string, patch: Partial<VoiceGenerationRow>) { const row = this.rows.get(id); if (row) Object.assign(row, patch); }
  async get(id: string) { return this.rows.get(id); }
}
class FakeSettings {
  store = new Map<string, unknown>();
  async get<T>(key: string, fallback: T): Promise<T> { return (this.store.get(key) as T | undefined) ?? fallback; }
  async has(key: string) { return this.store.has(key); }
  async set<T>(key: string, value: T) { this.store.set(key, value); }
}

class VoiceMedia implements MediaPlatform {
  readonly saved: MediaRecord[] = [];
  readonly destroyed: string[] = [];
  async save(request: { kind: MediaRecord['kind']; data: Uint8Array; mime?: string }) {
    const record: MediaRecord = { id: `media-${this.saved.length + 1}`, kind: request.kind, mime: request.mime ?? 'audio/mpeg', bytes: request.data.byteLength };
    this.saved.push(record);
    return record;
  }
  async read() { return null; }
  async remove() { return true; }
  async destroy(id: string) { this.destroyed.push(id); return true; }
}

interface VoiceHarness {
  messages: FakeMessages;
  batches: FakeBatches;
  tts: FakeTts;
  fishTts: FakeTts;
  imageProvider: FakeImageProvider;
  director: FakeDirectorModel;
  voices: FakeVoices;
  media: VoiceMedia;
  events: Array<{ type: string; data: Record<string, unknown> }>;
  run: () => Promise<void>;
}

function voiceHarness(options: {
  rawText: string;
  userTexts: string[];
  directorScripts: string[];
  ttsName?: string;
  ttsFailWith?: Error;
}): VoiceHarness {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const users = options.userTexts.map((t, i) => message(`u${i + 1}`, 'user', t));
  const messages = new FakeMessages(users);
  const batches = new FakeBatches();
  batches.batchUserIds = users.map((u) => u.id);
  const director = new FakeDirectorModel(options.directorScripts);
  const tts = new FakeTts(options.ttsName ?? 'openai-compatible', options.ttsFailWith);
  const fishTts = tts;
  const voices = new FakeVoices();
  const settings = new FakeSettings();
  const media = new VoiceMedia();
  const imageProvider = new FakeImageProvider();
  const mediaDirector = new MediaDirector(new DirectorClient(() => director));
  const voiceService = new LocalVoiceService({
    voices: voices as unknown as ConstructorParameters<typeof LocalVoiceService>[0]['voices'],
    settings: settings as unknown as ConstructorParameters<typeof LocalVoiceService>[0]['settings'],
    messages: messages as unknown as MessageRepo,
    mediaDirector,
    persona: () => ({ name: 'SOOYA', voicePolicy: { enabled: true, maxCharsPerClip: 300 } }),
    emit: (type, data) => events.push({ type, data }),
    isCurrentRevision: async (_batchId, revision) => batches.revision === revision
  });
  installReplyFeatureRuntime({ media, imageProvider: async () => imageProvider, ttsProvider: async () => fishTts });
  const coordinator = new ReplyCoordinator({
    messages: messages as unknown as MessageRepo,
    batches: batches as unknown as ReplyBatchRepo,
    memory: new FakeMemory() as unknown as MemoryProvider,
    provider: new FakeChat(options.rawText),
    mediaDirector,
    voiceService,
    emit: (type, data) => events.push({ type, data })
  });
  return { messages, batches, tts: fishTts, fishTts, imageProvider, director, voices, media, events, run: () => coordinator.run('batch-1', 1) };
}

const actionReply = '（听到你这么说，我把声音放轻了一点）\n好。\n（顿了一下，像把手机凑近了些）\n是我。你早点休息。';

describe('voice V2 through the reply pipeline', () => {
  beforeEach(() => installReplyFeatureRuntime(null));
  afterEach(() => installReplyFeatureRuntime(null));

  it('complement synthesizes an independent script, never the display text', async () => {
    const h = voiceHarness({ rawText: `${actionReply}[[voice]]`, userTexts: ['今天真的好累'], directorScripts: ['{"text":"乖一点，今晚真的早点睡，好不好。","speed":1.0}'] });

    await h.run();

    expect(h.tts.inputs).toHaveLength(1);
    const ttsInput = h.tts.inputs[0]!.text;
    expect(ttsInput).not.toBe(actionReply);
    expect(ttsInput).not.toContain('把声音放轻');
    expect(ttsInput).not.toContain('顿了一下');
    expect(ttsInput).toContain('早点睡');
    // Transcript is the spoken text, not the reply text.
    const audio = h.messages.appended.find((part) => part.type === 'audio')!;
    expect(audio.transcript).toBe('乖一点，今晚真的早点睡，好不好。');
    expect(audio.meta).toMatchObject({ voiceMode: 'complement', requestedBy: 'model' });
    const generation = [...h.voices.rows.values()][0]!;
    expect(generation.status).toBe('published');
    expect(generation.spoken_text).toBe('乖一点，今晚真的早点睡，好不好。');
    // Text still published for complement.
    const assistant = await h.messages.get('assistant-1');
    expect(assistant!.content[0]?.text).toContain('是我。你早点休息。');
    expect(h.batches.failed).toEqual([]);
  });

  it('rejects a director echo of the reply: rewrite, then skip — never full read-back', async () => {
    const h = voiceHarness({
      rawText: `${actionReply}[[voice]]`,
      userTexts: ['跟我聊聊'],
      directorScripts: [`{"text":${JSON.stringify(actionReply)},"speed":1}`] // echoes the reply every time
    });

    await h.run();

    expect(h.director.calls.length).toBe(2); // initial + one guarded rewrite
    expect(h.tts.inputs).toHaveLength(0);   // never synthesized the echo
    const assistant = await h.messages.get('assistant-1');
    expect(assistant!.status).toBe('sent');
    expect(assistant!.content[0]?.text).toContain('早点休息。');
    expect(h.messages.appended.some((part) => part.type === 'audio')).toBe(false);
    expect(h.events.some((event) => event.type === 'voice.script.rejected')).toBe(true);
  });

  it('read_aloud is the only path allowed to synthesize the target text', async () => {
    const target = '把你刚才那段原样念出来';
    const h = voiceHarness({ rawText: '好的，我来念。[[voice]]', userTexts: [target], directorScripts: ['unused'] });

    await h.run();

    expect(h.tts.inputs).toHaveLength(1);
    expect(h.tts.inputs[0]!.text).toContain('我来念');
    const assistant = await h.messages.get('assistant-1');
    // read_aloud attaches to the existing text part; no new audio bubble.
    expect(h.messages.appended.some((part) => part.type === 'audio')).toBe(false);
    expect(assistant!.content[0]?.meta).toMatchObject({ readAloudMediaId: 'media-1' });
    expect(assistant!.content[0]?.text).toContain('好的，我来念。');
  });

  it('skips complement voice when the director is unavailable and keeps the text', async () => {
    const director = new FakeDirectorModel(['not json at all']);
    const users = [message('u1', 'user', '晚安啦')];
    const messages = new FakeMessages(users);
    const batches = new FakeBatches();
    batches.batchUserIds = ['u1'];
    const tts = new FakeTts('openai-compatible');
    const voices = new FakeVoices();
    const media = new VoiceMedia();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const mediaDirector = new MediaDirector(new DirectorClient(() => director));
    const voiceService = new LocalVoiceService({
      voices: voices as unknown as ConstructorParameters<typeof LocalVoiceService>[0]['voices'],
      settings: new FakeSettings() as unknown as ConstructorParameters<typeof LocalVoiceService>[0]['settings'],
      messages: messages as unknown as MessageRepo,
      mediaDirector,
      persona: () => ({ name: 'SOOYA', voicePolicy: { enabled: true, maxCharsPerClip: 300 } }),
      emit: (type, data) => events.push({ type, data }),
      isCurrentRevision: async () => true
    });
    installReplyFeatureRuntime({ media, ttsProvider: async () => tts });
    new ReplyCoordinator({
      messages: messages as unknown as MessageRepo,
      batches: batches as unknown as ReplyBatchRepo,
      memory: new FakeMemory() as unknown as MemoryProvider,
      provider: new FakeChat('晚安，好梦。[[voice]]'),
      mediaDirector, voiceService,
      emit: (type, data) => events.push({ type, data })
    }).run('batch-1', 1).catch(() => undefined);

    // The service is invoked through decide(); drive it directly instead:
    const decision = await voiceService.decide({ userIntent: 'none', modelVoice: true, text: '晚安，好梦。', ttsConfigured: true });
    const outcome = await voiceService.synthesizeInlineVoice({
      batchId: 'batch-1', revision: 1,
      shell: await messages.get('assistant-1') ?? null, textPartId: 'a-p-0',
      finalText: '晚安，好梦。', userText: '晚安啦',
      decision, modelEmotion: null, signal: new AbortController().signal,
      media, ttsProvider: tts
    });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'voice:no-script' });
    expect(tts.inputs).toHaveLength(0);
  });

  it('replace falls back to published text when TTS fails (user asked for voice)', async () => {
    const h = voiceHarness({
      rawText: '今天过得还不错，上午整理了房间，下午去了咖啡店。[[voice]]',
      userTexts: ['用语音回我，今天过得怎么样'],
      directorScripts: ['{"text":"今天还不错，整理了房间，还去了咖啡店。","speed":1.0}'],
      ttsFailWith: new Error('tts endpoint down')
    });

    await h.run();

    const assistant = await h.messages.get('assistant-1');
    expect(assistant!.status).toBe('sent');
    const textPartAfter = assistant!.content.find((part) => part.type === 'text')!;
    expect(textPartAfter.text).toContain('咖啡店');
    expect(textPartAfter.meta).toMatchObject({ voiceFallback: true, voiceMode: 'replace' });
    expect(h.messages.appended.some((part) => part.type === 'audio')).toBe(false);
    expect(h.batches.failed).toEqual([]);
    expect([...h.voices.rows.values()][0]!.status).toBe('failed');
    // Single TTS attempt: generation providers are never auto-retried.
    expect(h.tts.inputs).toHaveLength(1);
  });

  it('compiles the fish cue prefix only through the renderer', async () => {
    const h = voiceHarness({
      rawText: '晚安，早点睡。[[voice]]',
      userTexts: ['晚安'],
      directorScripts: ['{"text":"晚安，做个好梦。","speed":0.97}'],
      ttsName: 'fish'
    });

    await h.run();

    expect(h.tts.inputs).toHaveLength(1);
    const input = h.tts.inputs[0]!;
    expect(input.text.startsWith('[speaking softly] 晚安')).toBe(true);
    const speed = (input.options as { speed?: number } | undefined)?.speed;
    expect(speed).toBeGreaterThanOrEqual(0.94);
    expect(speed).toBeLessThanOrEqual(1.05);
    // Transcript stays clean of the cue.
    const audio = h.messages.appended.find((part) => part.type === 'audio')!;
    expect(audio.transcript).toBe('晚安，做个好梦。');
  });

  it('voice-only holds the whole draft: no shell, no deltas, audio is the first visible output', async () => {
    const h = voiceHarness({
      rawText: '今天还不错，整理了房间，还去了咖啡店。[[voice]]',
      userTexts: ['只发语音，别打字'],
      directorScripts: ['{"text":"今天还不错，整理了房间，还去了咖啡店，跟你语音说。","speed":1}']
    });

    await h.run();

    // Exactly one shell, created empty by the voice publish barrier.
    expect(h.messages.createdCalls).toEqual([{ parts: [] }]);
    // No streaming text ever reached the UI.
    expect(h.events.filter((event) => event.type === 'reply.text.delta')).toEqual([]);
    const assistant = await h.messages.get('assistant-1');
    expect(assistant!.status).toBe('sent');
    expect(assistant!.content.map((part) => part.type)).toEqual(['audio']);
    expect(assistant!.content[0]?.transcript).toContain('语音说');
    expect(h.batches.completed).toBe(true);
    expect(h.messages.createdCalls[0]!.parts).toEqual([]);
  });

  it('hold + image request: voice opens the shell, the deferred image attaches after the audio', async () => {
    const directorScripts = ['{"text":"睡前给你看看我的小猫。","speed":1}'];
    const h = voiceHarness({
      rawText: '给你看。[[voice]][[image:一只正在打盹的橘猫]]',
      userTexts: ['用语音回我，顺便画一张小猫图'],
      directorScripts
    });
    // Reuse the same director model for the image expansion (second task).
    let imageExpanded = false;
    const originalComplete = h.director.complete.bind(h.director);
    h.director.complete = async (request: ChatRequest) => {
      const result = await originalComplete(request);
      const input = request.messages.map((t) => (t as { content: Array<{ text?: string }> }).content.map((p) => p.text ?? '').join('')).join('');
      if (input.includes('Image2')) { imageExpanded = true; return { text: '{"prompt":"一只蜷着打盹的橘猫，暖黄台灯，真实手机摄影质感","aspectRatio":"3:4"}', model: 'director-model' }; }
      return result;
    };

    await h.run();

    expect(imageExpanded).toBe(true);
    const assistant = await h.messages.get('assistant-1');
    // Audio first (voice opened the barrier), then the deferred image.
    expect(assistant!.content.map((part) => part.type)).toEqual(['audio', 'image']);
    expect(h.messages.createdCalls).toEqual([{ parts: [] }]);
  });

  it('hold replace survives director unavailability through the rule-based script', async () => {
    const h = voiceHarness({
      rawText: '今天过得还行，上午看书，下午散步。[[voice]]',
      userTexts: ['用语音回我'],
      directorScripts: ['not json']
    });

    await h.run();

    expect(h.tts.inputs).toHaveLength(1);
    const assistant = await h.messages.get('assistant-1');
    expect(assistant!.content.map((part) => part.type)).toEqual(['audio']);
    expect(assistant!.status).toBe('sent');
    const generation = [...h.voices.rows.values()][0]!;
    expect(generation.status).toBe('published');
  });

  it('reports superseded and destroys the audio when the revision moves during TTS', async () => {
    const h = voiceHarness({
      rawText: '晚安。[[voice]]',
      userTexts: ['晚安'],
      directorScripts: ['{"text":"晚安，好梦。","speed":1}']
    });
    // Move the revision forward right after the audio media is saved — the
    // stale fence must destroy the orphan instead of publishing it.
    const originalSave = h.media.save.bind(h.media);
    h.media.save = async (request: Parameters<typeof originalSave>[0]) => {
      const record = await originalSave(request);
      h.batches.revision = 2;
      return record;
    };

    await h.run();

    expect(h.media.destroyed.length).toBe(1);
    expect(h.messages.appended.some((part) => part.type === 'audio')).toBe(false);
    expect(h.batches.superseded).toEqual(['1']);
    expect(h.batches.failed).toEqual([]);
    expect([...h.voices.rows.values()][0]!.status).toBe('superseded');
    expect(h.events.some((event) => event.type === 'voice.generation.superseded')).toBe(true);
  });
});
