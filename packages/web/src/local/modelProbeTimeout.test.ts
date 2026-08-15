import { describe, expect, it } from 'vitest';
import { nativeModelProbeTimeoutLabel, nativeModelProbeTimeoutMs } from './modelProbeTimeout.js';

describe('native model probe timeout', () => {
  it('uses the configured image timeout', () => {
    expect(nativeModelProbeTimeoutMs({ options: { timeoutMs: 600_000 } }, 'image')).toBe(600_000);
  });

  it('uses a longer safe default for image probes without an explicit timeout', () => {
    expect(nativeModelProbeTimeoutMs({ options: {} }, 'image')).toBe(180_000);
    expect(nativeModelProbeTimeoutMs({ options: { timeoutMs: 0 } }, 'image')).toBe(180_000);
  });

  it('keeps non-image probes at 30 seconds even when the provider has a longer timeout', () => {
    expect(nativeModelProbeTimeoutMs({ options: { timeoutMs: 600_000 } }, 'chat')).toBe(30_000);
    expect(nativeModelProbeTimeoutMs({ options: { timeoutMs: 600_000 } }, 'embedding')).toBe(30_000);
  });

  it('formats the actual timeout in the error message', () => {
    expect(nativeModelProbeTimeoutLabel(600_000)).toBe('600 秒');
    expect(nativeModelProbeTimeoutLabel(30_500)).toBe('30500 毫秒');
  });
});
