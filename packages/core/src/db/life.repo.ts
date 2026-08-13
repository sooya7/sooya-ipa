import type { LocalDatabase } from '../platform/database.js';
import { clampInteger, newId, nowIso, placeholders, queryOne, runOperation, runTransaction, safeJson } from './database.js';

export interface LifeStateRow { activity: string; kind: string; mood: string; started_at: string; ends_at: string; updated_at: string; meta_json: string; }
export interface LifeLogRow { id: string; activity: string; kind: string; mood: string; started_at: string; ended_at: string; shared: number; created_at: string; }
export interface LifeStateInput { activity: string; kind: string; mood: string; startedAt: string; endsAt: string; meta?: Record<string, unknown>; }
export type LifePlanStatus = 'planned' | 'active' | 'paused' | 'completed' | 'cancelled' | 'skipped';
export type LifePlanSource = 'routine' | 'generated' | 'admin' | 'conversation';
export interface LifePlanRow { id: string; title: string; kind: string; planned_start: string | null; planned_end: string | null; status: LifePlanStatus; source: LifePlanSource; priority: number; meta_json: string; created_at: string; updated_at: string; }
export interface LifePlanInput { title: string; kind: string; plannedStart?: string | null; plannedEnd?: string | null; status?: LifePlanStatus; source?: LifePlanSource; priority?: number; meta?: Record<string, unknown>; }
export interface LifeEventRow { id: string; plan_id: string | null; log_id: string | null; event_type: string; activity: string; kind: string; description: string; mood_before: string | null; mood_after: string | null; happened_at: string; shareable: number; shared_at: string | null; meta_json: string; created_at: string; }
export interface LifeEventInput { planId?: string | null; logId?: string | null; eventType: string; activity: string; kind: string; description: string; moodBefore?: string | null; moodAfter?: string | null; happenedAt: string; shareable?: boolean; meta?: Record<string, unknown>; }

const SHAREABLE_KINDS = new Set(['out', 'play', 'meal', 'chore']);

