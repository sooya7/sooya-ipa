import type { LocationKind, TravelMode } from '../../db/location.repo.js';

export interface LifeVitals {
  energy: number;
  hunger: number;
  stress: number;
  socialNeed: number;
  loneliness: number;
  curiosity: number;
  comfort: number;
  focus: number;
  sleepDebt: number;
  /** Server-era mood tendency; stored in vitals meta to stay schema-additive. */
  moodTendency: number;
  /** Accumulated awake pressure; rest/sleep discharge it. */
  restPressure: number;
  updatedAt: string;
}

export interface LifeActivityDefinition {
  id: string;
  name: string;
  kind: string;
  tags: string[];
  moods: string[];
  /** Preferred location kinds in priority order. */
  locationKinds: LocationKind[];
  /** True when the activity prefers being outside. */
  outdoor: boolean;
  durationMinutes: [number, number];
  /** Local-hour windows in which this activity is more natural. */
  timeWindows: Array<{ startHour: number; endHour: number; weight: number }>;
  shareable: boolean;
  threadCategory: string;
  outcomes: string[];
}

export interface LifeActivityUsage {
  activityId: string;
  lastUsedAt: string | null;
  useCount7d: number;
  useCount30d: number;
  consecutiveDays: number;
  semanticTags: string[];
  recentOutcomes: string[];
}

export interface LifeDayTheme {
  id: string;
  date: string;
  theme: string;
  toneTags: string[];
  sourceFactors: string[];
}

export interface LifeThread {
  id: string;
  title: string;
  category: string;
  status: 'open' | 'paused' | 'resolved' | 'abandoned';
  progress: number;
  importance: number;
  heat: number;
  nextActions: string[];
}

export interface ScoredActivity {
  activity: LifeActivityDefinition;
  score: number;
  factors: Record<string, number>;
}

export interface LifeOutcome {
  result: string;
  resultType: 'positive' | 'neutral' | 'negative';
  novelty: number;
  emotionalValue: number;
  relevanceToUser: number;
  urgency: number;
}

export interface TravelStateSnapshot {
  fromLocationId: string;
  toLocationId: string;
  mode: TravelMode;
  startedAt: string;
  expectedArriveAt: string;
}
