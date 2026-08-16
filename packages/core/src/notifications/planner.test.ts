import { describe, expect, it } from 'vitest';
import { NotificationPlanner } from './planner.js';
import type { LocalNotificationScheduler, NotificationPolicyState } from './types.js';

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

describe('NotificationPlanner', () => {
  it('schedules allowed events and records a privacy-safe delivery key', async () => {
    const scheduled: unknown[] = [];
    const deliveries: Array<{ key: string; at: string }> = [];
    const scheduler: LocalNotificationScheduler = {
      schedule: async (input) => { scheduled.push(input); },
      cancel: async () => undefined,
      cancelAll: async () => undefined
    };
    const planner = new NotificationPlanner({
      scheduler,
      now: () => new Date('2026-08-13T10:00:00.000Z'),
      recordDelivery: async (entry) => { deliveries.push(entry); }
    });

    const result = await planner.plan({
      type: 'reply.completed',
      id: 'reply-1',
      at: new Date('2026-08-13T10:00:00.000Z'),
      appActive: false,
      body: '我回复你了'
    }, state());

    expect(result.scheduled).toBe(true);
    expect(scheduled[0]).toMatchObject({ title: 'SOOYA', body: '我回复你了' });
    expect(deliveries).toEqual([{ key: 'reply.completed:reply-1', at: '2026-08-13T10:00:00.000Z' }]);
  });

  it('does not touch the native scheduler when policy denies', async () => {
    let calls = 0;
    const scheduler: LocalNotificationScheduler = {
      schedule: async () => { calls += 1; },
      cancel: async () => undefined,
      cancelAll: async () => undefined
    };
    const planner = new NotificationPlanner({ scheduler });
    const result = await planner.plan({
      type: 'important_moment',
      id: 'moment-1',
      at: new Date('2026-08-13T10:00:00.000Z'),
      appActive: true,
      body: '新动态'
    }, state({ foregroundSuppression: true }));

    expect(result.scheduled).toBe(false);
    expect(result.decision.reason).toBe('foreground');
    expect(calls).toBe(0);
  });
});
