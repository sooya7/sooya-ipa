import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const NOTICE = read('./AdminNotice.css');
const MAIN = read('../main.tsx');

describe('admin action notice placement', () => {
  it('loads the floating notice override after the base admin styles', () => {
    const base = MAIN.indexOf("./components/AdminPanel.css");
    const notice = MAIN.indexOf("./components/AdminNotice.css");
    expect(base).toBeGreaterThanOrEqual(0);
    expect(notice).toBeGreaterThan(base);
  });

  it('keeps notices fixed inside the visible viewport with iOS safe-area spacing', () => {
    expect(NOTICE).toMatch(/\.admin-v2 \.admin-inline-error\s*\{[^}]*position:\s*fixed;/s);
    expect(NOTICE).toMatch(/bottom:\s*max\([^;]*safe-area-inset-bottom/s);
    expect(NOTICE).toContain('z-index: 1200;');
    expect(NOTICE).toMatch(/@media \(max-width:\s*760px\)/);
  });
});
