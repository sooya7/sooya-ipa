import type { LifeActivityDefinition } from './types.js';
import type { LifeVitals } from './types.js';

export const DEFAULT_LIFE_VITALS: Omit<LifeVitals, 'updatedAt'> = {
  energy: 0.75,
  hunger: 0.25,
  stress: 0.2,
  socialNeed: 0.35,
  loneliness: 0.3,
  curiosity: 0.5,
  comfort: 0.6,
  focus: 0.7,
  sleepDebt: 0.1,
  moodTendency: 0.15,
  restPressure: 0.2
};

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Elapsed-time settlement. Pure and idempotent: calling it with a target that
 * is not after `previous.updatedAt` returns the previous value unchanged, so
 * the same clock boundary can be replayed without double decay.
 */
export function settleVitals(
  previous: LifeVitals,
  toMs: number,
  context: { currentKind?: string; now?: string } = {}
): LifeVitals {
  const toIso = context.now ?? new Date(toMs).toISOString();
  if (toMs <= Date.parse(previous.updatedAt)) return previous;
  const elapsedHours = Math.max(0, Math.min(30 * 24, (toMs - Date.parse(previous.updatedAt)) / 3_600_000));
  const sleeping = context.currentKind === 'sleep';
  const resting = sleeping || context.currentKind === 'rest';
  const activeDrain = sleeping ? 0 : resting ? 0.35 : 1;

  return {
    ...previous,
    energy: clamp01(previous.energy + (resting ? 0.09 : -0.045) * elapsedHours),
    hunger: clamp01(previous.hunger + 0.065 * elapsedHours),
    stress: clamp01(previous.stress - 0.022 * elapsedHours),
    socialNeed: clamp01(previous.socialNeed + 0.032 * elapsedHours),
    loneliness: clamp01(previous.loneliness + (sleeping ? -0.015 : 0.024) * elapsedHours),
    curiosity: clamp01(previous.curiosity - 0.012 * elapsedHours),
    comfort: clamp01(previous.comfort + (resting ? 0.015 : -0.01) * elapsedHours),
    focus: clamp01(previous.focus + (resting ? 0.075 : -0.035 * activeDrain) * elapsedHours),
    sleepDebt: clamp01(previous.sleepDebt + (sleeping ? -0.055 : 0.018) * elapsedHours),
    moodTendency: clamp01(previous.moodTendency * (1 - 0.02 * elapsedHours)),
    restPressure: clamp01(previous.restPressure + (resting ? -0.14 : 0.05) * elapsedHours),
    updatedAt: toIso
  };
}

/** Applies one completed activity on top of elapsed settlement. */
export function applyActivityToVitals(previous: LifeVitals, activity: LifeActivityDefinition, durationMs: number): LifeVitals {
  const hours = Math.max(0, Math.min(12, durationMs / 3_600_000));
  const byKind: Record<string, Partial<Omit<LifeVitals, 'updatedAt'>>> = {
    sleep: { energy: 0.22 * hours, restPressure: -0.3 * hours, sleepDebt: -0.28 * hours, focus: 0.15 * hours, stress: -0.08 * hours },
    meal: { hunger: -0.55, energy: 0.12 * hours, comfort: 0.08 * hours },
    work: { focus: -0.16 * hours, energy: -0.1 * hours, restPressure: 0.14 * hours, stress: 0.05 * hours },
    study: { focus: -0.12 * hours, energy: -0.08 * hours, restPressure: 0.1 * hours, curiosity: 0.08 * hours },
    walk: { socialNeed: -0.08 * hours, loneliness: -0.08 * hours, energy: -0.07 * hours, restPressure: 0.08 * hours },
    rest: { energy: 0.14 * hours, restPressure: -0.22 * hours, focus: 0.1 * hours, stress: -0.05 * hours },
    chore: { energy: -0.09 * hours, restPressure: 0.08 * hours, comfort: 0.06 * hours },
    social: { socialNeed: -0.5, loneliness: -0.45, energy: -0.06 * hours, moodTendency: 0.15 },
    play: { socialNeed: -0.25, loneliness: -0.25, energy: -0.08 * hours, restPressure: 0.06 * hours, moodTendency: 0.2 },
    transit: { energy: -0.04 * hours, restPressure: 0.04 * hours }
  };
  const patch = byKind[activity.kind] ?? {};
  const next = { ...previous } as LifeVitals;
  for (const [key, rawDelta] of Object.entries(patch)) {
    const delta = rawDelta;
    if (delta === undefined) continue;
    const target = (next as unknown as Record<string, number>)[key];
    if (typeof target === 'number') (next as unknown as Record<string, number>)[key] = clamp01(target + delta);
  }
  return next;
}

export function vitalsToRow(vitals: LifeVitals): {
  energy: number;
  hunger: number;
  stress: number;
  social_need: number;
  loneliness: number;
  curiosity: number;
  comfort: number;
  focus: number;
  sleep_debt: number;
  updated_at?: string;
  meta_json: string;
} {
  return {
    energy: vitals.energy,
    hunger: vitals.hunger,
    stress: vitals.stress,
    social_need: vitals.socialNeed,
    loneliness: vitals.loneliness,
    curiosity: vitals.curiosity,
    comfort: vitals.comfort,
    focus: vitals.focus,
    sleep_debt: vitals.sleepDebt,
    updated_at: vitals.updatedAt,
    meta_json: JSON.stringify({ moodTendency: vitals.moodTendency, restPressure: vitals.restPressure })
  };
}

export function vitalsFromRow(row: {
  energy: number;
  hunger: number;
  stress: number;
  social_need: number;
  loneliness: number;
  curiosity: number;
  comfort: number;
  focus: number;
  sleep_debt: number;
  updated_at: string;
  meta_json: string;
}): LifeVitals {
  const meta = safeJson(row.meta_json);
  return {
    energy: row.energy,
    hunger: row.hunger,
    stress: row.stress,
    socialNeed: row.social_need,
    loneliness: row.loneliness,
    curiosity: row.curiosity,
    comfort: row.comfort,
    focus: row.focus,
    sleepDebt: row.sleep_debt,
    moodTendency: numberMeta(meta.moodTendency, DEFAULT_LIFE_VITALS.moodTendency),
    restPressure: numberMeta(meta.restPressure, DEFAULT_LIFE_VITALS.restPressure),
    updatedAt: row.updated_at
  };
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function numberMeta(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : fallback;
}
