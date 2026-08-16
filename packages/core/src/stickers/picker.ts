import type { StickerCandidate, StickerPickResult } from './types.js';

export interface StickerPickerOptions {
  /** Below this confidence the picker returns null instead of forcing a wrong sticker. */
  minConfidence?: number;
}

export class StickerPicker {
  private readonly minConfidence: number;

  constructor(options: StickerPickerOptions = {}) {
    this.minConfidence = options.minConfidence ?? 0.3;
  }

  pick(input: { semantic: string; candidates: StickerCandidate[]; recentUsedIds?: string[]; desiredIntent?: string }): StickerPickResult {
    const recent = new Set(input.recentUsedIds ?? []);
    const eligible = input.candidates.filter((candidate) => !recent.has(candidate.sticker.id));
    const top = eligible[0] ?? input.candidates[0];
    if (!top || top.score < this.minConfidence) {
      return {
        stickerId: null,
        confidence: 0,
        reason: top ? `best_match_below_confidence:${top.score.toFixed(2)}` : 'no_candidates'
      };
    }
    const confidence = Math.max(0, Math.min(1, 0.55 + (top.score - this.minConfidence) * 0.6));
    const signals = top.signals.slice(0, 4).join(',') || 'lexical';
    return {
      stickerId: top.sticker.id,
      confidence,
      reason: `top:${top.sticker.id}:${signals}:${confidence.toFixed(2)}`
    };
  }
}
