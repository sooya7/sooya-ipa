import type { ProviderConfig } from '../db/config.repo.js';
import type { HttpPlatform } from '../platform/http.js';
import type { BinaryData, GeneratedImage, HealthStatus, ImageProvider } from './types.js';
import { ProviderRequestError } from './types.js';
import { endpoint, requestBytes, requestJson, toBase64, type SecretHeader } from './http-json.js';

export type ImageJobState = 'creating' | 'queued' | 'running' | 'materializing' | 'succeeded' | 'failed' | 'legacy';

export interface ImageJobLifecycleState {
  state: ImageJobState;
  clientRequestId: string;
  remoteJobId?: string;
  error?: string;
}

export interface ImageJobLifecycle {
  clientRequestId: string;
  onState?: (state: ImageJobLifecycleState) => void | Promise<void>;
}

export interface ImageJobReference {
  data: BinaryData;
  mime: string;
}

export interface JobCapableImageProvider extends ImageProvider {
  startJob(prompt: string, options: {
    referenceImages?: ImageJobReference[];
    signal?: AbortSignal;
  }, lifecycle: ImageJobLifecycle): Promise<{ jobId: string }>;
  resumeJob(input: { jobId?: string; clientRequestId?: string }, lifecycle?: ImageJobLifecycle, signal?: AbortSignal): Promise<GeneratedImage>;
  generateWithJob(prompt: string, options: {
    referenceImages?: ImageJobReference[];
    signal?: AbortSignal;
  }, lifecycle: ImageJobLifecycle): Promise<GeneratedImage>;
  editWithJob(prompt: string, image: BinaryData, options: { mime?: string; signal?: AbortSignal }, lifecycle: ImageJobLifecycle): Promise<GeneratedImage>;
}

export class ImageJobUnsupportedError extends Error {
  override name = 'ImageJobUnsupportedError';
}

export function isJobCapableImageProvider(provider: ImageProvider | null | undefined): provider is JobCapableImageProvider {
  const value = provider as Partial<JobCapableImageProvider> | null | undefined;
  return Boolean(value && typeof value.startJob === 'function' && typeof value.resumeJob === 'function');
}

type JobEnvelope = {
  jobId?: string;
  clientRequestId?: string;
  status?: string;
  result?: {
    url?: string;
    mime?: string;
    sha256?: string;
  };
  error?: {
    code?: string;
    message?: string;
  } | string;
};

type UploadEnvelope = string | { url?: string };

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const UNSUPPORTED_STATUS = new Set([404, 405, 501]);
const REFERENCE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

/**
 * Thin client for the optional `/image-jobs` contract. The normal ImageProvider
 * methods intentionally keep delegating to the existing synchronous provider,
 * so shipping this client before the gateway is deployed cannot break image
 * generation. ReplyCoordinator's durable-image adapter opts into the job
 * methods only when it can persist a pending message part first.
 */
export class DurableAnumaImageProvider implements JobCapableImageProvider {
  readonly name: string;
  readonly configured: boolean;

  constructor(
    private readonly http: HttpPlatform,
    private readonly config: ProviderConfig,
    private readonly legacy: ImageProvider
  ) {
    this.name = legacy.name;
    this.configured = legacy.configured;
  }

  async generate(prompt: string, options: { size?: string; signal?: AbortSignal; referenceImages?: ImageJobReference[] } = {}): Promise<GeneratedImage> {
    return await this.legacy.generate(prompt, options);
  }

  async edit(prompt: string, image: BinaryData, options: { mime?: string; signal?: AbortSignal } = {}): Promise<GeneratedImage> {
    return await this.legacy.edit(prompt, image, options);
  }

  async inspectHealth(): Promise<HealthStatus> {
    return await this.legacy.inspectHealth();
  }

  async generateWithJob(
    prompt: string,
    options: { referenceImages?: ImageJobReference[]; signal?: AbortSignal } = {},
    lifecycle: ImageJobLifecycle
  ): Promise<GeneratedImage> {
    const { jobId } = await this.startJob(prompt, options, lifecycle);
    return await this.resumeJob({ jobId, clientRequestId: lifecycle.clientRequestId }, lifecycle, options.signal);
  }

