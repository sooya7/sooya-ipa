import type { HttpPlatform } from '../platform/http.js';
import type { WeatherCondition, WeatherSnapshot } from '../db/weather.repo.js';
import { ProviderRequestError } from '../providers/types.js';

export interface WeatherLocation {
  city?: string | null;
  region?: string | null;
  country?: string | null;
}

/** Key for caching/resolving coordinates per city. */
export function weatherLocationKey(location: WeatherLocation): string {
  return [location.country, location.region, location.city].filter(Boolean).join('|');
}

/** WMO weather code → semantic condition (same mapping as the server version). */
export function wmoCondition(code: number | null | undefined): WeatherCondition {
  if (code == null) return 'unknown';
  if (code === 0) return 'clear';
  if (code >= 1 && code <= 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'storm';
  return 'unknown';
}

const CN_ISO_CODES = new Map<string, string>([
  ['中国', 'CN'],
  ['中华人民共和国', 'CN']
]);

interface OpenMeteoCurrent {
  time?: string | null;
  weather_code?: number | string | null;
  temperature_2m?: number | null;
  apparent_temperature?: number | null;
  relative_humidity_2m?: number | null;
  precipitation?: number | null;
  wind_speed_10m?: number | null;
  visibility?: number | null;
  pressure_msl?: number | null;
}

interface OpenMeteoResponse {
  timezone?: string;
  utc_offset_seconds?: number;
  current?: OpenMeteoCurrent;
}

/**
 * Real-time weather adapter backed by open-meteo (free, no key). Coordinates
 * are resolved through the geocoding API and cached per city. All network I/O
 * goes through HttpPlatform so the native build reuses the URLSession bridge.
 */
export class OpenMeteoWeatherProvider {
  readonly name = 'open-meteo';
  readonly configured = true;
  private readonly baseUrl: string;
  private readonly geocodingBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly coordCache = new Map<string, { lat: number; lng: number }>();

  constructor(private readonly http: HttpPlatform, options: { baseUrl?: string; geocodingBaseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = String(options.baseUrl?.trim() || 'https://api.open-meteo.com').replace(/\/+$/u, '');
    this.geocodingBaseUrl = String(options.geocodingBaseUrl?.trim() || 'https://geocoding-api.open-meteo.com').replace(/\/+$/u, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async current(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherSnapshot> {
    const { lat, lng } = await this.coords(location, signal);
    const url = `${this.baseUrl}/v1/forecast?latitude=${lat}&longitude=${lng}` +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,visibility,pressure_msl&timezone=auto';
    const json = await this.getJson(url, signal);
    const current = json.current;
    if (!current) throw new ProviderRequestError('open-meteo: 响应缺少 current 数据', 0);
    const visibility = num(current.visibility);
    const observedAt = parseLocalIso(String(current.time ?? ''), json.timezone, json.utc_offset_seconds).toISOString();
    return {
      observedAt,
      condition: wmoCondition(num(current.weather_code)),
      temperatureC: num(current.temperature_2m),
      feelsLikeC: num(current.apparent_temperature),
      humidity: num(current.relative_humidity_2m),
      precipitationMm: num(current.precipitation),
      windKph: num(current.wind_speed_10m),
      visibilityKm: visibility != null ? Math.round(visibility / 1000) : undefined,
      pressureHpa: num(current.pressure_msl),
      provider: this.name,
      locationKey: weatherLocationKey(location),
      stale: false
    };
  }

  private async coords(location: WeatherLocation, signal?: AbortSignal): Promise<{ lat: number; lng: number }> {
    const key = weatherLocationKey(location);
    const cached = this.coordCache.get(key);
    if (cached) return cached;
    const name = encodeURIComponent(location.city || location.region || '');
    const code = CN_ISO_CODES.get(String(location.country ?? '').trim());
    const country = code ? `&countryCode=${code}` : '';
    const url = `${this.geocodingBaseUrl}/v1/search?name=${name}${country}&count=1&language=zh&format=json`;
    const value = await this.getJson(url, signal) as { results?: Array<{ latitude: number; longitude: number }> };
    const hit = value.results?.[0];
    if (!hit) throw new ProviderRequestError(`open-meteo: 未找到城市 ${location.city}`, 0);
    const coords = { lat: hit.latitude, lng: hit.longitude };
    this.coordCache.set(key, coords);
    return coords;
  }

  private async getJson(url: string, signal?: AbortSignal): Promise<OpenMeteoResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`weather provider timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    const onAbort = () => controller.abort(signal?.reason ?? new Error('weather request aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.http.request({
        url,
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
        timeoutMs: this.timeoutMs
      });
      const text = new TextDecoder().decode(response.body);
      let value: unknown;
      try { value = text ? JSON.parse(text) : null; } catch { value = null; }
      if (response.status < 200 || response.status >= 300) {
        throw new ProviderRequestError(`weather provider http ${response.status}`, response.status);
      }
      if (!value || typeof value !== 'object') throw new ProviderRequestError('weather provider returned invalid json', 0);
      return value as OpenMeteoResponse;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function num(value: number | string | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** open-meteo local clock time → ISO instant (with timezone/UTC-offset fallback). */
function parseLocalIso(time: string, tz: string | undefined, utcOffsetSeconds: number | undefined): Date {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/u.exec(time);
  if (!match) return new Date(time);
  const fallbackMinutes = -((utcOffsetSeconds ?? 0) / 60);
  const hour = match[2] ? Number(match[2]) : 12;
  const minute = match[3] ? Number(match[3]) : 0;
  const local = new Date(`${match[1]}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);
  if (!tz || tz === 'auto') {
    return new Date(local.getTime() - fallbackMinutes * 60_000);
  }
  // With a named tz we reconstruct the instant via Intl parts.
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(local);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')));
  } catch {
    return new Date(local.getTime() - fallbackMinutes * 60_000);
  }
}
