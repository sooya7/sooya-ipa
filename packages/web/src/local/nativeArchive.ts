import { Capacitor } from '@capacitor/core';

export interface NativeArchiveInfo { name?: string; path?: string; bytes: number; fileCount: number; sha256: string; verified?: boolean; }

interface ArchivePlugin {
  call<T>(method: string, options: Record<string, unknown>): Promise<T>;
}

/** JS seam for the native ZIP bridge; browser builds never invoke it. */
export class NativeArchive {
  private readonly plugin: ArchivePlugin | null;
  constructor(plugin?: ArchivePlugin | null) {
    this.plugin = plugin ?? ((Capacitor as unknown as { Plugins?: Record<string, unknown> }).Plugins?.SOOYAArchive as ArchivePlugin | undefined) ?? null;
  }
  async create(sourcePath: string, archiveName: string): Promise<NativeArchiveInfo> { return await this.require().call('create', { sourcePath, archiveName }); }
  async extract(archiveName: string, destinationPath: string): Promise<NativeArchiveInfo> { return await this.require().call('extract', { archiveName, destinationPath }); }
  async verify(archiveName: string, sha256?: string): Promise<NativeArchiveInfo> { return await this.require().call('verify', { archiveName, ...(sha256 ? { sha256 } : {}) }); }
  async cleanup(path: string): Promise<{ removed: boolean; path: string }> { return await this.require().call('cleanup', { path }); }
  private require(): ArchivePlugin { if (!this.plugin) throw new Error('native archive bridge is unavailable'); return this.plugin; }
}