  async editWithJob(
    prompt: string,
    image: BinaryData,
    options: { mime?: string; signal?: AbortSignal } = {},
    lifecycle: ImageJobLifecycle
  ): Promise<GeneratedImage> {
    return await this.generateWithJob(prompt, {
      signal: options.signal,
      referenceImages: [{ data: image, mime: options.mime ?? 'image/png' }]
    }, lifecycle);
  }

  async startJob(
    prompt: string,
    options: { referenceImages?: ImageJobReference[]; signal?: AbortSignal } = {},
    lifecycle: ImageJobLifecycle
  ): Promise<{ jobId: string }> {
    if (!prompt.trim()) throw new ProviderRequestError('image generation requires a non-empty prompt');
    await lifecycle.onState?.({ state: 'creating', clientRequestId: lifecycle.clientRequestId });

    const inputImages: string[] = [];
    for (const reference of options.referenceImages ?? []) {
      inputImages.push(await this.uploadReference(reference, options.signal));
    }

    const body = {
      clientRequestId: lifecycle.clientRequestId,
      model: this.config.model,
      prompt,
      n: 1,
      ...(inputImages.length ? { input_images: inputImages } : {})
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
      try {
        const response = await requestJson<JobEnvelope>(this.http, {
          url: endpoint(this.config.baseUrl, '/image-jobs'),
          method: 'POST',
          signal: options.signal,
          timeoutMs: optionNumber(this.config, 'jobCreateTimeoutMs', 20_000),
          body
        }, secretFor(this.config));
        const jobId = cleanString(response.jobId);
        if (!jobId) throw new ProviderRequestError('image job create response contained no jobId');
        const state = normalizeState(response.status) ?? 'queued';
        await lifecycle.onState?.({ state, clientRequestId: lifecycle.clientRequestId, remoteJobId: jobId });
        return { jobId };
      } catch (error) {
        if (isUnsupported(error)) throw new ImageJobUnsupportedError('image job gateway is not available');
        lastError = error;
        if (!isTransient(error) || attempt === 3) throw error;
        await sleep(500 * 2 ** attempt, options.signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('image job creation failed');
  }

  async resumeJob(
    input: { jobId?: string; clientRequestId?: string },
    lifecycle?: ImageJobLifecycle,
    signal?: AbortSignal
  ): Promise<GeneratedImage> {
    let jobId = cleanString(input.jobId);
    const clientRequestId = lifecycle?.clientRequestId ?? cleanString(input.clientRequestId) ?? '';
    if (!jobId && input.clientRequestId) {
      jobId = await this.lookupJobId(input.clientRequestId, signal);
    }
    if (!jobId) throw new ProviderRequestError('image job could not be recovered');

    const started = Date.now();
    let transientErrors = 0;
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (Date.now() - started > optionNumber(this.config, 'jobPollTimeoutMs', 15 * 60_000)!) {
        throw new ProviderRequestError('image job polling timed out');
      }
      try {
        const response = await requestJson<JobEnvelope>(this.http, {
          url: endpoint(this.config.baseUrl, `/image-jobs/${encodeURIComponent(jobId)}`),
          method: 'GET',
          signal,
          timeoutMs: optionNumber(this.config, 'jobPollRequestTimeoutMs', 15_000)
        }, secretFor(this.config));
        transientErrors = 0;
        const state = normalizeState(response.status) ?? 'running';
        await lifecycle?.onState?.({ state, clientRequestId, remoteJobId: jobId });
        if (state === 'failed') {
          const message = typeof response.error === 'string' ? response.error : cleanString(response.error?.message) ?? 'image job failed';
          throw new ProviderRequestError(message);
        }
        if (state === 'succeeded') {
          const url = cleanString(response.result?.url);
          if (!url) throw new ProviderRequestError('completed image job contained no result URL');
          const image = await this.downloadResult(url, response.result?.mime, signal);
          return image;
        }
        await sleep(pollDelay(Date.now() - started), signal);
      } catch (error) {
        if (!isTransient(error)) throw error;
        transientErrors += 1;
        await sleep(Math.min(12_000, 1_500 * transientErrors), signal);
      }
    }
  }

  private async lookupJobId(clientRequestId: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const response = await requestJson<JobEnvelope>(this.http, {
        url: endpoint(this.config.baseUrl, `/image-jobs/by-client/${encodeURIComponent(clientRequestId)}`),
        method: 'GET',
        signal,
        timeoutMs: optionNumber(this.config, 'jobPollRequestTimeoutMs', 15_000)
      }, secretFor(this.config));
      return cleanString(response.jobId);
    } catch (error) {
      if (error instanceof ProviderRequestError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async uploadReference(reference: ImageJobReference, signal?: AbortSignal): Promise<string> {
    const bytes = reference.data instanceof Uint8Array ? reference.data : new Uint8Array(reference.data);
    const mime = reference.mime.split(';')[0]?.trim().toLowerCase() || 'image/png';
    if (!REFERENCE_MIMES.has(mime)) throw new ProviderRequestError(`unsupported reference image type: ${mime}`);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_REFERENCE_BYTES) throw new ProviderRequestError('reference image is empty or larger than 10MB');
    const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] ?? 'png';
    const response = await requestJson<UploadEnvelope>(this.http, {
      url: endpoint(this.config.baseUrl, '/media/upload'),
      method: 'POST',
      signal,
      timeoutMs: optionNumber(this.config, 'uploadTimeoutMs', 20_000),
      body: {
        filename: `reference.${extension}`,
        content_type: mime,
        data: toBase64(bytes)
      }
    }, secretFor(this.config));
    const url = typeof response === 'string' ? response.trim() : cleanString(response.url);
    if (!url || !isHttps(url)) throw new ProviderRequestError('reference upload returned no HTTPS URL');
    return url;
  }

  private async downloadResult(url: string, fallbackMime?: string, signal?: AbortSignal): Promise<GeneratedImage> {
    const sameOrigin = originOf(url) !== null && originOf(url) === originOf(this.config.baseUrl);
    if (sameOrigin) {
      const response = await requestBytes(this.http, { url, method: 'GET', signal, timeoutMs: optionNumber(this.config, 'jobDownloadTimeoutMs', 60_000) }, secretFor(this.config));
      if (!response.body.byteLength) throw new ProviderRequestError('downloaded image was empty');
      return { data: response.body, mime: cleanMime(response.mime, fallbackMime ?? 'image/png') };
    }
    const response = await this.http.request({ url, method: 'GET', signal, timeoutMs: optionNumber(this.config, 'jobDownloadTimeoutMs', 60_000) });
    if (response.status < 200 || response.status >= 300) throw new ProviderRequestError(`downloading generated image failed (${response.status})`, response.status);
    if (!response.body.byteLength) throw new ProviderRequestError('downloaded image was empty');
    return { data: response.body, mime: cleanMime(headerValue(response.headers, 'content-type'), fallbackMime ?? 'image/png') };
  }
}

function secretFor(config: ProviderConfig): SecretHeader {
  const header = optionString(config, 'secretHeader');
  const prefix = optionString(config, 'secretPrefix');
  return { ref: config.secretRef, header: header ?? 'Authorization', prefix: prefix ?? 'Bearer ' };
}

function optionString(config: ProviderConfig, key: string): string | undefined {
  const value = config.options[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionNumber(config: ProviderConfig, key: string, fallback: number): number {
  const value = config.options[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeState(value: unknown): Exclude<ImageJobState, 'creating' | 'legacy'> | undefined {
  if (value === 'queued' || value === 'running' || value === 'materializing' || value === 'succeeded' || value === 'failed') return value;
  return undefined;
}

function isUnsupported(error: unknown): boolean {
  return error instanceof ProviderRequestError && error.status !== undefined && UNSUPPORTED_STATUS.has(error.status);
}

function isTransient(error: unknown): boolean {
  if (!(error instanceof ProviderRequestError)) return true;
  return error.status === undefined || TRANSIENT_STATUS.has(error.status);
}

function pollDelay(elapsedMs: number): number {
  if (elapsedMs < 30_000) return 2_000;
  if (elapsedMs < 120_000) return 4_000;
  return 8_000;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isHttps(value: string): boolean {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

function originOf(value: string): string | null {
  try { return new URL(value).origin; } catch { return null; }
}

function cleanMime(value: string | undefined, fallback: string): string {
  const mime = value?.split(';')[0]?.trim().toLowerCase();
  return mime && mime !== 'application/octet-stream' ? mime : fallback;
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === lower) return value;
  return undefined;
}
