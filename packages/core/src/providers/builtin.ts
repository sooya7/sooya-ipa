// The single createConfiguredProviders factory lives in provider-factory.ts.
// It was previously duplicated here (without the anuma protocol normalization
// and the summary/director slots), which silently left LocalCore's own runtime
// on the stale copy.
import type { ProviderConfig } from '../db/config.repo.js';
import type { HttpPlatform } from '../platform/http.js';
import type {
  ChatContentPart, ChatChunk, ChatProvider, ChatRequest, ChatResult, ChatToolCall, EmbeddingProvider, EmbeddingResult,
  HealthStatus, RerankProvider, RerankMatch
} from './types.js';
import { ProviderNotConfiguredError, ProviderRequestError } from './types.js';
import { endpoint, healthStatus, isRecord, requestJson, requestSse, type SecretHeader, toBase64 } from './http-json.js';
import { isJsonModeRejection, withJsonInstruction } from '../util/json-extract.js';

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

/**
 * Observed, not configured: flipped off the first time an endpoint refuses
 * `response_format` (server parity). Keyed by provider identity because IPA
 * factory calls construct fresh provider instances per resolve, so an
 * instance field would forget the lesson immediately.
 */
const jsonModeSupportByEndpoint = new Map<string, boolean>();

export class BuiltinChatProvider extends BuiltinProvider implements ChatProvider {
  readonly name = this.config.provider;
  readonly configured = Boolean(this.config.baseUrl && this.config.model && this.config.secretRef);
  readonly supportsTools = this.config.options.tools !== false;

  private endpointKey(): string {
    return `${this.config.provider}|${this.config.baseUrl}|${this.config.model}`;
  }

  private get jsonModeSupported(): boolean {
    return jsonModeSupportByEndpoint.get(this.endpointKey()) ?? true;
  }

  private set jsonModeSupported(value: boolean) {
    jsonModeSupportByEndpoint.set(this.endpointKey(), value);
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    if (!this.configured) throw new ProviderNotConfiguredError('chat');
    const run = (): Promise<ChatResult> => this.config.provider === 'anthropic' ? this.anthropic(request) : this.openAiCompatible(request);
    if (request.jsonMode !== true) return await run();
    // Config declares JSON mode the same way config declares vision: statically.
    // An endpoint that 4xx's on `response_format` used to fail the whole call,
    // which callers then swallowed as a fallback/skip -- a silent downgrade
    // with no visible symptom. Retry once under a prompt constraint and
    // remember the answer, so later calls skip the doomed request entirely.
    const degradedAlready = !this.jsonModeSupported;
    try {
      const result = await run();
      return degradedAlready ? { ...result, jsonModeDegraded: true } : result;
    } catch (error) {
      if (degradedAlready || !isJsonModeRejection(error)) throw error;
      this.jsonModeSupported = false;
      const result = await run();
      return { ...result, jsonModeDegraded: true };
    }
  }

  async stream(request: ChatRequest, onChunk: (chunk: ChatChunk) => void): Promise<ChatResult> {
    if (!this.configured) throw new ProviderNotConfiguredError('chat');
    return this.config.provider === 'anthropic'
      ? await this.streamAnthropic(request, onChunk)
      : await this.streamOpenAiCompatible(request, onChunk);
  }

  async inspectHealth(): Promise<HealthStatus> { return this.health('chat'); }

