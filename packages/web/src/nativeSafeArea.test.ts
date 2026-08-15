// Native iOS uses Capacitor contentInset=automatic, while the browser build owns its CSS env() safe area.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('native safe-area contract', () => {
  it('does not double-apply the iOS top or bottom safe area', async () => {
    const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
    const native = await readFile(new URL('./native.css', import.meta.url), 'utf8');
    expect(styles.match(/--sooya-safe-top:/g)).toHaveLength(1);
    expect(native.match(/--sooya-safe-top:/g)).toHaveLength(1);
    expect(native).toContain('--sooya-safe-top: 0px');
    expect(native).toContain('--sooya-safe-bottom: 0px');
    expect(native).not.toContain('--sooya-native-top-fallback');
    expect(styles).toMatch(/--sooya-safe-top: env\(safe-area-inset-top, 0px\)/);
  });

  it('lets fixed top elements consume the shared variable instead of direct env() lookups', async () => {
    const files = ['./components/ChatHeader.css', './components/AdminPanel.css', './components/overlays.css'];
    for (const file of files) {
      const css = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(css).not.toMatch(/env\(safe-area-inset-top/);
    }
  });
});
