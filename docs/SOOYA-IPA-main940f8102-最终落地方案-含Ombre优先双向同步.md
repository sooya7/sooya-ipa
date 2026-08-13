# SOOYA IPA：`main@940f8102` 后最终落地方案
## 目标：Final Native Base 正式安装一次，之后长期 OTA

> 当前代码已经完成主要本地化收口。现在只做发布落地，不再改大架构。
>
> 最终链路：**Native OTA 信任根固化 → OTA 托管 → Final IPA → 全能签 → 真机 → 旧数据迁移 → OTA 自更新/回滚 → 关闭旧业务服务器。**

---

# 1. 当前基线

```text
repo: sooya7/sooya-ipa
branch: main
merge: 940f8102
native-base.version: 2
schema: 45
bridge version: 2
```

已经完成：

```text
LocalCore
本地 SQLite
Keychain
Native HTTP / SSE / WebSocket
Native MCP
Native Media
Native Archive
Provider
Reply / Context / Summary
Local Memory
Life / Moment
Local Admin
Local / Push Notifications Plugin
OTA download / pending / cold-boot apply
OTA rollback 状态
Ed25519 验签代码
Native Freeze Guard
OTA Migration Guard
GitHub OTA Artifact
GitHub unsigned IPA
```

现在剩下的是最后发布层。

---

# 2. 正式安装前唯一建议再补的 Native 点

当前 OTA verifier 已经支持 Ed25519，但最终母版不能把 manifest 自己携带的 public key 当成信任根。

必须变成：

```text
GitHub Actions
  OTA_PRIVATE_KEY
       ↓
签 OTA Manifest
       ↓
updates.example.com

iPhone Final Native Base
  内置 OTA_PUBLIC_KEY
       ↓
验 Manifest
       ↓
验 bundle SHA256
       ↓
才允许 download / apply
```

---

# 3. 新增只读 Native Release Config

建议新增：

```text
SOOYAReleaseConfig.swift
SOOYAReleasePlugin.swift
```

Native 固化：

```text
nativeBaseVersion
bridgeVersion
capabilities
otaPublicKey
```

示意：

```swift
enum SOOYAReleaseConfig {
    static let nativeBaseVersion = 3
    static let bridgeVersion = 3
    static let otaPublicKeyBase64 = "<ED25519_RAW_PUBLIC_KEY_BASE64>"

    static let capabilities = [
        "database.sqlite",
        "keychain.secrets",
        "http.native",
        "http.stream",
        "http.websocket",
        "mcp.native",
        "mcp.transport",
        "media.sandbox",
        "archive.zip",
        "oauth.system",
        "notifications.local",
        "notifications.push-client",
        "ota.updater",
        "ota.signature.ed25519"
    ]
}
```

Plugin 只暴露：

```text
getReleaseInfo()
```

不提供写接口。

---

# 4. `native-base.version` 升到 3

现在是：

```text
2
```

正式安装前新增 Native trust root 后：

```text
2 → 3
```

Final Native Base 3 作为长期冻结基线。

以后 OTA：

```text
native.min = 3
native.max = 3
```

直到真的发布 Native Base 4。

---

# 5. OTA verifier 最终改法

删除把这些 TS 常量当权威来源的做法：

```text
NATIVE_BRIDGE_VERSION
BRIDGE_CAPABILITIES
globalThis.SOOYA_OTA_PUBLIC_KEY_B64 fallback
```

启动时：

```text
releaseInfo = await SOOYARelease.getReleaseInfo()
```

然后传入：

```text
LocalOtaUpdater(core, releaseInfo)
```

Manifest compatibility 使用真正 Native 返回的：

```text
nativeBaseVersion
bridgeVersion
capabilities
otaPublicKey
```

---

# 6. Ed25519 正式规则

生产 OTA：

