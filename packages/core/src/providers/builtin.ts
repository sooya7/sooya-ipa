import type { ConfigRepository, ProviderConfig } from '../db/config.repo.js';
import type { HttpPlatform } from '../platform/http.js';
import type {
  BinaryData, ChatContentPart, ChatProvider, ChatRequest, ChatResult, ChatToolCall, EmbeddingProvider, EmbeddingResult,
  GeneratedImage, HealthStatus, ImageProvider, RerankProvider, RerankMatch, SynthesizedAudio, TTSOptions, TTSProvider
} from './types.js';
import { ImageEditUnsupportedError, ProviderNotConfiguredError, ProviderRequestError } from './types.js';
import { binaryBytes, endpoint, healthStatus, isRecord, requestBytes, requestJson, type SecretHeader, toBase64 } from './http-json.js';

export interface ConfiguredProviders {
  chat: ChatProvider | null;
  embedding: EmbeddingProvider | null;
  rerank: RerankProvider | null;
  image: ImageProvider | null;
  tts: TTSProvider | null;
}

export async function createConfiguredProviders(http: HttpPlatform, config: ConfigRepository): Promise<ConfiguredProviders> {
  const [chat, embedding, rerank, image, tts] = await Promise.all([
    config.getProvider('chat'), config.getProvider('embedding'), config.getProvider('rerank'), config.getProvider('image'), config.getProvider('tts')
  ]);
  return {
    chat: chat && chat.enabled ? new BuiltinChatProvider(http, chat) : null,
    embedding: embedding && embedding.enabled ? new BuiltinEmbeddingProvider(http, embedding) : null,
    rerank: rerank && rerank.enabled ? new BuiltinRerankProvider(http, rerank) : null,
    image: image && image.enabled ? new BuiltinImageProvider(http, image) : null,
    tts: tts && tts.enabled ? new BuiltinTtsProvider(http, tts) : null
  };
}

abstract class BuiltinProvider {
  protected readonly secret: SecretHeader;
  protected readonly provider: string;
  protected readonly model: string;

  constructor(protected readonly http: HttpPlatform, protected readonly config: ProviderConfig) {
    this.secret = config.secretRef ? {
      ref: config.secretRef,
      header: typeof config.options.secretHeader === 'string' ? config.options.secretHeader : 'Authorization',
      prefix: typeof config.options.secretPrefix === 'string' ? config.options.secretPrefix : 'Bearer '
    } : {};
    this.provider = config.provider;
    this.model = config.model;
  }

  protected health(capability: string): HealthStatus {
    return healthStatus(capability, this.provider, Boolean(this.config.baseUrl && this.config.model && this.config.secretRef), this.model,
      this.config.secretRef ? undefined : '未配置密钥引用');
  }
}

export class BuiltinChatProvider extends BuiltinProvider implements ChatProvider {
  readonly name = this.config.provider;
  readonly configured = Boolean(this.config.baseUrl && this.config.model && this.config.secretRef);
  readonly supportsTools = this.config.options.tools !== false;

  async complete(request: ChatRequest): Promise<ChatResult> {
    if (!this.configured) throw new ProviderNotConfiguredError('chat');
    return this.config.provider === 'anthropic' ? await this.anthropic(request) : await this.openAiCompatible(request);
  }

  async stream(request: ChatRequest, onChunk: (chunk: { delta: string }) => void): Promise<ChatResult> {
    const result = await this.complete(request);
    if (result.text) onChunk({ delta: result.text });
    return result;
  }

  async inspectHealth(): Promise<HealthStatus> { return this.health('chat'); }

  private async openAiCompatible(request: ChatRequest): Promise<ChatResult> {
    const response = await requestJson<Record<string, unknown>>(this.http, {
      url: endpoint(this.config.baseUrl, '/v1/chat/completions'), method: 'POST', signal: request.signal,
      body: {
        model: this.model,
        messages: toOpenAiMessages(request),
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
        ...(request.toolChoice ? { tool_choice: request.toolChoice === 'none' ? 'none' : request.toolChoice === 'auto' ? 'auto' : { type: 'function', function: { name: request.toolChoice.name } } } : {})
      }
    }, this.secret);
    const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls.flatMap(toOpenAiToolCall) : [];
    const usage = isRecord(response.usage) ? response.usage : {};
    return {
      text: typeof message.content === 'string' ? message.content : extractText(message.content),
      toolCalls: calls.length ? calls : undefined,
      finishReason: isRecord(choice) && typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
      usage: { promptTokens: numberValue(usage.prompt_tokens), completionTokens: numberValue(usage.completion_tokens) },
      model: typeof response.model === 'string' ? response.model : this.model
    };
  }

