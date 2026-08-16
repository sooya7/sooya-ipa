export interface LifeCurrentState {
  activity: string;
  kind: string;
  mood: string;
  startedAt?: string;
  endsAt?: string;
}

export interface LifeClockState {
  lastSettledAt: string;
  simulationVersion: number;
  seedVersion: number;
  current: LifeCurrentState;
}

export interface LifeTransition extends LifeCurrentState {
  occurredAt: string;
  /** Deterministic transition metadata used by durable publishers. */
  meta?: Record<string, unknown>;
}

export interface LifeClockStore {
  load(): Promise<LifeClockState>;
  /** Atomically persists clock state and append-only history transitions. */
  settle(state: LifeClockState, transitions: LifeTransition[]): Promise<void>;
}

export interface LifeTransitionSource {
  next(state: LifeClockState, to: Date, deterministicSeed: number): Promise<LifeTransition | null>;
  coarseSettle(state: LifeClockState, to: Date): Promise<LifeClockState>;
}

export interface LifeCatchUpResult {
  state: LifeClockState;
  transitions: LifeTransition[];
  coarseSettled: boolean;
  limited: boolean;
}

/** Persistent elapsed-time simulation that never depends on a background timer. */
export class LifeCatchUpEngine {
  private readonly detailedWindowMs: number;
  private readonly maxTransitions: number;

  constructor(private readonly options: {
    store: LifeClockStore;
    source: LifeTransitionSource;
    detailedWindowMs?: number;
    maxTransitions?: number;
  }) {
    this.detailedWindowMs = options.detailedWindowMs ?? 7 * 86_400_000;
    this.maxTransitions = options.maxTransitions ?? 200;
  }

  async catchUp(to: Date): Promise<LifeCatchUpResult> {
    if (!Number.isFinite(to.getTime())) throw new Error('invalid catch-up target');
    let state = await this.options.store.load();
    const fromMs = Date.parse(state.lastSettledAt);
    if (!Number.isFinite(fromMs)) throw new Error('invalid life clock state');
    if (to.getTime() <= fromMs) return { state, transitions: [], coarseSettled: false, limited: false };

    let coarseSettled = false;
    const detailedStart = to.getTime() - this.detailedWindowMs;
    if (fromMs < detailedStart) {
      state = await this.options.source.coarseSettle(state, new Date(detailedStart));
      state = { ...state, lastSettledAt: new Date(detailedStart).toISOString() };
      coarseSettled = true;
    }

    const transitions: LifeTransition[] = [];
    let limited = false;
    for (let index = 0; index < this.maxTransitions; index += 1) {
      const seed = deterministicSeed(state, index);
      const transition = await this.options.source.next(state, to, seed);
      if (!transition) break;
      const at = Date.parse(transition.occurredAt);
      if (!Number.isFinite(at) || at <= Date.parse(state.lastSettledAt) || at > to.getTime()) {
        throw new Error('life transition source returned a non-forward boundary');
      }
      transitions.push(transition);
      state = {
        ...state,
        lastSettledAt: transition.occurredAt,
        current: {
          activity: transition.activity,
          kind: transition.kind,
          mood: transition.mood,
          startedAt: transition.occurredAt,
          endsAt: transition.endsAt
        }
      };
    }
    if (transitions.length === this.maxTransitions && Date.parse(state.lastSettledAt) < to.getTime()) {
      state = await this.options.source.coarseSettle(state, to);
      limited = true;
    }
    state = { ...state, lastSettledAt: to.toISOString() };
    await this.options.store.settle(state, transitions);
    return { state, transitions, coarseSettled, limited };
  }
}

function deterministicSeed(state: LifeClockState, transitionIndex: number): number {
  const value = `${state.lastSettledAt}:${state.simulationVersion}:${state.seedVersion}:${transitionIndex}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

