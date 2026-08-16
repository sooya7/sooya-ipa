import { describe, expect, it } from 'vitest';
import { activityById } from './activities.js';
import { applyActivityToVitals, DEFAULT_LIFE_VITALS, settleVitals } from './vitals.js';
import type { LifeVitals } from './types.js';

function vitals(overrides: Partial<LifeVitals> = {}): LifeVitals {
  return { ...DEFAULT_LIFE_VITALS, updatedAt: '2026-08-13T00:00:00.000Z', ...overrides };
}

describe('Life V2 vitals', () => {
  it('settles elapsed awake time deterministically', () => {
    const before = vitals({ energy: 0.8, hunger: 0.25, restPressure: 0.2 });
    const after = settleVitals(before, Date.parse('2026-08-13T04:00:00.000Z'), { currentKind: 'work' });

    expect(after.energy).toBeCloseTo(0.62, 5);
    expect(after.hunger).toBeCloseTo(0.51, 5);
    expect(after.restPressure).toBeCloseTo(0.4, 5);
    expect(after.updatedAt).toBe('2026-08-13T04:00:00.000Z');
  });

  it('is idempotent at the same settlement boundary', () => {
    const before = vitals();
    const first = settleVitals(before, Date.parse('2026-08-13T02:00:00.000Z'));
    const second = settleVitals(first, Date.parse('2026-08-13T02:00:00.000Z'));

    expect(second).toEqual(first);
  });

  it('applies activity effects on top of settlement', () => {
    const meal = activityById('meal');
    const afterMeal = applyActivityToVitals(vitals({ hunger: 0.7 }), meal, 30 * 60_000);
    expect(afterMeal.hunger).toBeLessThan(0.2);
    expect(afterMeal.energy).toBeGreaterThan(vitals({ hunger: 0.7 }).energy);
  });
});
