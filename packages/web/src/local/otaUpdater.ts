import { Capacitor } from '@capacitor/core';
import type { LocalCore } from '@sooya/core/app';
import { LATEST_SCHEMA_VERSION } from '@sooya/core/app';

export interface NativeReleaseInfo { nativeBaseVersion: number; bridgeVersion: number; capabilities: string[]; otaPublicKey: string; }

interface OtaManifest {
  format: 'sooya-ota/v1';
  releaseId: string;
  createdAt: string;
  bundle: { sha256: string; bytes: number; fileCount: number; zipSha256?: string };
  compatibility: { native: { min: number; max: number }; schema: { min: number; max: number }; bridgeCapabilities: string[] };
  bundleUrl?: string;
  signature?: { algorithm: string; value: string; publicKey?: string };
}

interface OtaStateRow {
  current_web_version?: string | null;
  pending_web_version?: string | null;
  pending_bundle_id?: string | null;
  pending_manifest_json?: string | null;
  blocked_web_version?: string | null;
}

export const DEFAULT_OTA_MANIFEST_URL = 'https://sooya.icu/ota/stable.json';

interface UpdaterBundleInfo {
  id?: string;
  version?: string;
}

interface UpdaterPlugin {
  notifyAppReady?: () => Promise<void>;
  download?: (input: { url: string; version: string; sessionKey?: string; checksum?: string }) => Promise<{ id: string }>;
  set?: (input: { id: string }) => Promise<void>;
  current?: () => Promise<{ bundle?: UpdaterBundleInfo | null }>;
}

/** Integrity-gated OTA coordinator. Swift/native changes are still IPA-only;
 * this class only ever hands a verified web bundle to CapacitorUpdater. */
export class LocalOtaUpdater {
  private readonly plugin: UpdaterPlugin | null;

  constructor(private readonly core: LocalCore, private readonly releaseInfo: NativeReleaseInfo) {
    const plugins = (Capacitor as unknown as { Plugins?: Record<string, unknown> }).Plugins ?? {};
    this.plugin = (plugins.CapacitorUpdater as UpdaterPlugin | undefined) ?? null;
  }

  async notifyReady(): Promise<void> {
    await this.plugin?.notifyAppReady?.();
    const now = new Date().toISOString();
    // A failed cold-boot set leaves the pending release blocked. Never let the
    // ready callback accidentally promote that release or clear its blacklist.
    await this.core.database.run(`UPDATE local_update_state SET current_web_version=COALESCE(pending_web_version,current_web_version),last_good_web_version=COALESCE(pending_web_version,last_good_web_version),last_good_bundle_id=COALESCE(pending_bundle_id,last_good_bundle_id),pending_web_version=NULL,pending_bundle_id=NULL,pending_manifest_json=NULL,failed_web_version=NULL,blocked_web_version=NULL,last_applied_at=?,last_error=NULL,updated_at=? WHERE id=1 AND blocked_web_version IS NULL`, [now, now]).catch(() => undefined);
  }

