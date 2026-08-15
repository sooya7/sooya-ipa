import type { ConfigRepository, ProviderConfig } from '../db/config.repo.js';
import type { HttpPlatform } from '../platform/http.js';
import type {
  ChatProvider,
  EmbeddingProvider,
  ImageProvider,
  RerankProvider,
  TTSProvider
} from './types.js';
import {
  BuiltinChatProvider,
  BuiltinEmbeddingProvider,
  BuiltinRerankProvider
} from './builtin.js';
import { BuiltinImageProvider, BuiltinTtsProvider } from './media-providers.js';

export interface ConfiguredProviders {
  chat: ChatProvider | null;
  /** Independent vision slot; falls back to the chat model when unconfigured. */
  vision: ChatProvider | null;
  /** Independent summary slot; falls back to the chat model when unconfigured. */
  summary: ChatProvider | null;
  /** Independent director slot (media/voice directors); falls back to chat. */
  director: ChatProvider | null;
  embedding: EmbeddingProvider | null;
  rerank: RerankProvider | null;
  image: ImageProvider | null;
  tts: TTSProvider | null;
}

/**
 * Compatibility normalization for callers that consume the returned provider
 * name. BuiltinImageProvider now resolves `options.protocol` itself via
 * imageProtocol(), so routing correctness no longer depends on this copy; it
 * only keeps the saved/admin-facing provider identity stable.
 */
function runtimeImageConfig(config: ProviderConfig): ProviderConfig {
  const protocol = typeof config.options.protocol === 'string' ? config.options.protocol.trim() : '';
  if (!protocol || protocol === config.provider) return config;
  if (protocol === 'anuma-input-images') return { ...config, provider: protocol };
  return config;
}

/**
 * Public provider factory used by the native runtime and NativeLocalCore probes.
 *
 * Chat/embedding/rerank keep the stable builtin implementations. Image/TTS are
 * dispatched through protocol-aware adapters so the saved provider value
 * actually controls endpoint, headers, payload and response parsing.
 */
export async function createConfiguredProviders(
  http: HttpPlatform,
  config: ConfigRepository
): Promise<ConfiguredProviders> {
  const [chat, vision, summary, director, embedding, rerank, image, tts] = await Promise.all([
    config.getProvider('chat'),
    config.getProvider('vision'),
    config.getProvider('summary'),
    config.getProvider('director'),
    config.getProvider('embedding'),
    config.getProvider('rerank'),
    config.getProvider('image'),
    config.getProvider('tts')
  ]);

  const chatProvider = chat && chat.enabled ? new BuiltinChatProvider(http, chat) : null;
  return {
    chat: chatProvider,
    vision: vision && vision.enabled ? new BuiltinChatProvider(http, vision) : chatProvider,
    summary: summary && summary.enabled ? new BuiltinChatProvider(http, summary) : chatProvider,
    director: director && director.enabled ? new BuiltinChatProvider(http, director) : chatProvider,
    embedding: embedding && embedding.enabled ? new BuiltinEmbeddingProvider(http, embedding) : null,
    rerank: rerank && rerank.enabled ? new BuiltinRerankProvider(http, rerank) : null,
    image: image && image.enabled ? new BuiltinImageProvider(http, runtimeImageConfig(image)) : null,
    tts: tts && tts.enabled ? new BuiltinTtsProvider(http, tts) : null
  };
}
