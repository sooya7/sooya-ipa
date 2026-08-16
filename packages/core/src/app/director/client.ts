import type { ChatProvider } from '../../providers/types.js';
import { extractJsonObject } from '../../util/json-extract.js';
import type { DirectorEvent, DirectorRunRequest, DirectorRunResult, DirectorTask } from './types.js';

export interface DirectorClientOptions {
  onEvent?: (event: DirectorEvent) => void;
}

/** Distinguishes the client's own timeout from provider/transport errors. */
export class DirectorTimeoutError extends Error {
  override name = 'DirectorTimeoutError';
}

/**
 * The one gateway for small, structured media decisions (server parity).
 *
 * It deliberately reports only task names, sizes, timing and failure classes.
 * The input is untrusted data, so neither prompts nor user text are emitted.
 *
 * LocalCore adaptations from the server version:
 * - No Node typings (`NodeJS.Timeout` → `ReturnType<typeof setTimeout>`).
 * - The provider resolver may be async and may resolve null; both map to the
 *   `provider_unavailable` / `not_configured` failure classes → caller
 *   fallback. A timeout only triggers the director fallback; an external
 *   abort is always rethrown so a superseded reply never continues through
 *   a fallback path.
 */
export class DirectorClient {
  constructor(
    private readonly provider: () => ChatProvider | null | Promise<ChatProvider | null>,
    private readonly opts: DirectorClientOptions = {}
  ) {}

  async run<T>(request: DirectorRunRequest<T>): Promise<DirectorRunResult<T> | null> {
    const startedAt = Date.now();
    const emit = (event: DirectorEvent['event'], extra: Omit<DirectorEvent, 'event' | 'task'> = {}): void => {
      this.opts.onEvent?.({ event, task: request.task, ...extra });
    };
    emit('started', { inputChars: request.input.length });

    let provider: ChatProvider | null;
    try {
      provider = await this.provider();
    } catch (error) {
      return this.fail(request.task, startedAt, emit, 'provider_unavailable', error);
    }
    if (!provider || !provider.configured) {
      return this.fail(request.task, startedAt, emit, 'not_configured');
    }
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('director request aborted');

    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeExternalAbort = (): void => undefined;
    const timeoutError = new DirectorTimeoutError(`director ${request.task} timed out after ${request.timeoutMs}ms`);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutError);
        reject(timeoutError);
      }, request.timeoutMs);
    });
    const externalAbortPromise = request.signal
      ? new Promise<never>((_, reject) => {
          const abort = (): void => {
            controller.abort(request.signal?.reason);
            reject(request.signal?.reason ?? new Error('director request aborted'));
          };
          request.signal!.addEventListener('abort', abort, { once: true });
          removeExternalAbort = () => request.signal?.removeEventListener('abort', abort);
        })
      : null;

    const operation = provider.complete({
      system: request.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: request.input }] }],
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      jsonMode: true,
      signal: controller.signal
    });
    // A provider should honor AbortSignal, but attaching a rejection handler
    // prevents a late rejection after the task timeout from becoming unhandled.
    operation.catch(() => undefined);

    try {
      const result = await Promise.race([
        operation,
        timeoutPromise,
        ...(externalAbortPromise ? [externalAbortPromise] : [])
      ]);
      const decoded = request.decoder(extractJsonObject(result.text));
      if (!decoded) {
        return this.fail(request.task, startedAt, emit, 'invalid_json');
      }
      const latencyMs = Date.now() - startedAt;
      emit('completed', {
        latencyMs,
        outputChars: result.text.length,
        model: result.model || provider.name
      });
      return { data: decoded, model: result.model || provider.name, latencyMs };
    } catch (error) {
      // An external abort must propagate: a superseded reply may not continue
      // through a fallback path. Only timeouts / provider errors degrade.
      if (request.signal?.aborted && !timedOut) throw error;
      return this.fail(request.task, startedAt, emit, timedOut || error instanceof DirectorTimeoutError ? 'timeout' : errorName(error), error);
    } finally {
      if (timer) clearTimeout(timer);
      removeExternalAbort();
    }
  }

  recordFallback(task: DirectorTask, reason: string): void {
    this.opts.onEvent?.({ event: 'fallback', task, reason });
  }

  private fail(
    _task: DirectorTask,
    startedAt: number,
    emit: (event: DirectorEvent['event'], extra?: Omit<DirectorEvent, 'event' | 'task'>) => void,
    reason: string,
    _error?: unknown
  ): null {
    const latencyMs = Date.now() - startedAt;
    emit('failed', { latencyMs, reason });
    return null;
  }
}

function errorName(error: unknown): string {
  if (error instanceof DirectorTimeoutError) return 'timeout';
  if (error instanceof Error && error.name) return error.name.slice(0, 40);
  return 'provider_error';
}
