import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => true) }
}));

vi.mock('../lib/serviceWorkerUpdate.js', () => ({ registerServiceWorkerUpdate: vi.fn() }));

import { Capacitor } from '@capacitor/core';
import { shouldRegisterPwaServiceWorker } from './nativeRuntime.js';

describe('native runtime boundary', () => {
  beforeEach(() => vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true));

  it('never registers the PWA updater inside the native app', () => {
    expect(shouldRegisterPwaServiceWorker(true, true)).toBe(false);
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(shouldRegisterPwaServiceWorker(true, true)).toBe(true);
  });
});
