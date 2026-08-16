import type { TravelMode } from '../../db/location.repo.js';
import type { LocationEdge, TravelPlan } from './types.js';

export interface FindPathResult {
  path: string[];
  travelMinutes: number;
  mode: TravelMode;
}

export function findPath(edges: LocationEdge[], fromId: string, toId: string): FindPathResult | undefined {
  if (fromId === toId) return { path: [fromId], travelMinutes: 0, mode: 'walk' };
  const adjacency = new Map<string, Array<{ to: string; edge: LocationEdge }>>();
  for (const edge of edges) {
    if (edge.travelMinutes <= 0) continue;
    const from = adjacency.get(edge.fromId) ?? [];
    from.push({ to: edge.toId, edge });
    adjacency.set(edge.fromId, from);
  }
  const queue: Array<{ id: string; path: string[]; minutes: number; modes: TravelMode[] }> = [{ id: fromId, path: [fromId], minutes: 0, modes: [] }];
  const visited = new Set([fromId]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.id === toId) {
      return { path: current.path, travelMinutes: Math.max(0, current.minutes), mode: dominantMode(current.modes) };
    }
    for (const next of adjacency.get(current.id) ?? []) {
      if (visited.has(next.to)) continue;
      visited.add(next.to);
      queue.push({ id: next.to, path: [...current.path, next.to], minutes: current.minutes + next.edge.travelMinutes, modes: [...current.modes, next.edge.mode] });
    }
  }
  return undefined;
}

export function planTravel(input: {
  fromLocationId: string;
  toLocationId: string;
  edges: LocationEdge[];
  startedAt: Date;
  modePreference?: TravelMode;
}): TravelPlan | undefined {
  const route = findPath(input.edges, input.fromLocationId, input.toLocationId);
  if (!route) return undefined;
  const minutes = Math.max(1, route.travelMinutes || 1);
  const mode = input.modePreference ?? route.mode;
  return {
    fromLocationId: input.fromLocationId,
    toLocationId: input.toLocationId,
    path: route.path,
    mode,
    travelMinutes: minutes,
    startedAt: input.startedAt.toISOString(),
    expectedArriveAt: new Date(input.startedAt.getTime() + minutes * 60_000).toISOString()
  };
}

function dominantMode(modes: TravelMode[]): TravelMode {
  if (modes.length === 0) return 'walk';
  const counts = new Map<TravelMode, number>();
  for (const mode of modes) counts.set(mode, (counts.get(mode) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'walk';
}