  private async anthropic(request: ChatRequest): Promise<ChatResult> {
    const response = await requestJson<Record<string, unknown>>(this.http, {
      url: endpoint(this.config.baseUrl, '/v1/messages'), method: 'POST', signal: request.signal,
      body: {
        model: this.model,
        max_tokens: request.maxTokens ?? 2048,
        ...(request.system ? { system: request.system } : {}),
        messages: toAnthropicMessages(request),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {})
      }
    }, { ...this.secret, header: 'x-api-key', prefix: '' });
    const content = Array.isArray(response.content) ? response.content : [];
    const calls = content.flatMap((item): ChatToolCall[] => {
      if (!isRecord(item) || item.type !== 'tool_use' || typeof item.name !== 'string' || typeof item.id !== 'string') return [];
      return [{ id: item.id, name: item.name, arguments: isRecord(item.input) ? item.input : {} }];
    });
    return {
      text: content.filter((item): item is Record<string, unknown> => isRecord(item) && item.type === 'text' && typeof item.text === 'string').map((item) => item.text as string).join(''),
      toolCalls: calls.length ? calls : undefined,
      finishReason: typeof response.stop_reason === 'string' ? response.stop_reason : undefined,
      usage: isRecord(response.usage) ? { promptTokens: numberValue(response.usage.input_tokens), completionTokens: numberValue(response.usage.output_tokens) } : undefined,
      model: typeof response.model === 'string' ? response.model : this.model
    };
  }
}

export class BuiltinEmbeddingProvider extends BuiltinProvider implements EmbeddingProvider {
  readonly name = this.config.provider;
  readonly configured = Boolean(this.config.baseUrl && this.config.model && this.config.secretRef);
  async embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    if (!this.configured) throw new ProviderNotConfiguredError('embedding');
    const response = await requestJson<Record<string, unknown>>(this.http, { url: endpoint(this.config.baseUrl, '/v1/embeddings'), method: 'POST', signal, body: { model: this.model, input: texts } }, this.secret);
    const rows = Array.isArray(response.data) ? response.data : [];
    const vectors = rows.map((row) => isRecord(row) && Array.isArray(row.embedding) ? row.embedding.filter((value): value is number => typeof value === 'number') : []);
    return { vectors, model: typeof response.model === 'string' ? response.model : this.model, dimensions: vectors[0]?.length ?? 0 };
  }
  async inspectHealth(): Promise<HealthStatus> { return this.health('embedding'); }
}

export class BuiltinRerankProvider extends BuiltinProvider implements RerankProvider {
  readonly name = this.config.provider;
  readonly configured = Boolean(this.config.baseUrl && this.config.model && this.config.secretRef);
  async rerank(query: string, documents: string[], signal?: AbortSignal): Promise<RerankMatch[]> {
    if (!this.configured) throw new ProviderNotConfiguredError('rerank');
    const response = await requestJson<Record<string, unknown>>(this.http, { url: endpoint(this.config.baseUrl, '/v1/rerank'), method: 'POST', signal, body: { model: this.model, query, documents, top_n: documents.length } }, this.secret);
    const rows = Array.isArray(response.results) ? response.results : [];
    return rows.flatMap((row) => isRecord(row) && typeof row.index === 'number' && Number.isInteger(row.index) && typeof row.relevance_score === 'number' ? [{ index: row.index, score: row.relevance_score }] : []);
  }
  async inspectHealth(): Promise<HealthStatus> { return this.health('rerank'); }
}

