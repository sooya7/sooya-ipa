export interface BatchEventPayload {
  batchId?: unknown;
  revision?: unknown;
}

/**
 * Accepts only events that can still affect the visible state for a batch.
 * Once a revision becomes terminal, every later event for that same revision
 * is stale, including another terminal event such as a delayed interruption.
 */
export function acceptBatchEvent(
  seenRevisions: Map<string, number>,
  terminalRevisions: Map<string, number>,
  payload: BatchEventPayload,
  terminal = false
): boolean {
  const batchId = String(payload.batchId ?? '');
  if (!batchId) return true;
  const revision = Number(payload.revision ?? 0);
  if (!Number.isFinite(revision) || revision <= 0) return true;

  const seen = seenRevisions.get(batchId) ?? 0;
  const terminalRevision = terminalRevisions.get(batchId) ?? 0;
  if (revision < seen) return false;
  if (revision <= terminalRevision) return false;

  seenRevisions.set(batchId, Math.max(seen, revision));
  if (terminal) terminalRevisions.set(batchId, Math.max(terminalRevision, revision));
  return true;
}
