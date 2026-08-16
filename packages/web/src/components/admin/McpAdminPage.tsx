import { useCallback, useEffect, useState } from 'react';
import {
  adminApi,
  type AdminMcpOverview,
  type AdminMcpServer,
  type AdminMcpTool
} from '../../lib/admin.js';
import { AdminState } from './AdminState.js';

function dateText(value: string | undefined | null): string {
  if (!value) return '暂无';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : value;
}

function statusLabel(state: string): string {
  return state === 'ready' ? '已连接' : state === 'connecting' ? '连接中' : state === 'disabled' ? '已停用' : state === 'closed' ? '未连接' : '降级';
}

function stateClass(state: string): string {
  return state === 'ready' ? 'is-ready' : state === 'degraded' ? 'is-warn' : 'is-muted';
}

function riskLabel(risk: string): string {
  return risk === 'read' ? '读取'
    : risk === 'write' ? '写入'
      : risk === 'maintenance' ? '维护'
        : risk === 'external_side_effect' ? '外部操作'
          : risk === 'destructive' ? '高风险'
            : risk;
}

function toolSummary(tools: AdminMcpTool[]): string {
  const counts = tools.reduce<Record<string, number>>((result, item) => {
    result[item.risk] = (result[item.risk] ?? 0) + 1;
    return result;
  }, {});
  const risks = ['read', 'write', 'external_side_effect', 'destructive', 'maintenance']
    .filter((risk) => counts[risk])
    .map((risk) => `${riskLabel(risk)} ${counts[risk]}`);
  const disabled = tools.filter((item) => !item.authorized).length;
  if (disabled > 0) risks.push(`未授权 ${disabled}`);
  return risks.join(' · ') || '暂无已注册工具';
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 7v5h-5" />
      <path d="M19 12a7 7 0 1 0-2.05 4.95" />
    </svg>
  );
}

