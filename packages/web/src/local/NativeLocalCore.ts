import {
  CHAT_FALLBACK_SLOTS,
  LocalCore,
  MODEL_CAPABILITY_SLOTS,
  type LocalAdminRequestOptions,
  type LocalCoreOptions,
  type ModelCapabilitySlot
} from '@sooya/core/app';
import type { HttpPlatform, McpPlatform } from '@sooya/core/platform';
import {
  BuiltinChatProvider,
  BuiltinEmbeddingProvider,
  BuiltinImageProvider,
  BuiltinRerankProvider,
  BuiltinTtsProvider,
  ImagePipelineError,
  ProviderRequestError
} from '@sooya/core/providers';
import { nativeModelProbeTimeoutLabel, nativeModelProbeTimeoutMs } from './modelProbeTimeout.js';

type NativeProviderConfig = ConstructorParameters<typeof BuiltinChatProvider>[1];

/** One selected selfie reference for the native admin selfie probe. */
export interface NativeProbeReferenceImage { data: Uint8Array; mime: string; framing?: string; }
export type NativeProbeReferenceLoader = (hint?: string) => Promise<NativeProbeReferenceImage[]>;

export interface NativeModelTestResult {
  ok: true;
  slot: ModelCapabilitySlot;
  provider: string;
  model?: string;
  latencyMs: number;
  detail: string;
  /** Image-only diagnostics: pipeline mode and selected reference framing. */
  mode?: 'text-to-image' | 'selfie';
  stage?: string;
  framing?: string;
}

export interface NativeVoicePreviewResult {
  dataBase64: string;
  mime: string;
  format: string;
}

const PROBE_TEXT = '你好';
const PREVIEW_TEXT = '你好呀，我刚刚想到你了。';
const VISION_PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/**
 * Native IPA variant of LocalCore. The regular LocalCore admin bridge keeps
 * model tests side-effect free for generic/local consumers, while the real iOS
 * app deliberately exercises the saved provider through the native HTTP +
 * Keychain path so the Admin "测试连接" button answers whether the model works.
 */
export class NativeLocalCore extends LocalCore {
  private readonly probeHttp: HttpPlatform;
  private readonly probeMcp?: McpPlatform;
  private readonly probeReferenceImages?: NativeProbeReferenceLoader;

  constructor(options: LocalCoreOptions & { http: HttpPlatform; referenceImages?: NativeProbeReferenceLoader }) {
    super(options);
    this.probeHttp = options.http;
    this.probeMcp = options.mcp;
    this.probeReferenceImages = options.referenceImages;
  }

  override async adminRequest<T = unknown>(path: string, options: LocalAdminRequestOptions = {}): Promise<T> {
    const url = new URL(path, 'https://sooya.local');
    const method = (options.method ?? 'GET').toUpperCase();

    // Native SOOYAMcp keeps an established server session in memory. The
    // generic admin refresh path reconnects before listing tools, so a second
    // "连接测试" used to hit duplicateServer and incorrectly mark a healthy
    // connection as degraded. Explicitly close the old session before the
    // diagnostic reconnect; the persisted config/tool policy stays untouched.
    const mcpAction = url.pathname.match(/^\/api\/admin\/mcp\/([^/]+)\/(test|refresh-tools)$/u);
    if (mcpAction && method === 'POST') {
      const serverId = decodeURIComponent(mcpAction[1]!);
      await this.probeMcp?.disconnect(serverId).catch(() => undefined);
      return await super.adminRequest<T>(path, options);
    }

    // Browser/server preview returns raw audio bytes. Native LocalCore has no
    // HTTP response body to hand to <audio>, so synthesize through the same
    // native provider/Keychain path and return a JSON-safe base64 envelope.
    if (url.pathname === '/api/admin/voice/preview' && method === 'POST') {
      const configured = await this.configRepo.getProvider('tts');
      if (!configured) throw new Error('这个能力还没配全（接口协议、地址、模型名、密钥缺一不可）');
      const body = isRecord(options.body) ? options.body : {};
      const text = typeof body.text === 'string' ? body.text : PREVIEW_TEXT;
      const emotion = typeof body.emotion === 'string' ? body.emotion : undefined;
      return await synthesizeNativeVoicePreview(this.probeHttp, configured, text, emotion) as T;
    }

    const match = url.pathname.match(/^\/api\/admin\/models\/([^/]+)\/test$/u);
    const rawCapability = match ? decodeURIComponent(match[1]!) : '';
    if (!match || method !== 'POST' || !(MODEL_CAPABILITY_SLOTS as readonly string[]).includes(rawCapability)) return await super.adminRequest<T>(path, options);

    const capability = rawCapability as ModelCapabilitySlot;

    let configured = await this.configRepo.getProvider(capability);
    if (!configured && (CHAT_FALLBACK_SLOTS as readonly string[]).includes(capability)) configured = await this.configRepo.getProvider('chat');
    if (!configured) throw new Error('这个能力还没配全（接口协议、地址、模型名、密钥缺一不可）');

    const body = isRecord(options.body) ? options.body : {};
    return await probeNativeModel(this.probeHttp, configured, capability, {
      forceImage: body.force === true,
      selfie: body.mode === 'selfie',
      referenceImages: this.probeReferenceImages
    }) as T;
  }
}

