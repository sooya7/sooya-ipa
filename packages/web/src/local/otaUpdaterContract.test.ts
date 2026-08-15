import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LocalOtaUpdater } from './otaUpdater.js';

describe('OTA apply contract', () => {
  it('does not call terminal set() when the pending bundle is already active', async () => {
    const set = vi.fn(async () => undefined);
    const updater = Object.create(LocalOtaUpdater.prototype) as LocalOtaUpdater;
    Object.defineProperties(updater, {
      plugin: {
        value: {
          current: async () => ({ bundle: { id: 'bundle_pending', version: 'ota-pending' } }),
          set
        }
      },
      core: {
        value: {
          database: {
            query: async () => [{
              current_web_version: null,
              pending_web_version: 'ota-pending',
              pending_bundle_id: 'bundle_pending',
              pending_manifest_json: '{}',
              blocked_web_version: null
            }],
            run: vi.fn(async () => ({ changes: 1 }))
          }
        }
      }
    });

    const result = await updater.applyPendingOnColdBoot();

    expect(result).toEqual({ applied: false, releaseId: 'ota-pending', reason: 'already-active' });
    expect(set).not.toHaveBeenCalled();
  });

  it('tracks current_web_version so the stable release is not downloaded on every launch', () => {
    const source = readFileSync(path.resolve('src/local/otaUpdater.ts'), 'utf8');
    expect(source).toContain('SELECT current_web_version,pending_web_version');
    expect(source).toContain("state.current_web_version === value.releaseId");
    expect(source).toContain("reason: 'already-current'");
  });

  it('checks native current bundle before the terminal CapacitorUpdater.set call', () => {
    const source = readFileSync(path.resolve('src/local/otaUpdater.ts'), 'utf8');
    const currentIndex = source.indexOf('this.plugin.current?.()');
    const setIndex = source.indexOf('this.plugin.set({ id: state.pending_bundle_id })');
    expect(currentIndex).toBeGreaterThan(-1);
    expect(setIndex).toBeGreaterThan(currentIndex);
  });

  it('exposes the same guarded apply path for a manual in-app update', () => {
    const source = readFileSync(path.resolve('src/local/otaUpdater.ts'), 'utf8');
    expect(source).toContain('let activeOtaUpdater: LocalOtaUpdater | null = null;');
    expect(source).toContain('export function currentOtaUpdater()');
    expect(source).toContain('async applyPendingNow()');
    expect(source).toContain('return await this.applyPendingNow();');
  });

  it('deduplicates a startup OTA check and a simultaneous manual check', () => {
    const source = readFileSync(path.resolve('src/local/otaUpdater.ts'), 'utf8');
    expect(source).toContain('private checkInFlight: Promise<OtaCheckResult> | null = null;');
    expect(source).toContain('if (this.checkInFlight) return await this.checkInFlight;');
    expect(source).toContain('private async performCheckAndDownload');
  });
});
