from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"anchor not found: {path}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1))


replace('packages/web/src/App.tsx',
    "const statusLabel = chat.connection === 'online' ? chat.activity.thinking ? chat.activity.label ?? '正在输入' : '在线' : chat.connection === 'connecting' ? '连接中…' : chat.connection === 'unauthorized' ? '需要访问令牌' : '连接已断开，正在重试';",
    "const statusLabel = chat.connection === 'online' ? chat.activity.thinking ? '思考中' : '在线' : chat.connection === 'connecting' ? '连接中…' : chat.connection === 'unauthorized' ? '需要访问令牌' : '连接已断开，正在重试';")
replace('packages/web/src/App.tsx',
    '<ChatHeader persona={persona} connection={chat.connection} statusLabel={statusLabel} life={chat.life} presence={chat.presence} onSearch={() => setHistoryOpen((value) => !value)} />',
    '<ChatHeader persona={persona} connection={chat.connection} statusLabel={statusLabel} presence={chat.presence} onSearch={() => setHistoryOpen((value) => !value)} />')

replace('packages/web/src/components/ChatHeader.tsx',
    "import type { ConnectionState, LifeState, PersonaInfo, WorldPresence } from '../lib/types.js';",
    "import type { ConnectionState, PersonaInfo, WorldPresence } from '../lib/types.js';")
replace('packages/web/src/components/ChatHeader.tsx', '  life: LifeState | null;\n', '')
replace('packages/web/src/components/ChatHeader.tsx',
    'export function ChatHeader({ persona, connection, statusLabel, life, presence, onSearch }: ChatHeaderProps) {',
    'export function ChatHeader({ persona, connection, statusLabel, presence, onSearch }: ChatHeaderProps) {')
replace('packages/web/src/components/ChatHeader.tsx',
    '          {connection === \'online\' && life && <span className="topbar-life" data-testid="life-activity" title={`心情${life.mood}`}>{life.activity}</span>}\n', '')

replace('packages/web/src/components/HeaderWorldPresence.tsx',
    '''      {place && <div className="topbar-world-line" data-testid="world-presence-place"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Z" /><circle cx="12" cy="10" r="2" /></svg><span>{place}</span></div>}
      {weather && <div className={`topbar-world-line topbar-world-weather${stale ? ' is-stale' : ''}`} data-testid="world-presence-weather" title={stale ? '天气数据较旧，正在尝试更新' : undefined}><WeatherIcon condition={presence?.weather?.condition ?? 'cloudy'} /><span>{weather}</span></div>}''',
    '''      <div className="topbar-world-line" data-testid="world-presence-summary">
        {place && <><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Z" /><circle cx="12" cy="10" r="2" /></svg><span>{place}</span></>}
        {place && weather && <span className="topbar-world-separator">·</span>}
        {weather && <><WeatherIcon condition={presence?.weather?.condition ?? 'cloudy'} /><span>{weather}</span></>}
      </div>''')

replace('packages/web/src/components/ChatHeader.css',
    ".chat-topbar .topbar-text { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: 'name name' 'status life'; column-gap: 6px; row-gap: 1px; align-items: center; }",
    ".chat-topbar .topbar-text { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-areas: 'name' 'status'; row-gap: 1px; align-items: center; }")
replace('packages/web/src/components/ChatHeader.css',
    "  .chat-topbar .topbar-life { grid-area: life; max-width: none; min-width: 0; white-space: nowrap; overflow: hidden; overflow-wrap: normal; text-overflow: ellipsis; line-height: 1.25; }\n  .chat-topbar .topbar-life::before { content: '· '; }\n", '')
replace('packages/web/src/components/ChatHeader.css',
    '  .chat-topbar .topbar-world-line { white-space: nowrap; overflow: hidden; min-width: 0; }',
    '  .chat-topbar .topbar-world-line { display: flex; align-items: center; gap: 4px; white-space: nowrap; overflow: hidden; min-width: 0; }')

replace('packages/core/src/app/reply-coordinator.ts',
    '  providerFactory?: () => Promise<ChatProvider | null>;\n',
    '  providerFactory?: () => Promise<ChatProvider | null>;\n  /** Saved chat request limits. Resolved per reply so Admin changes take effect immediately. */\n  requestConfig?: () => Promise<{ maxTokens?: number; temperature?: number }>;\n')
replace('packages/core/src/app/reply-coordinator.ts',
    "      const request: ChatRequest = { system: appendDirectiveProtocol(context.system), messages: context.turns, maxTokens: 2048, temperature: 0.7, signal: controller.signal };",
    "      const savedRequestConfig = await this.options.requestConfig?.().catch(() => undefined);\n      const request: ChatRequest = { system: appendDirectiveProtocol(context.system), messages: context.turns, maxTokens: savedRequestConfig?.maxTokens ?? 2048, temperature: savedRequestConfig?.temperature ?? 0.7, signal: controller.signal };")
