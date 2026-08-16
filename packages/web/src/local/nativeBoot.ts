import { Capacitor } from '@capacitor/core';
import { LocalCore, REFERENCE_FRAMINGS, SERVER_REFERENCE_IMAGES, installReplyFeatureRuntime, rollbackBuiltinStickerImport, seedBuiltinStickersOnce, seedServerPersonaOnce } from '@sooya/core/app';
import { createConfiguredProviders, ImagePipelineError } from '@sooya/core/providers';
import type { LocalDatabase, DatabaseValue, DatabaseIntegrityResult, DatabaseBackupResult, RunResult } from '@sooya/core/platform';
import type { SecretsPlatform } from '@sooya/core/platform';
import type { MediaPlatform, MediaRecord, MediaSaveRequest } from '@sooya/core/platform';
import type { HttpPlatform, HttpRequest, HttpResponse, HttpResponseHead } from '@sooya/core/platform';
import type { McpConnectionState, McpPlatform, McpServerConfig, McpTool } from '@sooya/core/platform';
import type { McpToolCallResult } from '@sooya/core/tools';
import { ToolCallRuntime, ToolPolicy, ToolRegistry } from '@sooya/core/tools';
import { migrateDatabase } from '@sooya/core/app';
import { installSooyaClient } from '../lib/sooyaClient.js';
import { LocalSooyaClient } from './LocalSooyaClient.js';
import { NativeLocalCore } from './NativeLocalCore.js';
import { probeNotificationCapabilities } from './notificationCapabilities.js';
import { DEFAULT_OTA_MANIFEST_URL, prepareOtaUpdater, type LocalOtaUpdater, type NativeReleaseInfo } from './otaUpdater.js';
import { BUILTIN_STICKERS, BuiltinStickerMedia, afterAppReady } from './builtinStickers.js';
import { ensureNativeCompanionState } from './nativePresenceBootstrap.js';

interface NativePluginCall { call<T = Record<string, unknown>>(method: string, options: Record<string, unknown>): Promise<T>; }
type TransactionOperation = { type: 'execute' | 'run' | 'query'; sql: string; values?: DatabaseValue[] };
type NativeDatabaseValue = string | number | boolean | null | { type: 'blob'; base64: string } | { type: 'int64'; value: string };
type NativeTransactionStatement = { type: TransactionOperation['type']; sql: string; values: NativeDatabaseValue[] };

export function databaseTransactionCallOptions(operations: TransactionOperation[]): { statements: NativeTransactionStatement[] } {
  return { statements: operations.map((op) => ({ type: op.type, sql: op.sql, values: normalizeValues(op.values ?? []) })) };
}

function nativePlugin(name: string): NativePluginCall {
  const plugins = (Capacitor as unknown as { Plugins: Record<string, unknown> }).Plugins;
  const plugin = plugins[name];
  if (!plugin) throw new Error(`native plugin ${name} is unavailable`);
  return plugin as NativePluginCall;
}

export async function getNativeReleaseInfo(): Promise<NativeReleaseInfo> {
  const value = await nativePlugin('SOOYARelease').call<NativeReleaseInfo>('getReleaseInfo', {});
  if (!Number.isSafeInteger(value.nativeBaseVersion) || !Number.isSafeInteger(value.bridgeVersion) || !Array.isArray(value.capabilities) || typeof value.otaPublicKey !== 'string' || !value.otaPublicKey) throw new Error('native release info is invalid');
  return value;
}

