import type { TTSOptions } from '../../providers/types.js';

/**
 * Emotion presets and text-based detection (server parity, from the server's
 * core/voice.ts + providers/tts.ts EMOTION_RULES). The model's explicit
 * emotion marker wins; otherwise the reply text is classified and mapped onto
 * the saved preset catalogue.
 */

export interface VoiceEmotionPreset {
  label: string;
  instructions: string;
  speed: number;
}

export type VoiceEmotionMap = Record<string, VoiceEmotionPreset>;

export const DEFAULT_VOICE_EMOTIONS: VoiceEmotionMap = {
  neutral: { label: '中性', instructions: '自然、清晰、平静地说。', speed: 1 },
  happy: { label: '开心', instructions: '轻快、明亮、有笑意，但不要夸张。', speed: 1.06 },
  sad: { label: '难过', instructions: '轻声、克制、稍慢，带一点低落。', speed: 0.9 },
  angry: { label: '生气', instructions: '语气坚定、略急，但不要吼叫。', speed: 1.04 },
  gentle: { label: '温柔', instructions: '柔和、亲近、放慢一点。', speed: 0.94 }
};

export type SpeechEmotion =
  | 'neutral' | 'happy' | 'sad' | 'angry' | 'sleepy' | 'playful'
  | 'curious' | 'serious' | 'warm' | 'comforting';

const EMOTION_RULES: Array<{ emotion: SpeechEmotion; re: RegExp }> = [
  { emotion: 'comforting', re: /抱抱|别难过|没事的|辛苦了|我陪你|会好的|慢慢来|不要怕/ },
  { emotion: 'sad', re: /难过|伤心|委屈|想哭|舍不得|遗憾|对不起/ },
  { emotion: 'angry', re: /生气|气死|讨厌|烦死|太过分|不许|别这样/ },
  { emotion: 'sleepy', re: /晚安|睡吧|困了|做个好梦|休息吧/ },
  { emotion: 'playful', re: /嘿嘿|哼哼|笨蛋|逗你|才不要|好不好嘛|求求|撒娇/ },
  { emotion: 'happy', re: /哈哈|开心|好耶|太好了|恭喜|喜欢|真棒|耶[！!]?/ },
  { emotion: 'curious', re: /为什么|怎么会|真的吗|是吗|呢[？?]|[？?]$/ },
  { emotion: 'serious', re: /认真|重要|必须|需要注意|先别急|听我说/ },
  { emotion: 'warm', re: /想你|在乎|喜欢你|陪着你|谢谢你|一直都在/ }
];

export function detectSpeechEmotion(text: string): SpeechEmotion {
  for (const rule of EMOTION_RULES) {
    if (rule.re.test(text)) return rule.emotion;
  }
  return 'neutral';
}

const DETECTED_TO_SAVED: Record<string, string> = {
  happy: 'happy',
  playful: 'happy',
  sad: 'sad',
  angry: 'angry',
  comforting: 'gentle',
  sleepy: 'gentle',
  warm: 'gentle',
  curious: 'neutral',
  serious: 'neutral',
  neutral: 'neutral'
};

/**
 * Fixed high-level voice-mood contract injected into the main model prompt
 * (convergence §5.3). The model only picks an intent word; it never sees
 * speeds, instructions or Fish cue names.
 */
export const VOICE_MOOD_INTENTS = 'neutral / warm / happy / gentle / sleepy / playful / serious / shy / reassuring';

export function resolveVoiceDelivery(
  text: string,
  requestedEmotion: string | null | undefined,
  saved: VoiceEmotionMap
): Required<Pick<TTSOptions, 'emotion' | 'instructions' | 'speed'>> {
  const detected = DETECTED_TO_SAVED[detectSpeechEmotion(text)] ?? 'neutral';
  const requested = requestedEmotion?.trim();
  const candidate = requested && saved[requested] ? requested : requested ? 'neutral' : detected;
  const emotion = saved[candidate] ? candidate : 'neutral';
  const preset = saved[emotion] ?? saved.neutral ?? DEFAULT_VOICE_EMOTIONS.neutral!;
  return {
    emotion,
    instructions: preset.instructions,
    speed: preset.speed
  };
}