export class BuiltinImageProvider extends BuiltinProvider implements ImageProvider {
  readonly name = this.config.provider;
  readonly configured = Boolean(this.config.baseUrl && this.config.model && this.config.secretRef);
  async generate(prompt: string, options: { size?: string; signal?: AbortSignal; referenceImages?: Array<{ data: BinaryData; mime: string }> } = {}): Promise<GeneratedImage> {
    if (!this.configured) throw new ProviderNotConfiguredError('image');
    const response = await requestJson<Record<string, unknown>>(this.http, { url: endpoint(this.config.baseUrl, '/v1/images/generations'), method: 'POST', signal: options.signal, body: { model: this.model, prompt, ...(options.size ? { size: options.size } : {}), n: 1 } }, this.secret);
    const item = Array.isArray(response.data) ? response.data[0] : undefined;
    if (!isRecord(item)) throw new ProviderRequestError('image provider returned no image');
    if (typeof item.url === 'string') {
      const downloaded = await this.http.request({ url: item.url, method: 'GET', signal: options.signal });
      return { data: downloaded.body, mime: downloaded.headers['content-type'] ?? 'image/png' };
    }
    return { ...binaryBytes(item.b64_json, 'image/png'), mime: 'image/png' };
  }
  async edit(_prompt: string, _image: BinaryData, _options: { mime?: string; signal?: AbortSignal } = {}): Promise<GeneratedImage> {
    throw new ImageEditUnsupportedError('configured image provider does not expose a safe edit endpoint');
  }
  async inspectHealth(): Promise<HealthStatus> { return this.health('image'); }
}

export class BuiltinTtsProvider extends BuiltinProvider implements TTSProvider {
  readonly name = this.config.provider;
  readonly configured = Boolean(this.config.baseUrl && this.config.model && this.config.secretRef);
  async synthesize(text: string, options: TTSOptions = {}): Promise<SynthesizedAudio> {
    if (!this.configured) throw new ProviderNotConfiguredError('tts');
    const response = await requestBytes(this.http, { url: endpoint(this.config.baseUrl, '/v1/audio/speech'), method: 'POST', signal: options.signal, body: { model: this.model, input: text, voice: options.voice ?? 'alloy', ...(options.instructions ? { instructions: options.instructions } : {}), ...(options.speed ? { speed: options.speed } : {}), response_format: 'mp3' } }, this.secret);
    return { data: response.body, mime: response.mime || 'audio/mpeg', format: 'mp3' };
  }
  async inspectHealth(): Promise<HealthStatus> { return this.health('tts'); }
}

function numberValue(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }
function extractText(value: unknown): string { return Array.isArray(value) ? value.flatMap((item) => isRecord(item) && typeof item.text === 'string' ? [item.text] : []).join('') : ''; }

function toOpenAiMessages(request: ChatRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  for (const turn of request.messages) {
    if (turn.role === 'assistant_tool_call') messages.push({ role: 'assistant', content: null, tool_calls: turn.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
    else if (turn.role === 'tool_result') messages.push({ role: 'tool', tool_call_id: turn.callId, name: turn.name, content: turn.content });
    else messages.push({ role: turn.role, content: contentForProvider(turn.content) });
  }
  return messages;
}

function toAnthropicMessages(request: ChatRequest): Array<Record<string, unknown>> {
  return request.messages.flatMap((turn): Array<Record<string, unknown>> => {
    if (turn.role === 'assistant_tool_call') return [{ role: 'assistant', content: turn.calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })) }];
    if (turn.role === 'tool_result') return [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: turn.callId, content: turn.content, ...(turn.isError ? { is_error: true } : {}) }] }];
    if (turn.role === 'system') return [];
    return [{ role: turn.role, content: contentForProvider(turn.content) }];
  });
}

function contentForProvider(parts: ChatContentPart[]): unknown {
  if (parts.length === 1 && parts[0]?.type === 'text') return parts[0].text;
  return parts.map((part) => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image_url', image_url: { url: `data:${part.mime};base64,${toBase64(part.data)}` } });
}

function toOpenAiToolCall(value: unknown): ChatToolCall[] {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.function) || typeof value.function.name !== 'string') return [];
  const raw = typeof value.function.arguments === 'string' ? value.function.arguments : '{}';
  try {
    const parsed = JSON.parse(raw) as unknown;
    return [{ id: value.id, name: value.function.name, arguments: isRecord(parsed) ? parsed : {}, ...(isRecord(parsed) ? {} : { argumentsError: 'tool arguments must be an object' }) }];
  } catch {
    return [{ id: value.id, name: value.function.name, arguments: {}, argumentsError: 'tool arguments are not valid JSON' }];
  }
}
