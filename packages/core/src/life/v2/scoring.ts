import { hashText } from './theme.js';
import type { LifeActivityDefinition } from './types.js';
import type { LifeThread, LifeVitals, ScoredActivity } from './types.js';

export interface ActivityScoreInput {
  at: Date;
  timeZone: string;
  deterministicSeed: number;
  vitals: LifeVitals;
  dayTheme: string;
  recentActivityKinds: string[];
  locationKind?: string;
  weatherCondition?: string;
  threads?: Pick<LifeThread, 'title' | 'category' | 'heat' | 'importance'>[];
}

/** Deterministic activity scoring. Core logic never uses Math.random(). */
export function scoreActivities(
  activities: readonly LifeActivityDefinition[],
  input: ActivityScoreInput
): ScoredActivity[] {
  const localHour = localHourIn(input.at, input.timeZone);
  const weather = input.weatherCondition ?? 'clear';
  const badWeather = ['rain', 'storm', 'snow'].includes(weather);
  const threadText = input.threads?.map((thread) => `${thread.title} ${thread.category}`).join(' ').toLocaleLowerCase() ?? '';

  const scored = activities.map((activity) => {
    const factors: Record<string, number> = {
      time: timeScore(activity, localHour),
      vitals: vitalsScore(activity, input.vitals),
      antiRepeat: input.recentActivityKinds.slice(0, 3).includes(activity.kind) ? -0.45 : 0,
      location: locationScore(activity, input.locationKind),
      weather: activity.outdoor && badWeather ? -0.5 : activity.outdoor && weather === 'clear' ? 0.12 : 0,
      theme: activity.tags.some((tag) => input.dayTheme.includes(tag) || input.dayTheme.split(/\s/u).some((part) => tag.includes(part) || part.includes(tag))) ? 0.22 : 0,
      threads: activity.tags.some((tag) => threadText.includes(tag)) ? 0.12 : 0
    };
    if (input.threads?.length) {
      const hottest = Math.max(0.05, ...input.threads.map((thread) => thread.heat * thread.importance));
      factors.threads = (factors.threads ?? 0) + (activity.threadCategory === '关系' ? hottest * 0.15 : 0);
    }
    // Small deterministic jitter, never wall-clock randomness.
    const jitter = (hashText(`${input.deterministicSeed}:${activity.id}:${input.at.toISOString()}:${input.dayTheme}`) % 1000) / 1000 * 0.08;
    const score = Object.values(factors).reduce((sum, value) => sum + value, 0) + jitter;
    return { activity, score, factors };
  });

  return scored.sort((a, b) => b.score - a.score || a.activity.id.localeCompare(b.activity.id));
}

function localHourIn(date: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? date.getUTCHours());
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? date.getUTCMinutes());
    return hour + minute / 60;
  } catch {
    return date.getUTCHours() + date.getUTCMinutes() / 60;
  }
}

function timeScore(activity: LifeActivityDefinition, localHour: number): number {
  if (activity.timeWindows.length === 0) return 0.1;
  return activity.timeWindows.reduce((best, window) => {
    const starts = window.startHour;
    const ends = window.endHour;
    const inside = starts <= ends
      ? localHour >= starts && localHour < ends
      : localHour >= starts || localHour < ends;
    return Math.max(best, inside ? window.weight : 0);
  }, 0);
}

function vitalsScore(activity: LifeActivityDefinition, vitals: LifeVitals): number {
  const v = vitals;
  const byKind: Record<string, number> = {
    sleep: (v.sleepDebt + (1 - v.energy)) * 0.55,
    meal: v.hunger * 0.7,
    rest: v.restPressure * 0.55 + (v.focus < 0.4 ? 0.3 : 0),
    work: v.focus * 0.28 - v.restPressure * 0.18,
    study: v.curiosity * 0.4 - v.restPressure * 0.12,
    walk: (v.loneliness + v.socialNeed) * 0.18 - (v.energy < 0.2 ? 0.25 : 0),
    social: (v.loneliness * 0.55 + v.socialNeed * 0.5),
    play: (v.loneliness + (1 - v.restPressure)) * 0.22,
    chore: v.comfort < 0.4 ? 0.25 : v.energy > 0.5 ? 0.12 : 0,
    transit: 0.05
  };
  return byKind[activity.kind] ?? 0.1;
}

function locationScore(activity: LifeActivityDefinition, locationKind: string | undefined): number {
  if (!locationKind) return 0;
  if (activity.locationKinds.includes(locationKind as never)) return 0.32;
  if (activity.locationKinds.includes('home') && locationKind === 'home') return 0.32;
  return 0;
}
