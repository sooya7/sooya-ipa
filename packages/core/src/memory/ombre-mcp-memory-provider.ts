import type { McpPlatform, McpServerConfig } from '../platform/mcp.js';
import type { McpToolCallResult } from '../tools/mcp-result.js';
import type { MemoryCommitInput, MemoryCommitResult, MemoryEntry, MemoryKind, MemoryProvider, MemoryRecall, MemoryRecallInput } from './types.js';
import type { OmbreMemorySyncPort } from './sync-types.js';

export type OmbreMemoryOperation = 'recall' | 'list' | 'commit' | 'upsert' | 'update' | 'forget' | 'maintain' | 'sync';
export type OmbreMemoryToolNames = Partial<Record<OmbreMemoryOperation, string>>;

export interface OmbreMcpMemoryProviderOptions {
  mcp: McpPlatform;
  getConfig: () => Promise<McpServerConfig | undefined>;
  serverId?: string;
  toolNames?: OmbreMemoryToolNames;
  timeoutMs?: number;
}

/**
 * Optional memory adapter for an Ombre MCP server. The adapter deliberately
 * discovers tools at runtime: old Ombre deployments use `hold`, while newer
 * deployments may expose `memory.commit`/`memory.sync`.
 */
export class OmbreMcpMemoryProvider implements MemoryProvider, OmbreMemorySyncPort {
  private readonly serverId: string;
  private readonly timeoutMs: number;
  private readonly configuredNames: OmbreMemoryToolNames;
  private availableTools = new Set<string>();
  private connectedConfigKey: string | null = null;

  constructor(private readonly options: OmbreMcpMemoryProviderOptions) {
    this.serverId = options.serverId ?? 'ombre';
    this.timeoutMs = Math.max(250, Math.min(10_000, Math.trunc(options.timeoutMs ?? 1_800)));
    this.configuredNames = options.toolNames ?? {};
  }

  async wake(signal?: AbortSignal): Promise<string | null> {
    await this.ensureReady(signal);
    return this.serverId;
  }

