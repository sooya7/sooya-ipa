# SOOYA IPA 服务器版最终替代 · 续作实施方案

> **用途**：交给 Codex / DSH 继续实施，不重做已经完成的 PR A 与 Admin Registry。
>
> **当前远端基线**：`sooya7/sooya-ipa` `main` @ `7a5bfddd9d4c839ad7e8cb99611c81075afd0054`
>
> **当前已完成**：
>
> - PR A：Media Director + Voice V2 + Hidden Publish Barrier
> - Provider Factory 收口，`summary` / `director` 槽已暴露
> - 图片过 Director、单用户图编辑、Anuma 单参考图/无 size
> - Voice V2：intent / planner / director / naturalness / semantic / delivery / Fish cue
> - revision fence / stale generation / orphan media cleanup
> - hidden draft / openShell / 混合媒体顺序
> - Admin Route Registry + method/capability/unknown-route 契约
> - Admin handler 已从 legacy dispatcher 全量抽出到 registry owned handlers
>
> **不要重新做以上内容。**

---

## 0. 当前真实状态

当前 IPA 已经完成媒体链与 Admin 路由架构收口，但总方案中的 B–G 仍未完成。

### 已核实的未完成项

**B. Context Server-Parity**

当前 `ContextBuilder` 仍然使用固定最近消息数和字符截断，正常 LocalCore 主路径仍以纯文本 recent turns 为主；缺少真正 token budget、跨 persona/summary/memory/recent 去重、文件提取正文注入、图片/sticker 统一多模态上下文。`SummaryBuilder` 仍使用 chat resolver，尚未切到 `summary` provider slot。

**C. Life V2 + Location Runtime**

当前 `packages/core/src/life/` 仍主要是 catch-up 链，缺少完整 vitals/themes/scoring/outcomes/threads 和正式 LocationSelector/TravelService；`LocalCore.presence()` 仍返回 `city: null`、`travel: null`。

**D. Moments + Sticker Intelligence**

当前 MomentComposer 仍以文字 Moment 为主，没有 POV/selfie share plan 与 MediaDirector 图片链。Sticker 回复链仍是 FTS/recent/usage fallback，没有候选融合、confidence、语义 picker 和重复窗口。

**E. Durable Runtime + Native Notifications**

`LocalTaskScheduler` 已存在，但 `onAppActive()` 仍直接串行执行 catch-up/weather/moments/recover/memory sync；没有统一 task handler map。通知侧仍主要是 capability probe，没有业务级 NotificationPolicy 与 reply-completed/important-moment 到本地通知的正式链。

**F. Server Archive Convergence**

还没有 `docs/SERVER_PARITY.md`、完整 E2E parity matrix、最终 migration regression 与服务器归档 gate。

**G. Advanced / Optional**

Visible Thoughts、weather daylight/fallback、Responses native search、Memory conflict/expiry 等仍可作为 P2，不应阻塞服务器归档，除非产品明确要求。

---

## 1. 执行原则

### 1.1 不允许回退 PR A

后续 B–G 不得破坏以下已经成立的契约：

- TTS 唯一入口是 `LocalVoiceService`
- 除 `read_aloud` 外，TTS 不得收到整段 canonical reply
- Fish cue 只能由 renderer 生成
- Director timeout 只能 fallback，外部 abort 必须传播
- 图片/语音生成后必须经过 revision fence
- stale/superseded 后不得落 orphan media
- hidden voice reply 不得出现文字闪烁
- Anuma 单参考图、不发送 `size`、自拍 framing 使用 finalImagePrompt
- 生成型 Image/TTS Provider 不自动重试

### 1.2 单一事实源

后续统一坚持：

- PersonaReferenceService：人物参考图唯一入口
- MediaDirector：图片/语音导演唯一入口
- ContextBuilder：模型上下文唯一入口
- WorldSnapshot：Life/Location/Weather 对话侧唯一入口
- NotificationPolicy：通知决策唯一入口
- LocalTaskScheduler：可恢复后台任务唯一调度入口

### 1.3 移动端架构原则

不要搬服务器 daemon / worker loop / VAPID / Node FS / HTTP server。

IPA 正确形态：

```text
App foreground / BGTask / cold start
        ↓
LocalTaskScheduler
        ↓
durable jobs
        ↓
catch-up / weather / moments / stickers / media extraction / memory
```

