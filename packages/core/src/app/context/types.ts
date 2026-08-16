import type { ChatContentPart } from '../../providers/types.js';

/**
 * Single conversation-side view of the local world. Producers (Life V2,
 * Location Runtime and Weather) own these values; ContextBuilder only
 * consumes this shape and never reaches into the repos directly.
 */
export interface WorldSnapshot {
  city: unknown;
  location: unknown;
  travel: unknown;
  weather: unknown;
  timeZone: string | null;
  /**
   * Optional Life V2 producer payload. Kept optional so B7 can roll out the
   * location/weather side first and Life V2 can attach in PR C without a
   * context-builder migration.
   */
  life?: unknown;
}

export interface ContextBudgetLimits {
  contextWindowTokens: number;
  maxOutputTokens: number;
  reserveTokens: number;
  /** What remains for prompt/turns after output + reserve are subtracted. */
  budgetTokens: number;
}

export interface ContextBudgetDrops {
  recent: number;
  summaries: number;
  memories: number;
  media: number;
}

export interface ContextBudgetDiagnostics extends ContextBudgetLimits {
  estimatedTokens: number;
  dropped: ContextBudgetDrops;
}

export interface MemoryRecallTrace {
  queried: boolean;
  candidates: number;
  accepted: number;
  droppedDuplicate: number;
  droppedBudget: number;
}

/**
 * Privacy-safe build diagnostics. This deliberately carries counts only:
 * memory content, file text, embeddings and the final prompt are never
 * mirrored into diagnostics or logs.
 */
export interface ContextBuildTrace {
  budget: ContextBudgetDiagnostics;
  memory: MemoryRecallTrace;
}

export interface MessageModelPartsOptions {
  /** Resolves message media bytes through the logical media id. */
  media?: {
    read(id: string): Promise<{ record: { id: string; kind: string; mime: string; bytes: number; name?: string }; data: Uint8Array } | null>;
  } | null;
  /** Reads `media_text` extraction rows for file parts. */
  mediaText?: ((mediaId: string) => Promise<{ status: string; text: string | null; error: string | null } | undefined>) | null;
  /** Resolves sticker semantics by the sticker media id. */
  stickerByMediaId?: ((mediaId: string) => Promise<{
    id: string;
    name: string;
    description: string;
    imageText: string;
    userMeaning: string;
    emotion: string;
  } | undefined>) | null;
  /** When false, images/stickers are never read as binary and degrade safely. */
  visionConfigured?: boolean | (() => boolean | Promise<boolean>);
  maxImages?: number;
  maxImageBytes?: number;
}

export interface MessageModelPartsResult {
  parts: ChatContentPart[];
  /** Images actually embedded as binary ChatImagePart payloads. */
  imagesRead: number;
  /** Image/sticker binary payloads not embedded because vision, size or budget refused them. */
  imagesDropped: number;
}
