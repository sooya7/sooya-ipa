import { describe, expect, it } from 'vitest';
import { pickDayTheme } from './theme.js';
import { DEFAULT_LIFE_VITALS } from './vitals.js';

const vitals = { ...DEFAULT_LIFE_VITALS };

describe('Life V2 day theme', () => {
  it('is deterministic for the same date, seed and vitals', () => {
    const input = {
      localDate: '2026-08-13',
      deterministicSeed: 11,
      recentThemes: [],
      vitals,
      weatherCondition: 'clear'
    };
    expect(pickDayTheme(input)).toEqual(pickDayTheme(input));
  });

  it('does not repeat a recent theme inside the cooldown window', () => {
    const recent = [
      { date: '2026-08-12', id: 'gentle', theme: '温和整理' },
      { date: '2026-08-11', id: 'focus', theme: '专注推进' },
      { date: '2026-08-10', id: 'connect', theme: '连接他人' }
    ];
    for (let seed = 0; seed < 12; seed += 1) {
      const picked = pickDayTheme({ localDate: '2026-08-13', deterministicSeed: seed, recentThemes: recent, vitals, weatherCondition: 'clear' });
      expect(recent.map((item) => item.id)).not.toContain(picked.id);
    }
  });
});
