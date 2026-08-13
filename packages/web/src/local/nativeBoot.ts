import { Capacitor } from '@capacitor/core';
import { LocalCore } from '@sooya/core/app';
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
import { probeNotificationCapabilities } from './notificationCapabilities.js';
import { prepareOtaUpdater, type LocalOtaUpdater, type NativeReleaseInfo } from './otaUpdater.js';

/**
 * Native bootstrap: wires the Capacitor Swift plugins into LocalCore and
 * installs it as the active SooyaClient. Browser/PWA never calls this — they
 * keep the remote API adapter.
 */

interface NativePluginCall {
  call<T = Record<string, unknown>>(method: string, options: Record<string, unknown>): Promise<T>;
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

/** LocalDatabase adapter over SOOYADatabasePlugin (Swift + SQLite C API). */
export class CapacitorDatabase implements LocalDatabase {
  private readonly plugin = nativePlugin('SOOYADatabase');

  async open(): Promise<void> { await this.plugin.call('open', {}); }
  async close(): Promise<void> { await this.plugin.call('close', {}); }
  async execute(sql: string): Promise<void> { await this.plugin.call('execute', { sql }); }
  async run(sql: string, values: DatabaseValue[] = []): Promise<RunResult> {
    return await this.plugin.call<RunResult>('run', { sql, values: normalizeValues(values) });
  }
  async query<T = Record<string, unknown>>(sql: string, values: DatabaseValue[] = []): Promise<T[]> {
    return await this.plugin.call<T[]>('query', { sql, values: normalizeValues(values) });
  }
  async transaction<T = unknown[]>(operations: Array<{ type: 'execute' | 'run' | 'query'; sql: string; values?: DatabaseValue[] }>): Promise<T> {
    return await this.plugin.call<T>('transaction', {
      operations: operations.map((op) => ({ ...op, values: normalizeValues(op.values ?? []) }))
    });
  }
  async integrityCheck(): Promise<DatabaseIntegrityResult> {
    return await this.plugin.call<DatabaseIntegrityResult>('integrity', {});
  }
  async backup(name: string): Promise<DatabaseBackupResult> { return await this.plugin.call<DatabaseBackupResult>('backup', { name }); }
  async restore(name: string): Promise<void> { await this.plugin.call('restore', { name }); }
}

/** SecretsPlatform over SOOYASecretsPlugin (Keychain, no raw get for JS). */
export class CapacitorSecrets implements SecretsPlatform {
  private readonly plugin = nativePlugin('SOOYASecrets');

  async get(key: string): Promise<string | null> {
    const result = await this.plugin.call<{ present: boolean }>('has', { key });
    return result.present ? '' : null;
  }
  async set(key: string, value: string): Promise<void> { await this.plugin.call('set', { key, value }); }
  async remove(key: string): Promise<void> { await this.plugin.call('delete', { key }); }
}

/** MediaPlatform over SOOYAMediaPlugin (app-sandbox binary store). */
export class CapacitorMedia implements MediaPlatform {
  private readonly plugin = nativePlugin('SOOYAMedia');

  async save(request: MediaSaveRequest): Promise<MediaRecord> {
    const bytes = request.data instanceof Uint8Array ? request.data : new Uint8Array(request.data);
    const result = await this.plugin.call<{ id: string; kind: MediaRecord['kind']; mime: string; bytes: number; sha256?: string }>('save', {
      kind: request.kind,
      mime: request.mime ?? 'application/octet-stream',
      name: request.name ?? null,
      dataBase64: bytesToBase64(bytes)
    });
    return { id: result.id, kind: result.kind, mime: result.mime, bytes: result.bytes, name: request.name };
  }
  async read(id: string): Promise<{ record: MediaRecord; data: Uint8Array } | null> {
    const result = await this.plugin.call<{ record: MediaRecord; dataBase64: string } | null>('read', { id });
    if (!result) return null;
    return { record: result.record, data: base64ToBytes(result.dataBase64) };
  }
  async remove(id: string): Promise<boolean> {
    return await this.plugin.call<{ removed: boolean }>('delete', { id }).then((r) => r.removed);
  }
}

/** Native HTTP adapter. Secret references are forwarded as opaque names; the
 * Swift bridge resolves the value from Keychain immediately before sending. */
export class CapacitorHttp implements HttpPlatform {
  private readonly plugin = nativePlugin('SOOYAHttp');

