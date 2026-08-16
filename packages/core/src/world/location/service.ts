import type { LifeLocationRow, LocationRepo } from '../../db/location.repo.js';
import { safeJson } from '../../db/database.js';
import type { LifeActivityDefinition } from '../../life/v2/types.js';
import { selectLocationCandidate } from './selector.js';
import { findPath, planTravel } from './travel.js';
import type { LocationCandidate, LocationEdge, LocationTransitionResult, TravelPlan } from './types.js';

export interface LocalLocationServiceOptions {
  locations: LocationRepo;
  now?: () => Date;
}

/**
 * Durable Location Runtime. Activity/location changes only happen through
 * edges and travel time — never teleport. Conversations and Life scoring can
 * request a departure, but only this service mutates world state.
 */
export class LocalLocationService {
  private readonly now: () => Date;

  constructor(private readonly options: LocalLocationServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async currentLocation(): Promise<LifeLocationRow | undefined> {
    const state = await this.options.locations.currentState();
    return state ? await this.options.locations.get(state.location_id) : undefined;
  }

  async travelPlan(): Promise<TravelPlan | undefined> {
    const travel = await this.options.locations.currentTravel();
    if (!travel) return undefined;
    return {
      fromLocationId: travel.from_location_id,
      toLocationId: travel.to_location_id,
      path: [travel.from_location_id, travel.to_location_id],
      mode: travel.mode,
      travelMinutes: Math.max(1, Math.ceil((Date.parse(travel.expected_arrive_at) - Date.parse(travel.started_at)) / 60_000)),
      startedAt: travel.started_at,
      expectedArriveAt: travel.expected_arrive_at
    };
  }

  /** Arrives only after the persisted expected-arrival time has elapsed. */
  async arriveIfDue(now = this.now()): Promise<LocationTransitionResult> {
    const travel = await this.options.locations.currentTravel();
    if (!travel) return { kind: 'none', reason: 'no_state' };
    if (now.getTime() < Date.parse(travel.expected_arrive_at)) {
      return { kind: 'stay', locationId: travel.from_location_id, reason: 'travel_in_progress' };
    }
    const to = await this.options.locations.get(travel.to_location_id);
    if (!to) return { kind: 'stay', locationId: travel.from_location_id, reason: 'no_candidate' };
    const arrivedAt = travel.expected_arrive_at;
    await this.options.locations.closeOpenVisits(travel.from_location_id, arrivedAt).catch(() => 0);
    await this.options.locations.recordVisit({
      locationId: to.id,
      enteredAt: arrivedAt,
      sourceActivityId: travel.source_activity_id
    });
    await this.options.locations.setState({
      locationId: to.id,
      arrivedAt,
      sourcePlanId: travel.source_plan_id,
      sourceActivityId: travel.source_activity_id,
      confidence: 1
    });
    await this.options.locations.clearTravel();
    return { kind: 'arrived', locationId: to.id, at: arrivedAt };
  }

  /**
   * Plans a travel departure for an activity. When the desired location is
   * not reachable through edges, the runtime stays at the current location
   * instead of fabricating a jump.
   */
  async departForActivity(activity: LifeActivityDefinition, input: { at?: Date; weatherCondition?: string; deterministicSeed?: number } = {}): Promise<LocationTransitionResult> {
    const at = input.at ?? this.now();
    const existing = await this.options.locations.currentTravel();
    if (existing) {
      const arrived = await this.arriveIfDue(at);
      if (arrived.kind === 'stay' && arrived.reason === 'travel_in_progress') return arrived;
    }
    const state = await this.options.locations.currentState();
    if (!state) return { kind: 'none', reason: 'no_state' };
    const current = await this.options.locations.get(state.location_id);
    if (!current) return { kind: 'none', reason: 'no_locations' };
    const locations = await this.locationCandidates();
    if (locations.length === 0) return { kind: 'stay', locationId: current.id, reason: 'no_candidate' };
    const recent = (await this.options.locations.recentVisits(12)).map((visit) => visit.location_id);
    const candidate = selectLocationCandidate(locations, {
      activity,
      currentLocationId: current.id,
      weatherCondition: input.weatherCondition,
      recentLocationIds: recent,
      deterministicSeed: input.deterministicSeed ?? 7,
      at: at.toISOString()
    });
    if (!candidate || candidate.id === current.id) return { kind: 'stay', locationId: current.id, reason: 'same_location' };
    const edges = await this.locationEdges();
    const path = findPath(edges, current.id, candidate.id);
    if (!path) return { kind: 'stay', locationId: current.id, reason: 'unreachable' };
    const plan = planTravel({ fromLocationId: current.id, toLocationId: candidate.id, edges, startedAt: at });
    if (!plan) return { kind: 'stay', locationId: current.id, reason: 'no_edge' };
    await this.options.locations.setTravel({
      fromLocationId: plan.fromLocationId,
      toLocationId: plan.toLocationId,
      mode: plan.mode,
      startedAt: plan.startedAt,
      expectedArriveAt: plan.expectedArriveAt,
      sourceActivityId: activity.id
    });
    return { kind: 'departed', travel: plan };
  }

  async locationCandidates(): Promise<LocationCandidate[]> {
    return (await this.options.locations.list(true)).map((row) => toCandidate(row));
  }

  private async locationEdges(): Promise<LocationEdge[]> {
    const locations = await this.options.locations.list(true);
    const edges: LocationEdge[] = [];
    for (const location of locations) {
      for (const edge of await this.options.locations.edgesFrom(location.id)) {
        edges.push({ fromId: edge.from_id, toId: edge.to_id, travelMinutes: edge.travel_minutes, mode: edge.mode });
      }
    }
    return edges;
  }
}

function toCandidate(row: LifeLocationRow): LocationCandidate {
  const tags = safeJson<unknown>(row.tags_json, []);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    city: row.city,
    region: row.region,
    country: row.country,
    timeZone: row.time_zone,
    indoor: row.indoor === 1,
    visitWeight: row.visit_weight,
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : []
  };
}
