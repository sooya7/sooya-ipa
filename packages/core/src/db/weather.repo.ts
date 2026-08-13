import type { LocalDatabase } from '../platform/database.js';
import { clampInteger, nowIso, queryOne } from './database.js';

export type WeatherCondition = 'clear' | 'cloudy' | 'rain' | 'snow' | 'storm' | 'fog' | 'wind' | 'unknown';
export interface WeatherSnapshotRow { location_key:string; observed_at:string; condition:WeatherCondition; temperature_c:number|null; feels_like_c:number|null; humidity:number|null; precipitation_mm:number|null; wind_kph:number|null; visibility_km:number|null; pressure_hpa:number|null; provider:string; created_at:string; }
export interface WeatherSnapshot { observedAt:string; condition:WeatherCondition; temperatureC?:number; feelsLikeC?:number; humidity?:number; precipitationMm?:number; windKph?:number; visibilityKm?:number; pressureHpa?:number; provider:string; locationKey:string; stale:boolean; degraded?:boolean; }
export interface WeatherForecastRow { location_key:string; generated_at:string; provider:string; periods_json:string; created_at:string; }
export interface WeatherDaylightRow { location_key:string; local_date:string; sunrise:string; sunset:string; provider:string; created_at:string; }

export class WeatherRepo {
  constructor(private readonly db:LocalDatabase,private readonly now:()=>Date=()=>new Date()){}
  async latest(locationKey:string):Promise<WeatherSnapshotRow|undefined>{return await queryOne(this.db,'SELECT * FROM weather_snapshots WHERE location_key=? ORDER BY observed_at DESC LIMIT 1',[locationKey]);}
  async save(snapshot:Omit<WeatherSnapshotRow,'created_at'>):Promise<WeatherSnapshotRow>{const row={...snapshot,created_at:nowIso(this.now)};await this.db.run(`INSERT INTO weather_snapshots(location_key,observed_at,condition,temperature_c,feels_like_c,humidity,precipitation_mm,wind_kph,visibility_km,pressure_hpa,provider,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,[row.location_key,row.observed_at,row.condition,row.temperature_c,row.feels_like_c,row.humidity,row.precipitation_mm,row.wind_kph,row.visibility_km,row.pressure_hpa,row.provider,row.created_at]);return row;}
  async recent(locationKey:string,limit=20):Promise<WeatherSnapshotRow[]>{return await this.db.query('SELECT * FROM weather_snapshots WHERE location_key=? ORDER BY observed_at DESC LIMIT ?',[locationKey,clampInteger(limit,1,100)]);}
  async latestForecast(locationKey:string):Promise<WeatherForecastRow|undefined>{return await queryOne(this.db,'SELECT * FROM weather_forecasts WHERE location_key=? ORDER BY generated_at DESC LIMIT 1',[locationKey]);}
  async saveForecast(input:Omit<WeatherForecastRow,'created_at'>):Promise<WeatherForecastRow>{const row={...input,created_at:nowIso(this.now)};await this.db.run('INSERT INTO weather_forecasts(location_key,generated_at,provider,periods_json,created_at) VALUES(?,?,?,?,?)',[row.location_key,row.generated_at,row.provider,row.periods_json,row.created_at]);return row;}
  async daylightFor(locationKey:string,localDate:string):Promise<WeatherDaylightRow|undefined>{return await queryOne(this.db,'SELECT * FROM weather_daylight WHERE location_key=? AND local_date=?',[locationKey,localDate]);}
  async saveDaylight(input:Omit<WeatherDaylightRow,'created_at'>):Promise<WeatherDaylightRow>{const row={...input,created_at:nowIso(this.now)};await this.db.run(`INSERT INTO weather_daylight(location_key,local_date,sunrise,sunset,provider,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(location_key,local_date) DO UPDATE SET sunrise=excluded.sunrise,sunset=excluded.sunset,provider=excluded.provider,created_at=excluded.created_at`,[row.location_key,row.local_date,row.sunrise,row.sunset,row.provider,row.created_at]);return row;}
}

export function toWeatherSnapshot(row:WeatherSnapshotRow,stale:boolean):WeatherSnapshot{return{observedAt:row.observed_at,condition:row.condition,temperatureC:row.temperature_c??undefined,feelsLikeC:row.feels_like_c??undefined,humidity:row.humidity??undefined,precipitationMm:row.precipitation_mm??undefined,windKph:row.wind_kph??undefined,visibilityKm:row.visibility_km??undefined,pressureHpa:row.pressure_hpa??undefined,provider:row.provider,locationKey:row.location_key,stale};}