```text
signature 必须存在
algorithm 必须 ed25519
manifest publicKey 如果存在，必须等于 Native pinned key
signature 必须通过
bundle zip SHA256 必须通过
```

生产模式下：

```text
无 signature → reject
key mismatch → reject
signature invalid → reject
```

---

# 7. 生成长期 OTA Key Pair

只生成一次。

Private Key：

```text
GitHub Secret:
OTA_PRIVATE_KEY
```

绝不能进入：

```text
repo
OTA server
App
SQLite
backup
```

Public Key：

```text
固化进 Final Native Base 3
```

Public Key 不需要保密。

---

# 8. GitHub Secrets

最终配置：

```text
OTA_PRIVATE_KEY
OTA_PUBLISH_URL
OTA_PUBLISH_TOKEN
```

例如：

```text
OTA_PUBLISH_URL=https://updates.example.com/sooya
```

Token 只允许上传更新文件，建议至少 32 random bytes。

---

# 9. OTA 发布改成 fail-closed

开发期没有托管地址时安全跳过是对的。

正式上线后，main 的 publish job 应该：

```text
缺 OTA_PUBLISH_URL → fail
缺 OTA_PUBLISH_TOKEN → fail
缺 OTA_PRIVATE_KEY → fail
```

Artifact 构建仍可独立成功。

但生产：

```text
stable.json
```

绝不能发布 unsigned OTA。

---

# 10. 更新服务器最终职责

服务器只做：

```text
静态 GET
受限 PUT 发布
```

不运行任何 SOOYA 业务。

目录：

```text
/var/www/sooya-updates/
├─ stable.json
├─ bundles/
│  └─ ota-<commit>/bundle.zip
└─ manifests/
   └─ ota-<commit>/ota-manifest.json
```

公开：

```text
GET /sooya/stable.json
GET /sooya/bundles/...
GET /sooya/manifests/...
```

发布：

```text
PUT
Authorization: Bearer <OTA_PUBLISH_TOKEN>
```

---

# 11. 发布必须原子写

服务器收到 PUT：

```text
写 .tmp
→ fsync
→ rename
```

尤其 `stable.json` 必须原子替换。

不能边上传边覆盖正式文件。

---

# 12. 更新域名

正式用：

```text
updates.<长期控制的域名>
```

不要把服务器 IP 写进 App。

以后换服务器：

```text
只改 DNS
```

不需要重新安装 IPA。

---

# 13. TLS

OTA 只走：

```text
HTTPS
```

建议更新站只暴露 443。

发布接口：

```text
Bearer Token
```

可选再加 IP allowlist。

---

# 14. App 的 manifestUrl

真机设置：

```text
ota.manifestUrl =
https://updates.example.com/sooya/stable.json
```

当前设计可从本地 Admin/SQLite 配置。

测试时可临时指向 staging。

---

# 15. OTA 最终运行流程

GitHub：

```text
push main
→ CI
→ OTA safety guard
→ build web/core
→ build bundle.zip
→ Ed25519 sign manifest
→ upload immutable bundle
→ upload immutable manifest
→ verify
→ atomic stable.json
```

iPhone：

```text
读取 stable.json
→ Native compatibility gate
→ Pinned Ed25519 verify
→ 下载
→ SHA256 verify
→ pending
→ 当前会话继续
→ 下次冷启动 apply
→ React / DB / LocalCore ready
→ notifyAppReady
→ promote lastGood
```

---

# 16. 坏 OTA

如果发生：

```text
JS crash
LocalCore boot fail
migration fail
capability mismatch
signature fail
hash fail
```

结果必须是：

```text
不应用
或
rollback lastGood
```

坏 release：

```text
blocked
```

不能反复下载。

---

# 17. OTA DB 规则继续锁死

长期 OTA 只允许：

```text
CREATE TABLE
ADD COLUMN
CREATE INDEX
新增 setting
兼容旧字段的新 payload
```

禁止：

```text
DROP
DROP COLUMN
destructive RENAME
不可逆数据重写
```

