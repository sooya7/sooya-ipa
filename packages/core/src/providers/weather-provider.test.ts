import { describe, expect, it } from 'vitest';
import type { HttpPlatform, HttpResponse } from '../platform/http.js';
import { OpenMeteoWeatherProvider, wmoCondition } from './weather-provider.js';

function fakeHttp(status: number, payload: unknown): HttpPlatform {
  return {
    async request(input) {
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const response: HttpResponse = { status, headers: { 'content-type': 'application/json' }, body };
      return response;
    },
    async stream() { throw new Error('not used'); }
  };
}

describe('wmoCondition', () => {
  it('maps WMO codes to semantic conditions', () => {
    expect(wmoCondition(0)).toBe('clear');
    expect(wmoCondition(2)).toBe('cloudy');
    expect(wmoCondition(45)).toBe('fog');
    expect(wmoCondition(61)).toBe('rain');
    expect(wmoCondition(75)).toBe('snow');
    expect(wmoCondition(95)).toBe('storm');
    expect(wmoCondition(null)).toBe('unknown');
    expect(wmoCondition(999)).toBe('unknown');
  });
});

describe('OpenMeteoWeatherProvider', () => {
  it('resolves coordinates then fetches current weather', async () => {
    const calls: string[] = [];
    const http: HttpPlatform = {
      async request(input) {
        calls.push(String(input.url));
        if (input.url.includes('/v1/search')) {
          return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ results: [{ latitude: 39.9, longitude: 116.4 }] })) };
        }
        return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
          timezone: 'Asia/Shanghai',
          utc_offset_seconds: 28800,
          current: {
            time: '2026-08-14T12:00',
            weather_code: 2,
            temperature_2m: 28.5,
            apparent_temperature: 30.1,
            relative_humidity_2m: 60,
            precipitation: 0,
            wind_speed_10m: 12,
            visibility: 15000,
            pressure_msl: 1013
          }
        })) };
      },
      async stream() { throw new Error('not used'); }
    };
    const provider = new OpenMeteoWeatherProvider(http, { baseUrl: 'https://api.test', geocodingBaseUrl: 'https://geo.test' });
    const snapshot = await provider.current({ city: '北京', country: '中国' });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('geo.test/v1/search');
    expect(calls[1]).toContain('api.test/v1/forecast');
    expect(snapshot).toMatchObject({
      condition: 'cloudy',
      temperatureC: 28.5,
      humidity: 60,
      provider: 'open-meteo',
      stale: false
    });
    expect(snapshot.locationKey).toBe('中国|北京');
  });

  it('caches resolved coordinates per city', async () => {
    let searchCalls = 0;
    const http: HttpPlatform = {
      async request(input) {
        if (input.url.includes('/v1/search')) {
          searchCalls += 1;
          return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ results: [{ latitude: 31.2, longitude: 121.5 }] })) };
        }
        return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ current: { time: '2026-08-14T12:00', weather_code: 1, temperature_2m: 22 } })) };
      },
      async stream() { throw new Error('not used'); }
    };
    const provider = new OpenMeteoWeatherProvider(http, { baseUrl: 'https://api.test', geocodingBaseUrl: 'https://geo.test' });
    await provider.current({ city: '上海', country: '中国' });
    await provider.current({ city: '上海', country: '中国' });
    expect(searchCalls).toBe(1);
  });

  it('throws a provider error when the city is not found', async () => {
    const http = fakeHttp(200, { results: [] });
    const provider = new OpenMeteoWeatherProvider(http, { baseUrl: 'https://api.test', geocodingBaseUrl: 'https://geo.test' });
    await expect(provider.current({ city: '不存在的城市' })).rejects.toThrow(/未找到城市/);
  });
});
