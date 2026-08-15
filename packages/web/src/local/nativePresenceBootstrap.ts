import type { LocalCore } from '@sooya/core/app';

type PresenceCore = Pick<LocalCore, 'lifeRepo' | 'lifeCitiesRepo' | 'locationsRepo'>;

/**
 * Fresh IPA databases have no server daemon to seed Life/location state.
 * Preserve migrated state when it exists; only fill the missing native baseline.
 */
export async function ensureNativeCompanionState(core: PresenceCore, now: () => Date = () => new Date()): Promise<void> {
  const timestamp = now();
  if (!await core.lifeRepo.current()) {
    await core.lifeRepo.advance({
      activity: '在家休息',
      kind: 'rest',
      mood: '平静',
      startedAt: timestamp.toISOString(),
      endsAt: new Date(timestamp.getTime() + 60 * 60_000).toISOString()
    }, { recordCompletionEvent: false });
  }

  const currentState = await core.locationsRepo.currentState();
  if (currentState && await core.locationsRepo.get(currentState.location_id)) return;

  let location = (await core.locationsRepo.list(true))[0];
  if (!location) {
    let city = await core.lifeCitiesRepo.activeCity();
    if (!city) {
      // LocalCore's weather adapter defaults to China. This deterministic first-run
      // city is only a fallback; imported/admin Life places always win.
      city = await core.lifeCitiesRepo.create({
        key: 'native-default-city',
        name: '上海',
        region: '上海',
        country: '中国',
        timeZone: 'Asia/Shanghai',
        active: true
      });
    }
    location = await core.locationsRepo.create({
      key: 'native-default-home',
      name: '家',
      kind: 'home',
      cityId: city.id,
      city: city.name,
      region: city.region,
      country: city.country,
      timeZone: city.time_zone,
      indoor: true,
      visitWeight: 10,
      source: 'builtin'
    });
  }

  await core.locationsRepo.setState({ locationId: location.id, arrivedAt: timestamp.toISOString(), confidence: 1 });
}
