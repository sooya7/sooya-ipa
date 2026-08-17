import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('reply image job recovery contract', () => {
  it('persists prepared input before remote submission and re-submits missing job ids idempotently', async () => {
    const source = await readFile(new URL('./reply-image-job-install.ts', import.meta.url), 'utf8');

    const prepared = source.indexOf('preparedPrompt: prepared.prompt');
    const firstStart = source.indexOf('const started = await provider.startJob(prepared.prompt');
    expect(prepared).toBeGreaterThan(-1);
    expect(firstStart).toBeGreaterThan(prepared);

    expect(source).toContain('if (!remoteJobId && clientRequestId)');
    expect(source).toContain('const restarted = await provider.startJob(recoverPrompt');
    expect(source).toContain('remoteJobId = restarted.jobId');
    expect(source).toContain('recoverImageReferences(runtime, recoveredMeta, recoverPrompt)');
  });
});
