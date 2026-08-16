import { describe, expect, it } from 'vitest';
import { migrateDatabase } from '../db/migrations.js';
import { NodeLocalDatabase } from '../../test/db/node-local-database.js';
import { LifeCityRepo, LifeClockRepo, LifeRepo, LifeV2Repo, LocationRepo, WeatherRepo } from '../db/index.js';
import { LocalLifeCatchUp } from '../life/catch-up-service.js';
import { LifeV2Source } from '../life/v2/source.js';
import { LocalLocationService } from '../world/location/service.js';
import { LocalCore } from './local-core.js';

async function seedClock(db: NodeLocalDatabase, lastSettledAt: string, endsAt: string): Promise<void> {
  const now = new Date(lastSettledAt);
  const clock = new LifeClockRepo(db, () => now);
  await clock.load();
  await db.run('UPDATE life_clock_state SET last_settled_at=?, updated_at=?, meta_json=json_set(meta_json, \'$.current.endsAt\', ?) WHERE id=1', [lastSettledAt, lastSettledAt, endsAt]);
  await db.run('UPDATE life_state SET activity=?, kind=?, mood=?, started_at=?, ends_at=? WHERE id=1', ['睡觉', 'sleep', 'quiet', lastSettledAt, endsAt]);
}

async function createRuntime() {
  const db = new NodeLocalDatabase();
  await migrateDatabase(db);
  const now = () => new Date('2026-08-13T15:00:00.000Z');
  await seedClock(db, '2026-08-13T01:00:00.000Z', '2026-08-13T07:30:00.000Z');
  const life = new LifeV2Repo(db, now);
  const lifeState = new LifeRepo(db, now);
  const locations = new LocationRepo(db, now);
  const weather = new WeatherRepo(db, now);
  const locationRuntime = new LocalLocationService({ locations, now });
  const source = new LifeV2Source({ life, lifeState, locations, weather, locationRuntime, now });
  const catchUp = new LocalLifeCatchUp({ clock: new LifeClockRepo(db, now), now, detailedWindowMs: 7 * 86_400_000, maxTransitions: 40, source });
  return { db, life, lifeState, locations, weather, catchUp };
}

describe('Life V2 + Location runtime parity', () => {
  it('replays elapsed time deterministically and creates share candidates', async () => {
    const first = await createRuntime();
    const second = await createRuntime();
    const a = await first.catchUp.catchUp(new Date('2026-08-13T15:00:00.000Z'));
    const b = await second.catchUp.catchUp(new Date('2026-08-13T15:00:00.000Z'));

    expect(a.transitions.length).toBeGreaterThan(0);
    expect(a.transitions.map((item) => `${item.activity}:${item.kind}`)).toEqual(b.transitions.map((item) => `${item.activity}:${item.kind}`));
    expect(await first.life.getVitals()).toBeDefined();
    expect((await first.life.recentThemes()).length).toBeGreaterThan(0);
    expect((await first.life.threads()).length).toBeGreaterThan(0);
    expect(await first.life.shareCandidates()).not.toHaveLength(0);
  });

  it('coarsely settles long offline gaps without fabricating hundreds of rows', async () => {
    const db = new NodeLocalDatabase();
    await migrateDatabase(db);
    const now = () => new Date('2026-08-13T15:00:00.000Z');
    await seedClock(db, '2026-06-01T00:00:00.000Z', '2026-06-01T08:00:00.000Z');
    const life = new LifeV2Repo(db, now);
    const catchUp = new LocalLifeCatchUp({
      clock: new LifeClockRepo(db, now),
      now,
      detailedWindowMs: 7 * 86_400_000,
      maxTransitions: 5,
      source: new LifeV2Source({ life, now })
    });

    const result = await catchUp.catchUp(new Date('2026-08-13T15:00:00.000Z'));
    expect(result.coarseSettled).toBe(true);
    expect(result.transitions.length).toBeLessThanOrEqual(5);
    expect(result.state.lastSettledAt).toBe('2026-08-13T15:00:00.000Z');
    expect(await life.getVitals()).toBeDefined();
  });

  it('exposes real city/location/travel/weather in presence()', async () => {
    const db = new NodeLocalDatabase();
    await migrateDatabase(db);
    const now = new Date('2026-08-13T08:00:00.000Z');
    const core = new LocalCore({ db, now: () => now });
    const city = await core.lifeCitiesRepo.create({ name: '上海', region: '上海', country: '中国', timeZone: 'Asia/Shanghai', active: true });
    const home = await core.locationsRepo.create({ key: 'home', name: '家', kind: 'home', cityId: city.id, city: '上海', region: '上海', country: '中国', timeZone: 'Asia/Shanghai', indoor: true, source: 'builtin' });
    const park = await core.locationsRepo.create({ key: 'park', name: '公园', kind: 'park', cityId: city.id, city: '上海', region: '上海', country: '中国', timeZone: 'Asia/Shanghai', indoor: false, source: 'builtin' });
    await core.locationsRepo.setState({ locationId: home.id, arrivedAt: now.toISOString() });
    await core.locationsRepo.setTravel({
      fromLocationId: home.id,
      toLocationId: park.id,
      mode: 'walk',
      startedAt: now.toISOString(),
      expectedArriveAt: new Date(now.getTime() + 12 * 60_000).toISOString()
    });
    await core.weatherRepo.save({
      location_key: 'active',
      observed_at: now.toISOString(),
      condition: 'clear',
      temperature_c: 26,
      feels_like_c: 27,
      humidity: 50,
      precipitation_mm: 0,
      wind_kph: 8,
      visibility_km: 10,
      pressure_hpa: 1012,
      provider: 'open-meteo'
    });

    const presence = await core.presence();
    expect(presence.city).toMatchObject({ name: '上海' });
    expect(presence.location).toMatchObject({ name: '家', kind: 'home' });
    expect(presence.travel).toMatchObject({ fromName: '家', toName: '公园', mode: 'walk' });
    expect(presence.weather?.condition).toBe('clear');

    await core.locationRuntime.arriveIfDue(new Date(now.getTime() + 15 * 60_000));
    const arrived = await core.presence();
    expect(arrived.location).toMatchObject({ name: '公园' });
    expect(arrived.travel).toBeNull();
    expect(arrived.city?.name).toBe('上海');
  });
});
