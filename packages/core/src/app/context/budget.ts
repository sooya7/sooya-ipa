import type { ChatTurn } from '../../providers/types.js';
import type { ContextBudgetLimits } from './types.js';

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const DEFAULT_RESERVE_TOKENS = 768;
/** Provider bridges add role/separator overhead on top of content tokens. */
export const TURN_OVERHEAD_TOKENS = 4;

export interface ContextBudgetInput {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  reserveTokens?: number;
}

/**
 * Stable, dependency-free token approximation. CJK glyphs are counted close
 * to 1 token/glyph while other text is approximated by the conventional
 * ~4 chars/token ratio plus a small padding for separators. Exact provider
 * tokenizers are deliberately not pulled into the mobile bundle.
 */
export function estimateTextTokens(value: string): number {
  const text = value.normalize('NFKC');
  const chars = Array.from(text);
  if (chars.length === 0) return 0;
  const cjk = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const other = Math.max(0, chars.length - cjk);
  return Math.ceil(cjk * 0.95 + other * 0.28) + 1;
}

/** Binary parts are priced as a fixed bridge cost plus a bytes-based estimate. */
export function estimateImageTokens(bytes: number): number {
  const safeBytes = Math.max(0, Math.trunc(bytes));
  return 64 + Math.ceil(safeBytes / 768);
}

export function estimateChatTurnTokens(turn: ChatTurn): number {
  return TURN_OVERHEAD_TOKENS + turn.content.reduce((sum, part) => {
    if (part.type === 'text') return sum + estimateTextTokens(part.text);
    return sum + estimateImageTokens(part.data.byteLength);
  }, 0);
}

export function estimateSectionTokens(header: string, lines: string[]): number {
  const headerTokens = header ? estimateTextTokens(header) + 2 : 0;
  return headerTokens + lines.reduce((sum, line) => sum + estimateTextTokens(line) + 1, 0);
}

/** Resolves explicit/async budget inputs into deterministic integer limits. */
export function contextBudgetLimits(input: ContextBudgetInput = {}): ContextBudgetLimits {
  const contextWindowTokens = positiveInteger(input.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_CONTEXT_WINDOW_TOKENS);
  const maxOutputTokens = positiveInteger(input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS);
  const reserveTokens = Math.max(0, Math.trunc(input.reserveTokens ?? DEFAULT_RESERVE_TOKENS));
  return {
    contextWindowTokens,
    maxOutputTokens,
    reserveTokens,
    budgetTokens: Math.max(0, contextWindowTokens - maxOutputTokens - reserveTokens)
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}
