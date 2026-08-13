import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../src/db/migrations.js';
import {
  AuditRepo,
  EventRepo,
  JobRepo,
  LifeRepo,
  LocationRepo,
  MediaRepo,
  MemoryRepo,
  MessageRepo,
  MetricsRepo,
  MomentRepo,
  ReplyBatchRepo,
  SettingsRepo,
  StickerRepo,
  SummaryRepo,
  ThoughtRepo,
  VoiceRepo,
  WeatherRepo
} from '../../src/db/index.js';
import { NodeLocalDatabase } from './node-local-database.js';

describe('async Core repositories', () => {
  let db: NodeLocalDatabase;

  beforeEach(async () => {
    db = new NodeLocalDatabase();
    await migrateDatabase(db);
  });

  afterEach(async () => db.close());

  it('performs representative CRUD through awaited LocalDatabase calls', async () => {
    const settings = new SettingsRepo(db);
    await settings.set('persona', { name: 'SOOYA' });
    await expect(settings.get('persona', null)).resolves.toEqual({ name: 'SOOYA' });

    const media = new MediaRepo(db);
    const image = await media.create({ kind: 'image', relPath: 'media/a.png', mime: 'image/png', bytes: 3, sha256: 'abc', origin: 'upload' });
    await expect(media.get(image.id)).resolves.toMatchObject({ id: image.id, animated: 0 });

    const messages = new MessageRepo(db);
    const created = await messages.create({ role: 'user', clientMsgId: 'client-1', parts: [{ type: 'text', text: '你好，本地数据库' }] });
    expect(created.created).toBe(true);
    await expect(messages.get(created.message.id)).resolves.toMatchObject({ content: [{ text: '你好，本地数据库' }] });

    const duplicate = await messages.create({ role: 'user', clientMsgId: 'client-1', parts: [{ type: 'text', text: '不应覆盖' }] });
    expect(duplicate).toMatchObject({ created: false, message: { id: created.message.id } });

    const stickers = new StickerRepo(db);
    const stickerMedia = await media.create({ kind: 'sticker', relPath: 'stickers/a.webp', mime: 'image/webp', bytes: 4, sha256: 'sticker', origin: 'upload' });
    const sticker = await stickers.create({ mediaId: stickerMedia.id, name: '开心', tags: ['笑'] });
    await expect(stickers.update(sticker.id, { favorite: true, description: '开心地笑' })).resolves.toMatchObject({ favorite: true });

    const summary = await new SummaryRepo(db).create({ fromSeq: 1, toSeq: created.message.seq, content: '打了招呼' });
    expect(summary.version).toBe(1);
    const event = await new EventRepo(db).append('message.received', { id: created.message.id });
    expect(event.seq).toBe(1);
    const job = await new JobRepo(db).enqueue('memory.embed', { id: 'm1' });
    await expect(new JobRepo(db).claimNext()).resolves.toMatchObject({ id: job.id, status: 'running' });

    const audit = new AuditRepo(db);
    await audit.add('settings', 'updated', 'persona', { safe: true });
    await expect(audit.list()).resolves.toHaveLength(1);
  });

  it('covers life, location, weather, metrics, thoughts, moments, batches, voice and memory', async () => {
    const life = new LifeRepo(db);
    await life.advance({ activity: '起床', kind: 'routine', mood: 'calm', startedAt: '2026-08-13T00:00:00.000Z', endsAt: '2026-08-13T01:00:00.000Z' });
    await life.advance({ activity: '早餐', kind: 'meal', mood: 'happy', startedAt: '2026-08-13T01:00:00.000Z', endsAt: '2026-08-13T02:00:00.000Z' });
    await expect(life.recent()).resolves.toMatchObject([{ activity: '起床' }]);

    const locations = new LocationRepo(db);
    const home = await locations.create({ key: 'home', name: '家', kind: 'home', timeZone: 'Asia/Shanghai' });
    await locations.setState({ locationId: home.id, arrivedAt: '2026-08-13T00:00:00.000Z' });
    await expect(locations.currentState()).resolves.toMatchObject({ location_id: home.id });

    const weather = new WeatherRepo(db);
    await weather.save({ location_key: 'home', observed_at: '2026-08-13T00:00:00.000Z', condition: 'clear', temperature_c: 26, feels_like_c: 27, humidity: 0.5, precipitation_mm: 0, wind_kph: 5, visibility_km: 10, pressure_hpa: 1010, provider: 'fixture' });
    await expect(weather.latest('home')).resolves.toMatchObject({ condition: 'clear' });

    const metrics = new MetricsRepo(db);
    await metrics.record('reply', 'latency_ms', 100, '2026-08-13');
    await metrics.record('reply', 'latency_ms', 200, '2026-08-13');
    await expect(metrics.aggregates('2026-08-13', '2026-08-13')).resolves.toMatchObject([{ count: 2, sum: 300 }]);

    const messages = new MessageRepo(db);
    const user = (await messages.create({ role: 'user', parts: [{ type: 'text', text: '在吗' }] })).message;
    const batches = new ReplyBatchRepo(db);
    const admission = await batches.appendOrCreateMessage(user.id, '2026-08-13T03:00:00.000Z', '2026-08-13T02:30:00.000Z');
    expect(admission.action).toBe('created');

    const assistant = (await messages.create({ role: 'assistant', batchId: admission.batch.id, parts: [{ type: 'text', text: '在的' }] })).message;
    const thoughts = new ThoughtRepo(db);
    const thought = await thoughts.create({ messageId: assistant.id, batchId: admission.batch.id, revision: 1, kind: 'inner_monologue', visibility: 'user' });
    await expect(thoughts.completeThought(thought.id, '她来找我了。')).resolves.toBe(true);

    const moments = new MomentRepo(db);
    const moment = await moments.create({ candidateId: 'candidate-1', text: '早餐时间', activity: '早餐' });
    await expect(moments.setLiked(moment.id, true)).resolves.toMatchObject({ liked: 1 });

    const voices = new VoiceRepo(db);
    const voice = await voices.create({ batchId: admission.batch.id, revision: 1, mode: 'auto', requestedBy: 'auto', spokenText: '在的', synthesisText: '在的' });
    await voices.update(voice.id, { status: 'published', message_id: assistant.id });
    await expect(voices.get(voice.id)).resolves.toMatchObject({ status: 'published', message_id: assistant.id });

    const memories = new MemoryRepo(db);
    const memory = await memories.upsert({ kind: 'preference', content: '用户喜欢猫', sourceMessageId: user.id });
    expect(memory.merged).toBe(false);
    await expect(memories.get(memory.record.id)).resolves.toMatchObject({ content: '用户喜欢猫', source: 'local' });
  });
});

