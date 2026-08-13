import type { LocalDatabase } from '../platform/database.js';
import type { SecretsPlatform } from '../platform/secrets.js';
import type { MediaPlatform } from '../platform/media.js';
import { JobRepo, LifeRepo, LocationRepo, MediaRepo, MemoryRepo, MessageRepo, MetricsRepo, MomentRepo, ReplyBatchRepo, SettingsRepo, StickerRepo, ThoughtRepo, VoiceRepo, WeatherRepo } from '../db/index.js';
import type { LocalEvent, LocalEventListener, LocalCoreApi, BootstrapInfo, ChatMessage, LifeState, MessagePage, MediaRef, MessagePart, MessageContext, MessageSearchHit, Moment, StickerInfo, WorldPresence, UploadInputFile } from './types.js';

export interface LocalCoreOptions {
  db: LocalDatabase;
  secrets?: SecretsPlatform;
  mediaStore?: MediaPlatform;
  now?: () => Date;
}

/**
 * Minimal ordered process-local event emitter matching the server SSE event
 * shape (seq/type/data/createdAt) so the React event handling stays intact.
 */
class LocalEmitter {
  private readonly listeners = new Set<LocalEventListener>();
  private nextSeq = 1;
  private dispatching = false;
  private readonly queue: LocalEvent[] = [];
  private readonly now: () => Date;

  constructor(now: () => Date) {
    this.now = now;
  }

  get lastSequence(): number { return this.nextSeq - 1; }

  subscribe(listener: LocalEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit<T extends Record<string, unknown>>(type: string, data: T): LocalEvent<T> {
    const event: LocalEvent<T> = { seq: this.nextSeq++, type, data, createdAt: this.now().toISOString() };
    this.queue.push(event);
    this.drain();
    return event;
  }

  private drain(): void {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        for (const listener of [...this.listeners]) {
          try { listener(event); } catch { /* listener isolation */ }
        }
      }
    } finally {
      this.dispatching = false;
    }
  }
}

/**
 * Local SOOYA Core: the in-process, server-free implementation of the client
 * contract. Reads come straight from local repositories; writes persist to the
 * local database and fan out through the event bus. Model calls, tool runtime
 * and MCP wiring are layered on top in later milestones.
 */
export class LocalCore implements LocalCoreApi {
  readonly messagesRepo: MessageRepo;
  readonly momentsRepo: MomentRepo;
  readonly stickersRepo: StickerRepo;
  readonly lifeRepo: LifeRepo;
  readonly locationsRepo: LocationRepo;
  readonly weatherRepo: WeatherRepo;
  readonly batchesRepo: ReplyBatchRepo;
  readonly jobsRepo: JobRepo;
  readonly settingsRepo: SettingsRepo;
  readonly memoryRepo: MemoryRepo;
  readonly thoughtsRepo: ThoughtRepo;
  readonly voicesRepo: VoiceRepo;
  readonly metricsRepo: MetricsRepo;
  readonly mediaRepo: MediaRepo;
  readonly events: LocalEmitter;

  constructor(private readonly options: LocalCoreOptions) {
    const db = options.db;
    const now = options.now ?? (() => new Date());
    this.messagesRepo = new MessageRepo(db, now);
    this.momentsRepo = new MomentRepo(db, now);
    this.stickersRepo = new StickerRepo(db, now);
    this.lifeRepo = new LifeRepo(db, now);
    this.locationsRepo = new LocationRepo(db, now);
    this.weatherRepo = new WeatherRepo(db, now);
    this.batchesRepo = new ReplyBatchRepo(db, now);
    this.jobsRepo = new JobRepo(db, now);
    this.settingsRepo = new SettingsRepo(db, now);
    this.memoryRepo = new MemoryRepo(db, now);
    this.thoughtsRepo = new ThoughtRepo(db, now);
    this.voicesRepo = new VoiceRepo(db, now);
    this.metricsRepo = new MetricsRepo(db, now);
    this.mediaRepo = new MediaRepo(db, now);
    this.events = new LocalEmitter(now);
  }

  subscribe(listener: LocalEventListener): () => void {
    return this.events.subscribe(listener);
  }

  /** Foreground: recover interrupted jobs before the scheduler drains them. */
  async onAppActive(): Promise<void> {
    await this.jobsRepo.recoverStuck();
  }

