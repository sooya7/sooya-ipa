# SOOYA iPhone 全本地版：一次性迁移最终方案

> **最终目标**：把当前 `sooya7/sooya` 从「React 前端 + Linux Node/Fastify 后端 + Server SQLite + Ombre/MCP Server」一次性迁成 **iPhone 本地运行的完整 SOOYA**。
>
> 最终状态：聊天、上下文、Life、动态、记忆、MCP Host、Tool Runtime、模型调用、图片、TTS、媒体、SQLite、配置、Jobs 全在 iPhone 本地运行。你的服务器只负责 IPA 和 OTA 更新静态文件。
>
> **明确不做**：主动聊天消息、APNs、Web Push、本地通知、推送权限、服务器业务 API、服务器数据库。
>
> 本方案按 2026-08-13 当前 `main` 实际代码设计。目标不是分期做个壳，而是一次迁完之后，可以直接关闭 SOOYA 业务服务器。

---

# 1. 最终架构

```text
┌───────────────────────────────────────────────┐
│                iPhone / SOOYA.ipa            │
│                                               │
│  React UI                                     │
│  ├─ 聊天                                     │
│  ├─ 动态                                     │
│  ├─ 媒体                                     │
│  ├─ MCP 管理                                 │
│  └─ Admin                                    │
│                     │                         │
│                     ▼                         │
│  SOOYA Local Core (TypeScript)                │
│  ├─ Reply / Context / Summary                 │
│  ├─ Tool Registry / Tool Runtime              │
│  ├─ Memory Router / Local Memory              │
│  ├─ Life / Location / Weather                 │
│  ├─ Moment Composer（动态）                   │
│  ├─ Voice / Image / Sticker                   │
│  └─ Local Task Scheduler                      │
│                     │                         │
│        ┌────────────┼───────────────┐          │
│        ▼            ▼               ▼          │
│  Native SQLite   iOS Keychain    Native Media │
│        │            │               │          │
│        └────────────┼───────────────┘          │
│                     │                          │
│       Native HTTP / Native MCP Transport       │
└─────────────────────┼──────────────────────────┘
                      │
        ┌─────────────┼────────────────────┐
        ▼             ▼                    ▼
   模型 Provider   外部 HTTP MCP       天气/搜索 API
   OpenAI 等       用户前台导入         手机直连
```

服务器最终只剩：

```text
updates.example.com
├─ /ota/stable/latest.json
├─ /ota/stable/<web-version>.zip
├─ /ipa/latest.json
└─ /ipa/SOOYA-<native-version>.ipa
```

**服务器不再运行 SOOYA。**

---

# 2. “全本地”的边界

## 必须在 iPhone

- SOOYA 所有业务状态
- 聊天数据库、消息、引用、搜索索引
- 动态数据库
- Life / Location / Weather 缓存
- Sticker 数据与分析状态
- 媒体文件
- 记忆数据库
- Tool Registry / Tool Policy / Tool Runtime
- MCP Host 管理逻辑
- ReplyCoordinator / ContextBuilder / Summarizer
- Local Jobs
- Persona / 模型配置
- API Key / MCP Token
- OTA 状态

## 允许手机直接访问

```text
OpenAI / Anthropic / OpenAI-compatible
Fish Audio
图像 Provider
Embedding / Rerank
Web Search
Open-Meteo
用户自行导入的 HTTP MCP
```

这是：

```text
iPhone → 第三方服务
```

不是：

```text
iPhone → 你的 SOOYA Server → 第三方服务
```

---

# 3. 为什么不能把当前 server 原封不动塞进 IPA

当前后端有：

```text
Fastify
better-sqlite3
node:fs / node:path / node:os
pino
sharp
file-type
Linux 文件目录
.env
setInterval JobWorker
Docker Ombre
```

所以迁移核心不是「打包 Node」，而是：

> **把 SOOYA 的业务逻辑从 Node/Fastify 外壳剥出来，改成纯 TypeScript Core；数据库、密钥、网络、MCP、媒体由 iOS Native Bridge 提供。**

React UI 继续保留，不做全 SwiftUI 重写。

---

# 4. 最终仓库结构

```text
sooya/
├─ packages/
│  ├─ core/
│  │  ├─ src/
│  │  │  ├─ app/
│  │  │  ├─ chat/
│  │  │  ├─ context/
│  │  │  ├─ memory/
│  │  │  ├─ life/
│  │  │  ├─ moments/
│  │  │  ├─ tools/
│  │  │  ├─ mcp/
│  │  │  ├─ providers/
│  │  │  ├─ voice/
│  │  │  ├─ stickers/
│  │  │  ├─ media/
│  │  │  ├─ jobs/
│  │  │  ├─ config/
│  │  │  ├─ db/
│  │  │  └─ platform/
│  │  └─ test/
│  ├─ web/
│  ├─ ios-bridge/
│  └─ migration-tools/
├─ ios/
│  └─ App/
│     ├─ SOOYADatabasePlugin.swift
│     ├─ SOOYASecretsPlugin.swift
│     ├─ SOOYAHttpPlugin.swift
│     ├─ SOOYAMediaPlugin.swift
│     └─ SOOYAMcpPlugin.swift
├─ capacitor.config.ts
├─ scripts/
│  ├─ build-ota.mjs
│  ├─ verify-ota.mjs
│  ├─ export-portable.mjs
│  └─ verify-portable.mjs
└─ .github/workflows/
   ├─ ci.yml
   ├─ ios-build.yml
   └─ ota-publish.yml
```

`packages/server` 只在迁移期间作为源代码和导出工具来源。最终生产 App 不依赖它。

---

# 5. Core 的硬边界

`packages/core` 禁止：

```text
fastify
better-sqlite3
node:fs
node:path
node:os
process.env
sharp
pino
Node Buffer 作为公共接口
```

允许：

```text
TypeScript
Promise / async
Uint8Array / ArrayBuffer
平台接口
纯业务算法
```

CI 增加 boundary test，Core 出现 Node import 直接红。

---

# 6. 一次性先定义平台接口

