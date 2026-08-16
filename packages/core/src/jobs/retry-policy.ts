import type { DurableTaskType } from './local-task-scheduler.js';

const RETRYABLE_ERRORS = [
  /timed?\s*out/iu,
  /network/iu,
  /econnreset|econnrefused|enetunreach|eai_again/iu,
  /rate[- ]?limit|429|too many requests/iu,
  /5\d\d/,
  /interrupted/iu
];

export function retryDelayMs(attempt: number, type: DurableTaskType): number {
  const base = type === 'weather.refresh' || type === 'sticker.analyze' || type === 'sticker.embed' ? 5_000 : 2_000;
  return Math.min(15 * 60_000, base * 2 ** Math.max(0, Math.min(6, attempt - 1)));
}

export function isRetryableJobError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_ERRORS.some((pattern) => pattern.test(message));
}
