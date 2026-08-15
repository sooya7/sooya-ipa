import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Keep the narrow source contract beside the behavioral LocalCore regression test:
// connection details must survive the provisional save used before model discovery.
describe('native model admin provisional save', () => {
  it('persists connection details before a model is selected without enabling runtime use', () => {
    const source = readFileSync(path.resolve('src/app/local-core.ts'), 'utf8');
    expect(source).toContain("if (!provider || !baseUrl) { if (provider === 'none') await this.configRepo.removeProvider(capability); continue; }");
    expect(source).not.toContain("if (!provider || !baseUrl || !model) { if (provider === 'none') await this.configRepo.removeProvider(capability); continue; }");
    expect(source).toContain('enabled: Boolean(model)');
  });
});