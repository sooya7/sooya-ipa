import { Capacitor } from '@capacitor/core';
import type { LocalCore } from '@sooya/core/app';
import { LATEST_SCHEMA_VERSION } from '@sooya/core/app';

const NATIVE_BRIDGE_VERSION = 1;
const BRIDGE_CAPABILITIES = ['database.sqlite', 'keychain.secrets', 'http.native', 'mcp.native', 'media.sandbox', 'notifications.local', 'ota.updater'];

interface OtaManifest {
  format: 'sooya-ota/v1';
  releaseId: string;
  createdAt: string;
  bundle: { sha256: string; bytes: number; fileCount: number; zipSha256?: string };
  compatibility: { native: { min: number; max: number }; schema: { min: number; max: number }; bridgeCapabilities: string[] };
  bundleUrl?: string;
  signature?: { algorithm: string; value: string; publicKey?: string };
}

interface UpdaterPlugin {
  notifyAppReady?: () => Promise<void>;
  download?: (input: { url: string; version: string; sessionKey?: string; checksum?: string }) => Promise<{ id: string }>;
  set?: (input: { id: string }) => Promise<void>;
}

/** Integrity-gated OTA coordinator. Swift/native changes are still IPA-only;
 * this class only ever hands a verified web bundle to CapacitorUpdater. */
export class LocalOtaUpdater {
  private readonly plugin: UpdaterPlugin | null;

  constructor(private readonly core: LocalCore) {
    const plugins = (Capacitor as unknown as { Plugins?: Record<string, unknown> }).Plugins ?? {};
    this.plugin = (plugins.CapacitorUpdater as UpdaterPlugin | undefined) ?? null;
  }

  async notifyReady(): Promise<void> {
    await this.plugin?.notifyAppReady?.();
    await this.core.database.run(`UPDATE local_update_state SET pending_web_version=NULL,last_applied_at=?,last_error=NULL,updated_at=? WHERE id=1`, [new Date().toISOString(), new Date().toISOString()]).catch(() => undefined);
  }

  async checkAndApply(manifestUrl: string): Promise<{ checked: boolean; applied: boolean; releaseId?: string; reason?: string }> {
    if (!manifestUrl || !this.plugin?.download || !this.plugin.set) return { checked: false, applied: false, reason: 'updater-unavailable' };
    try {
      const response = await fetch(manifestUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`OTA manifest request failed (${response.status})`);
      const manifest = await response.json() as unknown;
      validateManifest(manifest);
      const value = manifest as OtaManifest;
      await this.core.database.run(`UPDATE local_update_state SET last_checked_at=?,updated_at=?,last_error=NULL WHERE id=1`, [new Date().toISOString(), new Date().toISOString()]);
      const bundleUrl = new URL(value.bundleUrl ?? 'bundle.zip', manifestUrl);
      if (bundleUrl.protocol !== 'https:') throw new Error('OTA bundle URL must use HTTPS');
      const downloaded = await this.plugin.download({
        url: bundleUrl.href,
        version: value.releaseId,
        ...(value.bundle.zipSha256 ? { checksum: value.bundle.zipSha256 } : {})
      });
      if (!downloaded?.id) throw new Error('OTA download returned no bundle id');
      await this.core.database.run(`UPDATE local_update_state SET pending_web_version=?,pending_manifest_json=?,updated_at=? WHERE id=1`, [value.releaseId, JSON.stringify(value), new Date().toISOString()]);
      await this.plugin.set({ id: downloaded.id });
      return { checked: true, applied: true, releaseId: value.releaseId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.core.database.run(`UPDATE local_update_state SET last_error=?,updated_at=? WHERE id=1`, [reason.slice(0, 1000), new Date().toISOString()]).catch(() => undefined);
      return { checked: true, applied: false, reason };
    }
  }
}

export async function startOtaUpdater(core: LocalCore): Promise<LocalOtaUpdater> {
  const updater = new LocalOtaUpdater(core);
  await updater.notifyReady();
  const manifestUrl = await core.configRepo.getPreference('ota.manifestUrl', '');
  if (manifestUrl) void updater.checkAndApply(manifestUrl);
  return updater;
}

function validateManifest(value: unknown): asserts value is OtaManifest {
  if (!isRecord(value) || value.format !== 'sooya-ota/v1' || typeof value.releaseId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,100}$/u.test(value.releaseId)) throw new Error('invalid OTA manifest identity');
  if (!isRecord(value.bundle) || typeof value.bundle.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.bundle.sha256) || typeof value.bundle.bytes !== 'number' || typeof value.bundle.fileCount !== 'number' || (value.bundle.zipSha256 !== undefined && (typeof value.bundle.zipSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.bundle.zipSha256)))) throw new Error('invalid OTA bundle identity');
  if (!isRecord(value.compatibility) || !gate(value.compatibility.native) || !gate(value.compatibility.schema) || !Array.isArray(value.compatibility.bridgeCapabilities)) throw new Error('invalid OTA compatibility gates');
  if (NATIVE_BRIDGE_VERSION < value.compatibility.native.min || NATIVE_BRIDGE_VERSION > value.compatibility.native.max) throw new Error('OTA native version gate rejected');
  if (LATEST_SCHEMA_VERSION < value.compatibility.schema.min || LATEST_SCHEMA_VERSION > value.compatibility.schema.max) throw new Error('OTA schema version gate rejected');
  const missing = value.compatibility.bridgeCapabilities.filter((capability) => !BRIDGE_CAPABILITIES.includes(capability));
  if (missing.length) throw new Error(`OTA bridge capability missing: ${missing.join(', ')}`);
  if (value.signature && value.signature.algorithm !== 'ed25519') throw new Error('unsupported OTA signature algorithm');
}

function gate(value: unknown): value is { min: number; max: number } {
  return isRecord(value) && Number.isSafeInteger(value.min) && Number.isSafeInteger(value.max) && value.min >= 0 && value.max >= value.min;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
