# Native MCP tools/list 链路排查：连接 ready 但工具列表为空（2026-08-16）

> 现象（真机 IPA）：Ombre MCP `https://echo.sooya.icu/mcp` 连接测试成功、刷新工具
> 能更新时间，但管理页始终「工具数量 0 / 0 个已注册工具」；Memory 页 Ombre Brain
> degraded / sync unavailable。
> 要求：从 Native MCP tools/list 完整链路排查，不得先改 Memory Sync。

## 一、链路与排查方法

`McpPlatform.listTools` 完整链路：

```
服务端 tools/list 响应 (Ombre Brain v2.7.6, mcp python-sdk 1.28.1 streamable-http)
  → Swift SOOYAMcpClient 解码 (SSE/JSON, Mcp-Session-Id 捕获, 分页)
  → Capacitor bridge → CapacitorMcp.listTools (web/src/local/nativeBoot.ts)
  → LocalCore.refreshMcpServer (packages/core/src/app/local-core.ts)
  → ToolRegistry.replaceSource + mcp_tool_policies 持久化
  → GET /api/admin/mcp/servers (adminMcpRoutes) → McpAdminPage
```

排查手段：clone `sooya7/sooya` 服务端仓库 + `P0luz/Ombre-Brain` v2.7.6
(commit 6da5158b) 源码；本地复刻同配置 streamable-http 服务器
(mcp==1.28.1, stateful session, Bearer 中间件)，用 curl 逐字节抓取服务端真实响应。

## 二、各层实测结论

### 服务端（Ombre Brain v2.7.6）真实响应形态（本地复刻实测字节）
- `initialize`（无 Mcp-Session-Id）→ `200` + `Content-Type: text/event-stream`
  + `Mcp-Session-Id: <uuid>` 头 + SSE 单事件 `event: message` + `data: {jsonrpc...}`。
- `notifications/initialized`（带 session）→ `202` + `content-length: 0`。
- `tools/list`（带 session）→ `200` + SSE 单事件，`result.tools` 14 个工具
  （验收标准：README 明确「确认 tools/list 返回 14 个 Ombre 工具」）。
- 无 session 的非 initialize 请求 → `400 Bad Request: Missing session ID`
  （stateful 会话语义，Swift 会以 httpStatus 错误失败，不会静默空）。
- 服务端 tools.list 无分页/无客户端过滤，工具全局注册，与 capabilities 无关。
- 无 token → `401` + `www-authenticate: Bearer realm="Ombre Brain"`（实测）。

### Swift 客户端解码（SOOYAMcpPlugin.swift）
- SSE 解析（SOOYASSEParser）、JSON 分支、session 头捕获、202 空 body 特判、
  分页递归在复刻字节形态下全部正确；「成功但空」在代码上只有
  `result.tools == []` 一条路径，其余都走 invalidResponse/httpStatus 错误。

### McpPlatform.listTools → Admin 持久化（core）
- `refreshMcpServer`：connect → listTools → replaceSource + upsertPolicy →
  setRefreshed → setState('ready')。tools 非空时全链路正确（新增回归锁定）。

## 三、确认的缺陷（本改动修复）

| # | 层 | 缺陷 | 真机影响 |
|---|---|---|---|
| 1 | core `OmbreMcpMemoryProvider.ensureReady` | 首次 tools/list 只有 **1800ms** 超时（`timeoutMs` 默认），而 connect 用 30s；隧道 + SSE 握手下首次发现很容易超时 | Memory 页 degraded / sync unavailable 的直接根因之一 |
| 2 | core `OmbreMcpMemoryProvider.health` | ready + 0 tools 返回 `ready`/`0 tools`，无诊断 | 掩盖「连上了但没发现工具」 |
| 3 | core `refreshMcpServer` | connect ready + 0 tools 仍标 ready，清空注册后无任何诊断 | 管理页 0/0 且状态看似健康 |
| 4 | web `CapacitorMcp.connect` | 硬编码 `toolCount: 0`（假数据） | McpConnectionState 不可信 |
| 5 | core adminMcpRoutes refresh 分支 | 返回的 server 缺 `toolCount` | 刷新后卡片「工具」变 undefined |
| 6 | Swift `SOOYAMcpClient.connect` | 已存在会话时抛 duplicateServer | memory provider 探测与会话刷新并发时把健康连接标 degraded |
| 7 | Swift `listTools` | 成功但空无诊断字段 | JS 侧无法区分「空发现」与「正常空列表」 |

## 四、修复内容

- **Swift**：connect 幂等（替换旧会话，不再 duplicateServer）；listTools 空结果
  resolve 带 `noToolsDiscovered: true` + `detail`。`native-base` 11 → 12
  （native-base.version + SOOYAReleaseConfig.swift）。
- **web nativeBoot**：`CapacitorMcp.connect` connect 后真实拉一次 tools 得到
  toolCount；`listTools` 在 `noToolsDiscovered` 时抛明确错误
  （`no tools discovered: connected but tools/list returned 0 tools`）。
- **core**：`refreshMcpServer` 对 0 tools 标 `degraded` + lastError
  「no tools discovered: <id> connected to <url> but tools/list returned 0 tools」
  + error_log 记录（不再静默 ready）；admin refresh 响应补 toolCount。
- **Ombre adapter**：`ensureReady` 发现超时与 connect 预算一致
  （`max(timeoutMs, connectTimeoutMs)`）；`health()` 对 0 tools 返回
  `degraded` + 「no tools discovered: Ombre MCP is connected but tools/list
  returned 0 tools」（连接健康但无工具 = degraded，不是笼统 unavailable）。
- **UI**：McpAdminPage 记忆后端卡片直接展示 `health.detail`，server 卡片
  展示 lastError——修复后真机刷新即可看到精确原因。

## 五、真机等价回归

- **Swift XCTest**（SOOYAMcpPluginTests，macOS 跑）：
  - Ombre streamable 完整握手（initialize SSE + session 头 → 202 → tools/list
    14 工具 SSE）→ 断言 session/protocolVersion/14 工具/请求带 session；
  - 空 tools 以空成功浮现（供上层诊断）；
  - 无 session 的 tools/list → httpStatus(400)；
  - connect 幂等（重复 connect 不失败）。
- **core vitest**（test/app/mcp-admin-chain.test.ts，本机跑）：
  - 14 工具端到端：保存 → 刷新 → registry 14 个 canonical 工具 + toolCount 14
    + 幂等二次刷新；
  - 0 tools → degraded + 「no tools discovered」+ error_log + overview 0/0；
  - 0 tools 后恢复 → 再刷新回 ready 14；
  - memory health：0 tools → degraded + 明确 detail（连接保持、不重连循环）；
  - 发现超时预算与 connect 一致（预算内成功 / 超预算 unavailable）。
- **web vitest**：McpAdminPage 渲染 degraded + 两个来源的 no tools discovered
  诊断文案。

## 六、真机复现后的定位路径

1. 管理页 MCP 卡片：状态 degraded + lastError 显示精确原因；
2. 记忆后端卡片：health.detail 显示 provider 层诊断；
3. 错误日志（/api/admin/errors）：`mcp.ombre` scope 记录每次刷新失败原因；
4. Swift 侧 resolve 的 `noToolsDiscovered`/`detail` 字段直接反映原始响应。

若真机刷新后 lastError 不是 no tools discovered 而是 httpStatus/transport 类错误，
说明请求本身失败（401/400/超时），继续按错误文案定位；若仍显示 ready + 0，
则说明 native/web bundle 版本与仓库不一致（检查 OTA native gate：
`--native-min/max` 必须 ≥ 12）。