/** Native preview transport: real provider request in, JSON-safe audio out. */
export async function synthesizeNativeVoicePreview(
  http: HttpPlatform,
  configured: NativeProviderConfig,
  text: string,
  emotion?: string
): Promise<NativeVoicePreviewResult> {
  if (!configured.enabled || !configured.baseUrl || !configured.model || !configured.secretRef) {
    throw new Error('这个能力还没配全（接口协议、地址、模型名、密钥缺一不可）');
  }
  const provider = new BuiltinTtsProvider(http, configured);
  const audio = await provider.synthesize(text.trim() || PREVIEW_TEXT, { emotion });
  return {
    dataBase64: bytesToBase64(audio.data),
    mime: audio.mime,
    format: audio.format
  };
}

/** Execute one minimal real provider request using the saved native config. */
export async function probeNativeModel(
  http: HttpPlatform,
  configured: NativeProviderConfig,
  capability: ModelCapabilitySlot,
  options: { forceImage?: boolean; selfie?: boolean; referenceImages?: NativeProbeReferenceLoader } = {}
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

  const probeTimeoutMs = nativeModelProbeTimeoutMs(configured, capability);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`连接测试超过 ${nativeModelProbeTimeoutLabel(probeTimeoutMs)}还没有结果`)),
    probeTimeoutMs
  );
  const startedAt = Date.now();
  try {
    if (capability === 'image') {
      const provider = new BuiltinImageProvider(http, configured);
      const selfie = options.selfie === true;
      const prompt = selfie ? '生成一张 SOOYA 的正面自然生活自拍（连接测试）' : '生成一张简单的抽象色块测试图';
      const references = selfie ? await options.referenceImages?.(prompt) ?? [] : [];
      const framing = references[0]?.framing;
      // No hardcoded size here: the provider owns the wire protocol. Anuma
      // omits size entirely; OpenAI-compatible protocols read saved options.
      const image = await provider.generate(prompt, { signal: controller.signal, ...(references.length ? { referenceImages: references } : {}) });
      return {
        ok: true,
        slot: capability,
        provider: provider.name,
        model: configured.model || undefined,
        latencyMs: Date.now() - startedAt,
        detail: selfie
          ? `自拍链路正常：参考图 ${framing ?? '无'}，已收到 ${Math.max(1, Math.round(image.data.byteLength / 1024))} KB ${image.mime} 图片`
          : `已收到 ${Math.max(1, Math.round(image.data.byteLength / 1024))} KB ${image.mime} 图片`,
        mode: selfie ? 'selfie' : 'text-to-image',
        ...(framing ? { framing } : {})
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
    if (capability === 'image') {
      const pipelineStage = error instanceof ImagePipelineError ? error.stage : 'generation';
      const status = error instanceof ProviderRequestError ? error.status : error instanceof ImagePipelineError ? error.status : undefined;
      throw new Error(`图片${options.selfie === true ? '自拍链路' : '生成'}失败 · 阶段：${imageStageLabel(pipelineStage)}${status ? ` · HTTP ${status}` : ''} · ${modelProbeError(error, Date.now() - startedAt, controller.signal.aborted)}`);
    }
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

function imageStageLabel(stage: string): string {
  const labels: Record<string, string> = {
    reference_select: '参考图选择',
    reference_read: '参考图读取',
    reference_upload: '参考图上传',
    generation: '图片生成',
    download: '图片下载',
    media_save: '图片保存'
  };
  return labels[stage] ?? stage;
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

function bytesToBase64(value: Uint8Array | ArrayBuffer): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
