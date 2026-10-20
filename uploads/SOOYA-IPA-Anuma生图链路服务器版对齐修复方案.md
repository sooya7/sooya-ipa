# SOOYA IPA · Anuma 生图链路与服务器版彻底对齐修复方案

> 目标：解决当前 IPA 中“聊天一触发生图就立即失败”的问题，并消除“管理后台测试成功，但真实聊天失败”的协议分叉。
>
> 原则：**不再给 IPA 发明另一套生图逻辑，直接以服务器版已验证行为为准。**

---

## 1. 当前结论

当前 IPA 的问题不是单一 UI Bug，而是 **真实聊天生图链路与服务器版存在三层偏差**：

1. **Anuma 请求体不一致**
   - 服务器版 Anuma `/images/generations` 不发送 `size`
   - IPA 当前会把模型配置里的 `size` 一起发给 Anuma
   - 如果配置是 `1920x1920`，聊天就会真实带上这个值
   - 管理后台测试却硬编码为 `1024x1024`
   - 因此“测试连接成功”并不能证明聊天链路可用

2. **自拍参考图数量不一致**
   - 服务器版只会根据构图选择 **1 张最合适的参考图**
   - IPA 当前会把 front / full-body / side 三张全部加载，并全部上传后放入 `input_images`
   - 这与服务器版已验证的单参考图路径不一致

3. **图片失败语义不一致**
   - 服务器版：图片失败只让 image part 失败，文字回复继续保留
   - IPA 当前：显式图片请求会被标记为 `requiredImage`
   - 生图任一步报错后会继续向外 `throw`
   - 最终整个 assistant message / reply batch 会进入 `failed`
   - 所以 UI 看起来就是“一调用就整条失败”

另外还有一个结构性问题：

4. **图片协议判断仍有两套入口**
   - 之前为了兼容 `provider: anuma + options.protocol: anuma-input-images`，在 provider factory 做过一次运行时归一化
   - 但 `BuiltinImageProvider` 自身仍直接判断 `config.provider`
   - 只要某个调用点绕过 factory，仍可能重新选错协议
   - 这类“入口依赖”应该彻底消失

---

# 2. 修复目标

本次修复完成后，IPA 生图应满足：

```text
模型表达图片意图
    ↓
ReplyCoordinator 得到 image / self-image directive
    ↓
统一 imageProvider
    ↓
若为自拍：
    根据 prompt 选择 1 张参考图
    ↓
Anuma:
    POST /media/upload
    ↓
得到 HTTPS URL
    ↓
POST /images/generations
    body:
      model
      prompt
      n
      input_images: [ONE_URL]
    ↓
保存生成图片
    ↓
图片 part = sent
```

任何图片阶段失败：

```text
图片失败
    ↓
image part / media task 标记失败
    ↓
reply.media.failed
    ↓
保留已经生成的文字
    ↓
整个 reply 仍然 completed
```

不得再出现：

```text
图片失败
→ throw
→ reply.failed
→ 整个 assistant 消息失败
```

---

# 3. 改动范围

建议一次修改以下 5 个区域：

```text
packages/core/src/providers/media-providers.ts
packages/core/src/providers/provider-factory.ts
packages/core/src/app/reply-coordinator.ts
packages/web/src/local/nativeBoot.ts
packages/web/src/local/NativeLocalCore.ts
```

并新增 / 扩充对应测试。

---

# 4. 修复一：把 Anuma 协议判断收进 BuiltinImageProvider

## 文件

`packages/core/src/providers/media-providers.ts`

## 当前问题

现在核心判断类似：

```ts
if (this.config.provider === 'anuma-input-images') {
  ...
}
```

但迁移后的真实配置可能是：

```ts
provider: 'anuma'
options: {
  protocol: 'anuma-input-images'
}
```

所以 provider factory 虽然可以在某些路径帮它归一化，但：

- `NativeLocalCore`
- 单独实例化 provider
- 未来新增调用点

仍可能绕过归一化。

## 修改

在 `media-providers.ts` 内建立唯一协议解析：

```ts
function imageProtocol(config: ProviderConfig): string {
  const protocol =
    typeof config.options.protocol === 'string'
      ? config.options.protocol.trim()
      : '';

  return protocol || config.provider;
}
```

`BuiltinImageProvider` 内所有分支统一改为：

```ts
imageProtocol(this.config) === 'anuma-input-images'
```

包括：

