import type { ConfigRepository, ProviderConfig } from '../db/config.repo.js';
import type { HttpPlatform } from '../platform/http.js';
import type { HealthStatus } from './types.js';
import { ProviderNotConfiguredError, ProviderRequestError } from './types.js';
import { endpoint, healthStatus, isRecord, requestJson, type SecretHeader } from './http-json.js';

export type WebSearchProviderName = 'doubao' | 'tavily';
export type WebSearchFreshness = 'day' | 'week' | 'month' | 'year';

export interface WebSearchRequest {
  query: string;
  maxResults: number;
  city?: string;
  region?: string;
  country?: string;
  freshness?: WebSearchFreshness;
  signal?: AbortSignal;
}

export interface WebSearchCitation {
  title: string;
  url: string;
  snippet?: string;
  siteName?: string;
  publishedAt?: string;
}

export interface WebSearchResult {
  provider: WebSearchProviderName;
  query: string;
  citations: WebSearchCitation[];
}

export interface WebSearchProvider {
  readonly name: WebSearchProviderName;
  readonly configured: boolean;
  search(request: WebSearchRequest): Promise<WebSearchResult>;
}

export interface ConfiguredWebSearch {
  order: WebSearchProviderName[];
  providers: WebSearchProvider[];
  maxResults: number;
}

/**
 * Builds the local web-search runtime from the `webSearch` provider config.
 * Like every other provider here, HTTP goes through HttpPlatform so native
 * builds resolve the API key inside Keychain (secretRef) and never pass the
 * secret through JS. The config.provider value is the first-choice provider;
 * `options.fallback` may name a secondary (e.g. "tavily" when doubao fails).
 */
export async function createWebSearch(http: HttpPlatform, config: ConfigRepository): Promise<ConfiguredWebSearch | null> {
  const row = await config.getProvider('webSearch');
  if (!row || !row.enabled) return null;
  const primary = row.provider === 'tavily' ? 'tavily' : 'doubao';
  const fallback = row.options.fallback === 'tavily' ? 'tavily' : row.options.fallback === 'doubao' ? 'doubao' : null;
  const providers: WebSearchProvider[] = [];
  if (primary === 'tavily') providers.push(new TavilySearchProvider(http, row));
  else providers.push(new DoubaoSearchProvider(http, row));
  if (fallback && fallback !== primary) {
    const fallbackRow = fallback === 'tavily' ? { ...row, provider: 'tavily' } : { ...row, provider: 'doubao' };
    if (fallback === 'tavily') providers.push(new TavilySearchProvider(http, fallbackRow));
    else providers.push(new DoubaoSearchProvider(http, fallbackRow));
  }
  return {
    order: providers.map((provider) => provider.name),
    providers,
    maxResults: Math.max(1, Math.min(10, typeof row.options.maxResults === 'number' ? Math.trunc(row.options.maxResults) : 5))
  };
}

const TIME_RANGE: Record<WebSearchFreshness, string> = { day: 'OneDay', week: 'OneWeek', month: 'OneMonth', year: 'OneYear' };

export class DoubaoSearchProvider implements WebSearchProvider {
  readonly name = 'doubao' as const;
  readonly configured: boolean;
  private readonly secret: SecretHeader;

