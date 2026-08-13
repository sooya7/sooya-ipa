export interface LocalEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  seq: number;
  type: string;
  data: T;
  createdAt: string;
}

export type LocalEventListener = (event: LocalEvent) => void;

export interface LocalEventBusOptions {
  now?: () => Date;
  onListenerError?: (error: unknown, event: LocalEvent) => void;
}

/** Synchronous, ordered process-local replacement for the server SSE bus. */
export class LocalEventBus {
  private readonly listeners = new Set<LocalEventListener>();
  private readonly queue: LocalEvent[] = [];
  private nextSeq = 1;
  private dispatching = false;
  private readonly now: () => Date;
  private readonly onListenerError: (error: unknown, event: LocalEvent) => void;

  constructor(options: LocalEventBusOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.onListenerError = options.onListenerError ?? (() => undefined);
  }

  get lastSequence(): number { return this.nextSeq - 1; }

  subscribe(listener: LocalEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit<T extends Record<string, unknown>>(type: string, data: T): LocalEvent<T> {
    const event: LocalEvent<T> = {
      seq: this.nextSeq++,
      type,
      data,
      createdAt: this.now().toISOString()
    };
    this.queue.push(event);
    this.drain();
    return event;
  }

  private drain(): void {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        for (const listener of [...this.listeners]) {
          try {
            listener(event);
          } catch (error) {
            this.onListenerError(error, event);
          }
        }
      }
    } finally {
      this.dispatching = false;
    }
  }
}

