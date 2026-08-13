export * from './database.js';
export * from './secrets.js';
export * from './http.js';
export * from './media.js';
export * from './mcp.js';
export * from './logger.js';
export * from './lifecycle.js';

import type { DatabasePlatform } from './database.js';
import type { HttpPlatform } from './http.js';
import type { LifecyclePlatform } from './lifecycle.js';
import type { LoggerPlatform } from './logger.js';
import type { McpPlatform } from './mcp.js';
import type { MediaPlatform } from './media.js';
import type { SecretsPlatform } from './secrets.js';

export interface SooyaPlatform {
  database: DatabasePlatform;
  secrets: SecretsPlatform;
  http: HttpPlatform;
  media: MediaPlatform;
  mcp: McpPlatform;
  logger: LoggerPlatform;
  lifecycle: LifecyclePlatform;
}

export type PlatformContracts = SooyaPlatform;