- `generate()`
- `edit()`
- `inspectHealth()`
- provider name
- 是否允许参考图
- 是否进入 Anuma upload/generation 路径

## 结果

无论调用者来自：

```text
provider-factory
NativeLocalCore
LocalCore
Admin probe
Chat runtime
```

都不会再因为配置保存形式不同而选错协议。

## provider-factory.ts

现有 runtime normalization 可以：

### 推荐

保留一版兼容，但不再承担正确性责任。

也就是说：

```text
factory normalization = 兼容层
BuiltinImageProvider.imageProtocol() = 真正唯一协议源
```

后续即使移除 factory normalization，也不会影响真实请求。

---

# 5. 修复二：Anuma 请求严格对齐服务器版

## 文件

`packages/core/src/providers/media-providers.ts`

## 5.1 Anuma 不再发送 size

当前 IPA 的 `generateAnuma()` 会：

```ts
const size = ...
if (size) body.size = size;
```

服务器版已验证 Anuma 路径没有这一段。

### 修改

Anuma 请求固定为：

```ts
const body = {
  model: this.config.model,
  prompt,
  n: 1
};

if (inputImages.length) {
  body.input_images = inputImages;
}
```

**不要发送：**

```text
size
response_format
quality
style
```

除非以后 Anuma 官方协议明确支持并经过验证。

---

## 5.2 `/images/generations` endpoint 保持服务器版行为

保持：

```text
{baseUrl}/images/generations
```

不要走：

```text
{baseUrl}/v1/images/generations
```

Anuma 与 OpenAI-compatible 必须继续严格分流。

---

## 5.3 `/media/upload` 继续 JSON Base64 上传

保持现有：

```json
{
  "filename": "reference.jpg",
  "content_type": "image/jpeg",
  "data": "<base64>"
}
```

然后只接受合法：

```text
https://...
```

URL。

这里与服务器版一致，不需要改成 multipart。

---

# 6. 修复三：自拍只选择一张参考图

## 当前 IPA

`nativeBoot.ts` 中 `loadServerReferenceImages()` 当前会遍历：

```text
front
full-body
side
```

然后把所有可读图片全部返回。

结果：

```text
3 张参考图
→ 上传 3 次
→ input_images: [url1, url2, url3]
```

这不是服务器版行为。

---

## 服务器版行为

服务器版会先根据 prompt 判断构图：

```text
side / profile
    → side

full body / standing
    → full-body

其他
    → front
```

然后只读取 **一张**。

---

## IPA 修改方案

### 修改函数

从：

```ts
loadServerReferenceImages()
```

改为：

```ts
loadServerReferenceImages(hint?: string)
```

并增加：

```ts
type ReferenceFraming =
  | 'front'
  | 'full-body'
  | 'side';
```

### 分类规则与服务器版保持一致

```text
侧脸 / 侧面 / 侧颜 / profile / side
    → side

全身 / 站立 / standing / full body / head to toe
    → full-body

其他
    → front
```

### 选择顺序

```text
1. 用户上传的对应 slot
2. IPA 内置对应参考图
3. front fallback
4. 没有可用参考图则返回 []
```

### 返回值

仍保持 provider 接口：

```ts
Array<{
  data: Uint8Array;
  mime: string;
}>
```

但数组长度必须：

```text
0 或 1
```

---

# 7. 修复四：Provider 自己也只消费一张参考图

即使上层已经只传一张，Provider 也要做最后一道防线。

## 文件

`packages/core/src/providers/media-providers.ts`

当前：

```ts
for (const reference of references) {
  upload(...)
}
```

改为：

```ts
const reference = references[0];

if (reference) {
  const url = await upload(...)
  inputImages.push(url)
}
```

## 原因

防止未来其他调用点：

```text
误传 2~3 张
```

重新把 Anuma 链路搞坏。

### 建议

不直接报 `too_many_reference_images`。

为了完全对齐服务器版：

```text
只使用第一张
```

并在 debug / diagnostic 里记录：

```text
referenceImagesReceived
referenceImagesUsed = 1
```

即可。

---

# 8. 修复五：图片失败不得再杀掉整条回复

## 文件

`packages/core/src/app/reply-coordinator.ts`

这是当前用户体验最明显的问题。

---

## 当前错误逻辑

大致是：

```ts
try {
  generateImage()
} catch (error) {
  emit('reply.media.failed')

  if (directives.requiredImage) {
    throw error
  }
}
```

当用户明确说：

