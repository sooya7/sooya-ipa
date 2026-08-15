/**
 * Shared revision-fence error (server parity for the server's
 * util/abort.ts StaleGenerationError). Media/voice pipelines throw it when
 * they notice the batch revision moved on; the reply coordinator must treat
 * it as superseded — never as provider_failed — so the batch state machine
 * stays truthful.
 */
export class StaleGenerationError extends Error {
  override name = 'StaleGenerationError';
  constructor(message = 'generation revision is stale') {
    super(message);
  }
}
