import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Core database production boundary', () => {
  it('does not import better-sqlite3 from production sources', () => {
    const root = path.resolve(import.meta.dirname, '../../src/db');
    const sources = walk(root).filter((file) => file.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) expect(fs.readFileSync(file, 'utf8')).not.toMatch(/better-sqlite3/u);
  });
});

function walk(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