```text
发张照片
给我自拍
画一张
```

就会：

```text
requiredImage = true
```

因此图片 API 失败：

```text
media failed
↓
throw
↓
外层 reply failed
↓
整个 assistant 消息失败
```

---

## 修改原则

`requiredImage` 只应该表示：

```text
这一轮确实应该尝试生成图片
```

不能表示：

```text
图片失败 = 整条回复失败
```

---

## 推荐逻辑

```ts
try {
  ...
} catch (error) {
  emit('reply.media.failed', ...)

  // 不再 throw
}
```

---

## 图片失败后的表现

### 有文字回复

例如：

```text
给你拍了一张。
```

图片失败时：

```text
文字继续保留
图片失败
reply completed
```

不再让整个气泡进入 failed。

### 没有任何文字

如果模型只输出了：

```text
[[image-self: ...]]
```

那么图片失败后应补一条简短 fallback：

```text
（图片生成失败了，可以再试一次。）
```

不要出现：

```text
空白 assistant bubble
```

也不要整个 batch failed。

---

## 推荐事件

继续保留：

```text
reply.image.generating
reply.media.failed
```

成功：

```text
reply.media.created
```

但图片失败不得再触发：

```text
reply.failed
```

除非：

```text
聊天模型本身失败
数据库写入失败
reply revision fence 失败
```

---

# 9. 修复六：让图片失败真正可诊断

现在用户看到的往往只是：

```text
失败
```

我们需要知道到底死在哪一层。

## 给 `reply.media.failed` 增加 stage

统一：

```ts
stage:
  | 'reference_select'
  | 'reference_read'
  | 'reference_upload'
  | 'generation'
  | 'download'
  | 'media_save'
```

示例：

```json
{
  "type": "image",
  "stage": "reference_upload",
  "provider": "anuma-input-images",
  "status": 400,
  "error": "..."
}
```

### 注意

日志禁止记录：

```text
API Key
完整 Base64
完整签名 URL
参考图原始数据
```

只记录：

```text
provider
model
stage
status
elapsedMs
referenceCount
requestId
经过脱敏的 message
```

---

# 10. 修复七：管理后台测试不能再制造“假绿灯”

## 当前

Native Admin 图片测试：

```ts
provider.generate(
  '生成一张简单的抽象色块测试图',
  {
    size: '1024x1024'
  }
)
```

这和聊天自拍完全不同。

---

## 修改 1：普通测试不再硬编码 1024x1024

调用：

```ts
provider.generate(prompt, {
  signal
})
```

让 Provider 自己按照协议决定是否需要 size。

对于 Anuma：

```text
不带 size
```

对于 OpenAI-compatible：

```text
仍可读取 config.options.size
```

---

## 修改 2：增加“测试自拍链路”

图片模型页面建议出现两个诊断动作：

```text
测试文生图
测试自拍链路
```

### 测试文生图

验证：

```text
鉴权
模型名
baseUrl
/images/generations
响应下载
```

### 测试自拍链路

使用与真实聊天完全相同的：

```text
reference selection
→ /media/upload
→ input_images
→ /images/generations
→ 图片下载
```

这样以后不会再出现：

```text
测试连接绿色
聊天自拍秒失败
```

---

# 11. Admin 测试结果应该显示阶段

例如：

```text
连接正常
Anuma / xxx-model
文生图成功
耗时 8.3 秒
```

自拍：

```text
自拍链路正常
参考图：front
上传 620 ms
生成 7.4 秒
总耗时 8.1 秒
```

失败：

```text
自拍链路失败
阶段：参考图上传
HTTP 400
```

或者：

```text
阶段：图片生成
HTTP 422
```

这样后续排查不再靠截图猜。

---

# 12. 测试补齐

至少新增以下测试。

---

## 12.1 Anuma 不发送 size

文件建议：

```text
packages/core/src/providers/media-providers.test.ts
```

断言：

```ts
expect(body).toEqual({
  model: '...',
  prompt: '...',
  n: 1
});
```

即使配置：

```ts
options.size = '1920x1920'
```

Anuma body 里也不得出现：

```text
size
```

---

## 12.2 Anuma protocol 从 options.protocol 识别

配置：

```ts
provider: 'anuma'
options.protocol: 'anuma-input-images'
```

必须命中：

```text
/media/upload
/images/generations
```

而不是：

```text
/v1/images/generations
```

---

## 12.3 多参考图只使用第一张

传：

