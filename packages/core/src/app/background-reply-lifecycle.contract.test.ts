import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('background reply lifecycle contract', () => {
  it('pauses optional foreground work without cancelling an in-flight user reply', async () => {
    const source = await readFile(new URL('./local-core.ts', import.meta.url), 'utf8');
    const match = source.match(/async onAppInactive\(\): Promise<void> \{([\s\S]*?)\n  \}/u);
    expect(match).not.toBeNull();
    const body = match?.[1] ?? '';

    expect(body).toContain('await this.scheduler.deactivate()');
    expect(body).toContain("await this.options.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')");
    expect(body).not.toContain('this.replies.interruptAll');
    expect(source).not.toContain("this.replies.interruptAll('app_inactive')");
  });
});
