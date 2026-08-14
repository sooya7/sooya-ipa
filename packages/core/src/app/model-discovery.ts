import type { ConfigRepository, ProviderCapability } from '../db/config.repo.js';
import type { HttpPlatform } from '../platform/http.js';
import { isRecord } from '../providers/http-json.js';

/**
 * Real model discovery through HttpPlatform (server routes/admin.ts logic
 * ported 1:1). The API key never crosses into JS: requests carry secretRef +
 * header, and the native transport resolves it inside Keychain.
 */

/** Provider protocols that expose a /models endpoint worth querying. */
const DISCOVERABLE = new Set([
  'openai-chat',
  'openai-responses',
  'openai-compatible',
  'openai-embeddings',
  'openai-images',
  'openai-tts',
  'openai-rerank',
  'anthropic-messages'
]);

export type DiscoveryResult =
  | { ok: true; models: string[]; source: string }
  | { ok: false; error: string; detail: string };

export class ModelDiscoveryService {
  constructor(private readonly http: HttpPlatform, private readonly config: ConfigRepository) {}

  /** `baseUrl` is optional: when absent, the saved config's baseUrl is used. */
  async discover(capability: ProviderCapability, baseUrl?: string, signal?: AbortSignal): Promise<DiscoveryResult> {
    const row = await this.config.getProvider(capability);
    const provider = row?.provider?.trim() || 'none';
    if (!DISCOVERABLE.has(provider)) {
      return { ok: false, error: 'discovery_unsupported', detail: `「${provider}」这种接口不提供模型列表，模型名需要手填` };
    }
    const base = (baseUrl?.trim() ?? row?.baseUrl ?? '').replace(/\/+$/u, '');
    if (!base) return { ok: false, error: 'missing_base_url', detail: '先填接口地址再拉取' };
    const urls = discoveryUrls(base);
    const headers: Record<string, string> = {};
    if (row?.secretRef) {
      if (provider === 'anthropic-messages') {
        headers['x-api-key'] = 'placeholder';
        headers['anthropic-version'] = '2023-06-01';
      }
    }
    const secretHeader = provider === 'anthropic-messages' ? 'x-api-key' : 'authorization';
    const secretPrefix = provider === 'anthropic-messages' ? '' : 'Bearer ';
    // NewAPI's frontend model list requires the user id header, not the key.
    const newApiUserId = typeof row?.options.newApiUserId === 'string' ? row.options.newApiUserId.trim() : '';
    if (newApiUserId) headers['New-Api-User'] = newApiUserId;

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason ?? new Error('discovery aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('模型列表拉取超时')), 20_000);
    try {
      let url = urls[0]!;
      let response = await this.request(url, headers, row?.secretRef ?? null, secretHeader, secretPrefix, controller.signal);
      // NewAPI exposes its frontend model list at /api/models; only fall back
      // when the standard route is genuinely absent.
      if ((response.status === 404 || response.status === 405) && urls[1]) {
        url = urls[1]!;
        response = await this.request(url, headers, row?.secretRef ?? null, secretHeader, secretPrefix, controller.signal);
      }
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, error: 'discovery_failed', detail: `拉取失败：HTTP ${response.status}` };
      }
      const payload = parseJson(new TextDecoder().decode(response.body));
      const ids = [...new Set(
        modelRows(payload)
          .map((item) => (typeof item === 'string' ? item : (isRecord(item) ? item.id ?? item.name : undefined)))
          .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
          .map((id) => id.trim())
      )].sort((a, b) => a.localeCompare(b)).slice(0, 300);
      if (ids.length === 0) return { ok: false, error: 'discovery_empty', detail: '接口返回了列表，但里面没有可用的模型名' };
      return { ok: true, models: ids, source: url };
    } catch (error) {
      return { ok: false, error: 'discovery_failed', detail: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async request(url: string, headers: Record<string, string>, secretRef: string | null, secretHeader: string, secretPrefix: string, signal: AbortSignal) {
    return await this.http.request({
      url,
      method: 'GET',
      headers,
      ...(secretRef ? { secretRef, secretHeader, secretPrefix } : {}),
      signal,
      timeoutMs: 20_000
    });
  }
}

function discoveryUrls(rawBase: string): string[] {
  let base = rawBase.replace(/\/+$/u, '');
  // Operators often paste the image-generation endpoint from the provider docs.
  base = base.replace(/\/(?:images\/(?:generations|edits))$/iu, '');
  const primary = base.endsWith('/models') ? base : `${base}/models`;
  const urls = [primary];
  try {
    const parsed = new URL(base);
    if (!base.endsWith('/models') && /\/v1$/iu.test(parsed.pathname)) {
      urls.push(`${parsed.origin}/api/models`);
    }
  } catch { /* invalid base: keep the single primary url */ }
  return urls;
}

function modelRows(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const body = payload as { data?: unknown; models?: unknown };
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.models)) return body.models;
  // NewAPI groups model names by channel: { data: { "1": ["gpt-4o"] } }.
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    return Object.values(body.data as Record<string, unknown>).flatMap((group) => Array.isArray(group) ? group : []);
  }
  return [];
}

function parseJson(text: string): unknown {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
