import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('MiMo chat thinking compatibility', () => {
  it('disables implicit MiMo thinking in both complete and streaming OpenAI payloads', async () => {
    const source = await readFile(new URL('./builtin.ts', import.meta.url), 'utf8');
    expect(source).toContain("...openAiVendorBody(this.config)");
    expect(source.match(/\...openAiVendorBody\(this\.config\)/gu)).toHaveLength(2);
    expect(source).toContain("thinking: { type: 'disabled' }");
    expect(source).toContain("config.options.thinking");
    expect(source).toContain("thinking.type === 'enabled' || thinking.type === 'disabled'");
  });
});
