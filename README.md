# SOOYA IPA — iPhone 全本地版

SOOYA 的 iPhone 本地运行版。聊天、Life、动态、记忆、工具调用、模型、媒体、配置全部在 iPhone 本地运行;服务器只负责 IPA 与 OTA 静态文件。

> 完整方案见 [`docs/sooya-iphone-migration-plan.md`](docs/sooya-iphone-migration-plan.md)。

## 架构

```
React UI
  └─ SooyaClient 接口(LocalSooyaClient / TestLocalClient)
       └─ LocalCore(packages/core,纯 TypeScript)
            ├─ LocalDatabase   → Native SQLite(SOOYADatabasePlugin)
            ├─ SecretStore     → iOS Keychain(SOOYASecretsPlugin)
            ├─ HttpTransport   → Native URLSession(SOOYAHttpPlugin)
            ├─ BinaryStore     → Native Media(SOOYAMediaPlugin)
            └─ McpTransport    → Native MCP(SOOYAMcpPlugin)
```

- `packages/core` — 纯 TS 业务核心,禁止任何 Node 内置模块(CI boundary test 锁死)
- `packages/web` — React UI(保留原有 UI,本地化走 SooyaClient 注入)
- `packages/migration-tools` — 旧服务器数据导出/校验 + OTA 打包工具
- `ios/App/App/Plugins/` — 5 个 Swift 桥接插件(SQLite/Keychain/HTTP/MCP/Media)

## 开发

```bash
npm install
npm test          # core + web + migration-tools
npm run build     # web 产物 → packages/web/dist
```

### iOS

```bash
npm run ios:sync  # build web + cap sync ios(Windows 上只能生成工程,编译需 macOS)
```

iOS 编译与 unsigned IPA 由 GitHub Actions(macOS runner)完成;Windows 本地只保证 Swift 源码与工程配置正确。

## 迁移(T0 一次性)

旧服务器(SERVER 仓库)运行 `export-portable` 导出 `SOOYA-Migration-<date>.zip`;手机导入后进入本地模式。导出侧工具在旧服务器仓库,本仓库只含导入/校验/OTA 侧。

## 测试

| 包 | 框架 | 说明 |
|---|---|---|
| core | vitest | 平台接口、tools、memory、life、jobs、db repos(better-sqlite3 仅测试) |
| web | vitest | 组件 + LocalClient 契约(sooyaClient.test / useChat.local.test) |
| migration-tools | node:test | 便携包/OTA/校验/回滚 |

