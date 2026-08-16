import { describe, expect, it } from 'vitest';
import { LIFE_ACTIVITIES } from './activities.js';
import { scoreActivities, type ActivityScoreInput } from './scoring.js';
import { DEFAULT_LIFE_VITALS } from './vitals.js';

function base(): ActivityScoreInput {
  return {
    at: new Date('2026-08-13T08:00:00.000Z'),
    timeZone: 'Asia/Shanghai',
    deterministicSeed: 5,
    vitals: { ...DEFAULT_LIFE_VITALS, updatedAt: '2026-08-13T00:00:00.000Z' },
    dayTheme: '温和整理',
    recentActivityKinds: [],
    locationKind: 'home',
    weatherCondition: 'clear',
    threads: []
  };
}

describe('Life V2 activity scoring', () => {
  it('is deterministic for identical inputs', () => {
    const a = scoreActivities(LIFE_ACTIVITIES, base());
    const b = scoreActivities(LIFE_ACTIVITIES, base());
    expect(a.map((item) => [item.activity.id, item.score])).toEqual(b.map((item) => [item.activity.id, item.score]));
  });

  it('penalizes a recently repeated activity kind', () => {
    const without = scoreActivities(LIFE_ACTIVITIES, base());
    const withRepeat = scoreActivities(LIFE_ACTIVITIES, { ...base(), recentActivityKinds: ['out', 'meal', 'rest'] });
    const walkWithout = without.find((item) => item.activity.id === 'walk')!;
    const walkWith = withRepeat.find((item) => item.activity.id === 'walk')!;
    expect(walkWith.score).toBeLessThan(walkWithout.score);
  });

  it('penalizes outdoor activities in bad weather', () => {
    const clear = scoreActivities(LIFE_ACTIVITIES, base());
    const rain = scoreActivities(LIFE_ACTIVITIES, { ...base(), weatherCondition: 'rain' });
    const walkClear = clear.find((item) => item.activity.id === 'walk')!;
    const walkRain = rain.find((item) => item.activity.id === 'walk')!;
    expect(walkRain.score).toBeLessThan(walkClear.score);
  });
});