  async recall(input: MemoryRecallInput): Promise<MemoryRecall> {
    const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 20)));
    const result = await this.invoke('recall', { query: input.query, limit }, input.signal);
    return { entries: extractEntries(result).slice(0, limit), strategy: 'remote' };
  }

  async commit(input: MemoryCommitInput): Promise<MemoryCommitResult> {
    const content = input.userText?.trim() || input.assistantText?.trim() || '';
    if (!content) return { state: 'skipped', inserted: 0, merged: 0, reason: 'empty_memory_input' };
    const result = await this.invoke('commit', {
      content,
      text: content,
      userText: input.userText ?? '',
      assistantText: input.assistantText ?? '',
      batchId: input.batchId,
      revision: input.revision,
      tags: 'sooya'
    }, input.signal);
    const value = payloadValue(result);
    return {
      state: 'completed',
      inserted: numberValue(value, 'inserted', 1),
      merged: numberValue(value, 'merged', 0)
    };
  }

  async search(query: string, limit?: number): Promise<MemoryEntry[]> {
    return (await this.recall({ query, limit })).entries;
  }

  async list(options: { limit?: number; offset?: number; kind?: MemoryKind } = {}): Promise<MemoryEntry[]> {
    const result = await this.invoke('list', {
      limit: Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100))),
      offset: Math.max(0, Math.trunc(options.offset ?? 0)),
      ...(options.kind ? { kind: options.kind } : {})
    });
    return extractEntries(result);
  }

  async update(id: string, patch: { content?: string; importance?: number; confidence?: number }): Promise<MemoryEntry | null> {
    const result = await this.invoke('update', { id, memoryId: id, ...patch });
    return extractEntries(result)[0] ?? null;
  }

  async forget(id: string): Promise<boolean> {
    const result = await this.invoke('forget', { id, memoryId: id });
    const value = payloadValue(result);
    return isRecord(value) && typeof value.deleted === 'boolean' ? value.deleted : true;
  }

  async maintain(): Promise<{ removed: number; reembedded: number }> {
    try {
      const result = await this.invoke('maintain', {});
      const value = payloadValue(result);
      return { removed: numberValue(value, 'removed', 0), reembedded: numberValue(value, 'reembedded', 0) };
    } catch (error) {
      if (isMissingToolError(error)) return { removed: 0, reembedded: 0 };
      throw error;
    }
  }

  async health(): Promise<{ state: 'ready' | 'degraded' | 'unavailable'; provider: string; detail?: string }> {
    try {
      await this.ensureReady();
      return { state: 'ready', provider: 'ombre-mcp', detail: `${this.availableTools.size} tools` };
    } catch (error) {
      return { state: 'unavailable', provider: 'ombre-mcp', detail: safeError(error) };
    }
  }

  async upsertEntry(entry: MemoryEntry, signal?: AbortSignal): Promise<MemoryEntry> {
    const arguments_ = {
      id: entry.sourceId ?? entry.id,
      sourceId: entry.sourceId ?? entry.id,
      sourceHash: entry.sourceHash ?? null,
      kind: entry.kind,
      content: entry.content,
      importance: entry.importance,
      confidence: entry.confidence,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    };
    try {
      const result = await this.invoke('upsert', arguments_, signal);
      return extractEntries(result)[0] ?? { ...entry, source: 'ombre', sourceId: arguments_.sourceId };
    } catch (error) {
      if (!isMissingToolError(error)) throw error;
      const result = await this.invoke('commit', { ...arguments_, tags: 'sooya' }, signal);
      return extractEntries(result)[0] ?? { ...entry, source: 'ombre', sourceId: arguments_.sourceId };
    }
  }

  async forgetRemote(id: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.invoke('forget', { id, memoryId: id }, signal);
    const value = payloadValue(result);
    return isRecord(value) && typeof value.deleted === 'boolean' ? value.deleted : true;
  }

  async pullChanges(cursor: string | null, limit = 100, signal?: AbortSignal): Promise<{ entries: MemoryEntry[]; nextCursor: string | null }> {
    let result: McpToolCallResult;
    try {
      result = await this.invoke('sync', { cursor, updatedSince: cursor, limit: Math.max(1, Math.min(500, Math.trunc(limit))) }, signal);
    } catch (error) {
      // Older Ombre schemas have no delta cursor. Catalog is a safe fallback;
      // the local sourceId/sourceHash mapping still prevents duplicate rows.
      if (!isMissingToolError(error)) throw error;
      result = await this.invoke('list', { limit: Math.max(1, Math.min(500, Math.trunc(limit))), ...(cursor ? { cursor } : {}) }, signal);
    }
    const value = payloadValue(result);
    const entries = extractEntries(result);
    const nextCursor = stringValue(value, 'nextCursor') ?? stringValue(value, 'next_cursor') ?? (typeof value === 'object' && value !== null && 'cursor' in value ? stringValue(value, 'cursor') : null);
    return { entries, nextCursor };
  }

  /** Exposed for diagnostics and tests; no credentials are returned. */
  toolNames(): string[] { return [...this.availableTools].sort(); }

  private async invoke(operation: OmbreMemoryOperation, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult> {
    await this.ensureReady(signal);
    const name = this.resolveTool(operation);
    if (!name) throw new Error(`Ombre MCP tool for ${operation} is unavailable`);
    try {
      const result = await callWithTimeout(
        (callSignal) => this.options.mcp.callTool(this.serverId, name, arguments_, callSignal),
        signal,
        this.timeoutMs
      );
      if (result.isError === true) throw new Error(`Ombre MCP ${name} returned an error`);
      return result;
    } catch (error) {
      // Discovery only proves that the connection was alive at that moment.
      // A transport failure must make the next operation rediscover the session.
      await this.invalidateConnection();
      throw error;
    }
  }

  private async invalidateConnection(forceDisconnect = false): Promise<void> {
    const shouldDisconnect = forceDisconnect || this.connectedConfigKey !== null || this.availableTools.size > 0;
    this.availableTools = new Set<string>();
    this.connectedConfigKey = null;
    if (shouldDisconnect) await this.options.mcp.disconnect(this.serverId).catch(() => undefined);
  }

  private async ensureReady(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new Error('Ombre MCP request aborted');
    let connected = false;
    try {
      const config = await this.options.getConfig();
      if (!config || config.enabled === false || !config.url) throw new Error('Ombre MCP is not configured');
      const key = `${config.url}|${config.transport}|${config.secretKey ?? ''}`;
      if (this.connectedConfigKey === key) return;
      await this.invalidateConnection();
      const state = await callWithTimeout(
        (callSignal) => { void callSignal; return this.options.mcp.connect({ ...config, id: this.serverId }); },
        signal,
        Math.max(this.timeoutMs, config.connectTimeoutMs ?? this.timeoutMs)
      );
      if (state.state !== 'ready') throw new Error(state.detail ?? `Ombre MCP connection is ${state.state}`);
      connected = true;
      const tools = await callWithTimeout((callSignal) => this.options.mcp.listTools(this.serverId, callSignal), signal, this.timeoutMs);
      this.availableTools = new Set(tools.map((tool) => tool.name));
      this.connectedConfigKey = key;
    } catch (error) {
      await this.invalidateConnection(connected);
      throw error;
    }
  }

  private resolveTool(operation: OmbreMemoryOperation): string | null {
    const configured = this.configuredNames[operation];
    if (configured && this.availableTools.has(configured)) return configured;
    const aliases: Record<OmbreMemoryOperation, string[]> = {
      recall: ['memory.search', 'memory.recall', 'breath_search', 'search', 'recall'],
      list: ['memory.list', 'memory.catalog', 'breath_catalog', 'catalog', 'breath_advanced', 'list'],
      commit: ['memory.commit', 'commit', 'breath_hold', 'hold'],
      upsert: ['memory.upsert', 'memory.update_or_create', 'upsert'],
      update: ['memory.update', 'update'],
      forget: ['memory.forget', 'breath_release', 'forget', 'release'],
      maintain: ['memory.maintain', 'maintain'],
      sync: ['memory.sync', 'memory.sync.pull', 'memory.delta', 'delta', 'sync']
    };
    return aliases[operation].find((name) => this.availableTools.has(name)) ?? null;
  }
}

