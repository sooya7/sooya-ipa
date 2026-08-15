import type { ModelCapabilitySlot } from '@sooya/core/app';

const DEFAULT_MODEL_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_IMAGE_PROBE_TIMEOUT_MS = 180_000;

type ProbeTimeoutConfig = {
  options?: Record<string, unknown>;
};

/**
 * Keep quick connection probes short, but let real image generation use the
 * timeout configured for the image provider. Image generation often needs far
 * longer than a chat/embedding health probe on-device.
 */
export function nativeModelProbeTimeoutMs(
  configured: ProbeTimeoutConfig,
  capability: ModelCapabilitySlot
): number {
  if (capability !== 'image') return DEFAULT_MODEL_PROBE_TIMEOUT_MS;

  const configuredTimeout = configured.options?.timeoutMs;
  if (typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout) && configuredTimeout > 0) {
    return Math.round(configuredTimeout);
  }

  return DEFAULT_IMAGE_PROBE_TIMEOUT_MS;
}

export function nativeModelProbeTimeoutLabel(timeoutMs: number): string {
  return timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000} 秒` : `${timeoutMs} 毫秒`;
}
