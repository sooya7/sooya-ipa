import { describe, expect, it } from 'vitest';
import { decideWebSearch } from './web-search-policy.js';

describe('decideWebSearch', () => {
  it('offers on explicit search verbs', () => {
    for (const input of ['帮我搜一下最近新闻', '联网查一下机票价格', '求证一下这个消息是真的吗', '搜索深圳今天的天气']) {
      expect(decideWebSearch(input).offer).toBe(true);
      expect(decideWebSearch(input).reason).toBe('explicit');
    }
  });

  it('offers on local scope + topic', () => {
    const decision = decideWebSearch('附近有什么好吃的餐厅');
    expect(decision.offer).toBe(true);
    expect(decision.reason).toBe('local');
  });

  it('offers on freshness + external topic, with day freshness for today', () => {
    const today = decideWebSearch('今天有什么新闻');
    expect(today.offer).toBe(true);
    expect(today.freshness).toBe('day');
    const week = decideWebSearch('本周有什么比赛');
    expect(week.offer).toBe(true);
    expect(week.freshness).toBeUndefined();
  });

  it('offers on external topic + question shape', () => {
    const decision = decideWebSearch('最近的机票价格怎么样');
    expect(decision.offer).toBe(true);
    expect(decision.reason).toBe('fresh_external');
  });

  it('does not offer on chatty or empty input', () => {
    expect(decideWebSearch('').offer).toBe(false);
    expect(decideWebSearch('今天心情不错').offer).toBe(false);
    expect(decideWebSearch('想你了').offer).toBe(false);
    expect(decideWebSearch('天气').offer).toBe(false); // topic alone is not enough
  });
});
