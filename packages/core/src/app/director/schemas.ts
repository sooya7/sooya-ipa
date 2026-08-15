import { isRecord } from '../../providers/http-json.js';

/**
 * Pure-TS decoders that mirror the server's Zod schemas exactly (no runtime
 * dependency for the IPA bundle):
 *   voice: text trimmed 1..1000, speed finite → clamp 0.94..1.05, default 1
 *   image: prompt trimmed 10..4000, aspectRatio optional ≤ 20 chars
 */

export interface VoiceDirectorOutput {
  text: string;
  speed: number;
}

export function decodeVoiceDirectorOutput(value: unknown): VoiceDirectorOutput | null {
  if (!isRecord(value)) return null;
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  if (!text || text.length > 1000) return null;
  // Accept a finite provider value and normalize it at the Director boundary;
  // this preserves the safe 0.94–1.05 contract even when a model drifts.
  const speed = typeof value.speed === 'number' && Number.isFinite(value.speed)
    ? Math.min(1.05, Math.max(0.94, value.speed))
    : 1;
  return { text, speed };
}

export interface ImageDirectorOutput {
  prompt: string;
  aspectRatio?: string;
}

export function decodeImageDirectorOutput(value: unknown): ImageDirectorOutput | null {
  if (!isRecord(value)) return null;
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
  if (prompt.length < 10 || prompt.length > 4000) return null;
  const aspectRatio = typeof value.aspectRatio === 'string' ? value.aspectRatio.trim() : '';
  if (!aspectRatio) return { prompt };
  return aspectRatio.length <= 20 ? { prompt, aspectRatio } : { prompt };
}
