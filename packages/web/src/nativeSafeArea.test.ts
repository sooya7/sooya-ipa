// Safe-area contract: the whole app reads exactly one variable
// (--sooya-safe-top). These text assertions keep future edits from
// reintroducing per-page env() lookups that drift from the native fallback.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('native safe-area contract', () => {
  it('defines --sooya-safe-top exactly once per stylesheet with a native fallback', async () => {
    const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
    const native = await readFile(new URL('./native.css', import.meta.url), 'utf8');
    expect(styles.match(/--sooya-safe-top:/g)).toHaveLength(1);
    expect(native.match(/--sooya-safe-top:/g)).toHaveLength(1);
    expect(native).toContain('max(env(safe-area-inset-top, 0px), var(--sooya-native-top-fallback))');
    expect(native).toContain('--sooya-native-top-fallback: 47px');
  });

  it('lets every fixed top element consume the variable instead of env()', async () => {
    // Only the two variable-definition stylesheets may mention the env inset.
    const allowed = new Set(['styles.css', 'native.css']);
    const files = ['styles.css', 'native.css', './components/ChatHeader.css', './components/AdminPanel.css', './components/overlays.css'];
    for (const file of files) {
      const css = await readFile(new URL(file, import.meta.url), 'utf8');
      if (!allowed.has(file)) expect(css).not.toMatch(/env\(safe-area-inset-top/);
    }
    expect(await readFile(new URL('./styles.css', import.meta.url), 'utf8')).toMatch(/--sooya-safe-top: env\(safe-area-inset-top, 0px\)/);
  });
});