```ts
interface LocalDatabase {
  open(): Promise<void>;
  close(): Promise<void>;
  execute(sql: string): Promise<void>;
  run(sql: string, values?: DbValue[]): Promise<RunResult>;
  query<T>(sql: string, values?: DbValue[]): Promise<T[]>;
  transaction<T>(operations: DbOperation[]): Promise<T>;
  integrityCheck(): Promise<IntegrityResult>;
  backup(target: string): Promise<void>;
}

interface SecretStore {
  has(ref: string): Promise<boolean>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

interface HttpTransport {
  request(req: NativeHttpRequest): Promise<NativeHttpResponse>;
  stream(req: NativeHttpRequest, sink: StreamSink): Promise<void>;
  cancel(id: string): Promise<void>;
}

interface BinaryStore {
  save(input: BinarySaveInput): Promise<StoredBinary>;
  read(id: string): Promise<Uint8Array | null>;
  delete(id: string): Promise<boolean>;
  thumbnail(id: string, width: number): Promise<string>;
}

interface McpTransport {
  connect(config: McpRuntimeConfig): Promise<McpSnapshot>;
  disconnect(serverId: string): Promise<void>;
  listTools(serverId: string): Promise<McpRemoteTool[]>;
  callTool(
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<McpCallResult>;
}
```

SOOYA Core 只能依赖这些接口。

---

# 7. 数据库是迁移最大的技术点

当前 Repo 基于同步 `better-sqlite3`：

```text
prepare().get()
prepare().all()
prepare().run()
transaction(fn)
```

iOS Bridge 是异步的，所以不能做一个假的同步适配器。

## 正确做法

**所有 Repo 一次性 async 化。**

```ts
const msg = await messages.get(id);
const recent = await messages.recent(40);
```

事务必须在 Native 一侧批量执行，不能一条 SQL 一次 JS↔Swift bridge。

---

# 8. iOS SQLite

推荐自定义：

```text
SOOYADatabasePlugin.swift
```

底层直接 SQLite C API。

这样避免：

- `better-sqlite3` ABI
- SQLCipher 非必要依赖
- 社区插件与 Capacitor 主版本兼容风险
- 每条 SQL 跨 bridge

Native 暴露：

```text
open
close
execute
run
query
transaction
checkpoint
integrityCheck
backup
restore
databaseInfo
```

打开配置：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 8000;
PRAGMA temp_store = MEMORY;
```

---

# 9. FTS5 / trigram 必须做启动探针

当前 SOOYA 已经使用 FTS5 `trigram`。

首次启动：

```sql
CREATE VIRTUAL TABLE temp.__sooya_fts_probe
USING fts5(content, tokenize='trigram');
DROP TABLE temp.__sooya_fts_probe;
```

成功就继续使用现有索引。

如果 iOS SQLite 不支持，Local Migration 必须自动：

```text
保留原始数据
→ 重建兼容 FTS
→ embedding + CJK fallback
→ capability 标记 trigram=false
```

不能默默让搜索坏掉。

---

# 10. Schema 不推倒重来

保留当前 1～35 migration，再追加 Local migration。

建议增加：

```text
36 local_runtime
37 native_mcp
38 secret_refs
39 life_clock
40 moment_runtime_cleanup
41 local_memory_provider
42 local_update_state
43 local_backup_metadata
```

实际编号按实施时 HEAD 顺延。

新增：

```text
mcp_servers
mcp_tool_policies
secret_refs
life_clock_state
local_memory_receipts
app_runtime
migration_receipts
```

---

# 11. MCP 表

`mcp_servers`：

```sql
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  url TEXT NOT NULL,
  transport TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  secret_ref TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  connect_timeout_ms INTEGER NOT NULL,
  tool_timeout_ms INTEGER NOT NULL,
  protocol_mode TEXT NOT NULL DEFAULT 'auto',
  state TEXT NOT NULL DEFAULT 'closed',
  last_error TEXT,
  last_connected_at TEXT,
  last_refresh_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`mcp_tool_policies`：

```sql
CREATE TABLE mcp_tool_policies (
  server_id TEXT NOT NULL,
  remote_name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  risk TEXT NOT NULL,
  phases_json TEXT NOT NULL,
  authorized INTEGER NOT NULL DEFAULT 0,
  schema_hash TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(server_id, remote_name)
);
```

新发现工具默认：

```text
authorized=false
```

绝不自动授权。

---

# 12. Secret 只存在 Keychain

新增：

```text
SOOYASecretsPlugin.swift
```

Keychain 名称固定，例如：

```text
provider.chat.key
provider.vision.key
provider.image.key
provider.tts.key
provider.embedding.key
provider.rerank.key
websearch.tavily.key
mcp.<serverId>.token
```

SQLite 只存：

```text
secretRef
configured
```

默认不提供 `getRawSecret()` 给 React。

Native HTTP / MCP Plugin 根据 `secretRef` 自己从 Keychain 取值。

---

# 13. 当前配置系统本地化

现在的：

```text
persona.json
models.json
.env
fs.watch
```

改成：

```text
ConfigRepository
```

非 secret：

```text
Persona
Model config
Model presets
Web Search config
Life settings
Voice settings
Moment settings
```

存 SQLite。

API Key / Token 存 Keychain。

Admin 模型页显示：

```text
API Key：已配置
[更新密钥] [清除密钥]
```

不会回显真实值。

---

# 14. Native HTTP

新增：

```text
SOOYAHttpPlugin.swift
```

底层：

```text
URLSession
```

原因：

- 避免 WKWebView CORS
- Key 不进 JS
- 支持 SSE
- 更好控制 redirect / timeout / abort
- 二进制传输更稳定

接口：

```text
request
stream
cancel
```

流式事件：

```text
sooya:http:headers
sooya:http:chunk
sooya:http:complete
sooya:http:error
```

---

# 15. Native HTTP 安全

必须：

```text
只允许 http/https
生产默认要求 https
禁止 file/javascript scheme
限制 redirect
跨 host redirect 不携带 Authorization
日志永不打印 Authorization
日志永不打印 API key
response size limit
upload size limit
timeout
AbortController cancellation
```

私网 Endpoint 必须用户显式开启。

---

# 16. Provider Adapter 最大复用

当前的：

```text
OpenAI Chat
OpenAI Responses
Anthropic
OpenAI-compatible
Embedding
Image
Fish / TTS
Rerank
```

全部尽量迁到 `packages/core/providers`。

只是把：

```text
fetch()
```

替换成：

```text
HttpTransport
```

所有公共 `Buffer` 改为 `Uint8Array`。

工具调用、JSON mode fallback、retry、SSE parser 语义继续保留。

---

# 17. Streaming 从 Server SSE 改为本地 Event Bus

以前：

