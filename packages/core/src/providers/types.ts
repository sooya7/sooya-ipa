/** Portable binary values accepted by core adapters. */
export type BinaryData = Uint8Array | ArrayBuffer;

export interface HealthStatus {
  capability: string;
  configured: boolean;
  ok: boolean;
  provider: string;
  model?: string;
  detail?: string;
  checkedAt: string;
}

export interface ChatTextPart { type: 'text'; text: string; }
export interface ChatImagePart { type: 'image'; data: BinaryData; mime: string; }
export type ChatContentPart = ChatTextPart | ChatImagePart;

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: ChatContentPart[];
}

export interface ChatToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentsError?: string;
}

export interface ChatToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type ModelTurn =
  | ChatTurn
  | { role: 'assistant_tool_call'; calls: ChatToolCall[] }
  | { role: 'tool_result'; callId: string; name: string; content: string; isError?: boolean };

export interface ChatRequest {
  system?: string;
  messages: ModelTurn[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  jsonMode?: boolean;
  webSearch?: {
    enabled: true;
    userLocation?: { countryCode?: string; region?: string; city?: string };
  };
  tools?: ChatToolDefinition[];
  toolChoice?: 'auto' | 'none' | { name: string };
}

export interface ChatChunk {
  delta: string;
  /** Incremental tool-call data emitted by streaming providers. */
  toolCall?: { index: number; id?: string; name?: string; argumentsDelta?: string };
  finishReason?: string;
}

export interface ChatResult {
  text: string;
  toolCalls?: ChatToolCall[];
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  model: string;
  jsonModeDegraded?: boolean;
  webSearch?: {
    used: boolean;
    callCount: number;
    citations: Array<{ title: string; url: string }>;
  };
}

export interface ChatProvider {
  readonly name: string;
  readonly configured: boolean;
  readonly supportsTools?: boolean;
  complete(request: ChatRequest): Promise<ChatResult>;
  stream(request: ChatRequest, onChunk: (chunk: ChatChunk) => void): Promise<ChatResult>;
  inspectHealth(): Promise<HealthStatus>;
}

export interface EmbeddingResult { vectors: number[][]; model: string; dimensions: number; }
export interface EmbeddingProvider {
  readonly name: string;
  readonly configured: boolean;
  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult>;
  inspectHealth(): Promise<HealthStatus>;
}

export interface RerankMatch { index: number; score: number; }
export interface RerankProvider {
  readonly name: string;
  readonly configured: boolean;
  rerank(query: string, documents: string[], signal?: AbortSignal): Promise<RerankMatch[]>;
  inspectHealth(): Promise<HealthStatus>;
}

export interface GeneratedImage {
  data: BinaryData;
  mime: string;
  width?: number;
  height?: number;
}

export interface ImageProvider {
  readonly name: string;
  readonly configured: boolean;
  generate(prompt: string, options?: {
    size?: string;
    signal?: AbortSignal;
    referenceImages?: Array<{ data: BinaryData; mime: string }>;
  }): Promise<GeneratedImage>;
  edit(prompt: string, image: BinaryData, options?: { mime?: string; signal?: AbortSignal }): Promise<GeneratedImage>;
  inspectHealth(): Promise<HealthStatus>;
}

export interface SynthesizedAudio {
  data: BinaryData;
  mime: string;
  format: string;
  durationSec?: number;
}

export interface TTSOptions {
  voice?: string;
  signal?: AbortSignal;
  instructions?: string;
  speed?: number;
  emotion?: string;
  apiEmotion?: string;
}

export interface TTSProvider {
  readonly name: string;
  readonly configured: boolean;
  synthesize(text: string, options?: TTSOptions): Promise<SynthesizedAudio>;
  inspectHealth(): Promise<HealthStatus>;
}

export class ProviderNotConfiguredError extends Error {
  override name = 'ProviderNotConfiguredError';
  constructor(capability: string) { super(`capability "${capability}" is not configured`); }
}

export class ProviderRequestError extends Error {
  override name = 'ProviderRequestError';
  constructor(message: string, readonly status?: number) { super(message); }
}

export class ImageEditUnsupportedError extends Error {
  override name = 'ImageEditUnsupportedError';
}

export type ImageReferenceErrorCode =
  | 'too_many_reference_images'
  | 'reference_image_too_large'
  | 'reference_image_type_unsupported'
  | 'reference_upload_failed'
  | 'reference_upload_invalid_response'
  | 'reference_generation_failed';

export class ImageReferenceError extends Error {
  override name = 'ImageReferenceError';
  constructor(
    readonly code: ImageReferenceErrorCode,
    readonly publicMessage: string,
    message: string
  ) { super(message); }
}
