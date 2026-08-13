import { describe, expect, it } from 'vitest';
import { MomentPolicy, type MomentCandidate, type MomentRecord } from './moment-policy.js';

function candidate(id: string, occurredAt: string, topic = id): MomentCandidate {
  return { id, activity: `activity-${id}`, topic, occurredAt, status: 'pending' };
}

describe('MomentPolicy', () => {
  it('orders historical candidates and keeps their original event time', () => {
    const policy = new MomentPolicy({ dailyCap: 3, minGapMs: 30 * 60_000 });
    const selected = policy.select([
      candidate('later', '2026-08-13T14:18:00.000Z'),
      candidate('earlier', '2026-08-13T12:41:00.000Z')
    ], [], new Date('2026-08-13T15:00:00.000Z'));

    expect(selected.accepted.map((item) => [item.id, item.createdAt])).toEqual([
      ['earlier', '2026-08-13T12:41:00.000Z'],
      ['later', '2026-08-13T14:18:00.000Z']
    ]);
  });

  it('deduplicates topic, applies min gap and daily cap without changing candidates', () => {
    const policy = new MomentPolicy({ dailyCap: 2, minGapMs: 60 * 60_000 });
    const existing: MomentRecord[] = [{ id: 'm1', candidateId: 'old', topic: 'coffee', createdAt: '2026-08-13T09:00:00.000Z' }];
    const candidates = [
      candidate('duplicate', '2026-08-13T10:30:00.000Z', 'coffee'),
      candidate('too-close', '2026-08-13T09:20:00.000Z', 'book'),
      candidate('ok', '2026-08-13T11:40:00.000Z', 'walk'),
      candidate('capped', '2026-08-13T14:00:00.000Z', 'shop')
    ];

    const result = policy.select(candidates, existing, new Date('2026-08-13T15:00:00.000Z'));

    expect(result.accepted.map((item) => item.id)).toEqual(['ok']);
    expect(result.rejected).toEqual(expect.arrayContaining([
      { id: 'duplicate', reason: 'recent_topic' },
      { id: 'too-close', reason: 'min_gap' },
      { id: 'capped', reason: 'daily_cap' }
    ]));
    expect(candidates.every((item) => item.status === 'pending')).toBe(true);
  });

  it('leaves valuable candidates pending when the provider is unavailable', () => {
    const policy = new MomentPolicy();
    const result = policy.select([candidate('walk', '2026-08-13T12:00:00.000Z')], [], new Date('2026-08-13T15:00:00.000Z'), false);

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ id: 'walk', reason: 'provider_unavailable' }]);
  });
});

