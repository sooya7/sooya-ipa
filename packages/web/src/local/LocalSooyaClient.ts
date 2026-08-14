import type { LocalEventListener } from './LocalEventBus.js';
import type { LocalCoreFacade, SooyaClient } from '../lib/sooyaClient.js';
import { toUploadInput } from '../lib/sooyaClient.js';

/** Direct in-process client. It deliberately has no URL, token, or fetch seam. */
export class LocalSooyaClient implements SooyaClient {
  constructor(private readonly core: LocalCoreFacade, private readonly resolveBuiltin?: (id: string) => string | null) {}

  bootstrap: SooyaClient['bootstrap'] = () => this.core.bootstrap();
  messages: SooyaClient['messages'] = (options) => this.core.messages(options);
  messageSearch: SooyaClient['messageSearch'] = (query, options) => this.core.messageSearch(query, options);
  messagesByDate: SooyaClient['messagesByDate'] = (date, timeZone, limit) => this.core.messagesByDate(date, timeZone, limit);
  messageContext: SooyaClient['messageContext'] = (id, options) => this.core.messageContext(id, options);
  send: SooyaClient['send'] = (payload) => this.core.send(payload);
  withdraw: SooyaClient['withdraw'] = (id) => this.core.withdraw(id);
  retryBatch: SooyaClient['retryBatch'] = (id) => this.core.retryBatch(id);
  upload: SooyaClient['upload'] = async (files, options) => this.core.upload(await toUploadInput(files), options);
  moments: SooyaClient['moments'] = (limit) => this.core.moments(limit);
  likeMoment: SooyaClient['likeMoment'] = (id, liked) => this.core.likeMoment(id, liked);
  stickerSearch: SooyaClient['stickerSearch'] = (options) => this.core.stickerSearch(options);
  life: SooyaClient['life'] = () => this.core.life();
  presence: SooyaClient['presence'] = () => this.core.presence();
  capabilities: SooyaClient['capabilities'] = () => this.core.capabilities();
  adminRequest: NonNullable<SooyaClient['adminRequest']> = (path, options) => this.core.adminRequest(path, options);
  resolveBuiltinMediaUrl = (id: string): string | null => this.resolveBuiltin?.(id) ?? null;
  subscribe(listener: LocalEventListener): () => void { return this.core.subscribe(listener); }
}
