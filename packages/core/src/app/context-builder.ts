import type { LifeRepo, LocationRepo, MessageRepo, MediaRepo, SettingsRepo, StickerRepo, SummaryRepo, SummaryRow, WeatherRepo } from '../db/index.js';
import type { MediaPlatform } from '../platform/media.js';
import type { ChatTurn } from '../providers/types.js';
import type { MemoryProvider, MemoryEntry } from '../memory/types.js';
import type { ChatMessage } from './types.js';
import {
  contextBudgetLimits,
  estimateChatTurnTokens,
  estimateSectionTokens,
  estimateTextTokens
} from './context/budget.js';
import { dedupeLexical, type LexicalDedupeItem } from './context/dedupe.js';
import { DEFAULT_MAX_CONTEXT_IMAGE_BYTES, DEFAULT_MAX_CONTEXT_IMAGES, messageText, messageToModelParts } from './context/multimodal.js';
import { buildTrace, emptyMemoryTrace, memoryTrace } from './context/trace.js';
import type { ContextBuildTrace, ContextBudgetDrops, MemoryRecallTrace, WorldSnapshot } from './context/types.js';

export interface ContextBuilderOptions {
  messages: MessageRepo;
  summaries: SummaryRepo;
  memory: MemoryProvider;
  settings: SettingsRepo;
  /** Legacy world producers; used only until PR C installs `world`. */
  life?: LifeRepo;
  locations?: LocationRepo;
  weather?: WeatherRepo;
  stickers?: StickerRepo;
  /** PR C seam: ContextBuilder consumes only this snapshot for world state. */
  world?: () => Promise<WorldSnapshot>;
  /** Media resolver for message image/sticker pixels. */
  media?: MediaPlatform | null;
  /** media_text lookup for file parts. */
  mediaRepo?: Pick<MediaRepo, 'getExtractedText'> | null;
  /** Independent vision slot capability (falls back to chat at runtime). */
  visionConfigured?: boolean | (() => boolean | Promise<boolean>);
  contextWindowTokens?: number | (() => Promise<number | undefined>);
  maxOutputTokens?: number | (() => Promise<number | undefined>);
  reserveTokens?: number;
  now?: () => Date;
}

export interface ContextBuildInput {
  recent: ChatMessage[];
  latestUser: ChatMessage;
  maxMessages?: number;
  /** Batch membership in reply order; defaults to latestUser.meta.batchId. */
  batchMessageIds?: string[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  reserveTokens?: number;
}

export interface BuiltContext {
  system: string;
  turns: ChatTurn[];
  summaryCount: number;
  memoryCount: number;
  trace: ContextBuildTrace;
}

interface RecentCandidate {
  message: ChatMessage;
  turn: ChatTurn;
  text: string;
  direct: boolean;
}

interface BudgetItem {
  id: string;
  kind: 'batch' | 'persona' | 'recent' | 'world' | 'memory' | 'summary';
  priority: number;
  tokens: number;
  memoryIndex?: number;
  summaryIndex?: number;
}

const MAX_DEFAULT_MESSAGES = 28;
const RECENT_DIRECT_MESSAGES = 8;
const PERSONA_PRIORITY = 1000;
const RECENT_PRIORITY = 600;
const WORLD_PRIORITY = 550;
const MEMORY_PRIORITY = 500;
const SUMMARY_PRIORITY = 450;
const OLDER_RECENT_PRIORITY = 400;

/**
 * Builds the bounded, local-only context sent to a provider. Each source is
 * best-effort: a stale optional subsystem must not prevent a user message
 * from reaching the model.
 */
export class ContextBuilder {
  private readonly now: () => Date;

