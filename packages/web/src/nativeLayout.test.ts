// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('native iOS layout contract', () => {
  it('lets Capacitor own safe areas and fills the resized chat body', async () => {
    const css = await readFile(fileURLToPath(new URL('./native.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/html\.sooya-native\s*\{[\s\S]*--sooya-safe-top:\s*0px;[\s\S]*--sooya-safe-bottom:\s*0px;/u);
    expect(css).toMatch(/html\.sooya-native \.app\s*\{[\s\S]*height:\s*100%;[\s\S]*min-height:\s*0;/u);
    expect(css).toMatch(/html\.sooya-native \.messages\s*\{[\s\S]*overflow-anchor:\s*none;[\s\S]*scroll-behavior:\s*auto;/u);
  });

  it('keeps the chat body locked while giving admin an explicit touch scroller', async () => {
    const css = await readFile(fileURLToPath(new URL('./native.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/html\.sooya-native body\s*\{[\s\S]*overflow:\s*hidden;/u);
    expect(css).toMatch(/html\.sooya-native \.admin-page\s*\{[\s\S]*height:\s*100%;[\s\S]*overflow-y:\s*auto;[\s\S]*-webkit-overflow-scrolling:\s*touch;/u);
    expect(css).toMatch(/html\.sooya-native \.admin-page\.admin-v2,[\s\S]*html\.sooya-native \.admin-page \.admin-shell\s*\{[\s\S]*min-height:\s*100%;/u);
  });
});
