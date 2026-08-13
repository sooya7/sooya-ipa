import { describe, expect, it } from 'vitest';
import { SOOYA_MCP_RESULT } from '../tools/mcp-result.js';
import { byteLength, clipUtf8, normalizeToolError, normalizeToolResult } from './tool-history.js';

describe('tool result safety', () => {
  it('serializes structured values and clips UTF-8 output with an explicit marker', () => {
    const result = normalizeToolResult({ text: '记忆'.repeat(100) }, { maxBytes: 256 });
    expect(result.bytes).toBe(256);
    expect(result.content).toContain('[tool result truncated by SOOYA host: 256 bytes limit]');
  });

  it('redacts credential-shaped error text', () => {
    const result = normalizeToolError(new Error('request failed bearer=secret-value'));
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('secret-value');
  });

  it('preserves MCP error envelopes and handles unserializable or empty results', () => {
    expect(normalizeToolResult({ [SOOYA_MCP_RESULT]: true, value: 'failed', isError: true })).toEqual({
      content: 'failed', isError: true, bytes: 6
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(normalizeToolResult(circular).content).toBe('[tool result could not be serialized]');
    expect(normalizeToolResult(undefined).content).toBe('');
  });

  it('clips only at Unicode scalar boundaries', () => {
    expect(byteLength('你a')).toBe(4);
    expect(clipUtf8('你a', 3)).toBe('你');
    expect(clipUtf8('你a', 2)).toBe('');
  });
});