现有 OTA Migration Guard 必须继续保留。

---

# 18. Native Freeze Guard

Final Native Base 3 后：

```text
ios/**
Native dependencies
Entitlements
Bundle ID
Keychain Access Group
```

默认冻结。

普通 PR 修改这些：

```text
CI 拦截
```

只有明确做 Native Base 4 才放行。

---

# 19. Final unsigned IPA

OTA Public Key Pin 合并并 CI 全绿后：

```text
main
→ iOS unsigned IPA workflow
```

这一次生成的才叫：

```text
Final Native Base 3 unsigned IPA
```

当前 `940f8102` 产物可测试，但不建议当永久母版。

---

# 20. 通知保留

Final 母版继续带：

```text
Local Notifications
Push Notifications Client
```

默认：

```text
通知关闭
首次不主动请求权限
```

真机后测试：

```text
Local Notification
APNs entitlement
APNs registration
```

能用就启用。

不能用也不影响 SOOYA。

以后通知策略都走 OTA。

---

# 21. 全能签

使用：

```text
Final Native Base 3 unsigned IPA
```

Bundle ID 保持：

```text
com.sooya.app
```

不要改。

签完安装。

---

# 22. 安装后先做 Native Self-Test

不要立刻关旧 Server。

先测试：

```text
SQLite
transaction
Keychain
Native HTTP
HTTP streaming
WebSocket
Media
Archive
MCP
OAuth
Local Notifications capability
Push capability
OTA updater
Native release info
Pinned OTA public key
```

Native 有问题就现在修，再出 Final IPA。

---

# 23. 手机上的模型 Key

Admin 重新设置：

```text
Chat
Vision
Summary
Director
Embedding
Image
TTS
Rerank
Web Search
MCP Token
```

全部进 Keychain。

不要把旧 `.env` 自动搬进手机。

---

# 24. 真机 Chat 验收

至少测试：

```text
普通聊天
真 streaming
连续消息
打断
retry
tool call
MCP
Memory recall
图片
TTS
Sticker
引用
撤回
搜索
Home / 返回
强杀 / 重启
```

---

# 25. Life / 动态验收

测试：

```text
立即状态
离开 30 min
离开 2 h
离开一晚
```

检查：

```text
Life catch-up
Location
Weather
Moment
历史 createdAt
不会刷屏
```

---

# 26. 通知验收

Local：

```text
Admin 主动点测试
→ request permission
→ schedule
→ background
→ 收到
→ 点击
```

Push：

```text
register
```

拿到 token：

```text
APNs available
```

entitlement error：

```text
Remote Push disabled
```

不阻塞 Final。

---

# 27. 旧服务器数据导出

真机新 App 基础功能确认后：

```text
旧 SOOYA 进入短只读窗口
```

生成：

```text
SOOYA-Migration.zip
├─ manifest.json
├─ sooya.db
├─ media/
├─ references/
├─ persona
├─ models.redacted
├─ mcp.redacted
├─ memories/ombre.jsonl
└─ SHA256SUMS
```

数据库必须做一致 snapshot。

不能直接复制 live WAL DB。

---

# 28. Migration 不带 Secret

绝不包含：

```text
.env
API Keys
MCP Bearer
GitHub Token
SSH Key
Admin Token
```

手机上的 Keychain 已经单独配置。

---

# 29. 手机导入

```text
Files
→ Migration ZIP
→ Native Archive staging
→ checksum
→ DB integrity
→ foreign_key_check
→ schema migration
→ Media SHA
→ Memory import
→ atomic promote
```

失败：

```text
rollback
```

---

# 30. 数据核对

对比：

```text
messages count
message parts
moments
likes
stickers
media SHA256
references
persona
memory count
Life state
Location state
```

SQLite：

```text
integrity_check = ok
foreign_key_check = 0
```

---

# 31. 真实 OTA 验收

