import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('NativeLocalCore model probe ownership', () => {
  it('delegates standard probes to LocalCore and keeps only the native selfie special case', async () => {
    const source = await readFile(new URL('./NativeLocalCore.ts', import.meta.url), 'utf8');

    expect(source).toContain("if (body.mode !== 'selfie') return await super.adminRequest<T>(path, options);");
    expect(source).toContain('probeNativeSelfieImage');
    expect(source).not.toContain('probeNativeModel(');
    expect(source).not.toContain('maxTokens: 16');
    expect(source).not.toContain('可能被最大输出 token 截断');
    expect(source).not.toContain('BuiltinChatProvider');
    expect(source).not.toContain('BuiltinEmbeddingProvider');
    expect(source).not.toContain('BuiltinRerankProvider');
  });
});
