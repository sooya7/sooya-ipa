import { describe, expect, it } from 'vitest';
import { extractJsonObject, isJsonModeRejection, withJsonInstruction } from './json-extract.js';
import { ProviderRequestError } from '../providers/types.js';

describe('extractJsonObject', () => {
  it('parses a plain object', () => {
    expect(extractJsonObject('{"ok":true}')).toEqual({ ok: true });
  });

  it('parses fenced JSON', () => {
    expect(extractJsonObject('```json\n{"prompt":"雨夜的咖啡店"}\n```')).toEqual({ prompt: '雨夜的咖啡店' });
  });

  it('parses an object wrapped in prose', () => {
    expect(extractJsonObject('好的，这是结果：{"a":1} 希望有帮助')).toEqual({ a: 1 });
  });

  it('ignores reasoning traces and picks the real object', () => {
    const raw = '<think>用户要一个 {"decoy":0} 的东西</think> {"answer":42}';
    expect(extractJsonObject(raw)).toEqual({ answer: 42 });
  });

  it('repairs trailing commas', () => {
    expect(extractJsonObject('{"a":1,}')).toEqual({ a: 1 });
  });

  it('closes a truncated object and keeps complete members', () => {
    const raw = '{"text":"晚安","speed":1.0,';
    expect(extractJsonObject(raw)).toEqual({ text: '晚安', speed: 1 });
  });

  it('keeps braces inside strings from counting as structure', () => {
    expect(extractJsonObject('{"text":"微笑{不是结构}"}')).toEqual({ text: '微笑{不是结构}' });
  });

  it('returns null for non-JSON and non-object output', () => {
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject('完全没有花括号')).toBeNull();
    expect(extractJsonObject('not json {"a":')).toBeNull();
  });
});

describe('withJsonInstruction', () => {
  it('appends the constraint to an existing prompt', () => {
    expect(withJsonInstruction('你是整理器。')).toContain('你是整理器。');
    expect(withJsonInstruction('你是整理器。')).toContain('JSON 对象');
    expect(withJsonInstruction(undefined)).toContain('JSON');
  });
});

describe('isJsonModeRejection', () => {
  it('matches 4xx errors naming the json wire field', () => {
    expect(isJsonModeRejection(new ProviderRequestError('response_format is not supported', 400))).toBe(true);
    expect(isJsonModeRejection(new ProviderRequestError('json_object invalid', 422))).toBe(true);
  });

  it('rejects other statuses and unrelated messages', () => {
    expect(isJsonModeRejection(new ProviderRequestError('response_format bad', 500))).toBe(false);
    expect(isJsonModeRejection(new ProviderRequestError('rate limited', 429))).toBe(false);
    expect(isJsonModeRejection(new Error('response_format'))).toBe(false);
  });
});