```text
Provider → SOOYA Server → /api/stream → React
```

以后：

```text
Provider
→ Native HTTP stream
→ Local Core
→ LocalEventBus
→ React
```

事件名尽量原样保留：

```text
message.received
message.updated
reply.batch.collecting
reply.generation.started
reply.text.delta
reply.completed
reply.failed
life.updated
world.updated
moment.created
sticker.updated
```

这样 `useChat` 大部分事件处理不需要重写。

---

# 18. `api.ts` 改成客户端接口

定义：

```ts
interface SooyaClient {
  bootstrap()
  messages()
  messageSearch()
  messagesByDate()
  messageContext()
  send()
  withdraw()
  retryBatch()
  upload()
  moments()
  likeMoment()
  stickerSearch()
  life()
  presence()
  capabilities()
  subscribe()
}
```

实现：

```text
LocalSooyaClient
```

直接调 `LocalCore`。

迁移/parity 测试阶段可以保留：

```text
RemoteSooyaClient
```

最终 iOS 不请求 `/api/*`。

---

# 19. Admin 也彻底 Local

当前：

```text
admin.ts
→ /api/admin/*
→ Admin Token
```

改为：

```text
LocalAdminService
```

删除：

```text
sooya.admin-token
ADMIN_UNAUTHORIZED_EVENT
X-Admin-Token
管理员 HTTP 登录壳
```

单用户自签 App 没有远程 Admin 安全边界。

如果未来想锁设置页，可以单独加 Face ID，不需要服务器 token。

---

# 20. ReplyCoordinator 保持语义

保留：

```text
batch
revision
debounce
interrupt
publish grace
retry
partial publish
revision fence
```

这些已经是 SOOYA 的核心资产。

只替换：

```text
DB
事件出口
网络 transport
Job 调度
```

不要趁迁移重新设计聊天语义。

---

# 21. MCP Host 本地化

当前值得保留：

```text
ToolRegistry
ToolPolicy
ToolCallRuntime
namespace
risk
phase
timeout
result budget
parallel reads
sequential writes
server isolation
```

当前必须删除/替换：

```text
mcp.json
process.env
bearer-env
Server startup connect
Node MCP transport
```

---

# 22. MCP 前台完整 CRUD

管理中心 → MCP：

```text
MCP 服务                           [+ 添加]

Memory
已连接 · 14 工具
https://...
[测试] [刷新] [编辑]

Search
未连接
https://...
[测试] [刷新] [编辑]
```

必须支持：

```text
新增
粘贴 JSON 导入
编辑
启用/停用
删除
测试连接
刷新工具
查看 schema
工具授权
工具风险
允许 phase
认证配置
设为记忆 Provider
```

---

# 23. MCP JSON 导入

兼容：

```json
{
  "servers": {
    "memory": {
      "url": "https://example.com/mcp",
      "transport": "streamable-http"
    }
  }
}
```

以及：

```json
{
  "mcpServers": {
    "memory": {
      "url": "https://example.com/mcp"
    }
  }
}
```

如果导入：

```json
{
  "command": "npx",
  "args": ["..."]
}
```

明确提示：

```text
这是桌面 stdio MCP。
iPhone 不运行任意 Node/Python 子进程，请提供该 MCP 的 HTTP 地址。
```

不支持任意 stdio 动态运行。

---

# 24. MCP 认证

支持：

```text
none
Bearer
OAuth 2.1 + PKCE
```

Bearer Token 进 Keychain。

OAuth 使用：

```text
ASWebAuthenticationSession
PKCE
refresh token → Keychain
```

URL 中禁止携带明文 token 作为长期配置。

---

# 25. Native MCP

新增：

```text
SOOYAMcpPlugin.swift
```

只负责：

```text
协议 transport
tools/list
tools/call
pagination
auth
timeout
abort
health
reconnect
```

**Tool Policy 继续在 TS Core。**

不要把产品规则复制到 Swift。

---

# 26. MCP 协议兼容

配置：

```text
protocolMode:
auto
legacy
modern
```

`auto`：

```text
探测 modern
→ 不支持则 fallback legacy
```

modern 至少支持：

```text
server/discover
per-request POST
application/json
text/event-stream
tools/list
tools/call
per-request cancellation
```

legacy 支持：

```text
initialize
session
Streamable HTTP
legacy SSE fallback
```

必须有 fixture 测试，不靠肉眼判断。

---

# 27. Tool Phase 清理

当前历史 phase：

```text
proactive
```

迁成：

```text
moment
```

最终：

```ts
type ToolPhase =
  | 'reply'
  | 'memory_commit'
  | 'moment'
  | 'maintenance'
  | 'admin';
```

迁移旧配置时：

```text
proactive → moment
```

写回后不再保留旧语义。

---

# 28. MCP 失败隔离

任何一个 MCP：

```text
401
timeout
500
断线
schema 变化
工具 error
```

只影响该 Server/Tool。

不能：

```text
阻塞 App 启动
阻塞普通聊天
让 Local Memory 不可用
让其它 MCP 下线
```

MCP 默认 lazy connect。

---

# 29. 记忆最终架构

默认：

```text
LocalMemoryProvider
```

可选：

```text
McpMemoryProvider
HybridMemoryProvider
```

接口：

```ts
interface MemoryProvider {
  wake(...)
  recall(...)
  commit(...)
  search(...)
  list(...)
  update(...)
  forget(...)
  maintain(...)
  health(...)
}
```

---

# 30. Local Memory 不从零造

当前项目里的旧：

```text
MemoryService
MemoryRepo
memories
memory_sources
FTS
embedding
rerank
```

就是本地记忆基础。

把它：

```text
async 化
→ 搬进 core
→ 加 MemoryProvider 接口
```

再吸收 Ombre 已经验证的：

```text
wake
commit receipt
uncertain reconciliation
maintenance/dream
```

思想。

---

# 31. Local Memory Commit

最终回复：

```text
ReplyCoordinator
→ final revision
→ durable memory.commit
→ 模型判断值得记什么
→ memories
→ embedding job
```

revision fence 必须继续。

旧 revision 绝不能写长期记忆。

---

# 32. 本地 Memory Tools

注册：

```text
memory.search
memory.list
memory.hold
memory.update
memory.forget
memory.trace
```

同样进入 ToolRegistry。

模型层不需要知道这个 Tool 是本地还是 MCP。

---

# 33. MCP Memory Provider

