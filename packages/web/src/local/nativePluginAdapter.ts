export interface LegacyNativePluginCall {
  call<T = Record<string, unknown>>(method: string, options: Record<string, unknown>): Promise<T>;
}

/**
 * LocalCore's native adapters predate Capacitor 8 and call native methods
 * through a small `plugin.call(method, options)` compatibility seam. A
 * Capacitor `registerPlugin()` proxy exposes methods directly instead
 * (`plugin.open(options)`), and asking that proxy for `call` attempts to invoke
 * a real native method named `call`.
 *
 * Wrap the Capacitor proxy so the old seam dispatches to the named direct
 * method while all direct properties, including callback-style methods such as
 * HTTP `stream`, continue to pass through untouched.
 */
export function withLegacyNativePluginCall<T extends object>(plugin: T, pluginName: string): T & LegacyNativePluginCall {
  const invoke = async <R = Record<string, unknown>>(method: string, options: Record<string, unknown>): Promise<R> => {
    const candidate = Reflect.get(plugin, method);
    if (typeof candidate !== 'function') throw new Error(`native plugin ${pluginName}.${method} is unavailable`);
    return await Reflect.apply(candidate, plugin, [options]) as R;
  };

  return new Proxy(plugin as T & LegacyNativePluginCall, {
    get(target, property, receiver) {
      if (property === 'call') return invoke;
      return Reflect.get(target, property, receiver);
    }
  });
}