安装正式母版后做一个纯 TS 小改动。

例如：

```text
Admin 版本页新增测试文案
```

push main。

确认：

```text
CI
→ signed OTA
→ publish
→ 手机发现
→ download pending
→ 当前不 reload
→ 完全关闭 App
→ 再打开
→ 新 Bundle
→ notifyAppReady
→ lastGood 更新
```

---

# 32. 坏 OTA 回滚

用临时测试 manifestUrl。

发布一个“能验签但 boot 会失败”的测试 Bundle。

确认：

```text
apply
→ ready fail
→ rollback
→ lastGood 正常
→ failed release blocked
```

完成后切回正式 stable URL。

---

# 33. 更新服务器断网测试

更新站关闭或手机断网时，SOOYA 必须仍然：

```text
聊天
Memory
MCP
Life
动态
Media
Admin
```

全正常。

只是不更新。

---

# 34. Backup / Restore

旧 Server 下线前：

```text
导出完整本地 Backup
```

保存到 Files / iCloud / NAS。

再做一次 Restore 验证。

确认：

```text
DB
Media
References
Config
```

都正常。

---

# 35. 旧业务服务器下线，但 Ombre 保留为可选优先记忆脑

所有验收通过后：

```text
stop SOOYA Node/Fastify
```

**不要求关闭 Ombre。**

Ombre 从：

```text
SOOYA 必需后端
```

改为：

```text
优先但可失联的外部 Memory MCP
```

目标：

```text
Ombre 在线
→ 优先参与 Recall
→ 与 Local Memory 双向同步

Ombre 离线
→ Local Memory 100% 接管
→ Chat / Life / 动态 / MCP 其他能力完全正常
```

不要马上删除旧磁盘。

保留：

```text
旧 DB
Media
Ombre data
Migration ZIP
```

只读观察一段时间。

---

# 36. 服务器最终状态

SOOYA 业务服务器最终只剩：

```text
updates.example.com
```

负责：

```text
OTA publisher
OTA static files
可选 IPA archive
```

**Ombre 如果继续使用，可以独立存在，但不再是 SOOYA 必需依赖。**

最终服务边界：

```text
SOOYA iPhone
├─ Local Memory          ← authoritative durability / offline fallback
└─ Ombre MCP             ← online priority memory brain

Update Host
└─ OTA / IPA only
```

Update Host 不再保存 SOOYA Chat/Life/Media/SQLite。

---

# 37. 以后日常更新

普通改动：

```text
packages/core/**
packages/web/**
OTA-safe migration
```

以后：

```text
push main
→ CI
→ signed OTA
→ publish
→ iPhone 下次冷启动更新
```

不再重新全能签。

---

# 38. 什么时候才需要新 IPA

只有：

```text
Swift API
新 Native Plugin
Entitlement
Bundle ID
Keychain Access Group
Native Capability
```

变化时，才：

```text
Native Base 3 → 4
```

---

# 39. 自签例外

即使 SOOYA 功能永远走 OTA：

```text
证书/profile 到期、撤销、失效
```

iOS 仍可能要求重新签名安装。

这属于签名生命周期，不是 SOOYA 功能更新。

---

# 40. 实际执行顺序

```text
A 代码
1 Native OTA Public Key Pin
2 Native Release Config
3 native-base 2 → 3
4 production OTA fail-closed
5 CI

B OTA 基础设施
6 生成 Ed25519 key pair
7 配 OTA_PRIVATE_KEY
8 部署 updates.domain
9 配 OTA_PUBLISH_URL / TOKEN
10 publish smoke

C Final IPA
11 构建 Final Native Base 3 unsigned IPA
12 全能签
13 安装

D 真机
14 Native self-test
15 配 Provider/MCP Keys
16 Chat/MCP/Memory
17 Life/Moment
18 Notifications

E 数据
19 旧 Server 只读
20 Migration export
21 手机 import
22 count/hash/integrity

F OTA
23 正常 OTA
24 冷启动 apply
25 坏 OTA rollback
26 更新服务器断网测试

G 收尾
27 Backup/Restore
28 关闭 SOOYA Server
29 验证 Ombre 离线时 Local Memory 完整接管
30 验证 Ombre 恢复后的双向同步
31 只保留 update host + 可选 Ombre Memory MCP
```