replace('packages/core/src/app/local-core.ts',
    "      providerFactory: options.chatProviderFactory ?? (options.http ? async () => (await import('../providers/provider-factory.js')).createConfiguredProviders(options.http!, this.configRepo).then((providers) => providers.chat) : undefined),\n      webSearch:",
    "      providerFactory: options.chatProviderFactory ?? (options.http ? async () => (await import('../providers/provider-factory.js')).createConfiguredProviders(options.http!, this.configRepo).then((providers) => providers.chat) : undefined),\n      requestConfig: async () => {\n        const config = await this.configRepo.getProvider('chat');\n        const maxTokens = config?.options.maxTokens;\n        const temperature = config?.options.temperature;\n        return {\n          ...(typeof maxTokens === 'number' && maxTokens > 0 ? { maxTokens } : {}),\n          ...(typeof temperature === 'number' && Number.isFinite(temperature) ? { temperature } : {})\n        };\n      },\n      webSearch:")

replace('packages/core/src/app/context-builder.ts',
    "      `当前本地时间：${this.now().toISOString()}`,",
    "      `当前本地时间：${formatWorldLocalTime(this.now(), world.timeZone)}`,")
replace('packages/core/src/app/context-builder.ts',
    '''async function resolveLimit(
  configured: number | (() => Promise<number | undefined>) | undefined,''',
    '''function formatWorldLocalTime(value: Date, timeZone: string | null): string {
  if (!timeZone) return value.toISOString();
  try {
    const formatted = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(value);
    return `${formatted} (${timeZone})`;
  } catch {
    return value.toISOString();
  }
}

async function resolveLimit(
  configured: number | (() => Promise<number | undefined>) | undefined,''')

replace('packages/core/src/life/v2/source.ts',
    "    return location?.timeZone ?? 'Asia/Shanghai';",
    "    return location?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';")

replace('packages/core/src/app/local-core.ts',
    '''  private async localLifeSettings(): Promise<LocalLifeSettings> {
    const stored = await this.settingsRepo.get<Record<string, unknown>>('lifeSettings', defaultLifeSettings());
    return normalizeLocalLifeSettings(stored);
  }''',
    '''  private async localLifeSettings(): Promise<LocalLifeSettings> {
    const stored = await this.settingsRepo.get<Record<string, unknown>>('lifeSettings', defaultLifeSettings());
    const settings = normalizeLocalLifeSettings(stored);
    const current = await this.locationRuntime.currentLocation().catch(() => undefined);
    const offset = current?.time_zone ? offsetMinutesForTimeZone(current.time_zone, this.options.now?.() ?? new Date()) : undefined;
    return offset === undefined ? settings : { ...settings, tzOffsetMinutes: offset };
  }''')
replace('packages/core/src/app/local-core.ts',
    '''function defaultLifeSettings(): LocalLifeSettings {
  return { reachOut: false, quietGapMinutes: 240, maxReachOutsPerDay: 2, silentFrom: 23, silentTo: 8, tzOffsetMinutes: 480, proactiveMode: 'auto' };
}''',
    '''function defaultLifeSettings(): LocalLifeSettings {
  return { reachOut: false, quietGapMinutes: 240, maxReachOutsPerDay: 2, silentFrom: 23, silentTo: 8, tzOffsetMinutes: 0, proactiveMode: 'auto' };
}

function offsetMinutesForTimeZone(timeZone: string, at: Date): number | undefined {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at).find((part) => part.type === 'timeZoneName')?.value;
    const match = /^GMT([+-])(\\d{1,2})(?::(\\d{2}))?$/u.exec(name ?? '');
    if (!match) return name === 'GMT' ? 0 : undefined;
    const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
    return match[1] === '-' ? -minutes : minutes;
  } catch {
    return undefined;
  }
}''')

replace('packages/web/src/lib/numberDisplay.ts',
    '  return String(Math.round(value));',
    '  const displayValue = value >= 0 && value <= 1 ? value * 100 : value;\n  return String(Math.round(displayValue));')
replace('packages/web/src/components/life/LifeObservationPanel.tsx',
    '''function vitalDisplay(key: keyof AdminLifeVitals, value: number): VitalDisplay {
  if (key === 'sleep_debt') {''',
    '''function vitalDisplay(key: keyof AdminLifeVitals, value: number): VitalDisplay {
  if (key !== 'sleep_debt' && value >= 0 && value <= 1) value *= 100;
  if (key === 'sleep_debt') {''')
replace('packages/web/src/lib/lifeView.ts',
    ' * 的话，并把时间换算到她所在的时区（她是 UTC+8，浏览器不一定是）。',
    ' * 的话，并把时间换算到她当前生活地点的时区；浏览器所在时区不一定相同。')

replace('packages/web/src/components/AdminPanel.css',
    '.admin-status-chip { display: inline-flex; align-items: center; width: fit-content; margin-top: 7px; padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; }',
    '.admin-status-chip { display: inline-flex; align-items: center; flex: 0 0 auto; width: auto; max-width: 100%; margin-top: 0; padding: 4px 8px; border: 1px solid transparent; border-radius: 7px; font-size: 10px; line-height: 1.2; font-weight: 700; white-space: nowrap; }')
replace('packages/web/src/components/AdminPanel.css',
    '.admin-status-chip.is-ready { color: #146b4d; background: #e3f5ec; }',
    '.admin-status-chip.is-ready { color: #146b4d; background: #e3f5ec; border-color: color-mix(in srgb, #146b4d 18%, transparent); }')
replace('packages/web/src/components/AdminPanel.css',
    '.admin-status-chip.is-warn { color: #8a5a10; background: #fff1d1; }',
    '.admin-status-chip.is-warn { color: #8a5a10; background: #fff1d1; border-color: color-mix(in srgb, #8a5a10 18%, transparent); }')
