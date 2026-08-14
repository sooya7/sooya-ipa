import { Capacitor, registerPlugin } from '@capacitor/core';
import { withLegacyNativePluginCall } from './nativePluginAdapter.js';

/**
 * App-local Capacitor plugins are not npm plugins, so Capacitor cannot discover
 * their JavaScript proxies automatically. Register every native bridge name
 * once before nativeBoot.ts reads the legacy Capacitor.Plugins compatibility
 * map used by the existing adapters.
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

const capacitor = Capacitor as unknown as { Plugins?: Record<string, unknown> };
const plugins = capacitor.Plugins ?? {};
for (const name of NATIVE_LOCAL_PLUGIN_NAMES) {
  const proxy = registerPlugin(name) as Record<string, unknown>;
  plugins[name] = withLegacyNativePluginCall(proxy, name);
}
capacitor.Plugins = plugins;
