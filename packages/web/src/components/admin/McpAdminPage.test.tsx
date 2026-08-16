// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminMcpOverview } from '../../lib/admin.js';
import { McpAdminPage } from './McpAdminPage.js';

const adminMocks = vi.hoisted(() => ({
  mcpOverview: vi.fn(async (): Promise<AdminMcpOverview> => ({
    configSource: '/opt/sooya/shared/config/mcp.json',
    globalPolicy: { readEnabled: true, writeEnabled: true, maintenanceEnabled: true },
    servers: [{
      id: 'ombre',
      enabled: true,
      url: 'http://127.0.0.1:18001/mcp',
      transport: 'streamable-http',
      authConfigured: true,
      required: false,
      state: 'ready',
      toolCount: 2,
      latencyMs: 18
    }],
    tools: [
      {
        name: 'ombre.breath',
        serverId: 'ombre',
        description: 'UNIQUE LONG TOOL DESCRIPTION THAT SHOULD STAY HIDDEN UNTIL THE TOOL IS OPENED',
        risk: 'read',
        phases: ['reply', 'proactive'],
        authorized: true
      },
      {
        name: 'ombre.hold',
        serverId: 'ombre',
        description: 'write memory',
        risk: 'write',
        phases: ['memory_commit'],
        authorized: true
      }
    ],
    memory: {
      backend: 'ombre',
      connection: 'connected',
      health: null,
      lastCommit: null,
      pending: 0,
      uncertain: 0,
      lastDream: null,
      dashboardUrl: null
    },
    dashboardUrl: null
  })),
  mcpToolSchema: vi.fn(async (name: string) => ({
    tool: {
      name,
      serverId: 'ombre',
      description: 'UNIQUE LONG TOOL DESCRIPTION THAT SHOULD STAY HIDDEN UNTIL THE TOOL IS OPENED',
      risk: 'read',
      phases: ['reply', 'proactive'],
      authorized: true,
      inputSchema: { type: 'object', properties: {} }
    }
  })),
  testMcpServer: vi.fn(),
  refreshMcpTools: vi.fn(),
  saveMcpServer: vi.fn(async (server: Record<string, unknown>) => ({
    server: { id: String(server.id ?? 'mcp_x'), enabled: true, url: String(server.url), transport: String(server.transport ?? 'streamable-http'), authConfigured: Boolean(server.token), required: false, state: 'closed', toolCount: 0 }
  })),
  deleteMcpServer: vi.fn(async () => ({ deleted: true }))
}));