MCP 管理页允许：

```text
[设为记忆服务]
```

不要硬编码只支持 Ombre 名称。

配置工具映射：

```text
search tool
write tool
update tool
forget tool
```

如果 MCP 只支持 search/write，也可以运行降级版。

---

# 34. Hybrid Memory

可选：

```text
Local + 一个外部 MCP Memory
```

读取：

```text
并行 recall
→ normalize
→ dedupe
→ score
→ context budget
```

写入：

```text
Local authoritative
MCP 写入是否启用由设置控制
```

防止双边无限复制。

---

# 35. Ombre 不能继续 Docker 依赖

当前 Ombre 是：

```text
SOOYA → localhost:18001 → Python/Docker Ombre
```

手机全本地后，不能继续把它作为必需服务。

所以旧 Ombre 在切换前只做一件事：

```text
导出记忆
```

导入 `LocalMemoryProvider` 后即可退休。

如果以后用户有一个公网 Ombre HTTP MCP，也可以作为普通 MCP Memory Provider 直接从手机连接，但不是 SOOYA 的必要依赖。

---

# 36. Ombre 导出

迁移工具按当前锁定版本真实验证。

优先：

```text
catalog / breath_advanced
→ 分页
→ 读取完整 memory
→ ombre.jsonl
```

如果没有完整 catalog：

```text
读取 Ombre buckets 持久目录
```

必要时结合：

```text
MCP search + bucket id
```

**不要假设一个没验证过的 export-all API。**

---

# 37. Ombre 导入 Local Memory

每条转成：

```text
id
kind
content
normalized
importance
confidence
createdAt
updatedAt
source=ombre-import
sourceId=<bucket id>
sourceHash=<sha256 canonical>
```

不要复制旧 embedding。

导入后：

```text
embedding=null
→ 低优先级 lazy re-embed
```

---

# 38. Life 不再依赖后台 Timer

iOS 不保证 App 后台常驻。

所以正确性不能依赖：

```text
setInterval → life.tick
```

改为：

```text
Persistent Time Simulation
+
Catch-up
```

---

# 39. Life Catch-up

新增：

```ts
life.catchUp(to: Date)
```

保存：

```text
lastSettledAt
simulationVersion
seedVersion
```

例子：

```text
01:00 离开 App
15:00 再打开

01:00 睡觉
07:48 起床
08:20 早餐
...
15:00 当前状态
```

---

# 40. Catch-up 按事件边界，不按 5 分钟循环

推进：

```text
activity ends_at
travel arrival
plan boundary
day boundary
sleep/wake boundary
```

不要：

```text
14h / 5min = 168 次 tick
```

这样离开几天也不会炸 CPU。

---

# 41. Life deterministic

同一：

```text
日期
seedVersion
世界状态
```

应得到稳定结果。

保存：

```text
simulationVersion
seedVersion
```

OTA 改算法时：

```text
不重写已发生历史
从版本切换点继续
```

---

# 42. 长时间没打开的限流

建议：

```text
最近 7 天详细 replay
最大 transition 200
更早时间 coarse settle
```

更早的间隔只恢复：

```text
vitals
thread decay
day state
current-day plans
```

而不是生成几百条历史。

---

# 43. App 启动顺序

```text
1 React Shell
2 DB open
3 Core bootstrap
4 Life 快速 catch-up
5 Header 显示正确当前状态
6 Chat 可用
7 低优先级 memory/moment/sticker maintenance
8 OTA check
```

不能让 MCP 全连接、动态图片、re-embed 阻塞首屏。

---

# 44. 动态彻底替代主动消息

最终产品链路只有：

```text
Life
→ Life Event
→ Share Candidate
→ MomentPolicy
→ MomentComposer
→ 动态
```

不存在：

```text
主动聊天
push
notification
```

---

# 45. 代码正式改名

一次性清理：

```text
ProactiveComposer → MomentComposer
ProactiveAttemptRepo → MomentAttemptRepo
ProactiveRunResult → MomentComposeResult
ProactiveMode → MomentMode
enqueueProactive → enqueueMoment
proactive metrics → moment metrics
```

数据库可以新建 `moment_attempts` 并迁旧记录。

最终新代码不再使用 `proactive` 表示产品功能。

---

# 46. 动态 Catch-up 不能刷屏

Life catch-up 可能产生多个 share candidate。

MomentPolicy：

```text
按实际事件时间排序
→ 值得分享
→ topic dedupe
→ daily cap
→ min gap
→ already shared
→ provider available
```

只留下合理候选。

---

# 47. 动态时间必须是历史发生时间

例如离开 12 小时后回来：

```text
12:41 咖啡店
14:18 书店
```

不能变成：

```text
15:00
15:00
15:00
```

`createdAt` 使用模拟事件/分享发生时间。

---

# 48. 动态生成低优先级

恢复 App：

```text
先恢复 Life
```

然后：

```text
moment.compose
moment.image
```

进入 Scheduler。

模型不可用：

```text
candidate 保持 pending
```

不写假动态。

---

# 49. 当前动态能力全部保留

```text
文本
POV
自拍
scene
action
mood
framing
地点
城市
天气
温度
参考图
Media Director
like
```

只是从 Server 搬到 Local Core。

---

# 50. Chat 永远最高优先

LocalTaskScheduler：

```text
100 interactive reply
95  user media
90  reply tool
80  memory commit
75  life conversation
70  life catch-up
60  moment text
50  moment image
30  weather
20  sticker analysis/embed
10  memory maintenance/reindex
5   backup
```

用户发消息后，Moment 图片可以延后。

---

# 51. LocalTaskScheduler

当前 `JobWorker` 改为：

```text
LocalTaskScheduler
```

App active：

```text
drain durable jobs
```

App inactive：

```text
不再 claim
abort 可安全终止的网络任务
持久化状态
```

回前台：

```text
recover running → pending
按优先级继续
```

---

# 52. Durable Jobs

保留：

```text
memory.commit
summary.build
life.conversation
moment.compose
moment.image
sticker.analyze
sticker.embed
media.extract_text
weather.refresh
memory.reembed
maintenance
backup
```

删除：

```text
push.reply
```

不依赖 iOS BackgroundTask 才能保持正确。

---

# 53. Location

SOOYA Location 是角色世界位置，不是用户 GPS。

继续保留：

```text
activity affinity
travel
arrival
city
current place
```

全部本地 SQLite。

