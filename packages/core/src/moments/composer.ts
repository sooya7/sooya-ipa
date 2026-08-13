import type { LifeV2Repo, LifeShareCandidateRow } from '../db/life.repo.js';
import type { MomentRepo } from '../db/moment.repo.js';
import type { ChatProvider } from '../providers/types.js';
import { MomentPolicy, type MomentCandidate, type MomentRecord } from './moment-policy.js';

export interface MomentComposeResult {
  accepted: number;
  rejected: number;
  created: string[];
}

/** Selects and persists a bounded local Moment chain; image generation stays optional. */
export class MomentComposer {
  constructor(private readonly options: { life: LifeV2Repo; moments: MomentRepo; provider?: ChatProvider | null | (() => Promise<ChatProvider | null>); policy?: MomentPolicy; now?: () => Date }) {}

  async compose(now = (this.options.now ?? (() => new Date()))()): Promise<MomentComposeResult> {
    const pending = await this.options.life.pendingCandidates();
    const existingRows = await this.options.moments.list(100);
    const existing: MomentRecord[] = existingRows.map((row) => ({ id: row.id, candidateId: row.candidate_id, topic: row.topic_key ?? row.activity, createdAt: row.created_at }));
    const candidates = pending.map(toCandidate);
    const selected = (this.options.policy ?? new MomentPolicy()).select(candidates, existing, now, true);
    const rejectedIds = new Set(selected.rejected.map((item) => item.id));
    for (const candidate of pending) if (rejectedIds.has(candidate.id)) await this.options.life.updateShareCandidate(candidate.id, { status: 'suppressed' }).catch(() => undefined);
    const created: string[] = [];
    const provider = typeof this.options.provider === 'function' ? await this.options.provider() : this.options.provider;
    for (const candidate of selected.accepted) {
      const source = pending.find((item) => item.id === candidate.id)!;
      const meta = parseMeta(source.meta_json);
      let text = `${candidate.activity}的时候，${String(meta.detail ?? '留下一点今天的痕迹')}`.trim();
      if (provider?.configured) {
        try {
          const result = await provider.complete({
            system: '为 SOOYA 写一句克制、具体、不夸张的生活动态，不要编造地点或人物。只输出一句中文。',
            messages: [{ role: 'user', content: [{ type: 'text', text: `活动：${candidate.activity}\n上下文：${JSON.stringify(meta)}` }] }],
            maxTokens: 120,
            temperature: 0.7
          });
          if (result.text.trim()) text = result.text.trim().slice(0, 240);
        } catch { /* deterministic text remains publishable */ }
      }
      const row = await this.options.moments.create({ candidateId: candidate.id, text, activity: candidate.activity, locationId: typeof meta.locationId === 'string' ? meta.locationId : null, locationName: typeof meta.locationName === 'string' ? meta.locationName : null, city: typeof meta.city === 'string' ? meta.city : null, topicKey: candidate.topic, sourceEventId: source.source_id, createdAt: candidate.createdAt, status: 'published' });
      await this.options.life.updateShareCandidate(source.id, { status: 'shared', shared_at: candidate.createdAt });
      created.push(row.id);
    }
    return { accepted: selected.accepted.length, rejected: selected.rejected.length, created };
  }
}

function toCandidate(row: LifeShareCandidateRow): MomentCandidate {
  const meta = parseMeta(row.meta_json);
  return { id: row.id, activity: typeof meta.activity === 'string' ? meta.activity : row.source_type, topic: typeof meta.topicKey === 'string' ? meta.topicKey : row.source_type, occurredAt: typeof meta.occurredAt === 'string' ? meta.occurredAt : row.created_at, status: 'pending' };
}

function parseMeta(value: string): Record<string, unknown> { try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
