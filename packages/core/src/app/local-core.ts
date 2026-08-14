import type { LocalDatabase } from '../platform/database.js';
import type { SecretsPlatform } from '../platform/secrets.js';
import type { MediaPlatform } from '../platform/media.js';
import type { HttpPlatform } from '../platform/http.js';
import { ConfigRepository, JobRepo, LifeCityRepo, LifeClockRepo, LifeRepo, LifeV2Repo, LocationRepo, MediaRepo, MemoryRepo, MessageRepo, MetricsRepo, MomentRepo, ReplyBatchRepo, SettingsRepo, StickerRepo, SummaryRepo, ThoughtRepo, VoiceRepo, WeatherRepo, type MediaRow, type ProviderConfig, type Sticker } from '../db/index.js';
import type { ChatProvider } from '../providers/types.js';
import type { ConfiguredProviders } from '../providers/builtin.js';
import { createWebSearch, DOUBAO_SEARCH_DEFAULT_URL, TAVILY_SEARCH_DEFAULT_URL } from '../providers/web-search.js';
import { OpenMeteoWeatherProvider, summarizeForecast, type WeatherForecastSummary } from '../providers/weather-provider.js';
import type { MemoryProvider } from '../memory/types.js';
import { LocalMemoryProvider } from '../memory/local-memory-provider.js';
import { SqliteLocalMemoryStore } from '../memory/local-store.js';
import { MemoryExtractor } from '../memory/extractor.js';
import { MemoryRouter } from '../memory/memory-router.js';
import { OmbreMcpMemoryProvider } from '../memory/ombre-mcp-memory-provider.js';
import { MemorySyncService } from '../memory/memory-sync-service.js';
import { MemorySyncRepository } from '../db/memory-sync.repo.js';
import type { McpPlatform } from '../platform/mcp.js';
import { McpRepository } from '../db/mcp.repo.js';
import { ToolRegistry, ToolPolicy } from '../tools/index.js';
import type { ToolExecutionContext } from '../tools/registry.js';
import type { ToolCallRuntime } from '../tools/tool-runtime.js';
import { ReplyCoordinator } from './reply-coordinator.js';
import { ContextBuilder } from './context-builder.js';
import { SummaryBuilder } from './summary-builder.js';
import { StickerAnalyzer } from './sticker-analyzer.js';
import { extractText } from '../util/text-extractor.js';
import { LocalLifeCatchUp } from '../life/catch-up-service.js';
import { MomentComposer } from '../moments/composer.js';
import { LATEST_SCHEMA_VERSION } from '../db/migrations.js';
import type { LocalEvent, LocalEventListener, LocalCoreApi, BootstrapInfo, ChatMessage, LifeState, MessagePage, MediaRef, MessagePart, MessageContext, MessageSearchHit, Moment, StickerInfo, WorldPresence, UploadInputFile, LocalAdminRequestOptions } from './types.js';

export interface LocalCoreOptions {
  db: LocalDatabase;
  secrets?: SecretsPlatform;
  mediaStore?: MediaPlatform;
  http?: HttpPlatform;
  chatProvider?: ChatProvider | null;
  chatProviderFactory?: () => Promise<ChatProvider | null>;
  mcp?: McpPlatform;
  toolRegistry?: ToolRegistry;
  toolPolicy?: ToolPolicy;
  toolRuntime?: ToolCallRuntime;
  memoryProvider?: MemoryProvider;
  replyDebounceMs?: number;
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
 * local database and fan out through the event bus. Provider streaming, tool runtime
 * and MCP wiring stay behind this local boundary.
 */
export class LocalCore implements LocalCoreApi {
  readonly database: LocalDatabase;
  readonly messagesRepo: MessageRepo;
  readonly momentsRepo: MomentRepo;
  readonly momentComposer: MomentComposer;
  readonly stickersRepo: StickerRepo;
  readonly lifeRepo: LifeRepo;
  readonly lifeClockRepo: LifeClockRepo;
  readonly lifeCatchUp: LocalLifeCatchUp;
  readonly lifeCitiesRepo: LifeCityRepo;
  readonly locationsRepo: LocationRepo;
  readonly weatherRepo: WeatherRepo;
  readonly batchesRepo: ReplyBatchRepo;
  readonly jobsRepo: JobRepo;
  readonly settingsRepo: SettingsRepo;
  readonly configRepo: ConfigRepository;
  readonly mcpRepo: McpRepository;
  readonly toolRegistry: ToolRegistry;
  readonly toolPolicy: ToolPolicy;
  readonly memoryRepo: MemoryRepo;
  readonly memoryProvider: MemoryProvider;
  readonly memorySync?: MemorySyncService;
  readonly summaryRepo: SummaryRepo;
  readonly thoughtsRepo: ThoughtRepo;
  readonly voicesRepo: VoiceRepo;
  readonly metricsRepo: MetricsRepo;
  readonly mediaRepo: MediaRepo;
  readonly events: LocalEmitter;
  readonly replies: ReplyCoordinator;
  readonly contextBuilder: ContextBuilder;
  readonly summaryBuilder: SummaryBuilder;
  /** Resolver for providers built from the persisted config (used when no
   * explicit chatProvider was injected, e.g. native boot). */
  private readonly configuredProviders?: () => Promise<ConfiguredProviders>;
  /** In-memory weather forecast cache (per city, 30 min TTL). */
  private readonly forecastCache = new Map<string, { summary: WeatherForecastSummary; fetchedAt: number }>();

  constructor(private readonly options: LocalCoreOptions) {
    const db = options.db;
    this.database = db;
    const now = options.now ?? (() => new Date());
    this.messagesRepo = new MessageRepo(db, now);
    this.momentsRepo = new MomentRepo(db, now);
    this.stickersRepo = new StickerRepo(db, now);
    this.lifeRepo = new LifeRepo(db, now);
    this.lifeClockRepo = new LifeClockRepo(db, now);
    this.lifeCatchUp = new LocalLifeCatchUp({ clock: this.lifeClockRepo, now, detailedWindowMs: 7 * 86_400_000, maxTransitions: 200 });
    this.lifeCitiesRepo = new LifeCityRepo(db, now);
    this.locationsRepo = new LocationRepo(db, now);
    this.weatherRepo = new WeatherRepo(db, now);
    this.batchesRepo = new ReplyBatchRepo(db, now);
    this.jobsRepo = new JobRepo(db, now);
    this.settingsRepo = new SettingsRepo(db, now);
    this.configRepo = new ConfigRepository(db, now);
    this.mcpRepo = new McpRepository(db, now);
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.toolPolicy = options.toolPolicy ?? new ToolPolicy(this.toolRegistry);
    this.memoryRepo = new MemoryRepo(db, now);
    this.summaryRepo = new SummaryRepo(db, now);
    this.thoughtsRepo = new ThoughtRepo(db, now);
    this.voicesRepo = new VoiceRepo(db, now);
    this.metricsRepo = new MetricsRepo(db, now);
    this.mediaRepo = new MediaRepo(db, now);
    this.configuredProviders = options.http
      ? async () => (await import('../providers/builtin.js')).createConfiguredProviders(options.http!, this.configRepo)
      : undefined;
    const localMemoryProvider = new LocalMemoryProvider({
      store: new SqliteLocalMemoryStore(this.memoryRepo),
      extract: async (input) => await new MemoryExtractor({
        provider: async () => options.chatProvider ?? await options.chatProviderFactory?.() ?? (await this.configuredProviders?.())?.chat ?? null
      }).extract(input),
      currentRevision: async (batchId) => await this.batchesRepo.currentRevision(batchId),
      embeddingProvider: async () => (await this.configuredProviders?.())?.embedding ?? null,
      rerankProvider: async () => (await this.configuredProviders?.())?.rerank ?? null
    });
    if (options.memoryProvider) {
      this.memoryProvider = options.memoryProvider;
    } else if (options.mcp) {
      const ombre = new OmbreMcpMemoryProvider({
        mcp: options.mcp,
        getConfig: async () => {
          const server = await this.mcpRepo.getServer('ombre');
          return server?.enabled && server.url ? server : undefined;
        }
      });
      this.memorySync = new MemorySyncService({ local: this.memoryRepo, sync: new MemorySyncRepository(db, now), remote: ombre, now });
      this.memoryProvider = new MemoryRouter({
        local: localMemoryProvider,
        mcp: ombre,
        mode: 'hybrid',
        mirrorWrites: false,
        sync: this.memorySync,
        remoteEnabled: async () => {
          const server = await this.mcpRepo.getServer('ombre');
          return Boolean(server?.enabled && server.url);
        }
      });
    } else {
      this.memoryProvider = localMemoryProvider;
    }
    this.momentComposer = new MomentComposer({
      life: new LifeV2Repo(db, now),
      moments: this.momentsRepo,
      provider: async () => options.chatProvider ?? await options.chatProviderFactory?.() ?? (await this.configuredProviders?.())?.chat ?? null,
      now
    });
    this.contextBuilder = new ContextBuilder({
      messages: this.messagesRepo,
      summaries: this.summaryRepo,
      memory: this.memoryProvider,
      settings: this.settingsRepo,
      life: this.lifeRepo,
      locations: this.locationsRepo,
      weather: this.weatherRepo,
      stickers: this.stickersRepo,
      now
    });
    this.summaryBuilder = new SummaryBuilder({
      messages: this.messagesRepo,
      summaries: this.summaryRepo,
      provider: async () => options.chatProvider ?? await options.chatProviderFactory?.() ?? (await this.configuredProviders?.())?.chat ?? null
    });
    this.events = new LocalEmitter(now);
    this.replies = new ReplyCoordinator({
      messages: this.messagesRepo,
      batches: this.batchesRepo,
      memory: this.memoryProvider,
      provider: options.chatProvider,
      providerFactory: options.chatProviderFactory ?? (options.http ? async () => (await import('../providers/builtin.js')).createConfiguredProviders(options.http!, this.configRepo).then((providers) => providers.chat) : undefined),
      webSearch: options.http ? () => createWebSearch(options.http!, this.configRepo) : null,
      toolRuntime: options.toolRuntime,
      contextBuilder: this.contextBuilder,
      now,
      debounceMs: options.replyDebounceMs,
      emit: (type, data) => this.events.emit(type, data)
    });
  }