**不申请 iOS 定位权限。**

---

# 54. Weather

```text
active city
→ Local WeatherService
→ Native HTTP
→ Open-Meteo
→ SQLite cache
```

历史动态没有可靠历史天气：

```text
省略 weather
```

不要拿当前天气伪装过去天气。

---

# 55. Native Media

当前 MediaStore 强依赖 `fs/path/sharp/Buffer`。

新增：

```text
SOOYAMediaPlugin.swift
```

目录：

```text
Library/Application Support/SOOYA/
├─ database/
├─ media/
│  ├─ images/
│  ├─ audio/
│  ├─ stickers/
│  ├─ files/
│  ├─ variants/
│  └─ tmp/
├─ references/
└─ backups/
```

---

# 56. Native Media 职责

```text
save
read
delete
exists
metadata
thumbnail
sha256
copyImport
export
cleanupTemp
```

Native：

```text
CryptoKit → SHA256
ImageIO → 图片元数据/缩略图
AVFoundation → 音频时长
UTType → MIME
FileManager → atomic write
```

只允许按 Media ID/受控目录访问，不给 JS 任意路径读取能力。

---

# 57. 当前媒体性能优化保留

保留：

```text
DPR thumbnail
blob cache
并发去重
内存上限
LRU 淘汰
retry
```

只是：

```text
/api/media/:id
```

改成：

```text
LocalMediaResolver
```

不再需要媒体 token / same-origin 鉴权。

---

# 58. 图片/文件

上传入口可先继续用 iOS 系统 picker。

保存时 Native 再：

```text
内容嗅探
大小限制
hash
metadata
```

图片/文件导出使用 Share Sheet。

不依赖 `<a download>`。

---

# 59. TTS

流程：

```text
Local Core
→ Native HTTP
→ Fish/OpenAI/Volc
→ audio bytes
→ Native Media
→ SQLite
```

现有 emotion / prosody / voice policy 保留。

不申请 Background Audio。

---

# 60. Sticker

保留：

```text
AI analysis
semantic text
user meaning
embedding
favorite
retrieval
picker
```

`sharp` 职责交给 Native Media。

Sticker 分析仍用手机直连 Vision Provider。

---

# 61. Web Search

现有：

```text
doubao
tavily
responses
```

搬进 Core。

Key 全走 Keychain + Native HTTP。

---

# 62. Capacitor

使用 Capacitor 8：

```ts
{
  appId: 'com.sooya.app',
  appName: 'SOOYA',
  webDir: 'packages/web/dist'
}
```

生产明确不设置：

```text
server.url
```

React bundle 随 IPA 本地安装。

---

# 63. iOS UX

使用：

```text
@capacitor/app
@capacitor/keyboard
@capacitor/status-bar
@capacitor/splash-screen
@capacitor/haptics
@capacitor/share
@capacitor/browser
```

不引入 Push。

---

# 64. Safe Area

统一：

```css
--sooya-safe-top
--sooya-safe-bottom
--sooya-keyboard-height
```

验收：

```text
Dynamic Island
Home Indicator
Header
Composer
动态页
Admin
Image Viewer
Bottom sheet
```

---

# 65. Keyboard

第一版：

```text
resize = body
```

只保留一个 resize source。

真机：

```text
中文九宫格
中文全键盘
英文
Emoji
听写
长文本
快速收起/展开
```

底部聊天保持贴底；翻历史时不能被强行拉到底。

---

# 66. StatusBar / Splash / Haptics

StatusBar：

```text
浅色 → dark content
深色 → light content
```

Splash 只遮白屏，Core ready 立即隐藏。

Haptic：

```text
发送 light
保存 success
失败 error
重要 toggle selection
```

不对每个 token 震动。

---

# 67. 外链

聊天中的 HTTP(S) 外链走：

```text
系统 Browser / Safari
```

不能让主 WKWebView 离开 SOOYA。

---

# 68. Service Worker

Web/PWA 可以保留。

Native：

```text
不注册 PWA SW updater
```

OTA 只能有一套 Native updater。

---

# 69. App 生命周期

active：

```text
DB revalidate
recover interrupted jobs
Life catch-up
Scheduler resume
stale weather refresh
MCP lazy reconnect
OTA check
```

inactive：

```text
停止 claim 新 job
取消 optional maintenance
persist state
WAL checkpoint
```

---

# 70. MCP / Provider 启动都必须 lazy

打开 App 时：

```text
不全部 connect MCP
不全部测试模型
```

需要某 MCP 时才 `ensureConnected()`。

需要某 Provider 时才真实请求。

首屏优先。

---

# 71. Admin 首页重做为本机状态

删除：

```text
Node uptime
server load
Docker
```

显示：

```text
Native version
Core/Web version
Schema version
Bridge version
DB size
Media size
Free space
Integrity
Pending/failed jobs
Model 状态
MCP 状态
OTA 状态
```

---

# 72. Operations 继续“人话化”

保留当前分组展示。

错误来源：

```text
provider.*
mcp.*
database.*
media.*
life.*
moment.*
memory.*
ota.*
```

技术详情折叠。

日志永不记录 secret。

---

# 73. 本地备份

Admin：

```text
数据与备份
├─ 导出完整备份
├─ 导入/恢复
├─ 完整性检查
└─ 存储占用
```

备份：

```text
sooya-backup-<date>.zip
├─ sooya.db
├─ media/
├─ references/
├─ config.json
└─ manifest + checksums
```

默认**不包含 Keychain secret**。

通过 iOS Share Sheet 保存。

---

# 74. 一次性旧服务器迁移包

旧 Server 生成：

```text
SOOYA-Migration-<date>.zip
├─ manifest.json
├─ sooya.db
├─ db.sha256
├─ media/
├─ references/
├─ persona.json
├─ models.redacted.json
├─ mcp.redacted.json
├─ memories/
│  ├─ ombre.jsonl
│  └─ legacy.jsonl
└─ SHA256SUMS
```

`sooya.db` 必须通过 SQLite backup API 获得一致 snapshot，不能直接复制 live WAL DB。

---

# 75. 迁移包禁止包含 secret

绝不包含：

```text
.env
OpenAI key
Fish key
MCP token
Admin token
Web chat token
SSH
GitHub token
VAPID
```

模型只导出：

```text
provider
baseUrl
model
参数
apiKeyConfigured
建议 secretRef
```

手机首次导入后重新填 Key。

---

