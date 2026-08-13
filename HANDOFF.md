# SOOYA-IPA 交接文档(HANDOFF)

> 最后更新:2026-08-13。给后续任何开发代理(Codex/ZCode)的完整状态说明。
> 总方案:`docs/sooya-iphone-migration-plan.md`(20 个 Task)。本仓库是 **IPA 版**(iPhone 全本地),服务器版在 `sooya7/sooya` 仓库(继续运行,main 不动)。

## 1. 当前进度(按方案 Task)

### ✅ 已完成并验证
- **Task 1/2/3**:core contracts、platform interfaces、async db repos — core 17 文件/72 测试全绿,boundary test 锁死 Node 边界
- **Task 4/5/6/9/11 的 Native 层**:5 个 Swift 插件(SOOYADatabase/Secrets/Http/Mcp/Media)+ XCTest 套件;pbxproj 已注入插件(见 scripts/patch-xcode-project.mjs,幂等);entitlements/ATS/packageClassList 已配
- **iOS 编译已验证**:2026-08-13 GitHub Actions(macOS)成功产出 unsigned IPA(2.68 MB artifact `SOOYA-unsigned-ipa`)。过程中修掉:SPM 无 workspace(用 -project/-scheme + 共享 App.xcscheme)、Plugins group 挂载路径、FileReference 相对路径、`sqlite3_changes64` 需 iOS 15.4(换 32 位 API)、Media 插件 guard 语法
- **Task 7 骨架**:SooyaClient 接口 + LocalEventBus + LocalSooyaClient + TestLocalClient + nativeBoot(LocalCore ↔ Capacitor 插件接线,App 生命周期 + 键盘 inset)
- **Task 12/14 逻辑层**:life catch-up、moment-policy、local-task-scheduler 已在 core(有测试)
- **Task 16 基础**:Capacitor 8 工程(com.sooya.app,无 server.url)、safe-area/keyboard CSS 变量(--sooya-safe-top/-bottom/--sooya-keyboard-height)
- **Task 17/18 工具层**:migration-tools(portable 导出/校验/回滚、OTA manifest)10/10 测试
- **服务器版记忆修复已上线**:sooya7/sooya main `c2c903c`(零调用假成功→skipped/uncertain),CI 全绿
- **仓库已推送 GitHub**:`sooya7/sooya-ipa`(private),CI 4 job 全绿 + ios-build 成功

### ❌ 未完成(建议顺序)
1. **sooya-ipa 推 GitHub** → 触发 ci.yml + ios-build.yml(macOS 编译 unsigned IPA,验证 Swift 插件;Windows 本地无法 xcodebuild)
2. **Task 6:Provider 移植** — server 的 OpenAI/Anthropic/OpenAI-compatible/Embedding/Image/Fish 搬进 core,`fetch`→HttpTransport
3. **Task 8:Reply/Core 移植** — Context/Summary/Replier/ReplyCoordinator 搬进 core;目前 send 只写库+排队,无模型调用
4. Task 10 Local Memory 完整化(Ombre 导入/embedding)、Task 11 MCP 前台管理(web McpAdminPage 还走服务器 admin API)、Task 15 Admin Local、Task 5 ConfigRepository
5. Task 13 动态收口改名、Task 17 服务器导出接入、Task 18 OTA 服务端/回滚、Task 19 CI 真跑通、Task 20 服务器退役

## 2. 关键技术决策(不要偏离)

- **依赖方向**:web → `@sooya/core`(vite alias + tsconfig paths 指向 `../core/src/**/*.ts` 源码,core 是 TS 源码包);core 零 dependencies
- **better-sqlite3 只在测试**:core `test/db/node-local-database.ts` 从 core 自身 package.json 解析(devDeps);migration-tools `src/sqlite.mjs` 从自身目录解析。生产 Core 永不 import 它
- **DB 契约**:`LocalDatabase`(open/close/execute/run/query/transaction/integrityCheck/backup)全部 async,事务=单次 native batch(测试断言 transactionCalls)
- **Secrets**:Keychain 只有 has/set/delete,**无 get**(SOOYASecretsPlugin);service `com.sooya.app.secrets.v1`,accessGroup `TEAMID.com.sooya.app`(App.entitlements 用 `$(AppIdentifierPrefix)`)
- **Memory 语义**(服务器版修复同款):零 tool call→skipped、全失败→uncertain、≥1 成功→completed;receipt 只记脱敏元数据
- **web 本地化**:`installSooyaClient()` 只在 `isNativeSooya()` 时由 nativeBoot 调用;浏览器保持远程 api 回退;`useChat` 默认 `currentSooyaClient() ?? api`
- **iOS 工程**:SPM(CapApp-SPM,无 Podfile);自定义插件必须 `node scripts/patch-xcode-project.mjs` 注入 pbxproj(cap sync 不会自动加)

## 3. 验证命令(新仓库根目录)

```bash
npm install
npm test                    # core(72)+ web(570)+ migration-tools(10)
npm run typecheck           # core + web
npm run build               # web → packages/web/dist
node scripts/patch-xcode-project.mjs   # iOS 插件接线(幂等)
```

## 4. 坑与注意

- web 的 MessageItem 测试是**已知并发 flake**(单独跑必过),与本地化无关
- `packages/web/src/local/nativeBoot.ts` 里 `Capacitor.Plugins` 用了类型断言(类型定义缺 Plugins 属性)
- core 的 boundary.test.ts 断言 exports 键数量——加导出必须同步改它
- 测试文件风格:core 的 repo 层是单行压缩风格,新代码保持 repo 内一致即可
- Windows 无法验证 iOS 编译;Swift 源码改动后必须在 GitHub Actions(macOS)验证
- 主仓库(服务器版)的迁移导出工具 `export-portable` 在**服务器仓库**跑,本仓库只含导入/校验/OTA

## 5. 下一步建议

1. push sooya-ipa → GitHub 新建仓库 → CI 验证(尤其 ios-build)
2. Task 6 Provider 移植(先 OpenAI chat + Fish,最小闭环)
3. Task 8 ReplyCoordinator(保留 batch/revision/interrupt/publish 语义,只换 DB/事件/transport)
4. 每次里程碑跑全量测试 + typecheck,commit 用英文 conventional 风格,per-module 拆分
