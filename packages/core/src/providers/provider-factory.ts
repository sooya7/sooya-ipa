import type { ConfigRepository } from '../db/config.repo.js';
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
  embedding: EmbeddingProvider | null;
  rerank: RerankProvider | null;
  image: ImageProvider | null;
  tts: TTSProvider | null;
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
  const [chat, vision, embedding, rerank, image, tts] = await Promise.all([
    config.getProvider('chat'),
    config.getProvider('vision'),
    config.getProvider('embedding'),
    config.getProvider('rerank'),
    config.getProvider('image'),
    config.getProvider('tts')
  ]);

  const chatProvider = chat && chat.enabled ? new BuiltinChatProvider(http, chat) : null;
  return {
    chat: chatProvider,
    vision: vision && vision.enabled ? new BuiltinChatProvider(http, vision) : chatProvider,
    embedding: embedding && embedding.enabled ? new BuiltinEmbeddingProvider(http, embedding) : null,
    rerank: rerank && rerank.enabled ? new BuiltinRerankProvider(http, rerank) : null,
    image: image && image.enabled ? new BuiltinImageProvider(http, image) : null,
    tts: tts && tts.enabled ? new BuiltinTtsProvider(http, tts) : null
  };
}