```text
front
full-body
side
```

断言：

```text
/media/upload 只调用 1 次
input_images.length === 1
```

---

## 12.4 自拍构图选择

测试：

```text
“我侧着脸看窗外”
→ side

“站在镜子前拍一张全身照”
→ full-body

“坐在窗边喝咖啡”
→ front
```

---

## 12.5 图片 API 失败不失败整个 reply

模拟：

```text
imageProvider.generate()
→ throw ProviderRequestError
```

断言：

```text
reply.media.failed ✅
reply.completed ✅
reply.failed ❌
assistant status = sent
text part 仍存在
```

---

## 12.6 image-only 失败 fallback

模型只有：

```text
[[image-self: 坐在窗边]]
```

图片失败：

```text
assistant message 仍 sent
存在 fallback text
```

---

## 12.7 Native Admin probe

Anuma 配置：

```text
size = 1920x1920
```

测试按钮请求体：

```text
不得包含 size
```

---

# 13. 建议增加一条端到端回归测试

目标场景就是这次真实问题：

```text
用户：
“发张现在的照片给我”

模型：
[[image-self: 我坐在窗边喝咖啡]]

配置：
provider = anuma
protocol = anuma-input-images
size = 1920x1920
参考图槽位 = front/full-body/side
```

期望：

```text
选择 front
↓
只上传一次
↓
generation 不带 size
↓
input_images 只有一个 URL
↓
生成成功
↓
assistant:
  text sent
  image sent
↓
reply.completed
```

生成 API 模拟 500 时：

```text
assistant:
  text sent
  image failed
↓
reply.completed
↓
不得 reply.failed
```

---

# 14. 实施顺序

建议不要拆成很多零碎 PR。

一次完成一个 PR：

## Step 1

统一 `BuiltinImageProvider` 协议识别。

## Step 2

Anuma 请求体去掉 size。

## Step 3

参考图选择改为单图。

## Step 4

Provider 再做单图防线。

## Step 5

ReplyCoordinator 图片失败不再向外 throw。

## Step 6

Native Admin 测试改成真实协议。

## Step 7

增加自拍链路测试入口。

## Step 8

补完整回归测试。

## Step 9

CI + Web + iOS unsigned IPA 全绿后合并。

---

# 15. 建议 PR

建议分支：

```text
fix/anuma-image-server-parity
```

PR 标题：

```text
fix: align native Anuma image pipeline with server behavior
```

---

# 16. 验收标准

必须全部满足才算完成。

### 普通文生图

```text
✅ Anuma 可以生成
✅ 不发送 size
✅ 图片正常保存
```

### SOOYA 自拍

```text
✅ 根据 prompt 自动选择正面 / 全身 / 侧面
✅ 只上传 1 张参考图
✅ input_images 只有 1 个 URL
✅ 生图成功
```

### 管理后台

```text
✅ 文生图测试与真实 provider 协议一致
✅ 自拍链路可以单独真实测试
✅ 能显示失败阶段
```

### 失败行为

```text
✅ 图片失败不杀掉整条回复
✅ 已生成的文字保留
✅ reply.media.failed 有诊断阶段
✅ reply.failed 不会因为单纯图片失败触发
```

### 配置兼容

以下两种旧配置都必须可用：

```text
provider = anuma-input-images
```

以及：

```text
provider = anuma
options.protocol = anuma-input-images
```

---

# 17. 不做的事情

本次不要顺手重构：

```text
整个媒体系统
Director
聊天模型指令协议
TTS
Sticker
MediaStore
OTA
```

这些与本次故障无关。

本次只收口：

```text
Anuma 协议
自拍参考图
失败语义
图片诊断
Admin 图片测试
```

---

# 18. 最终目标状态

修复后 IPA 和服务器版应只保留“运行环境差异”：

```text
服务器：
Node / fs / Buffer

IPA：
Capacitor / Swift HTTP / Uint8Array
```

业务行为必须一致：

```text
同一个图片意图
同一种参考图选择
同一个 Anuma 请求协议
同一种失败降级
同一套可诊断结果
```

**不要再允许“服务器版是一套，IPA 为了本地化又复制出另一套近似实现”。**

这次修完后，生图链路应该从“能不能碰巧成功”变成真正可验证的：

```text
意图 → 单参考图 → 上传 → Anuma → 保存 → 展示
```

并且任何一段出错，都只影响图片这一段，不再把整条聊天回复一起拖下水。
