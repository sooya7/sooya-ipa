import type { ProviderConfig } from '../db/config.repo.js';
import type { HttpPlatform } from '../platform/http.js';
import type {
  BinaryData,
  GeneratedImage,
  HealthStatus,
  ImagePipelineStage,
  ImageProvider,
  SynthesizedAudio,
  TTSOptions,
  TTSProvider
} from './types.js';
import {
  ImageEditUnsupportedError,
  ImagePipelineError,
  ImageReferenceError,
  ProviderNotConfiguredError,
  ProviderRequestError
} from './types.js';
import {
  endpoint,
  fromBase64,
  isRecord,
  requestBytes,
  requestJson,
  toBase64,
  type SecretHeader
} from './http-json.js';

const IMAGE_REFERENCE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const IMAGE_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
const DIAGNOSTIC_KEY_LIMIT = 12;

const FORMAT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg',
  ogg_opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac'
};

function secretFor(config: ProviderConfig, override?: Partial<SecretHeader>): SecretHeader {
  const header = stringOption(config, 'secretHeader');
  const prefix = stringOption(config, 'secretPrefix');
  return {
    ref: config.secretRef,
    header: override?.header ?? header ?? 'Authorization',
    prefix: override?.prefix ?? prefix ?? 'Bearer '
  };
}

