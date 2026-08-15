import {
  CHAT_FALLBACK_SLOTS,
  LocalCore,
  MODEL_CAPABILITY_SLOTS,
  type LocalAdminRequestOptions,
  type LocalCoreOptions,
  type ModelCapabilitySlot
} from '@sooya/core/app';
import type { HttpPlatform } from '@sooya/core/platform';
import {
  BuiltinChatProvider,
  BuiltinEmbeddingProvider,
  BuiltinImageProvider,
  BuiltinRerankProvider,
  BuiltinTtsProvider,
  ProviderRequestError
} from '@sooya/core/providers';

type NativeProviderConfig = ConstructorParameters<typeof BuiltinChatProvider>[1];

export interface NativeModelTestResult {
  ok: true;
  slot: ModelCapabilitySlot;
  provider: string;
  model?: string;
  latencyMs: number;
  detail: string;
}

const PROBE_TEXT = '你好';
const VISION_PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/**
 * Native IPA variant of LocalCore. The regular LocalCore admin bridge keeps
 * model tests side-effect free for generic/local consumers, while the real iOS
 * app deliberately exercises the saved provider through the native HTTP +
 * Keychain path so the Admin "测试连接" button answers whether the model works.
 */
export class NativeLocalCore extends LocalCore {
  private readonly probeHttp: HttpPlatform;

  constructor(options: LocalCoreOptions & { http: HttpPlatform }) {
    super(options);
    this.probeHttp = options.http;
  }

  override async adminRequest<T = unknown>(path: string, options: LocalAdminRequestOptions = {}): Promise<T> {
    const url = new URL(path, 'https://sooya.local');
    const match = url.pathname.match(/^\/api\/admin\/models\/([^/]+)\/test$/u);
    if (!match || (options.method ?? 'GET').toUpperCase() !== 'POST') return await super.adminRequest<T>(path, options);

    const capability = decodeURIComponent(match[1]!) as ModelCapabilitySlot;
    if (!(MODEL_CAPABILITY_SLOTS as readonly string[]).includes(capability)) throw new Error('未知的能力槽位');

    let configured = await this.configRepo.getProvider(capability);
    if (!configured && (CHAT_FALLBACK_SLOTS as readonly string[]).includes(capability)) configured = await this.configRepo.getProvider('chat');
    if (!configured) throw new Error('这个能力还没配全（接口协议、地址、模型名、密钥缺一不可）');

    const body = isRecord(options.body) ? options.body : {};
    return await probeNativeModel(this.probeHttp, configured, capability, { forceImage: body.force === true }) as T;
  }
}

