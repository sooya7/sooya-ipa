import type { LifeRepo, LifeV2Repo, LocationRepo, WeatherRepo, LifeThreadRow } from '../../db/index.js';
import type { LifeClockState, LifeTransition, LifeTransitionSource } from '../catch-up.js';
import { LocalLocationService } from '../../world/location/service.js';
import { LIFE_ACTIVITIES, activityById, durationForActivity } from './activities.js';
import { applyActivityToVitals, DEFAULT_LIFE_VITALS, settleVitals, vitalsFromRow, vitalsToRow } from './vitals.js';
import { localDateKey, pickDayTheme } from './theme.js';
import { scoreActivities } from './scoring.js';
import { resolveOutcome } from './outcomes.js';
import { advanceThread, decayThread, pickDefaultThread } from './threads.js';
import type { LifeDayTheme, LifeThread, LifeVitals } from './types.js';

export interface LifeV2SourceOptions {
  life: LifeV2Repo;
  lifeState?: LifeRepo;
  locations?: LocationRepo;
  weather?: WeatherRepo;
  locationRuntime?: LocalLocationService;
  timeZone?: string;
  now?: () => Date;
}

/**
 * Life V2 transition source for the existing catch-up engine. Each transition
 * is deterministic and persists vitals/themes/threads/usage as it advances;
 * the clock repo remains responsible for the append-only life_log/event rows
 * and share-candidate publication.
 */
export class LifeV2Source implements LifeTransitionSource {
  constructor(private readonly options: LifeV2SourceOptions) {}

