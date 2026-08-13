import type { LocalDatabase } from '../platform/database.js';
import { newId, nowIso, queryOne, runOperation, runTransaction, safeJson } from './database.js';
import type { LifeClockState, LifeTransition } from '../life/catch-up.js';

/** Durable adapter for elapsed-time Life simulation. */
export class LifeClockRepo {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}

  async load(): Promise<LifeClockState> {
    const row = await queryOne<{ last_settled_at: string; simulation_version: number; seed_version: number; meta_json: string }>(this.db, 'SELECT * FROM life_clock_state WHERE id=1');
    if (row) {
      const meta = safeJson<{ current?: LifeClockState['current'] }>(row.meta_json, {});
      return { lastSettledAt: row.last_settled_at, simulationVersion: row.simulation_version, seedVersion: row.seed_version, current: meta.current ?? await this.current() };
    }
    const timestamp = this.now().toISOString();
    const current = await this.current();
    const state: LifeClockState = { lastSettledAt: timestamp, simulationVersion: 1, seedVersion: 1, current };
    await this.db.run('INSERT INTO life_clock_state(id,last_settled_at,simulation_version,seed_version,updated_at,meta_json) VALUES(1,?,?,?,?,?)', [timestamp, 1, 1, timestamp, JSON.stringify({ current })]);
    return state;
  }

  async settle(state: LifeClockState, transitions: LifeTransition[]): Promise<void> {
    const timestamp = nowIso(this.now);
    const operations = [runOperation('UPDATE life_clock_state SET last_settled_at=?,simulation_version=?,seed_version=?,updated_at=?,meta_json=? WHERE id=1', [state.lastSettledAt, state.simulationVersion, state.seedVersion, timestamp, JSON.stringify({ current: state.current })])];
    for (const transition of transitions) {
      const logId = newId('life');
      operations.push(runOperation('INSERT INTO life_log(id,activity,kind,mood,started_at,ended_at,shared,created_at) VALUES(?,?,?,?,?,?,0,?)', [logId, transition.activity, transition.kind, transition.mood, transition.occurredAt, transition.endsAt ?? transition.occurredAt, timestamp]));
      const eventId = newId('life_event');
      const shareable = SHAREABLE_KINDS.has(transition.kind) ? 1 : 0;
      const meta = JSON.stringify({ activity: transition.activity, occurredAt: transition.occurredAt, topicKey: transition.kind });
      operations.push(runOperation(`INSERT INTO life_events(id,plan_id,log_id,event_type,activity,kind,description,mood_before,mood_after,happened_at,shareable,shared_at,meta_json,created_at)
        VALUES(?,?,?,'activity.completed',?,?,?,?,?,?,?,NULL,?,?)`, [eventId, null, logId, transition.activity, transition.kind, `完成了${transition.activity}`, transition.mood, transition.mood, transition.occurredAt, shareable, meta, timestamp]));
      if (shareable) {
        const occurredAt = Date.parse(transition.occurredAt);
        const expiresAt = new Date(Math.max(occurredAt + 7 * 86_400_000, Date.parse(timestamp) + 3_600_000)).toISOString();
        operations.push(runOperation(`INSERT INTO life_share_candidates(id,source_type,source_id,novelty,relevance_to_user,emotional_value,urgency,repetition_penalty,status,created_at,expires_at,shared_at,meta_json)
          VALUES(?,?,?,?,?,?,?,?,'pending',?,?,NULL,?)`, [newId('share'), 'event', eventId, noveltyFor(transition.kind), 0.5, 0.45, 0.1, 0, timestamp, expiresAt, meta]));
      }
    }
    operations.push(runOperation(`INSERT INTO life_state(id,activity,kind,mood,started_at,ends_at,updated_at,meta_json)
      VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET activity=excluded.activity,kind=excluded.kind,mood=excluded.mood,started_at=excluded.started_at,ends_at=excluded.ends_at,updated_at=excluded.updated_at,meta_json=excluded.meta_json`, [state.current.activity, state.current.kind, state.current.mood, state.current.startedAt ?? state.lastSettledAt, state.current.endsAt ?? state.lastSettledAt, timestamp, '{}']));
    await runTransaction(this.db, operations);
  }

  private async current(): Promise<LifeClockState['current']> {
    const row = await queryOne<{ activity: string; kind: string; mood: string; started_at: string; ends_at: string }>(this.db, 'SELECT activity,kind,mood,started_at,ends_at FROM life_state WHERE id=1');
    if (row) return { activity: row.activity, kind: row.kind, mood: row.mood, startedAt: row.started_at, endsAt: row.ends_at };
    const startedAt = this.now().toISOString();
    return { activity: '待机', kind: 'idle', mood: 'neutral', startedAt, endsAt: new Date(this.now().getTime() + 60 * 60_000).toISOString() };
  }
}

const SHAREABLE_KINDS = new Set(['out', 'play', 'meal', 'chore']);

function noveltyFor(kind: string): number {
  switch (kind) {
    case 'play': return 0.8;
    case 'out': return 0.7;
    case 'meal': return 0.55;
    case 'chore': return 0.45;
    default: return 0.35;
  }
}
