// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('native iOS chat layout contract', () => {
  it('lets Capacitor own safe areas and fills the resized body', async () => {
    const css = await readFile(fileURLToPath(new URL('./native.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/html\.sooya-native\s*\{[\s\S]*--sooya-safe-top:\s*0px;[\s\S]*--sooya-safe-bottom:\s*0px;/u);
    expect(css).toMatch(/html\.sooya-native \.app\s*\{[\s\S]*height:\s*100%;[\s\S]*min-height:\s*0;/u);
    expect(css).toMatch(/html\.sooya-native \.messages\s*\{[\s\S]*overflow-anchor:\s*none;[\s\S]*scroll-behavior:\s*auto;/u);
  });
});
