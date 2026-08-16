import type { LocationKind, TravelMode } from '../../db/location.repo.js';

export interface LocationCandidate {
  id: string;
  name: string;
  kind: LocationKind;
  city: string | null;
  region: string | null;
  country: string | null;
  timeZone: string | null;
  indoor: boolean;
  visitWeight: number;
  tags: string[];
}

export interface LocationEdge {
  fromId: string;
  toId: string;
  travelMinutes: number;
  mode: TravelMode;
}

export type LocationTransitionResult =
  | { kind: 'arrived'; locationId: string; at: string }
  | { kind: 'departed'; travel: TravelPlan }
  | { kind: 'stay'; locationId: string; reason: 'same_location' | 'no_candidate' | 'unreachable' | 'no_edge' | 'travel_in_progress' }
  | { kind: 'none'; reason: 'no_state' | 'no_locations' };

export interface TravelPlan {
  fromLocationId: string;
  toLocationId: string;
  path: string[];
  mode: TravelMode;
  travelMinutes: number;
  startedAt: string;
  expectedArriveAt: string;
}