---

# 41. 最终 DoD

```text
[ ] OTA Public Key Native pinned
[ ] Native capability 由 Native Base 返回
[ ] native-base.version = 3
[ ] production OTA 强制签名
[ ] OTA Publisher 已部署
[ ] GitHub 自动 publish
[ ] stable.json 原子替换
[ ] Final unsigned IPA 成功
[ ] 全能签安装成功
[ ] Native self-test 全通过
[ ] Chat / streaming 正常
[ ] Memory / MCP 正常
[ ] Life / 动态正常
[ ] Notification capability 已实测
[ ] 真实旧数据迁移成功
[ ] 数据 count/hash/integrity 正确
[ ] 正常 OTA 真机成功
[ ] 坏 OTA 自动回滚
[ ] 更新服务器离线不影响 SOOYA
[ ] Backup / Restore 成功
[ ] 旧 SOOYA Server 关闭
[ ] Ombre 不再是运行必需
[ ] Ombre 在线时优先 Recall
[ ] Ombre 离线时 Local 100% fallback
[ ] Local ↔ Ombre 双向同步正常
[ ] Server 只剩更新托管 + 可选 Ombre Memory MCP
```

满足这些后，最终状态就是：

```text
Final Native Base 3
→ 全能签
→ 安装一次

之后：
SOOYA 功能更新
→ push main
→ OTA
→ 手机自己更新
```

---

# 43. Ombre + Local Memory 最终架构

这部分作为 Final Native Base 之后的正式 Memory 架构，不再把 Ombre 当一次性导入源。

最终：

```text
                  MemoryRouter
                 /            \
           Ombre MCP          Local Memory
          Online Priority     SQLite
               │                │
               └──── Recall ────┘
                       ↓
               Normalize / Dedupe
                       ↓
                    Rerank
                       ↓
                 ContextBuilder
```

核心原则：

```text
Recall 优先 Ombre
Durability 优先 Local
同步双向
Ombre 可失联
Local 永不缺席
```

---

# 44. Recall 优先级

Ombre 在线：

```text
并行查询：
├─ Ombre recall
└─ Local recall
```

然后：

```text
source-aware dedupe
→ 同一记忆 Ombre 版本优先
→ Local 补充 Ombre 没召回的内容
→ 统一 rerank
→ Context budget
```

不要做：

```text
Ombre 有结果
→ 完全不查 Local
```

否则会漏召回。

同一条记忆冲突时，默认优先：

```text
Ombre 当前有效版本
```

但最终还要服从下面的冲突规则。

---

# 45. Ombre 离线 Fallback

以下任何情况：

```text
timeout
401
500
断线
MCP unavailable
schema error
```

MemoryRouter：

```text
立即 degraded
→ 100% Local recall
```

Chat 继续正常。

Ombre recall timeout 建议：

```text
1500~2000ms
```

连续失败触发 circuit breaker：

```text
open
→ 一段时间不再每条消息尝试远程
→ 后台 health probe
→ 恢复后 half-open
→ success 后重新 ready
```

---

# 46. 写入策略：Local 先落盘

新长期记忆：

```text
Memory Extractor
↓
Local SQLite commit
↓
reply lifecycle 完成
↓
enqueue memory.sync.push
↓
异步写 Ombre
```

不能：

```text
先写 Ombre
→ Ombre 挂了
→ 本地也没记住
```

所以：

> Local 是 durability source of truth。

Ombre 是增强型远程记忆脑。

---