  subscribe(listener: LocalEventListener): () => void {
    return this.events.subscribe(listener);
  }

  /** Foreground: recover interrupted jobs before the scheduler drains them. */
  async onAppActive(): Promise<void> {
    await this.jobsRepo.recoverStuck();
    await this.lifeCatchUp.catchUp().catch(() => undefined);
    await this.momentComposer.compose().catch(() => undefined);
    await this.replies.recover();
    void this.memorySync?.syncOnce().catch(() => undefined);
  }

  /** Background: persist WAL state so the database survives suspension. */
  async onAppInactive(): Promise<void> {
    this.replies.interruptAll('app_inactive');
    try {
      await this.options.db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch { /* checkpoint is best-effort */ }
  }

  // ---- reads ---------------------------------------------------------------

  async bootstrap(): Promise<BootstrapInfo> {
    await this.lifeCatchUp.catchUp().catch(() => undefined);
    const persona = await this.settingsRepo.get<Record<string, unknown>>('persona', { name: 'SOOYA', avatar: '', userAvatar: '', tagline: '' });
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
        persona: {
          name: typeof persona.name === 'string' ? persona.name : 'SOOYA',
          avatar: typeof persona.avatar === 'string' ? persona.avatar : '',
          userAvatar: typeof persona.userAvatar === 'string' ? persona.userAvatar : '',
          tagline: typeof persona.tagline === 'string' ? persona.tagline : ''
        },
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
    // Catch-up path: the web layer walks `since` + `nextSince` cursors to drain
    // a backlog page by page. Ignoring `since` here returns the newest page
    // repeatedly, which stalls the cursor and skips the backlogged messages.
    const limit = options.limit ?? 50;
    const page = options.since !== undefined && options.since > 0
      ? await this.messagesRepo.pageSince(options.since, limit)
      : { ...(await this.messagesRepo.page(limit, options.before ?? null)), nextSince: undefined };
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
    const dueAt = new Date((this.options.now?.() ?? new Date()).getTime() + 2500).toISOString();
    const admission = await this.batchesRepo.appendOrCreateMessage(message.id, dueAt, dueAt);
    this.events.emit('message.received', { message });
    this.events.emit('reply.queued', { batchId: admission.batch.id, revision: admission.revision, status: admission.batch.status });
    if (message.seq > 0 && message.seq % 20 === 0) void this.summaryBuilder.build().catch(() => undefined);
    if (this.options.chatProvider || this.options.chatProviderFactory || this.options.http) this.replies.schedule(admission.batch.id, admission.revision);
    return { message, duplicate: false, replyPending: true };
  }

  async withdraw(id: string): Promise<{ message: ChatMessage }> {
    const result = await this.messagesRepo.withdraw(id, (this.options.now?.() ?? new Date()).getTime(), 5 * 60_000);
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
    const retried = await this.batchesRepo.retry(batch.id);
    if (retried && (this.options.chatProvider || this.options.chatProviderFactory || this.options.http)) this.replies.schedule(retried.id, retried.revision);
    return { batchId: batch.id, revision: retried?.revision ?? batch.revision, status: retried?.status ?? batch.status };
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
        if (saved.kind === 'file') void this.extractMediaText(row.id).catch(() => undefined);
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
    const offset = Math.max(0, Number.parseInt(options.cursor ?? '0', 10) || 0);
    const all = await this.stickersRepo.list({ scope: options.scope ?? 'all', q: options.q });
    const stickers = all.slice(offset, offset + limit);
    const nextOffset = offset + stickers.length;
    return { stickers: stickers.map(toStickerInfo), total: all.length, nextCursor: nextOffset < all.length ? String(nextOffset) : null };
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
        stale: (this.options.now?.() ?? new Date()).getTime() - Date.parse(weather.observed_at) > 3 * 3600_000,
        provider: weather.provider
      } : null,
      updatedAt: new Date().toISOString()
    };
  }

  async capabilities(): Promise<{ capabilities: Record<string, { configured: boolean; ok: boolean; detail?: string }>; stickers: { available: number; total: number }; notifications: { localSupported: boolean; localEnabled: boolean; remoteSupported: boolean; remoteEnabled: boolean } }> {
    const [total, available, providers, notificationState] = await Promise.all([
      this.stickersRepo.count(false),
      this.stickersRepo.count(true),
      this.configRepo.listProviders(),
      this.configRepo.notificationCapabilities()
    ]);
    const providerStatus = Object.fromEntries(providers.map((provider) => [provider.capability, { configured: provider.enabled && Boolean(provider.secretRef), ok: provider.enabled && Boolean(provider.secretRef) }])) as Record<string, { configured: boolean; ok: boolean }>;
    const configured = providerStatus.chat?.configured ?? (this.options.secrets ? await countSecrets(this.options.secrets) > 0 : false);
    return {
      capabilities: {
        chat: { configured, ok: configured, detail: configured ? undefined : '尚未配置任何模型密钥' },
        ...providerStatus
      },
      stickers: { available, total },
      notifications: {
        localSupported: notificationState.localSupported,
        localEnabled: notificationState.localEnabled,
        remoteSupported: notificationState.remoteSupported,
        remoteEnabled: notificationState.remoteEnabled
      }
    };
  }

  /** Runs one sticker through the vision analyzer; failure stays recorded on the sticker. */
  private async analyzeSticker(stickerId: string): Promise<void> {
    if (!this.options.mediaStore) return;
    const analyzer = new StickerAnalyzer(this.stickersRepo, this.options.mediaStore, () => this.visionProvider());
    await analyzer.analyze(stickerId);
  }

  private async visionProvider(): Promise<ChatProvider | null> {
    return this.options.chatProvider ?? await this.options.chatProviderFactory?.() ?? (await this.configuredProviders?.())?.chat ?? null;
  }