  async next(state: LifeClockState, to: Date, seed: number): Promise<LifeTransition | null> {
    const lastMs = Date.parse(state.lastSettledAt);
    const toMs = to.getTime();
    const boundaryMs = Date.parse(state.current.endsAt ?? '');
    let atMs = Number.isFinite(boundaryMs) && boundaryMs > lastMs ? boundaryMs : lastMs + 30 * 60_000;
    if (atMs > toMs) return null;
    const at = new Date(atMs);

    // A currently running travel transition ends at its expected arrival.
    const travel = await this.options.locations?.currentTravel().catch(() => undefined);
    if (travel && atMs < Date.parse(travel.expected_arrive_at)) {
      const transit = activityById('transit');
      const vitals = await this.settleVitals(state, at);
      return this.transition({
        state,
        activity: transit,
        at,
        endsAt: new Date(Math.min(toMs, Date.parse(travel.expected_arrive_at))),
        seed,
        vitals,
        locationId: travel.from_location_id,
        city: null,
        outcomeText: '仍在前往目的地'
      });
    }

    if (this.options.locationRuntime) {
      await this.options.locationRuntime.arriveIfDue(at).catch(() => undefined);
    }

    const vitals = await this.settleVitals(state, at);
    const timeZone = await this.timeZone();
    const localDate = localDateKey(at, timeZone);
    const recentThemes = await this.options.life.recentThemes(14).catch(() => []);
    const existingTheme = await this.options.life.themeFor(localDate).catch(() => undefined);
    const weather = await this.options.weather?.latest('active').catch(() => undefined);
    const weatherCondition = typeof weather?.condition === 'string' ? weather.condition : 'clear';
    const theme: LifeDayTheme = existingTheme
      ? {
          id: existingTheme.id,
          date: existingTheme.local_date,
          theme: existingTheme.theme,
          toneTags: parseStringArray(existingTheme.tone_tags_json),
          sourceFactors: parseStringArray(existingTheme.source_factors_json)
        }
      : pickDayTheme({
          localDate,
          deterministicSeed: seed,
          recentThemes: recentThemes.map((row) => ({ date: row.local_date, id: themeIdFromRow(row.id), theme: row.theme })),
          vitals,
          weatherCondition
        });
    if (!existingTheme) await this.options.life.saveTheme({ localDate, theme: theme.theme, themeId: theme.id, toneTags: theme.toneTags, sourceFactors: theme.sourceFactors }).catch(() => undefined);

    const currentLocation = await this.currentLocation();
    const threads = await this.openThreads();
    const recentKinds = await this.options.lifeState?.recent(8).catch(() => []) ?? [];
    const scored = scoreActivities(LIFE_ACTIVITIES.filter((activity) => activity.id !== 'transit'), {
      at,
      timeZone,
      deterministicSeed: seed,
      vitals,
      dayTheme: theme.theme,
      recentActivityKinds: recentKinds.map((row) => row.kind),
      locationKind: currentLocation?.kind,
      weatherCondition,
      threads
    });
    let selected = scored[0]?.activity ?? activityById('rest');

    // Location Runtime owns world movement. A departure turns this transition
    // into a transit transition whose boundary is the persisted arrival time.
    let locationId = currentLocation?.id ?? null;
    let city = currentLocation?.city ?? null;
    if (this.options.locationRuntime) {
      const movement = await this.options.locationRuntime.departForActivity(selected, {
        at,
        weatherCondition,
        deterministicSeed: seed
      }).catch(() => undefined);
      if (movement?.kind === 'departed') {
        selected = activityById('transit');
        const durationMinutes = Math.max(1, movement.travel.travelMinutes);
        const endsAt = new Date(atMs + durationMinutes * 60_000);
        const vitalsAfter = applyActivityToVitals(vitals, selected, durationMinutes * 60_000);
        await this.persistEffects(selected, at, localDate, theme.theme, threads);
        return this.transition({
          state,
          activity: selected,
          at,
          endsAt,
          seed,
          vitals: vitalsAfter,
          locationId: movement.travel.fromLocationId,
          city,
          outcomeText: `前往 ${movement.travel.toLocationId}`
        });
      }
      if (movement?.kind === 'arrived') {
        const arrived = await this.options.locationRuntime.currentLocation();
        locationId = arrived?.id ?? locationId;
        city = arrived?.city ?? city;
      } else if (movement?.kind === 'stay' && movement.reason === 'travel_in_progress') {
        selected = activityById('transit');
      }
    }

    const durationMs = durationForActivity(selected, seed);
    const endsAt = new Date(atMs + durationMs);
    const vitalsAfter = applyActivityToVitals(vitals, selected, durationMs);
    const outcome = resolveOutcome(selected, seed, at.toISOString());
    await this.persistEffects(selected, at, localDate, theme.theme, threads);

    return this.transition({
      state,
      activity: selected,
      at,
      endsAt,
      seed,
      vitals: vitalsAfter,
      locationId,
      city,
      outcomeText: outcome.result,
      shareScores: selected.shareable ? {
        novelty: outcome.novelty,
        relevanceToUser: outcome.relevanceToUser,
        emotionalValue: outcome.emotionalValue,
        urgency: outcome.urgency
      } : undefined
    });
  }

  async coarseSettle(state: LifeClockState, to: Date): Promise<LifeClockState> {
    await this.settleVitals(state, to, true);
    const elapsedDays = Math.max(0, (to.getTime() - Date.parse(state.lastSettledAt)) / 86_400_000);
    const threads = await this.options.life.threads('open').catch(() => []);
    await Promise.all(threads.map(async (row) => {
      const thread = toThread(row);
      const decayed = decayThread(thread, elapsedDays);
      await this.options.life.saveThread({
        id: decayed.id,
        title: decayed.title,
        category: decayed.category,
        status: decayed.status,
        progress: decayed.progress,
        importance: decayed.importance,
        heat: decayed.heat,
        nextActions: decayed.nextActions
      }).catch(() => undefined);
    }));
    const ended = new Date(to.getTime() + 60 * 60_000);
    return {
      ...state,
      current: { activity: '平稳度过', kind: 'coarse', mood: 'calm', startedAt: to.toISOString(), endsAt: ended.toISOString() }
    };
  }

  private async settleVitals(state: LifeClockState, at: Date, coarse = false): Promise<LifeVitals> {
    const row = await this.options.life.getVitals().catch(() => undefined);
    const previous = row
      ? vitalsFromRow(row)
      : { ...DEFAULT_LIFE_VITALS, updatedAt: state.lastSettledAt };
    const next = settleVitals(previous, at.getTime(), { currentKind: coarse ? 'rest' : state.current.kind });
    await this.options.life.upsertVitals(vitalsToRow(next)).catch(() => undefined);
    return next;
  }