  async checkAndDownload(manifestUrl: string): Promise<{ checked: boolean; downloaded: boolean; releaseId?: string; reason?: string }> {
    if (!manifestUrl || !this.plugin?.download) return { checked: false, downloaded: false, reason: 'updater-unavailable' };
    try {
      const response = await fetch(manifestUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`OTA manifest request failed (${response.status})`);
      const manifest = await response.json() as unknown;
      validateManifest(manifest, this.releaseInfo);
      const value = manifest as OtaManifest;
      await verifyManifestSignature(value, this.releaseInfo);
      const state = await this.readState();
      const checkedAt = new Date().toISOString();
      await this.core.database.run(`UPDATE local_update_state SET last_checked_at=?,updated_at=?,last_error=NULL WHERE id=1`, [checkedAt, checkedAt]);
      if (state.blocked_web_version === value.releaseId) return { checked: true, downloaded: false, releaseId: value.releaseId, reason: 'release-blocked' };
      if (state.current_web_version === value.releaseId) return { checked: true, downloaded: false, releaseId: value.releaseId, reason: 'already-current' };
      if (state.pending_web_version === value.releaseId && state.pending_bundle_id) return { checked: true, downloaded: false, releaseId: value.releaseId, reason: 'already-pending' };
      const bundleUrl = new URL(value.bundleUrl ?? 'bundle.zip', manifestUrl);
      if (bundleUrl.protocol !== 'https:') throw new Error('OTA bundle URL must use HTTPS');
      const downloaded = await this.plugin.download({
        url: bundleUrl.href,
        version: value.releaseId,
        ...(value.bundle.zipSha256 ? { checksum: value.bundle.zipSha256 } : {})
      });
      if (!downloaded?.id) throw new Error('OTA download returned no bundle id');
      const now = new Date().toISOString();
      await this.core.database.run(`UPDATE local_update_state SET pending_web_version=?,pending_bundle_id=?,pending_manifest_json=?,last_downloaded_at=?,updated_at=? WHERE id=1`, [value.releaseId, downloaded.id, JSON.stringify(value), now, now]);
      return { checked: true, downloaded: true, releaseId: value.releaseId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.core.database.run(`UPDATE local_update_state SET last_error=?,updated_at=? WHERE id=1`, [reason.slice(0, 1000), new Date().toISOString()]).catch(() => undefined);
      return { checked: true, downloaded: false, reason };
    }
  }

  /** Apply only a bundle persisted by checkAndDownload, during cold boot. */
  async applyPendingOnColdBoot(): Promise<{ applied: boolean; releaseId?: string; reason?: string }> {
    if (!this.plugin?.set) return { applied: false, reason: 'updater-unavailable' };
    const state = await this.readState();
    if (!state.pending_web_version || !state.pending_bundle_id) return { applied: false, reason: 'no-pending-update' };
    if (state.blocked_web_version === state.pending_web_version) return { applied: false, releaseId: state.pending_web_version, reason: 'release-blocked' };

    // CapacitorUpdater.set() immediately destroys the current JS context and
    // reloads the app. On the next boot our SQLite pending marker is still
    // present until notifyReady() runs. Without checking the native active
    // bundle first, every boot calls set() again and creates an infinite reload
    // loop. Treat an already-active pending bundle as successfully switched and
    // let notifyReady() promote/clear the pending row after React mounts.
    const active = await this.plugin.current?.().catch(() => null);
    const activeId = active?.bundle?.id;
    const activeVersion = active?.bundle?.version;
    if (activeId === state.pending_bundle_id || activeVersion === state.pending_web_version) {
      return { applied: false, releaseId: state.pending_web_version, reason: 'already-active' };
    }

    try {
      const manifest = state.pending_manifest_json ? JSON.parse(state.pending_manifest_json) as unknown : null;
      validateManifest(manifest, this.releaseInfo);
      await verifyManifestSignature(manifest, this.releaseInfo);
      // Terminal operation: Capgo reloads immediately, so no code after a
      // successful set() can be relied upon to run in this JavaScript context.
      await this.plugin.set({ id: state.pending_bundle_id });
      return { applied: true, releaseId: state.pending_web_version };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const now = new Date().toISOString();
      await this.core.database.run(`UPDATE local_update_state SET failed_web_version=?,blocked_web_version=?,last_failed_at=?,last_error=?,updated_at=? WHERE id=1`, [state.pending_web_version, state.pending_web_version, now, reason.slice(0, 1000), now]).catch(() => undefined);
      return { applied: false, releaseId: state.pending_web_version, reason };
    }
  }

  /** Compatibility entry point: download is deliberately decoupled from apply. */
  async checkAndApply(manifestUrl: string): Promise<{ checked: boolean; applied: boolean; releaseId?: string; reason?: string }> {
    const result = await this.checkAndDownload(manifestUrl);
    return { checked: result.checked, applied: false, releaseId: result.releaseId, reason: result.downloaded ? 'pending-cold-boot' : result.reason };
  }

  private async readState(): Promise<OtaStateRow> {
    return (await this.core.database.query<OtaStateRow>('SELECT current_web_version,pending_web_version,pending_bundle_id,pending_manifest_json,blocked_web_version FROM local_update_state WHERE id=1'))[0] ?? {};
  }
}

export async function startOtaUpdater(core: LocalCore, releaseInfo: NativeReleaseInfo): Promise<LocalOtaUpdater> {
  const updater = await prepareOtaUpdater(core, releaseInfo);
  await updater.notifyReady();
  const manifestUrl = await core.configRepo.getPreference('ota.manifestUrl', DEFAULT_OTA_MANIFEST_URL);
  if (manifestUrl) void updater.checkAndApply(manifestUrl);
  return updater;
}

/** Prepare a pending bundle before rendering, but only mark it ready after the
 * React shell has mounted. This keeps a bad bundle from being acknowledged as
 * healthy merely because the database/bootstrap phase completed. */
export async function prepareOtaUpdater(core: LocalCore, releaseInfo: NativeReleaseInfo): Promise<LocalOtaUpdater> {
  const updater = new LocalOtaUpdater(core, releaseInfo);
  await updater.applyPendingOnColdBoot();
  return updater;
}

export function validateManifest(value: unknown, releaseInfo: NativeReleaseInfo): asserts value is OtaManifest {
  if (!isRecord(value) || value.format !== 'sooya-ota/v1' || typeof value.releaseId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,100}$/u.test(value.releaseId)) throw new Error('invalid OTA manifest identity');
  if (!isRecord(value.bundle) || typeof value.bundle.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.bundle.sha256) || typeof value.bundle.bytes !== 'number' || typeof value.bundle.fileCount !== 'number' || (value.bundle.zipSha256 !== undefined && (typeof value.bundle.zipSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.bundle.zipSha256)))) throw new Error('invalid OTA bundle identity');
  if (!isRecord(value.compatibility) || !gate(value.compatibility.native) || !gate(value.compatibility.schema) || !Array.isArray(value.compatibility.bridgeCapabilities)) throw new Error('invalid OTA compatibility gates');
  if (releaseInfo.nativeBaseVersion < value.compatibility.native.min || releaseInfo.nativeBaseVersion > value.compatibility.native.max) throw new Error('OTA native version gate rejected');
  if (LATEST_SCHEMA_VERSION < value.compatibility.schema.min || LATEST_SCHEMA_VERSION > value.compatibility.schema.max) throw new Error('OTA schema version gate rejected');
  const missing = value.compatibility.bridgeCapabilities.filter((capability) => !releaseInfo.capabilities.includes(capability));
  if (missing.length) throw new Error(`OTA bridge capability missing: ${missing.join(', ')}`);
  if (!value.signature || value.signature.algorithm !== 'ed25519') throw new Error('OTA signature is required');
}

