import { describe, expect, it, vi } from 'vitest';
import type { LocalCore } from '@sooya/core/app';
import { ensureNativeCompanionState } from './nativePresenceBootstrap.js';

type PresenceCore = Pick<LocalCore, 'lifeRepo' | 'lifeCitiesRepo' | 'locationsRepo'>;

function freshCore(): PresenceCore {
  const city = { id: 'city_1', key: 'native-default-city', name: '上海', region: '上海', country: '中国', time_zone: 'Asia/Shanghai', active: 1, created_at: '', updated_at: '' };
  const home = { id: 'loc_1', key: 'native-default-home', name: '家', kind: 'home', city_id: city.id, city: city.name, region: city.region, country: city.country, time_zone: city.time_zone, lat: null, lng: null, tags_json: '[]', indoor: 1, visit_weight: 10, source: 'builtin', active: 1, created_at: '', updated_at: '' };
  return {
    lifeRepo: { current: vi.fn(async () => undefined), advance: vi.fn(async () => ({ previous: null })) } as unknown as PresenceCore['lifeRepo'],
    lifeCitiesRepo: { activeCity: vi.fn(async () => undefined), create: vi.fn(async () => city) } as unknown as PresenceCore['lifeCitiesRepo'],
    locationsRepo: {
      currentState: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      create: vi.fn(async () => home),
      setState: vi.fn(async (input) => ({ id: 1, location_id: input.locationId, arrived_at: input.arrivedAt, expected_leave_at: null, source_plan_id: null, source_activity_id: null, confidence: 1, updated_at: input.arrivedAt }))
    } as unknown as PresenceCore['locationsRepo']
  };
}

describe('native companion presence bootstrap', () => {
  it('fills a fresh IPA database with an activity and current home', async () => {
    const core = freshCore();
    await ensureNativeCompanionState(core, () => new Date('2026-08-15T03:00:00.000Z'));
    expect(core.lifeRepo.advance).toHaveBeenCalledWith(expect.objectContaining({ activity: '在家休息', kind: 'rest' }), { recordCompletionEvent: false });
    expect(core.lifeCitiesRepo.create).toHaveBeenCalledWith(expect.objectContaining({ name: '上海', active: true }));
    expect(core.locationsRepo.create).toHaveBeenCalledWith(expect.objectContaining({ name: '家', kind: 'home', city: '上海' }));
    expect(core.locationsRepo.setState).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc_1', confidence: 1 }));
  });

  it('keeps imported Life and location state intact', async () => {
    const core = freshCore();
    vi.mocked(core.lifeRepo.current).mockResolvedValue({ activity: '喝咖啡', kind: 'meal', mood: '开心', started_at: '', ends_at: '', updated_at: '', meta_json: '{}' });
    vi.mocked(core.locationsRepo.currentState).mockResolvedValue({ id: 1, location_id: 'server_place', arrived_at: '', expected_leave_at: null, source_plan_id: null, source_activity_id: null, confidence: 1, updated_at: '' });
    vi.mocked(core.locationsRepo.get).mockResolvedValue({ id: 'server_place', key: null, name: '咖啡店', kind: 'cafe', city_id: null, city: '成都', region: '四川', country: '中国', time_zone: 'Asia/Shanghai', lat: null, lng: null, tags_json: '[]', indoor: 1, visit_weight: 1, source: 'admin', active: 1, created_at: '', updated_at: '' });
    await ensureNativeCompanionState(core);
    expect(core.lifeRepo.advance).not.toHaveBeenCalled();
    expect(core.lifeCitiesRepo.create).not.toHaveBeenCalled();
    expect(core.locationsRepo.create).not.toHaveBeenCalled();
    expect(core.locationsRepo.setState).not.toHaveBeenCalled();
  });
});
