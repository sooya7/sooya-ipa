import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * Source contracts for the media/voice server-parity work (§15 of the parity
 * plan). These exist so a future refactor cannot quietly slide back into the
 * "read the whole reply aloud" era or add billable retry loops.
 */
describe('voice parity contracts', () => {
  it('the reply coordinator never calls TTS directly', async () => {
    const source = await readFile(new URL('./reply-coordinator.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('.synthesize(');
    expect(source).toContain('this.options.voiceService.synthesizeInlineVoice');
  });

  it('the only TTS entry point feeds it the synthesis text, never the reply text', async () => {
    const source = await readFile(new URL('./voice/service.ts', import.meta.url), 'utf8');
    expect(source).toContain('ttsProvider.synthesize(fishSynthesis?.text ?? synthesisText');
    // read_aloud is the only mode whose spokenText starts from the raw text.
    expect(source).toMatch(/mode === 'read_aloud'\s*\)?\s*{?\s*script = \{\s*spokenText: args\.finalText/);
    // The transcript persisted on the audio part is the spoken text.
    expect(source).toContain('transcript: spokenText');
  });

  it('generation providers are never auto-retried', async () => {
    const source = await readFile(new URL('./voice/service.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('ttsRetries');
    expect(source).not.toMatch(/for \(let attempt[\s\S]{0,80}synthesize/);
  });

  it('the voice-only draft stays hidden until the voice phase opens the shell', async () => {
    const source = await readFile(new URL('./reply-coordinator.ts', import.meta.url), 'utf8');
    expect(source).toContain('holdDraft');
    expect(source).toContain('if (!holdDraft) {');
    expect(source).toContain('openShell');
    // Interruptions must propagate, never degrade into media fallbacks.
    expect(source).toContain('if (isInterruption(error, signal)) throw error');
  });
});
