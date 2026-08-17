import {
  LocalCore,
  type LocalAdminRequestOptions,
  type LocalCoreOptions,
  type ModelCapabilitySlot
} from '@sooya/core/app';
import type { HttpPlatform, McpPlatform } from '@sooya/core/platform';
import type { LocalNotificationScheduler } from '@sooya/core/app';
import { NativeNotifications } from './nativeNotifications.js';
import {
  BuiltinImageProvider,
  BuiltinTtsProvider,
  ImagePipelineError,
  ProviderRequestError
} from '@sooya/core/providers';
import { nativeModelProbeTimeoutLabel, nativeModelProbeTimeoutMs } from './modelProbeTimeout.js';

type NativeProviderConfig = ConstructorParameters<typeof BuiltinImageProvider>[1];

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

const PREVIEW_TEXT = '你好呀，我刚刚想到你了。';

/**
 * Native IPA variant of LocalCore. Standard model probes stay owned by
 * LocalCore so every environment uses one implementation. NativeLocalCore only
 * handles genuinely native-only admin behavior such as selfie probing.
 */
export class NativeLocalCore extends LocalCore {
  private readonly probeHttp: HttpPlatform;
  private readonly probeMcp?: McpPlatform;
  private readonly probeReferenceImages?: NativeProbeReferenceLoader;

  constructor(options: LocalCoreOptions & { http: HttpPlatform; referenceImages?: NativeProbeReferenceLoader; notificationScheduler?: LocalNotificationScheduler | null }) {
    super({ ...options, notificationScheduler: options.notificationScheduler === undefined ? new NativeNotifications() : options.notificationScheduler });
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
    if (!match || method !== 'POST' || rawCapability !== 'image') return await super.adminRequest<T>(path, options);

    const body = isRecord(options.body) ? options.body : {};
    if (body.mode !== 'selfie') return await super.adminRequest<T>(path, options);

    const configured = await this.configRepo.getProvider('image');
    if (!configured) throw new Error('这个能力还没配全（接口协议、地址、模型名、密钥缺一不可）');
    return await probeNativeSelfieImage(this.probeHttp, configured, {
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

/** Native-only selfie probe. Standard model tests are owned by LocalCore. */
export async function probeNativeSelfieImage(
  http: HttpPlatform,
  configured: NativeProviderConfig,
  options: { referenceImages?: NativeProbeReferenceLoader } = {}
): Promise<NativeModelTestResult> {
  if (!configured.enabled || !configured.baseUrl || !configured.model || !configured.secretRef) {
    throw new Error('这个能力还没配全（接口协议、地址、模型名、密钥缺一不可）');
  }

  const probeTimeoutMs = nativeModelProbeTimeoutMs(configured, 'image');
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`连接测试超过 ${nativeModelProbeTimeoutLabel(probeTimeoutMs)}还没有结果`)),
    probeTimeoutMs
  );
  const startedAt = Date.now();
  try {
    const provider = new BuiltinImageProvider(http, configured);
    const prompt = '生成一张 SOOYA 的正面自然生活自拍（连接测试）';
    const references = await options.referenceImages?.(prompt) ?? [];
    const framing = references[0]?.framing;
    const image = await provider.generate(prompt, {
      signal: controller.signal,
      ...(references.length ? { referenceImages: references } : {})
    });
    return {
      ok: true,
      slot: 'image',
      provider: provider.name,
      model: configured.model || undefined,
      latencyMs: Date.now() - startedAt,
      detail: `自拍链路正常：参考图 ${framing ?? '无'}，已收到 ${Math.max(1, Math.round(image.data.byteLength / 1024))} KB ${image.mime} 图片`,
      mode: 'selfie',
      ...(framing ? { framing } : {})
    };
  } catch (error) {
    const pipelineStage = error instanceof ImagePipelineError ? error.stage : 'generation';
    const status = error instanceof ProviderRequestError ? error.status : error instanceof ImagePipelineError ? error.status : undefined;
    throw new Error(`图片自拍链路失败 · 阶段：${imageStageLabel(pipelineStage)}${status ? ` · HTTP ${status}` : ''} · ${modelProbeError(error, Date.now() - startedAt, controller.signal.aborted)}`);
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