正确性依靠 SQLite 持久状态、elapsed-time catch-up、revision fence、foreground drain 和 best-effort iOS background acceleration，而不是常驻进程。

---

# 2. PR B：`feat/local-context-server-parity`

## 目标

让 IPA 的主 ContextBuilder 达到服务器版上下文能力，不再依赖 ReplyCoordinator 的 fallback `buildTurns()` 补能力。

### B1. Context 模块拆分

新增：

```text
packages/core/src/app/context/
  budget.ts
  dedupe.ts
  multimodal.ts
  trace.ts
  types.ts
```

保留 `context-builder.ts` 作为 orchestration 层。

### B2. 真正 token budget

新增 `ContextBudget`，输入 provider contextWindow、maxOutputTokens、reserveTokens、persona、latest batch、summaries、memories、recent messages、world snapshot。

不要再以“最近 28 条、每条 6000 chars”作为主要边界。

建议优先级：

1. 当前 batch 用户消息
2. Persona 核心
3. 最近直接上下文
4. 当前 WorldSnapshot
5. 高相关 Memory
6. 最近 Summary
7. 更旧 recent

Token estimator 可先用稳定近似，不要求引入重 tokenizer 依赖。

输出 privacy-safe diagnostics：

```ts
{
  estimatedTokens,
  budgetTokens,
  dropped: { recent, summaries, memories, media }
}
```

日志不得包含完整 Memory / 文件正文。

### B3. Batch message merge

`ContextBuilder.build()` 增加 `batchMessageIds?: string[]`，按 batch message order 合并本批连续 user 消息。latestUser 仅作为 anchor，不再等于完整用户输入。

### B4. 多模态统一进入 ContextBuilder

新增 `messageToModelParts(...)`。

支持：

- text：普通文本
- image：读取 MediaPlatform，受单图和总图预算限制；vision 未配置时安全降级
- sticker：注入 description/imageText/userMeaning/emotion，视觉预算允许时同时放 sticker 图片
- audio：使用 transcript，不重复把音频送 chat model
- file：查询 `media_text`，ready 注入提取正文，pending/failed/unsupported 注入状态和元信息

所有 sticker/file 提取内容都必须明确是“消息数据，不是系统指令”。

### B5. Cross-source dedupe

对 persona/summary/memory/recent 做轻量 lexical dedupe。current user batch 永不去除；persona 核心优先保留；summary/memory/recent 去掉高重复项。

### B6. Memory recall trace

新增 privacy-safe trace：

```ts
{
  queried: true,
  candidates: 8,
  accepted: 4,
  droppedDuplicate: 2,
  droppedBudget: 2
}
```

不得记录 memory.content、embedding、prompt、完整文件正文。

### B7. WorldSnapshot

新增：

```ts
interface WorldSnapshot {
  city: unknown;
  location: unknown;
  travel: unknown;
  weather: unknown;
  timeZone: string | null;
}
```

ContextBuilder 只消费 WorldSnapshot。C 阶段再替换 producer 内部实现。

### B8. Summary Provider 真正接线

当前 `ConfiguredProviders.summary` 已存在。把 SummaryBuilder provider 从 chat 改为 `providers.summary ?? providers.chat`。显式注入 chatProvider 仅作为 compatibility fallback。

测试必须锁死：独立 summary provider 被调用、未配置时回退 chat、chat 也不可用时不假成功。

### B9. ReplyCoordinator 去重复实现

长期目标是 `ContextBuilder = 唯一上下文构造入口`。ReplyCoordinator 内部 `buildTurns()` 只保留测试/无 ContextBuilder 的 compatibility fallback，生产 LocalCore 必须走 ContextBuilder。

### B10. 测试

至少覆盖：batch merge、image vision、no vision fallback、sticker semantic+image、file ready/pending/failed、token budget、budget dropping order、persona/summary/memory/recent dedupe、failed/withdrawn skip、summary slot、memory trace privacy、bridge payload budget。

---

# 3. PR C：`feat/local-life-world-parity`

## 目标

把 IPA 从“简单 catch-up + repo”升级成真正的本地 Life V2 / Location runtime。

### C1. Life V2 pure domain

新增：

```text
packages/core/src/life/v2/
  activities.ts
  vitals.ts
  theme.ts
  scoring.ts
  outcomes.ts
  threads.ts
  source.ts
  types.ts
```

