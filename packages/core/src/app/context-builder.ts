import type { LifeRepo, LocationRepo, MessageRepo, SettingsRepo, StickerRepo, SummaryRepo, WeatherRepo } from '../db/index.js';
import type { ChatTurn } from '../providers/types.js';
import type { MemoryProvider } from '../memory/types.js';
import type { ChatMessage } from './types.js';

export interface ContextBuilderOptions {
  messages: MessageRepo;
  summaries: SummaryRepo;
  memory: MemoryProvider;
  settings: SettingsRepo;
  life: LifeRepo;
  locations: LocationRepo;
  weather: WeatherRepo;
  stickers: StickerRepo;
  now?: () => Date;
}

export interface BuiltContext {
  system: string;
  turns: ChatTurn[];
  summaryCount: number;
  memoryCount: number;
}

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

  async build(input: { recent: ChatMessage[]; latestUser: ChatMessage; maxMessages?: number }): Promise<BuiltContext> {
    const userText = messageText(input.latestUser);
    const [rawSettings, summaries, memories, life, locationState, travel, stickerHints] = await Promise.all([
      this.options.settings.all().catch(() => ({})),
      this.options.summaries.active(6).catch(() => []),
      userText ? this.options.memory.recall({ query: userText, limit: 8 }).then((result) => result.entries).catch(() => []) : Promise.resolve([]),
      Promise.all([this.options.life.current().catch(() => undefined), this.options.life.recent(6).catch(() => [])]),
      this.options.locations.currentState().catch(() => undefined),
      this.options.locations.currentTravel().catch(() => undefined),
      userText ? this.options.stickers.searchFts(userText, { enabledOnly: true, limit: 6 }).catch(() => []) : Promise.resolve([])
    ]);
    const settings = objectValue(rawSettings);

    const location = locationState ? await this.options.locations.get(locationState.location_id).catch(() => undefined) : undefined;
    const weather = await this.options.weather.latest(location?.key ?? 'active').catch(() => undefined)
      ?? (location?.key ? await this.options.weather.latest('active').catch(() => undefined) : undefined);
    const city = await this.options.locations.currentState().catch(() => undefined);
    const cityLocation = city && location ? location.city : null;
    const [currentLife, recentLife] = life;

    const recentMessages = input.recent
      .filter((message) => message.status !== 'failed' && !message.meta.withdrawnAt)
      .map((message) => ({ message, text: messageText(message) }))
      .filter((item) => item.text)
      .slice(-(input.maxMessages ?? 28));
    const turns: ChatTurn[] = recentMessages.map(({ message, text }) => ({
      role: message.role,
      content: [{ type: 'text', text: text.slice(0, 6000) }]
    }));

    const persona = objectValue(settings.persona);
    const assistantName = stringValue(persona.name) ?? stringValue(settings.assistantName) ?? 'SOOYA';
    const relationship = stringValue(settings.relationship) ?? stringValue(persona.relationship);
    const tone = stringValue(settings.tone) ?? stringValue(persona.tone);
    const userProfile = objectValue(settings.userProfile);
    const userName = stringValue(userProfile.name) ?? stringValue(settings.userName);

    const sections = [
      `你是${assistantName}，运行在用户的 iPhone 本地。`,
      '回答自然、简洁、真诚；不要声称自己访问了不存在的服务器服务。',
      '除非用户明确要求，不要主动发送消息、推送通知或制造任务。',
      `当前本地时间：${this.now().toISOString()}`,
      relationship ? `你们的关系设定：${relationship}` : '',
      tone ? `表达偏好：${tone}` : '',
      userName ? `用户称呼：${userName}` : '',
      currentLife ? `当前生活状态：${currentLife.activity}${currentLife.mood ? `；心情：${currentLife.mood}` : ''}` : '',
      recentLife.length ? `近期生活片段：${recentLife.map((row) => `${row.activity}（${row.started_at}）`).join('；')}` : '',
      location ? `当前地点：${location.name}${cityLocation ? `，${cityLocation}` : ''}` : '',
      travel ? `正在移动：从 ${travel.from_location_id} 前往 ${travel.to_location_id}，预计 ${travel.expected_arrive_at} 到达` : '',
      weather ? `当前天气：${weather.condition}${weather.temperature_c === null ? '' : `，${weather.temperature_c}°C`}（观测于 ${weather.observed_at}）` : '',
      summaries.length ? `对话摘要（按时间由旧到新）：\n${[...summaries].reverse().map((row) => `- ${row.content}`).join('\n')}` : '',
      memories.length ? `相关长期记忆（仅作参考）：\n${memories.map((item) => `- ${item.content}`).join('\n')}` : '',
      stickerHints.length ? `与当前话题相关的本地贴纸语义：${stickerHints.map((sticker) => sticker.name).join('、')}。只有用户需要时才使用。` : ''
    ].filter(Boolean);

    return {
      system: sections.join('\n'),
      turns,
      summaryCount: summaries.length,
      memoryCount: memories.length
    };
  }

  /** Used by diagnostics and tests to prove the context is local and bounded. */
  async countRecentMessages(limit = 28): Promise<number> {
    return (await this.options.messages.recent(Math.max(1, Math.min(100, limit)))).length;
  }
}

function messageText(message: ChatMessage): string {
  return message.content.map((part) => part.text ?? part.transcript ?? '').filter(Boolean).join('\n').trim();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : undefined;
}
