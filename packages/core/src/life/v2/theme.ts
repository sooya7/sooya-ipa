import type { LifeDayTheme, LifeVitals } from './types.js';

const DAY_THEMES = [
  { id: 'gentle', theme: '温和整理', tags: ['温和', '整理', '恢复'], factors: ['rest'] },
  { id: 'focus', theme: '专注推进', tags: ['专注', '推进', '事务'], factors: ['work', 'study'] },
  { id: 'connect', theme: '连接他人', tags: ['社交', '连接', '关系'], factors: ['social'] },
  { id: 'outdoor', theme: '出门透气', tags: ['外出', '自然', '放松'], factors: ['walk', 'play'] },
  { id: 'grow', theme: '缓慢成长', tags: ['成长', '学习', '好奇'], factors: ['study', 'curiosity'] },
  { id: 'comfort', theme: '照顾自己', tags: ['舒适', '休息', '饮食'], factors: ['meal', 'rest'] }
] as const;

export interface ThemeSelectionInput {
  localDate: string;
  deterministicSeed: number;
  recentThemes: Array<Pick<LifeDayTheme, 'date' | 'id' | 'theme'>>;
  vitals: Pick<LifeVitals, 'energy' | 'hunger' | 'socialNeed' | 'loneliness' | 'restPressure' | 'focus' | 'curiosity'>;
  weatherCondition?: string;
}

export function localDateKey(date: Date, timeZone = 'Asia/Shanghai'): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function pickDayTheme(input: ThemeSelectionInput): LifeDayTheme {
  const cooldown = new Set(input.recentThemes.slice(0, 3).map((theme) => theme.id));
  const candidates = DAY_THEMES.filter((theme) => !cooldown.has(theme.id));
  const pool = candidates.length >= 2 ? candidates : DAY_THEMES;
  const scored = pool.map((theme) => ({ theme, score: themeScore(theme.id, input) }));
  scored.sort((a, b) => b.score - a.score || hashText(`${input.localDate}:${a.theme.id}:${input.deterministicSeed}`) - hashText(`${input.localDate}:${b.theme.id}:${input.deterministicSeed}`));
  const selected = scored[0]?.theme ?? DAY_THEMES[0];
  return { id: selected.id, date: input.localDate, theme: selected.theme, toneTags: [...selected.tags], sourceFactors: [...selected.factors] };
}

function themeScore(id: string, input: ThemeSelectionInput): number {
  const v = input.vitals;
  const weather = input.weatherCondition ?? 'clear';
  let score = hashText(`${input.localDate}:${id}:${input.deterministicSeed}`) % 100;
  if (id === 'gentle' || id === 'comfort') score += v.restPressure * 90;
  if (id === 'comfort' || id === 'gentle') score += v.energy < 0.35 ? 60 : 0;
  if (id === 'focus') score += v.focus * 50;
  if (id === 'connect') score += (v.socialNeed + v.loneliness) * 55;
  if (id === 'outdoor') score += v.socialNeed < 0.5 && v.energy > 0.45 ? 55 : 0;
  if (id === 'outdoor' && ['clear', 'cloudy'].includes(weather)) score += 45;
  if (id === 'outdoor' && ['rain', 'storm', 'snow'].includes(weather)) score -= 70;
  if (id === 'grow') score += v.curiosity * 40;
  if (id === 'comfort') score += v.hunger > 0.6 ? 65 : 0;
  return score;
}

export function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}