async function verifyManifestSignature(value: OtaManifest, releaseInfo: NativeReleaseInfo): Promise<void> {
  if (!value.signature) throw new Error('OTA signature is required');
  const rawPublicKey = fromBase64(value.signature.publicKey ?? '');
  const signature = fromBase64(value.signature.value);
  if (rawPublicKey.length !== 32 || signature.length !== 64) throw new Error('invalid OTA Ed25519 key or signature length');
  if (value.signature.publicKey !== releaseInfo.otaPublicKey) throw new Error('OTA Ed25519 public key is not pinned');
  if (!globalThis.crypto?.subtle) throw new Error('OTA Ed25519 verification is unavailable');
  try {
    const key = await globalThis.crypto.subtle.importKey('raw', arrayBuffer(rawPublicKey), { name: 'Ed25519' } as Algorithm, false, ['verify']);
    const valid = await globalThis.crypto.subtle.verify({ name: 'Ed25519' } as Algorithm, key, arrayBuffer(signature), new TextEncoder().encode(signingPayload(value)));
    if (!valid) throw new Error('OTA Ed25519 signature verification failed');
  } catch (error) {
    if (error instanceof Error && /signature verification failed/u.test(error.message)) throw error;
    throw new Error(`OTA Ed25519 signature verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function signingPayload(value: OtaManifest): string {
  return [
    value.format, value.releaseId, value.createdAt, value.bundle.sha256, String(value.bundle.bytes), String(value.bundle.fileCount),
    String(value.compatibility.native.min), String(value.compatibility.native.max), String(value.compatibility.schema.min), String(value.compatibility.schema.max),
    [...value.compatibility.bridgeCapabilities].sort().join(','), value.bundleUrl ?? ''
  ].join('\n');
}

function gate(value: unknown): value is { min: number; max: number } {
  return isRecord(value) && Number.isSafeInteger(value.min) && Number.isSafeInteger(value.max) && value.min >= 0 && value.max >= value.min;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer as ArrayBuffer;
}