export function McpAdminPage({ onNotice }: { onNotice: (message: string) => void }) {
  const [overview, setOverview] = useState<AdminMcpOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [tool, setTool] = useState<(AdminMcpTool & { inputSchema: Record<string, unknown> }) | null>(null);
  const [editing, setEditing] = useState<AdminMcpServer | 'new' | null>(null);
  const [draft, setDraft] = useState({ id: '', name: '', url: '', transport: 'streamable-http' as 'streamable-http' | 'sse', token: '', enabled: true, required: false, clearToken: false });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await adminApi.mcpOverview());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'MCP 状态加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openNew = () => {
    setDraft({ id: '', name: '', url: '', transport: 'streamable-http', token: '', enabled: true, required: false, clearToken: false });
    setEditing('new');
  };

  const openEdit = (server: AdminMcpServer) => {
    setDraft({ id: server.id, name: server.id, url: server.url, transport: server.transport === 'sse' ? 'sse' : 'streamable-http', token: '', enabled: server.enabled, required: server.required, clearToken: false });
    setEditing(server);
  };

  const saveServer = async () => {
    const url = draft.url.trim();
    if (!url) { onNotice('请填写 MCP Server URL'); return; }
    setSaving(true);
    try {
      await adminApi.saveMcpServer({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim() || undefined,
        url,
        transport: draft.transport,
        ...(draft.token ? { token: draft.token } : draft.clearToken ? { token: '' } : {}),
        enabled: draft.enabled,
        required: draft.required
      });
      onNotice('MCP Server 已保存');
      setEditing(null);
      await load();
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : '保存 MCP Server 失败');
    } finally {
      setSaving(false);
    }
  };

  const removeServer = async (server: AdminMcpServer) => {
    if (!window.confirm(`删除 MCP Server「${server.id}」？其工具将立即从聊天中移除。`)) return;
    setBusy(`delete:${server.id}`);
    try {
      const result = await adminApi.deleteMcpServer(server.id);
      if (!result.deleted) throw new Error('MCP Server 未删除');
      onNotice('MCP Server 已删除');
      await load();
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : '删除 MCP Server 失败');
    } finally {
      setBusy(null);
    }
  };

  const runServerAction = async (server: AdminMcpServer, action: 'test' | 'refresh') => {
    const key = `${server.id}:${action}`;
    setBusy(key);
    try {
      const result = action === 'test'
        ? await adminApi.testMcpServer(server.id)
        : await adminApi.refreshMcpTools(server.id);
      if (result.ok !== true) throw new Error(`${server.id} ${action === 'test' ? '连接测试' : '工具刷新'}未成功`);
      setOverview((current) => current ? { ...current, servers: current.servers.map((item) => item.id === server.id ? result.server : item) } : current);
      onNotice(action === 'test' ? `${server.id} 连接测试完成` : `${server.id} 工具列表已刷新`);
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : 'MCP 操作失败');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const inspectTool = async (name: string) => {
    setBusy(`tool:${name}`);
    try {
      setTool((await adminApi.mcpToolSchema(name)).tool);
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : '工具详情加载失败');
    } finally {
      setBusy(null);
    }
  };

  if (loading && !overview) return <AdminState kind="loading" testId="mcp-admin-loading" />;
  if (error && !overview) return <AdminState kind="error" message={error} onRetry={() => void load()} testId="mcp-admin-error" />;
  if (!overview) return <AdminState kind="empty" testId="mcp-admin-empty" />;

  const refreshLabel = loading ? '正在刷新 MCP 状态' : '刷新 MCP 状态';

  return (
    <section className="admin-mcp-page" data-testid="admin-mcp-page">
      <header
        className="admin-subpage-header"
        style={{ gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'start' }}
      >
        <div>
          <span className="admin-eyebrow">INFRASTRUCTURE</span>
          <h2>MCP 服务</h2>
          <p>查看 MCP Server 的连接状态、工具刷新和权限概览。工具参数只在需要排查时展开。</p>
        </div>
        <button
          type="button"
          className="admin-header-button"
          data-testid="admin-mcp-status-refresh"
          aria-label={refreshLabel}
          title={refreshLabel}
          aria-busy={loading}
          onClick={() => void load()}
          disabled={loading}
          style={{ width: 36, minWidth: 36, padding: 0, justifySelf: 'end', alignSelf: 'start' }}
        >
          <RefreshIcon />
        </button>
      </header>

      {error && <p className="admin-inline-error" role="status">{error}</p>}

      <section className="admin-mcp-summary" aria-label="MCP 总览">
        <article className="admin-card">
          <span className="admin-card-kicker">记忆后端</span>
          <strong>{overview.memory.backend === 'ombre' ? 'Ombre Brain' : overview.memory.backend}</strong>
          <span className={`admin-status-chip ${stateClass(overview.memory.connection)}`}>{overview.memory.connection === 'connected' ? '已连接' : 'degraded'}</span>
          {typeof overview.memory.health?.detail === 'string' && <small>{overview.memory.health.detail}</small>}
        </article>
        <article className="admin-card">
          <span className="admin-card-kicker">配置来源</span>
          <strong className="admin-breakable">{overview.configSource}</strong>
          <small>全局读取 {overview.globalPolicy.readEnabled ? '开启' : '关闭'} · 写入 {overview.globalPolicy.writeEnabled ? '开启' : '关闭'}</small>
        </article>
        <article className="admin-card">
          <span className="admin-card-kicker">工具数量</span>
          <strong>{overview.tools.length}</strong>
          <small>{toolSummary(overview.tools)}</small>
        </article>
      </section>

      <section className="admin-card admin-mcp-servers" data-testid="admin-mcp-servers">
        <div className="admin-card-heading"><div><h3>MCP Server</h3><p>日常只需要关注连接状态和错误。URL 会移除查询参数和片段，认证 Token 只进系统钥匙串，界面只显示是否已配置。</p></div>
          <button type="button" className="admin-header-button" data-testid="admin-mcp-add" onClick={openNew}>+ 添加 MCP Server</button>
        </div>
        {editing && (
          <div className="admin-card admin-mcp-editor" data-testid="admin-mcp-editor">
            <div className="admin-card-heading"><div><h3>{editing === 'new' ? '添加 MCP Server' : `编辑 ${editing.id}`}</h3></div></div>
            <label>名称 / ID<input value={draft.name} placeholder={draft.id || '例如 ombre'} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label>URL<input value={draft.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => setDraft({ ...draft, url: e.target.value })} /></label>
            <label>传输方式<select value={draft.transport} onChange={(e) => setDraft({ ...draft, transport: e.target.value as 'streamable-http' | 'sse' })}>
              <option value="streamable-http">streamable-http</option>
              <option value="sse">sse</option>
            </select></label>
            <label>认证 Token<input type="password" autoComplete="off" value={draft.token} placeholder={editing !== 'new' ? '留空保持不变' : '粘贴 Bearer Token（可选）'} onChange={(e) => { setDraft({ ...draft, token: e.target.value, clearToken: false }); }} />
              {editing !== 'new' && <small>{draft.clearToken ? '保存后删除当前 Token' : '留空则保持已保存的 Token'}</small>}
              {editing !== 'new' && <button type="button" className="admin-link-button" onClick={() => { setDraft({ ...draft, token: '', clearToken: true }); }}>删除 Token</button>}
            </label>
            <label className="admin-toggle-row"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />启用</label>
            <label className="admin-toggle-row"><input type="checkbox" checked={draft.required} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} />Required（未连接时提示）</label>
            <div className="admin-actions">
              <button type="button" data-testid="admin-mcp-save" disabled={saving} onClick={() => void saveServer()}>{saving ? '保存中…' : '保存'}</button>
              <button type="button" onClick={() => setEditing(null)}>取消</button>
            </div>
          </div>
        )}
        {overview.servers.length === 0 && !editing ? <AdminState kind="empty" message="当前没有配置 MCP Server，点击右上角「添加 MCP Server」开始接入" /> : overview.servers.map((server) => (
          <article className="admin-mcp-server" key={server.id}>
            <div className="admin-mcp-server-main">
              <div className="admin-mcp-server-title"><strong>{server.id}</strong><span className={`admin-status-chip ${stateClass(server.state)}`}>{statusLabel(server.state)}</span></div>
              <p className="admin-breakable">{server.url || '未提供安全 URL'}</p>
              <small>{server.transport} · 工具 {server.toolCount} · 延迟 {server.latencyMs === undefined ? '暂无' : `${server.latencyMs}ms`} · required {server.required ? '是' : '否'} · 认证 {server.authConfigured ? '已配置' : '未配置'} · 最近连接 {dateText(server.lastConnectedAt ?? server.lastConnected)} · 最近刷新 {dateText(server.lastRefreshAt ?? server.lastRefresh)}</small>
              {server.lastError && <p className="admin-inline-error" role="status">{server.lastError}</p>}
            </div>
            <div className="admin-actions admin-mcp-actions">
              <button type="button" disabled={busy === `${server.id}:test`} onClick={() => void runServerAction(server, 'test')}>{busy === `${server.id}:test` ? '测试中…' : '连接测试'}</button>
              <button type="button" disabled={busy === `${server.id}:refresh`} onClick={() => void runServerAction(server, 'refresh')}>{busy === `${server.id}:refresh` ? '刷新中…' : '刷新工具'}</button>
              <button type="button" onClick={() => openEdit(server)}>编辑</button>
              <button type="button" disabled={busy === `delete:${server.id}`} onClick={() => void removeServer(server)}>删除</button>
            </div>
          </article>
        ))}
      </section>

      <section className="admin-card admin-mcp-tools" data-testid="admin-mcp-tools">
        <div className="admin-card-heading">
          <div>
            <h3>工具与权限</h3>
            <p>{overview.tools.length} 个已注册工具 · {toolSummary(overview.tools)}。仅排查权限或参数时需要查看详情。</p>
          </div>
          {overview.tools.length > 0 && (
            <button
              type="button"
              data-testid="admin-mcp-tools-toggle"
              aria-expanded={showTools}
              onClick={() => setShowTools((value) => !value)}
            >
              {showTools ? '收起详情' : '查看详情'}
            </button>
          )}
        </div>
        {overview.tools.length === 0 ? <AdminState kind="empty" message="尚未发现工具" /> : showTools ? (
          <div className="admin-mcp-tool-list" data-testid="admin-mcp-tool-details">
            {overview.tools.map((item) => (
              <button type="button" className="admin-mcp-tool-row" key={item.name} onClick={() => void inspectTool(item.name)} disabled={busy === `tool:${item.name}`}>
                <span><strong>{item.name}</strong><small>{item.serverId ?? 'local'} · 点开查看工具说明与参数</small></span>
                <span className="admin-mcp-tool-meta"><em>{riskLabel(item.risk)}</em><small>{item.phases.join(' · ')}</small></span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {tool && <div className="admin-tool-schema" role="dialog" aria-label={`${tool.name} 参数 schema`}>
        <div className="admin-tool-schema-inner">
          <button type="button" className="admin-tool-schema-close" aria-label="关闭工具详情" onClick={() => setTool(null)}>×</button>
          <span className="admin-eyebrow">TOOL SCHEMA</span>
          <h3>{tool.name}</h3>
          <p>{tool.description}</p>
          <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
        </div>
      </div>}
    </section>
  );
}

export type { AdminMcpOverview };