export class LifeRepo {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}

  async current(): Promise<LifeStateRow | undefined> { return await queryOne(this.db, 'SELECT activity,kind,mood,started_at,ends_at,updated_at,meta_json FROM life_state WHERE id=1'); }

  async advance(input: LifeStateInput, options: { recordCompletionEvent?: boolean } = {}): Promise<{ previous: LifeLogRow | null }> {
    const existing = await this.current();
    const timestamp = nowIso(this.now);
    const operations = [];
    let previous: LifeLogRow | null = null;
    if (existing) {
      previous = { id: newId('life'), activity: existing.activity, kind: existing.kind, mood: existing.mood, started_at: existing.started_at, ended_at: input.startedAt, shared: 0, created_at: timestamp };
      operations.push(runOperation('INSERT INTO life_log(id,activity,kind,mood,started_at,ended_at,shared,created_at) VALUES(?,?,?,?,?,?,0,?)', [previous.id, previous.activity, previous.kind, previous.mood, previous.started_at, previous.ended_at, previous.created_at]));
      if (existing.kind !== 'sleep' && options.recordCompletionEvent !== false) {
        const event = lifeEventRow({ logId: previous.id, eventType: 'activity.completed', activity: previous.activity, kind: previous.kind, description: `完成了${previous.activity}`, moodBefore: previous.mood, moodAfter: input.mood, happenedAt: previous.ended_at, shareable: SHAREABLE_KINDS.has(previous.kind) }, timestamp);
        operations.push(lifeEventOperation(event));
        if (event.shareable) operations.push(shareCandidateOperation(event, timestamp));
      }
    }
    operations.push(runOperation(`INSERT INTO life_state(id,activity,kind,mood,started_at,ends_at,updated_at,meta_json)
      VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET activity=excluded.activity,kind=excluded.kind,mood=excluded.mood,
      started_at=excluded.started_at,ends_at=excluded.ends_at,updated_at=excluded.updated_at,meta_json=excluded.meta_json`,
      [input.activity, input.kind, input.mood, input.startedAt, input.endsAt, timestamp, JSON.stringify(input.meta ?? {})]));
    await runTransaction(this.db, operations);
    return { previous };
  }

  async recent(limit = 8): Promise<LifeLogRow[]> { return await this.db.query('SELECT * FROM life_log ORDER BY started_at DESC LIMIT ?', [clampInteger(limit, 1, 100)]); }
  async since(iso: string, limit = 20): Promise<LifeLogRow[]> { return await this.db.query('SELECT * FROM life_log WHERE ended_at>? ORDER BY started_at ASC LIMIT ?', [iso, clampInteger(limit, 1, 100)]); }
  async unshared(kinds: string[], limit = 5): Promise<LifeLogRow[]> { return kinds.length ? await this.db.query(`SELECT * FROM life_log WHERE shared=0 AND kind IN (${placeholders(kinds.length)}) ORDER BY ended_at DESC LIMIT ?`, [...kinds, clampInteger(limit, 1, 50)]) : []; }

  async markShared(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const holes = placeholders(ids.length);
    const results = await runTransaction<Array<{ changes: number }>>(this.db, [
      runOperation(`UPDATE life_log SET shared=1 WHERE id IN (${holes})`, ids),
      runOperation(`UPDATE life_events SET shared_at=? WHERE shared_at IS NULL AND (id IN (${holes}) OR log_id IN (${holes}))`, [nowIso(this.now), ...ids, ...ids]),
      runOperation(`UPDATE life_log SET shared=1 WHERE id IN (SELECT log_id FROM life_events WHERE id IN (${holes}) AND log_id IS NOT NULL)`, ids)
    ]);
    return (results[0]?.changes ?? 0) + (results[1]?.changes ?? 0);
  }

  async countSharedSince(iso: string): Promise<number> {
    const row = await queryOne<{ count: number }>(this.db, `SELECT
      (SELECT COUNT(*) FROM life_events WHERE shared_at IS NOT NULL AND happened_at>?) +
      (SELECT COUNT(*) FROM life_log l WHERE l.shared=1 AND l.ended_at>? AND NOT EXISTS(SELECT 1 FROM life_events e WHERE e.log_id=l.id)) count`, [iso, iso]);
    return row?.count ?? 0;
  }

  async createPlan(input: LifePlanInput): Promise<LifePlanRow> {
    const timestamp = nowIso(this.now);
    const row: LifePlanRow = { id: newId('life_plan'), title: input.title, kind: input.kind, planned_start: input.plannedStart ?? null, planned_end: input.plannedEnd ?? null, status: input.status ?? 'planned', source: input.source ?? 'admin', priority: input.priority ?? 0, meta_json: JSON.stringify(input.meta ?? {}), created_at: timestamp, updated_at: timestamp };
    await this.db.run('INSERT INTO life_plans(id,title,kind,planned_start,planned_end,status,source,priority,meta_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [row.id, row.title, row.kind, row.planned_start, row.planned_end, row.status, row.source, row.priority, row.meta_json, row.created_at, row.updated_at]);
    return row;
  }
  async listPlans(status?: LifePlanStatus): Promise<LifePlanRow[]> { return status ? await this.db.query('SELECT * FROM life_plans WHERE status=? ORDER BY priority DESC,COALESCE(planned_start,created_at)', [status]) : await this.db.query(`SELECT * FROM life_plans ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,priority DESC,COALESCE(planned_start,created_at)`); }
  async getPlan(id: string): Promise<LifePlanRow | undefined> { return await queryOne(this.db, 'SELECT * FROM life_plans WHERE id=?', [id]); }
  async updatePlan(id: string, patch: Partial<Pick<LifePlanRow, 'title' | 'kind' | 'planned_start' | 'planned_end' | 'status' | 'priority'>> & { meta?: Record<string, unknown> }): Promise<LifePlanRow | undefined> {
    const current = await this.getPlan(id); if (!current) return undefined;
    const next = { ...current, ...patch, meta_json: patch.meta ? JSON.stringify({ ...safeJson(current.meta_json, {}), ...patch.meta }) : current.meta_json, updated_at: nowIso(this.now) };
    await this.db.run('UPDATE life_plans SET title=?,kind=?,planned_start=?,planned_end=?,status=?,priority=?,meta_json=?,updated_at=? WHERE id=?', [next.title, next.kind, next.planned_start, next.planned_end, next.status, next.priority, next.meta_json, next.updated_at, id]);
    return next;
  }
  async recordEvent(input: LifeEventInput): Promise<LifeEventRow> { const timestamp = nowIso(this.now); const row = lifeEventRow(input, timestamp); await this.db.run(`INSERT INTO life_events(id,plan_id,log_id,event_type,activity,kind,description,mood_before,mood_after,happened_at,shareable,shared_at,meta_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`, [row.id,row.plan_id,row.log_id,row.event_type,row.activity,row.kind,row.description,row.mood_before,row.mood_after,row.happened_at,row.shareable,row.meta_json,row.created_at]); return row; }
  async events(limit = 50): Promise<LifeEventRow[]> { return await this.db.query('SELECT * FROM life_events ORDER BY happened_at DESC LIMIT ?', [clampInteger(limit, 1, 200)]); }
  async unsharedEvents(limit = 5): Promise<LifeEventRow[]> { return await this.db.query("SELECT * FROM life_events WHERE shareable=1 AND shared_at IS NULL ORDER BY happened_at DESC LIMIT ?", [clampInteger(limit, 1, 50)]); }
  async clearAll(): Promise<void> { await runTransaction(this.db, [runOperation('DELETE FROM life_events'),runOperation('DELETE FROM life_log'),runOperation('DELETE FROM life_state'),runOperation('DELETE FROM life_plans')]); }
}

