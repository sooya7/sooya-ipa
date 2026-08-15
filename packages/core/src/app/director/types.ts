export type DirectorTask = 'sticker' | 'voice' | 'image';

/**
 * Server parity for the Zod schema slot: a decoder returns the validated
 * value or null. Keep decoders pure so they stay trivially testable without
 * adding a runtime dependency to the IPA bundle.
 */
export type DirectorDecoder<T> = (value: unknown) => T | null;

export interface DirectorRunRequest<T> {
  task: DirectorTask;
  system: string;
  input: string;
  decoder: DirectorDecoder<T>;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface DirectorRunResult<T> {
  data: T;
  model: string;
  latencyMs: number;
}

export type DirectorEventName = 'started' | 'completed' | 'failed' | 'fallback';

/**
 * Privacy-safe telemetry surface: only task names, sizes, timing, model and
 * failure classes. The input is untrusted data, so neither prompts nor user
 * text may ride on these events.
 */
export interface DirectorEvent {
  event: DirectorEventName;
  task: DirectorTask;
  latencyMs?: number;
  inputChars?: number;
  outputChars?: number;
  reason?: string;
  model?: string;
}
