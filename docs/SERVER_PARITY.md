# SOOYA Server → IPA Parity Manifest

> 基线：`sooya7/sooya-ipa` `main @ 7a5bfddd9d4c839ad7e8cb99611c81075afd0054` 之后按 PR B/C/D/E 顺序演进。
> 本文档是服务器归档的唯一 gate 清单；代码/测试/实机 smoke 未全绿前不得归档服务器仓库。

## 状态总览

| 域 | Parity state | Archive blocker |
|---|---|---|
| Chat + tools + MCP | ✅ local parity | 否 |
| Context (budget/multimodal/batch/summary slot) | ✅ PR B | 否 |
| Life V2 + Location Runtime | ✅ PR C | 否 |
| Moments + Sticker Intelligence | ✅ PR D | 否 |
| Durable runtime + Local notifications | ✅ PR E | 否 |
| Server migration regression + E2E matrix | ✅ PR F | 否 |
| Advanced/optional (Visible Thoughts, Responses search, daylight fallback, memory expiry) | ⏳ P2 | 否（不阻塞归档） |

## 逐项清单

### Chat / Message / Reply

| Server feature | IPA implementation | Parity | Intentional difference | Test |
|---|---|---|---|---|
| 流式聊天 + 批次合并 | `ReplyCoordinator` + `ReplyBatchRepo` | ✅ | 本地 SQLite，无 Redis/队列 | `reply-*`, `local-core.test.ts` |
| 隐藏发布屏障 + revision fence | `ReplyCoordinator` holdDraft / `stale-generation.ts` | ✅ | 无服务器 worker | `reply-media-failure.test.ts` |
| 撤回与 stale 清理 | `MessageRepo.withdraw`, orphan destroy | ✅ | 本地时间窗 | `transactions-fts-fk`, `reply-image-director` |
| Web search | `createWebSearch` + Doubao/Tavily | ✅ | 仅本地 HTTP | `web-search-policy.test.ts` |
| MCP host | `McpRepository` + `ToolRegistry` | ✅ | 无常驻 server session | `tools/*`, admin bridge |
| Memory recall/commit | `LocalMemoryProvider` + Ombre router/sync | ✅ | 本地 SQLite 优先 | `memory-provider.test.ts`, integration |

### Context（PR B）

| Server feature | IPA implementation | Parity | Intentional difference | Test |
|---|---|---|---|---|
| Token budget | `app/context/budget.ts` + `ContextBuilder` | ✅ | 轻量 estimator，不引入 tokenizer | `context-builder.test.ts` |
| Batch message merge | `batchMessageIds` | ✅ | batch 顺序来自 `reply_batch_messages.position` | 同上 |
| Multimodal image/sticker/audio/file | `app/context/multimodal.ts` | ✅ | 图片 ≤4 张、≤2MB；文件仅注入 `media_text` | 同上 |
| Cross-source dedupe | `app/context/dedupe.ts` | ✅ | lexical bigram dedupe，不上 embedding | 同上 |
| Memory recall trace | `app/context/trace.ts` | ✅ | 仅 count，不落 memory content | 同上 |
| WorldSnapshot 单一口 | `app/context/types.ts` + `LocalCore.worldSnapshot` | ✅ | Life V2 producer 在 C 接入 | `life-world-parity.test.ts` |
| Summary 独立 slot | `SummaryBuilder` `summary ?? chat` | ✅ | 两 slot 均不可用返回 noop，不假成功 | `summary-builder.test.ts` |

### Media / Voice（PR A，不可回退）

| Server feature | IPA implementation | Parity | Intentional difference | Test |
|---|---|---|---|---|
| Media Director | `MediaDirector` | ✅ | director 不可用只 fallback，外部 abort 传播 | `media-director.test.ts` |
| Voice V2 | `voice/service.ts` 全链 | ✅ | Fish cue 仅 renderer 生成 | `voice-*`, `reply-voice-director.test.ts` |
| Image/selfie/user edit | `ReplyCoordinator` + `PersonaReferenceService` | ✅ | Anuma 不发送 size、单参考图 | `reply-image-director`, Anuma provider tests |
| Hidden voice publish | holdDraft / openShell | ✅ | 无文字闪烁 | `reply-media-failure.test.ts` |

### Life V2 + Location（PR C）