vi.mock('../../lib/admin.js', () => ({ adminApi: adminMocks }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  adminMocks.mcpOverview.mockClear();
  adminMocks.mcpToolSchema.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('McpAdminPage', () => {
  it('keeps the tool registry collapsed and loads full details only on demand', async () => {
    await act(async () => {
      root!.render(<McpAdminPage onNotice={vi.fn()} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(adminMocks.mcpOverview).toHaveBeenCalledTimes(1));
    expect(container!.textContent).toContain('工具与权限');
    expect(container!.textContent).toContain('读取 1 · 写入 1');
    expect(container!.querySelector('[data-testid="admin-mcp-tool-details"]')).toBeNull();
    expect(container!.textContent).not.toContain('UNIQUE LONG TOOL DESCRIPTION');

    const refresh = container!.querySelector('[data-testid="admin-mcp-status-refresh"]') as HTMLButtonElement;
    expect(refresh.textContent).toBe('');
    expect(refresh.getAttribute('aria-label')).toBe('刷新 MCP 状态');
    expect(refresh.style.width).toBe('36px');
    expect(refresh.style.minWidth).toBe('36px');

    const toggle = container!.querySelector('[data-testid="admin-mcp-tools-toggle"]') as HTMLButtonElement;
    await act(async () => toggle.click());

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container!.querySelector('[data-testid="admin-mcp-tool-details"]')).not.toBeNull();
    expect(container!.textContent).toContain('ombre.breath');
    expect(container!.textContent).not.toContain('UNIQUE LONG TOOL DESCRIPTION');

    const toolButton = container!.querySelector('.admin-mcp-tool-row') as HTMLButtonElement;
    await act(async () => {
      toolButton.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(adminMocks.mcpToolSchema).toHaveBeenCalledWith('ombre.breath'));
    expect(container!.querySelector('[role="dialog"]')?.textContent).toContain('UNIQUE LONG TOOL DESCRIPTION');
  });

  it('creates an MCP server through the editor form', async () => {
    await act(async () => {
      root!.render(<McpAdminPage onNotice={vi.fn()} />);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(adminMocks.mcpOverview).toHaveBeenCalledTimes(1));

    await act(async () => (container!.querySelector('[data-testid="admin-mcp-add"]') as HTMLButtonElement).click());
    expect(container!.querySelector('[data-testid="admin-mcp-editor"]')).not.toBeNull();

    const inputs = container!.querySelectorAll('input');
    const setValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
    };
    await act(async () => {
      setValue(inputs[0]!, 'my-server');
      setValue(inputs[1]!, 'https://mcp.example.com/mcp');
      setValue(inputs[2]!, 'secret-token');
      await Promise.resolve();
      (container!.querySelector('[data-testid="admin-mcp-save"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(adminMocks.saveMcpServer).toHaveBeenCalledTimes(1));
    const payload = adminMocks.saveMcpServer.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.url).toBe('https://mcp.example.com/mcp');
    expect(payload.token).toBe('secret-token');
    expect(payload.transport).toBe('streamable-http');
    await vi.waitFor(() => expect(adminMocks.mcpOverview).toHaveBeenCalledTimes(2));
  });

  it('prompts to add a server instead of dead-ending when the list is empty', async () => {
    adminMocks.mcpOverview.mockResolvedValueOnce({
      configSource: 'local', globalPolicy: { readEnabled: true, writeEnabled: true, maintenanceEnabled: true },
      servers: [], tools: [],
      memory: { backend: 'local', connection: 'disconnected', health: null, lastCommit: null, pending: 0, uncertain: 0, lastDream: null, dashboardUrl: null },
      dashboardUrl: null
    });
    await act(async () => {
      root!.render(<McpAdminPage onNotice={vi.fn()} />);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(adminMocks.mcpOverview).toHaveBeenCalledTimes(1));
    expect(container!.textContent).toContain('添加 MCP Server');
    expect(container!.querySelector('[data-testid="admin-mcp-add"]')).not.toBeNull();
  });

  it('surfaces the concrete no-tools-discovered diagnostic for a degraded memory backend', async () => {
    const degraded: AdminMcpOverview = {
      configSource: 'local', globalPolicy: { readEnabled: true, writeEnabled: true, maintenanceEnabled: true },
      servers: [{ id: 'ombre', enabled: true, url: 'https://echo.sooya.icu/mcp', transport: 'streamable-http', authConfigured: true, required: false, state: 'degraded', toolCount: 0, lastError: 'no tools discovered: ombre connected to https://echo.sooya.icu/mcp but tools/list returned 0 tools' }],
      tools: [],
      memory: { backend: 'ombre-sync', connection: 'degraded', health: { state: 'degraded', provider: 'ombre-mcp', detail: 'no tools discovered: Ombre MCP is connected but tools/list returned 0 tools' }, lastCommit: null, pending: 0, uncertain: 0, lastDream: null, dashboardUrl: null },
      dashboardUrl: null
    };
    adminMocks.mcpOverview.mockResolvedValueOnce(degraded);
    await act(async () => {
      root!.render(<McpAdminPage onNotice={vi.fn()} />);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(adminMocks.mcpOverview).toHaveBeenCalledTimes(1));
    // The reason must be visible on the cards, not just a generic "degraded".
    expect(container!.textContent).toContain('no tools discovered: Ombre MCP is connected but tools/list returned 0 tools');
    expect(container!.textContent).toContain('no tools discovered: ombre connected to https://echo.sooya.icu/mcp');
    expect(container!.textContent).toContain('尚未发现工具');
  });

  it('deletes a server after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => {
      root!.render(<McpAdminPage onNotice={vi.fn()} />);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(adminMocks.mcpOverview).toHaveBeenCalledTimes(1));

    const buttons = [...container!.querySelectorAll('.admin-mcp-actions button')];
    const remove = buttons.find((button) => button.textContent === '删除') as HTMLButtonElement;
    expect(remove).toBeDefined();
    await act(async () => {
      remove.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(adminMocks.deleteMcpServer).toHaveBeenCalledWith('ombre'));
    (vi.spyOn(window, 'confirm') as ReturnType<typeof vi.spyOn>).mockRestore();
  });
});

