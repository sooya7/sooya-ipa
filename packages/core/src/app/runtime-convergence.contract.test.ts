import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function source(relative: string): Promise<string> {
  return await readFile(new URL(relative, import.meta.url), 'utf8');
}

describe('runtime convergence contracts', () => {
  it('uses saved chat request settings for ordinary replies', async () => {
    const coordinator = await source('./reply-coordinator.ts');
    const core = await source('./local-core.ts');

    expect(coordinator).toContain('requestConfig?: () => Promise<{ maxTokens?: number; temperature?: number }>');
    expect(coordinator).toContain('maxTokens: savedRequestConfig?.maxTokens ?? 2048');
    expect(coordinator).toContain('temperature: savedRequestConfig?.temperature ?? 0.7');
    expect(coordinator).not.toContain('messages: context.turns, maxTokens: 2048, temperature: 0.7');
    expect(core).toContain("const maxTokens = config?.options.maxTokens");
    expect(core).toContain("const temperature = config?.options.temperature");
  });

  it('does not hardcode the character to China time', async () => {
    const lifeSource = await source('../../life/v2/source.ts');
    const core = await source('./local-core.ts');
    const context = await source('./context-builder.ts');

    expect(lifeSource).not.toContain("?? 'Asia/Shanghai'");
    expect(core).toContain('offsetMinutesForTimeZone(current.time_zone');
    expect(core).toContain('tzOffsetMinutes: 0');
    expect(context).toContain('formatWorldLocalTime(this.now(), world.timeZone)');
  });

  it('keeps the chat header status single-owner and normalizes life vitals for display', async () => {
    const app = await source('../../../web/src/App.tsx');
    const header = await source('../../../web/src/components/ChatHeader.tsx');
    const numberDisplay = await source('../../../web/src/lib/numberDisplay.ts');
    const adminCss = await source('../../../web/src/components/AdminPanel.css');

    expect(app).toContain("chat.activity.thinking ? '思考中' : '在线'");
    expect(header).not.toContain('topbar-life');
    expect(numberDisplay).toContain('value >= 0 && value <= 1 ? value * 100 : value');
    expect(adminCss).toContain('border-radius: 7px');
    expect(adminCss).not.toMatch(/\.admin-status-chip \{[^}]*border-radius:\s*999px/u);
  });
});
