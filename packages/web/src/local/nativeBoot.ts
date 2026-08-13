import { Capacitor } from '@capacitor/core';
import { LocalCore } from '@sooya/core/app';
import type { LocalDatabase, DatabaseValue, DatabaseIntegrityResult, RunResult } from '@sooya/core/platform';
import type { SecretsPlatform } from '@sooya/core/platform';
import type { MediaPlatform, MediaRecord, MediaSaveRequest } from '@sooya/core/platform';
import { installSooyaClient } from '../lib/sooyaClient.js';
import { LocalSooyaClient } from './LocalSooyaClient.js';

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
  async backup(target: string): Promise<void> { await this.plugin.call('backup', { target }); }
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

/** Idempotent native bootstrap. Returns true when LocalCore was installed. */
export async function installNativeLocalCore(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  const db = new CapacitorDatabase();
  await db.open();
  const core = new LocalCore({ db, secrets: new CapacitorSecrets(), mediaStore: new CapacitorMedia() });
  installSooyaClient(new LocalSooyaClient(core));
  void wireNativeLifecycle(core);
  return true;
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
