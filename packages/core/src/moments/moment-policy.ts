export interface MomentCandidate {
  id: string;
  activity: string;
  topic: string;
  occurredAt: string;
  status: 'pending' | 'queued' | 'shared';
  /** 0..1 aggregate share-candidate score used by the image planner. */
  importance?: number;
  meta?: Record<string, unknown>;
}

export interface MomentRecord {
  id: string;
  candidateId: string;
  topic: string;
  createdAt: string;
}

export interface AcceptedMomentCandidate extends MomentCandidate { createdAt: string; }
export type MomentRejectionReason = 'invalid_time' | 'already_shared' | 'recent_topic' | 'min_gap' | 'daily_cap' | 'provider_unavailable';

/** Pure catch-up filter. It never mutates durable candidates or fabricates timestamps. */
export class MomentPolicy {
  private readonly dailyCap: number;
  private readonly minGapMs: number;
  private readonly topicWindowMs: number;

  constructor(options: { dailyCap?: number; minGapMs?: number; topicWindowMs?: number } = {}) {
    this.dailyCap = options.dailyCap ?? 2;
    this.minGapMs = options.minGapMs ?? 90 * 60_000;
    this.topicWindowMs = options.topicWindowMs ?? 24 * 60 * 60_000;
  }

  select(candidates: MomentCandidate[], existing: MomentRecord[], now: Date, providerAvailable = true): {
    accepted: AcceptedMomentCandidate[];
    rejected: Array<{ id: string; reason: MomentRejectionReason }>;
  } {
    const accepted: AcceptedMomentCandidate[] = [];
    const rejected: Array<{ id: string; reason: MomentRejectionReason }> = [];
    const day = now.toISOString().slice(0, 10);
    const allTimes = existing.map((item) => Date.parse(item.createdAt)).filter(Number.isFinite);
    let dailyCount = existing.filter((item) => item.createdAt.slice(0, 10) === day).length;
    const sharedIds = new Set(existing.map((item) => item.candidateId));

    for (const candidate of [...candidates].filter((item) => item.status === 'pending').sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
      const at = Date.parse(candidate.occurredAt);
      if (!Number.isFinite(at) || at > now.getTime()) { rejected.push({ id: candidate.id, reason: 'invalid_time' }); continue; }
      if (sharedIds.has(candidate.id)) { rejected.push({ id: candidate.id, reason: 'already_shared' }); continue; }
      if (!providerAvailable) { rejected.push({ id: candidate.id, reason: 'provider_unavailable' }); continue; }
      const topic = normalizeTopic(candidate.topic);
      const duplicate = [...existing, ...accepted.map((item) => ({ id: item.id, candidateId: item.id, topic: item.topic, createdAt: item.createdAt }))]
        .some((item) => normalizeTopic(item.topic) === topic && Math.abs(at - Date.parse(item.createdAt)) <= this.topicWindowMs);
      if (duplicate) { rejected.push({ id: candidate.id, reason: 'recent_topic' }); continue; }
      if (allTimes.some((time) => Math.abs(time - at) < this.minGapMs)) { rejected.push({ id: candidate.id, reason: 'min_gap' }); continue; }
      if (dailyCount >= this.dailyCap) { rejected.push({ id: candidate.id, reason: 'daily_cap' }); continue; }
      accepted.push({ ...candidate, createdAt: candidate.occurredAt });
      allTimes.push(at);
      dailyCount += 1;
    }
    return { accepted, rejected };
  }
}

function normalizeTopic(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