function lifeEventRow(input: LifeEventInput, timestamp: string): LifeEventRow { return { id: newId('life_event'), plan_id: input.planId ?? null, log_id: input.logId ?? null, event_type: input.eventType, activity: input.activity, kind: input.kind, description: input.description, mood_before: input.moodBefore ?? null, mood_after: input.moodAfter ?? null, happened_at: input.happenedAt, shareable: input.shareable ? 1 : 0, shared_at: null, meta_json: JSON.stringify(input.meta ?? {}), created_at: timestamp }; }
function lifeEventOperation(row: LifeEventRow) { return runOperation(`INSERT INTO life_events(id,plan_id,log_id,event_type,activity,kind,description,mood_before,mood_after,happened_at,shareable,shared_at,meta_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`, [row.id,row.plan_id,row.log_id,row.event_type,row.activity,row.kind,row.description,row.mood_before,row.mood_after,row.happened_at,row.shareable,row.meta_json,row.created_at]); }

function shareCandidateOperation(event: LifeEventRow, timestamp: string) {
  const occurredAt = Date.parse(event.happened_at);
  const expiresAt = new Date(Math.max(occurredAt + 7 * 86_400_000, Date.parse(timestamp) + 3_600_000)).toISOString();
  const meta = JSON.stringify({ activity: event.activity, occurredAt: event.happened_at, topicKey: event.kind });
  return runOperation(`INSERT INTO life_share_candidates(id,source_type,source_id,novelty,relevance_to_user,emotional_value,urgency,repetition_penalty,status,created_at,expires_at,shared_at,meta_json)
    VALUES(?,?,?,?,?,?,?,?,'pending',?,?,NULL,?)`, [newId('share'), 'event', event.id, noveltyForLifeKind(event.kind), 0.5, 0.45, 0.1, 0, timestamp, expiresAt, meta]);
}

function noveltyForLifeKind(kind: string): number {
  switch (kind) {
    case 'play': return 0.8;
    case 'out': return 0.7;
    case 'meal': return 0.55;
    case 'chore': return 0.45;
    default: return 0.35;
  }
}

export interface LifeVitalsRow { energy:number; hunger:number; stress:number; social_need:number; loneliness:number; curiosity:number; comfort:number; focus:number; sleep_debt:number; updated_at:string; meta_json:string; }
export interface LifeDayThemeRow { id:string; local_date:string; theme:string; tone_tags_json:string; source_factors_json:string; created_at:string; }
export interface LifeThreadRow { id:string; title:string; category:string; status:'open'|'paused'|'resolved'|'abandoned'; progress:number; importance:number; heat:number; started_at:string; updated_at:string; last_advanced_at:string|null; next_actions_json:string; meta_json:string; }
export interface LifeActivityUsageRow { activity_id:string; last_used_at:string|null; use_count_7d:number; use_count_30d:number; consecutive_days:number; semantic_tags_json:string; recent_outcomes_json:string; updated_at:string; }
export interface LifeShareCandidateRow { id:string; source_type:'event'|'plan'|'thread'|'mood'|'follow_up'; source_id:string; novelty:number; relevance_to_user:number; emotional_value:number; urgency:number; repetition_penalty:number; status:'pending'|'shared'|'expired'|'suppressed'; created_at:string; expires_at:string; shared_at:string|null; meta_json:string; }