# 47. Local → Ombre 同步

新增 durable job：

```text
memory.sync.push
```

本地记忆保存：

```text
syncState
remoteSourceId
remoteRevision
lastSyncedAt
syncError
```

状态：

```text
pending_push
synced
conflict
error
```

Ombre 恢复后自动补推 pending。

---

# 48. Ombre → Local 同步

新增：

```text
memory.sync.pull
```

触发：

```text
App 启动 / 回前台
Ombre offline → ready
低优先级 maintenance
用户手动“立即同步”
```

优先使用 Ombre 提供的：

```text
cursor
updatedSince
revision
catalog
```

做增量同步。

如果当前 Ombre 没有稳定 delta API：

```text
catalog
→ sourceId/sourceHash diff
→ 只拉变化
```

禁止每次全量导入。

---

# 49. 本地保存 Ombre 镜像

同步下来的记忆：

```text
source = 'ombre'
sourceId = <remote id>
sourceHash = <canonical hash>
remoteRevision
lastSyncedAt
syncState = synced
```

这样：

```text
飞机模式
Ombre 宕机
服务器维护
```

都仍可使用最近一次同步下来的完整本地镜像。

---

# 50. 双向去重

去重顺序：

```text
1 sourceId
2 sourceHash
3 normalized content
4 embedding similarity
```

高语义相似：

```text
merge
```

而不是保存两个近似副本。

禁止形成：

```text
Local → Ombre → Local → Ombre
```

同步回环。

每条同步写必须带：

```text
origin
sourceId
sourceHash
revision
```

---

# 51. 冲突解决

默认优先级：

```text
用户显式 forget / edit
>
较新的高 confidence 记忆
>
Ombre 当前版本
>
旧 Local 镜像
```

如果双方都有变更且无法自动判断：

```text
syncState = conflict
```

保留两个 revision metadata，但 Context 只选一个 active winner。

Admin 允许手动处理冲突。

---

# 52. Forget 必须双向传播

用户删除一条记忆：

```text
Local tombstone
↓
memory.sync.push
↓
Ombre forget
↓
成功后保留 tombstone 一段时间
```

Tombstone 作用：

```text
防止下一次 pull
把刚删掉的记忆重新拉回来
```

建议 tombstone TTL：

```text
30~90 天
```

---

# 53. MemoryRouter 代码结构

新增：

```text
packages/core/src/memory/
├─ memory-router.ts
├─ hybrid-memory-provider.ts
├─ ombre-mcp-memory-provider.ts
├─ memory-sync-service.ts
├─ conflict-resolver.ts
└─ sync-types.ts
```

数据库：

```text
memory_sync_state
memory_sync_outbox
memory_tombstones
```

---

# 54. LocalCore wiring

当前：

```ts
this.memoryProvider =
  options.memoryProvider ??
  new LocalMemoryProvider(...)
```

改成：

```text
LocalMemoryProvider
      +
OmbreMcpMemoryProvider
      ↓
HybridMemoryProvider
      ↓
MemoryRouter
      ↓
this.memoryProvider
```

如果 Ombre 没配置：

```text
MemoryRouter = Local only
```

如果配置但离线：

```text
MemoryRouter = Local degraded mode
```

如果在线：

```text
MemoryRouter = Hybrid ready
```

---

# 55. Ombre Provider 配置

Admin → Memory：

```text
模式
● Hybrid
○ Local only
○ Ombre only（不推荐）
```

Ombre：

```text
MCP Server
Memory Search Tool
Memory Write Tool
Memory Update Tool
Memory Forget Tool
Sync Mode
Recall Timeout
Auto Sync
```

默认：

```text
Hybrid
Auto Sync = on
Recall Timeout = 1800ms
```

---

# 56. Admin Memory 状态

显示：

```text
Memory Mode
Hybrid

Local
Ready
1,248 memories

Ombre
Ready / Degraded / Offline
1,196 mirrored
Last sync 2m ago

Sync
Pending push 0
Pending pull 0
Conflicts 0
```