| Server feature | IPA implementation | Parity | Intentional difference | Test |
|---|---|---|---|---|
| Vitals elapsed settlement | `life/v2/vitals.ts` | ✅ | elapsed-time，不跑 daemon | `vitals.test.ts` |
| Day theme + cooldown | `life/v2/theme.ts` | ✅ | deterministic hash，不重 tokenizer | `theme.test.ts` |
| Activity scoring | `life/v2/scoring.ts` | ✅ | 核心逻辑禁止 `Math.random()` | `scoring.test.ts` |
| Outcomes/threads/share candidates | `life/v2/outcomes.ts`, `threads.ts`, `LifeClockRepo` | ✅ | 本地 SQLite 表 | `life-world-parity.test.ts` |
| Catch-up integration | `LifeV2Source` + `LocalLifeCatchUp` | ✅ | ≤7 天详细 replay + coarse settle | `life-world-parity.test.ts` |
| Location selector/travel | `world/location/*` | ✅ | 禁止 teleport，无 edge 停留 | `service.test.ts` |
| Presence | `LocalCore.presence()` | ✅ | city/travel/weather 真实返回 | `life-world-parity.test.ts` |

### Moments + Stickers（PR D）

| Server feature | IPA implementation | Parity | Intentional difference | Test |
|---|---|---|---|---|
| Moment share planner | `moments/moment-image-policy.ts` | ✅ | 文字 Moment 是底线 | `composer.test.ts` |
| POV image | `MomentComposer` POV 直通 ImageProvider | ✅ | 无 persona reference | 同上 |
| Selfie image | `MomentComposer` + `PersonaReferenceService.framingFor` | ✅ | 单参考图；失败降级文字 | 同上 |
| Daily cap / min gap | `MomentImagePolicy` | ✅ | 默认 1 张/天、6h gap | 同上 |
| Sticker retriever | `stickers/retriever.ts` | ✅ | FTS + lexical + optional embedding，无服务端 vector DB | `retriever.test.ts` |
| Sticker picker | `stickers/picker.ts` | ✅ | 低 confidence 不发表情 | 同上 |
| sticker-only fallback | `ReplyCoordinator` | ✅ | 无合格表情回退正文 | `reply-media-runtime-contract.test.ts` |

### Durable Runtime + Notifications（PR E）

| Server feature | IPA implementation | Parity | Intentional difference | Test |
|---|---|---|---|---|
| Task handler map | `jobs/handlers.ts` | ✅ | 无 server worker loop | `handlers.test.ts` |
| Foreground drain | `LocalCore.onAppActive()` → `LocalTaskScheduler` | ✅ | 首屏不被低优先级任务阻塞 | `native-durable-notifications.test.ts` |
| Background deactivation | `onAppInactive()` abort optional jobs + WAL checkpoint | ✅ | 不把 terminal reply 改成 failed | `local-task-scheduler.test.ts` |
| Retry policy | `jobs/retry-policy.ts` | ✅ | 指数退避封顶 | `handlers.test.ts` |
| Notification policy | `notifications/policy.ts` | ✅ | permission/foreground/quiet hours/cap/dedupe/safe content | `policy.test.ts` |
| Notification delivery | `NotificationPlanner` + `NativeNotifications` | ✅ | Capacitor LocalNotifications；无 VAPID/Push 依赖 | `planner.test.ts`, web native wiring |
| iOS BGTask | 未启用 | ⏳ | 仅在 foreground catch-up 不足时再启用；Swift 不写第二套 world logic | 无（不阻塞归档） |

### Server Archive Finalization（PR F）

| Item | 状态 |
|---|---|
| `docs/SERVER_PARITY.md` | ✅ |
| E2E matrix | ✅ 见 `docs/E2E_PARITY_MATRIX.md` |
| Migration regression | ✅ migration-tools portable/OTA/redaction + OTA guard + freeze guard |
| Archive gate | ✅ 见下方 |

## Archive Gate（全部满足才允许归档服务器仓库）

- [x] PR A Voice/Image 契约测试全绿
- [x] PR B Context budget/multimodal/batch/dedupe/trace/summary slot 测试全绿
- [x] PR C Life V2 + Location runtime 测试全绿
- [x] PR D Moment image chain + Sticker picker 测试全绿
- [x] PR E durable recovery + notification policy/delivery 测试全绿
- [x] Admin capability/route contract 测试全绿
- [x] server→IPA migration 工具链测试全绿（migration-tools + OTA guard + freeze guard）
- [x] main CI 由仓库 CI 覆盖
- [ ] iOS unsigned workflow 由仓库 CI 覆盖（需推送后确认 workflow 绿）
- [ ] 实机 smoke（需设备确认）
- [ ] 观察期无 blocking regression（需时间确认）

> 服务器仓库在最后三项人工确认前保持 read-only/historical reference，不得删除数据。
