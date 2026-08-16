import { describe, expect, it } from 'vitest';
import { buildTaskHandlerMap, type CoreTaskHandlerDeps } from './handlers.js';
import { isRetryableJobError, retryDelayMs } from './retry-policy.js';

describe('durable task handler map', () => {
  it('registers every native maintenance handler from PR E', () => {
    const noop = async () => undefined;
    const deps = {
      'life.catchup': noop,
      'weather.refresh': noop,
      'moment.compose': noop,
      'moment.image': noop,
      'sticker.analyze': noop,
      'sticker.embed': noop,
      'media.extract_text': noop,
      'memory.commit': noop,
      'memory.reembed': noop,
      backup: noop
    } as CoreTaskHandlerDeps;
    const handlers = buildTaskHandlerMap(deps);

    expect(Object.keys(handlers).sort()).toEqual([
      'backup', 'life.catchup', 'media.extract_text', 'memory.commit', 'memory.reembed',
      'moment.compose', 'moment.image', 'sticker.analyze', 'sticker.embed', 'weather.refresh'
    ]);
  });

  it('classifies retryable transport/provider errors and grows backoff', () => {
    expect(isRetryableJobError(new Error('request timed out'))).toBe(true);
    expect(isRetryableJobError(new Error('HTTP 503'))).toBe(true);
    expect(isRetryableJobError(new Error('invalid payload'))).toBe(false);
    expect(retryDelayMs(1, 'weather.refresh')).toBeLessThan(retryDelayMs(3, 'weather.refresh'));
  });
});