function stringOption(config: ProviderConfig, key: string, fallback?: string): string | undefined {
  const value = config.options[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numberOption(config: ProviderConfig, key: string, fallback?: number): number | undefined {
  const value = config.options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanOption(config: ProviderConfig, key: string, fallback?: boolean): boolean | undefined {
  const value = config.options[key];
  return typeof value === 'boolean' ? value : fallback;
}

function cleanMime(value: string | undefined, fallback: string): string {
  return value?.split(';')[0]?.trim() || fallback;
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLocaleLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLocaleLowerCase() === lower) return value;
  return undefined;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function requestId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `sooya-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function diagnosticKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).slice(0, DIAGNOSTIC_KEY_LIMIT).map((key) => key.slice(0, 48));
}

function diagnosticUrlScheme(value: string): string | null {
  try {
    const protocol = new URL(value).protocol.toLocaleLowerCase();
    if (protocol === 'https:') return 'https';
    if (protocol === 'http:') return 'http';
    return protocol.replace(/:$/u, '') || 'other';
  } catch {
    return null;
  }
}

function anumaUploadHttpsUrl(response: unknown): string | null {
  const candidate = typeof response === 'string'
    ? response.trim()
    : isRecord(response) && typeof response.url === 'string'
      ? response.url.trim()
      : '';
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Privacy-safe description of an upload response. It deliberately reports
 * only object key names, candidate field paths and URL schemes. It never
 * includes string values, hosts, paths, query strings, API keys or base64.
 */
export function describeAnumaUploadResponse(response: unknown): string {
  if (!isRecord(response)) {
    if (Array.isArray(response)) return `type=array; length=${response.length}`;
    if (response === null) return 'type=null';
    if (typeof response === 'string') {
      const scheme = diagnosticUrlScheme(response.trim());
      return `type=string; length=${response.length}${scheme ? `; scheme=${scheme}` : ''}`;
    }
    return `type=${typeof response}`;
  }

  const nested: string[] = [];
  const urls: string[] = [];
  const seen = new Set<object>();

  const visit = (record: Record<string, unknown>, path: string, depth: number): void => {
    if (seen.has(record) || depth > 2) return;
    seen.add(record);
    for (const [rawKey, value] of Object.entries(record).slice(0, DIAGNOSTIC_KEY_LIMIT)) {
      const key = rawKey.slice(0, 48);
      const field = `${path}${key}`;
      if (typeof value === 'string') {
        const scheme = diagnosticUrlScheme(value);
        if (scheme) urls.push(`${field}:${scheme}`);
        continue;
      }
      if (isRecord(value)) {
        nested.push(`${field}=[${diagnosticKeys(value).join(',') || 'none'}]`);
        visit(value, `${field}.`, depth + 1);
        continue;
      }
      if (Array.isArray(value) && depth < 2) {
        const firstRecord = value.find((item): item is Record<string, unknown> => isRecord(item));
        if (firstRecord) {
          nested.push(`${field}[]=[${diagnosticKeys(firstRecord).join(',') || 'none'}]`);
          visit(firstRecord, `${field}[].`, depth + 1);
        }
      }
    }
  };

  visit(response, '', 0);
  const parts = [`keys=[${diagnosticKeys(response).join(',') || 'none'}]`];
  if (nested.length) parts.push(`nested=${nested.slice(0, 8).join('|')}`);
  if (urls.length) parts.push(`urls=[${urls.slice(0, 8).join(',')}]`);
  else parts.push('urls=[none]');
  return parts.join('; ');
}

type ImageApiResponse = { data?: Array<{ b64_json?: string; url?: string; mime_type?: string }> };
type ImageApiItem = NonNullable<ImageApiResponse['data']>[number];

/**
 * Single source of truth for the image wire protocol. Persisted configs may
 * keep the vendor identity in `provider` and the wire protocol in
 * `options.protocol` (for example `provider: 'anuma'` +
 * `options.protocol: 'anuma-input-images'`); every branch in this provider
 * must resolve through this function so no caller can route differently.
 */
export function imageProtocol(config: ProviderConfig): string {
  const protocol = typeof config.options.protocol === 'string' ? config.options.protocol.trim() : '';
  return protocol || config.provider;
}

function pipelineError(stage: ImagePipelineStage, error: unknown): ImagePipelineError {
  if (error instanceof ImagePipelineError) return error;
  const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  const status = error instanceof ProviderRequestError ? error.status : undefined;
  return new ImagePipelineError(stage, message, status);
}

export class BuiltinImageProvider implements ImageProvider {
  readonly name: string;
  readonly configured: boolean;

  constructor(private readonly http: HttpPlatform, private readonly config: ProviderConfig) {
    this.name = imageProtocol(config);
    this.configured = Boolean(config.baseUrl && config.model && config.secretRef);
  }

  async generate(
    prompt: string,
    options: {
      size?: string;
      signal?: AbortSignal;
      referenceImages?: Array<{ data: BinaryData; mime: string }>;
    } = {}
  ): Promise<GeneratedImage> {
    if (!this.configured) throw new ProviderNotConfiguredError('image');
    if (!prompt.trim()) throw new ProviderRequestError('image generation requires a non-empty prompt');

    if (imageProtocol(this.config) === 'anuma-input-images') {
      return await this.generateAnuma(prompt, options);
    }

    let response: ImageApiResponse;
    try {
      response = await requestJson<ImageApiResponse>(
        this.http,
        {
          url: endpoint(this.config.baseUrl, '/v1/images/generations'),
          method: 'POST',
          signal: options.signal,
          timeoutMs: numberOption(this.config, 'timeoutMs'),
          body: {
            model: this.config.model,
            prompt,
            size: options.size ?? stringOption(this.config, 'size', '1024x1024'),
            n: 1
          }
        },
        secretFor(this.config)
      );
    } catch (error) {
      throw pipelineError('generation', error);
    }
    return await this.materializeOpenAICompatible(response, options.signal);
  }

  async edit(
    prompt: string,
    image: BinaryData,
    options: { mime?: string; signal?: AbortSignal } = {}
  ): Promise<GeneratedImage> {
    if (!this.configured) throw new ProviderNotConfiguredError('image');
    if (imageProtocol(this.config) !== 'anuma-input-images') {
      throw new ImageEditUnsupportedError('configured image provider does not expose a safe edit endpoint');
    }
    return await this.generateAnuma(prompt, {
      signal: options.signal,
      referenceImages: [{ data: image, mime: options.mime ?? 'image/png' }]
    });
  }

  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'image',
      configured: this.configured,
      ok: this.configured,
      provider: this.name,
      model: this.config.model || undefined,
      detail: this.configured ? 'configured' : 'not configured',
      checkedAt: new Date().toISOString()
    };
  }

  private async generateAnuma(
    prompt: string,
    options: {
      size?: string;
      signal?: AbortSignal;
      referenceImages?: Array<{ data: BinaryData; mime: string }>;
    }
  ): Promise<GeneratedImage> {
    const references = options.referenceImages ?? [];
    const reference = references[0];
    const inputImages: string[] = [];
    if (reference) {
      inputImages.push(await this.uploadAnumaReference(reference.data, reference.mime, options.signal));
    }

    // Server-verified Anuma /images/generations contract: model, prompt, n,
    // and input_images only. Never send size/quality/style/response_format.
    const body: Record<string, unknown> = {
      model: this.config.model,
      prompt,
      n: 1
    };
    if (inputImages.length) body.input_images = inputImages;

    let response: ImageApiResponse;
    try {
      response = await requestJson<ImageApiResponse>(
        this.http,
        {
          url: endpoint(this.config.baseUrl, '/images/generations'),
          method: 'POST',
          signal: options.signal,
          timeoutMs: numberOption(this.config, 'timeoutMs'),
          body
        },
        secretFor(this.config)
      );
    } catch (error) {
      throw pipelineError('generation', error);
    }
    return await this.materializeOpenAICompatible(response, options.signal);
  }

  private async uploadAnumaReference(data: BinaryData, mimeInput: string, signal?: AbortSignal): Promise<string> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const mime = cleanMime(mimeInput, 'image/png').toLocaleLowerCase();
    if (!IMAGE_REFERENCE_MIMES.has(mime)) {
      throw pipelineError('reference_upload', new ImageReferenceError(
        'reference_image_type_unsupported',
        '参考图格式不受支持',
        `unsupported reference image type: ${mime}`
      ));
    }
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_REFERENCE_MAX_BYTES) {
      throw pipelineError('reference_upload', new ImageReferenceError(
        'reference_image_too_large',
        '参考图为空或超过 10MB',
        `reference image size is ${bytes.byteLength} bytes`
      ));
    }

    const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] ?? 'png';
    let response: unknown;
    try {
      response = await requestJson<unknown>(
        this.http,
        {
          url: endpoint(this.config.baseUrl, '/media/upload'),
          method: 'POST',
          signal,
          timeoutMs: numberOption(this.config, 'uploadTimeoutMs', 20_000),
          body: {
            filename: `reference.${extension}`,
            content_type: mime,
            data: toBase64(bytes)
          }
        },
        secretFor(this.config)
      );
    } catch (error) {
      throw pipelineError('reference_upload', error);
    }

    const returned = anumaUploadHttpsUrl(response);
    if (!returned) {
      const diagnostic = describeAnumaUploadResponse(response);
      throw pipelineError('reference_upload', new ImageReferenceError(
        'reference_upload_invalid_response',
        '参考图上传返回无效，请稍后重试',
        `anuma reference upload did not return an HTTPS URL (${diagnostic})`
      ));
    }
    return returned;
  }

  /** Parse and materialize an OpenAI-compatible image response. */
  private async materializeOpenAICompatible(response: ImageApiResponse, signal?: AbortSignal): Promise<GeneratedImage> {
    let first: ImageApiItem;
    try {
      first = this.firstImage(response);
      if (first.b64_json) {
        const data = fromBase64(first.b64_json);
        if (!data.byteLength) throw new ProviderRequestError('image response was empty');
        return { data, mime: first.mime_type ?? 'image/png' };
      }
    } catch (error) {
      throw pipelineError('generation', error);
    }

    try {
      return await this.downloadGeneratedImage(first.url!, first.mime_type, signal);
    } catch (error) {
      throw pipelineError('download', error);
    }
  }

  private firstImage(response: ImageApiResponse): ImageApiItem {
    const first = response.data?.[0];
    if (!first) throw new ProviderRequestError('image response contained no data');
    if (!first.b64_json && !first.url) throw new ProviderRequestError('image response contained neither b64_json nor url');
    return first;
  }

  private async downloadGeneratedImage(url: string, fallbackMime: string | undefined, signal?: AbortSignal): Promise<GeneratedImage> {
    const downloaded = await this.http.request({
      url,
      method: 'GET',
      signal,
      timeoutMs: numberOption(this.config, 'timeoutMs')
    });
    if (downloaded.status < 200 || downloaded.status >= 300) {
      throw new ProviderRequestError(`downloading generated image failed (${downloaded.status})`, downloaded.status);
    }
    if (!downloaded.body.byteLength) throw new ProviderRequestError('downloaded image was empty');
    return {
      data: downloaded.body,
      mime: cleanMime(headerValue(downloaded.headers, 'content-type'), fallbackMime ?? 'image/png')
    };
  }
}

export class BuiltinTtsProvider implements TTSProvider {
  readonly name: string;
  readonly configured: boolean;

  constructor(private readonly http: HttpPlatform, private readonly config: ProviderConfig) {
    this.name = config.provider;
    this.configured = Boolean(config.baseUrl && config.model && config.secretRef);
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<SynthesizedAudio> {
    if (!this.configured) throw new ProviderNotConfiguredError('tts');
    const trimmed = text.trim();
    if (!trimmed) throw new ProviderRequestError('tts requires non-empty text');

    if (this.config.provider === 'fish') return await this.synthesizeFish(trimmed, options);
    if (this.config.provider === 'volc-tts') return await this.synthesizeVolc(trimmed, options);
    return await this.synthesizeOpenAI(trimmed, options);
  }

  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'tts',
      configured: this.configured,
      ok: this.configured,
      provider: this.name,
      model: this.config.model || undefined,
      detail: this.configured ? 'configured' : 'not configured',
      checkedAt: new Date().toISOString()
    };
  }

  private async synthesizeOpenAI(text: string, options: TTSOptions): Promise<SynthesizedAudio> {
    const format = stringOption(this.config, 'format', 'mp3')!;
    const speed = options.speed ?? numberOption(this.config, 'speed', 1);
    const body: Record<string, unknown> = {
      model: this.config.model,
      input: text,
      voice: options.voice ?? stringOption(this.config, 'voice', 'alloy'),
      response_format: format
    };
    if (typeof speed === 'number') body.speed = speed;
    if (options.instructions && stringOption(this.config, 'instructionMode', 'on') !== 'off') body.instructions = options.instructions;
    if (stringOption(this.config, 'emotionMode') === 'enum') {
      const emotion = options.apiEmotion ?? options.emotion;
      if (emotion) {
        body.emotion = emotion;
        body.emotion_scale = numberOption(this.config, 'emotionScale', 4);
      }
    }

    const response = await requestBytes(
      this.http,
      {
        url: endpoint(this.config.baseUrl, '/v1/audio/speech'),
        method: 'POST',
        signal: options.signal,
        timeoutMs: numberOption(this.config, 'timeoutMs'),
        body
      },
      secretFor(this.config)
    );
    return {
      data: response.body,
      mime: cleanMime(response.mime, FORMAT_MIME[format] ?? 'application/octet-stream'),
      format
    };
  }

  private async synthesizeFish(text: string, options: TTSOptions): Promise<SynthesizedAudio> {
    const format = stringOption(this.config, 'format', 'mp3')!;
    const speed = clamp(options.speed ?? numberOption(this.config, 'prosodySpeed', numberOption(this.config, 'speed', 1)) ?? 1, 0.8, 1.2);
    const body: Record<string, unknown> = {
      text,
      temperature: numberOption(this.config, 'temperature', 0.65),
      top_p: numberOption(this.config, 'topP', 0.7),
      prosody: {
        speed,
        volume: numberOption(this.config, 'prosodyVolume', 0),
        normalize_loudness: booleanOption(this.config, 'normalizeLoudness', true)
      },
      chunk_length: numberOption(this.config, 'chunkLength', 200),
      normalize: booleanOption(this.config, 'normalize', true),
      format,
      sample_rate: 44_100,
      mp3_bitrate: 128,
      latency: stringOption(this.config, 'latency', 'balanced'),
      repetition_penalty: numberOption(this.config, 'repetitionPenalty', 1.2),
      condition_on_previous_chunks: booleanOption(this.config, 'conditionOnPreviousChunks', true)
    };

    const referenceId =
      options.voice ??
      stringOption(this.config, 'referenceId') ??
      (() => {
        const voice = stringOption(this.config, 'voice');
        return voice && voice !== 'alloy' ? voice : undefined;
      })();
    if (referenceId) body.reference_id = referenceId;

    const response = await requestBytes(
      this.http,
      {
        url: endpoint(this.config.baseUrl, '/v1/tts'),
        method: 'POST',
        signal: options.signal,
        timeoutMs: numberOption(this.config, 'timeoutMs'),
        headers: { model: this.config.model },
        body
      },
      secretFor(this.config)
    );
    return {
      data: response.body,
      mime: cleanMime(response.mime, FORMAT_MIME[format] ?? 'application/octet-stream'),
      format
    };
  }

  private async synthesizeVolc(text: string, options: TTSOptions): Promise<SynthesizedAudio> {
    const format = stringOption(this.config, 'format', 'mp3')!;
    const voice = options.voice ?? stringOption(this.config, 'voice');
    const resourceId = stringOption(this.config, 'resourceId', 'seed-tts-2.0');
    if (!voice) throw new ProviderNotConfiguredError('tts');
    if (!resourceId) throw new ProviderNotConfiguredError('tts');

    const audioParams: Record<string, unknown> = {
      format: format === 'opus' ? 'ogg_opus' : format,
      sample_rate: 24_000
    };
    if (stringOption(this.config, 'emotionMode') === 'enum') {
      const emotion = options.apiEmotion ?? options.emotion;
      if (emotion) {
        audioParams.emotion = emotion;
        audioParams.emotion_scale = numberOption(this.config, 'emotionScale', 4);
      }
    }

    const reqParams: Record<string, unknown> = {
      text,
      speaker: voice,
      audio_params: audioParams
    };
    if (options.instructions && stringOption(this.config, 'instructionMode', 'on') !== 'off') {
      reqParams.additions = JSON.stringify({ context_texts: [options.instructions] });
    }

    const response = await requestBytes(
      this.http,
      {
        url: this.config.baseUrl,
        method: 'POST',
        signal: options.signal,
        timeoutMs: numberOption(this.config, 'timeoutMs'),
        headers: {
          'X-Api-Resource-Id': resourceId,
          'X-Api-Request-Id': requestId()
        },
        body: {
          user: { uid: 'sooya' },
          req_params: reqParams
        }
      },
      secretFor(this.config, { header: 'X-Api-Key', prefix: '' })
    );

    const data = decodeVolcStream(new TextDecoder().decode(response.body));
    return {
      data,
      mime: FORMAT_MIME[format] ?? 'application/octet-stream',
      format
    };
  }
}

export function decodeVolcStream(raw: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let sawLine = false;
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim().replace(/^data:\s*/u, '');
    if (!trimmed) continue;
    sawLine = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ProviderRequestError('tts returned a non-JSON line in the audio stream');
    }
    if (!isRecord(parsed)) throw new ProviderRequestError('tts returned an invalid JSON line');
    const code = typeof parsed.code === 'number' ? parsed.code : undefined;
    if (code !== undefined && code !== 0 && code !== 20_000_000) {
      throw new ProviderRequestError(`tts failed: ${code} ${typeof parsed.message === 'string' ? parsed.message : ''}`.trim());
    }
    if (typeof parsed.data === 'string' && parsed.data) chunks.push(fromBase64(parsed.data));
  }
  if (!sawLine) throw new ProviderRequestError('tts returned an empty stream');
  if (!chunks.length) throw new ProviderRequestError('tts stream carried no audio');
  return concatBytes(chunks);
}