只移植服务器纯业务逻辑，不移植 setInterval、daemon、server worker、process-global loop。

### C2. Vitals

本地维护 energy/social/mood tendency/rest pressure/hunger/focus 等服务器已有维度，使用 elapsed-time settlement。foreground/cold start 补算；超长离线 coarse settle；同一时间点 settle 幂等。

### C3. Day Theme

实现 day theme、cooldown、recent theme anti-repeat，并让 Theme 参与 activity scoring。

### C4. Activity scoring

输入 time/theme/vitals/recent activities/location/weather/threads，输出候选 activity+score。必须 deterministic，核心逻辑禁止直接 `Math.random()`。

### C5. Outcomes / Threads

移植 activity outcome、thread advancement、open/close thread、recent outcome anti-repeat，并生成 ShareCandidate 供 MomentComposer 使用。

### C6. Location Runtime

新增：

```text
packages/core/src/world/location/
  selector.ts
  travel.ts
  service.ts
  types.ts
```

正式接管：

```text
activity
→ location candidate
→ edge
→ travel duration
→ TravelState
→ arrive
→ CurrentLocation
→ Visit
```

硬约束：禁止 teleport；无可达 edge 时不能凭空跳点；conversation 不直接改真实 world state。

### C7. Presence 修复

当前必须修 `city: null`、`travel: null`。最终 `presence()` 返回真实 city/location/travel/weather。

### C8. Catch-up 接入

继续保留 LocalLifeCatchUp/CatchUpEngine 思路，改成 elapsed time → LifeV2 transitions → Location transitions → outcomes → share candidates，不运行 server tick daemon。

### C9. 测试

至少：deterministic seed、vitals offline settlement、theme cooldown、activity anti-repeat、weather influence、travel no teleport、arrival、city switching、long offline coarse settle、ShareCandidate creation、presence real world state。

---

# 4. PR D：`feat/local-moments-sticker-parity`

### D1. Moment share planner

扩展现有 MomentComposer，不新建第二套 proactive composer。

```ts
{
  text: string,
  image: null | {
    kind: 'pov' | 'selfie',
    scene: string,
    action?: string,
    mood?: string,
    framing?: string
  }
}
```

### D2. Moment 图片策略

根据 share candidate、daily image cap、minimum image gap、provider configured、moment importance、activity suitability 决定是否带图。图片失败必须降级为纯文字 Moment。

### D3. POV

POV 不使用 persona reference，过 MediaDirector.image() 再进 ImageProvider。

### D4. Selfie

Selfie 必须 PersonaReferenceService → finalImagePrompt framing → 单参考图 → MediaDirector → ImageProvider。复用 PR A，不复制实现。Anuma 仍无 size。

### D5. Sticker Retriever

新增：

```text
packages/core/src/stickers/
  retriever.ts
  picker.ts
  types.ts
```

Retriever 融合 FTS、embedding relevance（可用时）、userMeaning、description、emotion、recent exclusion、favorite/usage prior，输出 top K。

### D6. Sticker Picker

输入 reply semantic、candidate list、recent used ids、desired intent，输出：

```ts
{
  stickerId: string | null,
  confidence: number,
  reason: string
}
```

低 confidence 允许不发表情，不得强选错误表情。

### D7. sticker-only fallback

`sticker-only + 无合格 sticker` 必须回退正文，绝不能空 assistant 或触发 provider returned empty reply。

### D8. 测试

Moment：text-only、POV、selfie、image fail→text、daily cap、min gap、reference framing。

Sticker：userMeaning 优先、repeat exclusion、low confidence none、sticker-only fallback text、embedding unavailable fallback FTS、picker failure safe fallback。

---

# 5. PR E：`feat/native-durable-runtime-notifications`

### E1. Task handler map

新增：

```text
packages/core/src/jobs/handlers.ts
packages/core/src/jobs/retry-policy.ts
```

至少注册：

```text
life.catchup
weather.refresh
moment.compose
moment.image
sticker.analyze
sticker.embed
media.extract_text
memory.commit
memory.reembed
backup
```

reply.generate 可继续保持 real-time coordinator，但 batch/revision 状态不能和 jobs 冲突。

### E2. onAppActive 收口

从当前直接串行调用改为：