操作：

```text
立即同步
只同步到 Ombre
只从 Ombre 拉取
重试失败项
查看冲突
```

---

# 57. Context 使用规则

ContextBuilder 只依赖：

```text
MemoryRouter.recall()
```

不直接区分：

```text
Local
Ombre
```

Router 返回已经：

```text
dedupe
merged
ranked
bounded
```

的 MemoryRecall。

这样 ContextBuilder 不长出两套记忆逻辑。

---

# 58. Sync 优先级

Local Scheduler：

```text
100 Chat reply
90  reply tools
80  memory commit
75  memory.sync.push
70  Life catch-up
60  Moment text
50  Moment image
30  memory.sync.pull
20  memory maintenance
```

原因：

```text
新记忆推 Ombre
```

比后台全量 pull 更重要。

---

# 59. Sync 失败规则

Push 失败：

```text
Local 已保存
→ pending_push
→ retry
```

Pull 失败：

```text
继续使用现有 Local mirror
```

任何同步失败：

```text
不能让 Chat failed
```

---

# 60. 首次 Ombre 接入

如果手机第一次连接已有 Ombre：

```text
1 health
2 catalog / delta capability probe
3 pull remote memory
4 写 Local mirror
5 dedupe with existing Local
6 建 sourceId/sourceHash mapping
7 再开始 push Local pending
```

先 Pull 后 Push，避免首次连接把 Local 内容无脑覆盖远端。

---

# 61. 从旧 Ombre 迁移后的衔接

旧 Server cutover：

```text
Ombre 数据
```

有两种方式：

### Ombre 继续运行

```text
iPhone 直接连接 Ombre MCP
→ 首次全量/增量 sync
→ Local mirror
```

优先这个。

### Ombre 暂时不可从手机访问

才使用：

```text
ombre.jsonl
→ Local import
```

之后 Ombre 可连接时再建立映射。

---

# 62. Ombre 不再和 Update Host 混在一起

推荐：

```text
updates.example.com
→ OTA only

memory.example.com
→ Ombre MCP
```

两者分开。

以后：

```text
关 Ombre
```

不会影响 OTA。

```text
换 OTA 服务器
```

也不会碰 Memory。

---

# 63. 最终离线验收

人为断开 Ombre：

```text
关闭 Ombre 服务
或
手机阻断 memory 域名
```

确认：

```text
Chat 正常
Memory recall 正常
新记忆仍写 Local
syncState = pending_push
UI 显示 degraded
```

不能出现：

```text
聊天超时几秒后失败
Context 空掉
Memory commit failed
```

---

# 64. 恢复验收

重新启动 Ombre：

```text
health ready
↓
MemoryRouter 恢复 Hybrid
↓
pull changes
↓
push pending
↓
dedupe
↓
syncState 全部收敛
```

检查：

```text
无重复
无记忆丢失
无同步回环
```

---

# 65. Final DoD 增补

在原 Final DoD 基础上，再要求：

```text
[ ] HybridMemoryProvider
[ ] OmbreMcpMemoryProvider
[ ] MemoryRouter
[ ] MemorySyncService
[ ] Local → Ombre durable sync
[ ] Ombre → Local incremental sync
[ ] sourceId/sourceHash dedupe
[ ] tombstone forget propagation
[ ] conflict resolver
[ ] circuit breaker
[ ] Ombre offline → Local 100% fallback
[ ] Ombre restore → 双向自动收敛
[ ] Admin Memory sync status
[ ] Context 使用 unified MemoryRouter
```

最终 Memory 定义：

> **Ombre 在线时是优先记忆脑，Local 是完整本地镜像与永远可用的兜底；写入 Local 先落盘，再异步同步 Ombre；双方增量双向同步，Ombre 挂掉不影响 SOOYA。**

