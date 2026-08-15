import type { StickerRepo } from '../db/sticker.repo.js';
import type { MediaPlatform } from '../platform/media.js';
import type { ImageProvider, TTSProvider } from '../providers/types.js';

export interface ReplyFeatureRuntime {
  media: MediaPlatform;
  stickers?: StickerRepo;
  imageProvider?: () => Promise<ImageProvider | null>;
  ttsProvider?: () => Promise<TTSProvider | null>;
  referenceImages?: (hint?: string) => Promise<Array<{ data: Uint8Array; mime: string }>>;
}

let installed: ReplyFeatureRuntime | null = null;

/** Native boot installs platform-owned media/provider adapters here. The core
 * reply coordinator consumes this seam without importing Capacitor or Swift. */
export function installReplyFeatureRuntime(runtime: ReplyFeatureRuntime | null): void {
  installed = runtime;
}

export function currentReplyFeatureRuntime(): ReplyFeatureRuntime | null {
  return installed;
}