# 76. 迁移可回滚

导入：

```text
staging
→ verify manifest
→ verify sha256
→ DB preflight
→ media hash
→ transaction / atomic directory switch
→ migration receipt
```

失败：

```text
rollback
删除 staging
旧本地数据库不受影响
```

相同 exportId 不允许重复导入。

---

# 77. OTA

Core 是 TypeScript，所以：

```text
React + 大部分 SOOYA 业务逻辑
```

都能 OTA。

服务器只提供静态更新文件。

Manifest：

```json
{
  "schema": 1,
  "channel": "stable",
  "webVersion": "1.14.2",
  "commit": "abc1234",
  "url": "https://updates.example/ota/stable/1.14.2.zip",
  "sha256": "...",
  "bytes": 2345678,
  "minNativeVersion": "1.0.0",
  "minSchemaVersion": 42,
  "maxSchemaVersion": 42,
  "requiredCapabilities": [
    "db.v2",
    "http.stream.v1",
    "media.v1",
    "secrets.v1",
    "mcp.v1"
  ],
  "publishedAt": "..."
}
```

---

# 78. Native Capability Manifest

App 启动 Native 返回：

```json
{
  "nativeVersion": "1.0.0",
  "bridgeVersion": 3,
  "schemaVersion": 42,
  "capabilities": [
    "db.v2",
    "http.stream.v1",
    "media.v1",
    "secrets.v1",
    "mcp.v1"
  ]
}
```

OTA 必须同时检查：

```text
native version
schema
bridge capability
```

---

# 79. OTA 应用时机

发现更新时可以下载，但以下任何任务存在就禁止切换：

```text
reply active
tool call active
db migration
media write
import/export
```

最安全：

```text
下载 → verify → pending → 下次冷启动切换
```

---

# 80. OTA 回滚

使用成熟 updater 的 last-good / `notifyAppReady()` 机制。

Ready 条件：

```text
React root mounted
LocalCore init
DB open
schema migration success
Native capability check passed
```

不要求：

```text
模型在线
MCP 在线
天气在线
```

第三方故障不能让正常 OTA 被回滚。

---

# 81. 哪些 OTA，哪些重打 IPA

只改：

```text
Chat
Context
Life
动态
Memory
Tool Policy
Provider payload
UI/CSS
Admin
大部分 MCP 管理逻辑
```

→ OTA。

改：

```text
Swift Plugin
Capacitor plugin
Info.plist
Bundle ID
Native DB/HTTP/MCP/Media capability
```

→ 新 IPA → 全能签。

---

# 82. GitHub unsigned IPA

macOS runner：

```text
Node 22
Xcode 26+
npm ci
npm run build
npx cap sync ios
xcodebuild CODE_SIGNING_ALLOWED=NO
Payload/SOOYA.app → SOOYA-unsigned.ipa
```

你：

```text
下载
→ 全能签
→ 安装
```

GitHub 不存 `.p12` / mobileprovision / 密码。

---

# 83. Bundle ID

第一次就固定，例如：

```text
com.sooya.app
```

后续不要随意变。

它关系到：

```text
覆盖安装
App data
Keychain service
```

本方案不需要 Push entitlement。

---

# 84. CI 最终结构

当前 Server-centric CI 改成：

```text
Core Unit
Core Integration
Web Unit
UI E2E
Migration
Native Swift Tests
iOS Simulator Smoke
Unsigned IPA Build
OTA Verify
Dependency Audit
```

---

# 85. Core Test

重点：

```text
ReplyCoordinator
Context
Tool Runtime
Tool Policy
Memory
Life
Moment
Provider protocol
Sticker
Voice planning
```

---

# 86. DB Integration

Node 测试环境可以保留一个 async `better-sqlite3` Adapter，只用于 CI。

生产不使用。

验证：

```text
Repo
Migration
Transaction
FTS
Import/export
foreign key
```

---

# 87. UI E2E

浏览器 E2E 不再启动 SOOYA Server。

使用：

```text
TestLocalClient
```

验证：

```text
Header
Chat
动态
MCP Admin
模型 Admin
Media
移动宽度
滚动
```

真正 Core/native 集成放 iOS smoke。

---

# 88. Native Test

至少覆盖：

```text
SQLite transaction rollback
WAL / backup / restore
Keychain
HTTP redirect stripping
HTTP SSE chunk / abort
MCP modern/legacy
MCP pagination
Media sha256 / thumbnail / atomic write
```

---

# 89. MCP Contract Fixture

必须有：

```text
modern 2026 Streamable HTTP
legacy Streamable HTTP
legacy SSE
401 Bearer
OAuth
pagination
schema change
tool error
timeout
disconnect/reconnect
```

前台导入新 MCP 才不是“碰巧能连 Ombre”。

---

# 90. Migration Fixture

提交一个脱敏 fixture：

```text
migration-fixtures/server-v35/
```

CI 每次：

```text
export
→ verify
→ import local
→ migrate
→ integrity
→ count/hash parity
```

真实生产 snapshot 也要在切换前做一次 dry-run。

---

# 91. Parity Test

旧 Server 和新 LocalCore 用同一 fixture 比较：

```text
Context assembly
Life snapshot
Message serialization
Moment serialization
Sticker retrieval
Tool Policy
Provider payload
```

把时间/id normalize 后比较。

---

# 92. 删除 Push

最终删除/停用：

```text
PushService
PushSubscriptionRepo runtime
push.reply
Push routes
PWA push native path
APNs plan
notification UI
```

旧 DB migration/table 可以作为历史保留，不再读写。

---

# 93. 删除 Server Auth / CORS

Native 不再使用：

```text
WEB_CHAT_TOKEN
ADMIN_API_TOKEN
CORS_ALLOWED_ORIGINS
SOOYA_PUSH_SUBJECT
```

也不再有：

```text
/api/bootstrap
/api/messages
/api/stream
/api/admin/*
```

作为运行依赖。

---

# 94. 删除生产 Server Runtime

最终不再生产依赖：

```text
Fastify
@fastify/cors
@fastify/multipart
@fastify/static
systemd SOOYA
Docker SOOYA runtime
Cloudflare/Nginx → SOOYA API
Server SQLite
Server MediaStore
```

更新域名只静态托管 OTA/IPA。

---

# 95. Ombre 退休顺序

不能先删。

```text
导出 Ombre
→ 导入手机
→ memory count / search / recall 验收
→ 保留旧 buckets 只读备份
→ 再停 Ombre
```