  /** Fetches current weather for the active location through open-meteo and persists it. */
  private async refreshWeather(): Promise<{ ok: boolean; snapshot: Record<string, unknown> | null; error: string | null }> {
    if (!this.options.http) return { ok: false, snapshot: null, error: '本地 HTTP 传输不可用' };
    try {
      const locationState = await this.locationsRepo.currentState();
      const location = locationState ? await this.locationsRepo.get(locationState.location_id) : undefined;
      if (!location?.name) return { ok: false, snapshot: null, error: '没有可用的当前位置' };
      const provider = new OpenMeteoWeatherProvider(this.options.http);
      const snapshot = await provider.current({ city: location.name, country: '中国' });
      await this.weatherRepo.save({
        location_key: snapshot.locationKey,
        observed_at: snapshot.observedAt,
        condition: snapshot.condition,
        temperature_c: snapshot.temperatureC ?? null,
        feels_like_c: snapshot.feelsLikeC ?? null,
        humidity: snapshot.humidity ?? null,
        precipitation_mm: snapshot.precipitationMm ?? null,
        wind_kph: snapshot.windKph ?? null,
        visibility_km: snapshot.visibilityKm ?? null,
        pressure_hpa: snapshot.pressureHpa ?? null,
        provider: snapshot.provider
      });
      this.events.emit('weather.updated', { locationKey: snapshot.locationKey, observedAt: snapshot.observedAt });
      const latest = await this.weatherRepo.latest(snapshot.locationKey);
      return { ok: true, snapshot: latest ? toAdminWeather(latest) : null, error: null };
    } catch (error) {
      return { ok: false, snapshot: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Maps the web panel's WebSearchConfig-shaped payload (nested doubao/
   * tavily blocks, provider order) onto the local `webSearch` provider row.
   *
   * Secret references are keyed by PROVIDER IDENTITY, not by slot, so
   * reordering providers never swaps credentials: `provider.webSearch.doubao.key`
   * / `provider.webSearch.tavily.key`. A submitted apiKey overwrites its
   * identity ref; an explicitly empty apiKey ('' — the panel's "删除密钥")
   * removes the ref from Keychain; an absent apiKey preserves whatever the
   * identity currently holds. 'responses' stays in the mirrored settings for
   * UI order but has no on-device runtime, so it is never a provider. */
  private async saveWebSearchConfig(raw: Record<string, unknown>): Promise<void> {
    const enabled = raw.enabled === true;
    const providers = Array.isArray(raw.providers) ? raw.providers.filter((item): item is string => typeof item === 'string') : [];
    const doubao = isRecord(raw.doubao) ? raw.doubao : {};
    const tavily = isRecord(raw.tavily) ? raw.tavily : {};
    const localOrder = providers.filter((item) => item === 'doubao' || item === 'tavily');
    const primary = localOrder[0] === 'tavily' ? 'tavily' : 'doubao';
    const fallback = localOrder[1] === 'tavily' ? 'tavily' : localOrder[1] === 'doubao' ? 'doubao' : null;
    const primaryCfg = primary === 'tavily' ? tavily : doubao;
    const secondaryCfg = primary === 'tavily' ? doubao : tavily;
    const baseUrl = typeof primaryCfg.baseUrl === 'string' && primaryCfg.baseUrl.trim() ? primaryCfg.baseUrl.trim() : primary === 'tavily' ? TAVILY_SEARCH_DEFAULT_URL : DOUBAO_SEARCH_DEFAULT_URL;
    const secondaryBaseUrl = typeof secondaryCfg.baseUrl === 'string' && secondaryCfg.baseUrl.trim()
      ? secondaryCfg.baseUrl.trim()
      : fallback === 'tavily' ? TAVILY_SEARCH_DEFAULT_URL : fallback === 'doubao' ? DOUBAO_SEARCH_DEFAULT_URL : '';
    if (!enabled || !baseUrl) { await this.configRepo.removeProvider('webSearch'); return; }
    const existing = await this.configRepo.getProvider('webSearch');
    // Identity -> current ref map from the previous row (works across reorders).
    const identityRefs = new Map<string, string | null>();
    if (existing) {
      identityRefs.set(existing.provider === 'tavily' ? 'tavily' : 'doubao', existing.secretRef);
      const oldFallback = existing.options.fallback === 'tavily' ? 'tavily' : existing.options.fallback === 'doubao' ? 'doubao' : null;
      if (oldFallback) {
        identityRefs.set(oldFallback, typeof existing.options.secondarySecretRef === 'string' ? existing.options.secondarySecretRef : null);
      }
    }
    const resolveRef = async (identity: 'doubao' | 'tavily', cfg: Record<string, unknown>): Promise<string | null> => {
      const submitted = Object.prototype.hasOwnProperty.call(cfg, 'apiKey') && typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : undefined;
      const ref = `provider.webSearch.${identity}.key`;
      if (submitted !== undefined && submitted !== '') {
        if (this.options.secrets) await this.options.secrets.set(ref, submitted);
        return ref;
      }
      if (submitted === '') {
        // Explicit delete ("删除密钥"): drop the identity's ref from Keychain.
        const previous = identityRefs.get(identity) ?? null;
        if (this.options.secrets && previous && previous !== ref) await this.options.secrets.remove(previous);
        if (this.options.secrets) await this.options.secrets.remove(ref);
        return null;
      }
      // Not touched: keep whatever this identity currently holds.
      return identityRefs.get(identity) ?? null;
    };
    const secretRef = await resolveRef(primary, primaryCfg);
    const secondarySecretRef = fallback ? await resolveRef(fallback, secondaryCfg) : null;
    await this.configRepo.setProvider({
      capability: 'webSearch',
      provider: primary,
      model: '',
      baseUrl,
      secretRef,
      enabled,
      options: {
        fallback,
        maxResults: typeof raw.maxResults === 'number' && Number.isFinite(raw.maxResults) ? Math.max(1, Math.min(20, Math.trunc(raw.maxResults))) : 5,
        timeoutMs: typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) ? Math.max(1_000, Math.min(120_000, Math.trunc(raw.timeoutMs))) : 15_000,
        edition: typeof doubao.edition === 'string' ? doubao.edition : 'custom',
        ...(secondaryBaseUrl ? { secondaryBaseUrl } : {}),
        ...(secondarySecretRef ? { secondarySecretRef } : {})
      }
    });
  }

  /** Fetches (or returns the cached) weather forecast summary for the active
   * location through open-meteo; null when unavailable — never throws. */
  private async forecastSummary(force = false): Promise<WeatherForecastSummary | null> {
    if (!this.options.http) return null;
    try {
      const locationState = await this.locationsRepo.currentState();
      const location = locationState ? await this.locationsRepo.get(locationState.location_id) : undefined;
      if (!location?.name) return null;
      const now = this.options.now?.() ?? new Date();
      const cached = this.forecastCache.get(location.name);
      if (!force && cached && now.getTime() - cached.fetchedAt < 30 * 60_000) return cached.summary;
      const provider = new OpenMeteoWeatherProvider(this.options.http);
      const forecast = await provider.forecast({ city: location.name, country: '中国' });
      const summary = summarizeForecast(forecast.periods, forecast.generatedAt, forecast.provider, now);
      this.forecastCache.set(location.name, { summary, fetchedAt: now.getTime() });
      return summary;
    } catch {
      return null;
    }
  }

  /** Extracts text from an uploaded file and records it in media_text. */
  private async extractMediaText(mediaId: string): Promise<void> {
    if (!this.options.mediaStore) return;
    const row = await this.mediaRepo.get(mediaId);
    if (!row) return;
    const read = await this.options.mediaStore.read(mediaId).catch(() => null);
    if (!read) {
      await this.mediaRepo.setExtractedText(mediaId, { status: 'failed', error: 'media_unavailable' });
      return;
    }
    const name = (() => { try { const meta = JSON.parse(row.meta_json) as { name?: unknown }; return typeof meta.name === 'string' ? meta.name : undefined; } catch { return undefined; } })();
    const result = extractText(read.data, row.mime, name);
    if (result.status === 'ready') {
      await this.mediaRepo.setExtractedText(mediaId, { status: 'ready', text: result.text, metadata: result.metadata });
      this.events.emit('media.updated', { mediaId, textStatus: 'ready' });
    } else if (result.status === 'unsupported') {
      await this.mediaRepo.setExtractedText(mediaId, { status: 'unsupported', metadata: result.metadata });
    } else {
      await this.mediaRepo.setExtractedText(mediaId, { status: 'failed', error: result.error, metadata: result.metadata });
      this.events.emit('media.updated', { mediaId, textStatus: 'failed' });
    }
  }

  /** Admin UI bridge for native mode. It intentionally accepts route-shaped
   * paths so existing panels can be reused without a localhost server. */
  async adminRequest<T = unknown>(path: string, options: LocalAdminRequestOptions = {}): Promise<T> {
    const url = new URL(path, 'https://sooya.local');
    const route = url.pathname;
    const method = (options.method ?? 'GET').toUpperCase();
    const rawBody = options.body;
    const body = isRecord(options.body) ? options.body : {};
    if (route === '/api/admin/system') {
      return {
        version: 'local', startedAt: new Date(0).toISOString(), uptimeSec: 0, node: 'native', platform: 'iOS', memoryMb: 0, loadAvg: [],
        database: await this.options.db.integrityCheck(), storage: { mode: 'app-sandbox' }, stream: { mode: 'in-process', lastEventSeq: this.events.lastSequence }, agent: { mode: 'on-device' }
      } as T;
    }
    if (route === '/api/admin/capabilities') return { capabilities: (await this.capabilities()).capabilities, embeddingDimensions: null } as T;
    if (route === '/api/admin/persona') {
      const fallback = { id: 'local', name: 'SOOYA', avatar: '', userAvatar: '', tagline: '在的', systemPrompt: '', language: 'zh-CN', stickerPolicy: {}, voicePolicy: {}, imagePolicy: {} };
      if (method === 'PUT' || method === 'PATCH') await this.settingsRepo.set('persona', { ...fallback, ...(await this.settingsRepo.get('persona', {})), ...body });
      return { persona: await this.settingsRepo.get('persona', fallback) } as T;
    }
    if (route === '/api/admin/voice-behavior') {
      const fallback = { enabled: false, maxVoiceSeconds: 30 };
      if (method === 'PUT' || method === 'PATCH') await this.settingsRepo.set('voiceBehavior', body);
      return await this.settingsRepo.get('voiceBehavior', fallback) as T;
    }
    if (route === '/api/admin/models') {
      if (method === 'PUT' || method === 'PATCH') {
        const input = isRecord(body.models) ? body.models : body;
        for (const capability of ['chat', 'embedding', 'rerank', 'image', 'tts', 'webSearch'] as const) {
          const raw = input[capability];
          if (!isRecord(raw)) continue;
          if (capability === 'webSearch') { await this.saveWebSearchConfig(raw); continue; }
          const provider = typeof raw.provider === 'string' ? normalizeProvider(raw.provider) : '';
          const model = typeof raw.model === 'string' ? raw.model : '';
          const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : '';
          if (!provider || !baseUrl || !model) { if (provider === 'none') await this.configRepo.removeProvider(capability); continue; }
          const existing = await this.configRepo.getProvider(capability);
          const submittedKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
          const secretRef = typeof raw.secretRef === 'string' && raw.secretRef.trim() ? raw.secretRef.trim() : existing?.secretRef ?? (submittedKey ? `provider.${capability}.key` : null);
          if (this.options.secrets && secretRef && submittedKey) await this.options.secrets.set(secretRef, submittedKey);
          await this.configRepo.setProvider({ capability, provider, model, baseUrl, secretRef, options: isRecord(raw.options) ? raw.options : {} });
        }
        await this.settingsRepo.set('models', redactModelConfig(input));
      }
      const providers = await this.configRepo.listProviders();
      const models: Record<string, unknown> = {};
      for (const provider of providers) {
        if (provider.capability === 'webSearch') { models.webSearch = toAdminWebSearchConfig(provider); continue; }
        models[provider.capability] = { provider: provider.provider, model: provider.model, baseUrl: provider.baseUrl, secretRef: provider.secretRef, apiKeyConfigured: Boolean(provider.secretRef), apiKeyBound: true, options: provider.options };
      }
      // Fresh installs have no webSearch row yet; still return a usable empty
      // shape so the panel renders the form (and the first save creates it).
      if (!(models.webSearch && isRecord(models.webSearch))) models.webSearch = EMPTY_WEB_SEARCH_CONFIG;
      // Preserve panel-provided details the row does not track (e.g. a
      // 'responses' entry in the provider order) from the mirrored settings.
      const saved = await this.settingsRepo.get<Record<string, unknown>>('models', {});
      const savedWebSearch = isRecord(saved.webSearch) ? saved.webSearch : null;
      const mergedWebSearch = isRecord(models.webSearch) ? models.webSearch : null;
      if (savedWebSearch && mergedWebSearch) {
        if (Array.isArray(savedWebSearch.providers) && (savedWebSearch.providers as unknown[]).length > 0) mergedWebSearch.providers = savedWebSearch.providers;
        if (savedWebSearch.maxResults != null) mergedWebSearch.maxResults = savedWebSearch.maxResults;
        if (savedWebSearch.timeoutMs != null) mergedWebSearch.timeoutMs = savedWebSearch.timeoutMs;
      }
      return { models: { ...saved, ...models } } as T;
    }
    if (route === '/api/admin/model-presets') {
      if (method === 'PUT') await this.settingsRepo.set('modelPresets', body.presets ?? []);
      return { presets: await this.settingsRepo.get('modelPresets', []), slots: await this.settingsRepo.get('modelSlots', []) } as T;
    }
    if (route === '/api/admin/model-presets/from-current' && method === 'POST') {
      const preset = isRecord(body.preset) ? body.preset : {};
      const presets = await this.settingsRepo.get<Array<Record<string, unknown>>>('modelPresets', []);
      const saved = { ...preset, id: typeof preset.id === 'string' ? preset.id : `preset_${Date.now().toString(36)}` };
      await this.settingsRepo.set('modelPresets', [...presets.filter((item) => item.id !== saved.id), saved]);
      return { preset: saved } as T;
    }
    const modelAction = route.match(/^\/api\/admin\/models\/([^/]+)\/(discover|test)$/u);
    if (modelAction) {
      const capability = decodeURIComponent(modelAction[1]!);
      const configured = await this.configRepo.getProvider(capability as never);
      if (modelAction[2] === 'discover') return { models: configured?.model ? [configured.model] : [], source: 'local-config' } as T;
      return { ok: Boolean(configured?.enabled && configured.secretRef), provider: configured?.provider ?? 'none', model: configured?.model ?? '', detail: configured?.secretRef ? '已绑定本地密钥引用' : '尚未配置本地密钥引用', latencyMs: 0 } as T;
    }
    if (route === '/api/admin/models/web-search/test' && method === 'POST') {
      if (body.provider === 'responses') {
        return { ok: false, provider: 'responses', latencyMs: 0, resultCount: 0, detail: '设备端本地运行时不支持 Responses 原生搜索，请改用豆包或 Tavily' } as T;
      }
      const runtime = await createWebSearch(this.options.http!, this.configRepo);
      if (!runtime || runtime.providers.length === 0) return { ok: false, provider: body.provider ?? 'unknown', latencyMs: 0, resultCount: 0, detail: '未配置联网搜索（webSearch provider 未启用或无密钥引用）' } as T;
      const started = Date.now();
      try {
        const provider = runtime.providers.find((item) => item.name === body.provider) ?? runtime.providers[0]!;
        const query = typeof body.query === 'string' && body.query.trim() ? body.query.trim().slice(0, 200) : '今日新闻';
        const result = await provider.search({ query, maxResults: runtime.maxResults, signal: undefined });
        return { ok: true, provider: provider.name, latencyMs: Date.now() - started, resultCount: result.citations.length, citations: result.citations.slice(0, 5), detail: `${result.citations.length} 条结果` } as T;
      } catch (error) {
        return { ok: false, provider: body.provider ?? 'unknown', latencyMs: Date.now() - started, resultCount: 0, detail: error instanceof Error ? error.message : String(error) } as T;
      }
    }
    const applyPreset = route.match(/^\/api\/admin\/model-presets\/([^/]+)\/apply$/u)?.[1];
    if (applyPreset && method === 'POST') {
      const presets = await this.settingsRepo.get<Array<Record<string, unknown>>>('modelPresets', []);
      const preset = presets.find((item) => item.id === decodeURIComponent(applyPreset));
      if (!preset) throw new Error(`model preset ${applyPreset} not found`);
      const capability = typeof preset.slot === 'string' && ['chat', 'embedding', 'rerank', 'image', 'tts'].includes(preset.slot) ? preset.slot as 'chat' | 'embedding' | 'rerank' | 'image' | 'tts' : 'chat';
      const existing = await this.configRepo.getProvider(capability);
      await this.configRepo.setProvider({ capability, provider: normalizeProvider(String(preset.provider ?? '')), model: String(preset.model ?? ''), baseUrl: String(preset.baseUrl ?? ''), secretRef: existing?.secretRef ?? null });
      return { applied: decodeURIComponent(applyPreset), models: (await this.adminRequest<{ models: Record<string, unknown> }>('/api/admin/models')).models } as T;
    }
    if (route === '/api/admin/memories' || route === '/api/admin/memory/legacy') {
      const rows = await this.options.db.query<{ id: string; kind: string; content: string; importance: number; confidence: number; created_at: string; updated_at: string; hits: number; has_embedding: number }>('SELECT id,kind,content,importance,confidence,created_at,updated_at,hits,embedding IS NOT NULL AS has_embedding FROM memories WHERE active=1 ORDER BY updated_at DESC LIMIT ?', [route.endsWith('/legacy') ? 100 : 500]);
      const memories = rows.map((row) => ({ id: row.id, kind: row.kind, content: row.content, importance: row.importance, confidence: row.confidence, createdAt: row.created_at, updatedAt: row.updated_at, hits: row.hits, hasEmbedding: row.has_embedding === 1 }));
      return route.endsWith('/legacy') ? { memories, total: memories.length, readOnly: true } as T : { memories, stats: { total: memories.length } } as T;
    }
    if (route === '/api/admin/memories/clear' && method === 'POST') {
      if (this.memorySync) await this.memorySync.clearLocal();
      else await this.options.db.run("UPDATE memories SET active=0,updated_at=? WHERE active=1", [(this.options.now?.() ?? new Date()).toISOString()]);
      return { cleared: true } as T;
    }
    if (route === '/api/admin/memory/status') {
      const health = await this.memoryProvider.health();
      const sync = this.memorySync ? await this.memorySync.status() : { state: health.state, provider: 'local', pendingPush: 0, pendingPull: 0, conflicts: 0, lastSyncAt: null };
      return { backend: sync.provider, connection: health.state === 'unavailable' ? 'disconnected' : health.state === 'degraded' ? 'degraded' : 'connected', health, sync, lastCommit: null, pending: sync.pendingPush, uncertain: 0, lastDream: null, dashboardUrl: null } as T;
    }
    if (route === '/api/admin/memory/sync' && method === 'POST') {
      if (!this.memorySync) return { state: 'ready', pushed: 0, pulled: 0, conflicts: 0, pending: 0, detail: 'Ombre sync is not configured' } as T;
      return await this.memorySync.syncOnce() as T;
    }
    if (route.startsWith('/api/admin/memory/ombre/search')) {
      const query = url.searchParams.get('q') ?? '';
      const results = await this.memoryRepo.searchFts(query, Number(url.searchParams.get('limit') ?? 10));
      return { query, results: results.map((row) => ({ id: row.id, content: row.content })), raw: '', resultCount: results.length } as T;
    }
    if (route.startsWith('/api/admin/memory/ombre/catalog')) {
      const memories = await this.memoryRepo.list({ limit: Number(url.searchParams.get('limit') ?? 50) });
      return { backend: 'local', entries: memories.map((row) => ({ id: row.id, kind: row.kind, content: row.content, updatedAt: row.updated_at })), total: memories.length } as T;
    }
    if (route === '/api/admin/memory/activity') return { activity: [] } as T;
    const memoryId = route.match(/^\/api\/admin\/memories\/([^/]+)$/u)?.[1];
    if (memoryId && method === 'DELETE') {
      const id = decodeURIComponent(memoryId);
      const deleted = this.memorySync ? await this.memorySync.forgetLocal(id) : await this.memoryRepo.forget(id);
      return { deleted } as T;
    }
    if (route === '/api/admin/chat/history') {
      const page = await this.messagesRepo.page(Number(url.searchParams.get('limit') ?? 100));
      return { messages: page.messages, total: await this.messagesRepo.count(), limit: page.messages.length, offset: 0, hasMore: page.hasMore } as T;
    }
    const contextId = route.match(/^\/api\/admin\/chat\/history\/([^/]+)\/context$/u)?.[1];
    if (contextId) return await this.messageContext(decodeURIComponent(contextId), { before: Number(url.searchParams.get('before') ?? 10), after: Number(url.searchParams.get('after') ?? 10) }) as T;
    if (route === '/api/admin/chat/clear' && method === 'POST') { const count = await this.messagesRepo.count(); await this.messagesRepo.clearAll(); return { cleared: true, messages: count } as T; }
    if (route === '/api/admin/chat/summary/build' && method === 'POST') return await this.summaryBuilder.build() as T;
    if (route === '/api/admin/jobs') return { jobs: await this.jobsRepo.list(100) } as T;
    if (route === '/api/admin/errors' && method === 'DELETE') return { cleared: true } as T;
    if (route === '/api/admin/errors') return { errors: [] } as T;
    if (route === '/api/admin/backups' && method === 'GET') return { backups: await this.options.db.query('SELECT * FROM local_backup_metadata ORDER BY created_at DESC LIMIT 50') } as T;
    if (route === '/api/admin/backups' && method === 'POST') {
      const name = `sooya-${Date.now().toString(36)}.sqlite3`;
      const started = (this.options.now?.() ?? new Date()).toISOString();
      await this.options.db.run(`INSERT INTO local_backup_metadata(id,target,state,schema_version,created_at,detail_json) VALUES(?,?, 'creating', ?, ?, '{}')`, [name, name, LATEST_SCHEMA_VERSION, started]);
      try {
        const backup = await this.options.db.backup(name);
        const integrity = await this.options.db.integrityCheck();
        const finished = (this.options.now?.() ?? new Date()).toISOString();
        const detail = { ...integrity, native: backup ?? null };
        await this.options.db.run(`UPDATE local_backup_metadata SET state=?,bytes=?,sha256=?,verified_at=?,detail_json=? WHERE id=?`, [integrity.ok ? 'ready' : 'failed', backup && typeof backup === 'object' ? backup.sizeBytes ?? null : null, backup && typeof backup === 'object' ? backup.sha256 ?? null : null, finished, JSON.stringify(detail), name]);
        return { backup: { name, path: name, bytes: backup && typeof backup === 'object' ? backup.sizeBytes ?? 0 : 0, createdAt: started, sha256: backup && typeof backup === 'object' ? backup.sha256 ?? '' : '', verified: integrity.ok && (backup && typeof backup === 'object' ? backup.verified !== false : true), mediaArchived: false } } as T;
      } catch (error) {
        await this.options.db.run(`UPDATE local_backup_metadata SET state='failed',detail_json=? WHERE id=?`, [JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), name]);
        throw error;
      }
    }
    if (route.match(/^\/api\/admin\/backups\/[^/]+$/u) && method === 'DELETE') return { deleted: false } as T;
    const backupName = route.match(/^\/api\/admin\/backups\/([^/]+)\/(verify|restore)$/u);
    if (backupName && method === 'POST') {
      const name = decodeURIComponent(backupName[1]!);
      if (backupName[2] === 'restore') {
        if (!this.options.db.restore) throw new Error('database restore is unavailable on this platform');
        await this.options.db.restore(name);
        await this.options.db.run(`UPDATE local_backup_metadata SET state='restored',restored_at=? WHERE id=?`, [(this.options.now?.() ?? new Date()).toISOString(), name]);
      }
      const integrity = await this.options.db.integrityCheck();
      return { name, verified: integrity.ok, integrity } as T;
    }
    if (route === '/api/admin/notifications') return { notifications: await this.configRepo.notificationCapabilities() } as T;
    if (route === '/api/admin/life/catch-up' && method === 'POST') return await this.lifeCatchUp.catchUp() as T;
    if (route === '/api/admin/moments/compose' && method === 'POST') return await this.momentComposer.compose() as T;
    if (route === '/api/admin/ota' && method === 'GET') return { manifestUrl: await this.configRepo.getPreference('ota.manifestUrl', ''), state: (await this.options.db.query('SELECT * FROM local_update_state WHERE id=1'))[0] ?? null } as T;
    if (route === '/api/admin/ota' && (method === 'PUT' || method === 'PATCH')) {
      const manifestUrl = typeof body.manifestUrl === 'string' ? body.manifestUrl.trim() : '';
      if (manifestUrl && !/^https:\/\//iu.test(manifestUrl)) throw new Error('OTA manifest URL must use HTTPS');
      await this.configRepo.setPreference('ota.manifestUrl', manifestUrl);
      return { manifestUrl, state: (await this.options.db.query('SELECT * FROM local_update_state WHERE id=1'))[0] ?? null } as T;
    }
    if (route === '/api/admin/mcp/servers' && method === 'GET') {
      const servers = await this.mcpRepo.listServers();
      const policies = await this.mcpRepo.listPolicies();
      const tools = this.toolRegistry.listForAdmin().map((tool) => ({ ...tool, serverId: tool.serverId ?? null }));
      return { configSource: 'local-sqlite', globalPolicy: {}, servers: servers.map((server) => ({ ...server, authConfigured: Boolean(server.secretKey), toolCount: policies.filter((policy) => policy.serverId === server.id).length })), tools, memory: { state: 'ready', provider: 'local' }, dashboardUrl: null } as T;
    }
    const mcpTest = route.match(/^\/api\/admin\/mcp\/([^/]+)\/(test|refresh-tools)$/u);
    if (mcpTest && method === 'POST') {
      const server = await this.refreshMcpServer(decodeURIComponent(mcpTest[1]!));
      return { ok: true, server: { ...server, authConfigured: Boolean(server?.secretKey) } } as T;
    }
    const mcpTool = route.match(/^\/api\/admin\/mcp\/tools\/([^/]+)$/u)?.[1];
    if (mcpTool) {
      const found = this.toolRegistry.listForAdmin().find((tool) => tool.name === decodeURIComponent(mcpTool) || tool.modelName === decodeURIComponent(mcpTool));
      return { tool: found ?? { name: decodeURIComponent(mcpTool), description: '', inputSchema: { type: 'object' } } } as T;
    }
    const mcpServerId = route.match(/^\/api\/admin\/mcp\/servers\/([^/]+)$/u)?.[1];
    if (mcpServerId && method === 'DELETE') { await this.options.mcp?.disconnect(decodeURIComponent(mcpServerId)); await this.mcpRepo.removeServer(decodeURIComponent(mcpServerId)); return { deleted: true } as T; }
    if (route === '/api/admin/mcp/servers' && (method === 'POST' || method === 'PUT')) {
      const id = typeof body.id === 'string' && body.id ? body.id : `mcp_${Date.now().toString(36)}`;
      const server = await this.mcpRepo.upsertServer({ id, name: typeof body.name === 'string' ? body.name : id, url: typeof body.url === 'string' ? body.url : '', transport: body.transport === 'sse' ? 'sse' : 'streamable-http', enabled: body.enabled !== false, required: body.required === true, secretKey: typeof body.secretKey === 'string' ? body.secretKey : undefined });
      return { server: { ...server, authConfigured: Boolean(server.secretKey) } } as T;
    }
    if (route === '/api/admin/stickers' && method === 'POST') {
      const form = rawBody as { get?: (name: string) => unknown };
      const file = typeof form?.get === 'function' ? form.get('file') : null;
      if (!file || typeof (file as { arrayBuffer?: unknown }).arrayBuffer !== 'function') throw new Error('sticker file is required');
      const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
      const uploaded = await this.upload([{ name: stringValue(typeof form.get === 'function' ? form.get('name') : null, 'sticker'), mime: typeof (file as File).type === 'string' ? (file as File).type : 'image/png', bytes, field: 'image' }]);
      const media = uploaded.media[0];
      if (!media) throw new Error('sticker media could not be stored');
      const sticker = await this.stickersRepo.create({ mediaId: media.id, name: stringValue(typeof form.get === 'function' ? form.get('name') : null, 'sticker'), emotion: stringValue(typeof form.get === 'function' ? form.get('emotion') : null, 'neutral'), tags: [typeof form.get === 'function' ? stringValue(form.get('tags'), 'neutral') : 'neutral'], nameSource: 'manual', analysisSource: 'manual' });
      return { created: [toAdminSticker(sticker)], failed: [] } as T;
    }
    if (route === '/api/admin/stickers' && method === 'GET') {
      const stickers = await this.stickersRepo.list({ q: url.searchParams.get('q') ?? undefined, status: (url.searchParams.get('status') as never) || undefined, source: (url.searchParams.get('source') as never) || undefined, emotion: url.searchParams.get('emotion') ?? undefined, enabled: url.searchParams.has('enabled') ? url.searchParams.get('enabled') === 'true' : undefined, sort: (url.searchParams.get('sort') as never) || 'created', limit: Number(url.searchParams.get('limit') ?? 100), offset: Number(url.searchParams.get('offset') ?? 0) });
      const total = await this.stickersRepo.count(false);
      const rows = stickers.map(toAdminSticker);
      return { stickers: rows, total, offset: Number(url.searchParams.get('offset') ?? 0), facets: { status: {}, source: {}, emotion: {} }, analysisVersion: 0 } as T;
    }
    const stickerId = route.match(/^\/api\/admin\/stickers\/([^/]+)$/u)?.[1];
    if (stickerId && method === 'PATCH') {
      const sticker = await this.stickersRepo.update(decodeURIComponent(stickerId), { name: typeof body.name === 'string' ? body.name : undefined, tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : undefined, emotion: typeof body.emotion === 'string' ? body.emotion : undefined, enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined, description: typeof body.description === 'string' ? body.description : undefined, imageText: typeof body.imageText === 'string' ? body.imageText : undefined, userMeaning: typeof body.userMeaning === 'string' ? body.userMeaning : undefined, favorite: typeof body.favorite === 'boolean' ? body.favorite : undefined });
      if (!sticker) throw new Error('sticker not found');
      return { sticker: toAdminSticker(sticker) } as T;
    }
    if (stickerId && method === 'DELETE') return { deleted: await this.stickersRepo.delete(decodeURIComponent(stickerId)) } as T;
    const stickerAction = route.match(/^\/api\/admin\/stickers\/([^/]+)\/analyze$/u)?.[1];
    if (stickerAction && method === 'POST') {
      const stickerId = decodeURIComponent(stickerAction);
      void this.analyzeSticker(stickerId).catch(() => undefined);
      return { queued: true, jobId: '', stickerId } as T;
    }
    if (route === '/api/admin/stickers/analyze-batch' && method === 'POST') {
      const pending = await this.stickersRepo.list({ status: 'pending', limit: 500 });
      const queued = pending.length;
      for (const sticker of pending) void this.analyzeSticker(sticker.id).catch(() => undefined);
      return { queued, skipped: 0 } as T;
    }
    const localMediaData = route.match(/^\/api\/admin\/media\/([^/]+)\/data$/u)?.[1];
    if (localMediaData && method === 'GET') {
      if (!this.options.mediaStore) throw new Error('native media storage is unavailable');
      const value = await this.options.mediaStore.read(decodeURIComponent(localMediaData));
      if (!value) throw new Error('media not found');
      return { id: value.record.id, mime: value.record.mime, bytes: value.record.bytes, dataBase64: bytesToBase64(value.data) } as T;
    }
    if (route === '/api/admin/gallery' && method === 'GET') {
      const query = Object.fromEntries(url.searchParams.entries());
      const rows = await this.mediaRepo.listGallery({
        deleted: query.trash === 'true', origin: mediaOrigin(query.origin), favorite: query.favorite === 'true', search: query.search,
        from: query.from, to: query.to, limit: Number(query.limit ?? 60), offset: Number(query.offset ?? 0)
      });
      const stats = await this.mediaRepo.galleryStats({ deleted: query.trash === 'true', origin: mediaOrigin(query.origin), favorite: query.favorite === 'true', search: query.search, from: query.from, to: query.to });
      return { media: await Promise.all(rows.map((row) => this.toAdminMedia(row))), stats, total: stats.count } as T;
    }
    const mediaId = route.match(/^\/api\/admin\/media\/([^/]+)$/u)?.[1];
    if (mediaId) {
      const id = decodeURIComponent(mediaId);
      if (method === 'GET') {
        const row = await this.mediaRepo.get(id);
        if (!row) throw new Error('media not found');
        return { media: await this.toAdminMedia(row) } as T;
      }
      if (method === 'PATCH') {
        if (typeof body.favorite === 'boolean') await this.mediaRepo.setFavorite(id, body.favorite);
        if (Array.isArray(body.tags)) await this.mediaRepo.setTags(id, body.tags.filter((tag): tag is string => typeof tag === 'string'));
        const row = await this.mediaRepo.get(id);
        if (!row) throw new Error('media not found');
        return { media: await this.toAdminMedia(row) } as T;
      }
      if (method === 'DELETE') return { deleted: await this.mediaRepo.delete(id) } as T;
    }
    const mediaAction = route.match(/^\/api\/admin\/media\/([^/]+)\/(trash|restore|permanent|usage)$/u);
    if (mediaAction) {
      const id = decodeURIComponent(mediaAction[1]!);
      if (mediaAction[2] === 'trash' && method === 'POST') return { trashed: await this.mediaRepo.trash(id) } as T;
      if (mediaAction[2] === 'restore' && method === 'POST') return { restored: await this.mediaRepo.restore(id) } as T;
      if (mediaAction[2] === 'permanent' && method === 'DELETE') return { deleted: await this.mediaRepo.delete(id) } as T;
      if (mediaAction[2] === 'usage' && method === 'GET') { const references = await this.mediaRepo.references(id); return { mediaId: id, usageCount: references.total, references, avatar: false } as T; }
    }
    if (route === '/api/admin/media' && method === 'GET') {
      const state = url.searchParams.get('state');
      const rows = await this.mediaRepo.listGallery({ deleted: state === 'trashed', kind: (url.searchParams.get('kind') as 'image' | 'audio' | 'sticker' | 'file' | null) ?? undefined, origin: (url.searchParams.get('origin') as 'upload' | 'generated' | 'builtin' | 'remote' | null) ?? undefined, search: url.searchParams.get('q') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 200), offset: Number(url.searchParams.get('offset') ?? 0) });
      return { media: await Promise.all(rows.map((row) => this.toAdminMedia(row))), total: (await this.mediaRepo.galleryStats({ deleted: state === 'trashed' })).count, offset: Number(url.searchParams.get('offset') ?? 0) } as T;
    }
    if (route === '/api/admin/media/batch' && method === 'POST') {
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
      const action = body.action;
      let changed = 0;
      for (const id of ids) {
        if (action === 'trash') changed += Number(await this.mediaRepo.trash(id));
        else if (action === 'restore') changed += Number(await this.mediaRepo.restore(id));
        else if (action === 'favorite') changed += Number(await this.mediaRepo.setFavorite(id, true));
        else if (action === 'unfavorite') changed += Number(await this.mediaRepo.setFavorite(id, false));
        else if (action === 'permanent') changed += Number(await this.mediaRepo.delete(id));
      }
      return { changed, blocked: [], missing: [] } as T;
    }
    if (route === '/api/admin/life' && method === 'GET') {
      const snapshot = await this.life();
      const settings = await this.settingsRepo.get('lifeSettings', defaultLifeSettings());
      return { snapshot, log: await this.lifeRepo.recent(100), plans: await this.lifeRepo.listPlans(), events: await this.lifeRepo.events(100), proactive: [], reachOut: { reach: false, reason: 'local proactive messaging is disabled', candidate: null, sharedLastDay: 0, lastUserAt: null, lastAssistantAt: null, enabledByDeployment: false }, settings } as T;
    }
    if (route === '/api/admin/life/plans' && method === 'GET') return { plans: await this.lifeRepo.listPlans() } as T;
    if (route === '/api/admin/life/plans' && method === 'POST') {
      const plan = await this.lifeRepo.createPlan({ title: stringValue(body.title, '未命名计划'), kind: stringValue(body.kind, 'other'), plannedStart: nullableString(body.plannedStart), plannedEnd: nullableString(body.plannedEnd), priority: numberValue(body.priority, 0) });
      return { plan } as T;
    }
    const lifePlanId = route.match(/^\/api\/admin\/life\/plans\/([^/]+)$/u)?.[1];
    if (lifePlanId && method === 'PATCH') {
      const plan = await this.lifeRepo.updatePlan(decodeURIComponent(lifePlanId), { title: typeof body.title === 'string' ? body.title : undefined, kind: typeof body.kind === 'string' ? body.kind : undefined, status: typeof body.status === 'string' ? body.status as never : undefined, planned_start: body.plannedStart === null || typeof body.plannedStart === 'string' ? body.plannedStart : undefined, planned_end: body.plannedEnd === null || typeof body.plannedEnd === 'string' ? body.plannedEnd : undefined, priority: typeof body.priority === 'number' ? body.priority : undefined });
      if (!plan) throw new Error('life plan not found');
      return { plan } as T;
    }
    if (route === '/api/admin/life/settings' && (method === 'PUT' || method === 'PATCH')) {
      const settings = { ...defaultLifeSettings(), ...(await this.settingsRepo.get('lifeSettings', defaultLifeSettings())), ...body, reachOut: false, proactiveMode: 'disabled' };
      await this.settingsRepo.set('lifeSettings', settings);
      return { settings } as T;
    }
    if (route === '/api/admin/life/tick' && method === 'POST') {
      if (typeof body.activity === 'string' && body.activity.trim()) {
        const startedAt = new Date().toISOString();
        await this.lifeRepo.advance({ activity: body.activity.trim(), kind: stringValue(body.kind, 'other'), mood: stringValue(body.mood, '平静'), startedAt, endsAt: typeof body.endsAt === 'string' ? body.endsAt : new Date(Date.now() + 3_600_000).toISOString() });
        return { changed: true, activity: body.activity.trim(), snapshot: await this.life() } as T;
      }
      const snapshot = await this.life();
      return { changed: false, activity: snapshot.activity, snapshot } as T;
    }
    if (route === '/api/admin/life/overview' && method === 'GET') {
      const current = await this.life();
      const locationState = await this.locationsRepo.currentState();
      const location = locationState ? await this.locationsRepo.get(locationState.location_id) : undefined;
      const weather = await this.weatherRepo.latest('active');
      const activePlan = (await this.lifeRepo.listPlans('active'))[0] ?? null;
      const events = await this.lifeRepo.events(10);
      return { snapshot: current, location: location ? { id: location.id, name: location.name, kind: location.kind } : null, weather: weather ? `${weather.condition}${weather.temperature_c == null ? '' : ` · ${weather.temperature_c}°C`}` : null, vitals: (await this.options.db.query('SELECT * FROM life_vitals WHERE id=1'))[0] ?? null, activePlan: activePlan ? { id: activePlan.id, title: activePlan.title, kind: activePlan.kind, status: activePlan.status } : null, openThreads: [], recentEvents: events.map((event) => ({ id: event.id, eventType: event.event_type, description: event.description, happenedAt: event.happened_at })) } as T;
    }
    if (route === '/api/admin/life/vitals') return { vitals: (await this.options.db.query('SELECT * FROM life_vitals WHERE id=1'))[0] ?? null } as T;
    if (route === '/api/admin/life/threads') return { threads: [] } as T;
    if (route === '/api/admin/life/events') return { events: await this.lifeRepo.events(Number(url.searchParams.get('limit') ?? 50)) } as T;
    if (route === '/api/admin/life/proactive') return { attempts: [] } as T;
    if (route === '/api/admin/life/locations' && method === 'GET') {
      const rows = await this.locationsRepo.list(false);
      const state = await this.locationsRepo.currentState();
      return { locations: rows.map(toAdminLocation), current: state ? toAdminLocation(rows.find((row) => row.id === state.location_id)) : null } as T;
    }
    if (route === '/api/admin/life/locations' && method === 'POST') {
      const location = await this.locationsRepo.create({ name: stringValue(body.name, '未命名地点'), kind: stringValue(body.kind, 'other') as never, city: nullableString(body.city), region: nullableString(body.region), country: nullableString(body.country), timeZone: nullableString(body.timeZone), lat: numberOrNull(body.lat), lng: numberOrNull(body.lng) });
      return { location: toAdminLocation(location) } as T;
    }
    const locationId = route.match(/^\/api\/admin\/life\/locations\/([^/]+)$/u)?.[1];
    if (locationId && method === 'DELETE') return { ok: await this.locationsRepo.deactivate(decodeURIComponent(locationId)) } as T;
    if (route === '/api/admin/life/travel' && method === 'GET') {
      const travel = await this.locationsRepo.currentTravel();
      return { travel: travel ? { fromLocationId: travel.from_location_id, toLocationId: travel.to_location_id, mode: travel.mode, startedAt: travel.started_at, expectedArriveAt: travel.expected_arrive_at } : null } as T;
    }
    if (route === '/api/admin/life/cities' && method === 'GET') return { cities: await this.lifeCitiesRepo.list() } as T;
    if (route === '/api/admin/weather/status' && method === 'GET') {
      const snapshot = await this.weatherRepo.latest('active');
      return { enabled: Boolean(snapshot), provider: { name: snapshot?.provider ?? null, configured: Boolean(snapshot), active: Boolean(snapshot) }, currentSource: snapshot?.provider ?? null, lastSnapshot: snapshot ? toAdminWeather(snapshot) : null, cacheAgeSec: snapshot ? Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.observed_at)) / 1000)) : null, daylight: null, forecast: await this.forecastSummary() } as T;
    }
    if (route === '/api/admin/weather/forecast' && method === 'GET') {
      return { forecast: await this.forecastSummary(), daylight: null } as T;
    }
    if (route === '/api/admin/weather/refresh' && method === 'POST') {
      const result = await this.refreshWeather();
      const forecast = await this.forecastSummary(true);
      return { ok: result.ok, snapshot: result.snapshot, forecast, error: result.error, presence: await this.presence() } as T;
    }
    if (route.startsWith('/api/admin/metrics')) return { aggregates: [], distributions: [] } as T;
    return {} as T;
  }

  private async refreshMcpServer(id: string): Promise<Awaited<ReturnType<McpRepository['getServer']>>> {
    const server = await this.mcpRepo.getServer(id);
    if (!server) throw new Error(`MCP server ${id} not found`);
    if (!this.options.mcp) throw new Error('native MCP transport is unavailable');
    try {
      await this.mcpRepo.setState(id, 'connecting', null);
      await this.options.mcp.connect(server);
      const tools = await this.options.mcp.listTools(id);
      const policies = new Map((await this.mcpRepo.listPolicies(id)).map((policy) => [policy.remoteName, policy]));
      this.toolRegistry.replaceSource(id, tools.map((tool) => {
        const policy = policies.get(tool.name);
        const canonicalName = policy?.canonicalName ?? canonicalMcpName(id, tool.name);
        void this.mcpRepo.upsertPolicy({ serverId: id, remoteName: tool.name, canonicalName, risk: policy?.risk ?? 'read', phases: policy?.phases ?? ['reply', 'admin'], authorized: policy?.authorized ?? false, schemaHash: null });
        return {
          name: canonicalName,
          modelName: modelMcpName(id, tool.name),
          remoteName: tool.name,
          serverId: id,
          description: tool.description ?? `MCP tool ${tool.name}`,
          inputSchema: tool.inputSchema,
          source: 'mcp' as const,
          risk: (policy?.risk ?? 'read') as 'read',
          phases: (policy?.phases ?? ['reply', 'admin']) as Array<'reply' | 'admin'>,
          authorized: policy?.authorized ?? false,
          handler: async (rawInput: unknown, context?: ToolExecutionContext) => await this.options.mcp!.callTool(id, tool.name, isRecord(rawInput) ? rawInput : {}, context?.signal)
        };
      }));
      await this.mcpRepo.setRefreshed(id);
      await this.mcpRepo.setState(id, 'ready', null);
    } catch (error) {
      await this.mcpRepo.setState(id, 'degraded', error instanceof Error ? error.message : String(error));
      throw error;
    }
    return await this.mcpRepo.getServer(id);
  }

  private async toAdminMedia(row: MediaRow): Promise<Record<string, unknown>> {
    const references = await this.mediaRepo.references(row.id);
    const meta = parseJsonRecord(row.meta_json);
    return {
      id: row.id, kind: row.kind, mime: row.mime, bytes: row.bytes, url: `local-media://${row.id}`, origin: row.origin,
      exists: Boolean(this.options.mediaStore), createdAt: row.created_at, name: typeof meta.name === 'string' ? meta.name : null,
      deletedAt: row.deleted_at, favorite: row.favorite === 1, tags: parseJsonArray(row.tags_json), animated: row.animated === 1,
      usageCount: references.total, references, avatar: meta.avatar === true
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

function parseJsonRecord(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value) as unknown; return isRecord(parsed) ? parsed : {}; } catch { return {}; }
}