export class CapacitorDatabase implements LocalDatabase {
  private readonly plugin = nativePlugin('SOOYADatabase');
  async open(): Promise<void> { await this.plugin.call('open', {}); }
  async close(): Promise<void> { await this.plugin.call('close', {}); }
  async execute(sql: string): Promise<void> { await this.plugin.call('execute', { sql }); }
  async run(sql: string, values: DatabaseValue[] = []): Promise<RunResult> {
    const result = await this.plugin.call<{ changes?: number; lastInsertRowId?: unknown }>('run', { sql, values: normalizeValues(values) });
    const lastInsertRowid = decodeNativeDatabaseValue(result.lastInsertRowId);
    return { changes: typeof result.changes === 'number' ? result.changes : 0, ...(typeof lastInsertRowid === 'number' || typeof lastInsertRowid === 'bigint' ? { lastInsertRowid } : {}) };
  }
  async query<T = Record<string, unknown>>(sql: string, values: DatabaseValue[] = []): Promise<T[]> {
    const result = await this.plugin.call<{ rows?: unknown[] }>('query', { sql, values: normalizeValues(values) });
    if (!Array.isArray(result.rows)) throw new Error('native database query returned an invalid row envelope');
    return result.rows.map((row) => decodeNativeDatabaseRow<T>(row));
  }
  async transaction<T = unknown[]>(operations: TransactionOperation[]): Promise<T> {
    const result = await this.plugin.call<{ results?: unknown[] }>('transaction', databaseTransactionCallOptions(operations));
    if (!Array.isArray(result.results)) throw new Error('native database transaction returned an invalid result envelope');
    return result.results.map(decodeNativeTransactionResult) as T;
  }
  async integrityCheck(): Promise<DatabaseIntegrityResult> {
    const result = await this.plugin.call<{ ok?: boolean; messages?: unknown[]; foreignKeyViolations?: number }>('integrity', {});
    const count = Number.isSafeInteger(result.foreignKeyViolations) && (result.foreignKeyViolations ?? 0) > 0 ? result.foreignKeyViolations! : 0;
    return { ok: result.ok === true, integrity: Array.isArray(result.messages) ? result.messages.filter((value): value is string => typeof value === 'string') : [], foreignKeys: Array.from({ length: count }, () => ({})) };
  }
  async backup(name: string): Promise<DatabaseBackupResult> { return await this.plugin.call<DatabaseBackupResult>('backup', { name }); }
  async restore(name: string): Promise<void> { await this.plugin.call('restore', { name }); }
  async verifyBackup(name: string): Promise<DatabaseBackupResult> { return await this.plugin.call<DatabaseBackupResult>('verifyBackup', { name }); }
  async deleteBackup(name: string): Promise<boolean> {
    const result = await this.plugin.call<{ deleted?: boolean }>('deleteBackup', { name });
    return result.deleted === true;
  }
}

export class CapacitorSecrets implements SecretsPlatform {
  private readonly plugin = nativePlugin('SOOYASecrets');
  async get(key: string): Promise<string | null> { const result = await this.plugin.call<{ present: boolean }>('has', { key }); return result.present ? '' : null; }
  async set(key: string, value: string): Promise<void> { await this.plugin.call('set', { key, value }); }
  async remove(key: string): Promise<void> { await this.plugin.call('delete', { key }); }
}

export class CapacitorMedia implements MediaPlatform {
  private readonly plugin = nativePlugin('SOOYAMedia');
  async save(request: MediaSaveRequest): Promise<MediaRecord> {
    const bytes = request.data instanceof Uint8Array ? request.data : new Uint8Array(request.data);
    const result = await this.plugin.call<Record<string, unknown>>('save', { kind: request.kind, mimeType: request.mime ?? 'application/octet-stream', name: request.name ?? null, dataBase64: bytesToBase64(bytes) });
    return nativeMediaRecord(result, request.kind, request.name);
  }
  async read(id: string): Promise<{ record: MediaRecord; data: Uint8Array } | null> {
    try {
      const result = await this.plugin.call<{ metadata?: Record<string, unknown>; dataBase64?: string }>('read', { id });
      if (!isRecordValue(result.metadata) || typeof result.dataBase64 !== 'string') throw new Error('native media read returned an invalid payload');
      return { record: nativeMediaRecord(result.metadata), data: base64ToBytes(result.dataBase64) };
    } catch (error) {
      if (error instanceof Error && /media not found/iu.test(error.message)) return null;
      throw error;
    }
  }
  async remove(id: string): Promise<boolean> { return await this.plugin.call<{ deleted?: boolean }>('delete', { id }).then((result) => result.deleted === true); }
}

