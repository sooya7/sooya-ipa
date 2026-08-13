# SOOYA-IPA 交接文档(HANDOFF)

> 最后更新:2026-08-14(Native Base 3 + Ombre/Local 双向同步基础收口中)。
> **给后续任何开发代理(Codex/ZCode)**:先读本文件,再读 `docs/sooya-iphone-migration-plan.md`(总方案,20 个 Task),最后 `git log --oneline` 看提交历史。所有进度都在磁盘和 git 里,不需要依赖任何人的会话记忆。

### 当前方案与交流文档

- 最终落地方案：`docs/SOOYA-IPA-main940f8102-最终落地方案-含Ombre优先双向同步.md`
- 本文件是项目交接、决策和发布状态记录；方案原文与本文件位于同一分支，避免实现分支和文档分叉。

---

## 1. 项目概览

SOOYA 有两个仓库,职责分离:

| 仓库 | 位置 | 角色 | 状态 |
|---|---|---|---|
| `sooya7/sooya` | `C:\Users\iulze\Desktop\sooya` | **服务器版**(Node/Fastify/Ombre MCP),线上运行 | main 不动,继续服役直到 cutover T9 |
| `sooya7/sooya-ipa` | `C:\Users\iulze\Desktop\sooya-ipa` | **IPA 版**(iPhone 全本地),本仓库 | 主战场,`main@940f8102` 已落地；PR3 为 Native Base 3 收口分支 |

**最终目标**(方案 §1):聊天、Life、动态、记忆、MCP、Tool Runtime、模型、媒体、SQLite、配置全在 iPhone 本地;服务器只提供 IPA 和 OTA 静态文件。**明确不做**:主动消息、APNs、Push、本地通知、服务器业务 API。

---

## 2. 当前状态(2026-08-13)

### ✅ 已完成并验证
- **Task 1/2/3**:core contracts、platform interfaces、async db repos — core **17 文件/72 测试**全绿;boundary test 锁死 Node 依赖(生产 Core 零 Node import)
- **Task 4/5/6/9/11 的 Native 层**:5 个 Swift 插件 + XCTest 套件:
  - `SOOYADatabasePlugin`(SQLite C API:WAL、FTS5 trigram 探测、批量事务、backup/restore、integrity)
  - `SOOYASecretsPlugin`(Keychain,**只有 has/set/delete,无 get**;accessGroup 探测;错误不泄漏 secret)
  - `SOOYAHttpPlugin`(URLSession:SSE、重定向剥 Authorization、timeout/abort、生产拒绝明文)
  - `SOOYAMcpPlugin`(streamable-http + legacy fallback、分页、Bearer/OAuth token 引用)
  - `SOOYAMediaPlugin`(沙盒原子写、SHA256、缩略图、路径穿越拒绝)
- **iOS 编译已验证**:GitHub Actions(macOS)成功产出 unsigned IPA(artifact `SOOYA-unsigned-ipa`,2.68 MB)。过程中修掉的问题见 §5「踩过的坑」
- **Task 7 骨架**:`SooyaClient` 接口 + `LocalEventBus` + `LocalSooyaClient` + `TestLocalClient` + `nativeBoot.ts`(LocalCore ↔ Capacitor 插件接线、App 生命周期、键盘 inset)
- **LocalCore 骨架**(`packages/core/src/app/local-core.ts`):SooyaClient 15 方法全部实现(读路径全走本地 repo;send/withdraw/upload 最小可用;onAppActive/onAppInactive 生命周期)
- **Task 12/14 逻辑层**:`life/catch-up`、`moments/moment-policy`、`jobs/local-task-scheduler` 已在 core(有测试)
- **Task 16 基础**:Capacitor 8 工程(`com.sooya.app`,无 `server.url`)、safe-area/keyboard CSS 变量(`--sooya-safe-top/-bottom/--sooya-keyboard-height`)
- **Task 17/18 工具层**:`migration-tools`(portable 导出/校验/回滚、OTA manifest)10/10 测试;`scripts/` 4 个 CLI + `patch-xcode-project.mjs`
- **服务器版记忆修复已上线**:`sooya7/sooya` main `c2c903c`(零调用假成功→skipped/uncertain),CI 全绿,自动部署
- **本轮本地化实现**:ConfigRepository(SQLite)+Keychain secret refs、OpenAI-compatible/Anthropic/Embedding/Rerank/Image/TTS Provider、ReplyCoordinator、SQLite 本地记忆与批次 receipt、MCP 本地 CRUD/连接/工具注册/安全策略、Admin 本地 bridge、图库/动态/Life 本地路由
- **通知与 OTA**:通知仅做能力探测且默认关闭；原生 updater 有 native/schema/capability gate、pending/last-good 状态；OTA workflow 产出 manifest + bundle artifact
- **Ombre/Local Memory 同步基础**:schema 46 新增 `memory_sync_state`、durable outbox、tombstone、cursor；新增 `OmbreMcpMemoryProvider`、`MemorySyncService`，实现 Ombre 在线优先召回、Local 先落盘、断网 Local fallback、失败重试、sourceId/sourceHash 去重、forget 双向 tombstone、冲突状态与 circuit breaker；未配置 `ombre` MCP 时不联网
- **旧 Ombre 兼容**:自动识别 `memory.*`、`breath_search`、`hold` 等工具；没有 delta 工具时退回 catalog 映射，不阻塞本地运行
- **CI 约束**:Native Base 冻结守卫、Node 22 核心测试、Web 570 测试、migration-tools 11 测试、typecheck/build、unsigned IPA workflow 均已接入

