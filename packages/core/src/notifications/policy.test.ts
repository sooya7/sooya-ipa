import { describe, expect, it } from 'vitest';
import { NotificationPolicy, sanitizeBody } from './policy.js';
import type { NotificationEvent, NotificationPolicyState } from './types.js';

function state(patch: Partial<NotificationPolicyState> = {}): NotificationPolicyState {
  return {
    permission: { supported: true, enabled: true, granted: true },
    foregroundSuppression: true,
    quietHours: null,
    dailyCap: 5,
    recent: [],
    maxBodyLength: 120,
    ...patch
  };
}

function event(patch: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    type: 'reply.completed',
    id: 'reply-1',
    at: new Date('2026-08-13T10:00:00.000Z'),
    appActive: false,
    body: '我回复你了 [[sticker:开心]]，晚点见',
    ...patch
  };
}

describe('NotificationPolicy', () => {
  const policy = new NotificationPolicy();

  it('allows reply.completed while the app is inactive and sanitizes private markers', () => {
    const decision = policy.decide(event(), state());
    expect(decision.allow).toBe(true);
    expect(decision.body).toBe('我回复你了 ，晚点见');
    expect(decision.dedupeKey).toBe('reply.completed:reply-1');
  });

  it('suppresses foreground notifications and respects quiet hours', () => {
    expect(policy.decide(event({ appActive: true }), state()).reason).toBe('foreground');
    expect(policy.decide(event({ at: new Date('2026-08-13T02:00:00.000Z') }), state({ quietHours: { fromHour: 9, toHour: 12, timeZone: 'Asia/Shanghai' } })).reason).toBe('quiet_hours');
  });

  it('enforces daily cap and duplicate suppression', () => {
    const history = [{ key: 'reply.completed:old', at: '2026-08-13T09:00:00.000Z' }, { key: 'reply.completed:old2', at: '2026-08-13T09:30:00.000Z' }];
    expect(policy.decide(event(), state({ dailyCap: 2, recent: history })).reason).toBe('daily_cap');
    expect(policy.decide(event(), state({ recent: [{ key: 'reply.completed:reply-1', at: '2026-08-13T09:00:00.000Z' }] })).reason).toBe('duplicate');
  });

  it('degrades gracefully when permission is unsupported or denied', () => {
    expect(policy.decide(event(), state({ permission: { supported: false, enabled: true, granted: true } })).reason).toBe('not_supported');
    expect(policy.decide(event(), state({ permission: { supported: true, enabled: false, granted: true } })).reason).toBe('denied');
    expect(policy.decide(event(), state({ permission: { supported: true, enabled: true, granted: false } })).reason).toBe('denied');
  });

  it('truncates bodies and strips control characters', () => {
    expect(sanitizeBody('a\n\u0000b'.repeat(100), 12)).toHaveLength(12);
  });
});
