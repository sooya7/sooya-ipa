import type { MemoryEntry } from './types.js';

const LEGACY_CURSOR_PREFIX = 'ombre276:';
const EXACT_CONTENT_BOUNDARY = '[instructions:false]';
const EPOCH = new Date(0).toISOString();

interface LegacyBucketSummary {
  sourceId: string;
  importance: number;
}

export interface OmbreLegacySyncOptions {
  pulseText: string;
  cursor: string | null;
  limit: number;
  readBucket: (bucketId: string) => Promise<string>;
}

/**
 * Compatibility bridge for Ombre 2.7.6.
 *
 * 2.7.6 has no structured memory.sync/list tool, but pulse exposes stable
 * bucket IDs and breath_advanced has an explicit exact-bucket-ID read path.
 * We parse only those two narrow, test-covered boundaries. Any format drift
 * fails closed instead of becoming an empty successful sync.
 */
export async function pullOmbre276LegacyPage(
  options: OmbreLegacySyncOptions
): Promise<{ entries: MemoryEntry[]; nextCursor: string | null }> {
  const catalog = parsePulseOrdinaryMemories(options.pulseText);
  const offset = parseLegacyCursor(options.cursor);
  const pageSize = Math.max(1, Math.min(100, Math.trunc(options.limit)));
  const selected = catalog.slice(offset, offset + pageSize);
  const entries: MemoryEntry[] = [];

  // Keep tool calls sequential. Some native Streamable HTTP implementations
  // serialize requests on one MCP session even though JSON-RPC permits
  // concurrency; correctness matters more than shaving a few round trips here.
  for (const summary of selected) {
    const rendered = await options.readBucket(summary.sourceId);
    const content = extractExactBucketContent(rendered, summary.sourceId);
    const revision = `legacy-${stableHash(content)}`;
    entries.push({
      id: summary.sourceId,
      kind: 'summary',
      content,
      normalized: normalize(content),
      importance: normalizedImportance(summary.importance),
      confidence: 0.8,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      source: 'ombre',
      sourceId: summary.sourceId,
      sourceHash: revision,
      remoteRevision: revision
    });
  }

  const nextOffset = offset + selected.length;
  return {
    entries,
    nextCursor: nextOffset < catalog.length ? `${LEGACY_CURSOR_PREFIX}${nextOffset}` : null
  };
}

export function parsePulseOrdinaryMemories(text: string): LegacyBucketSummary[] {
  const source = String(text ?? '');
  const permanentCount = countFromPulse(source, /固化桶:\s*(\d+)\s*个/u);
  const dynamicCount = countFromPulse(source, /动态桶:\s*(\d+)\s*个/u);
  const expectedCount = permanentCount !== null && dynamicCount !== null
    ? permanentCount + dynamicCount
    : null;

  const section = source.match(
    /(?:^|\r?\n)=== 记忆列表 ===\r?\n([\s\S]*?)(?=\r?\n=== |$)/u
  )?.[1] ?? '';

  if (!section) {
    if (expectedCount === 0) return [];
    throw new Error(
      'legacy Ombre sync unavailable: pulse did not expose the ordinary-memory bucket list'
    );
  }

  const byId = new Map<string, LegacyBucketSummary>();
  for (const line of section.split(/\r?\n/u)) {
    const id = line.match(/\[([0-9a-f]{12})\]/iu)?.[1]?.toLowerCase();
    if (!id) continue;
    const rawImportance = Number(line.match(/重要:\s*(\d+)/u)?.[1] ?? 6);
    byId.set(id, {
      sourceId: id,
      importance: Number.isFinite(rawImportance) ? rawImportance : 6
    });
  }

  if (expectedCount !== null && expectedCount > 0 && byId.size === 0) {
    throw new Error(
      `legacy Ombre sync unavailable: pulse reports ${expectedCount} ordinary memories but no bucket IDs were parseable`
    );
  }

  return [...byId.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

export function extractExactBucketContent(rendered: string, bucketId: string): string {
  const text = String(rendered ?? '');
  const idMarker = `[bucket_id:${bucketId}]`;
  if (!text.includes(idMarker)) {
    throw new Error(
      `legacy Ombre sync unavailable: exact read for ${bucketId} did not return the requested bucket ID`
    );
  }
  const boundary = text.indexOf(EXACT_CONTENT_BOUNDARY);
  if (boundary < 0) {
    throw new Error(
      `legacy Ombre sync unavailable: exact read for ${bucketId} is missing the stored-content boundary`
    );
  }

  let content = text.slice(boundary + EXACT_CONTENT_BOUNDARY.length);
  if (content.startsWith('\r\n')) content = content.slice(2);
  else if (content.startsWith('\n')) content = content.slice(1);
  if (!content.trim()) {
    throw new Error(
      `legacy Ombre sync unavailable: exact read for ${bucketId} returned empty stored content`
    );
  }
  return content;
}

function parseLegacyCursor(cursor: string | null): number {
  if (!cursor?.startsWith(LEGACY_CURSOR_PREFIX)) return 0;
  const parsed = Number(cursor.slice(LEGACY_CURSOR_PREFIX.length));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function countFromPulse(text: string, pattern: RegExp): number | null {
  const raw = text.match(pattern)?.[1];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizedImportance(value: number): number {
  if (!Number.isFinite(value)) return 0.6;
  const normalized = value > 1 ? value / 10 : value;
  return Math.max(0, Math.min(1, normalized));
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\u3000,.;:!?，。！？；：、"'()（）]+/gu, '');
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(value)) {
    hash = Math.imul(hash ^ byte, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