function extractEntries(result: McpToolCallResult): MemoryEntry[] {
  const value = payloadValue(result);
  const candidates = Array.isArray(value)
    ? value
    : isRecord(value)
      ? firstArray(value, ['entries', 'memories', 'items', 'results', 'data'])
      : [];
  return candidates.flatMap((item) => toEntry(item));
}

function toEntry(value: unknown): MemoryEntry[] {
  if (!isRecord(value) || typeof value.content !== 'string' || !value.content.trim()) return [];
  const id = stringValue(value, 'id') ?? stringValue(value, 'memoryId') ?? stringValue(value, 'sourceId') ?? stableId(value.content);
  const sourceId = stringValue(value, 'sourceId') ?? stringValue(value, 'source_id') ?? id;
  const importance = normalizedScore(value.importance);
  const confidence = normalizedScore(value.confidence ?? 0.6);
  const createdAt = stringValue(value, 'createdAt') ?? stringValue(value, 'created_at') ?? new Date(0).toISOString();
  const updatedAt = stringValue(value, 'updatedAt') ?? stringValue(value, 'updated_at') ?? createdAt;
  const kind = memoryKind(value.kind);
  const sourceHash = stringValue(value, 'sourceHash') ?? stringValue(value, 'source_hash') ?? undefined;
  const remoteRevision = typeof value.remoteRevision === 'string' || typeof value.remoteRevision === 'number'
    ? value.remoteRevision
    : typeof value.revision === 'string' || typeof value.revision === 'number' ? value.revision : undefined;
  return [{
    id,
    kind,
    content: value.content.trim(),
    normalized: stringValue(value, 'normalized') ?? normalize(value.content),
    importance,
    confidence,
    createdAt,
    updatedAt,
    source: 'ombre',
    sourceId,
    ...(sourceHash ? { sourceHash } : {}),
    ...(remoteRevision !== undefined ? { remoteRevision } : {})
  }];
}

function payloadValue(result: McpToolCallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content ?? []).filter((item): item is { type: 'text'; text: string } => item.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n').trim();
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function firstArray(value: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) if (Array.isArray(value[key])) return value[key] as unknown[];
  return [];
}

function numberValue(value: unknown, key: string, fallback: number): number {
  if (isRecord(value) && typeof value[key] === 'number' && Number.isFinite(value[key])) return value[key] as number;
  return fallback;
}

function stringValue(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === 'string' && value[key] ? value[key] : null;
}

function memoryKind(value: unknown): MemoryKind {
  return value === 'profile' || value === 'preference' || value === 'relationship' || value === 'project' || value === 'event' || value === 'summary' ? value : 'summary';
}

function normalizedScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.6;
  const normalized = value > 1 ? value / 10 : value;
  return Math.max(0, Math.min(1, normalized));
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\u3000,.;:!?，。！？；：、"'()（）]+/gu, '');
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(value)) hash = Math.imul(hash ^ byte, 16777619);
  return `ombre_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingToolError(error: unknown): boolean {
  return error instanceof Error && /tool .* unavailable/iu.test(error.message);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+[^\s]+/giu, 'Bearer [REDACTED_SECRET]').slice(0, 500);
}

async function callWithTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort(parentSignal?.reason ?? new Error('Ombre MCP request aborted'));
  if (parentSignal) {
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener('abort', abort, { once: true });
  }
  timer = setTimeout(() => controller.abort(new Error('Ombre MCP request timed out')), timeoutMs);
  try {
    return await call(controller.signal);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}
