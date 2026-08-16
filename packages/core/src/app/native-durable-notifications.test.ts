import { describe, expect, it, vi } from 'vitest';
import { migrateDatabase } from '../db/migrations.js';
import { NodeLocalDatabase } from '../../test/db/node-local-database.js';
import { LocalCore } from './local-core.js';
import type { LocalNotificationScheduler } from '../notifications/types.js';
import type { ChatMessage } from './types.js';

class FakeNotifications implements LocalNotificationScheduler {
  readonly scheduled: Array<{ id: number; title: string; body: string }> = [];
  async schedule(input: { id: number; title: string; body: string; scheduleAt?: Date; extra?: Record<string, unknown> }) { this.scheduled.push(input); }
  async cancel() {}
  async cancelAll() {}
}

function assistantMessage(): ChatMessage {
  return {
    id: 'assistant-notify-1',
    conversationId: 'main',
    role: 'assistant',
    createdAt: '2026-08-13T02:00:00.000Z',
    updatedAt: '2026-08-13T02:00:00.000Z',
    seq: 2,
    status: 'sent',
    clientMsgId: null,
    replyTo: null,
    error: null,
    content: [{ id: 'part-1', type: 'text', text: '我回复你了', mediaId: null, status: 'sent', error: null, duration: null, transcript: null, meta: {}, media: null }],
    meta: {}
  };
}

describe('native durable runtime and notifications', () => {
  it('drains due maintenance through the scheduler and stays idempotent', async () => {
    const db = new NodeLocalDatabase();
    await migrateDatabase(db);
    const now = new Date('2026-08-13T02:00:00.000Z');
    const core = new LocalCore({ db, now: () => now });

    await core.onAppActive();
    expect(await core.jobsRepo.pendingCount()).toBe(0);
    const firstRun = (await core.jobsRepo.list()).map((job) => job.type);

    await core.onAppActive();
    const secondRun = (await core.jobsRepo.list()).map((job) => job.type);
    expect(secondRun).toEqual(firstRun);
  });

  it('schedules reply.completed notifications only while inactive and permission is granted', async () => {
    const db = new NodeLocalDatabase();
    await migrateDatabase(db);
    const now = new Date('2026-08-13T02:00:00.000Z');
    const notifications = new FakeNotifications();
    const core = new LocalCore({ db, now: () => now, notificationScheduler: notifications });
    await core.configRepo.setNotificationCapabilities({
      localSupported: true,
      localEnabled: true,
      checkedAt: now.toISOString(),
      detail: { localPermission: 'granted' }
    });

    await core.onAppInactive();
    core.events.emit('reply.completed', { batchId: 'batch-1', revision: 1, message: assistantMessage(), model: 'fake' });
    await vi.waitFor(() => expect(notifications.scheduled.length).toBe(1));
    expect(notifications.scheduled[0]).toMatchObject({ title: 'SOOYA 回复了你', body: '我回复你了' });

    await core.onAppActive();
    const count = notifications.scheduled.length;
    core.events.emit('reply.completed', { batchId: 'batch-2', revision: 1, message: { ...assistantMessage(), id: 'assistant-notify-2' }, model: 'fake' });
    await vi.waitFor(() => expect(core.configRepo.notificationCapabilities()).resolves.toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notifications.scheduled.length).toBe(count);
  });
});
