import { describe, expect, it } from 'vitest';
import { decideVoiceMode, type VoiceDecisionInput } from './planner.js';

const base: VoiceDecisionInput = {
  userIntent: 'none',
  text: '我知道啦。今天如果累就早点休息，别硬撑。',
  persona: { name: 'SOOYA', voicePolicy: { enabled: true, maxCharsPerClip: 300 } },
  preferences: { enabled: true, autoVoiceFrequency: 'never', preferredModes: ['replace', 'complement'], maxVoiceSeconds: 35 },
  ttsConfigured: true,
  recentAutoCount: 0,
  dailyAutoCap: 20,
  inSilentHours: false
};

describe('decideVoiceMode (server parity §22.4)', () => {
  it('maps hard user intents', () => {
    expect(decideVoiceMode({ ...base, userIntent: 'no_voice' })).toMatchObject({ mode: null, requestedBy: 'user', reason: 'no_voice' });
    expect(decideVoiceMode({ ...base, userIntent: 'voice_reply' })).toMatchObject({ mode: 'replace', requestedBy: 'user' });
    expect(decideVoiceMode({ ...base, userIntent: 'voice_only' })).toMatchObject({ mode: 'replace', requestedBy: 'user' });
    expect(decideVoiceMode({ ...base, userIntent: 'read_aloud' })).toMatchObject({ mode: 'read_aloud', requestedBy: 'user' });
  });

  it('maps model markers conservatively', () => {
    expect(decideVoiceMode({ ...base, modelVoice: true })).toMatchObject({ mode: 'complement', requestedBy: 'model' });
    expect(decideVoiceMode({ ...base, modelVoice: 'complement' })).toMatchObject({ mode: 'complement' });
    expect(decideVoiceMode({ ...base, modelVoice: 'summary' })).toMatchObject({ mode: 'summary' });
    // The model alone can never hide the text: voice-only degrades to complement.
    expect(decideVoiceMode({ ...base, modelVoice: 'replace', userIntent: 'none' })).toMatchObject({ mode: 'replace', requestedBy: 'model' });
    expect(decideVoiceMode({ ...base, modelVoice: 'read_aloud' })).toMatchObject({ mode: 'read_aloud', requestedBy: 'model' });
  });

  it('disables everything when voice policy, tts or preferences are off', () => {
    expect(decideVoiceMode({ ...base, persona: { ...base.persona, voicePolicy: { enabled: false, maxCharsPerClip: 300 } } }).mode).toBeNull();
    expect(decideVoiceMode({ ...base, ttsConfigured: false }).mode).toBeNull();
    expect(decideVoiceMode({ ...base, preferences: { ...base.preferences, enabled: false } }).mode).toBeNull();
  });

  it('never auto-fires while autoVoiceFrequency is pinned to never', () => {
    const decision = decideVoiceMode({ ...base, text: '晚安，早点睡个好觉哦', preferences: { ...base.preferences, autoVoiceFrequency: 'never' } });
    expect(decision.mode).toBeNull();
    expect(decision.reason).toBe('auto_never');
  });
});
