import { describe, expect, it, vi } from 'vitest';
import { LocalEventBus } from '../local/LocalEventBus.js';
import { LocalSooyaClient } from '../local/LocalSooyaClient.js';
import { clearSooyaClient, currentSooyaClient, installSooyaClient } from './sooyaClient.js';
import { TestLocalClient } from '../local/TestLocalClient.js';

describe('LocalEventBus', () => {
  it('keeps nested emissions ordered and isolates a broken subscriber', () => {
    const errors: unknown[] = [];
    const bus = new LocalEventBus({ onListenerError: (error) => errors.push(error) });
    const seen: string[] = [];

    bus.subscribe((event) => {
      seen.push(`first:${event.type}`);
      if (event.type === 'message.received') bus.emit('reply.batch.queued', { batchId: 'b1' });
    });
    bus.subscribe((event) => {
      seen.push(`second:${event.type}`);
      if (event.type === 'message.received') throw new Error('listener failed');
    });

    const event = bus.emit('message.received', { message: { id: 'm1' } });

    expect(event.seq).toBe(1);
    expect(seen).toEqual([
      'first:message.received',
      'second:message.received',
      'first:reply.batch.queued',
      'second:reply.batch.queued'
    ]);
    expect(errors).toHaveLength(1);
  });

  it('unsubscribes exactly one listener', () => {
    const bus = new LocalEventBus();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = bus.subscribe(first);
    bus.subscribe(second);

    unsubscribe();
    bus.emit('life.updated', { activity: 'reading' });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});

describe('LocalSooyaClient', () => {
  it('delegates directly to Local Core and never uses fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const unsubscribe = vi.fn();
    const facade = {
      bootstrap: vi.fn(async () => ({ ready: true })),
      messages: vi.fn(async (options: unknown) => ({ options })),
      send: vi.fn(async (payload: unknown) => ({ payload })),
      subscribe: vi.fn(() => unsubscribe)
    };
    const client = new LocalSooyaClient(facade as never);
    const listener = vi.fn();

    await client.bootstrap();
    await client.messages({ limit: 20 });
    await client.send({ clientMsgId: 'c1', content: [{ type: 'text', text: 'hi' }] });
    const stop = client.subscribe(listener);
    stop();

    expect(facade.bootstrap).toHaveBeenCalledOnce();
    expect(facade.messages).toHaveBeenCalledWith({ limit: 20 });
    expect(facade.send).toHaveBeenCalledWith({ clientMsgId: 'c1', content: [{ type: 'text', text: 'hi' }] });
    expect(facade.subscribe).toHaveBeenCalledWith(listener);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('installs one client for the native runtime without browser storage', () => {
    const client = new TestLocalClient();
    installSooyaClient(client);
    expect(currentSooyaClient()).toBe(client);
    clearSooyaClient();
    expect(currentSooyaClient()).toBeNull();
  });
});

describe('TestLocalClient', () => {
  it('persists a deterministic local send and emits the existing event contract', async () => {
    const client = new TestLocalClient({ now: () => new Date('2026-08-13T02:00:00.000Z') });
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));

    const sent = await client.send({ clientMsgId: 'c1', content: [{ type: 'text', text: '你好' }] });
    const page = await client.messages({ limit: 10 });

    expect(sent.message).toMatchObject({ role: 'user', seq: 1, clientMsgId: 'c1', status: 'sent' });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.content[0]).toMatchObject({ type: 'text', text: '你好' });
    expect(events).toEqual(['message.received']);
  });

  it('de-duplicates a retried client message and updates moments locally', async () => {
    const client = new TestLocalClient();
    const payload = { clientMsgId: 'same', content: [{ type: 'text', text: 'once' }] };

    const first = await client.send(payload);
    const duplicate = await client.send(payload);
    const created = client.addMoment({ text: '今天去散步', activity: 'walking' });
    const liked = await client.likeMoment(created.id, true);

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.message.id).toBe(first.message.id);
    expect((await client.messages()).messages).toHaveLength(1);
    expect(liked.moment.liked).toBe(true);
  });
});
