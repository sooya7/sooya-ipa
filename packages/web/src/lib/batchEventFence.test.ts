import { describe, expect, it } from 'vitest';
import { acceptBatchEvent } from './batchEventFence.js';

describe('acceptBatchEvent', () => {
  it('rejects every late event for a revision after completion', () => {
    const seen = new Map<string, number>();
    const terminal = new Map<string, number>();

    expect(acceptBatchEvent(seen, terminal, { batchId: 'batch-1', revision: 1 })).toBe(true);
    expect(acceptBatchEvent(seen, terminal, { batchId: 'batch-1', revision: 1 }, true)).toBe(true);

    // A delayed app_inactive interruption for the already-completed revision
    // must not resurrect a failure card or clear the successful UI state.
    expect(acceptBatchEvent(seen, terminal, { batchId: 'batch-1', revision: 1 }, true)).toBe(false);
    expect(acceptBatchEvent(seen, terminal, { batchId: 'batch-1', revision: 1 })).toBe(false);

    // A newer revision still owns the batch normally.
    expect(acceptBatchEvent(seen, terminal, { batchId: 'batch-1', revision: 2 })).toBe(true);
    expect(acceptBatchEvent(seen, terminal, { batchId: 'batch-1', revision: 2 }, true)).toBe(true);
  });
});
