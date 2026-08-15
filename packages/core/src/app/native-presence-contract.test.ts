import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('native Life/weather header contract', () => {
  it('stores refreshed weather in the active slot and refreshes foreground presence', () => {
    const source = readFileSync(path.resolve('src/app/local-core.ts'), 'utf8');
    expect(source).toContain("const cityName = location?.city ?? activeCity?.name ?? location?.name;");
    expect(source).toContain("location_key: 'active'");
    expect(source).toContain("this.events.emit('life.updated'");
    expect(source).toContain("this.events.emit('world.updated'");
  });
});
