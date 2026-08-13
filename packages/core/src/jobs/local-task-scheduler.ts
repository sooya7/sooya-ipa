export const TASK_PRIORITY = {
  'reply.generate': 100,
  'media.user': 95,
  'reply.tool': 90,
  'memory.commit': 80,
  'life.conversation': 75,
  'life.catchup': 70,
  'moment.compose': 60,
  'moment.image': 50,
  'weather.refresh': 30,
  'sticker.analyze': 20,
  'sticker.embed': 20,
  'media.extract_text': 20,
  'memory.reembed': 10,
  'memory.maintenance': 10,
  backup: 5
} as const;

export type DurableTaskType = keyof typeof TASK_PRIORITY;
export type DurableTaskState = 'pending' | 'running' | 'completed' | 'failed';

export interface DurableTask {
  id: string;
  type: DurableTaskType;
  state: DurableTaskState;
  priority: number;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  payload?: Record<string, unknown>;
}

export interface DurableTaskStore {
  recoverRunning(): Promise<number>;
  claimNext(): Promise<DurableTask | null>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string, retryable: boolean): Promise<void>;
}

export type DurableTaskHandler = (task: DurableTask, signal: AbortSignal) => Promise<void>;

const OPTIONAL_ON_INACTIVE = new Set<DurableTaskType>([
  'moment.compose', 'moment.image', 'weather.refresh', 'sticker.analyze', 'sticker.embed',
  'media.extract_text', 'memory.reembed', 'memory.maintenance', 'backup'
]);

/** Foreground-only durable scheduler; correctness never depends on iOS background execution. */
export class LocalTaskScheduler {
  private active = false;
  private loop: Promise<void> | null = null;
  private current: { task: DurableTask; controller: AbortController } | null = null;

  constructor(private readonly options: { store: DurableTaskStore; handlers: Partial<Record<DurableTaskType, DurableTaskHandler>> }) {}

  async activate(): Promise<void> {
    if (this.active) return this.loop ?? Promise.resolve();
    this.active = true;
    await this.options.store.recoverRunning();
    this.loop = this.drain();
    return this.loop;
  }

  async deactivate(): Promise<void> {
    this.active = false;
    if (this.current && OPTIONAL_ON_INACTIVE.has(this.current.task.type)) this.current.controller.abort('app_inactive');
  }

  async whenIdle(): Promise<void> { await this.loop; }

  private async drain(): Promise<void> {
    try {
      while (this.active) {
        const task = await this.options.store.claimNext();
        if (!task) break;
        const handler = this.options.handlers[task.type];
        if (!handler) {
          await this.options.store.fail(task.id, `no handler for ${task.type}`, false);
          continue;
        }
        const controller = new AbortController();
        this.current = { task, controller };
        try {
          await handler(task, controller.signal);
          if (!controller.signal.aborted) await this.options.store.complete(task.id);
          else await this.options.store.fail(task.id, 'interrupted', true);
        } catch (error) {
          await this.options.store.fail(task.id, safeError(error), !controller.signal.aborted && task.attempts + 1 < task.maxAttempts);
        } finally {
          if (this.current?.task.id === task.id) this.current = null;
        }
      }
    } finally {
      this.loop = null;
    }
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').slice(0, 300);
}