function parseJsonArray(value: string): string[] {
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []; } catch { return []; }
}

function defaultLifeSettings(): Record<string, unknown> {
  return { reachOut: false, quietGapMinutes: 240, maxReachOutsPerDay: 0, silentFrom: 23, silentTo: 8, tzOffsetMinutes: 480, proactiveMode: 'disabled' };
}

function stringValue(value: unknown, fallback: string): string { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function nullableString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function numberValue(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function mediaOrigin(value: string | undefined): 'upload' | 'generated' | 'builtin' | 'remote' | undefined {
  return value === 'upload' || value === 'generated' || value === 'builtin' || value === 'remote' ? value : undefined;
}

function toAdminLocation(row: { id: string; name: string; kind: string; city_id?: string | null; city?: string | null; region?: string | null; country?: string | null; time_zone?: string | null; lat?: number | null; lng?: number | null; tags_json?: string; indoor?: number; visit_weight?: number; source?: string; active?: number } | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return { id: row.id, name: row.name, kind: row.kind, cityId: row.city_id ?? null, city: row.city ?? null, region: row.region ?? null, country: row.country ?? null, timeZone: row.time_zone ?? null, lat: row.lat ?? null, lng: row.lng ?? null, tags: parseJsonArray(row.tags_json ?? '[]'), indoor: row.indoor === 1, visitWeight: row.visit_weight ?? 1, source: row.source ?? 'local', active: row.active !== 0 };
}

function toAdminWeather(row: { observed_at: string; condition: string; temperature_c: number | null; feels_like_c: number | null; humidity: number | null; precipitation_mm: number | null; wind_kph: number | null; provider: string; location_key: string }): Record<string, unknown> {
  return { observedAt: row.observed_at, condition: row.condition, temperatureC: row.temperature_c ?? undefined, feelsLikeC: row.feels_like_c ?? undefined, humidity: row.humidity ?? undefined, precipitationMm: row.precipitation_mm ?? undefined, windKph: row.wind_kph ?? undefined, provider: row.provider, locationKey: row.location_key, stale: Date.now() - Date.parse(row.observed_at) > 3_600_000 };
}

function toAdminSticker(row: Sticker): Record<string, unknown> {
  return { id: row.id, name: row.name, tags: row.tags, emotion: row.emotion, enabled: row.enabled, useCount: row.useCount, assistantUseCount: row.assistantUseCount, assistantLastUsedAt: row.assistantLastUsedAt, userUseCount: row.userUseCount, userLastUsedAt: row.userLastUsedAt, description: row.description, imageText: row.imageText, userMeaning: row.userMeaning, analysisStatus: row.analysisStatus, analysisSource: row.analysisSource, analysisVersion: row.analysisVersion, analysisError: row.analysisError, favorite: row.favorite, url: row.url, mime: 'image/*', createdAt: row.createdAt, updatedAt: row.updatedAt, available: row.enabled };
}

function bytesToBase64(value: Uint8Array): string {
  let output = '';
  for (let index = 0; index < value.length; index += 0x8000) output += String.fromCharCode(...value.subarray(index, index + 0x8000));
  return btoa(output);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeMcpSegment(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9_-]+/gu, '_').replace(/^_+/u, '').slice(0, 48) || 'server';
}

function canonicalMcpName(serverId: string, remoteName: string): string {
  return `mcp.${safeMcpSegment(serverId)}.${safeMcpSegment(remoteName)}`;
}

function modelMcpName(serverId: string, remoteName: string): string {
  return `mcp_${safeMcpSegment(serverId)}_${safeMcpSegment(remoteName)}`;
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized || normalized === 'none') return 'none';
  if (normalized.includes('anthropic')) return 'anthropic';
  return normalized;
}