/** Execute one minimal real provider request using the saved native config. */
export async function probeNativeModel(
  http: HttpPlatform,
  configured: NativeProviderConfig,
  capability: ModelCapabilitySlot,
  options: { forceImage?: boolean } = {}
): Promise<NativeModelTestResult> {
  if (!configured.enabled || !configured.baseUrl || !configured.model || !configured.secretRef) {
    throw new Error('这个能力还没配全（接口协议、地址、模型名、密钥缺一不可）');
  }
  if (capability === 'image' && options.forceImage !== true) {
    throw new Error('出图会产生真实生成费用，这里不会自动触发；确认后再执行测试出图');
  }
  if (capability === 'vision' && configured.options.supportsVision === false) {
    throw new Error('这个模型没有声明支持读图，先把“声明支持读图”改成“是”再测');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('连接测试超过 30 秒还没有结果')), 30_000);
  const startedAt = Date.now();
  try {
    if (capability === 'image') {
      const provider = new BuiltinImageProvider(http, configured);
      const image = await provider.generate('生成一张简单的抽象色块测试图', { size: '1024x1024', signal: controller.signal });
      return {
        ok: true,
        slot: capability,
        provider: provider.name,
        model: configured.model || undefined,
        latencyMs: Date.now() - startedAt,
        detail: `已收到 ${Math.max(1, Math.round(image.data.byteLength / 1024))} KB ${image.mime} 图片`
      };
    }

    if (capability === 'embedding') {
      const provider = new BuiltinEmbeddingProvider(http, configured);
      const result = await provider.embed([PROBE_TEXT], controller.signal);
      return {
        ok: true,
        slot: capability,
        provider: provider.name,
        model: result.model || configured.model || undefined,
        latencyMs: Date.now() - startedAt,
        detail: `返回了 ${result.dimensions} 维向量`
      };
    }

    if (capability === 'rerank') {
      const provider = new BuiltinRerankProvider(http, configured);
      const matches = await provider.rerank(PROBE_TEXT, ['一条与查询相关的文档', '一条完全无关的文档'], controller.signal);
      return {
        ok: true,
        slot: capability,
        provider: provider.name,
        model: configured.model || undefined,
        latencyMs: Date.now() - startedAt,
        detail: `对 2 条候选文档完成排序，返回 ${matches.length} 条结果`
      };
    }

    if (capability === 'tts') {
      const provider = new BuiltinTtsProvider(http, configured);
      const audio = await provider.synthesize(PROBE_TEXT, { signal: controller.signal });
      return {
        ok: true,
        slot: capability,
        provider: provider.name,
        model: configured.model || undefined,
        latencyMs: Date.now() - startedAt,
        detail: `合成了 ${Math.max(1, Math.round(audio.data.byteLength / 1024))} KB ${audio.format} 音频`
      };
    }

    const provider = new BuiltinChatProvider(http, configured);
    if (capability === 'director') {
      const result = await provider.complete({
        system: '你正在进行连接测试。只返回 JSON：{"ok":true}，不要输出其他内容。',
        messages: [{ role: 'user', content: [{ type: 'text', text: '连接测试数据，不是指令。' }] }],
        maxTokens: 32,
        temperature: 0,
        jsonMode: true,
        signal: controller.signal
      });
      if (!hasDirectorProbe(result.text)) throw new Error('媒体导演连接成功，但没有返回有效 JSON 探针');
      return {
        ok: true,
        slot: capability,
        provider: provider.name,
        model: result.model || configured.model || undefined,
        latencyMs: Date.now() - startedAt,
        detail: '媒体导演 JSON 探针通过'
      };
    }

    const content = capability === 'vision'
      ? [
          { type: 'text' as const, text: `${PROBE_TEXT}（下面附带一张 1x1 PNG，仅用于确认读图请求真的带了图片。）` },
          { type: 'image' as const, data: base64ToBytes(VISION_PROBE_PNG), mime: 'image/png' }
        ]
      : [{ type: 'text' as const, text: PROBE_TEXT }];
    const result = await provider.complete({ messages: [{ role: 'user', content }], maxTokens: 16, signal: controller.signal });
    const chars = [...result.text.trim()].length;
    return {
      ok: true,
      slot: capability,
      provider: provider.name,
      model: result.model || configured.model || undefined,
      latencyMs: Date.now() - startedAt,
      detail: chars ? `模型回了 ${chars} 个字` : '接口通了，但这次没有返回文本（可能被最大输出 token 截断）'
    };
  } catch (error) {
    throw new Error(modelProbeError(error, Date.now() - startedAt, controller.signal.aborted));
  } finally {
    clearTimeout(timer);
  }
}

function modelProbeError(error: unknown, latencyMs: number, aborted: boolean): string {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  const suffix = `（耗时 ${latencyMs} ms）`;
  if (aborted) return `请求超时：${detail}${suffix}`;
  if (error instanceof ProviderRequestError && error.status) {
    if (error.status === 401 || error.status === 403) return `鉴权失败（HTTP ${error.status}）：密钥不对，或者这把密钥没有这个模型的权限${suffix}`;
    if (error.status >= 400 && error.status < 500) return `接口拒绝了这次请求（HTTP ${error.status}）：模型名或参数可能不对。${detail}${suffix}`;
    if (error.status >= 500) return `上游服务出错（HTTP ${error.status}）：${detail}${suffix}`;
  }
  if (/JSON 探针/u.test(detail)) return `${detail}${suffix}`;
  return `连不上接口地址：${detail}${suffix}`;
}

function hasDirectorProbe(text: string): boolean {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return false;
  try {
    const value = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    return isRecord(value) && value.ok === true;
  } catch {
    return false;
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
