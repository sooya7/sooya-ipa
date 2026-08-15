import type { UserDirectives } from './directives.js';
import type { ChatMessage } from './types.js';

const MEDIA_INTERNAL_LINE_RE = /(?:生图|图片生成|生成图片|照片|语音).{0,16}(?:接口|通道|provider|服务实例)|(?:接口|通道|provider|服务实例|回传).{0,28}(?:生图|图片|照片|语音|调用|返回|回传|配置|可用|失败|成功|为空)/iu;
const MEDIA_EXECUTION_CLAIM_RE = /(?:接口|通道|provider|服务实例|配置|回传|调用).{0,42}(?:没有|没|未|无法|不能|失败|成功|为空|可用|提供|返回|回传|调用|走|通|配置)|(?:已经|真的|这次|刚才|现在).{0,24}(?:调用|走了|打开|接上).{0,16}(?:接口|通道)/iu;

/**
 * The reply model cannot observe media execution because image/TTS providers
 * run only after chat generation has finished. Hide invented provider status
 * from explicit media-request replies; the runtime is the sole authority for
 * success/failure.
 */
export function stripModelMediaExecutionClaims(text: string, explicitMediaRequest: boolean): string {
  const value = (text ?? '').trim();
  if (!explicitMediaRequest || !value) return value;
  const parts = value.match(/[^。！？!?\n]+[。！？!?]?|\n+/gu) ?? [value];
  return parts
    .filter((part) => !part.trim() || !MEDIA_EXECUTION_CLAIM_RE.test(part))
    .join('')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * Explicit image intent must always resolve to an executable prompt even when
 * the chat model forgets the private [[image...]] marker. Prefer a recent
 * scene-bearing assistant turn and ignore prior hallucinated API chatter.
 */
export function buildImageFallbackPrompt(
  user: UserDirectives,
  recent: ChatMessage[],
  latestUser: ChatMessage
): string | null {
  if (!user.wantImage) return null;
  const explicit = user.imagePrompt?.trim();
  if (explicit) return explicit.slice(0, 1_500);

  let scene = '';
  for (const message of [...recent].reverse()) {
    if (message.id === latestUser.id || message.role !== 'assistant' || message.status === 'failed') continue;
    const cleaned = messageText(message)
      .split(/\n+/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !MEDIA_INTERNAL_LINE_RE.test(line))
      .join(' ')
      .replace(/\s{2,}/gu, ' ')
      .trim();
    if (cleaned.length >= 8) {
      scene = cleaned.slice(0, 1_200);
      break;
    }
  }

  if (user.selfieIntent) {
    return scene
      ? `SOOYA 的自然生活自拍，延续上一轮对话场景：${scene}`
      : 'SOOYA 的自然生活自拍，手机随手拍，真实自然';
  }
  return scene
    ? `根据当前对话延续生成一张自然照片。场景参考：${scene}`
    : '一张与当前对话相关的自然生活照片';
}

function messageText(message: ChatMessage): string {
  return message.content.map((part) => part.text ?? part.transcript ?? '').filter(Boolean).join('\n').trim();
}
