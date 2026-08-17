import { readFile, writeFile } from 'node:fs/promises';

const providerPath = 'packages/core/src/providers/builtin.ts';
const testPath = 'packages/core/src/providers/mimo-thinking.contract.test.ts';
let source = await readFile(providerPath, 'utf8');

const completeNeedle = "        ...(effective.temperature !== undefined ? { temperature: effective.temperature } : {}),\n        ...(nativeJson ? { response_format: { type: 'json_object' } } : {}),";
const completeReplacement = "        ...(effective.temperature !== undefined ? { temperature: effective.temperature } : {}),\n        ...openAiVendorBody(this.config),\n        ...(nativeJson ? { response_format: { type: 'json_object' } } : {}),";
const streamNeedle = "        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),\n        ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),";
const streamReplacement = "        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),\n        ...openAiVendorBody(this.config),\n        ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),";
const helperNeedle = "function numberValue(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }";
const helperReplacement = `function openAiVendorBody(config: ProviderConfig): Record<string, unknown> {\n  const thinking = config.options.thinking;\n  if (isRecord(thinking) && (thinking.type === 'enabled' || thinking.type === 'disabled')) return { thinking };\n  const model = config.model.trim().toLowerCase();\n  // MiMo V2.5 thinking responses carry reasoning_content that must be round-tripped\n  // on later turns. SOOYA's canonical chat history intentionally stores one visible\n  // message stream, not a second hidden reasoning transcript, so disable MiMo thinking\n  // unless the operator explicitly opts into a future reasoning-aware protocol.\n  if (/^mimo[-_/.:]?v?2(?:\\.5)?(?:[-_/.:]|$)/u.test(model)) return { thinking: { type: 'disabled' } };\n  return {};\n}\n\n${helperNeedle}`;

for (const [needle, replacement, label] of [
  [completeNeedle, completeReplacement, 'complete payload'],
  [streamNeedle, streamReplacement, 'stream payload'],
  [helperNeedle, helperReplacement, 'vendor helper']
]) {
  if (!source.includes(needle)) {
    if (source.includes(replacement)) continue;
    throw new Error(`missing patch anchor: ${label}`);
  }
  source = source.replace(needle, replacement);
}
await writeFile(providerPath, source);

const test = `import { readFile } from 'node:fs/promises';\nimport { describe, expect, it } from 'vitest';\n\ndescribe('MiMo chat thinking compatibility', () => {\n  it('disables implicit MiMo thinking in both complete and streaming OpenAI payloads', async () => {\n    const source = await readFile(new URL('./builtin.ts', import.meta.url), 'utf8');\n    expect(source).toContain("...openAiVendorBody(this.config)");\n    expect(source.match(/\\.\.\.openAiVendorBody\\(this\\.config\\)/gu)).toHaveLength(2);\n    expect(source).toContain("thinking: { type: 'disabled' }");\n    expect(source).toContain("config.options.thinking");\n    expect(source).toContain("thinking.type === 'enabled' || thinking.type === 'disabled'");\n  });\n});\n`;
await writeFile(testPath, test);