  /** Background: persist WAL state so the database survives suspension. */
  async onAppInactive(): Promise<void> {
    try {
      await this.options.db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch { /* checkpoint is best-effort */ }
  }

  // ---- reads ---------------------------------------------------------------

  async bootstrap(): Promise<BootstrapInfo> {
    const [countRow, maxSeqRow, minSeqRow, page, stickers, life, presence] = await Promise.all([
      this.options.db.query<{ c: number }>("SELECT COUNT(*) c FROM messages WHERE conversation_id = 'main'"),
      this.options.db.query<{ m: number | null }>("SELECT MAX(seq) m FROM messages WHERE conversation_id = 'main'"),
      this.options.db.query<{ m: number | null }>("SELECT MIN(seq) m FROM messages WHERE conversation_id = 'main'"),
      this.messagesRepo.page(30),
      this.stickersRepo.list({ limit: 8 }),
      this.life(),
      this.presence()
    ]);
    const messageCount = countRow[0]?.c ?? 0;
    const lastSeq = maxSeqRow[0]?.m ?? 0;
    return {
      conversation: {
        conversationId: 'main',
        persona: { name: 'SOOYA', avatar: '', userAvatar: '', tagline: '' },
        messageCount,
        lastSeq,
        lastEventSeq: this.events.lastSequence
      },
      messages: { ...page, lastEventSeq: this.events.lastSequence, lastMessageSeq: lastSeq, oldestSeq: minSeqRow[0]?.m ?? null },
      stickers: stickers.map(toStickerInfo),
      life,
      presence
    };
  }

  async messages(options: { limit?: number; before?: number; since?: number } = {}): Promise<MessagePage> {
    const page = await this.messagesRepo.page(options.limit ?? 50, options.before ?? null);
    const lastMessageSeq = (await this.options.db.query<{ m: number | null }>("SELECT MAX(seq) m FROM messages WHERE conversation_id = 'main'"))[0]?.m ?? 0;
    const oldestSeq = (await this.options.db.query<{ m: number | null }>("SELECT MIN(seq) m FROM messages WHERE conversation_id = 'main'"))[0]?.m ?? null;
    return { ...page, lastEventSeq: this.events.lastSequence, lastMessageSeq, oldestSeq };
  }

  async messageSearch(query: string, options: { limit?: number; cursor?: string | null } = {}): Promise<{ hits: MessageSearchHit[]; nextCursor: string | null }> {
    return await this.messagesRepo.search(query, options.limit ?? 30, options.cursor ?? null);
  }

  async messagesByDate(date: string, timeZone: string, limit = 200): Promise<{ date: string; timeZone: string; messages: ChatMessage[]; hasMore: boolean }> {
    const start = zonedStartOfDayUtcMs(date, timeZone);
    const rows = await this.options.db.query<{ id: string }>(
      `SELECT id FROM messages WHERE conversation_id = 'main' AND created_at >= ? AND created_at < ? ORDER BY seq ASC LIMIT ?`,
      [new Date(start).toISOString(), new Date(start + 86_400_000).toISOString(), Math.max(1, Math.min(500, Math.trunc(limit)) + 1)]
    );
    const hasMore = rows.length > limit;
    const ids = rows.slice(0, limit).map((row) => row.id);
    const messages = (await Promise.all(ids.map((id) => this.messagesRepo.get(id)))).filter((m): m is ChatMessage => m !== undefined);
    return { date, timeZone, messages, hasMore };
  }

  async messageContext(id: string, options: { before?: number; after?: number } = {}): Promise<MessageContext> {
    const context = await this.messagesRepo.context(id, options.before ?? 20, options.after ?? 20);
    if (!context) throw new Error(`message ${id} not found`);
    return context;
  }

  // ---- writes --------------------------------------------------------------

  async send(payload: { clientMsgId: string; content: unknown[]; directives?: Record<string, boolean>; replyTo?: string }): Promise<{ message: ChatMessage; duplicate: boolean; replyPending: boolean }> {
    const existing = payload.clientMsgId ? await this.messagesRepo.getByClientId(payload.clientMsgId) : undefined;
    if (existing) return { message: existing, duplicate: true, replyPending: false };
    const parts = (payload.content as Array<Partial<MessagePart>>).map((part) => ({
      type: part.type ?? ('text' as const),
      text: part.text ?? null,
      mediaId: part.mediaId ?? null,
      status: part.status ?? ('sent' as const),
      error: part.error ?? null,
      duration: part.duration ?? null,
      transcript: part.transcript ?? null,
      meta: part.meta ?? {}
    }));
    const { message } = await this.messagesRepo.create({
      role: 'user',
      clientMsgId: payload.clientMsgId ?? null,
      replyTo: payload.replyTo ?? null,
      parts
    });
    const dueAt = new Date(this.options.now?.().getTime() ?? Date.now() + 2500).toISOString();
    const admission = await this.batchesRepo.appendOrCreateMessage(message.id, dueAt, dueAt);
    this.events.emit('message.received', { message });
    this.events.emit('reply.queued', { batchId: admission.batch.id, revision: admission.revision, status: admission.batch.status });
    return { message, duplicate: false, replyPending: true };
  }

  async withdraw(id: string): Promise<{ message: ChatMessage }> {
    const result = await this.messagesRepo.withdraw(id, Date.now(), 5 * 60_000);
    if (result.kind === 'not_found') throw new Error(`message ${id} not found`);
    if (result.kind !== 'withdrawn' && result.kind !== 'already_withdrawn') {
      throw new Error(`message ${id} is not withdrawable`);
    }
    this.events.emit('message.updated', { message: result.message });
    return { message: result.message };
  }

  async retryBatch(id: string): Promise<{ batchId: string; revision: number; status: string }> {
    const batch = await this.batchesRepo.get(id);
    if (!batch) throw new Error(`batch ${id} not found`);
    return { batchId: batch.id, revision: 0, status: batch.status };
  }

  async upload(files: UploadInputFile[], _options: { signal?: AbortSignal } = {}): Promise<{ media: MediaRef[]; failed: Array<{ filename: string; error: string; code?: string }> }> {
    if (!this.options.mediaStore) {
      return { media: [], failed: files.map((file) => ({ filename: file.name, error: 'media storage unavailable', code: 'no-media-store' })) };
    }
    const media: MediaRef[] = [];
    const failed: Array<{ filename: string; error: string; code?: string }> = [];
    for (const file of files) {
      try {
        const saved = await this.options.mediaStore.save({
          kind: file.field === 'image' ? 'image' : 'file',
          name: file.name,
          mime: file.mime,
          data: file.bytes
        });
        const row = await this.mediaRepo.create({
          kind: saved.kind,
          relPath: saved.id,
          mime: saved.mime,
          bytes: saved.bytes,
          sha256: await sha256Hex(file.bytes),
          origin: 'upload'
        });
        media.push(toMediaRef(row));
      } catch (error) {
        failed.push({ filename: file.name, error: error instanceof Error ? error.message : String(error), code: 'save-failed' });
      }
    }
    return { media, failed };
  }

  // ---- moments / stickers / life -------------------------------------------

  async moments(limit = 50): Promise<{ moments: Moment[]; hasMore: boolean }> {
    const rows = await this.momentsRepo.list(limit + 1);
    const hasMore = rows.length > limit;
    const moments = await Promise.all(rows.slice(0, limit).map((row) => this.toMoment(row)));
    return { moments, hasMore };
  }

  async likeMoment(id: string, liked: boolean): Promise<{ moment: Moment }> {
    const row = await this.momentsRepo.setLiked(id, liked);
    if (!row) throw new Error(`moment ${id} not found`);
    this.events.emit('moment.updated', { momentId: id, liked });
    return { moment: await this.toMoment(row) };
  }

  async stickerSearch(options: { scope?: 'recent' | 'favorite' | 'all'; q?: string; limit?: number; cursor?: string | null } = {}): Promise<{ stickers: StickerInfo[]; total: number; nextCursor: string | null }> {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const stickers = await this.stickersRepo.list({ scope: options.scope ?? 'all', q: options.q, limit, offset: 0 });
    const total = await this.stickersRepo.count(false);
    return { stickers: stickers.map(toStickerInfo), total, nextCursor: null };
  }

  async life(): Promise<LifeState> {
    const current = await this.lifeRepo.current();
    const recent = await this.lifeRepo.recent(8);
    return {
      activity: current?.activity ?? '未知',
      kind: current?.kind ?? '',
      mood: current?.mood ?? '',
      startedAt: current?.started_at ?? new Date().toISOString(),
      endsAt: current?.ends_at ?? new Date().toISOString(),
      recent: recent.map((row) => ({ activity: row.activity, startedAt: row.started_at, endedAt: row.ended_at }))
    };
  }

  async presence(): Promise<WorldPresence> {
    const [state, weather] = await Promise.all([
      this.locationsRepo.currentState(),
      this.weatherRepo.latest('active')
    ]);
    const location = state ? await this.locationsRepo.get(state.location_id) : undefined;
    return {
      city: null,
      location: location ? { id: location.id, name: location.name, kind: location.kind } : null,
      travel: null,
      weather: weather ? {
        condition: weather.condition,
        temperatureC: weather.temperature_c,
        feelsLikeC: weather.feels_like_c,
        observedAt: weather.observed_at,
        stale: Date.now() - Date.parse(weather.observed_at) > 3 * 3600_000,
        provider: weather.provider
      } : null,
      updatedAt: new Date().toISOString()
    };
  }

  async capabilities(): Promise<{ capabilities: Record<string, { configured: boolean; ok: boolean; detail?: string }>; stickers: { available: number; total: number } }> {
    const [total, available, secretCount] = await Promise.all([
      this.stickersRepo.count(false),
      this.stickersRepo.count(true),
      this.options.secrets ? countSecrets(this.options.secrets) : Promise.resolve(0)
    ]);
    const configured = secretCount > 0;
    return {
      capabilities: {
        chat: { configured, ok: configured, detail: configured ? undefined : '尚未配置任何模型密钥' }
      },
      stickers: { available, total }
    };
  }

  // ---- helpers --------------------------------------------------------------

  private async toMoment(row: MomentRowLike): Promise<Moment> {
    const image = row.image_media_id ? await this.mediaRepo.get(row.image_media_id) : undefined;
    return {
      id: row.id,
      text: row.text,
      activity: row.activity,
      image: image ? { id: image.id, url: `media://${image.id}`, kind: row.image_kind } : null,
      location: row.location_id || row.location_name
        ? { id: row.location_id, name: row.location_name, city: row.city }
        : null,
      weather: row.weather_condition ? { condition: row.weather_condition, temperatureC: row.temperature_c } : null,
      liked: row.liked === 1,
      createdAt: row.created_at
    };
  }
}

interface MomentRowLike {
  id: string;
  text: string;
  activity: string;
  image_media_id: string | null;
  image_kind: 'pov' | 'selfie' | null;
  location_id: string | null;
  location_name: string | null;
  city: string | null;
  weather_condition: string | null;
  temperature_c: number | null;
  liked: number;
  created_at: string;
}

function toStickerInfo(sticker: StickerLike): StickerInfo {
  return {
    id: sticker.id,
    name: sticker.name,
    emotion: sticker.emotion ?? '',
    tags: sticker.tags ?? [],
    url: `media://${sticker.mediaId}`,
    mediaId: sticker.mediaId,
    description: sticker.description ?? null,
    imageText: sticker.imageText ?? null,
    userMeaning: sticker.userMeaning ?? null,
    favorite: sticker.favorite ?? undefined,
    assistantUseCount: sticker.assistantUseCount,
    assistantLastUsedAt: sticker.assistantLastUsedAt ?? null,
    userUseCount: sticker.useCount,
    userLastUsedAt: sticker.lastUsedAt ?? null,
    analysisStatus: sticker.analysisStatus
  };
}

interface StickerLike {
  id: string;
  name: string;
  emotion: string;
  tags: string[];
  mediaId: string;
  description?: string | null;
  imageText?: string | null;
  userMeaning?: string | null;
  favorite?: boolean;
  useCount?: number;
  lastUsedAt?: string | null;
  assistantUseCount?: number;
  assistantLastUsedAt?: string | null;
  analysisStatus?: 'pending' | 'processing' | 'ready' | 'failed';
}

function toMediaRef(row: MediaRowLike): MediaRef {
  return {
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    duration: row.duration,
    url: `media://${row.id}`,
    name: null,
    transcript: row.transcript,
    animated: row.meta_json.includes('"animated":true')
  };
}

interface MediaRowLike {
  id: string;
  kind: 'image' | 'audio' | 'sticker' | 'file';
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  transcript: string | null;
  meta_json: string;
}

async function countSecrets(store: SecretsPlatform): Promise<number> {
  let count = 0;
  for (const ref of ['provider.chat.key', 'provider.vision.key', 'provider.image.key', 'provider.tts.key', 'websearch.tavily.key']) {
    if ((await store.get(ref)) !== null) count += 1;
  }
  return count;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Local midnight (start of day) for `YYYY-MM-DD` in `timeZone`, as UTC epoch ms. */
export function zonedStartOfDayUtcMs(date: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) throw new Error(`invalid date ${date}`);
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(probe);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offsetMs = wall - probe.getTime();
  return Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMs;
}
