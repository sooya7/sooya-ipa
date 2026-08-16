import type { VoiceDeliveryPlan } from './types.js';

/**
 * FishCueRenderer (server parity) — the ONLY producer of Fish S2.x cues in
 * the voice pipeline. Everything upstream (main model, VoiceDirector) is
 * banned from emitting `[cue]`; every cue in a real request comes from this
 * table.
 *
 * - Whitelist only, from the quality doc's published table. Moods without a
 *   doc cue (sad, angry, serious) map to NO cue rather than an invented one.
 * - Continuous intensity (0–1) in three bands: low → no cue; medium → one
 *   light cue with the pace blended toward neutral; high → the full cue.
 *   Restraint first: a plain short voice with zero cues is normal.
 * - The transcript is never touched: cues are prepended to the synthesis text
 *   only, and the visible transcript stays clean.
 * - One cue at most. Banned over-the-top tags are stripped even from the table.
 * - Speed has one fixed priority chain: director → mood → TTS global default
 *   (the caller supplies the last as `fallbackSpeed`).
 */

export interface FishCueSpec {
  /** Fish S2 bracket cue, or null for no cue. */
  cue: string | null;
  /** Resolved prosody.speed (clamped to 0.94–1.05 per the quality spec §5). */
  speed: number;
}

export const FISH_MOOD_TABLE: Record<VoiceDeliveryPlan['primaryEmotion'], FishCueSpec> = {
  neutral: { cue: null, speed: 1.0 },
  // 开心 1.00–1.05.
  happy: { cue: '[warm and relaxed]', speed: 1.02 },
  // 温柔 0.96–0.99.
  gentle: { cue: '[speaking softly]', speed: 0.97 },
  sad: { cue: null, speed: 0.97 },
  angry: { cue: null, speed: 1.0 },
  // 困倦 0.94–0.98.
  sleepy: { cue: '[slightly sleepy]', speed: 0.96 },
  playful: { cue: '[small chuckle]', speed: 1.02 },
  serious: { cue: null, speed: 0.99 }
};

/** Moods the domain enum does not carry yet (alias entries). */
export const FISH_ALIAS_CUE: Record<string, FishCueSpec> = {
  warm: { cue: '[warm and relaxed]', speed: 0.98 },
  tender: { cue: '[speaking softly]', speed: 0.97 },
  curious: { cue: null, speed: 1.0 },
  concerned: { cue: null, speed: 0.97 },
  reassuring: { cue: '[gently reassuring]', speed: 0.97 },
  shy: { cue: '[slightly shy]', speed: 0.98 },
  excited: { cue: '[warm and relaxed]', speed: 1.03 }
};

/** Over-the-top tags banned in Phase 1 (doc §5.1). */
const BANNED_CUE_FRAGMENTS = ['[laughing]', '[sobbing]', '[shouting]', '[screaming]', '[panting]'];

/** Continuous intensity (0–1) → cue strength (convergence spec §7.2). */
export type CueIntensityBand = 'none' | 'light' | 'full';

export function cueIntensityBand(intensity: number): CueIntensityBand {
  if (intensity <= 0.3) return 'none';
  if (intensity <= 0.6) return 'light';
  return 'full';
}

export function fishCueFor(plan: VoiceDeliveryPlan, opts: { intensity?: number; moodAlias?: string; pace?: number; fallbackSpeed?: number } = {}): FishCueSpec {
  const intensity = opts.intensity ?? plan.energy;
  return fishCueForMood(plan.primaryEmotion, {
    intensity,
    moodAlias: opts.moodAlias,
    directorSpeed: opts.pace,
    fallbackSpeed: opts.fallbackSpeed
  });
}

/** Mood-string variant for callers that only carry a raw emotion string. */
export function fishCueForMood(
  mood: string,
  opts: { intensity?: number; moodAlias?: string; directorSpeed?: number; fallbackSpeed?: number } = {}
): FishCueSpec {
  const intensity = opts.intensity ?? 1;
  const alias = opts.moodAlias ? FISH_ALIAS_CUE[opts.moodAlias] : undefined;
  const spec = FISH_MOOD_TABLE[mood as VoiceDeliveryPlan['primaryEmotion']];
  // An explicit alias wins even when it maps to no cue: "no cue > wrong cue".
  const cue = alias ? alias.cue : spec?.cue ?? null;
  const moodSpeed = alias?.speed ?? spec?.speed;
  const band = cueIntensityBand(intensity);
  if (band === 'none' || !cue || BANNED_CUE_FRAGMENTS.some((banned) => cue.includes(banned))) {
    return { cue: null, speed: resolveSpeed(opts.directorSpeed, moodSpeed, opts.fallbackSpeed) };
  }
  // Light cue keeps the mood's cue but blends its pace halfway toward neutral;
  // full cue uses the table pace as-is.
  const speed = band === 'light' ? Math.round((((moodSpeed ?? 1) + 1) / 2) * 100) / 100 : moodSpeed ?? 1;
  return { cue, speed: resolveSpeed(opts.directorSpeed, speed, opts.fallbackSpeed) };
}

/** Render the final Fish synthesis text: an optional cue prefix followed by the
 * clean synthesis text. This function only prefixes, never rewrites. */
export function renderFishSynthesisText(
  synthesisText: string,
  plan: VoiceDeliveryPlan,
  opts: { intensity?: number; moodAlias?: string; pace?: number; fallbackSpeed?: number } = {}
): string {
  const { cue } = fishCueFor(plan, opts);
  return prefixCue(synthesisText, cue);
}

/** Mood-string variant of the renderer. */
export function renderFishSynthesisTextForMood(
  synthesisText: string,
  mood: string,
  opts: { intensity?: number; moodAlias?: string; directorSpeed?: number; fallbackSpeed?: number } = {}
): string {
  const { cue } = fishCueForMood(mood, opts);
  return prefixCue(synthesisText, cue);
}

/** Resolved speed for the Fish request, clamped to the quality spec's 0.94–1.05 range. */
export function fishSpeedFor(plan: VoiceDeliveryPlan, opts: { intensity?: number; moodAlias?: string; pace?: number; fallbackSpeed?: number } = {}): number {
  return fishCueFor(plan, opts).speed;
}

/** Mood-string variant of `fishSpeedFor` for thin transports. */
export function fishSpeedForMood(mood: string, opts: { intensity?: number; moodAlias?: string; directorSpeed?: number; fallbackSpeed?: number } = {}): number {
  return fishCueForMood(mood, opts).speed;
}

function prefixCue(text: string, cue: string | null): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return cue ? `${cue} ${trimmed}` : trimmed;
}

/** Speed priority chain: director → mood → TTS global default, then clamp. */
function resolveSpeed(directorSpeed: number | undefined, moodSpeed: number | undefined, fallbackSpeed: number | undefined): number {
  return clampSpeed(directorSpeed ?? moodSpeed ?? fallbackSpeed ?? 1);
}

function clampSpeed(speed: number): number {
  return Math.min(1.05, Math.max(0.94, Math.round(speed * 100) / 100));
}
