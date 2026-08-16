import type { LocalAdminRequestOptions } from './types.js';

export type NativeAdminMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface NativeAdminRouteContext {
  path: string;
  route: string;
  method: NativeAdminMethod;
  url: URL;
  rawBody: unknown;
  body: Record<string, unknown>;
  options: LocalAdminRequestOptions;
}

export interface NativeAdminRoute {
  /** Stable capability key exposed by /api/admin/native-capabilities. */
  capability: string;
  /** Methods allowed by this entry; undefined means the handler accepts any
   * method (legacy behavior preserved for read-only routes). */
  methods?: readonly NativeAdminMethod[];
  /** True when this registry entry owns the route. Entries are evaluated in
   * declaration order, exactly like the old if-chain. */
  matches: (route: string) => boolean;
  handler: (context: NativeAdminRouteContext) => Promise<unknown>;
}

export function exactRoute(path: string): (route: string) => boolean {
  return (route) => route === path;
}

export function prefixRoute(path: string): (route: string) => boolean {
  return (route) => route.startsWith(path);
}

export function regexRoute(pattern: RegExp): (route: string) => boolean {
  return (route) => pattern.test(route);
}

export function methodSet(...methods: NativeAdminMethod[]): readonly NativeAdminMethod[] {
  return methods;
}
