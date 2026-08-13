import { describe, expect, it } from 'vitest';
import { SOOYA_MCP_RESULT, wrapMcpResult } from './mcp-result.js';

describe('wrapMcpResult', () => {
  it('prefers structured content while preserving accompanying text and error state', () => {
    expect(wrapMcpResult({
      content: [{ type: 'text', text: 'context' }, { type: 'image', data: new Uint8Array([1]) }],
      structuredContent: { answer: 42 },
      isError: true
    })).toEqual({
      [SOOYA_MCP_RESULT]: true,
      value: { structuredContent: { answer: 42 }, text: 'context' },
      isError: true
    });
  });
});

