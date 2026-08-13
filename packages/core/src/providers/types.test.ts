import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  BinaryData,
  ChatImagePart,
  ChatRequest,
  GeneratedImage,
  ImageProvider,
  ModelTurn,
  SynthesizedAudio
} from './types.js';

describe('provider-neutral contracts', () => {
  it('keeps tool rounds independent from vendor wire roles', () => {
    const turns: ModelTurn[] = [
      { role: 'user', content: [{ type: 'text', text: '记得我不吃香菜' }] },
      { role: 'assistant_tool_call', calls: [{ id: 'call-1', name: 'ombre.breath', arguments: {} }] },
      { role: 'tool_result', callId: 'call-1', name: 'ombre.breath', content: '历史材料', isError: false }
    ];
    const request: ChatRequest = {
      messages: turns,
      tools: [{ name: 'ombre.breath', description: 'Surface memory.', inputSchema: { type: 'object' } }],
      toolChoice: 'auto'
    };
    expect(request.messages[1]?.role).toBe('assistant_tool_call');
    expect(request.tools?.[0]?.name).toBe('ombre.breath');
  });

  it('uses only portable byte containers for public binary values', () => {
    const bytes: BinaryData = new Uint8Array([1, 2, 3]);
    const imagePart: ChatImagePart = { type: 'image', data: bytes, mime: 'image/png' };
    const image: GeneratedImage = { data: bytes, mime: 'image/png' };
    const arrayBuffer = new ArrayBuffer(3);
    const audio: SynthesizedAudio = { data: arrayBuffer, mime: 'audio/mpeg', format: 'mp3' };
    expect(imagePart.data).toBe(bytes);
    expect(image.data).toBe(bytes);
    expect(audio.data).toBe(arrayBuffer);
    expectTypeOf<Parameters<ImageProvider['edit']>[1]>().toEqualTypeOf<BinaryData>();
  });
});
