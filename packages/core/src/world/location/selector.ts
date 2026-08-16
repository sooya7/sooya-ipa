import { hashText } from '../../life/v2/theme.js';
import type { LifeActivityDefinition } from '../../life/v2/types.js';
import type { LocationCandidate } from './types.js';

export interface LocationSelectorInput {
  activity: LifeActivityDefinition;
  currentLocationId: string;
  weatherCondition?: string;
  recentLocationIds?: string[];
  deterministicSeed: number;
  at: string;
}

export function selectLocationCandidate(
  locations: LocationCandidate[],
  input: LocationSelectorInput
): LocationCandidate | undefined {
  const active = locations.filter((location) => location.id !== input.currentLocationId);
  if (active.length === 0) return undefined;
  const weather = input.weatherCondition ?? 'clear';
  const badWeather = ['rain', 'storm', 'snow', 'fog', 'wind'].includes(weather);
  const recent = new Set(input.recentLocationIds ?? []);

  return [...active]
    .map((location) => {
      let score = 0;
      const kindMatches = input.activity.locationKinds.includes(location.kind);
      score += kindMatches ? 4 : input.activity.locationKinds.includes('home') && location.kind === 'home' ? 3 : 0;
      score += location.indoor && badWeather ? 2 : input.activity.outdoor && !location.indoor && !badWeather ? 2 : 0;
      if (input.activity.outdoor && location.kind === 'park') score += 2;
      score += Math.min(3, location.visitWeight);
      score -= recent.has(location.id) ? 2 : 0;
      score += (hashText(`${input.deterministicSeed}:${input.at}:${location.id}`) % 100) / 100;
      return { location, score };
    })
    .sort((a, b) => b.score - a.score || a.location.name.localeCompare(b.location.name))[0]?.location;
}
