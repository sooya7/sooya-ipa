import { describe, expect, it, vi } from 'vitest';
import { LifeCatchUpEngine, type LifeClockState, type LifeClockStore, type LifeTransitionSource } from './catch-up.js';

const initial = (lastSettledAt: string): LifeClockState => ({
  lastSettledAt,
  simulationVersion: 1,
  seedVersion: 7,
  current: { activity: 'sleep', kind: 'sleep', mood: 'quiet', startedAt: lastSettledAt, endsAt: '2026-08-13T07:30:00.000Z' }
});

function memoryStore(state: LifeClockState): LifeClockStore & { history: string[] } {
  const history: string[] = [];
  return {
    history,
    load: vi.fn(async () => structuredClone(state)),
    settle: vi.fn(async (next, transitions) => { state = structuredClone(next); history.push(...transitions.map((item: { occurredAt: string }) => item.occurredAt)); })
  };
}

describe('LifeCatchUpEngine', () => {
  it('advances by event boundaries instead of five-minute ticks', async () => {
    const store = memoryStore(initial('2026-08-13T01:00:00.000Z'));
    const calls: string[] = [];
    const source: LifeTransitionSource = {
      next: vi.fn(async (state, to, seed) => {
        calls.push(`${state.lastSettledAt}:${seed}`);
        const at = Date.parse(state.lastSettledAt);
        const next = at < Date.parse('2026-08-13T07:30:00.000Z') ? '2026-08-13T07:30:00.000Z'
          : at < Date.parse('2026-08-13T08:10:00.000Z') ? '2026-08-13T08:10:00.000Z'
            : null;
        if (!next || Date.parse(next) > to.getTime()) return null;
        return { occurredAt: next, activity: next.includes('07:30') ? 'wake' : 'breakfast', kind: next.includes('07:30') ? 'wake' : 'meal', mood: 'calm', endsAt: next };
      }),
      coarseSettle: vi.fn(async (state, to) => ({ ...state, lastSettledAt: to.toISOString() }))
    };
    const engine = new LifeCatchUpEngine({ store, source });

    const result = await engine.catchUp(new Date('2026-08-13T15:00:00.000Z'));

    expect(result.transitions.map((item) => item.activity)).toEqual(['wake', 'breakfast']);
    expect(result.state.lastSettledAt).toBe('2026-08-13T15:00:00.000Z');
    expect(calls).toHaveLength(3);
    expect(source.coarseSettle).not.toHaveBeenCalled();
  });

  it('coarsely settles old gaps, caps detailed replay, and preserves historical rows', async () => {
    const store = memoryStore(initial('2026-07-01T00:00:00.000Z'));
    let sequence = 0;
    const source: LifeTransitionSource = {
      coarseSettle: vi.fn(async (state, to) => ({ ...state, lastSettledAt: to.toISOString(), current: { ...state.current, activity: 'coarse-restored' } })),
      next: vi.fn(async (state, to) => {
        const next = new Date(Date.parse(state.lastSettledAt) + 60_000);
        if (next > to) return null;
        sequence += 1;
        return { occurredAt: next.toISOString(), activity: `step-${sequence}`, kind: 'rest', mood: 'calm', endsAt: next.toISOString() };
      })
    };
    const engine = new LifeCatchUpEngine({ store, source, detailedWindowMs: 7 * 86_400_000, maxTransitions: 200 });

    const result = await engine.catchUp(new Date('2026-08-13T00:00:00.000Z'));

    // Once for history older than seven days, then once more after the
    // detailed transition cap is reached. Neither path fabricates history.
    expect(source.coarseSettle).toHaveBeenCalledTimes(2);
    expect(result.transitions).toHaveLength(200);
    expect(result.limited).toBe(true);
    expect(store.history).toHaveLength(200);
  });

  it('is deterministic for the same state, date, and seed version', async () => {
    const make = () => {
      const store = memoryStore(initial('2026-08-13T01:00:00.000Z'));
      const source: LifeTransitionSource = {
        coarseSettle: async (state, to) => ({ ...state, lastSettledAt: to.toISOString() }),
        next: async (state, to, seed) => {
          const next = new Date(Date.parse(state.lastSettledAt) + ((seed % 11) + 1) * 60_000);
          return next <= to ? { occurredAt: next.toISOString(), activity: `seed-${seed}`, kind: 'rest', mood: 'calm', endsAt: next.toISOString() } : null;
        }
      };
      return new LifeCatchUpEngine({ store, source, maxTransitions: 3 }).catchUp(new Date('2026-08-13T02:00:00.000Z'));
    };

    const [a, b] = await Promise.all([make(), make()]);
    expect(a.transitions).toEqual(b.transitions);
  });
});