  async request(request: HttpRequest): Promise<HttpResponse> {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('HTTP request aborted');
    const id = `http_${crypto.randomUUID()}`;
    const body = request.body === undefined ? {} : request.body instanceof Uint8Array || request.body instanceof ArrayBuffer
      ? { bodyBase64: bytesToBase64(request.body instanceof Uint8Array ? request.body : new Uint8Array(request.body)) }
      : { bodyText: request.body };
    const options = {
      id, url: request.url, method: request.method ?? 'GET', headers: request.headers ?? {}, timeoutMs: request.timeoutMs ?? 30_000,
      ...body,
      ...(request.secretRef ? { secretRef: request.secretRef, secretHeader: request.secretHeader, secretPrefix: request.secretPrefix } : {})
    };
    let settled = false;
    let abortListener: (() => void) | undefined;
    const result = await new Promise<{ status: number; headers: Record<string, string>; dataBase64: string }>((resolve, reject) => {
      const finish = (error?: Error, value?: { status: number; headers: Record<string, string>; dataBase64: string }) => {
        if (settled) return;
        settled = true;
        if (abortListener) request.signal?.removeEventListener('abort', abortListener);
        if (error) reject(error); else resolve(value!);
      };
      abortListener = () => {
        void this.plugin.call('cancel', { id }).catch(() => undefined);
        finish(request.signal?.reason instanceof Error ? request.signal.reason : new Error('HTTP request aborted'));
      };
      request.signal?.addEventListener('abort', abortListener, { once: true });
      this.plugin.call<typeof result>('request', options).then((value) => finish(undefined, value), (error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
    return { status: result.status, headers: result.headers ?? {}, body: base64ToBytes(result.dataBase64) };
  }

  async stream(request: HttpRequest, onChunk: (chunk: Uint8Array) => void): Promise<HttpResponseHead> {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('HTTP stream aborted');
    const streamPlugin = (this.plugin as unknown as { stream?: (options: Record<string, unknown>, callback: (value: unknown, error?: { message?: string }) => void) => unknown }).stream;
    if (!streamPlugin) {
      const response = await this.request(request);
      if (response.body.length) onChunk(response.body);
      return { status: response.status, headers: response.headers };
    }
    const id = `http_${crypto.randomUUID()}`;
    const body = request.body === undefined ? {} : request.body instanceof Uint8Array || request.body instanceof ArrayBuffer
      ? { bodyBase64: bytesToBase64(request.body instanceof Uint8Array ? request.body : new Uint8Array(request.body)) }
      : { bodyText: request.body };
    let head: HttpResponseHead | undefined;
    let settled = false;
    let abortListener: (() => void) | undefined;
    const abort = async () => {
      if (settled) return;
      await this.plugin.call('cancel', { id }).catch(() => undefined);
    };
    const promise = new Promise<HttpResponseHead>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (abortListener) request.signal?.removeEventListener('abort', abortListener);
        if (error) reject(error); else if (head) resolve(head); else reject(new Error('native HTTP stream returned no headers'));
      };
      const callback = (value: unknown, error?: { message?: string }) => {
        if (error) { finish(new Error(error.message ?? 'native HTTP stream failed')); return; }
        if (!isRecordValue(value)) return;
        if (value.type === 'headers') {
          head = { status: typeof value.status === 'number' ? value.status : 0, headers: isRecordValue(value.headers) ? value.headers as Record<string, string> : {} };
        } else if (value.type === 'chunk' && typeof value.dataBase64 === 'string') {
          onChunk(base64ToBytes(value.dataBase64));
        } else if (value.type === 'sse') {
          const event = typeof value.event === 'string' ? `event: ${value.event}\n` : '';
          const data = typeof value.data === 'string' ? value.data.split('\n').map((line) => `data: ${line}\n`).join('') : '';
          onChunk(new TextEncoder().encode(`${event}${data}\n`));
        } else if (value.type === 'complete') finish();
      };
      if (request.signal) {
        abortListener = () => { void abort(); finish(request.signal?.reason instanceof Error ? request.signal.reason : new Error('HTTP stream aborted')); };
        request.signal.addEventListener('abort', abortListener, { once: true });
      }
      try {
        streamPlugin.call(this.plugin, {
          id, url: request.url, method: request.method ?? 'GET', headers: request.headers ?? {}, timeoutMs: request.timeoutMs ?? 30_000,
          ...body,
          ...(request.secretRef ? { secretRef: request.secretRef, secretHeader: request.secretHeader, secretPrefix: request.secretPrefix } : {})
        }, callback);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    return await promise;
  }
}

export class CapacitorMcp implements McpPlatform {
  private readonly plugin = nativePlugin('SOOYAMcp');

  async connect(config: McpServerConfig): Promise<McpConnectionState> {
    const result = await this.plugin.call<{ serverId: string; mode?: string }>('connect', {
      serverId: config.id, url: config.url, transport: config.transport, timeoutMs: config.connectTimeoutMs ?? 30_000,
      authType: config.secretKey ? 'bearer' : 'none', ...(config.secretKey ? { tokenRef: config.secretKey } : {})
    });
    return { serverId: result.serverId ?? config.id, state: 'ready', toolCount: 0, detail: result.mode };
  }

  async disconnect(serverId: string): Promise<void> { await this.plugin.call('disconnect', { serverId }); }

  async listTools(serverId: string): Promise<McpTool[]> {
    const result = await this.plugin.call<{ tools: Array<Record<string, unknown>> }>('listTools', { serverId });
    return (result.tools ?? []).flatMap((tool) => typeof tool.name === 'string' ? [{ name: tool.name, description: typeof tool.description === 'string' ? tool.description : undefined, inputSchema: isRecordValue(tool.inputSchema) ? tool.inputSchema : { type: 'object' }, annotations: isRecordValue(tool.annotations) ? tool.annotations : undefined }] : []);
  }

  async callTool(serverId: string, name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult> {
    if (signal?.aborted) throw signal.reason ?? new Error('MCP call aborted');
    const result = await this.plugin.call<McpToolCallResult>('callTool', { serverId, name, arguments: arguments_ });
    return result;
  }

  async close(): Promise<void> { /* Individual servers are closed by admin/remove or app teardown. */ }
}

let nativeOtaUpdater: LocalOtaUpdater | null = null;
let nativeOtaCore: LocalCore | null = null;
let nativeOtaReady: Promise<void> | null = null;

/** Idempotent native bootstrap. Returns true when LocalCore was installed. */
export async function installNativeLocalCore(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  const db = new CapacitorDatabase();
  await db.open();
  await migrateDatabase(db);
  const registry = new ToolRegistry();
  const policy = new ToolPolicy(registry);
  const runtime = new ToolCallRuntime({ registry, policy });
  const core = new LocalCore({ db, secrets: new CapacitorSecrets(), mediaStore: new CapacitorMedia(), http: new CapacitorHttp(), mcp: new CapacitorMcp(), toolRegistry: registry, toolPolicy: policy, toolRuntime: runtime });
  installSooyaClient(new LocalSooyaClient(core));
  void probeNotificationCapabilities(core);
  nativeOtaCore = core;
  nativeOtaUpdater = await prepareOtaUpdater(core, await getNativeReleaseInfo());
  void wireNativeLifecycle(core);
  return true;
}

/** Called by the mounted React shell; safe to call repeatedly under StrictMode. */
export async function notifyNativeAppReady(): Promise<void> {
  if (!nativeOtaUpdater || !nativeOtaCore) return;
  nativeOtaReady ??= (async () => {
    const updater = nativeOtaUpdater!;
    await updater.notifyReady();
    const manifestUrl = await nativeOtaCore!.configRepo.getPreference('ota.manifestUrl', '').catch(() => '');
    if (manifestUrl) void updater.checkAndApply(manifestUrl);
  })();
  await nativeOtaReady;
}

/**
 * Native lifecycle wiring: app-state transitions drive LocalCore foreground/
 * background handling; keyboard insets are published as the CSS variable the
 * stylesheet consumes. All imports are lazy — browsers never execute this.
 */
async function wireNativeLifecycle(core: LocalCore): Promise<void> {
  const [{ App }, { Keyboard }] = await Promise.all([
    import('@capacitor/app'),
    import('@capacitor/keyboard')
  ]);
  await App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) void core.onAppActive();
    else void core.onAppInactive();
  });
  await Keyboard.addListener('keyboardWillShow', (info) => {
    document.documentElement.style.setProperty('--sooya-keyboard-height', `${info.keyboardHeight}px`);
  });
  await Keyboard.addListener('keyboardWillHide', () => {
    document.documentElement.style.setProperty('--sooya-keyboard-height', '0px');
  });
}

function normalizeValues(values: DatabaseValue[]): DatabaseValue[] {
  return values.map((value) => (value instanceof Uint8Array ? value : value));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
