import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalCore } from '../../src/app/local-core.js';
import type { HttpPlatform, HttpResponse } from '../../src/platform/http.js';
import type { MediaPlatform, MediaRecord, MediaSaveRequest } from '../../src/platform/media.js';
import type { SecretsPlatform } from '../../src/platform/secrets.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { NodeLocalDatabase } from '../db/node-local-database.js';
import { rmSync } from 'node:fs';

class MemoryMediaStore implements MediaPlatform {
  private next = 1;
  readonly records = new Map<string, { record: MediaRecord; data: Uint8Array }>();
  async save(request: MediaSaveRequest): Promise<MediaRecord> {
    const record: MediaRecord = { id: `mem-media-${this.next++}`, kind: request.kind, mime: request.mime ?? 'application/octet-stream', bytes: request.data.byteLength, name: request.name };
    this.records.set(record.id, { record, data: new Uint8Array(request.data) });
    return record;
  }
  async read(id: string) { const entry = this.records.get(id); return entry ? { record: entry.record, data: entry.data } : null; }
  async remove(id: string) { return this.records.delete(id); }
}

class MemorySecrets implements SecretsPlatform {
  private readonly values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); }
  async remove(key: string) { this.values.delete(key); }
}

function jsonHttp(response: Record<string, unknown>): HttpPlatform {
  return {
    async request(input) {
      const body = new TextEncoder().encode(JSON.stringify(response));
      return { status: 200, headers: { 'content-type': typeof input.headers?.['accept'] === 'string' ? input.headers['accept'] : 'application/json' }, body } as HttpResponse;
    },
    async stream() { throw new Error('not used'); }
  };
}

