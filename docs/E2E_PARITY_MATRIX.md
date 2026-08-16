# SOOYA IPA Final E2E Parity Matrix

> 每行 = 最终服务器归档 gate。状态列只允许 ✅（已由代码/测试证明）或 ⏳（实机/CI 待确认）；未覆盖不得写 ✅。

| # | E2E flow | Core/Web 覆盖 | Native/iOS | 状态 |
|---|---|---|---|---|
| 1 | Chat 连续对话 + batch merge | `context-builder.test.ts`, `reply-media-failure.test.ts` | 实机 smoke | ✅ / ⏳ |
| 2 | Vision 图片上下文 / no-vision fallback | `context-builder.test.ts` | native boot | ✅ |
| 3 | Sticker 上下文语义 + 图片 | `context-builder.test.ts` | native boot | ✅ |
| 4 | Image POV / Selfie / user-image edit | `composer.test.ts`, `reply-image-director.test.ts` | native probe | ✅ |
| 5 | Voice complement / replace / read_aloud | `voice/*`, `reply-voice-director.test.ts` | native preview | ✅ |
| 6 | Web Search | `web-search-policy.test.ts` | native HTTP | ✅ |
| 7 | MCP | `tools/*`, admin bridge | Capacitor MCP | ✅ |
| 8 | Memory recall/commit | `memory-provider.test.ts`, `memory-sync.integration.test.ts` | Ombre sync | ✅ |
| 9 | Summary independent slot | `summary-builder.test.ts` | native providers | ✅ |
| 10 | Life catch-up + vitals + theme + scoring | `life/v2/*.test.ts`, `life-world-parity.test.ts` | cold start | ✅ |
| 11 | Location travel no-teleport / arrival / city switch | `world/location/service.test.ts` | native DB | ✅ |
| 12 | Moment text/POV/selfie/image-fail | `composer.test.ts` | native media | ✅ |
| 13 | Sticker picker userMeaning/repeat/low-confidence/fallback | `stickers/retriever.test.ts`, `reply-media-runtime-contract.test.ts` | native stickers | ✅ |
| 14 | Notification reply/moment/quiet-hours/denied | `notifications/*.test.ts`, `native-durable-notifications.test.ts` | Capacitor LocalNotifications | ✅ |
| 15 | Backup export/import | migration-tools + `fullBackup.ts` | native file UI | ✅ |
| 16 | Server → IPA migration | `portable.test.mjs`, OTA guard, freeze guard | native import | ✅ |
| 17 | OTA startup + schema guard | `ota.test.mjs`, `ota-migration-guard` | Capgo updater | ✅ |

## 实机 smoke 必查

- [ ] 冷启动后 Header/presence 真实 city/location/travel/weather
- [ ] 长离线（>7 天）后 Life 只 coarse settle，不刷几百条历史
- [ ] 后台回复完成可通知；前台不打扰；拒绝权限后聊天正常
- [ ] OTA 更新后消息、图片、Voice、Memory、World 均保留
- [ ] 服务器迁移导入后本地 sync cursor/outbox/tombstones/builtin stickers/local prefs 不被覆盖
