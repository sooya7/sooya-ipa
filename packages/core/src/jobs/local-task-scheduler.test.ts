import { describe, expect, it, vi } from 'vitest';
import { LocalTaskScheduler, TASK_PRIORITY, type DurableTask, type DurableTaskStore } from './local-task-scheduler.js';

function task(id: string, type: DurableTask['type'], state: DurableTask['state'] = 'pending'): DurableTask {
  return { id, type, state, priority: TASK_PRIORITY[type], attempts: 0, maxAttempts: 3, createdAt: id, updatedAt: id };
}

function store(rows: DurableTask[]) {
  const claimed: string[] = [];
  const completed: string[] = [];
  const failed: string[] = [];
  const recovered: string[] = [];
  const api: DurableTaskStore = {
    recoverRunning: vi.fn(async () => { for (const row of rows) if (row.state === 'running') { row.state = 'pending'; recovered.push(row.id); } return recovered.length; }),
    claimNext: vi.fn(async () => {
      const next = rows.filter((row) => row.state === 'pending').sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))[0];
      if (!next) return null;
      next.state = 'running'; claimed.push(next.id); return { ...next };
    }),
    complete: vi.fn(async (id) => { completed.push(id); const row = rows.find((item) => item.id === id); if (row) row.state = 'completed'; }),
    fail: vi.fn(async (id) => { failed.push(id); const row = rows.find((item) => item.id === id); if (row) row.state = 'failed'; })
  };
  return { api, claimed, completed, failed, recovered };
}

describe('LocalTaskScheduler', () => {
  it('recovers interrupted work and drains chat before maintenance', async () => {
    const state = store([task('old', 'memory.maintenance', 'running'), task('moment', 'moment.image'), task('chat', 'reply.generate')]);
    const order: string[] = [];
    const scheduler = new LocalTaskScheduler({ store: state.api, handlers: {
      'reply.generate': async (job) => { order.push(job.id); },
      'moment.image': async (job) => { order.push(job.id); },
      'memory.maintenance': async (job) => { order.push(job.id); }
    } });

    await scheduler.activate();
    await scheduler.whenIdle();

    expect(state.recovered).toEqual(['old']);
    expect(order).toEqual(['chat', 'moment', 'old']);
    expect(state.completed).toEqual(order);
  });

  it('does not claim while inactive and aborts optional network work on deactivation', async () => {
    const state = store([task('moment', 'moment.image')]);
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new LocalTaskScheduler({ store: state.api, handlers: {
      'moment.image': async (_job, nextSignal) => { signal = nextSignal; await held; }
    } });

    await Promise.resolve();
    expect(state.claimed).toEqual([]);
    const active = scheduler.activate();
    await vi.waitFor(() => expect(signal).toBeDefined());
    await scheduler.deactivate();
    expect(signal!.aborted).toBe(true);
    release();
    await active;
  });

  it('has no push task and exposes the specified priority ordering', () => {
    expect('push.reply' in TASK_PRIORITY).toBe(false);
    expect(TASK_PRIORITY['reply.generate']).toBeGreaterThan(TASK_PRIORITY['memory.commit']);
    expect(TASK_PRIORITY['memory.commit']).toBeGreaterThan(TASK_PRIORITY['moment.compose']);
    expect(TASK_PRIORITY['moment.compose']).toBeGreaterThan(TASK_PRIORITY['memory.maintenance']);
  });
});