export class CapacitorHttp implements HttpPlatform {
  private readonly plugin = nativePlugin('SOOYAHttp');
  async request(request: HttpRequest): Promise<HttpResponse> {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('HTTP request aborted');
    const id = `http_${crypto.randomUUID()}`;
    const body = request.body === undefined ? {} : request.body instanceof Uint8Array || request.body instanceof ArrayBuffer
      ? { bodyBase64: bytesToBase64(request.body instanceof Uint8Array ? request.body : new Uint8Array(request.body)) }
      : { bodyText: request.body };
    const options = { id, url: request.url, method: request.method ?? 'GET', headers: request.headers ?? {}, timeoutMs: request.timeoutMs ?? 30_000, ...body, ...(request.secretRef ? { secretRef: request.secretRef, secretHeader: request.secretHeader, secretPrefix: request.secretPrefix } : {}) };
    let settled = false;
    let abortListener: (() => void) | undefined;
    const result = await new Promise<{ status: number; headers: Record<string, string>; dataBase64: string }>((resolve, reject) => {
      const finish = (error?: Error, value?: { status: number; headers: Record<string, string>; dataBase64: string }) => {
        if (settled) return; settled = true; if (abortListener) request.signal?.removeEventListener('abort', abortListener); if (error) reject(error); else resolve(value!);
      };
      abortListener = () => { void this.plugin.call('cancel', { id }).catch(() => undefined); finish(request.signal?.reason instanceof Error ? request.signal.reason : new Error('HTTP request aborted')); };
      request.signal?.addEventListener('abort', abortListener, { once: true });
      this.plugin.call<typeof result>('request', options).then((value) => finish(undefined, value), (error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
    return { status: result.status, headers: result.headers ?? {}, body: base64ToBytes(result.dataBase64) };
  }
  async stream(request: HttpRequest, onChunk: (chunk: Uint8Array) => void): Promise<HttpResponseHead> {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('HTTP stream aborted');
    const streamPlugin = (this.plugin as unknown as { stream?: (options: Record<string, unknown>, callback: (value: unknown, error?: { message?: string }) => void) => unknown }).stream;
    if (!streamPlugin) { const response = await this.request(request); if (response.body.length) onChunk(response.body); return { status: response.status, headers: response.headers }; }
    const id = `http_${crypto.randomUUID()}`;
    const body = request.body === undefined ? {} : request.body instanceof Uint8Array || request.body instanceof ArrayBuffer
      ? { bodyBase64: bytesToBase64(request.body instanceof Uint8Array ? request.body : new Uint8Array(request.body)) }
      : { bodyText: request.body };
    let head: HttpResponseHead | undefined;
    let settled = false;
    let abortListener: (() => void) | undefined;
    const abort = async () => { if (!settled) await this.plugin.call('cancel', { id }).catch(() => undefined); };
    return await new Promise<HttpResponseHead>((resolve, reject) => {
      const finish = (error?: Error) => { if (settled) return; settled = true; if (abortListener) request.signal?.removeEventListener('abort', abortListener); if (error) reject(error); else if (head) resolve(head); else reject(new Error('native HTTP stream returned no headers')); };
      const callback = (value: unknown, error?: { message?: string }) => {
        if (error) { finish(new Error(error.message ?? 'native HTTP stream failed')); return; }
        if (!isRecordValue(value)) return;
        if (value.type === 'headers') head = { status: typeof value.status === 'number' ? value.status : 0, headers: isRecordValue(value.headers) ? value.headers as Record<string, string> : {} };
        else if (value.type === 'chunk' && typeof value.dataBase64 === 'string') onChunk(base64ToBytes(value.dataBase64));
        else if (value.type === 'sse') { const event = typeof value.event === 'string' ? `event: ${value.event}\n` : ''; const data = typeof value.data === 'string' ? value.data.split('\n').map((line) => `data: ${line}\n`).join('') : ''; onChunk(new TextEncoder().encode(`${event}${data}\n`)); }
        else if (value.type === 'complete') finish();
      };
      if (request.signal) { abortListener = () => { void abort(); finish(request.signal?.reason instanceof Error ? request.signal.reason : new Error('HTTP stream aborted')); }; request.signal.addEventListener('abort', abortListener, { once: true }); }
      try { streamPlugin.call(this.plugin, { id, url: request.url, method: request.method ?? 'GET', headers: request.headers ?? {}, timeoutMs: request.timeoutMs ?? 30_000, ...body, ...(request.secretRef ? { secretRef: request.secretRef, secretHeader: request.secretHeader, secretPrefix: request.secretPrefix } : {}) }, callback); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}

export class CapacitorMcp implements McpPlatform {
  private readonly plugin = nativePlugin('SOOYAMcp');
  async connect(config: McpServerConfig): Promise<McpConnectionState> {
    const result = await this.plugin.call<{ serverId: string; mode?: string }>('connect', { serverId: config.id, url: config.url, transport: config.transport, timeoutMs: config.connectTimeoutMs ?? 30_000, authType: config.secretKey ? 'bearer' : 'none', ...(config.secretKey ? { tokenRef: config.secretKey } : {}) });
    return { serverId: result.serverId ?? config.id, state: 'ready', toolCount: 0, detail: result.mode };
  }
  async disconnect(serverId: string): Promise<void> { await this.plugin.call('disconnect', { serverId }); }
  async listTools(serverId: string): Promise<McpTool[]> {
    const result = await this.plugin.call<{ tools: Array<Record<string, unknown>> }>('listTools', { serverId });
    return (result.tools ?? []).flatMap((tool) => typeof tool.name === 'string' ? [{ name: tool.name, description: typeof tool.description === 'string' ? tool.description : undefined, inputSchema: isRecordValue(tool.inputSchema) ? tool.inputSchema : { type: 'object' }, annotations: isRecordValue(tool.annotations) ? tool.annotations : undefined }] : []);
  }
  async callTool(serverId: string, name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult> {
    if (signal?.aborted) throw signal.reason ?? new Error('MCP call aborted');
    return await this.plugin.call<McpToolCallResult>('callTool', { serverId, name, arguments: arguments_ });
  }
  async close(): Promise<void> { /* individual servers are closed separately */ }
}

let nativeOtaUpdater: LocalOtaUpdater | null = null;
let nativeOtaCore: LocalCore | null = null;
let nativeOtaReady: Promise<void> | null = null;
let nativeBuiltinMedia: BuiltinStickerMedia | null = null;

export async function installNativeLocalCore(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  const db = new CapacitorDatabase();
  await db.open();
  await migrateDatabase(db);
  const registry = new ToolRegistry();
  const policy = new ToolPolicy(registry);
  const runtime = new ToolCallRuntime({ registry, policy });
  const nativeMedia = new CapacitorMedia();
  const mediaStore = new BuiltinStickerMedia(nativeMedia);
  const secrets = new CapacitorSecrets();
  const http = new CapacitorHttp();
  nativeBuiltinMedia = mediaStore;
  let runtimeVersion = 'local';
  try {
    const release = await getNativeReleaseInfo();
    runtimeVersion = `${release.nativeBaseVersion}.${release.bridgeVersion}`;
  } catch { /* release plugin is optional for diagnostics */ }
  const core = new NativeLocalCore({ db, secrets, mediaStore, http, mcp: new CapacitorMcp(), toolRegistry: registry, toolPolicy: policy, toolRuntime: runtime, version: runtimeVersion, referenceImages: loadServerReferenceImages });
  await ensureNativeCompanionState(core);
  await seedServerPersonaOnce(core.settingsRepo);
  installReplyFeatureRuntime({
    media: core.media!,
    stickers: core.stickersRepo,
    imageProvider: async () => (await createConfiguredProviders(http, core.configRepo)).image,
    ttsProvider: async () => (await createConfiguredProviders(http, core.configRepo)).tts,
    referenceImages: loadServerReferenceImages
  });
  installSooyaClient(new LocalSooyaClient(core, (id) => mediaStore.assetUrl(id)));
  void probeNotificationCapabilities(core);
  nativeOtaCore = core;
  void wireNativeLifecycle(core).catch((error) => console.warn('Native lifecycle wiring is unavailable', error));
  void core.onAppActive().catch((error) => console.warn('Native initial Life/weather refresh failed', error));
  try { nativeOtaUpdater = await prepareOtaUpdater(core, await getNativeReleaseInfo()); }
  catch (error) { nativeOtaUpdater = null; console.warn('OTA updater is unavailable; LocalCore will continue without OTA', error); }
  return true;
}

export async function notifyNativeAppReady(): Promise<void> {
  if (!nativeOtaCore || !nativeBuiltinMedia) return;
  nativeOtaReady ??= (async () => {
    const updater = nativeOtaUpdater;
    await afterAppReady(
      () => seedBuiltinStickersOnce(nativeOtaCore!.database, 'server-2026-08-14', BUILTIN_STICKERS),
      (ids) => nativeBuiltinMedia!.activate(ids),
      () => updater ? updater.notifyReady() : Promise.resolve(),
      (result) => rollbackBuiltinStickerImport(nativeOtaCore!.database, result)
    );
    window.dispatchEvent(new Event('sooya:stickers-ready'));
    if (!updater) return;
    const manifestUrl = await nativeOtaCore!.configRepo.getPreference('ota.manifestUrl', DEFAULT_OTA_MANIFEST_URL).catch(() => DEFAULT_OTA_MANIFEST_URL);
    if (manifestUrl) void updater.checkAndApply(manifestUrl);
  })();
  await nativeOtaReady;
}

export type NativeReferenceFraming = 'front' | 'full-body' | 'side';
export interface NativeReferenceImage { data: Uint8Array; mime: string; framing: NativeReferenceFraming; }

/**
 * Server-verified framing selection: side/profile wins, then full-body,
 * then front. Chat passes the image prompt as a hint; unknown hints use
 * front so the selfie pipeline always has a safe default.
 */
export function selectReferenceFraming(hint?: string): NativeReferenceFraming {
  const value = (hint ?? '').trim().toLocaleLowerCase();
  if (/(?:侧脸|侧颜|侧面|侧着|侧身|profile|\bside\b)/iu.test(value)) return 'side';
  if (/(?:全身|站立|standing|full\s*body|head\s*to\s*toe)/iu.test(value)) return 'full-body';
  return 'front';
}

async function loadServerReferenceImages(hint?: string): Promise<NativeReferenceImage[]> {
  const images: NativeReferenceImage[] = [];
  const core = nativeOtaCore;
  if (!core) return images;
  // Server parity: select ONE framing from the prompt, read that one image
  // (user upload wins, then bundled asset), then fall back to front. The
  // management page and chat runtime share PersonaReferenceService.
  let slots: Record<NativeReferenceFraming, string | null>;
  try {
    slots = await core.personaReferences.activeSlots();
  } catch (error) {
    throw new ImagePipelineError(
      'reference_read',
      error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
    );
  }
  const preferred = selectReferenceFraming(hint);
  const candidates = preferred === 'front' ? ['front'] as const : [preferred, 'front'] as const;
  for (const framing of candidates) {
    const image = await readReferenceSlot(core, slots, framing);
    if (image) { images.push(image); break; }
  }
  return images;
}

async function readReferenceSlot(
  core: LocalCore,
  slots: Record<NativeReferenceFraming, string | null>,
  framing: NativeReferenceFraming
): Promise<NativeReferenceImage | null> {
  const mediaId = slots[framing] ?? null;
  if (mediaId) {
    const read = await core.media?.read(mediaId).catch(() => null);
    if (read) return { data: read.data, mime: read.record.mime, framing };
  }
  const builtin = SERVER_REFERENCE_IMAGES[REFERENCE_FRAMINGS.indexOf(framing)] ?? null;
  if (!builtin) return null;
  try {
    const response = await fetch(builtin, { cache: 'force-cache' });
    if (!response.ok) return null;
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
    return { data: new Uint8Array(await response.arrayBuffer()), mime, framing };
  } catch { /* a missing optional reference does not break chat */ }
  return null;
}

async function wireNativeLifecycle(core: LocalCore): Promise<void> {
  const [{ App }, { Keyboard }] = await Promise.all([import('@capacitor/app'), import('@capacitor/keyboard')]);
  await App.addListener('appStateChange', ({ isActive }) => { if (isActive) void core.onAppActive(); else void core.onAppInactive(); });
  await Keyboard.addListener('keyboardWillShow', (info) => { document.documentElement.style.setProperty('--sooya-keyboard-height', `${info.keyboardHeight}px`); });
  await Keyboard.addListener('keyboardWillHide', () => { document.documentElement.style.setProperty('--sooya-keyboard-height', '0px'); });
}

function normalizeValues(values: DatabaseValue[]): NativeDatabaseValue[] {
  return values.map((value): NativeDatabaseValue => {
    if (value instanceof Uint8Array) return { type: 'blob', base64: bytesToBase64(value) };
    if (value instanceof ArrayBuffer) return { type: 'blob', base64: bytesToBase64(new Uint8Array(value)) };
    if (typeof value === 'bigint') return { type: 'int64', value: value.toString() };
    return value;
  });
}
function decodeNativeDatabaseValue(value: unknown): unknown {
  if (!isRecordValue(value) || typeof value.type !== 'string') return value;
  if (value.type === 'blob' && typeof value.base64 === 'string') return base64ToBytes(value.base64);
  if (value.type === 'int64' && typeof value.value === 'string' && /^-?\d+$/u.test(value.value)) return BigInt(value.value);
  return value;
}
function decodeNativeDatabaseRow<T>(value: unknown): T {
  if (!isRecordValue(value)) throw new Error('native database query returned a non-object row');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeNativeDatabaseValue(item)])) as T;
}
function decodeNativeTransactionResult(value: unknown): unknown {
  if (!isRecordValue(value)) return value;
  if (Array.isArray(value.rows)) return value.rows.map((row) => decodeNativeDatabaseRow<Record<string, unknown>>(row));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeNativeDatabaseValue(item)]));
}
function nativeMediaRecord(value: Record<string, unknown>, fallbackKind?: MediaRecord['kind'], fallbackName?: string): MediaRecord {
  const id = typeof value.id === 'string' ? value.id : '';
  const mime = typeof value.mimeType === 'string' ? value.mimeType : 'application/octet-stream';
  const bytes = typeof value.bytes === 'number' ? value.bytes : 0;
  if (!id) throw new Error('native media metadata is missing id');
  const rawKind = typeof value.kind === 'string' ? value.kind : undefined;
  const kind: MediaRecord['kind'] = rawKind === 'image' || rawKind === 'audio' || rawKind === 'sticker' || rawKind === 'file' ? rawKind : fallbackKind ?? inferMediaKind(mime);
  const name = typeof value.originalName === 'string' ? value.originalName : fallbackName;
  return { id, kind, mime, bytes, ...(name ? { name } : {}), ...(typeof value.width === 'number' ? { width: value.width } : {}), ...(typeof value.height === 'number' ? { height: value.height } : {}), ...(typeof value.durationSeconds === 'number' ? { durationSec: value.durationSeconds } : {}) };
}
function inferMediaKind(mime: string): MediaRecord['kind'] { if (mime.startsWith('image/')) return 'image'; if (mime.startsWith('audio/')) return 'audio'; return 'file'; }
function bytesToBase64(bytes: Uint8Array): string { let binary = ''; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk)); return btoa(binary); }
function base64ToBytes(base64: string): Uint8Array { const binary = atob(base64); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i); return bytes; }
function isRecordValue(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