  private async openAiCompatible(request: ChatRequest): Promise<ChatResult> {
    // `jsonMode` is what the caller needs, `response_format` is only one way
    // to get it. When the endpoint has rejected that field once, the
    // constraint moves into the prompt instead of being dropped on the floor.
    const nativeJson = request.jsonMode === true && this.jsonModeSupported;
    const effective = request.jsonMode === true && !nativeJson
      ? { ...request, system: withJsonInstruction(request.system) }
      : request;
    const response = await requestJson<Record<string, unknown>>(this.http, {
      url: endpoint(this.config.baseUrl, '/v1/chat/completions'), method: 'POST', signal: effective.signal,
      body: {
        model: this.model,
        messages: toOpenAiMessages(effective),
        ...(effective.maxTokens ? { max_tokens: effective.maxTokens } : {}),
        ...(effective.temperature !== undefined ? { temperature: effective.temperature } : {}),
        ...openAiVendorBody(this.config),
        ...(nativeJson ? { response_format: { type: 'json_object' } } : {}),
        ...(effective.tools?.length ? { tools: effective.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
        ...(effective.toolChoice ? { tool_choice: effective.toolChoice === 'none' ? 'none' : effective.toolChoice === 'auto' ? 'auto' : { type: 'function', function: { name: effective.toolChoice.name } } } : {})
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

  private async streamOpenAiCompatible(request: ChatRequest, onChunk: (chunk: ChatChunk) => void): Promise<ChatResult> {
    const text: string[] = [];
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | undefined;
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;
    let model = this.model;
    const response = await requestSse(this.http, {
      url: endpoint(this.config.baseUrl, '/v1/chat/completions'), method: 'POST', signal: request.signal,
      body: {
        model: this.model,
        messages: toOpenAiMessages(request),
        stream: true,
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...openAiVendorBody(this.config),
        ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
        ...(request.toolChoice ? { tool_choice: request.toolChoice === 'none' ? 'none' : request.toolChoice === 'auto' ? 'auto' : { type: 'function', function: { name: request.toolChoice.name } } } : {})
      }
    }, (event) => {
      if (event.data.trim() === '[DONE]') return;
      const value = parseJsonRecord(event.data);
      if (!value) return;
      if (typeof value.model === 'string') model = value.model;
      const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
      if (!isRecord(choice)) {
        if (isRecord(value.usage)) usage = { promptTokens: numberValue(value.usage.prompt_tokens), completionTokens: numberValue(value.usage.completion_tokens) };
        return;
      }
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === 'string' && delta.content) { text.push(delta.content); onChunk({ delta: delta.content }); }
      if (Array.isArray(delta.tool_calls)) for (const raw of delta.tool_calls) {
        if (!isRecord(raw) || typeof raw.index !== 'number' || !Number.isInteger(raw.index)) continue;
        const index = raw.index;
        const current = toolCalls.get(index) ?? { id: '', name: '', args: '' };
        const fn = isRecord(raw.function) ? raw.function : {};
        if (typeof raw.id === 'string') current.id = raw.id;
        if (typeof fn.name === 'string') current.name = fn.name;
        const argumentsDelta = typeof fn.arguments === 'string' ? fn.arguments : '';
        current.args += argumentsDelta;
        toolCalls.set(index, current);
        onChunk({ delta: '', toolCall: { index, ...(current.id ? { id: current.id } : {}), ...(current.name ? { name: current.name } : {}), ...(argumentsDelta ? { argumentsDelta } : {}) } });
      }
      if (typeof choice.finish_reason === 'string') { finishReason = choice.finish_reason; onChunk({ delta: '', finishReason }); }
      if (isRecord(value.usage)) usage = { promptTokens: numberValue(value.usage.prompt_tokens), completionTokens: numberValue(value.usage.completion_tokens) };
    }, this.secret);
    if (response.eventCount === 0) return parseOpenAiFallback(response.rawBody, this.model, onChunk);
    return { text: text.join(''), toolCalls: finalizeToolCalls(toolCalls), finishReason, usage, model };
  }

  private async streamAnthropic(request: ChatRequest, onChunk: (chunk: ChatChunk) => void): Promise<ChatResult> {
    const text: string[] = [];
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | undefined;
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;
    let model = this.model;
    const response = await requestSse(this.http, {
      url: endpoint(this.config.baseUrl, '/v1/messages'), method: 'POST', signal: request.signal,
      headers: { 'anthropic-version': '2023-06-01' },
      body: {
        model: this.model, max_tokens: request.maxTokens ?? 2048, stream: true,
        ...(request.system ? { system: request.system } : {}), messages: toAnthropicMessages(request),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {})
      }
    }, (event) => {
      const value = parseJsonRecord(event.data);
      if (!value) return;
      if (event.event === 'message_start' && isRecord(value.message)) {
        if (typeof value.message.model === 'string') model = value.message.model;
        if (isRecord(value.message.usage)) usage = { promptTokens: numberValue(value.message.usage.input_tokens), completionTokens: numberValue(value.message.usage.output_tokens) };
      } else if (event.event === 'content_block_start' && isRecord(value.content_block)) {
        const index = typeof value.index === 'number' ? value.index : toolCalls.size;
        if (value.content_block.type === 'tool_use') toolCalls.set(index, { id: typeof value.content_block.id === 'string' ? value.content_block.id : '', name: typeof value.content_block.name === 'string' ? value.content_block.name : '', args: '' });
      } else if (event.event === 'content_block_delta' && isRecord(value.delta)) {
        const index = typeof value.index === 'number' ? value.index : 0;
        if (value.delta.type === 'text_delta' && typeof value.delta.text === 'string') { text.push(value.delta.text); onChunk({ delta: value.delta.text }); }
        if (value.delta.type === 'input_json_delta' && typeof value.delta.partial_json === 'string') {
          const current = toolCalls.get(index) ?? { id: '', name: '', args: '' };
          current.args += value.delta.partial_json; toolCalls.set(index, current);
          onChunk({ delta: '', toolCall: { index, ...(current.id ? { id: current.id } : {}), ...(current.name ? { name: current.name } : {}), argumentsDelta: value.delta.partial_json } });
        }
      } else if (event.event === 'message_delta') {
        if (isRecord(value.delta) && typeof value.delta.stop_reason === 'string') { finishReason = value.delta.stop_reason; onChunk({ delta: '', finishReason }); }
        if (isRecord(value.usage)) usage = { promptTokens: usage?.promptTokens, completionTokens: numberValue(value.usage.output_tokens) };
      }
    }, { ...this.secret, header: 'x-api-key', prefix: '' });
    if (response.eventCount === 0) return parseAnthropicFallback(response.rawBody, this.model, onChunk);
    return { text: text.join(''), toolCalls: finalizeToolCalls(toolCalls), finishReason, usage, model };
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

function openAiVendorBody(config: ProviderConfig): Record<string, unknown> {
  const thinking = config.options.thinking;
  if (isRecord(thinking) && (thinking.type === 'enabled' || thinking.type === 'disabled')) return { thinking };
  const model = config.model.trim().toLowerCase();
  // MiMo V2.5 thinking responses carry reasoning_content that must be round-tripped
  // on later turns. SOOYA's canonical chat history intentionally stores one visible
  // message stream, not a second hidden reasoning transcript, so disable MiMo thinking
  // unless the operator explicitly opts into a future reasoning-aware protocol.
  if (/^mimo[-_/.:]?v?2(?:\.5)?(?:[-_/.:]|$)/u.test(model)) return { thinking: { type: 'disabled' } };
  return {};
}

function numberValue(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }
function parseJsonRecord(value: string): Record<string, unknown> | null { try { const parsed = JSON.parse(value) as unknown; return isRecord(parsed) ? parsed : null; } catch { return null; } }
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

function finalizeToolCalls(toolCalls: Map<number, { id: string; name: string; args: string }>): ChatToolCall[] {
  return [...toolCalls.entries()].sort(([a], [b]) => a - b).flatMap(([index, call]) => {
    if (!call.name) return [];
    try {
      const parsed = JSON.parse(call.args || '{}') as unknown;
      return [{ id: call.id || `tool_${index}`, name: call.name, arguments: isRecord(parsed) ? parsed : {}, ...(isRecord(parsed) ? {} : { argumentsError: 'tool arguments must be an object' }) }];
    } catch {
      return [{ id: call.id || `tool_${index}`, name: call.name, arguments: {}, argumentsError: 'tool arguments are not valid JSON' }];
    }
  });
}

function parseOpenAiFallback(body: Uint8Array, model: string, onChunk: (chunk: ChatChunk) => void): ChatResult {
  const value = parseJsonRecord(new TextDecoder().decode(body));
  if (!value) throw new ProviderRequestError('stream response was neither SSE nor JSON');
  const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
  const text = typeof message.content === 'string' ? message.content : extractText(message.content);
  if (text) onChunk({ delta: text });
  return { text, toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.flatMap(toOpenAiToolCall) : undefined, finishReason: isRecord(choice) && typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined, model: typeof value.model === 'string' ? value.model : model };
}

function parseAnthropicFallback(body: Uint8Array, model: string, onChunk: (chunk: ChatChunk) => void): ChatResult {
  const value = parseJsonRecord(new TextDecoder().decode(body));
  if (!value) throw new ProviderRequestError('stream response was neither SSE nor JSON');
  const content = Array.isArray(value.content) ? value.content : [];
  const text = content.filter((item): item is Record<string, unknown> => isRecord(item) && item.type === 'text' && typeof item.text === 'string').map((item) => item.text as string).join('');
  if (text) onChunk({ delta: text });
  return { text, toolCalls: content.flatMap((item): ChatToolCall[] => isRecord(item) && item.type === 'tool_use' && typeof item.id === 'string' && typeof item.name === 'string' ? [{ id: item.id, name: item.name, arguments: isRecord(item.input) ? item.input : {} }] : []), finishReason: typeof value.stop_reason === 'string' ? value.stop_reason : undefined, model: typeof value.model === 'string' ? value.model : model };
}