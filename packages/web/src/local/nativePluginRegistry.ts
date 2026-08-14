import { registerPlugin } from '@capacitor/core';

/**
 * App-local Capacitor plugins are not npm plugins, so Capacitor cannot discover
 * their JavaScript proxies automatically. Register every native bridge name
 * once before nativeBoot.ts reads Capacitor.Plugins.
 */
export const NATIVE_LOCAL_PLUGIN_NAMES = [
  'SOOYADatabase',
  'SOOYASecrets',
  'SOOYAMedia',
  'SOOYAHttp',
  'SOOYAMcp',
  'SOOYAArchive',
  'SOOYAWebSocket',
  'SOOYARelease'
] as const;

for (const name of NATIVE_LOCAL_PLUGIN_NAMES) registerPlugin(name);