describe('admin bridge truthfulness contract', () => {
  let db: NodeLocalDatabase;
  let core: LocalCore;
  let media: MemoryMediaStore;
  const backupNames: string[] = [];

  beforeEach(async () => {
    db = new NodeLocalDatabase();
    await migrateDatabase(db);
    media = new MemoryMediaStore();
    core = new LocalCore({ db, mediaStore: media, secrets: new MemorySecrets(), startedAt: '2026-08-16T00:00:00.000Z', version: 'test.1' });
  });

  afterEach(async () => {
    for (const name of backupNames) rmSync(name, { force: true });
    backupNames.length = 0;
    await db.close();
  });

  it('throws on unknown admin routes instead of returning {}', async () => {
    await expect(core.adminRequest('/api/admin/not-a-real-route', { method: 'PUT', body: { x: 1 } })).rejects.toThrow(/尚未接入设备端/);
  });

  it('surfaces runtime diagnostics written by platform adapters', async () => {
    await core.recordRuntimeError('ota.check', 'manifest signature invalid');
    const errors = await core.adminRequest<{ errors: Array<{ scope: string; message: string }> }>('/api/admin/errors');
    expect(errors.errors).toEqual([expect.objectContaining({ scope: 'ota.check', message: 'manifest signature invalid' })]);
    const cleared = await core.adminRequest<{ cleared: boolean }>('/api/admin/errors', { method: 'DELETE' });
    expect(cleared.cleared).toBe(true);
  });

  it('advertises native admin capabilities based on actual platform seams', async () => {
    const capabilities = await core.adminRequest<Record<string, boolean>>('/api/admin/native-capabilities');
    expect(capabilities.metrics).toBe(true);
    expect(capabilities.storageCleanup).toBe(true);
    expect(capabilities.backupVerify).toBe(true);
    expect(capabilities.backupDelete).toBe(true);
    expect(capabilities.ombreRemoteSearch).toBe(false);
  });

  it('returns real metrics and system database counts', async () => {
    await core.metricsRepo.record('reply', 'latency_ms', 100, '2026-08-16');
    const system = await core.adminRequest<{ database: { messages: number; memories: number; media: number }; storage: { mediaBytes: number; backupBytes: number }; version: string; uptimeSec: number }>('/api/admin/system');
    expect(system.version).toBe('test.1');
    expect(system.database.messages).toBe(0);
    expect(system.storage.backupBytes).toBe(0);
    const metrics = await core.adminRequest<{ aggregates: Array<{ category: string; metric: string; count: number }> }>('/api/admin/metrics?days=7');
    expect(metrics.aggregates).toEqual([{ category: 'reply', metric: 'latency_ms', count: 1, sum: 100, avg: 100 }]);
  });

  it('applies media filters including state=all and blocks referenced hard-deletes in Core', async () => {
    const first = await core.upload([{ name: 'a.png', mime: 'image/png', bytes: new Uint8Array([1]), field: 'image' }]);
    await core.mediaRepo.trash(first.media[0]!.id);
    const second = await core.upload([{ name: 'b.png', mime: 'image/png', bytes: new Uint8Array([2]), field: 'image' }]);
    const id = second.media[0]!.id;
    await core.messagesRepo.create({ role: 'user', parts: [{ type: 'image', mediaId: id }] });

    const all = await core.adminRequest<{ total: number }>('/api/admin/media?state=all');
    expect(all.total).toBe(2);
    const active = await core.adminRequest<{ total: number }>('/api/admin/media?state=active');
    expect(active.total).toBe(1);
    await expect(core.adminRequest(`/api/admin/media/${encodeURIComponent(id)}`, { method: 'DELETE' })).rejects.toThrow(/仍被 1 处引用/);
  });

  it('marks persona avatar media as protected and enforces it in Core', async () => {
    const uploaded = await core.upload([{ name: 'avatar.png', mime: 'image/png', bytes: new Uint8Array([9]), field: 'image' }]);
    const id = uploaded.media[0]!.id;
    await core.adminRequest('/api/admin/persona', { method: 'PUT', body: { avatar: `local-media://${id}` } });
    const usage = await core.adminRequest<{ avatar: boolean }>(`/api/admin/media/${encodeURIComponent(id)}/usage`);
    expect(usage.avatar).toBe(true);
    await expect(core.adminRequest(`/api/admin/media/${encodeURIComponent(id)}`, { method: 'DELETE' })).rejects.toThrow(/头像/);
  });

  it('persists storage policy and builds an honest cleanup preview', async () => {
    await core.settingsRepo.set('persona', { id: 'local', name: 'SOOYA', avatar: '', userAvatar: '', tagline: '在的', systemPrompt: '', language: 'zh-CN', stickerPolicy: {}, voicePolicy: {}, imagePolicy: {} });
    const saved = await core.adminRequest<{ policy: { trashRetentionDays: number; softLimitBytes: number } }>('/api/admin/storage/policy', { method: 'PUT', body: { trashRetentionDays: 9, softLimitBytes: 1024 * 1024 } });
    expect(saved.policy.trashRetentionDays).toBe(9);
    const preview = await core.adminRequest<{ report: { reclaimableBytes: number; applied: boolean; candidates: Record<string, unknown[]> } }>('/api/admin/storage/cleanup', { method: 'POST', body: { apply: false } });
    expect(preview.report.applied).toBe(false);
  });

  it('maps backup rows to the admin DTO and deletes the actual backup file', async () => {
    const name = `contract-${Date.now().toString(36)}.sqlite3`;
    backupNames.push(name);
    await core.adminRequest('/api/admin/backups', { method: 'POST' });
    const created = await core.adminRequest<{ backups: Array<{ name: string; createdAt: string; state: string }> }>('/api/admin/backups');
    expect(created.backups[0]).toMatchObject({ name: expect.any(String), state: 'ready' });
    backupNames.push(created.backups[0]!.name);
    // create a second known-name backup through the DB port so delete can be exercised
    await db.backup(name);
    await db.run("INSERT INTO local_backup_metadata(id,target,state,schema_version,created_at,detail_json) VALUES(?,?,'ready',?,?,'{}')", [name, name, 99, '2026-08-16T00:00:00.000Z']);
    const deleted = await core.adminRequest<{ deleted: boolean }>(`/api/admin/backups/${encodeURIComponent(name)}`, { method: 'DELETE' });
    expect(deleted.deleted).toBe(true);
    await expect(db.verifyBackup!(name)).rejects.toThrow();
  });

  it('filters chat history by role, media presence and text', async () => {
    await core.messagesRepo.create({ role: 'user', parts: [{ type: 'text', text: '今天天气不错' }] });
    await core.messagesRepo.create({ role: 'assistant', parts: [{ type: 'text', text: '是呀，适合散步' }] });
    await core.messagesRepo.create({ role: 'user', parts: [{ type: 'audio', text: null, transcript: '语音消息' }] });
    const userOnly = await core.adminRequest<{ total: number; messages: Array<{ role: string }> }>('/api/admin/chat/history?role=user');
    expect(userOnly.total).toBe(2);
    expect(userOnly.messages.every((message) => message.role === 'user')).toBe(true);
    const search = await core.adminRequest<{ total: number }>(`/api/admin/chat/history?q=${encodeURIComponent('散步')}`);
    expect(search.total).toBe(1);
  });

  it('runs a real web-search test and reports ok=false when unconfigured', async () => {
    const http = jsonHttp({ Result: { WebResults: [{ Title: '结果', Url: 'https://example.test', Summary: '摘要' }] } });
    const withHttp = new LocalCore({ db, mediaStore: media, secrets: new MemorySecrets(), http });
    const unconfigured = await withHttp.adminRequest<{ ok: boolean; detail: string }>('/api/admin/models/web-search/test', { method: 'POST', body: { provider: 'doubao', query: '测试' } });
    expect(unconfigured.ok).toBe(false);
    expect(unconfigured.detail).toContain('未配置');
    await withHttp.adminRequest('/api/admin/models', { method: 'PUT', body: { webSearch: { enabled: true, providers: ['doubao'], maxResults: 3, timeoutMs: 1000, doubao: { edition: 'custom', baseUrl: 'https://search.test', apiKey: 'key' } } } });
    const configured = await withHttp.adminRequest<{ ok: boolean; resultCount: number }>('/api/admin/models/web-search/test', { method: 'POST', body: { provider: 'doubao', query: '测试' } });
    expect(configured.ok).toBe(true);
    expect(configured.resultCount).toBe(1);
  });

  it('returns real sticker facets and filtered totals', async () => {
    const a = await core.upload([{ name: 'a.png', mime: 'image/png', bytes: new Uint8Array([1]), field: 'image' }]);
    const b = await core.upload([{ name: 'b.png', mime: 'image/png', bytes: new Uint8Array([2]), field: 'image' }]);
    await core.stickersRepo.create({ mediaId: a.media[0]!.id, name: 'A', analysisStatus: 'ready', analysisSource: 'ai', emotion: 'happy' });
    await core.stickersRepo.create({ mediaId: b.media[0]!.id, name: 'B', analysisStatus: 'pending', analysisSource: 'manual', emotion: 'happy' });
    const result = await core.adminRequest<{ total: number; facets: { status: Record<string, number>; source: Record<string, number>; emotion: Record<string, number> } }>('/api/admin/stickers?status=ready');
    expect(result.total).toBe(1);
    expect(result.facets.status.ready).toBe(1);
    expect(result.facets.status.pending).toBeUndefined();
    expect(result.facets.emotion.happy).toBe(1);
  });
});
