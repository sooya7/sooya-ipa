import type { LocalDatabase } from '../platform/database.js';
import { nowIso, queryOne, safeJson } from './database.js';

export type ProviderCapability = 'chat' | 'embedding' | 'rerank' | 'image' | 'tts' | 'webSearch';

export interface ProviderConfig {
  capability: ProviderCapability;
  provider: string;
  baseUrl: string;
  model: string;
  secretRef: string | null;
  enabled: boolean;
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ProviderConfigRow {
  capability: ProviderCapability;
  provider: string;
  base_url: string;
  model: string;
  secret_ref: string | null;
  enabled: number;
  options_json: string;
  created_at: string;
  updated_at: string;
}

export interface NotificationCapabilityState {
  localSupported: boolean;
  localEnabled: boolean;
  remoteSupported: boolean;
  remoteEnabled: boolean;
  checkedAt: string | null;
  detail: Record<string, unknown>;
}

export class ConfigRepository {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}

  async getProvider(capability: ProviderCapability): Promise<ProviderConfig | null> {
    const row = await queryOne<ProviderConfigRow>(this.db, 'SELECT * FROM provider_configs WHERE capability = ?', [capability]);
    return row ? toProviderConfig(row) : null;
  }

  async listProviders(): Promise<ProviderConfig[]> {
    return (await this.db.query<ProviderConfigRow>('SELECT * FROM provider_configs ORDER BY capability')).map(toProviderConfig);
  }

  async setProvider(input: {
    capability: ProviderCapability;
    provider: string;
    baseUrl: string;
    model: string;
    secretRef?: string | null;
    enabled?: boolean;
    options?: Record<string, unknown>;
  }): Promise<ProviderConfig> {
    const timestamp = nowIso(this.now);
    const existing = await this.getProvider(input.capability);
    await this.db.run(
      `INSERT INTO provider_configs(capability,provider,base_url,model,secret_ref,enabled,options_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(capability) DO UPDATE SET provider=excluded.provider,base_url=excluded.base_url,
       model=excluded.model,secret_ref=excluded.secret_ref,enabled=excluded.enabled,
       options_json=excluded.options_json,updated_at=excluded.updated_at`,
      [input.capability, input.provider.trim(), input.baseUrl.trim(), input.model.trim(), input.secretRef ?? null,
        input.enabled === false ? 0 : 1, JSON.stringify(input.options ?? {}), existing?.createdAt ?? timestamp, timestamp]
    );
    return (await this.getProvider(input.capability))!;
  }

  async removeProvider(capability: ProviderCapability): Promise<void> {
    await this.db.run('DELETE FROM provider_configs WHERE capability = ?', [capability]);
  }

  async getPreference<T>(key: string, fallback: T): Promise<T> {
    const row = await queryOne<{ value_json: string }>(this.db, 'SELECT value_json FROM app_preferences WHERE key = ?', [key]);
    return row ? safeJson(row.value_json, fallback) : fallback;
  }

  async setPreference<T>(key: string, value: T): Promise<void> {
    await this.db.run(
      `INSERT INTO app_preferences(key,value_json,updated_at) VALUES(?,?,?)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
      [key, JSON.stringify(value), nowIso(this.now)]
    );
  }

  async notificationCapabilities(): Promise<NotificationCapabilityState> {
    const row = await queryOne<{
      local_supported: number;
      local_enabled: number;
      remote_supported: number;
      remote_enabled: number;
      checked_at: string | null;
      detail_json: string;
    }>(this.db, 'SELECT * FROM notification_capabilities WHERE id = 1');
    return row ? {
      localSupported: row.local_supported === 1,
      localEnabled: row.local_enabled === 1,
      remoteSupported: row.remote_supported === 1,
      remoteEnabled: row.remote_enabled === 1,
      checkedAt: row.checked_at,
      detail: safeJson(row.detail_json, {})
    } : { localSupported: false, localEnabled: false, remoteSupported: false, remoteEnabled: false, checkedAt: null, detail: {} };
  }

  async setNotificationCapabilities(input: Partial<NotificationCapabilityState>): Promise<NotificationCapabilityState> {
    const current = await this.notificationCapabilities();
    const next = {
      localSupported: input.localSupported ?? current.localSupported,
      localEnabled: input.localEnabled ?? current.localEnabled,
      remoteSupported: input.remoteSupported ?? current.remoteSupported,
      remoteEnabled: input.remoteEnabled ?? current.remoteEnabled,
      checkedAt: input.checkedAt ?? current.checkedAt ?? nowIso(this.now),
      detail: input.detail ?? current.detail
    };
    await this.db.run(
      `UPDATE notification_capabilities SET local_supported=?,local_enabled=?,remote_supported=?,remote_enabled=?,checked_at=?,detail_json=? WHERE id=1`,
      [next.localSupported ? 1 : 0, next.localEnabled ? 1 : 0, next.remoteSupported ? 1 : 0, next.remoteEnabled ? 1 : 0,
        next.checkedAt, JSON.stringify(next.detail)]
    );
    return next;
  }
}

function toProviderConfig(row: ProviderConfigRow): ProviderConfig {
  return {
    capability: row.capability,
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    secretRef: row.secret_ref,
    enabled: row.enabled === 1,
    options: safeJson(row.options_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