---

# 96. 一次性 Cutover

```text
T0 旧 Server 继续运行
T1 Local Core + iOS 全部开发完成
T2 CI / Simulator / Migration fixture 全绿
T3 旧 Server 短暂只读，停止新写
T4 生成 DB snapshot + media + config + Ombre memory
T5 安装全能签 Local IPA
T6 导入 Migration ZIP
T7 本机 integrity / foreign key / hash / counts 验证
T8 真机 smoke：聊天/图片/语音/动态/MCP/重启
T9 停 SOOYA backend
T10 停 Ombre runtime
T11 域名只保留更新静态文件
T12 旧数据保留只读观察期
```

---

# 97. 一次性实施任务清单

**可以拆 commit，但不能中间交付。**

## Task 1：`packages/core`
搬纯 TS types、ToolRegistry、ToolPolicy、ToolRuntime、provider contracts、通用 utils，建立 Node import boundary test。

## Task 2：Platform Contracts
创建 database/secrets/http/media/mcp/logger/lifecycle 接口。

## Task 3：Repo async 化
迁 Message/Media/Sticker/Settings/Summary/Event/Job/Life/Location/Weather/Metrics/Thought/Moment/ReplyBatch/Voice/Audit/Memory Repo，全链路 `await`。

## Task 4：Native Database
完成 `SOOYADatabasePlugin.swift`、事务 batch、WAL、backup/restore、FTS probe、integrity。

## Task 5：Config + Keychain
完成 `ConfigRepository`、secret refs、`SOOYASecretsPlugin.swift`，所有模型/MCP secret 迁出 JSON/localStorage。

## Task 6：Native HTTP + Provider
完成 SSE、binary、abort、timeout、redirect 安全，迁所有 Provider。

## Task 7：Local EventBus + LocalSooyaClient
替换 REST/SSE，保持当前 UI event semantics。

## Task 8：Reply/Core
迁 Context、Summary、Replier、ReplyCoordinator、MediaDirector、Thoughts、Voice、Search。

## Task 9：Native Media
替换 fs/sharp/file-type，迁图片/音频/Sticker/文件/参考图/thumbnail。

## Task 10：Local Memory
迁旧 MemoryService，建立 MemoryRouter、LocalMemoryProvider、receipt、local memory tools、Ombre importer。

## Task 11：Native MCP + 前台 MCP 管理
完成 CRUD、JSON Import、Bearer、OAuth、modern/legacy、工具授权、memory-provider 映射。

## Task 12：Life Catch-up
实现 event-boundary catch-up、seed/simulation version、long-gap coarse settle。

## Task 13：动态收口
正式 `Proactive → Moment`，完成 catch-up candidates、历史 createdAt、dedupe/cap/gap、图片 job。

## Task 14：LocalTaskScheduler
替代 JobWorker timer，foreground drain、priority、crash recovery、abort；删除 push。

## Task 15：Admin Local
替换 adminRequest/admin token，新增本机状态、MCP CRUD、backup/import/export、versions/OTA。

## Task 16：Capacitor UX
Capacitor 8 + ios、Keyboard、Safe Area、StatusBar、Splash、Share、Browser、Haptic。

## Task 17：Migration
完成一致 DB snapshot、Media、Config、Ombre export、Local importer、receipt、rollback。

## Task 18：OTA
Self-hosted update、SHA、native/schema/capability gate、pending、last-good rollback。

## Task 19：CI / IPA
重做 CI、Native tests、Simulator smoke、migration fixture、unsigned IPA、OTA publish。

## Task 20：最终清理
删除生产 Fastify/Push/REST/SSE/Admin auth/Server deployment/Ombre requirement/Native SW updater/旧 proactive 语义，更新文档。

---

# 98. 开发代理不能停在这些中间态

不接受：

```text
Capacitor 壳能开，但聊天仍走服务器
DB 本地了，但媒体仍走 /api/media
MCP 有“添加”按钮，但保存仍写服务器 mcp.json
API key 进手机了，但 localStorage 还有副本
Life 关 App 后仍冻结
动态 catch-up 会刷十几条
OTA 能下载但无 rollback
IPA 能 build 但旧数据迁不过来
Server 一关 App 核心功能就坏
```

---

# 99. 最硬的完成标准

完成后执行：

```text
sudo systemctl stop sooya
docker stop sooya-ombre-brain
```

手机仍必须：

```text
打开
看旧消息
聊天
流式回复
图片
语音
Sticker
动态
Life
Location
Weather（手机直连）
Memory
MCP（手机直连）
Admin
备份
恢复
```

唯一受影响：

```text
更新服务器也停了
→ 暂时查不到新版
```

App 本身不受影响。

---

# 100. 数据验收

迁完：

```text
messages count 一致
message_parts 一致
moments count 一致
like 一致
media referenced files SHA256 一致
stickers count 一致
persona 一致
reference images 一致
Life 可正确 catch-up
Ombre + legacy memories 导入
foreign_key_check = 0
integrity_check = ok
```

---

# 101. 聊天验收

```text
单消息
连续消息
打断
streaming
timeout/retry
partial
引用
撤回
搜索
按日期
500+ 历史
图片
文件
Sticker
语音
tool call
memory recall
```

---

# 102. 生命周期验收

```text
发消息时 Home
返回
锁屏
解锁
强杀
重启
离开 2h
离开 1d
离开 7d
```

不能：

```text
丢消息
重复回复
重复 memory commit
重复动态
Life 卡旧状态
```

---

# 103. 动态验收

```text
离开 12h
重新打开
Life 当前状态合理
不会瞬间刷屏
动态时间是历史事件时间
candidate 不重复
图片失败可降级
聊天优先
历史天气缺失不编造
```

---

# 104. MCP 验收

```text
新增
JSON 导入
编辑
禁用
删除
Bearer
OAuth
测试
刷新
分页
新工具默认禁用
授权
schema change
单 Server 隔离
timeout
abort
reconnect
legacy
modern
```

---

# 105. 密钥验收

搜索：

```text
Web bundle
SQLite
backup zip
logs
error_log
migration export
```

都找不到真实：

```text
API Key
MCP Token
```

Keychain 删除后对应能力立即显示未配置。

---

# 106. 性能验收

真机：

```text
500+ 消息
100+ 图片
快速滚动
Gallery
动态
MCP 工具列表
Admin
键盘反复开关
```

