import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(packageRoot, 'src');

async function productionSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(target);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [target] : [];
  }));
  return files.flat();
}

describe('Node import boundary', () => {
  it('loads every public entrypoint without server implementation packages', async () => {
    await expect(Promise.all([
      import('../src/tools/index.js'),
      import('../src/providers/types.js'),
      import('../src/platform/index.js'),
      import('../src/util/tool-history.js')
    ])).resolves.toHaveLength(4);
  });

  it('keeps forbidden Node and server dependencies out of production sources', async () => {
    const files = await productionSources(sourceRoot);
    const forbidden = [
      ['Fastify', /(?:from\s+|import\s*)['"](?:@fastify\/[^'"]+|fastify)['"]/u],
      ['SQLite native binding', /(?:from\s+|import\s*)['"]better-sqlite3['"]/u],
      ['Node filesystem/path/os', /(?:from\s+|import\s*)['"](?:node:)?(?:fs(?:\/promises)?|path|os)['"]/u],
      ['environment globals', /\bprocess\.env\b/u],
      ['image native binding', /(?:from\s+|import\s*)['"]sharp['"]/u],
      ['server logger', /(?:from\s+|import\s*)['"]pino(?:-pretty)?['"]/u],
      ['Node byte type', /\bBuffer\b/u]
    ] as const;
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const [label, pattern] of forbidden) {
        if (pattern.test(source)) violations.push(`${path.relative(packageRoot, file)}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('publishes only source files inside the portable package', async () => {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
      name?: string;
      dependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
    };
    expect(manifest.name).toBe('@sooya/core');
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(Object.keys(manifest.exports ?? {})).toEqual(['.', './tools', './providers', './platform', './util/tool-history', './app']);
  });
});