export class LifeV2Repo {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}
  async getVitals(): Promise<LifeVitalsRow|undefined> { return await queryOne(this.db,'SELECT energy,hunger,stress,social_need,loneliness,curiosity,comfort,focus,sleep_debt,updated_at,meta_json FROM life_vitals WHERE id=1'); }
  async upsertVitals(v: Omit<LifeVitalsRow,'updated_at'> & {updated_at?:string}): Promise<void> { const ts=v.updated_at??nowIso(this.now); await this.db.run(`INSERT INTO life_vitals(id,energy,hunger,stress,social_need,loneliness,curiosity,comfort,focus,sleep_debt,updated_at,meta_json) VALUES(1,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET energy=excluded.energy,hunger=excluded.hunger,stress=excluded.stress,social_need=excluded.social_need,loneliness=excluded.loneliness,curiosity=excluded.curiosity,comfort=excluded.comfort,focus=excluded.focus,sleep_debt=excluded.sleep_debt,updated_at=excluded.updated_at,meta_json=excluded.meta_json`,[v.energy,v.hunger,v.stress,v.social_need,v.loneliness,v.curiosity,v.comfort,v.focus,v.sleep_debt,ts,v.meta_json??'{}']); }
  async themeFor(localDate:string):Promise<LifeDayThemeRow|undefined>{return await queryOne(this.db,'SELECT * FROM life_day_themes WHERE local_date=?',[localDate]);}
  async recentThemes(limit=14):Promise<LifeDayThemeRow[]>{return await this.db.query('SELECT * FROM life_day_themes ORDER BY local_date DESC LIMIT ?',[clampInteger(limit,1,100)]);}
  async saveTheme(input:{localDate:string;theme:string;toneTags:string[];sourceFactors:string[]}):Promise<LifeDayThemeRow>{const row={id:newId('theme'),local_date:input.localDate,theme:input.theme,tone_tags_json:JSON.stringify(input.toneTags),source_factors_json:JSON.stringify(input.sourceFactors),created_at:nowIso(this.now)};await this.db.run(`INSERT INTO life_day_themes(id,local_date,theme,tone_tags_json,source_factors_json,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(local_date) DO UPDATE SET theme=excluded.theme,tone_tags_json=excluded.tone_tags_json,source_factors_json=excluded.source_factors_json`,[row.id,row.local_date,row.theme,row.tone_tags_json,row.source_factors_json,row.created_at]);return (await this.themeFor(input.localDate))!;}
  async threads(status?:string):Promise<LifeThreadRow[]>{return status?await this.db.query('SELECT * FROM life_threads WHERE status=? ORDER BY heat DESC,updated_at DESC',[status]):await this.db.query('SELECT * FROM life_threads ORDER BY heat DESC,updated_at DESC LIMIT 50');}
  async getThread(id:string):Promise<LifeThreadRow|undefined>{return await queryOne(this.db,'SELECT * FROM life_threads WHERE id=?',[id]);}
  async saveThread(input:{id?:string;title:string;category:string;status?:LifeThreadRow['status'];progress?:number;importance?:number;heat?:number;nextActions?:string[];meta?:Record<string,unknown>}):Promise<LifeThreadRow>{const existing=input.id?await this.getThread(input.id):undefined;const ts=nowIso(this.now);const row:LifeThreadRow=existing?{...existing,title:input.title,category:input.category,status:input.status??existing.status,progress:input.progress??existing.progress,importance:input.importance??existing.importance,heat:input.heat??existing.heat,next_actions_json:JSON.stringify(input.nextActions??safeJson(existing.next_actions_json,[])),meta_json:JSON.stringify({...safeJson(existing.meta_json,{}),...(input.meta??{})}),updated_at:ts,last_advanced_at:input.status?ts:existing.last_advanced_at}:{id:newId('thread'),title:input.title,category:input.category,status:input.status??'open',progress:input.progress??0,importance:input.importance??0.5,heat:input.heat??0.3,started_at:ts,updated_at:ts,last_advanced_at:null,next_actions_json:JSON.stringify(input.nextActions??[]),meta_json:JSON.stringify(input.meta??{})};await this.db.run(`INSERT INTO life_threads(id,title,category,status,progress,importance,heat,started_at,updated_at,last_advanced_at,next_actions_json,meta_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,category=excluded.category,status=excluded.status,progress=excluded.progress,importance=excluded.importance,heat=excluded.heat,updated_at=excluded.updated_at,last_advanced_at=excluded.last_advanced_at,next_actions_json=excluded.next_actions_json,meta_json=excluded.meta_json`,[row.id,row.title,row.category,row.status,row.progress,row.importance,row.heat,row.started_at,row.updated_at,row.last_advanced_at,row.next_actions_json,row.meta_json]);return row;}
  async getUsage(activityId:string):Promise<LifeActivityUsageRow|undefined>{return await queryOne(this.db,'SELECT * FROM life_activity_usage WHERE activity_id=?',[activityId]);}
  async recordUsage(input:{activityId:string;tags:string[];outcomeTags:string[];usedAt:string}):Promise<void>{const existing=await this.getUsage(input.activityId);const usedDay=input.usedAt.slice(0,10);const lastDay=existing?.last_used_at?.slice(0,10)??null;const consecutive=existing&&lastDay===usedDay?existing.consecutive_days:existing&&lastDay===previousDay(usedDay)?existing.consecutive_days+1:1;const tags=[...new Set([...(existing?safeJson<string[]>(existing.semantic_tags_json,[]):[]),...input.tags])].slice(0,12);const outcomes=[...(existing?safeJson<string[]>(existing.recent_outcomes_json,[]).slice(0,8):[]),...input.outcomeTags.slice(0,3)].slice(0,12);await this.db.run(`INSERT INTO life_activity_usage(activity_id,last_used_at,use_count_7d,use_count_30d,consecutive_days,semantic_tags_json,recent_outcomes_json,updated_at) VALUES(?,?,1,1,?,?,?,?) ON CONFLICT(activity_id) DO UPDATE SET last_used_at=excluded.last_used_at,use_count_7d=CASE WHEN julianday(excluded.last_used_at)-julianday(life_activity_usage.last_used_at)>7 THEN 1 ELSE life_activity_usage.use_count_7d+1 END,use_count_30d=CASE WHEN julianday(excluded.last_used_at)-julianday(life_activity_usage.last_used_at)>30 THEN 1 ELSE life_activity_usage.use_count_30d+1 END,consecutive_days=excluded.consecutive_days,semantic_tags_json=excluded.semantic_tags_json,recent_outcomes_json=excluded.recent_outcomes_json,updated_at=excluded.updated_at`,[input.activityId,input.usedAt,consecutive,JSON.stringify(tags),JSON.stringify(outcomes),input.usedAt]);}
  async recentActivityUsage(limit:number):Promise<LifeActivityUsageRow[]>{return await this.db.query('SELECT * FROM life_activity_usage ORDER BY last_used_at DESC LIMIT ?',[clampInteger(limit,1,30)]);}
  async shareCandidates(status?:string,limit=20):Promise<LifeShareCandidateRow[]>{return status?await this.db.query('SELECT * FROM life_share_candidates WHERE status=? ORDER BY created_at DESC LIMIT ?',[status,limit]):await this.db.query('SELECT * FROM life_share_candidates ORDER BY created_at DESC LIMIT ?',[limit]);}
  async pendingCandidates():Promise<LifeShareCandidateRow[]>{return await this.db.query(`SELECT * FROM life_share_candidates WHERE status='pending' AND expires_at>? ORDER BY (novelty+relevance_to_user+emotional_value+urgency-repetition_penalty) DESC LIMIT 10`,[nowIso(this.now)]);}
  async addShareCandidate(input:{sourceType:LifeShareCandidateRow['source_type'];sourceId:string;novelty:number;relevanceToUser:number;emotionalValue:number;urgency:number;repetitionPenalty:number;expiresAt:string;meta?:Record<string,unknown>}):Promise<LifeShareCandidateRow>{const row:LifeShareCandidateRow={id:newId('share'),source_type:input.sourceType,source_id:input.sourceId,novelty:input.novelty,relevance_to_user:input.relevanceToUser,emotional_value:input.emotionalValue,urgency:input.urgency,repetition_penalty:input.repetitionPenalty,status:'pending',created_at:nowIso(this.now),expires_at:input.expiresAt,shared_at:null,meta_json:JSON.stringify(input.meta??{})};await this.db.run(`INSERT INTO life_share_candidates(id,source_type,source_id,novelty,relevance_to_user,emotional_value,urgency,repetition_penalty,status,created_at,expires_at,shared_at,meta_json) VALUES(?,?,?,?,?,?,?,?,'pending',?,?,NULL,?)`,[row.id,row.source_type,row.source_id,row.novelty,row.relevance_to_user,row.emotional_value,row.urgency,row.repetition_penalty,row.created_at,row.expires_at,row.meta_json]);return row;}
  async updateShareCandidate(id:string,patch:Partial<Pick<LifeShareCandidateRow,'status'|'shared_at'>>):Promise<void>{await this.db.run('UPDATE life_share_candidates SET status=COALESCE(?,status),shared_at=COALESCE(?,shared_at) WHERE id=?',[patch.status??null,patch.shared_at??null,id]);}
  async expireShareCandidates():Promise<number>{return(await this.db.run("UPDATE life_share_candidates SET status='expired' WHERE status='pending' AND expires_at<=?",[nowIso(this.now)])).changes;}
  async markSharedBySource(sourceType:string,sourceId:string):Promise<void>{await this.db.run("UPDATE life_share_candidates SET status='shared',shared_at=? WHERE source_type=? AND source_id=? AND status='pending'",[nowIso(this.now),sourceType,sourceId]);}
}

function previousDay(value:string):string{const date=new Date(`${value}T00:00:00Z`);date.setUTCDate(date.getUTCDate()-1);return date.toISOString().slice(0,10);}
