import { beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../db/migrations.js';
import { NodeLocalDatabase } from '../../../test/db/node-local-database.js';
import { LifeCityRepo, LocationRepo } from '../../db/index.js';
import { activityById } from '../../life/v2/activities.js';
import { LocalLocationService } from './service.js';

describe('LocalLocationService', () => {
  let db: NodeLocalDatabase;
  let locations: LocationRepo;
  let service: LocalLocationService;
  let now: Date;

  beforeEach(async () => {
    db = new NodeLocalDatabase();
    await migrateDatabase(db);
    now = new Date('2026-08-13T08:00:00.000Z');
    locations = new LocationRepo(db, () => now);
    const cities = new LifeCityRepo(db, () => now);
    await cities.create({ name: '上海', timeZone: 'Asia/Shanghai', active: true });
    service = new LocalLocationService({ locations, now: () => now });
  });

  async function seedLocations(): Promise<{ home: string; park: string }> {
    const home = await locations.create({ key: 'home', name: '家', kind: 'home', city: '上海', timeZone: 'Asia/Shanghai', indoor: true, source: 'builtin' });
    const park = await locations.create({ key: 'park', name: '公园', kind: 'park', city: '上海', timeZone: 'Asia/Shanghai', indoor: false, source: 'builtin' });
    await locations.setState({ locationId: home.id, arrivedAt: now.toISOString() });
    return { home: home.id, park: park.id };
  }

  it('refuses to teleport when no edge connects the locations', async () => {
    const { home, park } = await seedLocations();
    const result = await service.departForActivity(activityById('walk'), { at: now, deterministicSeed: 1 });

    expect(result).toMatchObject({ kind: 'stay', reason: 'unreachable' });
    expect((await locations.currentState())?.location_id).toBe(home);
    expect(await locations.currentTravel()).toBeUndefined();
    expect((await locations.currentState())?.location_id).not.toBe(park);
  });

  it('departs through an edge and arrives only after the expected arrival time', async () => {
    const { home, park } = await seedLocations();
    await locations.saveEdge(home, park, 10, 'walk');

    const departed = await service.departForActivity(activityById('walk'), { at: now, deterministicSeed: 1 });
    expect(departed).toMatchObject({ kind: 'departed' });
    if (departed.kind !== 'departed') throw new Error('expected departure');
    expect(departed.travel.expectedArriveAt).toBe(new Date(now.getTime() + 10 * 60_000).toISOString());

    await expect(service.arriveIfDue(new Date(now.getTime() + 5 * 60_000))).resolves.toMatchObject({ kind: 'stay', reason: 'travel_in_progress' });
    expect((await locations.currentState())?.location_id).toBe(home);

    const arrived = await service.arriveIfDue(new Date(now.getTime() + 11 * 60_000));
    expect(arrived).toMatchObject({ kind: 'arrived', locationId: park });
    expect((await locations.currentState())?.location_id).toBe(park);
    expect(await locations.currentTravel()).toBeUndefined();
    expect(await locations.recentVisits()).toHaveLength(1);
  });


  it('switches city only through an edge and arrival', async () => {
    const { home } = await seedLocations();
    const cities = new LifeCityRepo(db, () => now);
    const hangzhou = await cities.create({ name: '杭州', timeZone: 'Asia/Shanghai' });
    const office = await locations.create({ key: 'hz-office', name: '杭州办公室', kind: 'work', cityId: hangzhou.id, city: '杭州', timeZone: 'Asia/Shanghai', indoor: true, source: 'builtin' });
    await locations.saveEdge(home, office.id, 30, 'transit');

    const result = await service.departForActivity(activityById('work'), { at: now, deterministicSeed: 3 });
    expect(result).toMatchObject({ kind: 'departed' });
    if (result.kind !== 'departed') throw new Error('expected departure');
    expect(result.travel.toLocationId).toBe(office.id);

    await service.arriveIfDue(new Date(now.getTime() + 31 * 60_000));
    const state = await locations.currentState();
    const current = state ? await locations.get(state.location_id) : undefined;
    expect(current?.id).toBe(office.id);
    expect(current?.city).toBe('杭州');
    expect(current?.city_id).toBe(hangzhou.id);
  });

  it('supports multi-edge paths without intermediate teleport jumps', async () => {
    const { home, park } = await seedLocations();
    await locations.deactivate(park);
    const cafe = await locations.create({ key: 'cafe', name: '咖啡馆', kind: 'cafe', city: '上海', indoor: true, source: 'builtin' });
    const farPark = await locations.create({ key: 'park-2', name: '远一点的公园', kind: 'park', city: '上海', indoor: false, source: 'builtin' });
    await locations.saveEdge(home, cafe.id, 5, 'walk');
    await locations.saveEdge(cafe.id, farPark.id, 8, 'bike');

    const result = await service.departForActivity(activityById('walk'), { at: now, deterministicSeed: 2 });
    expect(result).toMatchObject({ kind: 'departed' });
    if (result.kind !== 'departed') throw new Error('expected departure');
    expect(result.travel.path).toEqual([home, cafe.id, farPark.id]);
    expect(result.travel.travelMinutes).toBe(13);
  });
});
