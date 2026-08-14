/**
 * Single source of default model configuration, aligned 1:1 with the server's
 * config/schema.ts defaults. GET /api/admin/models returns these even when no
 * row exists yet, so a fresh install shows a complete (but disabled —
 * provider defaults to 'none') form instead of a wall of empty inputs.
 * Defaults are NOT "enabled": provider 'none' never triggers a real call.
 */

export type ModelCapabilitySlot = 'chat' | 'vision' | 'summary' | 'director' | 'embedding' | 'image' | 'tts' | 'rerank';

export const MODEL_CAPABILITY_SLOTS: readonly ModelCapabilitySlot[] = ['chat', 'vision', 'summary', 'director', 'embedding', 'image', 'tts', 'rerank'];

export const MODEL_DEFAULTS: Record<ModelCapabilitySlot, Record<string, unknown>> = {
  chat: {
    provider: 'none', baseUrl: '', model: '',
    timeoutMs: 60_000, maxTokens: 1024, temperature: 0.8, contextWindow: 32_000,
    supportsVision: false, supportsTools: false, supportsStreaming: true, maxRetries: 2
  },
  vision: {
    provider: 'none', baseUrl: '', model: '',
    timeoutMs: 60_000, maxTokens: 1024, temperature: 0.8, contextWindow: 32_000,
    supportsVision: true, supportsTools: false, supportsStreaming: true, maxRetries: 2
  },
  summary: {
    provider: 'none', baseUrl: '', model: '',
    timeoutMs: 60_000, maxTokens: 1024, temperature: 0.8, contextWindow: 32_000,
    supportsVision: false, supportsTools: false, supportsStreaming: true, maxRetries: 2
  },
  director: {
    provider: 'none', baseUrl: '', model: '',
    timeoutMs: 60_000, maxTokens: 1024, temperature: 0.8, contextWindow: 32_000,
    supportsVision: false, supportsTools: false, supportsStreaming: true, maxRetries: 2
  },
  embedding: {
    provider: 'none', baseUrl: '', model: '',
    timeoutMs: 30_000, maxRetries: 2
  },
  image: {
    provider: 'none', baseUrl: '', model: '',
    size: '1024x1024', timeoutMs: 120_000, maxRetries: 1, uploadTimeoutMs: 20_000, uploadMaxRetries: 2
  },
  tts: {
    provider: 'none', baseUrl: '', model: '',
    voice: 'alloy', format: 'mp3', speed: 1, timeoutMs: 90_000, maxRetries: 1,
    emotionMode: 'auto', emotionScale: 4, resourceId: 'seed-tts-2.0',
    instructionMode: 'on', expressive: true, emotionIntensity: 0.75,
    temperature: 0.65, topP: 0.7, prosodySpeed: 1, prosodyVolume: 0, normalizeLoudness: true,
    normalize: true, chunkLength: 200, latency: 'balanced', repetitionPenalty: 1.2, conditionOnPreviousChunks: true
  },
  rerank: {
    provider: 'none', baseUrl: '', model: '',
    timeoutMs: 10_000, maxRetries: 1, candidateLimit: 16
  }
};

/** Chat-like slots that fall back to the chat model when unconfigured. */
export const CHAT_FALLBACK_SLOTS: readonly ModelCapabilitySlot[] = ['vision', 'summary', 'director'];
