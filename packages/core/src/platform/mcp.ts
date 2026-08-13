import type { McpToolCallResult } from '../tools/mcp-result.js';

export type McpTransport = 'streamable-http' | 'sse';

export interface McpServerConfig {
  id: string;
  url: string;
  transport: McpTransport;
  enabled?: boolean;
  required?: boolean;
  secretKey?: string;
  connectTimeoutMs?: number;
  toolTimeoutMs?: number;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpConnectionState {
  serverId: string;
  state: 'disabled' | 'connecting' | 'ready' | 'degraded' | 'closed';
  toolCount: number;
  detail?: string;
}

export interface McpPlatform {
  connect(config: McpServerConfig): Promise<McpConnectionState>;
  disconnect(serverId: string): Promise<void>;
  listTools(serverId: string, signal?: AbortSignal): Promise<McpTool[]>;
  callTool(serverId: string, name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

export type McpAdapter = McpPlatform;
