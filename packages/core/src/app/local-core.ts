import type { LocalDatabase } from '../platform/database.js';
import type { SecretsPlatform } from '../platform/secrets.js';
import type { MediaPlatform } from '../platform/media.js';
import type { HttpPlatform } from '../platform/http.js';
import { ConfigRepository, JobRepo, LifeCityRepo, LifeClockRepo, LifeRepo, LifeV2Repo, LocationRepo, MediaRepo, MemoryRepo, MessageRepo, MetricsRepo, MomentRepo, ReplyBatchRepo, SettingsRepo, StickerRepo, SummaryRepo, ThoughtRepo, VoiceRepo, WeatherRepo, type MediaRow, type ProviderConfig, type Sticker } from '../db/index.js';
import type { ChatProvider } from '../providers/types.js';
import type { ConfiguredProviders } from '../providers/provider-factory.js';
import { DirectorClient } from './director/client.js';
import { MediaDirector } from './media-director.js';
import { LocalVoiceService } from './voice/service.js';
import { mergeServerPersonaSeed } from './server-persona.js';
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
import { LocalMediaResolver } from './media-resolver.js';
import { ModelDiscoveryService } from './model-discovery.js';
import { CHAT_FALLBACK_SLOTS, MODEL_CAPABILITY_SLOTS, MODEL_DEFAULTS, type ModelCapabilitySlot } from './model-defaults.js';
import { PersonaReferenceService, REFERENCE_FRAMINGS, type ReferenceFraming } from './persona-reference-service.js';
import { ContextBuilder } from './context-builder.js';
import type { WorldSnapshot } from './context/types.js';
import { SummaryBuilder } from './summary-builder.js';
import { StickerAnalyzer } from './sticker-analyzer.js';
import { extractText } from '../util/text-extractor.js';
import { LocalLifeCatchUp } from '../life/catch-up-service.js';
import { LifeV2Source } from '../life/v2/source.js';
import { LocalLocationService } from '../world/location/service.js';
import { MomentComposer } from '../moments/composer.js';
import { MomentPolicy } from '../moments/moment-policy.js';
import { MomentImagePolicy } from '../moments/moment-image-policy.js';
import { currentReplyFeatureRuntime } from './reply-feature-runtime.js';
import { LATEST_SCHEMA_VERSION } from '../db/migrations.js';
import { newId } from '../db/database.js';
import { exactRoute, methodSet, prefixRoute, regexRoute, type NativeAdminMethod, type NativeAdminRoute, type NativeAdminRouteContext } from './admin-routes.js';
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
  /** Display version surfaced by GET /api/admin/system. */
  version?: string;
  /** Process start timestamp surfaced by GET /api/admin/system. */
  startedAt?: string;
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

/** Thrown when the native admin bridge receives a route it has not
 * implemented. The old `return {}` behavior made missing handlers look like
 * successful mutations; this is the explicit failure contract instead. */
