import type { LocalEventListener } from './LocalEventBus.js';
import type { LocalCoreFacade, SooyaClient } from '../lib/sooyaClient.js';
import { toUploadInput } from '../lib/sooyaClient.js';

const MODEL_TEST_UI_TIMEOUT_MS = 35_000;
const IMAGE_TEST_UI_TIMEOUT_MS = 15 * 60_000;

type LocalAdminRequestOptions = { method?: string; body?: unknown; signal?: AbortSignal };

/**
 * Native/local admin requests run in-process, so a bridge promise that never
 * settles would otherwise leave the model-test button stuck forever. Provider
 * probes have their own AbortController, but this outer deadline also covers
 * config/Keychain/native-bridge work that happens before the provider probe.
 */
export function localAdminRequestTimeoutMs(path: string): number | null {
  const pathname = new URL(path, 'https://sooya.local').pathname;
  const match = pathname.match(/^\/api\/admin\/models\/([^/]+)\/test$/u);
  if (!match || match[1] === 'web-search') return null;
  return decodeURIComponent(match[1]!) === 'image' ? IMAGE_TEST_UI_TIMEOUT_MS : MODEL_TEST_UI_TIMEOUT_MS;
}

export async function withLocalAdminDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`连接测试超过 ${formatTimeout(timeoutMs)}仍未返回，请检查本地桥接、网络或上游服务`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function formatTimeout(timeoutMs: number): string {
  return timeoutMs % 60_000 === 0
    ? `${timeoutMs / 60_000} 分钟`
    : timeoutMs % 1_000 === 0
      ? `${timeoutMs / 1_000} 秒`
      : `${timeoutMs} 毫秒`;
}

/** Direct in-process client. It deliberately has no URL, token, or fetch seam. */
export class LocalSooyaClient implements SooyaClient {
  constructor(private readonly core: LocalCoreFacade, private readonly resolveBuiltin?: (id: string) => string | null) {}

  bootstrap: SooyaClient['bootstrap'] = () => this.core.bootstrap();
  messages: SooyaClient['messages'] = (options) => this.core.messages(options);
  messageSearch: SooyaClient['messageSearch'] = (query, options) => this.core.messageSearch(query, options);
  messagesByDate: SooyaClient['messagesByDate'] = (date, timeZone, limit) => this.core.messagesByDate(date, timeZone, limit);
  messageContext: SooyaClient['messageContext'] = (id, options) => this.core.messageContext(id, options);
  send: SooyaClient['send'] = (payload) => this.core.send(payload);
  withdraw: SooyaClient['withdraw'] = (id) => this.core.withdraw(id);
  retryBatch: SooyaClient['retryBatch'] = (id) => this.core.retryBatch(id);
  upload: SooyaClient['upload'] = async (files, options) => this.core.upload(await toUploadInput(files), options);
  moments: SooyaClient['moments'] = (limit) => this.core.moments(limit);
  likeMoment: SooyaClient['likeMoment'] = (id, liked) => this.core.likeMoment(id, liked);
  stickerSearch: SooyaClient['stickerSearch'] = (options) => this.core.stickerSearch(options);
  life: SooyaClient['life'] = () => this.core.life();
  presence: SooyaClient['presence'] = () => this.core.presence();
  capabilities: SooyaClient['capabilities'] = () => this.core.capabilities();
  adminRequest: NonNullable<SooyaClient['adminRequest']> = async <T = unknown>(
    path: string,
    options?: LocalAdminRequestOptions
  ): Promise<T> => {
    const work = this.core.adminRequest<T>(path, options);
    const timeoutMs = localAdminRequestTimeoutMs(path);
    return timeoutMs === null ? await work : await withLocalAdminDeadline(work, timeoutMs);
  };
  resolveBuiltinMediaUrl = (id: string): string | null => this.resolveBuiltin?.(id) ?? null;
  subscribe(listener: LocalEventListener): () => void { return this.core.subscribe(listener); }
}