要求：

```text
无横向溢出
无明显卡顿
DB transaction 不逐条跨 bridge
大文件不反复 base64 整份复制
首屏不等待 maintenance
```

---

# 107. OTA 验收

```text
正常更新
更新服务器离线
下载中断
SHA 错
manifest 错
minNative 不满足
schema 不满足
bridge capability 不满足
JS 启动崩溃
DB migration 失败
自动 rollback
聊天进行中发现更新
```

任何失败都不能把 App 变砖。

---

# 108. 自签验收

```text
SOOYA-unsigned.ipa
→ 全能签
→ 安装
→ 使用
```

之后新 Native 版覆盖安装：

```text
DB 保留
Media 保留
Keychain 保留
OTA 状态合理
```

因此 Bundle ID 和 Keychain service 名必须第一版定死。

---

# 109. 最终不再需要

```text
WEB_CHAT_TOKEN
ADMIN_API_TOKEN
SOOYA_PUSH_SUBJECT
VAPID
APNs
Push subscriptions
CORS
Fastify production
/api/*
服务器 SQLite
服务器媒体
server Life timer
server JobWorker
Ombre Docker
```

旧代码只可作为 migration/reference，不可成为运行依赖。

---

# 110. 推荐的 Commit 组织

```text
1  core contracts
2  async db repos
3  ios database/secrets
4  native http + providers
5  local client/event bus
6  reply/context/core
7  native media
8  local memory
9  native MCP + MCP admin
10 life catch-up
11 moments cleanup
12 local scheduler
13 admin local
14 capacitor UX
15 migration
16 OTA
17 CI/IPA
18 remove server runtime/push
19 parity + docs
```

**Commit 可以多，交付只有一次。**

---

# 111. 最关键的设计决定

不要把 SOOYA 全重写成 Swift。

Swift 只负责：

```text
SQLite
Keychain
HTTP transport
MCP transport
Media/filesystem
iOS shell
```

真正的 SOOYA 继续 TypeScript：

```text
Chat
Context
Life
动态
Memory
Tool
Provider protocol
Voice logic
Sticker logic
```

这样才能：

```text
最大复用现在代码
维持一套业务逻辑
绝大部分功能以后可 OTA
避免重新制造第二个 SOOYA
```

---

# 112. 最终版本信息

Admin：

```text
SOOYA

Native       1.0.0
Core/Web     1.0.0-local.42 / abcdef1
Database     schema 42
Bridge       v3
Update       stable / 已是最新
```

---

# 113. 日常最终体验

安装一次：

```text
SOOYA.ipa
→ 全能签
→ iPhone
```

之后：

```text
打开 SOOYA
→ 本地启动
→ 历史就在手机
→ Life 自动追上时间
→ 动态自然补齐
→ 模型手机直连
→ Memory 本地
→ MCP 手机直连
```

新增 MCP：

```text
管理 → MCP → 添加
→ 粘 URL / JSON
→ 填认证
→ 测试
→ 保存
→ 刷新工具
→ 授权
```

下一条消息即可使用。

普通代码更新：

```text
push main
→ CI
→ OTA
→ 手机安全切新版
```

Native 更新：

```text
push
→ GitHub unsigned IPA
→ 全能签
→ 覆盖安装
```

服务器只做：

```text
“有新版本。”
“这是更新包。”
```

---

# 114. 给开发代理的总指令

```text
一次性把 SOOYA 从 server-centric 架构迁成 iOS local-first。

必须：
- 保留当前 React UI
- 建立纯 TS packages/core
- 业务逻辑全部本地运行
- Native SQLite + async repositories
- API/MCP secrets 只存 Keychain
- Provider 网络使用 Native URLSession bridge
- MCP 可前台新增/导入/编辑/禁用/删除/测试/刷新/授权
- MCP 支持 modern Streamable HTTP + legacy fallback
- iPhone 明确拒绝 arbitrary stdio npx/python MCP
- Local Memory 为默认，支持 optional MCP/Hybrid
- 旧 Ombre 记忆一次性迁到本地
- Life 用 elapsed-time catch-up，不依赖后台 timer
- 所有产品 proactive 语义改为 Moment/动态
- 无主动消息、无 Push、无 APNs、无 Local Notification
- 动态从 Life share candidate 生成，catch-up 不刷屏
- LocalTaskScheduler 只在 active 时 drain
- 保留 ReplyCoordinator batch/revision/interrupt/publish 语义
- Media 放 App Sandbox，Native 管 hash/type/metadata/thumbnail
- Admin 不再 HTTP，不再 admin token
- OTA 自托管，带 hash/native/schema/bridge gate 和 rollback
- GitHub 产出 unsigned IPA，全能签重签
- 提供真实旧 DB + Media + Ombre 的一次性 migration export/import
- 最终关掉 SOOYA server/Ombre 后，除更新检查外全部正常
- 全部测试和真机 smoke 通过才算完成

禁止：
- server.url 远程网页壳
- 把 Node Server 嵌进 iPhone
- API key 存 localStorage/SQLite/OTA bundle
- 保留 /api 作为 Native 业务依赖
- Life 正确性依赖 iOS 后台常驻
- 动态依赖通知
- 保留旧主动聊天功能
- MCP 新工具自动授权
- iPhone 动态执行任意 stdio Node/Python MCP
- 中间态交付
```

---

# 115. 最终 Checklist

```text
[ ] 全能签 IPA 可安装
[ ] 一次导入旧 SOOYA 数据成功
[ ] 旧聊天/图片/语音/Sticker/动态完整
[ ] Ombre 记忆迁本地
[ ] Local Memory 正常
[ ] 模型手机直连
[ ] Streaming 正常
[ ] Tool Runtime 正常
[ ] MCP 前台动态导入
[ ] MCP secrets 在 Keychain
[ ] Life 关闭 App 后 catch-up
[ ] 动态从 catch-up 事件自然生成
[ ] 无主动消息
[ ] 无 Push
[ ] Server 业务进程关闭后完整使用
[ ] Server 只剩 OTA/IPA
[ ] Keyboard/Safe Area/StatusBar 正常
[ ] 长消息列表性能正常
[ ] 备份/恢复正常
[ ] OTA 正常
[ ] 坏 OTA 自动 rollback
[ ] Native 变化才需重签 IPA
[ ] CI 全绿
```

满足全部，才叫这次“一次性做完”。
