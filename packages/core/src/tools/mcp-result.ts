import type { BinaryData } from '../providers/types.js';

export const SOOYA_MCP_RESULT = '__sooya_mcp_result__';

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; data: BinaryData; mime?: string }
  | { type: string; [key: string]: unknown };

export interface McpToolCallResult {
  content?: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface SooyaMcpResultEnvelope {
  [SOOYA_MCP_RESULT]: true;
  value: unknown;
  isError: boolean;
}

export function wrapMcpResult(result: McpToolCallResult): SooyaMcpResultEnvelope {
  const text = (result.content ?? [])
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  const value = result.structuredContent !== undefined
    ? (text ? { structuredContent: result.structuredContent, text } : result.structuredContent)
    : text;
  return { [SOOYA_MCP_RESULT]: true, value, isError: result.isError === true };
}