```text
recover stuck
recover voice
enqueue due tasks
scheduler.activate/drain
reply recover
memory sync
```

Life/weather/moments 由 task handler 驱动。

### E3. onAppInactive

执行 scheduler.deactivate()、interrupt real-time reply、持久化 retryable job、WAL checkpoint。不能把已 terminal success 的 reply 改 failed。

### E4. NotificationPolicy

新增：

```text
packages/core/src/notifications/
  policy.ts
  planner.ts
  types.ts
```

支持业务事件：`reply.completed while app inactive`、`important moment created`。

Policy 必须处理 permission、foreground suppression、quiet hours、daily cap、dedupe、safe content、max body length。

### E5. Native delivery

优先复用现有 Capacitor LocalNotifications。不要搬服务器 VAPID。Push/APNs 只有在明确存在外部推送源时才启用，不作为本地 correctness 依赖。

### E6. iOS Background

只有 foreground catch-up + local scheduling 无法满足体验时，再加 BGTask。若加，BGTask 只作 acceleration，task handler 仍走 Core，禁止在 Swift 写第二套 world logic。

### E7. 测试

job retry、stuck recovery、scheduler foreground drain、deactivation、idempotency、foreground suppress、quiet hours、daily cap、duplicate suppress、reply completed inactive notification、moment notification、permission denied graceful fallback。

---

# 6. PR F：`chore/server-parity-finalization`

### F1. 新增 parity manifest

新增 `docs/SERVER_PARITY.md`，逐项记录 Server feature、IPA implementation、Parity state、Intentional difference、Test、Archive blocker。

### F2. E2E Matrix

必须覆盖：Chat、Vision、Sticker、Image、Selfie、User image edit、Voice complement/replace/read_aloud、Web Search、MCP、Memory recall/commit、Summary、Life catch-up、Location travel、Moment text/POV/selfie、Sticker picker、Notification、Backup export/import、Server migration、OTA startup。

### F3. Migration regression

服务器→IPA 导入必须验证 messages、summaries、memories、media、stickers、moments、life、provider config、secret refs、MCP、notification prefs、OTA prefs、Ombre state、backup metadata。

不能破坏 IPA 本地已有 sync cursor、outbox、tombstones、built-in stickers、local-only prefs。

### F4. Archive Gate

只有以下全部满足才允许归档服务器仓库：

- A–E 全绿
- Context multimodal/budget 完成
- Life V2 + Location 正式运行
- Moment 图片链完成
- Sticker Picker 完成
- durable task recovery 完成
- native notification business chain 完成
- server→IPA migration 回归完成
- Admin capability/route contract 完成
- 没有核心功能依赖 server daemon
- main CI 绿
- iOS build/unsigned workflow 绿
- 实机 smoke 绿
- 观察期无 blocking regression

然后服务器仓库才进入 read-only/historical reference/archive，IPA 成为唯一产品主线。

---

# 7. PR G：Advanced / Optional

默认不阻塞服务器归档：

- Visible Thoughts：reply fully published 后才允许，新 user activity 立即 abort，默认 off
- Metrics：更完整 runtime metrics/latency/task success ratio
- OpenAI Responses native search：IPA 已有 Doubao/Tavily，只有产品明确需要才补
- Weather daylight/fallback：sunrise/sunset/daylight 与 fallback provider
- Memory conflict/expiry parity：高级 conflict supersede / expiry diagnostics

---

# 8. 建议提交顺序

## PR B

1. `refactor(core): split context budget and multimodal helpers`
2. `feat(core): merge reply batch into context`
3. `feat(core): add multimodal message context`
4. `feat(core): inject extracted file text`
5. `feat(core): add context budget and source dedupe`
6. `feat(core): add memory recall trace`
7. `feat(core): route summaries through summary provider`
8. `test(core): lock context server parity`

## PR C

1. `feat(life): port life v2 domain rules`
2. `feat(life): add vitals and day themes`
3. `feat(life): add deterministic activity scoring`
4. `feat(life): add outcomes threads and share candidates`
5. `feat(world): add location selector and travel runtime`
6. `feat(core): expose real world presence`
7. `test(core): lock life world parity`

## PR D

1. `feat(moments): add share planner`
2. `feat(moments): add pov image moments`
3. `feat(moments): add selfie image moments`
4. `feat(stickers): add candidate retriever`
5. `feat(stickers): add confidence picker`
6. `test(core): lock moment sticker parity`