  constructor(private readonly http: HttpPlatform, private readonly config: ProviderConfig) {
    this.configured = Boolean(config.baseUrl.trim() && config.secretRef);
    this.secret = { ref: config.secretRef, header: 'authorization', prefix: 'Bearer ' };
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult> {
    if (!this.configured) throw new ProviderNotConfiguredError('webSearch');
    const body: Record<string, unknown> = {
      Query: request.query,
      SearchType: 'web',
      Count: Math.max(1, Math.min(request.maxResults, 50)),
      NeedSummary: true,
      QueryControl: { QueryRewrite: true }
    };
    if (request.freshness) body.TimeRange = TIME_RANGE[request.freshness];
    if (this.config.options.edition !== 'global') body.Filter = { AuthInfoLevel: 0 };
    let value: unknown;
    try {
      value = await requestJson<unknown>(this.http, {
        url: endpoint(this.config.baseUrl, '/api/contents/query'),
        method: 'POST',
        body,
        signal: request.signal,
        timeoutMs: typeof this.config.options.timeoutMs === 'number' ? this.config.options.timeoutMs : 15_000
      }, this.secret);
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError(`doubao search failed: ${error instanceof Error ? error.message : String(error)}`, 0);
    }
    const citations = doubaoCitations(value).slice(0, request.maxResults);
    return { provider: this.name, query: request.query, citations };
  }

  async inspectHealth(): Promise<HealthStatus> {
    return healthStatus('webSearch', this.name, this.configured, this.config.model, this.configured ? undefined : '未配置密钥引用');
  }
}

export class TavilySearchProvider implements WebSearchProvider {
  readonly name = 'tavily' as const;
  readonly configured: boolean;
  private readonly secret: SecretHeader;

  constructor(private readonly http: HttpPlatform, private readonly config: ProviderConfig) {
    this.configured = Boolean(config.baseUrl.trim() && config.secretRef);
    this.secret = { ref: config.secretRef, header: 'authorization', prefix: 'Bearer ' };
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult> {
    if (!this.configured) throw new ProviderNotConfiguredError('webSearch');
    const body = {
      query: tavilyQuery(request.query),
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      max_results: Math.max(1, Math.min(request.maxResults, 5)),
      ...(request.freshness ? { time_range: request.freshness } : {})
    };
    let value: unknown;
    try {
      value = await requestJson<unknown>(this.http, {
        url: endpoint(this.config.baseUrl, '/search'),
        method: 'POST',
        body,
        signal: request.signal,
        timeoutMs: typeof this.config.options.timeoutMs === 'number' ? this.config.options.timeoutMs : 15_000
      }, this.secret);
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError(`tavily search failed: ${error instanceof Error ? error.message : String(error)}`, 0);
    }
    const citations = tavilyCitations(value).slice(0, body.max_results);
    return { provider: this.name, query: request.query, citations };
  }

  async inspectHealth(): Promise<HealthStatus> {
    return healthStatus('webSearch', this.name, this.configured, this.config.model, this.configured ? undefined : '未配置密钥引用');
  }
}

/** Tavily rejects CJK-only queries; a neutral ASCII prefix preserves the query semantics. */
function tavilyQuery(query: string): string {
  const trimmed = query.trim();
  return /[a-z0-9]/iu.test(trimmed) ? trimmed : `web search: ${trimmed}`;
}

function doubaoCitations(value: unknown): WebSearchCitation[] {
  if (!isRecord(value)) return [];
  const result = isRecord(value.Result) ? value.Result : null;
  const rows = Array.isArray(result?.WebResults) ? result.WebResults : [];
  return rows.flatMap((item) => {
    if (!isRecord(item)) return [];
    const url = safeWebUrl(item.Url);
    if (!url) return [];
    const snippet = boundedText(item.Summary ?? item.Snippet);
    const siteName = text(item.SiteName);
    const publishedAt = text(item.PublishTime ?? item.PublishDate ?? item.DatePublished);
    return [{ title: text(item.Title) || hostname(url), url, ...(snippet ? { snippet } : {}), ...(siteName ? { siteName } : {}), ...(publishedAt ? { publishedAt } : {}) }];
  });
}

function tavilyCitations(value: unknown): WebSearchCitation[] {
  if (!isRecord(value)) return [];
  const rows = Array.isArray(value.results) ? value.results : [];
  return rows.flatMap((item) => {
    if (!isRecord(item)) return [];
    const url = safeWebUrl(item.url);
    if (!url) return [];
    const snippet = boundedText(item.content);
    return [{ title: text(item.title) || hostname(url), url, ...(snippet ? { snippet } : {}) }];
  });
}

function safeWebUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function hostname(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function boundedText(value: unknown): string {
  return text(value).slice(0, 1_200);
}
