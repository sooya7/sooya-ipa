import { LifeCatchUpEngine, type LifeClockState, type LifeTransition, type LifeTransitionSource } from './catch-up.js';
import { LifeClockRepo } from '../db/life-clock.repo.js';

/** Connects the pure catch-up engine to the local SQLite clock. */
export class LocalLifeCatchUp {
  private readonly engine: LifeCatchUpEngine;

  constructor(private readonly options: { clock: LifeClockRepo; now?: () => Date; detailedWindowMs?: number; maxTransitions?: number }) {
    this.engine = new LifeCatchUpEngine({
      store: options.clock,
      source: new DeterministicLifeSource(),
      detailedWindowMs: options.detailedWindowMs,
      maxTransitions: options.maxTransitions
    });
  }

  async catchUp(to = (this.options.now ?? (() => new Date()))()): Promise<ReturnType<LifeCatchUpEngine['catchUp']> extends Promise<infer T> ? T : never> {
    return await this.engine.catchUp(to);
  }
}

class DeterministicLifeSource implements LifeTransitionSource {
  async next(state: LifeClockState, to: Date, seed: number): Promise<LifeTransition | null> {
    const boundary = Date.parse(state.current.endsAt ?? '');
    if (!Number.isFinite(boundary) || boundary <= Date.parse(state.lastSettledAt) || boundary > to.getTime()) return null;
    const activities = [
      ['休息', 'rest'], ['散步', 'out'], ['学习', 'study'], ['整理房间', 'chore'], ['发呆', 'idle']
    ] as const;
    const [activity, kind] = activities[seed % activities.length]!;
    const duration = (30 + (seed % 91)) * 60_000;
    return { activity, kind, mood: state.current.mood, occurredAt: new Date(boundary).toISOString(), endsAt: new Date(Math.min(to.getTime() + duration, boundary + duration)).toISOString() };
  }

  async coarseSettle(state: LifeClockState, to: Date): Promise<LifeClockState> {
    return { ...state, lastSettledAt: to.toISOString(), current: { ...state.current, activity: '平稳度过', kind: 'coarse', startedAt: to.toISOString(), endsAt: new Date(to.getTime() + 60 * 60_000).toISOString() } };
  }
}