  private async persistEffects(
    activity: (typeof LIFE_ACTIVITIES)[number],
    at: Date,
    localDate: string,
    dayTheme: string,
    threads: LifeThread[]
  ): Promise<void> {
    if (activity.id !== 'transit') {
      await this.options.life.recordUsage({
        activityId: activity.id,
        tags: activity.tags,
        outcomeTags: activity.outcomes.slice(0, 2),
        usedAt: at.toISOString()
      }).catch(() => undefined);
    }
    const seed = Math.trunc(at.getTime() / 3_600_000);
    const matching = threads.find((thread) => thread.category === activity.threadCategory) ?? threads[0];
    const outcome = resolveOutcome(activity, seed, `${localDate}:${dayTheme}`);
    if (matching) {
      const advanced = advanceThread(matching, { activity, outcome, now: at.toISOString() });
      await this.options.life.saveThread({
        id: advanced.id,
        title: advanced.title,
        category: advanced.category,
        status: advanced.status,
        progress: advanced.progress,
        importance: advanced.importance,
        heat: advanced.heat,
        nextActions: advanced.nextActions
      }).catch(() => undefined);
    } else if (threads.length === 0 && activity.id !== 'transit') {
      const fallback = pickDefaultThread(activity, seed);
      await this.options.life.saveThread({
        title: fallback.title,
        category: fallback.category,
        importance: fallback.importance,
        nextActions: [`继续：${activity.name}`]
      }).catch(() => undefined);
    }
  }

  private async transition(input: {
    state: LifeClockState;
    activity: (typeof LIFE_ACTIVITIES)[number];
    at: Date;
    endsAt: Date;
    seed: number;
    vitals: LifeVitals;
    locationId: string | null;
    city: string | null;
    outcomeText: string;
    shareScores?: { novelty: number; relevanceToUser: number; emotionalValue: number; urgency: number };
  }): Promise<LifeTransition> {
    const mood = input.activity.moods[input.seed % input.activity.moods.length] ?? 'calm';
    return {
      activity: input.activity.name,
      kind: input.activity.kind,
      mood,
      occurredAt: input.at.toISOString(),
      endsAt: input.endsAt.toISOString(),
      meta: {
        activityId: input.activity.id,
        outcome: input.outcomeText,
        locationId: input.locationId,
        city: input.city,
        ...(input.shareScores ? { shareScores: input.shareScores } : {})
      }
    };
  }

  private async currentLocation(): Promise<{ id: string; name: string; kind: string; city: string | null; timeZone: string | null } | undefined> {
    if (!this.options.locations) return undefined;
    const state = await this.options.locations.currentState().catch(() => undefined);
    if (!state) return undefined;
    const location = await this.options.locations.get(state.location_id).catch(() => undefined);
    return location ? { id: location.id, name: location.name, kind: location.kind, city: location.city, timeZone: location.time_zone } : undefined;
  }

  private async timeZone(): Promise<string> {
    if (this.options.timeZone) return this.options.timeZone;
    const location = await this.currentLocation();
    return location?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  }

  private async openThreads(): Promise<LifeThread[]> {
    const rows = await this.options.life.threads('open').catch(() => [] as LifeThreadRow[]);
    return rows.map(toThread);
  }
}

function themeIdFromRow(id: string): string {
  const separator = id.indexOf(':');
  return separator > 0 ? id.slice(0, separator) : id;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toThread(row: LifeThreadRow): LifeThread {
  let nextActions: unknown = [];
  try { nextActions = JSON.parse(row.next_actions_json) as unknown; } catch { nextActions = []; }
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    status: row.status,
    progress: row.progress,
    importance: row.importance,
    heat: row.heat,
    nextActions: Array.isArray(nextActions) ? nextActions.filter((item): item is string => typeof item === 'string') : []
  };
}