function redactModelConfig(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, raw]) => {
    if (!isRecord(raw)) return [key, raw];
    const { apiKey: _apiKey, key: _key, token: _token, ...safe } = raw;
    // Nested provider blocks (webSearch.doubao/tavily) carry keys too.
    if (key === 'webSearch' && isRecord(safe)) {
      return [key, Object.fromEntries(Object.entries(safe).map(([nestedKey, nested]) => {
        if (!isRecord(nested)) return [nestedKey, nested];
        const { apiKey: _nestedApiKey, key: _nestedKey, token: _nestedToken, ...nestedSafe } = nested;
        return [nestedKey, nestedSafe];
      }))];
    }
    return [key, safe];
  }));
}

/** Empty nested WebSearchConfig returned before any webSearch row exists, so
 * the panel always renders an editable form (fresh-install first save). */
const EMPTY_WEB_SEARCH_CONFIG: Record<string, unknown> = {
  enabled: false,
  providers: [],
  maxResults: 5,
  timeoutMs: 15_000,
  doubao: { edition: 'custom', baseUrl: '', apiKeyConfigured: false },
  tavily: { baseUrl: '', apiKeyConfigured: false }
};

/** Converts the persisted webSearch provider row back into the panel's nested
 * WebSearchConfig shape (enabled/providers/maxResults/timeoutMs/doubao/tavily). */