### ⏳ 当前发布状态
1. `agent/final-native-base-3` / PR3 已包含 Native Base 3、只读 `SOOYAReleasePlugin` 和固化 Ed25519 OTA 公钥。
2. PR3 的 CI 与 macOS unsigned IPA 已通过；当前分支新增 schema 46，OTA workflow gate 已同步为 `schema 46`；合并前仍需配置 `OTA_PRIVATE_KEY`、`OTA_PUBLISH_URL`、`OTA_PUBLISH_TOKEN`。
3. 生产更新域名不硬编码：合并后在本机 Admin/SQLite 中设置 `ota.manifestUrl`，再进行真实 OTA 验收。
4. Ombre 同步只有在本机 Admin/SQLite 配置 id 为 `ombre` 的 MCP server 后才启用；默认仍是纯本地，不会因 Ombre 不可用阻断聊天。

### ⏳ 仍需外部条件才能完成

- PR3 合并到 `main`，并在 GitHub Actions Secrets 中配置真实 OTA 发布凭据；本代理不能替用户写入或生成生产密钥。
- 用同一签名证书生成正式 IPA、真机安装一次，完成 Native Self-Test、正常 OTA、坏包拒绝/回滚、断网/恢复验收。
- 从 `sooya7/sooya` 服务器导出真实 DB snapshot、media、config、Ombre memory，导入真实 iPhone 并核对 counts、SHA256、`integrity_check` 与 `foreign_key_check=0`。
- 连接真实 Ombre MCP 做 catalog/delta、push/pull、edit/forget 冲突和长期断网恢复验收；仓库目前只有 credential-free fixture，不能冒充真实服务验收。
- 在确认真机完全可用后，由有服务器权限的人执行 `systemctl stop sooya`、停止 Ombre runtime，并保留静态 OTA host（以及可选独立 Ombre MCP）。服务器仓库 `sooya7/sooya` 的 main 仍按约束不改。

---

## 3. 架构与依赖方向(不要偏离)

```
React UI (packages/web)
  └─ SooyaClient 接口(web/src/lib/sooyaClient.ts + local/LocalSooyaClient.ts)
       └─ LocalCore (packages/core/src/app/local-core.ts, 纯 TS, 零依赖)
            ├─ LocalDatabase  → SOOYADatabasePlugin (Swift SQLite)
            ├─ SecretsPlatform → SOOYASecretsPlugin (Keychain)
            ├─ HttpTransport   → SOOYAHttpPlugin (URLSession)
            ├─ MediaPlatform   → SOOYAMediaPlugin (沙盒)
            └─ McpTransport    → SOOYAMcpPlugin (streamable-http)
```

- **依赖方向**:web → `@sooya/core`(vite alias + tsconfig paths 指向 `../core/src/*.ts` 源码;core 是 TS 源码包,exports 有 6 个键:`.` `./tools` `./providers` `./platform` `./util/tool-history` `./app`)
- **core 零 dependencies**(devDeps 只有 typescript/vitest/better-sqlite3);boundary test 断言 exports 键数量——**加导出必须同步改 `packages/core/test/boundary.test.ts`**
- **better-sqlite3 只在测试**:core `test/db/node-local-database.ts` 从 core 自身 package.json 解析;migration-tools `src/sqlite.mjs` 从自身目录解析。生产 Core 永不 import 它
- **DB 契约**:`LocalDatabase`(open/close/execute/run/query/transaction/integrityCheck/backup)全 async;事务 = 单次 native batch(测试断言 `transactionCalls`)
- **web 本地化**:`installSooyaClient()` 只在 `isNativeSooya()` 时由 `nativeBoot.ts` 调用;浏览器保持远程 api 回退;`useChat` 默认 `currentSooyaClient() ?? api`
- **Memory 语义**(服务器版修复同款):零 tool call→`skipped`、全失败→`uncertain`、≥1 成功→`completed`;receipt 只记脱敏元数据,不记参数/凭据
- **iOS 工程**:SPM(CapApp-SPM,无 Podfile);自定义插件必须 `node scripts/patch-xcode-project.mjs` 注入 pbxproj(cap sync 不会自动加);共享 scheme 已提交(`App.xcscheme`)

