import type { Sticker } from '../db/sticker.repo.js';

export interface StickerCandidate {
  sticker: Sticker;
  score: number;
  signals: string[];
}

export interface StickerRetrieval {
  candidates: StickerCandidate[];
  query: string;
  usedEmbedding: boolean;
  ftsCount: number;
  semanticCount: number;
}

export interface StickerPickResult {
  stickerId: string | null;
  confidence: number;
  reason: string;
}