## PR E

1. `feat(jobs): register durable task handlers`
2. `refactor(core): drive maintenance through scheduler`
3. `feat(notifications): add local notification policy`
4. `feat(native): deliver reply and moment notifications`
5. `test(core): lock durable runtime notification parity`

## PR F

1. `docs: add server parity manifest`
2. `test: add final parity e2e matrix`
3. `test: lock server migration regression`
4. `chore: add server archive gate`

---

# 9. 每个 PR 的门槛

每个阶段必须执行：

```bash
npm run typecheck
npm run test
npm run build
```

并跑当前仓库已有 OTA migration guard、freeze guard、Core tests、Web tests。

如果改 Swift/Native，必须额外跑 iOS/unsigned IPA workflow 并标记 Native-base-required。

如果只改 TS/Core/Web，标记 OTA-safe。

当前 `7a5bfddd` 之后若 HEAD 已前进，必须重新判断 native/schema/OTA 边界，不能直接沿用 PR A 的标签。

---

# 10. 最终实机验收

### Context
- 连发两三条短消息，模型理解为一轮
- 发图片，模型能看见
- 发 sticker，模型理解 sticker 内容
- 发可提取文件，模型能引用正文
- 长对话不爆 context
- Summary 独立模型真正被调用

### Life / World
- 冷启动后 Life 补算
- 长时间离线后状态合理
- location 不 teleport
- travel 状态能出现和结束
- presence 显示真实 city/location/travel/weather

### Moments
- 文字动态
- POV 图
- 自拍图
- 图片失败不影响文字 Moment

### Sticker
- 不连续乱发同一表情
- userMeaning 有效
- 低 confidence 不强发
- sticker-only 无匹配回退文字

### Durable Runtime
- app background/foreground 后任务恢复
- 解析任务不丢
- weather/moment/memory maintenance 恢复
- reply completion 不被后台状态误杀

### Notifications
- 前台不打扰
- 后台 reply completed 可通知
- quiet hours 不通知
- Moment 仅重要时通知
- 拒绝权限后功能正常降级

### Migration / OTA
- server backup 导入
- full backup 导入/导出
- OTA 更新后启动
- Voice/Image/Memory/World 均保持正常

---

# 11. 可直接交给 Codex 的执行指令

> 以 `sooya7/sooya-ipa` 当前 `main @ 7a5bfddd9d4c839ad7e8cb99611c81075afd0054` 为基线继续实施总方案，不要重做已经完成的 Media Director / Voice V2 / hidden publish barrier / Admin Route Registry。先重新 fetch 当前 main，若 HEAD 已前进则以最新 main 为准并重新核差异。
>
> 从本文件 PR B 开始顺序执行 B → C → D → E → F；G 仅在不阻塞主线时做。每个 PR 都先检查当前代码再改，禁止凭方案假设文件仍未变化。不要把 B–F 合成一个 mega commit；按本文件提交顺序落地。
>
> 任何阶段都不得破坏 PR A 已锁死的 Voice/Image 契约。所有 async 生成路径保留 AbortSignal + revision fence；stale 后不得留下 orphan media。生成型 Image/TTS 不自动重试。
>
> 每个阶段完成后跑 typecheck、Core/Web 全量测试、Web build、OTA migration guard、freeze guard；涉及 Native 时额外跑 iOS/unsigned workflow。只有全部绿色才进入下一阶段。
>
> 最终以 `docs/SERVER_PARITY.md` + E2E parity matrix + migration regression 作为服务器归档依据。不要因为任务列表显示完成就宣称服务器可归档，必须以真实代码、测试和实机 smoke 为准。

---

# 12. 当前建议状态

```text
PR A  Media Director + Voice V2               ✅ 已完成
Admin  Route Registry / Handler Convergence    ✅ 已完成

PR B  Context Server-Parity                    ⏳ 下一步
PR C  Life V2 + Location Runtime               ⏳
PR D  Moments + Sticker Intelligence           ⏳
PR E  Durable Runtime + Notifications          ⏳
PR F  Server Archive Convergence               ⏳
PR G  Advanced / Optional                      ⏳ 非阻塞
```

**当前不要归档服务器仓库。**

当 B–F 全部通过验收后，再做最终服务器归档判断。