function toAdminWebSearchConfig(row: ProviderConfig): Record<string, unknown> {
  const options = row.options;
  const primary = row.provider === 'tavily' ? 'tavily' : 'doubao';
  const fallback = options.fallback === 'tavily' ? 'tavily' : options.fallback === 'doubao' ? 'doubao' : null;
  const secondaryBaseUrl = typeof options.secondaryBaseUrl === 'string' ? options.secondaryBaseUrl : '';
  const secondarySecretRef = typeof options.secondarySecretRef === 'string' ? options.secondarySecretRef : null;
  const doubao = primary === 'doubao'
    ? { edition: options.edition === 'global' ? 'global' : 'custom', baseUrl: row.baseUrl, apiKeyConfigured: Boolean(row.secretRef) }
    : { edition: options.edition === 'global' ? 'global' : 'custom', baseUrl: secondaryBaseUrl || DOUBAO_SEARCH_DEFAULT_URL, apiKeyConfigured: Boolean(secondarySecretRef) };
  const tavily = primary === 'tavily'
    ? { baseUrl: row.baseUrl, apiKeyConfigured: Boolean(row.secretRef) }
    : { baseUrl: secondaryBaseUrl || TAVILY_SEARCH_DEFAULT_URL, apiKeyConfigured: Boolean(secondarySecretRef) };
  return {
    enabled: row.enabled,
    providers: [primary, ...(fallback ? [fallback] : [])],
    maxResults: typeof options.maxResults === 'number' ? Math.max(1, Math.min(20, Math.trunc(options.maxResults))) : 5,
    timeoutMs: typeof options.timeoutMs === 'number' ? Math.max(1_000, Math.min(120_000, Math.trunc(options.timeoutMs))) : 15_000,
    doubao,
    tavily
  };
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