  constructor(private readonly options: ContextBuilderOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async build(input: ContextBuildInput): Promise<BuiltContext> {
    const limits = contextBudgetLimits({
      contextWindowTokens: await resolveLimit(this.options.contextWindowTokens, input.contextWindowTokens),
      maxOutputTokens: await resolveLimit(this.options.maxOutputTokens, input.maxOutputTokens),
      reserveTokens: input.reserveTokens ?? this.options.reserveTokens
    });
    const drops: ContextBudgetDrops = { recent: 0, summaries: 0, memories: 0, media: 0 };
    const [rawSettings, world, visionConfigured] = await Promise.all([
      this.options.settings.all().catch(() => ({})),
      this.loadWorldSnapshot(),
      resolveBoolean(this.options.visionConfigured, true)
    ]);
    const summaries: SummaryRow[] = await this.options.summaries.active(6).catch(() => []);
    const settings = objectValue(rawSettings);
    const persona = objectValue(settings.persona);
    const assistantName = stringValue(persona.name) ?? stringValue(settings.assistantName) ?? 'SOOYA';
    const personaPrompt = longStringValue(persona.systemPrompt);
    const relationship = stringValue(settings.relationship) ?? stringValue(persona.relationship);
    const tone = stringValue(settings.tone) ?? stringValue(persona.tone);
    const userProfile = objectValue(settings.userProfile);
    const userName = stringValue(userProfile.name) ?? stringValue(settings.userName);
    const personaSection = [
      personaPrompt ?? `你是${assistantName}，运行在用户的 iPhone 本地。`,
      '## 本地运行环境',
      '你当前运行在用户的 iPhone 本地。不要声称访问了不存在的服务器服务；只有真实可用的本地能力、Provider 或工具才能被当作已执行。',
      '除非用户明确要求，不要主动发送消息、推送通知或制造任务。',
      `当前本地时间：${this.now().toISOString()}`,
      relationship ? `你们的关系设定：${relationship}` : '',
      tone ? `表达偏好：${tone}` : '',
      userName ? `用户称呼：${userName}` : ''
    ].filter(Boolean).join('\n\n');

    // 1. The current user batch is merged into one user turn and is always
    // included. latestUser only anchors the batch; it is no longer the whole
    // user input.
    const batchMessages = await this.resolveBatchMessages(input);
    const batchParts: ChatTurn['content'] = [];
    let imageBudget = DEFAULT_MAX_CONTEXT_IMAGES;
    for (const message of batchMessages) {
      const converted = await messageToModelParts(message, this.modelPartsOptions(imageBudget, visionConfigured));
      batchParts.push(...converted.parts);
      imageBudget = Math.max(0, imageBudget - converted.imagesRead);
      drops.media += converted.imagesDropped;
    }
    const batchTurn: ChatTurn = { role: 'user', content: batchParts };
    const batchText = chatPartsText(batchParts) || messageText(batchMessages.at(-1) ?? input.latestUser);

    // 2. Recalled memories use the merged batch text, not latestUser alone.
    const recall = batchText
      ? await this.options.memory.recall({ query: batchText, limit: 8 }).catch(() => undefined)
      : undefined;
    const memoryEntries = recall?.entries ?? [];

    // 3. Non-batch recent turns are converted through the same multimodal
    // path; failed/withdrawn messages are skipped before any media is read.
    const batchIds = new Set(batchMessages.map((message) => message.id));
    const maxMessages = Math.max(1, Math.min(100, Math.trunc(input.maxMessages ?? MAX_DEFAULT_MESSAGES)));
    const recentCandidates: RecentCandidate[] = [];
    const recentMessages = input.recent
      .filter((message) => validMessage(message) && !batchIds.has(message.id))
      .slice(-maxMessages);
    for (const message of recentMessages) {
      const converted = await messageToModelParts(message, this.modelPartsOptions(imageBudget, visionConfigured));
      imageBudget = Math.max(0, imageBudget - converted.imagesRead);
      drops.media += converted.imagesDropped;
      if (converted.parts.length === 0) continue;
      const turn: ChatTurn = { role: message.role === 'system' ? 'system' : message.role, content: converted.parts };
      recentCandidates.push({ message, turn, text: messageText(message), direct: false });
    }
    const directCount = Math.min(RECENT_DIRECT_MESSAGES, recentCandidates.length);
    recentCandidates.forEach((candidate, index) => {
      candidate.direct = index >= recentCandidates.length - directCount;
    });

    // 4. Cross-source lexical dedupe. Batch content never participates and
    // persona core always wins; recent > memory > summary for the rest.
    const dedupeItems: LexicalDedupeItem<{ kind: 'recent' | 'memory' | 'summary'; index: number }>[] = [
      { id: 'persona-core', text: personaSection, priority: PERSONA_PRIORITY, kind: 'persona' },
      ...recentCandidates.flatMap((candidate, index) => candidate.text.trim()
        ? [{ id: `recent:${candidate.message.id}`, text: candidate.text, priority: RECENT_PRIORITY, kind: 'recent' as const, value: { kind: 'recent' as const, index } }]
        : []),
      ...memoryEntries.map((entry, index) => ({ id: `memory:${entry.id}`, text: entry.content, priority: MEMORY_PRIORITY, kind: 'memory' as const, value: { kind: 'memory' as const, index } })),
      ...summaries.map((summary, index) => ({ id: `summary:${summary.id}`, text: summary.content, priority: SUMMARY_PRIORITY, kind: 'summary' as const, value: { kind: 'summary' as const, index } }))
    ];
    const deduped = dedupeLexical(dedupeItems);
    const dedupeDropCounts = { recent: 0, memory: 0, summary: 0 };
    const includedRecentTextIndices = new Set<number>();
    const includedMemoryIndices = new Set<number>();
    const includedSummaryIndices = new Set<number>();
    for (const item of deduped.accepted) {
      if (!item.value) continue;
      if (item.value.kind === 'recent') includedRecentTextIndices.add(item.value.index);
      if (item.value.kind === 'memory') includedMemoryIndices.add(item.value.index);
      if (item.value.kind === 'summary') includedSummaryIndices.add(item.value.index);
    }
    for (const item of deduped.dropped) {
      if (item.kind === 'recent') dedupeDropCounts.recent += 1;
      if (item.kind === 'memory') dedupeDropCounts.memory += 1;
      if (item.kind === 'summary') dedupeDropCounts.summary += 1;
    }

    // Candidates without searchable text (image-only turns) are not lexically
    // deduped and always survive to budget allocation.
    const dedupedRecentIndices = new Set<number>([
      ...recentCandidates.map((candidate, index) => candidate.text.trim() ? [] : [index]).flat(),
      ...includedRecentTextIndices
    ]);
    const dedupedRecent = recentCandidates.filter((_candidate, index) => dedupedRecentIndices.has(index));

    // 5. Token-budget allocation in server priority order. Mandatory batch and
    // persona core are never dropped; everything else is admitted until the
    // remaining provider context budget is exhausted.
    const worldSection = formatWorldSnapshot(world);
    const summaryDisplay = [...summaries].reverse();
    const direct = dedupedRecent.filter((candidate) => candidate.direct);
    const older = dedupedRecent.filter((candidate) => !candidate.direct);
    const dedupedMemory = memoryEntries.filter((_entry, index) => includedMemoryIndices.has(index));
    const dedupedSummaries = summaries.filter((_summary, index) => includedSummaryIndices.has(index));
    const memorySummary = buildMemorySummary(dedupedMemory);
    const summarySummary = buildSummarySummary(dedupedSummaries);
    const budgetItems: BudgetItem[] = [
      { id: 'batch', kind: 'batch', priority: PERSONA_PRIORITY + 100, tokens: estimateChatTurnTokens(batchTurn) },
      { id: 'persona', kind: 'persona', priority: PERSONA_PRIORITY, tokens: estimateTextTokens(personaSection) },
      ...[...direct].reverse().map((candidate) => ({
        id: `recent:${candidate.message.id}`,
        kind: 'recent' as const,
        priority: RECENT_PRIORITY,
        tokens: estimateChatTurnTokens(candidate.turn)
      })),
      ...(worldSection ? [{ id: 'world', kind: 'world' as const, priority: WORLD_PRIORITY, tokens: estimateSectionTokens('', [worldSection]) }] : []),
      ...dedupedMemory.map((entry) => ({
        id: `memory:${entry.id}`,
        kind: 'memory' as const,
        priority: MEMORY_PRIORITY,
        tokens: estimateTextTokens(`- ${entry.content}`) + Math.ceil(memorySummary.headerTokens / Math.max(1, memorySummary.count)),
        memoryIndex: memoryEntries.indexOf(entry)
      })),
      ...dedupedSummaries.map((summary) => ({
        id: `summary:${summary.id}`,
        kind: 'summary' as const,
        priority: SUMMARY_PRIORITY,
        tokens: estimateTextTokens(`- ${summary.content}`) + Math.ceil(summarySummary.headerTokens / Math.max(1, summarySummary.count)),
        summaryIndex: summaries.indexOf(summary)
      })),
      ...[...older].reverse().map((candidate) => ({
        id: `recent:${candidate.message.id}`,
        kind: 'recent' as const,
        priority: OLDER_RECENT_PRIORITY,
        tokens: estimateChatTurnTokens(candidate.turn)
      }))
    ];

    const included = new Set<string>();
    const includedMemory = new Set<number>();
    const includedSummary = new Set<number>();
    let usedTokens = 0;
    for (const item of budgetItems) {
      if (item.kind === 'batch' || item.kind === 'persona') {
        included.add(item.id);
        usedTokens += item.tokens;
        continue;
      }
      if (usedTokens + item.tokens <= limits.budgetTokens) {
        included.add(item.id);
        usedTokens += item.tokens;
        if (item.kind === 'memory' && item.memoryIndex !== undefined) includedMemory.add(item.memoryIndex);
        if (item.kind === 'summary' && item.summaryIndex !== undefined) includedSummary.add(item.summaryIndex);
      } else {
        const dropKind = item.kind === 'memory' ? 'memories' : item.kind === 'summary' ? 'summaries' : item.kind === 'recent' ? 'recent' : undefined;
        if (dropKind) drops[dropKind] += 1;
      }
    }

    // Budget drop counting for dedupe is folded into the final diagnostics;
    // memory keeps the duplicate/budget split in its privacy-safe trace.
    drops.recent += dedupeDropCounts.recent;
    drops.summaries += dedupeDropCounts.summary;
    drops.memories += dedupeDropCounts.memory;
    const acceptedMemory = dedupedMemory.filter((entry) => includedMemory.has(memoryEntries.indexOf(entry)));
    const acceptedSummaries = summaryDisplay.filter((summary) => includedSummary.has(summaries.indexOf(summary)));

    const finalTurns = [
      ...dedupedRecent
        .filter((candidate) => included.has(`recent:${candidate.message.id}`))
        .sort((a, b) => a.message.seq - b.message.seq)
        .map((candidate) => candidate.turn),
      batchTurn
    ];

    const worldIncluded = included.has('world');
    const sections = [
      personaSection,
      worldIncluded && worldSection ? worldSection : '',
      acceptedMemory.length ? memorySummary.header + acceptedMemory.map((entry) => `- ${entry.content}`).join('\n') : '',
      acceptedSummaries.length ? summarySummary.header + acceptedSummaries.map((summary) => `- ${summary.content}`).join('\n') : ''
    ].filter(Boolean);
    const system = sections.join('\n\n');
    const estimatedTokens = estimateTextTokens(system) + finalTurns.reduce((sum, turn) => sum + estimateChatTurnTokens(turn), 0);
    const memoryDroppedBudget = memoryEntries.length - acceptedMemory.length - dedupeDropCounts.memory;
    const traceMemory: MemoryRecallTrace = batchText
      ? memoryTrace({
          queried: true,
          candidates: memoryEntries.length,
          accepted: acceptedMemory.length,
          droppedDuplicate: dedupeDropCounts.memory,
          droppedBudget: Math.max(0, memoryDroppedBudget)
        })
      : emptyMemoryTrace();

    return {
      system,
      turns: finalTurns,
      summaryCount: acceptedSummaries.length,
      memoryCount: acceptedMemory.length,
      trace: buildTrace({
        budget: {
          ...limits,
          estimatedTokens,
          dropped: drops
        },
        memory: traceMemory
      })
    };
  }

  /** Used by diagnostics and tests to prove the context is local and bounded. */
  async countRecentMessages(limit = 28): Promise<number> {
    return (await this.options.messages.recent(Math.max(1, Math.min(100, limit)))).length;
  }

  private modelPartsOptions(maxImages: number, visionConfigured: boolean) {
    return {
      media: this.options.media,
      mediaText: this.options.mediaRepo
        ? (mediaId: string) => this.options.mediaRepo!.getExtractedText(mediaId)
        : undefined,
      stickerByMediaId: this.options.stickers
        ? async (mediaId: string) => {
            const sticker = await this.options.stickers!.getByMediaId(mediaId);
            return sticker ? {
              id: sticker.id,
              name: sticker.name,
              description: sticker.description,
              imageText: sticker.imageText,
              userMeaning: sticker.userMeaning,
              emotion: sticker.emotion
            } : undefined;
          }
        : undefined,
      visionConfigured,
      maxImages,
      maxImageBytes: DEFAULT_MAX_CONTEXT_IMAGE_BYTES
    };
  }

  private async resolveBatchMessages(input: ContextBuildInput): Promise<ChatMessage[]> {
    const requestedIds = input.batchMessageIds?.length
      ? input.batchMessageIds
      : typeof input.latestUser.meta.batchId === 'string' && input.latestUser.meta.batchId
        ? input.recent
            .filter((message) => message.meta.batchId === input.latestUser.meta.batchId)
            .sort((a, b) => a.seq - b.seq)
            .map((message) => message.id)
        : [input.latestUser.id];
    const known = new Map(input.recent.map((message) => [message.id, message]));
    const messages = await Promise.all(requestedIds.map(async (id) => {
      const recent = known.get(id);
      if (recent) return recent;
      return await this.options.messages.get(id).catch(() => undefined);
    }));
    const order = new Map(requestedIds.map((id, index) => [id, index]));
    const valid = messages
      .filter((message): message is ChatMessage => Boolean(message))
      .filter((message) => message.role === 'user' && validMessage(message))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    if (valid.length === 0) return [input.latestUser];
    return valid;
  }

  private async loadWorldSnapshot(): Promise<WorldSnapshot> {
    if (this.options.world) return await this.options.world();
    return await this.legacyWorldSnapshot();
  }

  /** Temporary producer until PR C installs Life V2 + Location Runtime. */
  private async legacyWorldSnapshot(): Promise<WorldSnapshot> {
    const [lifePair, locationState, travel] = await Promise.all([
      this.options.life
        ? Promise.all([this.options.life.current().catch(() => undefined), this.options.life.recent(6).catch(() => [])])
        : Promise.resolve([undefined, []] as const),
      this.options.locations?.currentState().catch(() => undefined) ?? Promise.resolve(undefined),
      this.options.locations?.currentTravel().catch(() => undefined) ?? Promise.resolve(undefined)
    ]);
    const [currentLife, recentLife] = lifePair;
    const location = locationState && this.options.locations
      ? await this.options.locations.get(locationState.location_id).catch(() => undefined)
      : undefined;
    const weather = this.options.weather
      ? await this.options.weather.latest(location?.key ?? 'active').catch(() => undefined)
        ?? (location?.key ? await this.options.weather.latest('active').catch(() => undefined) : undefined)
      : undefined;
    const city = location?.city ? { name: location.city } : null;
    return {
      city: city?.name ? { name: city.name } : null,
      location: location ? { id: location.id, name: location.name, kind: location.kind, city: location.city } : null,
      travel: travel ? {
        fromLocationId: travel.from_location_id,
        toLocationId: travel.to_location_id,
        mode: travel.mode,
        expectedArriveAt: travel.expected_arrive_at
      } : null,
      weather: weather ? {
        condition: weather.condition,
        temperatureC: weather.temperature_c,
        observedAt: weather.observed_at,
        provider: weather.provider
      } : null,
      timeZone: location?.time_zone ?? null,
      life: {
        current: currentLife ? { activity: currentLife.activity, mood: currentLife.mood, kind: currentLife.kind } : null,
        recent: recentLife.map((row) => ({ activity: row.activity, startedAt: row.started_at, endedAt: row.ended_at }))
      }
    };
  }
}

function buildMemorySummary(entries: MemoryEntry[]) {
  const count = entries.length;
  const header = count ? '相关长期记忆（仅作参考）：' : '';
  return { count, header, headerTokens: estimateTextTokens(header) };
}

function buildSummarySummary(summaries: Array<{ content: string }>) {
  const count = summaries.length;
  const header = count ? '对话摘要（按时间由旧到新）：' : '';
  return { count, header, headerTokens: estimateTextTokens(header) };
}

function formatWorldSnapshot(world: WorldSnapshot): string {
  const life = objectValue(world.life);
  const currentLife = objectValue(life.current);
  const recentLife = Array.isArray(life.recent) ? life.recent.map(objectValue) : [];
  const location = objectValue(world.location);
  const city = objectValue(world.city);
  const travel = objectValue(world.travel);
  const weather = objectValue(world.weather);
  const cityName = stringValue(city.name) ?? stringValue(location.city);
  const lines = [
    currentLife.activity
      ? `当前生活状态：${stringValue(currentLife.activity) ?? ''}${currentLife.mood ? `；心情：${stringValue(currentLife.mood) ?? ''}` : ''}`
      : '',
    recentLife.length
      ? `近期生活片段：${recentLife.map((row) => `${stringValue(row.activity) ?? ''}（${stringValue(row.startedAt) ?? stringValue(row.started_at) ?? ''}）`).filter((text) => text.length > 2).join('；')}`
      : '',
    location.name
      ? `当前地点：${stringValue(location.name) ?? ''}${cityName ? `，${cityName}` : ''}`
      : cityName
        ? `当前城市：${cityName}`
        : '',
    travel.fromLocationId || travel.toLocationId
      ? `正在移动：从 ${stringValue(travel.fromLocationId) ?? stringValue(travel.from_location_id) ?? '未知'} 前往 ${stringValue(travel.toLocationId) ?? stringValue(travel.to_location_id) ?? '未知'}，预计 ${stringValue(travel.expectedArriveAt) ?? stringValue(travel.expected_arrive_at) ?? '未知'} 到达`
      : '',
    weather.condition
      ? `当前天气：${stringValue(weather.condition) ?? ''}${weather.temperatureC === null || weather.temperatureC === undefined ? '' : `，${weather.temperatureC}°C`}（观测于 ${stringValue(weather.observedAt) ?? stringValue(weather.observed_at) ?? '未知'}）`
      : '',
    world.timeZone ? `当前时区：${world.timeZone}` : ''
  ].filter(Boolean);
  return lines.join('\n');
}

function validMessage(message: ChatMessage): boolean {
  return message.status !== 'failed' && !message.meta.withdrawnAt;
}

function chatPartsText(parts: ChatTurn['content']): string {
  return parts.map((part) => part.type === 'text' ? part.text : '').filter(Boolean).join('\n').trim();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : undefined;
}

function longStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 64_000) : undefined;
}

async function resolveLimit(
  configured: number | (() => Promise<number | undefined>) | undefined,
  input: number | undefined
): Promise<number | undefined> {
  if (input !== undefined) return input;
  if (typeof configured === 'function') return await configured();
  return configured;
}

async function resolveBoolean(value: boolean | (() => boolean | Promise<boolean>) | undefined, fallback: boolean): Promise<boolean> {
  if (typeof value === 'function') return await value();
  return value ?? fallback;
}
