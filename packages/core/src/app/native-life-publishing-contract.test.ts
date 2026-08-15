import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// This contract also guards the core code shipped inside the signed IPA OTA bundle.
describe('native Life publishing contract', () => {
  it('uses the persisted IPA switch instead of a deployment env hard-disable', () => {
    const source = readFileSync(path.resolve('src/app/local-core.ts'), 'utf8');
    expect(source).toContain('enabledByDeployment: true');
    expect(source).toContain("const settings = normalizeLocalLifeSettings({ ...current, ...body });");
    expect(source).not.toContain("reachOut: false, proactiveMode: 'disabled'");
    expect(source).not.toContain("reason: 'local proactive messaging is disabled'");
  });

  it('gates native Moment composition with the saved cap, gap and silent hours', () => {
    const source = readFileSync(path.resolve('src/app/local-core.ts'), 'utf8');
    expect(source).toContain('private async composeMomentsIfEnabled()');
    expect(source).toContain('dailyCap: settings.maxReachOutsPerDay');
    expect(source).toContain('minGapMs: settings.quietGapMinutes * 60_000');
    expect(source).toContain('isSilentLifeHour(now, settings)');
    expect(source).toContain('await this.composeMomentsIfEnabled().catch(() => undefined);');
  });

  it('migrates the old impossible-to-enable IPA default to a usable local default', () => {
    const source = readFileSync(path.resolve('src/app/local-core.ts'), 'utf8');
    expect(source).toContain('maxReachOutsPerDay: 2');
    expect(source).toContain("proactiveMode: 'auto'");
    expect(source).toContain('legacyDisabled && savedCap === 0 ? defaults.maxReachOutsPerDay : savedCap');
  });
});
