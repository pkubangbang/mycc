/**
 * Tests for token.ts - Token estimation utility
 */
import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateTokensForMessages, estimateTextTokens, truncateToTokens } from '../../utils/token.js';

describe('estimateTokens', () => {
  it('should return 0 for empty content', () => {
    const tokens = estimateTokens({ role: 'user', content: '' });
    expect(tokens).toBeGreaterThanOrEqual(0);
  });

  it('should return positive number for simple text', () => {
    const tokens = estimateTokens({ role: 'user', content: 'hello world' });
    expect(tokens).toBeGreaterThan(0);
  });

  it('should return more tokens for longer text', () => {
    const short = estimateTokens({ role: 'user', content: 'hello' });
    const long = estimateTokens({ role: 'user', content: 'hello world this is a longer sentence' });
    expect(long).toBeGreaterThan(short);
  });

  it('should handle CJK characters', () => {
    const tokens = estimateTokens({ role: 'user', content: '你好世界' });
    expect(tokens).toBeGreaterThan(0);
  });

  it('should handle mixed CJK and Latin', () => {
    const tokens = estimateTokens({ role: 'user', content: 'Hello 世界 test 测试' });
    expect(tokens).toBeGreaterThan(0);
  });

  it('should handle tool_calls in message', () => {
    const tokens = estimateTokens({
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_123',
        function: { name: 'read_file', arguments: { path: 'test.ts' } },
      } as any],
    });
    expect(tokens).toBeGreaterThan(0);
  });

  it('should handle system messages', () => {
    const tokens = estimateTokens({ role: 'system', content: 'You are a helpful assistant.' });
    expect(tokens).toBeGreaterThan(0);
  });

  it('should handle null content', () => {
    const tokens = estimateTokens({ role: 'user', content: undefined as unknown as string });
    expect(tokens).toBeGreaterThanOrEqual(0);
  });
});

describe('estimateTokensForMessages', () => {
  it('should return 0 for empty array', () => {
    expect(estimateTokensForMessages([])).toBe(0);
  });

  it('should sum tokens for multiple messages', () => {
    const single = estimateTokensForMessages([{ role: 'user', content: 'hello' }]);
    const multiple = estimateTokensForMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
    expect(multiple).toBeGreaterThan(single);
  });

  it('should handle mixed message types', () => {
    const tokens = estimateTokensForMessages([
      { role: 'system', content: 'System prompt here.' },
      { role: 'user', content: 'User query here.' },
      { role: 'assistant', content: 'Assistant response here.' },
      { role: 'tool', content: 'Tool result here.', tool_name: 'bash', tool_call_id: 'call_1' },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });

  it('should handle messages with tool_calls', () => {
    const tokens = estimateTokensForMessages([
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          function: { name: 'read_file', arguments: { path: 'test.ts' } },
        } as any],
      },
      { role: 'tool', content: 'file content', tool_name: 'read_file', tool_call_id: 'call_1' },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('truncateToTokens', () => {
  it('returns text unchanged when it already fits the budget', () => {
    const text = 'hello world this is short';
    expect(truncateToTokens(text, 200)).toBe(text);
  });

  it('returns empty string for empty/non-positive budget', () => {
    expect(truncateToTokens('hello', 0)).toBe('');
    expect(truncateToTokens('hello', -1)).toBe('');
    expect(truncateToTokens('', 200)).toBe('');
  });

  it('trims trailing words until the estimate fits the budget', () => {
    // ~500 words is well over 200 tokens.
    const longText = 'word '.repeat(500).trim();
    expect(estimateTextTokens(longText)).toBeGreaterThan(200);
    const truncated = truncateToTokens(longText, 200);
    expect(estimateTextTokens(truncated)).toBeLessThanOrEqual(200);
    // The result is a prefix (leading words preserved; trailing dropped).
    expect(longText.startsWith(truncated)).toBe(true);
  });

  it('never exceeds the budget and keeps whole words only', () => {
    const longText = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    const truncated = truncateToTokens(longText, 8);
    expect(estimateTextTokens(truncated)).toBeLessThanOrEqual(8);
    // No partial words — every kept token is a whole original word.
    for (const w of truncated.split(/\s+/)) {
      expect(longText).toContain(w);
    }
  });

  it('truncates pure CJK (spaceless) text to a leading prefix instead of discarding it', () => {
    // Pure CJK: no whitespace, so split(/\s+/) yields one element. Without the
    // character-level fallback, pop() would empty the array and return "".
    const longText = '你好世界测试中文截断逻辑验证这是一个很长的中文句子用来测试截断功能是否正常工作'.repeat(4);
    expect(estimateTextTokens(longText)).toBeGreaterThan(200);
    const truncated = truncateToTokens(longText, 200);
    // Must fit the budget.
    expect(estimateTextTokens(truncated)).toBeLessThanOrEqual(200);
    // Must be non-empty (the bug returned "" here).
    expect(truncated.length).toBeGreaterThan(0);
    // Must be a leading prefix (leading content preserved, trailing dropped).
    expect(longText.startsWith(truncated)).toBe(true);
  });

  it('truncates a single CJK run longer than a tiny budget to a non-empty prefix', () => {
    // CJK chars are ~2 tokens each. With a budget of 8, we expect ~4 chars kept,
    // not "" (which the word-only path returned before the fix).
    const text = '你好世界测试验证';
    const truncated = truncateToTokens(text, 8);
    expect(estimateTextTokens(truncated)).toBeLessThanOrEqual(8);
    expect(truncated.length).toBeGreaterThan(0);
    expect(text.startsWith(truncated)).toBe(true);
  });

  it('falls back to character-level for mixed text where a single run exceeds the budget', () => {
    // One CJK run (no spaces) bigger than the budget, plus trailing words.
    const text = '你好世界测试验证这是一个很长的无空格中文段落'.repeat(3) + ' tail words here';
    const truncated = truncateToTokens(text, 60);
    expect(estimateTextTokens(truncated)).toBeLessThanOrEqual(60);
    expect(truncated.length).toBeGreaterThan(0);
    expect(text.startsWith(truncated)).toBe(true);
  });
});