---

## 4. 踩过的坑(全部已修复,别再踩)

### iOS 构建(2026-08-13 在 CI 上连续修了 4 轮)
1. **SPM 工程没有 `.xcworkspace`**(CocoaPods 才有)→ 用 `-project ios/App/App.xcodeproj -scheme App`,且必须提交共享 scheme(已提交)
2. **`-target` 构建不支持 `-derivedDataPath`** → 必须 `-scheme` 才能用
3. **patch 脚本 Plugins group 没挂进 App group**(正则缩进错,静默失败)→ 用唯一锚点 `50B271D01FEDC1A000F3C39B /* public */,` 插入;已修复
4. **FileReference 路径重复 `Plugins/Plugins/`** → 文件引用相对 Plugins group 时 path 只写文件名,不带 `Plugins/` 前缀;已修复
5. **`sqlite3_changes64/total_changes64` 需 iOS 15.4**(工程 target 15.0)→ 换 `sqlite3_changes/total_changes` + `Int64()` 转换;已修复
6. **Media 插件 guard 语法**:`value.bytes == try fileSize(object)` 在 guard 里非法 → 拆成先取 `let size = try ...` 再比较;已修复

### 环境/流程
- **Windows 无法 xcodebuild** — Swift 改动必须在 GitHub Actions(macOS)验证,本地只保证源码正确
- **git push 需要代理**:sooya-ipa 仓库 `git config --local http.proxy socks5h://127.0.0.1:7890`(原仓库有,新仓库必须单独配)
- **web 的 MessageItem 测试是已知并发 flake**(单独跑必过),与本地化无关,别浪费时间
- **core 的 repo 层是单行压缩风格**(子代理产物),新增 repo 保持文件内风格一致即可
- **cap sync 会覆盖 `ios/App/App/capacitor.config.json`**(packageClassList)——自定义插件靠 pbxproj 注入 + App target 编译,不依赖 packageClassList(已加但 cap sync 后可能被重写,无影响)
- **主仓库(服务器版)的迁移导出工具在服务器仓库跑**,本仓库只含导入/校验/OTA 侧

---

## 5. 验证命令(sooya-ipa 根目录)

```bash
npm install
npm test                    # core(87)+ web(570)+ migration-tools(11)
npm run typecheck           # core + web
npm run build               # web → packages/web/dist
node scripts/patch-xcode-project.mjs   # iOS 插件接线(幂等)
```

本轮本地复验实际结果：Core `87/87`、Web `570/570`、migration-tools `11/11` 全绿；测试使用 Node 22 与 `TZ=UTC`，与 CI 的 Node 22 约束一致。

CI(推送后自动):`ci.yml`(5 job)+ `ios-build.yml`(macOS unsigned IPA)+ PR3 OTA 信任根校验。

---

## 6. 给 Codex 的开场指令(可直接复制)

> 读 HANDOFF.md 和 docs/sooya-iphone-migration-plan.md。项目在 `sooya7/sooya-ipa`，不要动服务器版 `sooya7/sooya` 的 main。先确认 branch/CI 状态，再完成本地化收口或修 CI；提交用英文 conventional，Swift 改动必须在 macOS Actions 验证。

---

## 7. 关键验收标准(方案摘录,完成时对照)

- §100 数据验收:messages/moments/stickers count 一致、media SHA256 一致、`foreign_key_check=0`、`integrity_check=ok`
- §99 最硬标准:`systemctl stop sooya` + `docker stop sooya-ombre-brain` 后,手机仍能完整使用
- §105 密钥验收:Web bundle/SQLite/备份/日志里搜不到真实 API Key/MCP Token
- §107 OTA 验收:坏包自动回滚,任何失败不把 App 变砖
- §108 自签验收:覆盖安装后 DB/Media/Keychain 保留(前提:同一签名证书!)

---

## 8. 用户工作流约定

- 中文交流;commit 用英文 conventional(如 `fix(ios): ...`)
- per-module commits,不混提交
- 服务器版 main 保持稳定;IPA 版独立演进
- IPA 更新:TS 改动未来走 OTA,Swift 改动重签 IPA(用户用全能签,自备证书)
- 如需公开仓库:`gh repo edit sooya7/sooya-ipa --visibility public`(当前 private)