export class AdminRouteUnsupportedError extends Error {
  readonly code = 'admin-route-unsupported';
  constructor(readonly method: string, readonly route: string) {
    super(`此功能尚未接入设备端：${method} ${route}`);
    this.name = 'AdminRouteUnsupportedError';
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
  /** Durable location runtime: travel is only created through edges. */
  readonly locationRuntime: LocalLocationService;
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
  readonly lifeV2Repo: LifeV2Repo;
  /** Monotonic wall-clock used for runtime-relative admin fields. */
  readonly runtimeStartedAt: Date;
  readonly runtimeVersion: string;
  /** Logical-id → physical-location media store (builtin assets vs native
   * UUID via rel_path); undefined only when no platform store was injected. */
  readonly media: MediaPlatform | undefined;
  readonly events: LocalEmitter;
  /** Structured media-decision layer (voice/image directors) over the
   * director provider slot; degrades through deterministic fallbacks. */
  readonly mediaDirector: MediaDirector;
  /** Voice V2 pipeline: intent → mode → independent script → guards → TTS. */
  readonly voiceService: LocalVoiceService;
  readonly replies: ReplyCoordinator;
  readonly contextBuilder: ContextBuilder;
  readonly summaryBuilder: SummaryBuilder;
  readonly personaReferences: PersonaReferenceService;
  /** Resolver for providers built from the persisted config (used when no
   * explicit chatProvider was injected, e.g. native boot). */
  private readonly configuredProviders?: () => Promise<ConfiguredProviders>;
  /** In-memory weather forecast cache (per city, 30 min TTL). */
  private readonly forecastCache = new Map<string, { summary: WeatherForecastSummary; fetchedAt: number }>();
  /** Ordered native admin route registry. Matching and capability discovery
   * are owned by this table; unknown routes never reach a handler. */
  private readonly adminRoutes: NativeAdminRoute[];

  constructor(private readonly options: LocalCoreOptions) {
    const db = options.db;
    this.database = db;
    const now = options.now ?? (() => new Date());
    this.messagesRepo = new MessageRepo(db, now);
    this.momentsRepo = new MomentRepo(db, now);
    this.stickersRepo = new StickerRepo(db, now);
    this.lifeRepo = new LifeRepo(db, now);
    this.lifeClockRepo = new LifeClockRepo(db, now);
    this.lifeCitiesRepo = new LifeCityRepo(db, now);
    this.locationsRepo = new LocationRepo(db, now);
    this.weatherRepo = new WeatherRepo(db, now);
    this.lifeV2Repo = new LifeV2Repo(db, now);
    this.locationRuntime = new LocalLocationService({ locations: this.locationsRepo, now });
    this.lifeCatchUp = new LocalLifeCatchUp({
      clock: this.lifeClockRepo,
      now,
      detailedWindowMs: 7 * 86_400_000,
      maxTransitions: 200,
      source: new LifeV2Source({
        life: this.lifeV2Repo,
        lifeState: this.lifeRepo,
        locations: this.locationsRepo,
        weather: this.weatherRepo,
        locationRuntime: this.locationRuntime,
        now
      })
    });
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
    this.runtimeStartedAt = options.startedAt ? new Date(options.startedAt) : now();
    this.runtimeVersion = options.version ?? 'local';
    this.media = options.mediaStore ? new LocalMediaResolver(this.mediaRepo, options.mediaStore) : undefined;
    this.personaReferences = new PersonaReferenceService(this.settingsRepo, this.mediaRepo);
    this.configuredProviders = options.http
      ? async () => (await import('../providers/provider-factory.js')).createConfiguredProviders(options.http!, this.configRepo)
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
      imageProvider: async () => (await this.configuredProviders?.())?.image ?? null,
      mediaDirector: () => this.mediaDirector,
      media: this.media,
      personaReferences: this.personaReferences,
      referenceImages: async (hint) => (await currentReplyFeatureRuntime()?.referenceImages?.(hint)) ?? [],
      imagePolicy: new MomentImagePolicy(),
      now
    });
    this.contextBuilder = new ContextBuilder({
      messages: this.messagesRepo,
      summaries: this.summaryRepo,
      memory: this.memoryProvider,
      settings: this.settingsRepo,
      world: () => this.worldSnapshot(),
      stickers: this.stickersRepo,
      media: this.media,
      mediaRepo: this.mediaRepo,
      visionConfigured: async () => {
        const providers = await this.configuredProviders?.();
        return Boolean(providers?.vision?.configured ?? options.chatProvider?.configured ?? false);
      },
      contextWindowTokens: async () => {
        const config = await this.configRepo.getProvider('chat');
        const value = config?.options.contextWindow;
        return typeof value === 'number' && value > 0 ? value : undefined;
      },
      maxOutputTokens: async () => {
        const config = await this.configRepo.getProvider('chat');
        const value = config?.options.maxTokens;
        return typeof value === 'number' && value > 0 ? value : undefined;
      },
      now
    });
    this.summaryBuilder = new SummaryBuilder({
      messages: this.messagesRepo,
      summaries: this.summaryRepo,
      summaryProvider: async () => (await this.configuredProviders?.())?.summary ?? null,
      chatProvider: async () => options.chatProvider ?? await options.chatProviderFactory?.() ?? (await this.configuredProviders?.())?.chat ?? null
    });
    this.events = new LocalEmitter(now);
    // Media Director: resolves the director slot (with chat fallback) lazily
    // per call, so admin config changes take effect without rebuilding. Events
    // carry only privacy-safe fields (task/latency/sizes/failure class).
    this.mediaDirector = new MediaDirector(new DirectorClient(
      async () => (await this.configuredProviders?.())?.director ?? null,
      { onEvent: (event) => this.events.emit(`director.${event.task}.${event.event}`, { ...event }) }
    ));
    this.voiceService = new LocalVoiceService({
      voices: this.voicesRepo,
      settings: this.settingsRepo,
      messages: this.messagesRepo,
      mediaDirector: this.mediaDirector,
      persona: () => this.personaVoicePolicy(),
      emit: (type, data) => this.events.emit(type, data),
      isCurrentRevision: async (batchId, revision) => await this.batchesRepo.currentRevision(batchId) === revision
    });
    this.replies = new ReplyCoordinator({
      messages: this.messagesRepo,
      batches: this.batchesRepo,
      memory: this.memoryProvider,
      provider: options.chatProvider,
      providerFactory: options.chatProviderFactory ?? (options.http ? async () => (await import('../providers/provider-factory.js')).createConfiguredProviders(options.http!, this.configRepo).then((providers) => providers.chat) : undefined),
      webSearch: options.http ? () => createWebSearch(options.http!, this.configRepo) : null,
      toolRuntime: options.toolRuntime,
      contextBuilder: this.contextBuilder,
      mediaDirector: this.mediaDirector,
      voiceService: this.voiceService,
      now,
      debounceMs: options.replyDebounceMs,
      emit: (type, data) => this.events.emit(type, data)
    });
    this.adminRoutes = this.buildAdminRoutes();
  }

  subscribe(listener: LocalEventListener): () => void {
    return this.events.subscribe(listener);
  }

  /** Single world producer consumed by ContextBuilder (Life/Location/Weather). */
  private async worldSnapshot(): Promise<WorldSnapshot> {
    const [presence, life] = await Promise.all([this.presence(), this.life()]);
    const state = await this.locationsRepo.currentState().catch(() => undefined);
    const location = state ? await this.locationsRepo.get(state.location_id).catch(() => undefined) : undefined;
    return {
      city: presence.city,
      location: presence.location,
      travel: presence.travel,
      weather: presence.weather,
      timeZone: location?.time_zone ?? null,
      life: {
        current: { activity: life.activity, kind: life.kind, mood: life.mood },
        recent: life.recent
      }
    };
  }

  /** Persona voice policy with server defaults applied (enabled, 300 chars). */
  private async personaVoicePolicy(): Promise<{ name: string; voicePolicy: { enabled: boolean; maxCharsPerClip: number } }> {
    const saved = await this.settingsRepo.get<Record<string, unknown>>('persona', {});
    const persona = mergeServerPersonaSeed(saved) as { name?: string; voicePolicy?: { enabled?: boolean; maxCharsPerClip?: number } };
    return {
      name: typeof persona.name === 'string' && persona.name ? persona.name : 'SOOYA',
      voicePolicy: {
        enabled: persona.voicePolicy?.enabled !== false,
        maxCharsPerClip: persona.voicePolicy?.maxCharsPerClip || 300
      }
    };
  }

  /** Foreground: recover interrupted jobs before the scheduler drains them. */
  async onAppActive(): Promise<void> {
    await this.jobsRepo.recoverStuck();
    await this.voicesRepo.recoverInFlight().catch(() => undefined);
    const caught = await this.lifeCatchUp.catchUp().catch(() => null);
    if (caught) this.events.emit('life.updated', { activity: caught.state.current.activity });
    const cachedWeather = await this.weatherRepo.latest('active').catch((error) => { void this.recordError('weather.read', errorMessage(error)); return undefined; });
    const weatherAgeMs = cachedWeather ? (this.options.now?.() ?? new Date()).getTime() - Date.parse(cachedWeather.observed_at) : Number.POSITIVE_INFINITY;
    if (!cachedWeather || !Number.isFinite(weatherAgeMs) || weatherAgeMs > 30 * 60_000) await this.refreshWeather().catch((error) => { void this.recordError('weather.refresh', errorMessage(error)); });
    const presence = await this.presence().catch((error) => { void this.recordError('world.presence', errorMessage(error)); return null; });
    if (presence) this.events.emit('world.updated', { presence });
    await this.composeMomentsIfEnabled().catch((error) => { void this.recordError('moment.compose', errorMessage(error)); });
    await this.replies.recover().catch((error) => { void this.recordError('reply.recover', errorMessage(error)); });
    void this.memorySync?.syncOnce().catch((error) => { void this.recordError('memory.sync', errorMessage(error)); });
  }

  private async localLifeSettings(): Promise<LocalLifeSettings> {
    const stored = await this.settingsRepo.get<Record<string, unknown>>('lifeSettings', defaultLifeSettings());
    return normalizeLocalLifeSettings(stored);
  }

  /** Native IPA has no deployment env gate. The saved admin switch is the source of truth. */
  private async composeMomentsIfEnabled(): Promise<void> {
    const settings = await this.localLifeSettings();
    const now = this.options.now?.() ?? new Date();
    if (!settings.reachOut || settings.maxReachOutsPerDay <= 0 || isSilentLifeHour(now, settings)) return;
    await this.momentComposer.compose(now, new MomentPolicy({
      dailyCap: settings.maxReachOutsPerDay,
      minGapMs: settings.quietGapMinutes * 60_000
    }));
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
    if (!this.media) {
      return { media: [], failed: files.map((file) => ({ filename: file.name, error: 'media storage unavailable', code: 'no-media-store' })) };
    }
    const media: MediaRef[] = [];
    const failed: Array<{ filename: string; error: string; code?: string }> = [];
    for (const file of files) {
      try {
        const saved = await this.media.save({
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
    const [state, travel, weather, activeCity] = await Promise.all([
      this.locationsRepo.currentState(),
      this.locationsRepo.currentTravel(),
      this.weatherRepo.latest('active'),
      this.lifeCitiesRepo.activeCity()
    ]);
    const location = state ? await this.locationsRepo.get(state.location_id) : undefined;
    const from = travel ? await this.locationsRepo.get(travel.from_location_id) : undefined;
    const to = travel ? await this.locationsRepo.get(travel.to_location_id) : undefined;
    const cityId = location?.city_id ?? activeCity?.id ?? (location?.city ? `city:${location.city}` : undefined);
    const cityName = location?.city ?? activeCity?.name ?? undefined;
    return {
      city: cityId && cityName ? {
        id: cityId,
        name: cityName,
        ...(location?.region || activeCity?.region ? { region: location?.region ?? activeCity?.region ?? undefined } : {}),
        ...(location?.country || activeCity?.country ? { country: location?.country ?? activeCity?.country ?? undefined } : {})
      } : null,
      location: location ? { id: location.id, name: location.name, kind: location.kind } : null,
      travel: travel ? {
        fromLocationId: travel.from_location_id,
        fromName: from?.name ?? null,
        toLocationId: travel.to_location_id,
        toName: to?.name ?? null,
        mode: travel.mode,
        expectedArriveAt: travel.expected_arrive_at
      } : null,
      weather: weather ? {
        condition: weather.condition,
        temperatureC: weather.temperature_c,
        feelsLikeC: weather.feels_like_c,
        observedAt: weather.observed_at,
        stale: (this.options.now?.() ?? new Date()).getTime() - Date.parse(weather.observed_at) > 3 * 3600_000,
        provider: weather.provider
      } : null,
      updatedAt: (this.options.now?.() ?? new Date()).toISOString()
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
  private async analyzeSticker(stickerId: string, force = false): Promise<void> {
    if (!this.media) return;
    const analyzer = new StickerAnalyzer(this.stickersRepo, this.media, () => this.visionProvider());
    await analyzer.analyze(stickerId, { force });
  }

  private async visionProvider(): Promise<ChatProvider | null> {
    return this.options.chatProvider ?? await this.options.chatProviderFactory?.() ?? (await this.configuredProviders?.())?.vision ?? null;
  }

  /** Fetches current weather for the active location through open-meteo and persists it. */
  private async refreshWeather(): Promise<{ ok: boolean; snapshot: Record<string, unknown> | null; error: string | null }> {
    if (!this.options.http) return { ok: false, snapshot: null, error: '本地 HTTP 传输不可用' };
    try {
      const locationState = await this.locationsRepo.currentState();
      const location = locationState ? await this.locationsRepo.get(locationState.location_id) : undefined;
      const activeCity = await this.lifeCitiesRepo.activeCity();
      const cityName = location?.city ?? activeCity?.name ?? location?.name;
      const country = location?.country ?? activeCity?.country ?? '中国';
      if (!cityName) return { ok: false, snapshot: null, error: '没有可用的当前位置' };
      const provider = new OpenMeteoWeatherProvider(this.options.http);
      const snapshot = await provider.current({ city: cityName, country });
      await this.weatherRepo.save({
        // Header/presence reads the logical active slot rather than the provider's geocode key.
        location_key: 'active',
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
      const activeCity = await this.lifeCitiesRepo.activeCity();
      const cityName = location?.city ?? activeCity?.name ?? location?.name;
      const country = location?.country ?? activeCity?.country ?? '中国';
      if (!cityName) return null;
      const now = this.options.now?.() ?? new Date();
      const cached = this.forecastCache.get(cityName);
      if (!force && cached && now.getTime() - cached.fetchedAt < 30 * 60_000) return cached.summary;
      const provider = new OpenMeteoWeatherProvider(this.options.http);
      const forecast = await provider.forecast({ city: cityName, country });
      const summary = summarizeForecast(forecast.periods, forecast.generatedAt, forecast.provider, now);
      this.forecastCache.set(cityName, { summary, fetchedAt: now.getTime() });
      return summary;
    } catch {
      return null;
    }
  }

  /** Extracts text from an uploaded file and records it in media_text. */
  private async extractMediaText(mediaId: string): Promise<void> {
    if (!this.media) return;
    const row = await this.mediaRepo.get(mediaId);
    if (!row) return;
    const read = await this.media.read(mediaId).catch(() => null);
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

  /** Admin UI bridge for native mode. Route matching is owned by the
   * {@link adminRoutes} registry; unknown routes fail explicitly. */
  async adminRequest<T = unknown>(path: string, options: LocalAdminRequestOptions = {}): Promise<T> {
    const url = new URL(path, 'https://sooya.local');
    const route = url.pathname;
    const method = (options.method ?? 'GET').toUpperCase() as NativeAdminMethod;
    const context: NativeAdminRouteContext = {
      path,
      route,
      method,
      url,
      rawBody: options.body,
      body: isRecord(options.body) ? options.body : {},
      options
    };
    for (const entry of this.adminRoutes) {
      if (entry.methods && !entry.methods.includes(method)) continue;
      if (!entry.matches(route)) continue;
      return await entry.handler(context) as T;
    }
    throw new AdminRouteUnsupportedError(method, route);
  }

  /** Builds the ordered route registry in the same precedence order as the
   * original admin if-chain. Every implemented route must be declared here;
   * the dispatcher rejects everything else before any handler runs. */
  private adminRouteHandler(capability: string): (context: NativeAdminRouteContext) => Promise<unknown> {
    switch (capability) {
      case 'system':
      case 'capabilities': return (context) => this.adminSystemRoutes(context);
      case 'persona':
      case 'voiceBehavior': return (context) => this.adminPersonaRoutes(context);
      case 'models':
      case 'modelPresets':
      case 'webSearchProbe':
      case 'modelProbe':
      case 'ttsPreview': return (context) => this.adminModelRoutes(context);
      case 'memories':
      case 'memoryStatus':
      case 'memorySync':
      case 'memoryLocalSearch':
      case 'memoryCatalog':
      case 'memoryActivity': return (context) => this.adminMemoryRoutes(context);
      case 'chatHistory':
      case 'chatContext':
      case 'chatSummary': return (context) => this.adminChatRoutes(context);
      case 'jobs':
      case 'errors':
      case 'backupList':
      case 'backupCreate':
      case 'backupDelete':
      case 'backupVerify':
      case 'notifications':
      case 'ota': return (context) => this.adminOperationsRoutes(context);
      case 'lifeCatchUp':
      case 'momentsCompose': return (context) => this.adminLifeEngineRoutes(context);
      case 'mcpOverview':
      case 'mcpTest':
      case 'mcpToolSchema':
      case 'mcpServerDelete':
      case 'mcpServerSave': return (context) => this.adminMcpRoutes(context);
      case 'stickerUpload':
      case 'stickerList':
      case 'stickerUpdate':
      case 'stickerAnalyze':
      case 'stickerBatchAnalyze': return (context) => this.adminStickerRoutes(context);
      case 'referenceList':
      case 'referenceUpload':
      case 'referenceData':
      case 'referenceDelete': return (context) => this.adminReferenceRoutes(context);
      case 'mediaData':
      case 'gallery':
      case 'mediaDetail':
      case 'mediaAction':
      case 'mediaList':
      case 'mediaBatch': return (context) => this.adminMediaRoutes(context);
      case 'life':
      case 'lifePlans':
      case 'lifeSettings':
      case 'lifeTick':
      case 'lifeOverview':
      case 'lifeVitals':
      case 'lifeThreads':
      case 'lifeEvents':
      case 'lifeProactive':
      case 'lifeLocations':
      case 'lifeLocationOverride':
      case 'lifeTravel':
      case 'lifeCities': return (context) => this.adminLifeRoutes(context);
      case 'weatherStatus':
      case 'weatherForecast':
      case 'weatherRefresh': return (context) => this.adminWeatherRoutes(context);
      case 'nativeCapabilities':
      case 'storage':
      case 'storagePolicy':
      case 'storageCleanup':
      case 'metrics':
      case 'metricsDistributions':
      case 'audit': return (context) => this.adminStorageMetricsRoutes(context);
      default: throw new Error(`missing native admin route handler: ${capability}`);
    }
  }

  private buildAdminRoutes(): NativeAdminRoute[] {
    const legacy = (capability: string, methods: readonly NativeAdminMethod[] | undefined, matches: (route: string) => boolean): NativeAdminRoute => ({
      capability,
      methods,
      matches,
      handler: (context) => this.adminRouteHandler(capability)(context)
    });

    return [
      // ---- overview / bootstrap ----
      legacy('system', undefined, exactRoute('/api/admin/system')),
      legacy('capabilities', undefined, exactRoute('/api/admin/capabilities')),
      legacy('nativeCapabilities', methodSet('GET'), exactRoute('/api/admin/native-capabilities')),

      // ---- persona / voice behavior ----
      legacy('persona', undefined, exactRoute('/api/admin/persona')),
      legacy('voiceBehavior', undefined, exactRoute('/api/admin/voice-behavior')),

      // ---- models & presets ----
      legacy('models', undefined, exactRoute('/api/admin/models')),
      legacy('modelPresets', undefined, exactRoute('/api/admin/model-presets')),
      legacy('modelPresets', methodSet('POST'), exactRoute('/api/admin/model-presets/from-current')),
      legacy('webSearchProbe', methodSet('POST'), exactRoute('/api/admin/models/web-search/test')),
      legacy('modelProbe', methodSet('POST'), regexRoute(/^\/api\/admin\/models\/(?!web-search)[^/]+\/(discover|test)$/u)),
      legacy('modelPresets', methodSet('POST'), regexRoute(/^\/api\/admin\/model-presets\/[^/]+\/apply$/u)),
      legacy('ttsPreview', methodSet('POST'), exactRoute('/api/admin/voice/preview')),

      // ---- memory ----
      legacy('memories', undefined, exactRoute('/api/admin/memories')),
      legacy('memories', methodSet('POST'), exactRoute('/api/admin/memories/clear')),
      legacy('memoryStatus', undefined, exactRoute('/api/admin/memory/status')),
      legacy('memorySync', methodSet('POST'), exactRoute('/api/admin/memory/sync')),
      legacy('memoryLocalSearch', undefined, prefixRoute('/api/admin/memory/ombre/search')),
      legacy('memoryCatalog', undefined, prefixRoute('/api/admin/memory/ombre/catalog')),
      legacy('memoryActivity', undefined, exactRoute('/api/admin/memory/activity')),
      legacy('memories', methodSet('DELETE'), regexRoute(/^\/api\/admin\/memories\/[^/]+$/u)),

      // ---- chat ----
      legacy('chatHistory', methodSet('GET'), exactRoute('/api/admin/chat/history')),
      legacy('chatContext', methodSet('GET'), regexRoute(/^\/api\/admin\/chat\/history\/[^/]+\/context$/u)),
      legacy('chatHistory', methodSet('POST'), exactRoute('/api/admin/chat/clear')),
      legacy('chatSummary', methodSet('POST'), exactRoute('/api/admin/chat/summary/build')),

      // ---- operations / diagnostics ----
      legacy('jobs', undefined, exactRoute('/api/admin/jobs')),
      legacy('errors', methodSet('DELETE'), exactRoute('/api/admin/errors')),
      legacy('errors', methodSet('GET'), exactRoute('/api/admin/errors')),
      legacy('backupList', methodSet('GET'), exactRoute('/api/admin/backups')),
      legacy('backupCreate', methodSet('POST'), exactRoute('/api/admin/backups')),
      legacy('backupDelete', methodSet('DELETE'), regexRoute(/^\/api\/admin\/backups\/[^/]+$/u)),
      legacy('backupVerify', methodSet('POST'), regexRoute(/^\/api\/admin\/backups\/[^/]+\/(verify|restore)$/u)),
      legacy('notifications', undefined, exactRoute('/api/admin/notifications')),

      // ---- life / moments / weather ----
      legacy('lifeCatchUp', methodSet('POST'), exactRoute('/api/admin/life/catch-up')),
      legacy('momentsCompose', methodSet('POST'), exactRoute('/api/admin/moments/compose')),

      // ---- OTA ----
      legacy('ota', methodSet('GET'), exactRoute('/api/admin/ota')),
      legacy('ota', methodSet('PUT', 'PATCH'), exactRoute('/api/admin/ota')),

      // ---- MCP ----
      legacy('mcpOverview', methodSet('GET'), exactRoute('/api/admin/mcp/servers')),
      legacy('mcpTest', methodSet('POST'), regexRoute(/^\/api\/admin\/mcp\/[^/]+\/(test|refresh-tools)$/u)),
      legacy('mcpToolSchema', undefined, regexRoute(/^\/api\/admin\/mcp\/tools\/[^/]+$/u)),
      legacy('mcpServerDelete', methodSet('DELETE'), regexRoute(/^\/api\/admin\/mcp\/servers\/[^/]+$/u)),
      legacy('mcpServerSave', methodSet('POST', 'PUT'), exactRoute('/api/admin/mcp/servers')),

      // ---- stickers ----
      legacy('stickerUpload', methodSet('POST'), exactRoute('/api/admin/stickers')),
      legacy('stickerList', methodSet('GET'), exactRoute('/api/admin/stickers')),
      legacy('stickerUpdate', methodSet('PATCH', 'DELETE'), regexRoute(/^\/api\/admin\/stickers\/[^/]+$/u)),
      legacy('stickerAnalyze', methodSet('POST'), regexRoute(/^\/api\/admin\/stickers\/[^/]+\/analyze$/u)),
      legacy('stickerBatchAnalyze', methodSet('POST'), exactRoute('/api/admin/stickers/analyze-batch')),

      // ---- persona reference images ----
      legacy('referenceList', methodSet('GET'), exactRoute('/api/admin/persona/references')),
      legacy('referenceUpload', methodSet('POST'), regexRoute(/^\/api\/admin\/persona\/references\/slot\/[^/]+$/u)),
      legacy('referenceData', methodSet('GET'), regexRoute(/^\/api\/admin\/persona\/references\/[^/]+\/data$/u)),
      legacy('referenceDelete', methodSet('DELETE'), regexRoute(/^\/api\/admin\/persona\/references\/[^/]+$/u)),

      // ---- media ----
      legacy('mediaData', methodSet('GET'), regexRoute(/^\/api\/admin\/media\/[^/]+\/data$/u)),
      legacy('gallery', methodSet('GET'), exactRoute('/api/admin/gallery')),
      legacy('mediaDetail', methodSet('GET', 'PATCH', 'DELETE'), regexRoute(/^\/api\/admin\/media\/[^/]+$/u)),
      legacy('mediaAction', methodSet('POST', 'DELETE', 'GET'), regexRoute(/^\/api\/admin\/media\/[^/]+\/(trash|restore|permanent|usage)$/u)),
      legacy('mediaList', methodSet('GET'), exactRoute('/api/admin/media')),
      legacy('mediaBatch', methodSet('POST'), exactRoute('/api/admin/media/batch')),

      // ---- life ----
      legacy('life', methodSet('GET'), exactRoute('/api/admin/life')),
      legacy('lifePlans', methodSet('GET', 'POST'), exactRoute('/api/admin/life/plans')),
      legacy('lifePlans', methodSet('PATCH'), regexRoute(/^\/api\/admin\/life\/plans\/[^/]+$/u)),
      legacy('lifeSettings', methodSet('PUT', 'PATCH'), exactRoute('/api/admin/life/settings')),
      legacy('lifeTick', methodSet('POST'), exactRoute('/api/admin/life/tick')),
      legacy('lifeOverview', methodSet('GET'), exactRoute('/api/admin/life/overview')),
      legacy('lifeVitals', methodSet('GET'), exactRoute('/api/admin/life/vitals')),
      legacy('lifeVitals', methodSet('POST'), exactRoute('/api/admin/life/vitals/adjust')),
      legacy('lifeVitals', methodSet('POST'), exactRoute('/api/admin/life/vitals/reset')),
      legacy('lifeThreads', methodSet('GET'), exactRoute('/api/admin/life/threads')),
      legacy('lifeThreads', methodSet('PATCH'), regexRoute(/^\/api\/admin\/life\/threads\/[^/]+$/u)),
      legacy('lifeEvents', methodSet('GET'), exactRoute('/api/admin/life/events')),
      legacy('lifeProactive', methodSet('GET'), exactRoute('/api/admin/life/proactive')),
      legacy('lifeLocations', methodSet('GET', 'POST'), exactRoute('/api/admin/life/locations')),
      legacy('lifeLocationOverride', methodSet('POST'), exactRoute('/api/admin/life/location/override')),
      legacy('lifeLocations', methodSet('DELETE'), regexRoute(/^\/api\/admin\/life\/locations\/[^/]+$/u)),
      legacy('lifeTravel', methodSet('GET'), exactRoute('/api/admin/life/travel')),
      legacy('lifeCities', methodSet('GET', 'POST'), exactRoute('/api/admin/life/cities')),
      legacy('lifeCities', methodSet('PATCH'), regexRoute(/^\/api\/admin\/life\/cities\/[^/]+$/u)),
      legacy('weatherStatus', methodSet('GET'), exactRoute('/api/admin/weather/status')),
      legacy('weatherForecast', methodSet('GET'), exactRoute('/api/admin/weather/forecast')),
      legacy('weatherRefresh', methodSet('POST'), exactRoute('/api/admin/weather/refresh')),

      // ---- storage / metrics / audit ----
      legacy('storage', methodSet('GET'), exactRoute('/api/admin/storage')),
      legacy('storagePolicy', methodSet('PUT', 'PATCH'), exactRoute('/api/admin/storage/policy')),
      legacy('storageCleanup', methodSet('POST'), exactRoute('/api/admin/storage/cleanup')),
      legacy('metrics', methodSet('GET'), exactRoute('/api/admin/metrics')),
      legacy('metricsDistributions', methodSet('GET'), exactRoute('/api/admin/metrics/distributions')),
      legacy('audit', methodSet('GET'), exactRoute('/api/admin/audit'))
    ];
  }

  private async adminSystemRoutes(context: NativeAdminRouteContext): Promise<unknown> {
    const route = context.route;
    const method = context.method;
    if (route === '/api/admin/system') {
      const [integrity, messages, memories, media, mediaStats, pendingJobs, backupBytes] = await Promise.all([
        this.options.db.integrityCheck(),
        this.messagesRepo.count(),
        this.options.db.query<{ c: number }>('SELECT COUNT(*) c FROM memories WHERE active=1').then((rows) => rows[0]?.c ?? 0),
        this.mediaRepo.count(false),
        this.mediaRepo.galleryStats({ deleted: false }),
        this.jobsRepo.pendingCount(),
        this.backupBytes()
      ]);
      const startedAt = Number.isFinite(this.runtimeStartedAt.getTime()) ? this.runtimeStartedAt.toISOString() : new Date(0).toISOString();
      const uptimeSec = Number.isFinite(this.runtimeStartedAt.getTime()) ? Math.max(0, Math.floor(((this.options.now?.() ?? new Date()).getTime() - this.runtimeStartedAt.getTime()) / 1000)) : 0;
      const memoryMb = await this.processMemoryMb();
      return {
        version: this.runtimeVersion,
        startedAt,
        uptimeSec,
        node: 'native',
        platform: 'iOS',
        memoryMb,
        loadAvg: [],
        healthy: integrity.ok,
        database: {
          ...integrity,
          messages,
          memories,
          media: media,
          pendingJobs,
          mediaBytes: mediaStats.bytes
        },
        storage: { mediaBytes: mediaStats.bytes, backupBytes, freeBytes: null, mode: 'app-sandbox' },
        stream: { mode: 'in-process', lastEventSeq: this.events.lastSequence },
        agent: { mode: 'on-device' }
      };
    }
    if (route === '/api/admin/capabilities') return { capabilities: (await this.capabilities()).capabilities, embeddingDimensions: null };
    throw new AdminRouteUnsupportedError(method, route);
  }

  private async adminPersonaRoutes(context: NativeAdminRouteContext): Promise<unknown> {
    const route = context.route;
    const method = context.method;
    const body = context.body;
    if (route === '/api/admin/persona') {
      const fallback = { id: 'local', name: 'SOOYA', avatar: '', userAvatar: '', tagline: '在的', systemPrompt: '', language: 'zh-CN', stickerPolicy: {}, voicePolicy: {}, imagePolicy: {} };
      if (method === 'PUT' || method === 'PATCH') {
        const previous = await this.settingsRepo.get('persona', fallback);
        const next = { ...fallback, ...previous, ...body };
        await this.syncAvatarMediaFlags(previous, next);
        await this.settingsRepo.set('persona', next);
      }
      return { persona: await this.settingsRepo.get('persona', fallback) };
    }
    if (route === '/api/admin/voice-behavior') {
      // Default mirrors the server's DEFAULT_VOICE_PREFERENCES so voice stays
      // usable out of the box (the old enabled:false default was never
      // enforced by the runtime and only misled the panel).
      const fallback = { enabled: true, maxVoiceSeconds: 30 };
      if (method === 'PUT' || method === 'PATCH') await this.settingsRepo.set('voiceBehavior', body);
      return await this.settingsRepo.get('voiceBehavior', fallback);
    }
    throw new AdminRouteUnsupportedError(method, route);
  }

  private async adminModelRoutes(context: NativeAdminRouteContext): Promise<unknown> {
    const route = context.route;
    const method = context.method;
    const body = context.body;
    if (route === '/api/admin/models') {
      if (method === 'PUT' || method === 'PATCH') {
        const input = isRecord(body.models) ? body.models : body;
        for (const capability of [...MODEL_CAPABILITY_SLOTS, 'webSearch'] as const) {
          const raw = input[capability];
          if (!isRecord(raw)) continue;
          if (capability === 'webSearch') { await this.saveWebSearchConfig(raw); continue; }
          const provider = typeof raw.provider === 'string' ? normalizeProvider(raw.provider) : '';
          const model = typeof raw.model === 'string' ? raw.model : '';
          const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : '';
          if (!provider || !baseUrl) { if (provider === 'none') await this.configRepo.removeProvider(capability); continue; }
          const existing = await this.configRepo.getProvider(capability);
          const submittedKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
          const secretRef = typeof raw.secretRef === 'string' && raw.secretRef.trim() ? raw.secretRef.trim() : existing?.secretRef ?? (submittedKey ? `provider.${capability}.key` : null);
          if (this.options.secrets && secretRef && submittedKey) await this.options.secrets.set(secretRef, submittedKey);
          await this.configRepo.setProvider({ capability, provider, model, baseUrl, secretRef, enabled: Boolean(model), options: modelOptionsFrom(raw) });
        }
        await this.settingsRepo.set('models', redactModelConfig(input));
      }
      const providers = await this.configRepo.listProviders();
      const models: Record<string, unknown> = {};
      // Fresh installs get the full default shape for every slot (provider
      // 'none' = not enabled), so the panel never shows empty inputs.
      for (const slot of MODEL_CAPABILITY_SLOTS) {
        models[slot] = { ...MODEL_DEFAULTS[slot], apiKeyConfigured: false, apiKeyBound: false, options: {} };
      }
      for (const provider of providers) {
        if (provider.capability === 'webSearch') { models.webSearch = toAdminWebSearchConfig(provider); continue; }
        const defaults = MODEL_DEFAULTS[provider.capability as ModelCapabilitySlot] ?? {};
        models[provider.capability] = {
          ...defaults,
          provider: provider.provider,
          model: provider.model,
          baseUrl: provider.baseUrl,
          secretRef: provider.secretRef,
          apiKeyConfigured: Boolean(provider.secretRef),
          apiKeyBound: true,
          options: provider.options,
          ...provider.options
        };
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
      return { models: { ...saved, ...models } };
    }
    if (route === '/api/admin/model-presets') {
      if (method === 'PUT') await this.settingsRepo.set('modelPresets', body.presets ?? []);
      return { presets: await this.settingsRepo.get('modelPresets', []), slots: await this.settingsRepo.get('modelSlots', []) };
    }
    if (route === '/api/admin/model-presets/from-current' && method === 'POST') {
      const preset = isRecord(body.preset) ? body.preset : {};
      const presets = await this.settingsRepo.get<Array<Record<string, unknown>>>('modelPresets', []);
      const saved = { ...preset, id: typeof preset.id === 'string' ? preset.id : `preset_${Date.now().toString(36)}` };
      await this.settingsRepo.set('modelPresets', [...presets.filter((item) => item.id !== saved.id), saved]);
      return { preset: saved };
    }
    if (route === '/api/admin/models/web-search/test' && method === 'POST') {
      if (body.provider === 'responses') {
        return { ok: false, provider: 'responses', latencyMs: 0, resultCount: 0, detail: '设备端本地运行时不支持 Responses 原生搜索，请改用豆包或 Tavily' };
      }
      if (!this.options.http) return { ok: false, provider: body.provider ?? 'unknown', latencyMs: 0, resultCount: 0, detail: '本地 HTTP 传输不可用，无法执行联网搜索测试' };
      const runtime = await createWebSearch(this.options.http, this.configRepo);
      if (!runtime || runtime.providers.length === 0) return { ok: false, provider: body.provider ?? 'unknown', latencyMs: 0, resultCount: 0, detail: '未配置联网搜索（webSearch provider 未启用或无密钥引用）' };
      const started = Date.now();
      try {
        const provider = runtime.providers.find((item) => item.name === body.provider) ?? runtime.providers[0]!;
        const query = typeof body.query === 'string' && body.query.trim() ? body.query.trim().slice(0, 200) : '今日新闻';
        const result = await provider.search({ query, maxResults: runtime.maxResults, signal: undefined });
        return { ok: true, provider: provider.name, latencyMs: Date.now() - started, resultCount: result.citations.length, citations: result.citations.slice(0, 5), detail: `${result.citations.length} 条结果` };
      } catch (error) {
        return { ok: false, provider: body.provider ?? 'unknown', latencyMs: Date.now() - started, resultCount: 0, detail: error instanceof Error ? error.message : String(error) };
      }
    }
    const modelAction = route.match(/^\/api\/admin\/models\/([^/]+)\/(discover|test)$/u);
    if (modelAction && modelAction[1] !== 'web-search') {
      const capability = decodeURIComponent(modelAction[1]!);
      if (modelAction[2] === 'discover') {
        if (!this.options.http) throw new Error('本地 HTTP 传输不可用，无法拉取模型列表');
        const service = new ModelDiscoveryService(this.options.http, this.configRepo);
        const result = await service.discover(capability as never, typeof body.baseUrl === 'string' ? body.baseUrl : undefined);
        if (!result.ok) throw new Error(result.detail);
        return { models: result.models, source: result.source };
      }
      return await this.probeModel(capability as (typeof MODEL_CAPABILITY_SLOTS)[number], body);
    }
    const applyPreset = route.match(/^\/api\/admin\/model-presets\/([^/]+)\/apply$/u)?.[1];
    if (applyPreset && method === 'POST') {
      const presets = await this.settingsRepo.get<Array<Record<string, unknown>>>('modelPresets', []);
      const preset = presets.find((item) => item.id === decodeURIComponent(applyPreset));
      if (!preset) throw new Error(`model preset ${applyPreset} not found`);
      const capability = typeof preset.slot === 'string' && (MODEL_CAPABILITY_SLOTS as readonly string[]).includes(preset.slot) ? preset.slot as (typeof MODEL_CAPABILITY_SLOTS)[number] : 'chat';
      const existing = await this.configRepo.getProvider(capability);
      await this.configRepo.setProvider({ capability, provider: normalizeProvider(String(preset.provider ?? '')), model: String(preset.model ?? ''), baseUrl: String(preset.baseUrl ?? ''), secretRef: existing?.secretRef ?? null });
      return { applied: decodeURIComponent(applyPreset), models: (await this.adminRequest<{ models: Record<string, unknown> }>('/api/admin/models')).models };
    }
    if (route === '/api/admin/voice/preview' && method === 'POST') {
      const preview = await this.previewVoice(typeof body.text === 'string' ? body.text : undefined, typeof body.emotion === 'string' ? body.emotion : undefined);
      if (!preview.ok) return preview;
      return { ok: true, dataBase64: bytesToBase64(preview.audio.data), mime: preview.audio.mime, format: preview.audio.format };
    }
    throw new AdminRouteUnsupportedError(method, route);
  }

  private async adminMemoryRoutes(context: NativeAdminRouteContext): Promise<unknown> {
    const route = context.route;
    const method = context.method;
    const url = context.url;
    if (route === '/api/admin/memories') {
      const rows = await this.options.db.query<{ id: string; kind: string; content: string; importance: number; confidence: number; created_at: string; updated_at: string; hits: number; has_embedding: number }>('SELECT id,kind,content,importance,confidence,created_at,updated_at,hits,embedding IS NOT NULL AS has_embedding FROM memories WHERE active=1 ORDER BY updated_at DESC LIMIT ?', [500]);
      const memories = rows.map((row) => ({ id: row.id, kind: row.kind, content: row.content, importance: row.importance, confidence: row.confidence, createdAt: row.created_at, updatedAt: row.updated_at, hits: row.hits, hasEmbedding: row.has_embedding === 1 }));
      return { memories, stats: { total: memories.length } };
    }
    if (route === '/api/admin/memories/clear' && method === 'POST') {
      if (this.memorySync) await this.memorySync.clearLocal();
      else await this.options.db.run("UPDATE memories SET active=0,updated_at=? WHERE active=1", [(this.options.now?.() ?? new Date()).toISOString()]);
      return { cleared: true };
    }
    if (route === '/api/admin/memory/status') return await this.ombreStatus();
    if (route === '/api/admin/memory/sync' && method === 'POST') {
      if (!this.memorySync) return { state: 'ready', pushed: 0, pulled: 0, conflicts: 0, pending: 0, detail: 'Ombre sync is not configured' };
      return await this.memorySync.syncOnce();
    }
    if (route.startsWith('/api/admin/memory/ombre/search')) {
      const query = url.searchParams.get('q') ?? '';
      const results = await this.memoryRepo.searchFts(query, Number(url.searchParams.get('limit') ?? 10));
      return { query, results: results.map((row) => ({ id: row.id, content: row.content })), raw: '', resultCount: results.length };
    }
    if (route.startsWith('/api/admin/memory/ombre/catalog')) {
      const memories = await this.memoryRepo.list({ limit: Number(url.searchParams.get('limit') ?? 50) });
      return { backend: 'local', entries: memories.map((row) => ({ id: row.id, kind: row.kind, content: row.content, updatedAt: row.updated_at })), total: memories.length };
    }
    if (route === '/api/admin/memory/activity') return { activity: await this.memoryActivity(Number(url.searchParams.get('limit') ?? 50)) };
    const memoryId = route.match(/^\/api\/admin\/memories\/([^/]+)$/u)?.[1];
    if (memoryId && method === 'DELETE') {
      const id = decodeURIComponent(memoryId);
      const deleted = this.memorySync ? await this.memorySync.forgetLocal(id) : await this.memoryRepo.forget(id);
      return { deleted };
    }
    throw new AdminRouteUnsupportedError(method, route);
  }

  private async adminChatRoutes(context: NativeAdminRouteContext): Promise<unknown> {
    const route = context.route;
    const method = context.method;
    const url = context.url;
    if (route === '/api/admin/chat/history') {
      const hasMediaParam = url.searchParams.get('hasMedia');
      const page = await this.messagesRepo.adminPage({
        q: url.searchParams.get('q') ?? undefined,
        role: url.searchParams.get('role') === 'user' || url.searchParams.get('role') === 'assistant' ? url.searchParams.get('role') as 'user' | 'assistant' : undefined,
        hasMedia: hasMediaParam === 'true' ? true : hasMediaParam === 'false' ? false : undefined,
        mediaKind: url.searchParams.get('mediaKind') ?? undefined,
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
        limit: Number(url.searchParams.get('limit') ?? 100),
        offset: Number(url.searchParams.get('offset') ?? 0)
      });
      return { messages: page.messages, total: page.total, limit: page.messages.length, offset: Number(url.searchParams.get('offset') ?? 0), hasMore: page.hasMore };
    }
    const contextId = route.match(/^\/api\/admin\/chat\/history\/([^/]+)\/context$/u)?.[1];
    if (contextId) return await this.messageContext(decodeURIComponent(contextId), { before: Number(url.searchParams.get('before') ?? 10), after: Number(url.searchParams.get('after') ?? 10) });
    if (route === '/api/admin/chat/clear' && method === 'POST') { const count = await this.messagesRepo.count(); await this.messagesRepo.clearAll(); return { cleared: true, messages: count }; }
    if (route === '/api/admin/chat/summary/build' && method === 'POST') return await this.summaryBuilder.build();
    throw new AdminRouteUnsupportedError(method, route);
  }

  private async adminOperationsRoutes(context: NativeAdminRouteContext): Promise<unknown> {
    const route = context.route;
    const method = context.method;
    const url = context.url;
    const body = context.body;
    if (route === '/api/admin/jobs') return { jobs: await this.jobsRepo.list(100) };
    if (route === '/api/admin/errors' && method === 'DELETE') return { cleared: await this.clearErrors() };
    if (route === '/api/admin/errors') return { errors: await this.listErrors(Number(url.searchParams.get('limit') ?? 100)) };
    if (route === '/api/admin/backups' && method === 'GET') return { backups: await this.listBackups() };
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
        return { backup: { name, path: name, bytes: backup && typeof backup === 'object' ? backup.sizeBytes ?? 0 : 0, createdAt: started, sha256: backup && typeof backup === 'object' ? backup.sha256 ?? '' : '', verified: integrity.ok && (backup && typeof backup === 'object' ? backup.verified !== false : true), mediaArchived: false } };
      } catch (error) {
        await this.options.db.run(`UPDATE local_backup_metadata SET state='failed',detail_json=? WHERE id=?`, [JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), name]);
        throw error;
      }
    }
    if (route.match(/^\/api\/admin\/backups\/[^/]+$/u) && method === 'DELETE') {
      const name = decodeURIComponent(route.split('/').pop()!);
      if (!this.options.db.deleteBackup) throw new AdminRouteUnsupportedError(method, route);
      const deletedFile = await this.options.db.deleteBackup(name);
      const deletedRow = (await this.options.db.run('DELETE FROM local_backup_metadata WHERE id=?', [name])).changes > 0;
      return { deleted: deletedFile || deletedRow };
    }
    const backupName = route.match(/^\/api\/admin\/backups\/([^/]+)\/(verify|restore)$/u);
    if (backupName && method === 'POST') {
      const name = decodeURIComponent(backupName[1]!);
      if (backupName[2] === 'verify') {
        if (!this.options.db.verifyBackup) throw new AdminRouteUnsupportedError(method, route);
        const result = await this.options.db.verifyBackup(name);
        const backup = isRecord(result) ? result : {};
        const verified = typeof backup.verified === 'boolean' ? backup.verified : true;
        const integrity = 'integrity' in backup && Array.isArray((backup as { integrity?: unknown }).integrity) ? (backup as { integrity: unknown[] }).integrity : [];
        await this.options.db.run(`UPDATE local_backup_metadata SET verified_at=?,detail_json=json_set(COALESCE(detail_json,'{}'),'$.verifyResult',json(?)) WHERE id=?`, [(this.options.now?.() ?? new Date()).toISOString(), JSON.stringify(backup), name]);
        return { name, verified, sizeBytes: typeof backup.sizeBytes === 'number' ? backup.sizeBytes : null, sha256: typeof backup.sha256 === 'string' ? backup.sha256 : '', integrity, detail: backup };
      }
      if (!this.options.db.restore) throw new Error('database restore is unavailable on this platform');
      await this.options.db.restore(name);
      await this.options.db.run(`UPDATE local_backup_metadata SET state='restored',restored_at=? WHERE id=?`, [(this.options.now?.() ?? new Date()).toISOString(), name]);
      const integrity = await this.options.db.integrityCheck();
      return { name, verified: integrity.ok, integrity };
    }
    if (route === '/api/admin/notifications') return { notifications: await this.configRepo.notificationCapabilities() };
    if (route === '/api/admin/ota' && method === 'GET') return { manifestUrl: await this.configRepo.getPreference('ota.manifestUrl', ''), state: (await this.options.db.query('SELECT * FROM local_update_state WHERE id=1'))[0] ?? null };
    if (route === '/api/admin/ota' && (method === 'PUT' || method === 'PATCH')) {
      const manifestUrl = typeof body.manifestUrl === 'string' ? body.manifestUrl.trim() : '';
      if (manifestUrl && !/^https:\/\//iu.test(manifestUrl)) throw new Error('OTA manifest URL must use HTTPS');
      await this.configRepo.setPreference('ota.manifestUrl', manifestUrl);
      return { manifestUrl, state: (await this.options.db.query('SELECT * FROM local_update_state WHERE id=1'))[0] ?? null };
    }
    throw new AdminRouteUnsupportedError(method, route);
  }

  private async adminLifeEngineRoutes(context: NativeAdminRouteContext): Promise<unknown> {
    const route = context.route;
    const method = context.method;
    if (route === '/api/admin/life/catch-up' && method === 'POST') return await this.lifeCatchUp.catchUp();
    if (route === '/api/admin/moments/compose' && method === 'POST') return await this.momentComposer.compose();
    throw new AdminRouteUnsupportedError(method, route);
  }

  private async adminMcpRoutes(context: NativeAdminRouteContext): Promise<unknown> {
    const route = context.route;
    const method = context.method;
    const body = context.body;
    if (route === '/api/admin/mcp/servers' && method === 'GET') {
      const servers = await this.mcpRepo.listServers();
      const policies = await this.mcpRepo.listPolicies();
      const tools = this.toolRegistry.listForAdmin().map((tool) => ({ ...tool, serverId: tool.serverId ?? null }));
      const memory = await this.ombreStatus();
      return { configSource: 'local-sqlite', globalPolicy: this.toolPolicy.policyState(), servers: servers.map((server) => {
        const { secretKey: _secretKey, ...safe } = server;
        return { ...safe, authConfigured: Boolean(_secretKey), toolCount: policies.filter((policy) => policy.serverId === server.id).length };
      }), tools, memory, dashboardUrl: null };
    }
    const mcpTest = route.match(/^\/api\/admin\/mcp\/([^/]+)\/(test|refresh-tools)$/u);
    if (mcpTest && method === 'POST') {
      const server = await this.refreshMcpServer(decodeURIComponent(mcpTest[1]!));
      return { ok: true, server: { ...server, authConfigured: Boolean(server?.secretKey) } };
    }
    const mcpTool = route.match(/^\/api\/admin\/mcp\/tools\/([^/]+)$/u)?.[1];
    if (mcpTool) {
      const decodedTool = decodeURIComponent(mcpTool);
      const found = this.toolRegistry.listForAdmin().find((tool) => tool.name === decodedTool || tool.modelName === decodedTool);
      if (!found) throw new Error(`MCP 工具 ${decodedTool} 不存在`);
      return { tool: found };
    }
    const mcpServerId = route.match(/^\/api\/admin\/mcp\/servers\/([^/]+)$/u)?.[1];
    if (mcpServerId && method === 'DELETE') {
      const id = decodeURIComponent(mcpServerId);
      const existing = await this.mcpRepo.getServer(id);
      await this.options.mcp?.disconnect(id);
      await this.mcpRepo.removeServer(id);
      if (this.options.secrets) {
        await this.options.secrets.remove(`mcp.${id}.token`);
        if (existing?.secretKey && existing.secretKey !== `mcp.${id}.token`) await this.options.secrets.remove(existing.secretKey);
      }
      return { deleted: true };
    }
    if (route === '/api/admin/mcp/servers' && (method === 'POST' || method === 'PUT')) {
      const id = typeof body.id === 'string' && body.id ? body.id : `mcp_${Date.now().toString(36)}`;
      const existing = await this.mcpRepo.getServer(id);
      // Token never lands in SQLite: a new value overwrites the Keychain
      // entry, '' deletes it, an absent field keeps the current ref.
      const submitted = Object.prototype.hasOwnProperty.call(body, 'token') && typeof body.token === 'string' ? body.token.trim() : undefined;
      const tokenRef = `mcp.${id}.token`;
      let secretKey: string | undefined;
      if (submitted !== undefined && submitted !== '') {
        if (this.options.secrets) await this.options.secrets.set(tokenRef, submitted);
        secretKey = tokenRef;
      } else if (submitted === '') {
        if (this.options.secrets) {
          await this.options.secrets.remove(tokenRef);
          if (existing?.secretKey && existing.secretKey !== tokenRef) await this.options.secrets.remove(existing.secretKey);
        }
        secretKey = '';
      } else {
        secretKey = existing?.secretKey;
      }
      const server = await this.mcpRepo.upsertServer({ id, name: typeof body.name === 'string' ? body.name : id, url: sanitizeMcpUrl(typeof body.url === 'string' ? body.url : ''), transport: body.transport === 'sse' ? 'sse' : 'streamable-http', enabled: body.enabled !== false, required: body.required === true, secretKey });
      return { server: { ...server, authConfigured: Boolean(server.secretKey) } };
    }
    throw new AdminRouteUnsupportedError(method, route);
  }

  private async adminStickerRoutes(context: NativeAdminRouteContext): Promise<unknown> {
    const route = context.route;
    const method = context.method;
    const url = context.url;
    const rawBody = context.rawBody;
    const body = context.body;
    if (route === '/api/admin/stickers' && method === 'POST') {
      const form = rawBody as { get?: (name: string) => unknown };
      const file = typeof form?.get === 'function' ? form.get('file') : null;
      if (!file || typeof (file as { arrayBuffer?: unknown }).arrayBuffer !== 'function') throw new Error('sticker file is required');
      const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
      const uploaded = await this.upload([{ name: stringValue(typeof form.get === 'function' ? form.get('name') : null, 'sticker'), mime: typeof (file as File).type === 'string' ? (file as File).type : 'image/png', bytes, field: 'image' }]);
      const media = uploaded.media[0];
      if (!media) throw new Error('sticker media could not be stored');
      const sticker = await this.stickersRepo.create({ mediaId: media.id, name: stringValue(typeof form.get === 'function' ? form.get('name') : null, 'sticker'), emotion: stringValue(typeof form.get === 'function' ? form.get('emotion') : null, 'neutral'), tags: [typeof form.get === 'function' ? stringValue(form.get('tags'), 'neutral') : 'neutral'], nameSource: 'manual', analysisSource: 'manual' });
      return { created: [toAdminSticker(sticker)], failed: [] };
    }
    if (route === '/api/admin/stickers' && method === 'GET') {
      const filters = { q: url.searchParams.get('q') ?? undefined, status: (url.searchParams.get('status') as never) || undefined, source: (url.searchParams.get('source') as never) || undefined, emotion: url.searchParams.get('emotion') ?? undefined, enabled: url.searchParams.has('enabled') ? url.searchParams.get('enabled') === 'true' : undefined, sort: (url.searchParams.get('sort') as never) || 'created', limit: Number(url.searchParams.get('limit') ?? 100), offset: Number(url.searchParams.get('offset') ?? 0) };
      const [stickers, total, facets] = await Promise.all([
        this.stickersRepo.list(filters),
        this.stickersRepo.countFiltered(filters),
        this.stickersRepo.facets(filters)
      ]);
      return { stickers: stickers.map(toAdminSticker), total, offset: Number(url.searchParams.get('offset') ?? 0), facets, analysisVersion: 0 };
    }
    const stickerId = route.match(/^\/api\/admin\/stickers\/([^/]+)$/u)?.[1];
    if (stickerId && method === 'PATCH') {
      const sticker = await this.stickersRepo.update(decodeURIComponent(stickerId), { name: typeof body.name === 'string' ? body.name : undefined, tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : undefined, emotion: typeof body.emotion === 'string' ? body.emotion : undefined, enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined, description: typeof body.description === 'string' ? body.description : undefined, imageText: typeof body.imageText === 'string' ? body.imageText : undefined, userMeaning: typeof body.userMeaning === 'string' ? body.userMeaning : undefined, favorite: typeof body.favorite === 'boolean' ? body.favorite : undefined });
      if (!sticker) throw new Error('sticker not found');
      return { sticker: toAdminSticker(sticker) };
    }
    if (stickerId && method === 'DELETE') return { deleted: await this.stickersRepo.delete(decodeURIComponent(stickerId)) };
    const stickerAction = route.match(/^\/api\/admin\/stickers\/([^/]+)\/analyze$/u)?.[1];
    if (stickerAction && method === 'POST') {
      const stickerId = decodeURIComponent(stickerAction);
      void this.analyzeSticker(stickerId, body.force === true).catch((error) => { void this.recordError('sticker.analyze', errorMessage(error)); });
      return { queued: true, jobId: '', stickerId, force: body.force === true };
    }
    if (route === '/api/admin/stickers/analyze-batch' && method === 'POST') {
      const selectedIds = body.mode === 'selected' && Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
      const pending = selectedIds.length
        ? (await Promise.all(selectedIds.map(async (id) => await this.stickersRepo.get(id)))).filter((item): item is Sticker => Boolean(item))
        : await this.stickersRepo.list({ status: 'pending', limit: 500 });
      for (const sticker of pending) void this.analyzeSticker(sticker.id, true).catch((error) => { void this.recordError('sticker.analyze', errorMessage(error)); });
      return { queued: pending.length, skipped: selectedIds.length ? Math.max(0, selectedIds.length - pending.length) : 0 };
    }
    throw new AdminRouteUnsupportedError(method, route);
  }

  private async adminReferenceRoutes(context: NativeAdminRouteContext): Promise<unknown> {
    const route = context.route;
    const method = context.method;
    const rawBody = context.rawBody;
    if (route === '/api/admin/persona/references' && method === 'GET') {
      return { dir: null, references: await this.personaReferences.list() };
    }
    const referenceSlot = route.match(/^\/api\/admin\/persona\/references\/slot\/([^/]+)$/u)?.[1];
    if (referenceSlot && method === 'POST') {
      const framing = decodeURIComponent(referenceSlot) as ReferenceFraming;
      if (!(REFERENCE_FRAMINGS as readonly string[]).includes(framing)) throw new Error('视角只能是 front、full-body 或 side。');
      const form = rawBody as { get?: (name: string) => unknown };
      const file = typeof form?.get === 'function' ? form.get('file') : null;
      if (!file || typeof (file as { arrayBuffer?: unknown }).arrayBuffer !== 'function') throw new Error('reference file is required');
      const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
      const mime = typeof (file as File).type === 'string' ? (file as File).type : 'image/png';
      if (!mime.startsWith('image/')) throw new Error('只支持 PNG / JPG / WEBP / GIF 图片。');
      const uploadResult = await this.upload([{ name: 'reference', mime, bytes, field: 'image' }]);
      const media = uploadResult.media[0];
      if (!media) throw new Error('reference media could not be stored');
      const uploaded = await this.personaReferences.upload(framing, media.id);
      const replaced: string[] = [];
      if (uploaded.previousMediaId && uploaded.previousMediaId !== media.id) {
        replaced.push(uploaded.previousMediaId);
        await this.deleteMediaIfUnreferenced(uploaded.previousMediaId);
      }
      const referenceImages = (await this.personaReferences.list()).map((item) => item.name);
      return { reference: uploaded.item, replaced, referenceImages };
    }
    const referenceData = route.match(/^\/api\/admin\/persona\/references\/([^/]+)\/data$/u)?.[1];
    if (referenceData && method === 'GET') {
      const name = decodeURIComponent(referenceData);
      const references = await this.personaReferences.list();
      const item = references.find((ref) => ref.name === name);
      if (item?.mediaId) {
        const read = this.media ? await this.media.read(item.mediaId) : null;
        if (!read) throw new Error('reference not found');
        return { dataBase64: bytesToBase64(read.data), mime: read.record.mime };
      }
      if (item) return { builtinPath: item.builtinPath };
      throw new Error('reference not found');
    }
    const referenceDelete = route.match(/^\/api\/admin\/persona\/references\/([^/]+)$/u)?.[1];
    if (referenceDelete && method === 'DELETE') {
      const target = decodeURIComponent(referenceDelete);
      const before = await this.personaReferences.activeSlots();
      const result = await this.personaReferences.remove(target);
      let removedFile = false;
      for (const [framing, mediaId] of Object.entries(before)) {
        if (mediaId && !(await this.personaReferences.activeSlots())[framing as ReferenceFraming]) removedFile = await this.deleteMediaIfUnreferenced(mediaId) || removedFile;
      }
      return { deleted: result.framing !== null, removedFile, referenceImages: result.referenceImages.map((item) => item.name) };
    }
    throw new AdminRouteUnsupportedError(method, route);
  }

  private async adminMediaRoutes(context: NativeAdminRouteContext): Promise<unknown> {
    const route = context.route;
    const method = context.method;
    const url = context.url;
    const body = context.body;
    const localMediaData = route.match(/^\/api\/admin\/media\/([^/]+)\/data$/u)?.[1];
    if (localMediaData && method === 'GET') {
      if (!this.media) throw new Error('native media storage is unavailable');
      const value = await this.media.read(decodeURIComponent(localMediaData));
      if (!value) throw new Error('media not found');
      return { id: value.record.id, mime: value.record.mime, bytes: value.record.bytes, dataBase64: bytesToBase64(value.data) };
    }
    if (route === '/api/admin/gallery' && method === 'GET') {
      const query = Object.fromEntries(url.searchParams.entries());
      const rows = await this.mediaRepo.listGallery({
        deleted: query.trash === 'true', origin: mediaOrigin(query.origin), favorite: query.favorite === 'true', search: query.search,
        from: query.from, to: query.to, limit: Number(query.limit ?? 60), offset: Number(query.offset ?? 0), avatar: false
      });
      const stats = await this.mediaRepo.galleryStats({ deleted: query.trash === 'true', origin: mediaOrigin(query.origin), favorite: query.favorite === 'true', search: query.search, from: query.from, to: query.to, avatar: false });
      return { media: await Promise.all(rows.map((row) => this.toAdminMedia(row))), stats, total: stats.count };
    }
    const mediaId = route.match(/^\/api\/admin\/media\/([^/]+)$/u)?.[1];
    if (mediaId) {
      const id = decodeURIComponent(mediaId);
      if (method === 'GET') {
        const row = await this.mediaRepo.get(id);
        if (!row) throw new Error('media not found');
        return { media: await this.toAdminMedia(row) };
      }
      if (method === 'PATCH') {
        if (typeof body.favorite === 'boolean') await this.mediaRepo.setFavorite(id, body.favorite);
        if (Array.isArray(body.tags)) await this.mediaRepo.setTags(id, body.tags.filter((tag): tag is string => typeof tag === 'string'));
        const row = await this.mediaRepo.get(id);
        if (!row) throw new Error('media not found');
        return { media: await this.toAdminMedia(row) };
      }
      if (method === 'DELETE') {
        await this.assertMediaDeletable(id);
        await this.removeMediaFile(id);
        return { deleted: await this.mediaRepo.delete(id) };
      }
    }
    const mediaAction = route.match(/^\/api\/admin\/media\/([^/]+)\/(trash|restore|permanent|usage)$/u);
    if (mediaAction) {
      const id = decodeURIComponent(mediaAction[1]!);
      if (mediaAction[2] === 'trash' && method === 'POST') { await this.assertMediaDeletable(id); return { trashed: await this.mediaRepo.trash(id) }; }
      if (mediaAction[2] === 'restore' && method === 'POST') return { restored: await this.mediaRepo.restore(id) };
      if (mediaAction[2] === 'permanent' && method === 'DELETE') { await this.assertMediaDeletable(id); await this.removeMediaFile(id); return { deleted: await this.mediaRepo.delete(id) }; }
      if (mediaAction[2] === 'usage' && method === 'GET') { const references = await this.mediaRepo.references(id); return { mediaId: id, usageCount: references.total, references, avatar: await this.mediaRepo.isAvatar(id) }; }
    }
    if (route === '/api/admin/media' && method === 'GET') {
      const state = url.searchParams.get('state');
      const deleted = state === 'trashed' ? true : state === 'all' ? null : false;
      const filters = { deleted, kind: (url.searchParams.get('kind') as 'image' | 'audio' | 'sticker' | 'file' | null) ?? undefined, origin: (url.searchParams.get('origin') as 'upload' | 'generated' | 'builtin' | 'remote' | null) ?? undefined, search: url.searchParams.get('q') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 200), offset: Number(url.searchParams.get('offset') ?? 0) };
      const [rows, stats] = await Promise.all([this.mediaRepo.listGallery(filters), this.mediaRepo.galleryStats(filters)]);
      return { media: await Promise.all(rows.map((row) => this.toAdminMedia(row))), total: stats.count, offset: Number(url.searchParams.get('offset') ?? 0) };
    }
    if (route === '/api/admin/media/batch' && method === 'POST') {
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
      const action = body.action;
      let changed = 0;
      const blocked: Array<{ id: string; reason: string }> = [];
      const missing: string[] = [];
      for (const id of ids) {
        const row = await this.mediaRepo.get(id);
        if (!row) { missing.push(id); continue; }
        if (action === 'trash' || action === 'permanent') {
          try {
            await this.assertMediaDeletable(id);
          } catch (error) {
            blocked.push({ id, reason: error instanceof Error ? error.message : String(error) });
            continue;
          }
        }
        if (action === 'trash') changed += Number(await this.mediaRepo.trash(id));
        else if (action === 'restore') changed += Number(await this.mediaRepo.restore(id));
        else if (action === 'favorite') changed += Number(await this.mediaRepo.setFavorite(id, true));
        else if (action === 'unfavorite') changed += Number(await this.mediaRepo.setFavorite(id, false));
        else if (action === 'permanent') { await this.removeMediaFile(id); changed += Number(await this.mediaRepo.delete(id)); }
      }
      return { changed, blocked, missing };
    }
    throw new AdminRouteUnsupportedError(method, route);
  }

  private async adminLifeRoutes(context: NativeAdminRouteContext): Promise<unknown> {
    const route = context.route;
    const method = context.method;
    const url = context.url;
    const body = context.body;
    if (route === '/api/admin/life' && method === 'GET') {
      const snapshot = await this.life();
      const settings = await this.localLifeSettings();
      const now = this.options.now?.() ?? new Date();
      const reason = !settings.reachOut
        ? 'disabled'
        : settings.maxReachOutsPerDay <= 0
          ? 'daily_cap'
          : isSilentLifeHour(now, settings)
            ? 'silent_hours'
            : 'ok';
      return {
        snapshot,
        log: await this.lifeRepo.recent(100),
        plans: await this.lifeRepo.listPlans(),
        events: await this.lifeRepo.events(100),
        proactive: await this.proactiveAttempts(),
        reachOut: {
          reach: reason === 'ok',
          reason,
          candidate: null,
          sharedLastDay: 0,
          lastUserAt: null,
          lastAssistantAt: null,
          enabledByDeployment: true
        },
        settings
      };
    }
    if (route === '/api/admin/life/plans' && method === 'GET') return { plans: await this.lifeRepo.listPlans() };
    if (route === '/api/admin/life/plans' && method === 'POST') {
      const plan = await this.lifeRepo.createPlan({ title: stringValue(body.title, '未命名计划'), kind: stringValue(body.kind, 'other'), plannedStart: nullableString(body.plannedStart), plannedEnd: nullableString(body.plannedEnd), priority: numberValue(body.priority, 0) });
      return { plan };
    }
    const lifePlanId = route.match(/^\/api\/admin\/life\/plans\/([^/]+)$/u)?.[1];
    if (lifePlanId && method === 'PATCH') {
      const plan = await this.lifeRepo.updatePlan(decodeURIComponent(lifePlanId), { title: typeof body.title === 'string' ? body.title : undefined, kind: typeof body.kind === 'string' ? body.kind : undefined, status: typeof body.status === 'string' ? body.status as never : undefined, planned_start: body.plannedStart === null || typeof body.plannedStart === 'string' ? body.plannedStart : undefined, planned_end: body.plannedEnd === null || typeof body.plannedEnd === 'string' ? body.plannedEnd : undefined, priority: typeof body.priority === 'number' ? body.priority : undefined });
      if (!plan) throw new Error('life plan not found');
      return { plan };
    }
    if (route === '/api/admin/life/settings' && (method === 'PUT' || method === 'PATCH')) {
      const current = await this.localLifeSettings();
      const settings = normalizeLocalLifeSettings({ ...current, ...body });
      await this.settingsRepo.set('lifeSettings', settings);
      if (settings.reachOut) await this.composeMomentsIfEnabled().catch(() => undefined);
      return { settings };
    }
    if (route === '/api/admin/life/tick' && method === 'POST') {
      if (typeof body.activity === 'string' && body.activity.trim()) {
        const startedAt = new Date().toISOString();
        await this.lifeRepo.advance({ activity: body.activity.trim(), kind: stringValue(body.kind, 'other'), mood: stringValue(body.mood, '平静'), startedAt, endsAt: typeof body.endsAt === 'string' ? body.endsAt : new Date(Date.now() + 3_600_000).toISOString() });
        return { changed: true, activity: body.activity.trim(), snapshot: await this.life() };
      }
      const snapshot = await this.life();
      return { changed: false, activity: snapshot.activity, snapshot };
    }
    if (route === '/api/admin/life/overview' && method === 'GET') {
      const current = await this.life();
      const locationState = await this.locationsRepo.currentState();
      const location = locationState ? await this.locationsRepo.get(locationState.location_id) : undefined;
      const weather = await this.weatherRepo.latest('active');
      const activePlan = (await this.lifeRepo.listPlans('active'))[0] ?? null;
      const events = await this.lifeRepo.events(10);
      const openThreads = (await this.lifeV2Repo.threads('open')).map((thread) => ({ id: thread.id, title: thread.title, category: thread.category, status: thread.status, progress: thread.progress }));
      return { snapshot: current, location: location ? { id: location.id, name: location.name, kind: location.kind } : null, weather: weather ? `${weather.condition}${weather.temperature_c == null ? '' : ` · ${weather.temperature_c}°C`}` : null, vitals: (await this.options.db.query('SELECT * FROM life_vitals WHERE id=1'))[0] ?? null, activePlan: activePlan ? { id: activePlan.id, title: activePlan.title, kind: activePlan.kind, status: activePlan.status } : null, openThreads, recentEvents: events.map((event) => ({ id: event.id, eventType: event.event_type, description: event.description, happenedAt: event.happened_at })) };
    }
    if (route === '/api/admin/life/vitals') return { vitals: (await this.options.db.query('SELECT * FROM life_vitals WHERE id=1'))[0] ?? null };
    if (route === '/api/admin/life/vitals/adjust' && method === 'POST') return { vitals: await this.adjustLifeVitals(body) };
    if (route === '/api/admin/life/vitals/reset' && method === 'POST') return { vitals: await this.resetLifeVitals() };
    if (route === '/api/admin/life/threads') return { threads: (await this.lifeV2Repo.threads()).map(toAdminLifeThread) };
    const lifeThreadId = route.match(/^\/api\/admin\/life\/threads\/([^/]+)$/u)?.[1];
    if (lifeThreadId && method === 'PATCH') {
      const current = await this.lifeV2Repo.getThread(decodeURIComponent(lifeThreadId));
      if (!current) throw new Error('life thread not found');
      const status = body.status === 'paused' || body.status === 'resolved' || body.status === 'abandoned' || body.status === 'open' ? body.status : current.status;
      const thread = await this.lifeV2Repo.saveThread({ id: current.id, title: current.title, category: current.category, status, progress: typeof body.progress === 'number' ? Math.max(0, Math.min(1, body.progress)) : current.progress, importance: typeof body.importance === 'number' ? body.importance : current.importance, heat: typeof body.heat === 'number' ? body.heat : current.heat, nextActions: Array.isArray(body.nextActions) ? body.nextActions.filter((item): item is string => typeof item === 'string') : undefined, meta: isRecord(body.meta) ? body.meta : undefined });
      return { thread: toAdminLifeThread(thread) };
    }
    if (route === '/api/admin/life/events') return { events: await this.lifeRepo.events(Number(url.searchParams.get('limit') ?? 50)) };
    if (route === '/api/admin/life/proactive') return { attempts: await this.proactiveAttempts() };
    if (route === '/api/admin/life/locations' && method === 'GET') {
      const rows = await this.locationsRepo.list(false);
      const state = await this.locationsRepo.currentState();
      return { locations: rows.map(toAdminLocation), current: state ? toAdminLocation(rows.find((row) => row.id === state.location_id)) : null };
    }
    if (route === '/api/admin/life/locations' && method === 'POST') {
      const location = await this.locationsRepo.create({ name: stringValue(body.name, '未命名地点'), kind: stringValue(body.kind, 'other') as never, city: nullableString(body.city), region: nullableString(body.region), country: nullableString(body.country), timeZone: nullableString(body.timeZone), lat: numberOrNull(body.lat), lng: numberOrNull(body.lng) });
      return { location: toAdminLocation(location) };
    }
    if (route === '/api/admin/life/location/override' && method === 'POST') {
      const locationId = stringValue(body.locationId, '');
      const location = await this.locationsRepo.get(locationId);
      if (!location) throw new Error('location not found');
      await this.locationsRepo.setState({ locationId, arrivedAt: (this.options.now?.() ?? new Date()).toISOString(), sourceActivityId: 'admin' });
      return { location: toAdminLocation(location), presence: await this.presence() };
    }
    const locationId = route.match(/^\/api\/admin\/life\/locations\/([^/]+)$/u)?.[1];
    if (locationId && method === 'DELETE') return { ok: await this.locationsRepo.deactivate(decodeURIComponent(locationId)) };
    if (route === '/api/admin/life/travel' && method === 'GET') {
      const travel = await this.locationsRepo.currentTravel();
      return { travel: travel ? { fromLocationId: travel.from_location_id, toLocationId: travel.to_location_id, mode: travel.mode, startedAt: travel.started_at, expectedArriveAt: travel.expected_arrive_at } : null };
    }
    if (route === '/api/admin/life/cities' && method === 'POST') {
      const city = await this.lifeCitiesRepo.create({ name: stringValue(body.name, '未命名城市'), region: nullableString(body.region), country: nullableString(body.country) ?? '中国', timeZone: nullableString(body.timeZone) ?? 'Asia/Shanghai' });
      return { city: toAdminLifeCity(city) };
    }
    if (route === '/api/admin/life/cities' && method === 'GET') return { cities: (await this.lifeCitiesRepo.list()).map(toAdminLifeCity) };
    const lifeCityId = route.match(/^\/api\/admin\/life\/cities\/([^/]+)$/u)?.[1];
    if (lifeCityId && method === 'PATCH') {
      const city = await this.lifeCitiesRepo.update(decodeURIComponent(lifeCityId), { name: typeof body.name === 'string' ? body.name : undefined, region: typeof body.region === 'string' ? body.region : undefined, active: typeof body.active === 'boolean' ? body.active : undefined });
      if (!city) throw new Error('city not found');
      return { city: toAdminLifeCity(city) };
    }
    throw new AdminRouteUnsupportedError(method, route);
  }

  private async adminWeatherRoutes(context: NativeAdminRouteContext): Promise<unknown> {
    const route = context.route;
    const method = context.method;
    if (route === '/api/admin/weather/status' && method === 'GET') {
      const snapshot = await this.weatherRepo.latest('active');
      return { enabled: Boolean(snapshot), provider: { name: snapshot?.provider ?? null, configured: Boolean(snapshot), active: Boolean(snapshot) }, currentSource: snapshot?.provider ?? null, lastSnapshot: snapshot ? toAdminWeather(snapshot) : null, cacheAgeSec: snapshot ? Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.observed_at)) / 1000)) : null, daylight: null, forecast: await this.forecastSummary() };
    }
    if (route === '/api/admin/weather/forecast' && method === 'GET') {
      return { forecast: await this.forecastSummary(), daylight: null };
    }
    if (route === '/api/admin/weather/refresh' && method === 'POST') {
      const result = await this.refreshWeather();
      const forecast = await this.forecastSummary(true);
      return { ok: result.ok, snapshot: result.snapshot, forecast, error: result.error, presence: await this.presence() };
    }
    throw new AdminRouteUnsupportedError(method, route);
  }

  private async adminStorageMetricsRoutes(context: NativeAdminRouteContext): Promise<unknown> {
    const route = context.route;
    const method = context.method;
    const url = context.url;
    const body = context.body;
    if (route === '/api/admin/native-capabilities' && method === 'GET') return await this.nativeAdminCapabilities();
    if (route === '/api/admin/storage' && method === 'GET') return await this.storageStatus();
    if (route === '/api/admin/storage/policy' && (method === 'PUT' || method === 'PATCH')) return await this.saveStoragePolicy(body);
    if (route === '/api/admin/storage/cleanup' && method === 'POST') return await this.previewOrApplyCleanup(body);
    if (route === '/api/admin/metrics' && method === 'GET') {
      const days = clampAdminDays(Number(url.searchParams.get('days') ?? 7));
      const [fromDate, toDate] = adminMetricRange(days, this.options.now?.() ?? new Date());
      const [aggregates, distributions] = await Promise.all([this.metricsRepo.aggregates(fromDate, toDate), this.metricsRepo.distributions(fromDate, toDate)]);
      return { aggregates, distributions };
    }
    if (route === '/api/admin/metrics/distributions' && method === 'GET') {
      const days = clampAdminDays(Number(url.searchParams.get('days') ?? 7));
      const [fromDate, toDate] = adminMetricRange(days, this.options.now?.() ?? new Date());
      return { distributions: await this.metricsRepo.distributions(fromDate, toDate) };
    }
    if (route === '/api/admin/audit' && method === 'GET') {
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50)));
      const errors = await this.listErrors(limit);
      const jobs = await this.jobsRepo.list(limit);
      return { audit: [...errors.map((error) => ({ kind: 'error', id: error.id, createdAt: error.createdAt, scope: error.scope, message: error.message, detail: error.detail })), ...jobs.map((job) => ({ kind: 'job', id: job.id, createdAt: job.created_at, type: job.type, status: job.status, detail: job.last_error }))].sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '')).slice(0, limit) };
    }
    throw new AdminRouteUnsupportedError(method, route);
  }

  /** Public seam for platform adapters (OTA updater, native plugins) to feed
   * runtime failures into the same error_log surfaced by the admin page. */
  async recordRuntimeError(scope: string, message: string, detail?: unknown): Promise<void> {
    await this.recordError(scope, message, detail);
  }

  /** Writes runtime diagnostics into the existing error_log table so the
   * admin「最近错误」page is not an empty placeholder. */
  private async recordError(scope: string, message: string, detail?: unknown): Promise<void> {
    try {
      await this.options.db.run(
        'INSERT INTO error_log(id,created_at,scope,message,detail) VALUES(?,?,?,?,?)',
        [newId('error'), (this.options.now?.() ?? new Date()).toISOString(), scope, message.slice(0, 2000), detail === undefined ? null : JSON.stringify(detail)]
      );
    } catch { /* diagnostics must never break the primary path */ }
  }

  private async processMemoryMb(): Promise<number> {
    const memory = (globalThis as { performance?: { memory?: { usedJSHeapSize?: number } } }).performance?.memory;
    return memory && typeof memory.usedJSHeapSize === 'number' ? Math.round((memory.usedJSHeapSize / 1024 / 1024) * 10) / 10 : 0;
  }

  private async backupBytes(): Promise<number> {
    const row = await this.options.db.query<{ bytes: number | null }>('SELECT COALESCE(SUM(bytes), 0) bytes FROM local_backup_metadata').then((rows) => rows[0]);
    return row?.bytes ?? 0;
  }

  /** Same DTO shape as GET /api/admin/memory/status, reused by the MCP overview. */
  private async ombreStatus(): Promise<Record<string, unknown>> {
    const health = await this.memoryProvider.health();
    const sync = this.memorySync ? await this.memorySync.status() : { state: health.state, provider: 'local', pendingPush: 0, pendingPull: 0, conflicts: 0, lastSyncAt: null };
    return { backend: sync.provider, connection: health.state === 'unavailable' ? 'disconnected' : health.state === 'degraded' ? 'degraded' : 'connected', health, sync, lastCommit: null, pending: sync.pendingPush, uncertain: 0, lastDream: null, dashboardUrl: null };
  }

  private async memoryActivity(limit: number): Promise<Array<{ id: string; seq: number; type: string; createdAt: string; detail: Record<string, unknown> }>> {
    const capped = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.trunc(limit) : 50));
    const rows = await this.options.db.query<{ id: string; operation: string; status: string; local_memory_id: string; remote_source_id: string | null; last_error: string | null; created_at: string; updated_at: string }>(
      'SELECT * FROM memory_sync_outbox ORDER BY updated_at DESC LIMIT ?', [capped]);
    return rows.map((row, index) => ({
      id: row.id,
      seq: index,
      type: `memory.${row.operation}`,
      createdAt: row.updated_at,
      detail: { status: row.status, localMemoryId: row.local_memory_id, remoteSourceId: row.remote_source_id, error: row.last_error }
    }));
  }

  private async listErrors(limit: number): Promise<Array<{ id: string; createdAt: string; scope: string; message: string; detail: unknown }>> {
    const capped = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.trunc(limit) : 100));
    const rows = await this.options.db.query<{ id: string; created_at: string; scope: string; message: string; detail: string | null }>('SELECT * FROM error_log ORDER BY created_at DESC LIMIT ?', [capped]);
    return rows.map((row) => ({ id: row.id, createdAt: row.created_at, scope: row.scope, message: row.message, detail: row.detail == null ? null : parseJsonRecord(row.detail) ?? row.detail }));
  }

  private async clearErrors(): Promise<boolean> {
    return (await this.options.db.run('DELETE FROM error_log')).changes >= 0;
  }

  private async listBackups(): Promise<Array<Record<string, unknown>>> {
    const rows = await this.options.db.query<{
      id: string; target: string; state: string; bytes: number | null; sha256: string | null;
      created_at: string; verified_at: string | null; restored_at: string | null; detail_json: string;
    }>('SELECT * FROM local_backup_metadata ORDER BY created_at DESC LIMIT 50');
    return rows.map((row) => ({
      name: row.id,
      path: row.target,
      bytes: row.bytes ?? 0,
      createdAt: row.created_at,
      sha256: row.sha256 ?? '',
      verified: Boolean(row.verified_at) && row.state !== 'failed',
      state: row.state,
      restoredAt: row.restored_at,
      mediaArchived: false
    }));
  }

  /** Executes a real, minimal upstream request for the saved model config.
   * Returns `ok:false` instead of throwing for expected probe failures. */
  private async probeModel(capability: (typeof MODEL_CAPABILITY_SLOTS)[number], body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.options.http) return { ok: false, slot: capability, provider: 'none', latencyMs: 0, detail: '本地 HTTP 传输不可用，无法执行真实连接测试' };
    if (capability === 'image' && body.force !== true) {
      return { ok: false, slot: capability, provider: 'none', latencyMs: 0, detail: '出图会产生真实生成费用，确认后才会执行测试出图' };
    }
    let configured = await this.configRepo.getProvider(capability);
    if (!configured && (CHAT_FALLBACK_SLOTS as readonly string[]).includes(capability)) configured = await this.configRepo.getProvider('chat');
    if (!configured?.enabled || !configured.baseUrl || !configured.model || !configured.secretRef) {
      return { ok: false, slot: capability, provider: configured?.provider ?? 'none', model: configured?.model || undefined, latencyMs: 0, detail: '这个能力还没配全（接口协议、地址、模型名、密钥缺一不可）' };
    }
    if (capability === 'vision' && configured.options.supportsVision === false) {
      return { ok: false, slot: capability, provider: configured.provider, model: configured.model, latencyMs: 0, detail: '这个模型没有声明支持读图，先把“声明支持读图”改成“是”再测' };
    }
    const { BuiltinChatProvider, BuiltinEmbeddingProvider, BuiltinRerankProvider } = await import('../providers/builtin.js');
    const { BuiltinImageProvider, BuiltinTtsProvider } = await import('../providers/media-providers.js');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('连接测试超过 30 秒还没有结果')), 30_000);
    const startedAt = Date.now();
    try {
      if (capability === 'image') {
        const provider = new BuiltinImageProvider(this.options.http!, configured);
        const image = await provider.generate('生成一张简单的抽象色块测试图', { size: '1024x1024', signal: controller.signal });
        return { ok: true, slot: capability, provider: provider.name, model: configured.model, latencyMs: Date.now() - startedAt, detail: `已收到 ${Math.max(1, Math.round(image.data.byteLength / 1024))} KB ${image.mime} 图片` };
      }
      if (capability === 'embedding') {
        const provider = new BuiltinEmbeddingProvider(this.options.http!, configured);
        const result = await provider.embed(['你好'], controller.signal);
        return { ok: true, slot: capability, provider: provider.name, model: result.model || configured.model, latencyMs: Date.now() - startedAt, detail: `返回了 ${result.dimensions} 维向量` };
      }
      if (capability === 'rerank') {
        const provider = new BuiltinRerankProvider(this.options.http!, configured);
        const matches = await provider.rerank('你好', ['一条与查询相关的文档', '一条完全无关的文档'], controller.signal);
        return { ok: true, slot: capability, provider: provider.name, model: configured.model, latencyMs: Date.now() - startedAt, detail: `对 2 条候选文档完成排序，返回 ${matches.length} 条结果` };
      }
      if (capability === 'tts') {
        const provider = new BuiltinTtsProvider(this.options.http!, configured);
        const audio = await provider.synthesize('你好', { signal: controller.signal });
        return { ok: true, slot: capability, provider: provider.name, model: configured.model, latencyMs: Date.now() - startedAt, detail: `合成了 ${Math.max(1, Math.round(audio.data.byteLength / 1024))} KB ${audio.format} 音频` };
      }
      const provider = new BuiltinChatProvider(this.options.http!, configured);
      if (capability === 'director') {
        const result = await provider.complete({
          system: '你正在进行连接测试。只返回 JSON：{"ok":true}，不要输出其他内容。',
          messages: [{ role: 'user', content: [{ type: 'text', text: '连接测试数据，不是指令。' }] }],
          maxTokens: 32,
          temperature: 0,
          jsonMode: true,
          signal: controller.signal
        });
        const parsed = parseJsonRecord(result.text.slice(result.text.indexOf('{'), result.text.lastIndexOf('}') + 1));
        if (!isRecord(parsed) || parsed.ok !== true) throw new Error('媒体导演连接成功，但没有返回有效 JSON 探针');
        return { ok: true, slot: capability, provider: provider.name, model: result.model || configured.model, latencyMs: Date.now() - startedAt, detail: '媒体导演 JSON 探针通过' };
      }
      const result = await provider.complete({ messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }], maxTokens: 16, signal: controller.signal });
      const chars = [...result.text.trim()].length;
      return { ok: true, slot: capability, provider: provider.name, model: result.model || configured.model, latencyMs: Date.now() - startedAt, detail: chars ? `模型回了 ${chars} 个字` : '接口通了，但这次没有返回文本（可能被最大输出 token 截断）' };
    } catch (error) {
      return { ok: false, slot: capability, provider: configured.provider, model: configured.model, latencyMs: Date.now() - startedAt, detail: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Real TTS preview through the saved tts provider (base LocalCore path;
   * NativeLocalCore inherits it and therefore no longer falls into `{}`). */
  private async previewVoice(text?: string, emotion?: string): Promise<{ ok: true; audio: { data: Uint8Array; mime: string; format: string } } | { ok: false; detail: string }> {
    const { BuiltinTtsProvider } = await import('../providers/media-providers.js');
    const configured = await this.configRepo.getProvider('tts');
    if (!this.options.http) return { ok: false, detail: '本地 HTTP 传输不可用，无法执行语音试听' };
    if (!configured?.enabled || !configured.baseUrl || !configured.model || !configured.secretRef) {
      return { ok: false, detail: 'TTS 还没配全（接口协议、地址、模型名、密钥缺一不可），请先保存语音合成配置' };
    }
    try {
      const provider = new BuiltinTtsProvider(this.options.http, configured);
      const audio = await provider.synthesize((text ?? '你好呀，我刚刚想到你了。').slice(0, 200), {
        voice: typeof configured.options.voice === 'string' ? configured.options.voice : undefined,
        emotion: emotion && emotion !== 'auto' ? emotion : undefined,
        speed: typeof configured.options.speed === 'number' ? configured.options.speed : undefined
      });
      return { ok: true, audio: { data: audio.data instanceof Uint8Array ? audio.data : new Uint8Array(audio.data), mime: audio.mime, format: audio.format } };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async syncAvatarMediaFlags(previous: Record<string, unknown>, next: Record<string, unknown>): Promise<void> {
    const previousIds = new Set([avatarMediaId(previous.avatar), avatarMediaId(previous.userAvatar)].filter((id): id is string => Boolean(id)));
    const nextIds = new Set([avatarMediaId(next.avatar), avatarMediaId(next.userAvatar)].filter((id): id is string => Boolean(id)));
    for (const id of previousIds) if (!nextIds.has(id)) await this.mediaRepo.setAvatarFlag(id, false).catch(() => undefined);
    for (const id of nextIds) await this.mediaRepo.setAvatarFlag(id, true).catch(() => undefined);
  }

  private async deleteMediaIfUnreferenced(mediaId: string): Promise<boolean> {
    const [references, avatar] = await Promise.all([this.mediaRepo.references(mediaId), this.mediaRepo.isAvatar(mediaId)]);
    if (references.total > 0 || avatar) return false;
    await this.removeMediaFile(mediaId);
    return await this.mediaRepo.delete(mediaId);
  }

  private async assertMediaDeletable(mediaId: string): Promise<void> {
    const row = await this.mediaRepo.get(mediaId);
    if (!row) throw new Error('media not found');
    if (row.origin === 'builtin') throw new Error('内置媒体不能删除或移入回收站');
    const [references, avatar] = await Promise.all([this.mediaRepo.references(mediaId), this.mediaRepo.isAvatar(mediaId)]);
    if (avatar) throw new Error('该媒体是当前头像，不能删除或移入回收站');
    if (references.total > 0) throw new Error(`该媒体仍被 ${references.total} 处引用，不能删除或移入回收站`);
  }

  private async removeMediaFile(mediaId: string): Promise<boolean> {
    if (!this.media) return false;
    try {
      return await this.media.remove(mediaId);
    } catch {
      return false;
    }
  }

  private async adjustLifeVitals(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const current = await this.lifeV2Repo.getVitals();
    const base = {
      energy: current?.energy ?? 0.5,
      hunger: current?.hunger ?? 0.5,
      stress: current?.stress ?? 0.5,
      social_need: current?.social_need ?? 0.5,
      loneliness: current?.loneliness ?? 0.5,
      curiosity: current?.curiosity ?? 0.5,
      comfort: current?.comfort ?? 0.5,
      focus: current?.focus ?? 0.5,
      sleep_debt: current?.sleep_debt ?? 0.5
    };
    const field = typeof body.field === 'string' ? body.field : '';
    const delta = typeof body.delta === 'number' && Number.isFinite(body.delta) ? body.delta : 0;
    if (!(field in base)) throw new Error(`unknown vital field ${field}`);
    const next = { ...base, [field]: Math.max(0, Math.min(1, Number(base[field as keyof typeof base]) + delta)) };
    await this.lifeV2Repo.upsertVitals({ ...next, meta_json: '{}' });
    return { ...(await this.lifeV2Repo.getVitals()) };
  }

  private async resetLifeVitals(): Promise<Record<string, unknown> | null> {
    const defaults = { energy: 0.5, hunger: 0.5, stress: 0.5, social_need: 0.5, loneliness: 0.5, curiosity: 0.5, comfort: 0.5, focus: 0.5, sleep_debt: 0.5 };
    await this.lifeV2Repo.upsertVitals({ ...defaults, meta_json: '{}' });
    return { ...(await this.lifeV2Repo.getVitals()) };
  }

  private async proactiveAttempts(): Promise<Array<Record<string, unknown>>> {
    const rows = await this.options.db.query<{
      id: string; candidate_id: string | null; status: string; blocked_reason: string | null; message_id: string | null;
      requested_mode: string | null; created_at: string;
    }>('SELECT id,candidate_id,status,blocked_reason,message_id,requested_mode,created_at FROM proactive_attempts ORDER BY created_at DESC LIMIT 100');
    return rows.map((row) => ({
      id: row.id,
      candidateId: row.candidate_id,
      status: row.status,
      blockedReason: row.blocked_reason,
      messageId: row.message_id,
      requestedMode: row.requested_mode,
      createdAt: row.created_at
    }));
  }

  /** Capability flags for the admin UI. Every implemented route is derived
   * from the route registry; platform-dependent seams are refined below so
   * `true` means “implemented and usable on this device”. */
  private async nativeAdminCapabilities(): Promise<Record<string, unknown>> {
    const capabilities: Record<string, boolean> = {};
    for (const entry of this.adminRoutes) capabilities[entry.capability] = true;
    capabilities.backupVerify = typeof this.options.db.verifyBackup === 'function';
    capabilities.backupDelete = typeof this.options.db.deleteBackup === 'function';
    capabilities.backupRestore = typeof this.options.db.restore === 'function';
    capabilities.memorySync = Boolean(this.memorySync);
    capabilities.ombreRemoteSearch = Boolean(this.memorySync);
    capabilities.modelDiscovery = Boolean(this.options.http);
    capabilities.modelProbe = Boolean(this.options.http);
    capabilities.webSearchProbe = Boolean(this.options.http);
    // Canonical UI switches, kept stable even when individual route keys are
    // split or renamed in the registry.
    capabilities.runtimeLogs = capabilities.errors === true;
    capabilities.chatHistoryFilters = capabilities.chatHistory === true;
    capabilities.mediaStateAll = capabilities.mediaList === true;
    capabilities.mediaRefProtection = capabilities.mediaDetail === true;
    capabilities.stickerFacets = capabilities.stickerList === true;
    capabilities.stickerForceAnalysis = capabilities.stickerAnalyze === true;
    capabilities.mcpUrlSanitized = capabilities.mcpServerSave === true;
    return capabilities;
  }

  private async storagePolicy(): Promise<StoragePolicy> {
    const stored = await this.settingsRepo.get<Record<string, unknown>>('storagePolicy', {});
    return {
      softLimitBytes: clampStorageBytes(stored.softLimitBytes),
      hardLimitBytes: clampStorageBytes(stored.hardLimitBytes),
      trashRetentionDays: clampAdminInt(stored.trashRetentionDays, 0, 3650, 30),
      tempRetentionHours: clampAdminInt(stored.tempRetentionHours, 0, 8760, 24),
      backupKeep: clampAdminInt(stored.backupKeep, 0, 1000, 7)
    };
  }

  private async storageStatus(): Promise<Record<string, unknown>> {
    const [policy, mediaStats, backupBytes] = await Promise.all([this.storagePolicy(), this.mediaRepo.galleryStats({ deleted: false }), this.backupBytes()]);
    const warning = policy.hardLimitBytes > 0 && mediaStats.bytes >= policy.hardLimitBytes ? 'hard' : policy.softLimitBytes > 0 && mediaStats.bytes >= policy.softLimitBytes ? 'soft' : null;
    return {
      mediaBytes: mediaStats.bytes,
      backupBytes,
      freeBytes: null,
      policy,
      warning,
      trashCount: (await this.mediaRepo.galleryStats({ deleted: true })).count,
      orphanFileBytes: 0,
      tempFileBytes: 0
    };
  }

  private async saveStoragePolicy(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const previous = await this.storagePolicy();
    const policy = {
      softLimitBytes: clampStorageBytes(body.softLimitBytes ?? previous.softLimitBytes),
      hardLimitBytes: clampStorageBytes(body.hardLimitBytes ?? previous.hardLimitBytes),
      trashRetentionDays: clampAdminInt(body.trashRetentionDays, 0, 3650, previous.trashRetentionDays),
      tempRetentionHours: clampAdminInt(body.tempRetentionHours, 0, 8760, previous.tempRetentionHours),
      backupKeep: clampAdminInt(body.backupKeep, 0, 1000, previous.backupKeep)
    };
    if (policy.softLimitBytes > 0 && policy.hardLimitBytes > 0 && policy.softLimitBytes > policy.hardLimitBytes) throw new Error('软限额不能大于硬限额');
    await this.settingsRepo.set('storagePolicy', policy);
    return await this.storageStatus();
  }

  private async previewOrApplyCleanup(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const apply = body.apply === true;
    const policy = await this.storagePolicy();
    const now = this.options.now?.() ?? new Date();
    const [trashCutoff, activeRows, backupRows] = await Promise.all([
      new Date(now.getTime() - policy.trashRetentionDays * 86_400_000).toISOString(),
      this.mediaRepo.listGallery({ deleted: false, limit: 500 }),
      this.options.db.query<{ id: string; bytes: number | null; created_at: string }>('SELECT * FROM local_backup_metadata ORDER BY created_at DESC')
    ]);
    const expiredTrash = await this.mediaRepo.listExpiredTrash(trashCutoff, 500);
    const candidates: Record<string, Array<Record<string, unknown>> | undefined> = {
      expiredTrash: expiredTrash.map(mediaCandidate),
      missingRecords: [],
      unreferencedMedia: [],
      tempFiles: [],
      oldBackups: backupRows.slice(policy.backupKeep).map((row) => ({ id: row.id, bytes: row.bytes ?? 0, createdAt: row.created_at, path: row.id })),
      orphanFiles: []
    };
    for (const row of activeRows) {
      if (row.origin === 'builtin') continue;
      const [references, avatar] = await Promise.all([this.mediaRepo.references(row.id), this.mediaRepo.isAvatar(row.id)]);
      if (references.total === 0 && !avatar) {
        const exists = this.media ? !!(await this.media.read(row.id).catch(() => null)) : true;
        const category = exists ? 'unreferencedMedia' : 'missingRecords';
        (candidates[category] ??= []).push({ ...mediaCandidate(row), references: references.total });
      } else if (this.media && !(await this.media.read(row.id).catch(() => null))) {
        (candidates.missingRecords ??= []).push({ ...mediaCandidate(row), references: references.total });
      }
    }
    const candidateGroups = Object.values(candidates).filter((items): items is Array<Record<string, unknown>> => Array.isArray(items));
    const reclaimableBytes = candidateGroups.reduce((sum, items) => sum + items.reduce((bytes, item) => bytes + Number(item.bytes ?? 0), 0), 0);
    const reportId = typeof body.reportId === 'string' ? body.reportId : `cleanup_${Date.now().toString(36)}`;
    if (!apply) {
      return { report: { reportId, candidates, generatedAt: now.toISOString(), reclaimableBytes, applied: false }, releasedBytes: 0 };
    }
    let releasedBytes = 0;
    let removedItems = 0;
    const requested = Array.isArray(body.categories) ? body.categories.filter((category): category is string => typeof category === 'string') : Object.keys(candidates);
    const safe = new Set(['expiredTrash', 'missingRecords', 'unreferencedMedia', 'oldBackups']);
    for (const category of requested) {
      if (!safe.has(category)) continue;
      const items = candidates[category];
      if (!items) continue;
      for (const item of items) {
        const id = typeof item.id === 'string' ? item.id : '';
        if (!id) continue;
        try {
          if (category === 'oldBackups') {
            if (!this.options.db.deleteBackup) continue;
            await this.options.db.deleteBackup(id);
            await this.options.db.run('DELETE FROM local_backup_metadata WHERE id=?', [id]);
          } else {
            await this.assertMediaDeletable(id);
            await this.removeMediaFile(id);
            if (await this.mediaRepo.delete(id)) removedItems += 1;
          }
          releasedBytes += Number(item.bytes ?? 0);
        } catch { /* an item may have become referenced between preview and apply */ }
      }
    }
    return {
      report: { reportId, candidates, generatedAt: now.toISOString(), reclaimableBytes, applied: true, removedItems },
      releasedBytes
    };
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
      const message = errorMessage(error);
      await this.mcpRepo.setState(id, 'degraded', message);
      await this.recordError(`mcp.${id}`, message);
      throw error;
    }
    return await this.mcpRepo.getServer(id);
  }

  private async toAdminMedia(row: MediaRow): Promise<Record<string, unknown>> {
    const references = await this.mediaRepo.references(row.id);
    const meta = parseJsonRecord(row.meta_json);
    return {
      id: row.id, kind: row.kind, mime: row.mime, bytes: row.bytes, url: `local-media://${row.id}`, origin: row.origin,
      exists: Boolean(this.media), createdAt: row.created_at, name: typeof meta.name === 'string' ? meta.name : null,
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

type LocalProactiveMode = 'auto' | 'text' | 'text_sticker' | 'voice' | 'image';
interface LocalLifeSettings {
  [key: string]: unknown;
  reachOut: boolean;
  quietGapMinutes: number;
  maxReachOutsPerDay: number;
  silentFrom: number;
  silentTo: number;
  tzOffsetMinutes: number;
  proactiveMode: LocalProactiveMode;
}

function defaultLifeSettings(): LocalLifeSettings {
  return { reachOut: false, quietGapMinutes: 240, maxReachOutsPerDay: 2, silentFrom: 23, silentTo: 8, tzOffsetMinutes: 480, proactiveMode: 'auto' };
}

function normalizeLocalLifeSettings(value: Record<string, unknown>): LocalLifeSettings {
  const defaults = defaultLifeSettings();
  const legacyDisabled = value.proactiveMode === 'disabled';
  const proactiveMode = value.proactiveMode === 'auto' || value.proactiveMode === 'text' || value.proactiveMode === 'text_sticker' || value.proactiveMode === 'voice' || value.proactiveMode === 'image'
    ? value.proactiveMode
    : defaults.proactiveMode;
  const number = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw === 'number' && Number.isFinite(raw) ? Math.max(min, Math.min(max, Math.trunc(raw))) : fallback;
  const savedCap = number(value.maxReachOutsPerDay, defaults.maxReachOutsPerDay, 0, 20);
  return {
    reachOut: value.reachOut === true,
    quietGapMinutes: number(value.quietGapMinutes, defaults.quietGapMinutes, 5, 1440),
    maxReachOutsPerDay: legacyDisabled && savedCap === 0 ? defaults.maxReachOutsPerDay : savedCap,
    silentFrom: number(value.silentFrom, defaults.silentFrom, 0, 23),
    silentTo: number(value.silentTo, defaults.silentTo, 0, 23),
    tzOffsetMinutes: number(value.tzOffsetMinutes, defaults.tzOffsetMinutes, -840, 840),
    proactiveMode
  };
}

function isSilentLifeHour(now: Date, settings: Pick<LocalLifeSettings, 'silentFrom' | 'silentTo' | 'tzOffsetMinutes'>): boolean {
  if (settings.silentFrom === settings.silentTo) return false;
  const shifted = new Date(now.getTime() + settings.tzOffsetMinutes * 60_000);
  const hour = shifted.getUTCHours();
  return settings.silentFrom < settings.silentTo
    ? hour >= settings.silentFrom && hour < settings.silentTo
    : hour >= settings.silentFrom || hour < settings.silentTo;
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

interface StoragePolicy {
  softLimitBytes: number;
  hardLimitBytes: number;
  trashRetentionDays: number;
  tempRetentionHours: number;
  backupKeep: number;
}

function avatarMediaId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (raw.startsWith('local-media://')) return raw.slice('local-media://'.length) || null;
  return raw;
}

function sanitizeMcpUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('MCP Server URL 无效，请填写完整的 http(s) 地址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('MCP Server URL 只支持 http/https');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function toAdminLifeCity(row: { id: string; name: string; region: string | null; country: string | null; time_zone: string; active: number }): Record<string, unknown> {
  return { id: row.id, name: row.name, region: row.region, country: row.country, timeZone: row.time_zone, active: row.active === 1 };
}

function toAdminLifeThread(row: { id: string; title: string; category: string; status: string; progress: number; heat: number; next_actions_json: string; meta_json: string }): Record<string, unknown> {
  return { id: row.id, title: row.title, category: row.category, status: row.status, progress: row.progress, heat: row.heat, next_actions_json: row.next_actions_json, meta_json: row.meta_json };
}

function mediaCandidate(row: { id: string; rel_path: string; bytes: number; origin: string; created_at: string; deleted_at: string | null }): Record<string, unknown> {
  return { id: row.id, path: row.rel_path, relPath: row.rel_path, bytes: row.bytes, origin: row.origin, createdAt: row.created_at, deletedAt: row.deleted_at };
}

function clampStorageBytes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function clampAdminInt(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(value))) : fallback;
}

function clampAdminDays(value: number): number {
  return Math.max(1, Math.min(90, Number.isFinite(value) ? Math.trunc(value) : 7));
}

function adminMetricRange(days: number, now: Date): [string, string] {
  const to = localDateKey(now);
  const from = localDateKey(new Date(now.getTime() - (days - 1) * 86_400_000));
  return [from, to];
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** Everything except the core identity fields and key-handling bookkeeping is
 * persisted as provider options (maxTokens, supportsVision, size, voice, ...),
 * and surfaced back on GET merged over the slot defaults. */
function modelOptionsFrom(raw: Record<string, unknown>): Record<string, unknown> {
  const CORE_KEYS = new Set(['provider', 'model', 'baseUrl', 'apiKey', 'secretRef', 'apiKeyConfigured', 'apiKeyBound', 'options']);
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !CORE_KEYS.has(key)));
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
