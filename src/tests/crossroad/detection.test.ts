/**
 * Additional edge case tests for detectTurningWord
 */
import { describe, it, expect } from 'vitest';
import { detectTurningWord } from '../../loop/crossroad.js';

describe('detectTurningWord — edge cases', () => {
  it('should handle unicode and emoji content', () => {
    // Ensure the prefix before "However" is at least 30 chars and at sentence boundary
    const content = 'We need to check the authentication flow carefully. 检查完毕。However, I realize the issue might be elsewhere.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('However');
  });

  it('should handle very long content (1000+ chars)', () => {
    const prefix = 'We need to analyze the system architecture thoroughly. '.repeat(20);
    const content = prefix + 'However, I think we should reconsider the approach entirely.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('However');
  });

  it('should detect the earliest turning word when multiple exist', () => {
    const content =
      'First we need to examine the database schema carefully to understand the relationships. However, the real issue might be in the API layer. But we should also check the caching logic to be thorough.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('However');
  });

  it('should detect turning word at exact MIN_PREFIX_LENGTH boundary (30 chars)', () => {
    // 30 chars of prefix (exactly at boundary) - "However" at index 30
    // The turning word "However" starts at index 30, which is NOT > 0 and NOT < 30,
    // so idx > 0 && idx < MIN_PREFIX_LENGTH is false (idx=30, MIN_PREFIX_LENGTH=30)
    // This means the position check passes (30 is not < 30).
    const content = 'Let me check the system first. However, I think we should reconsider.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('However');
  });

  it('should reject turning word just below MIN_PREFIX_LENGTH (29 chars)', () => {
    // 29 chars of prefix (just below boundary)
    const content = 'A' .repeat(29) + ' However, I think we should reconsider.';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('should detect turning word at exact MIN_SUFFIX_LENGTH boundary (15 chars)', () => {
    // "However, " is 9 chars, so we need 15+ chars after
    const content = 'We need to carefully examine the system architecture first. However, I think we should.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('However');
  });

  it('should reject turning word just below MIN_SUFFIX_LENGTH', () => {
    // "However" at end with only 14 chars after
    const content = 'We need to carefully examine the system architecture first. However, I think so.';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('should detect turning word at position 0 (always allowed)', () => {
    const content = 'However, I think we should reconsider the entire approach to this problem from a different angle.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('However');
    expect(result!.index).toBe(0);
  });

  it('should detect Chinese 等等 as "wait!" (interjection)', () => {
    const content =
      '最简单的解决方案是直接修改配置文件，添加新的环境变量来覆盖默认值。等等，这样可能会影响其他服务的配置。';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('等等');
  });

  it('should reject Chinese 等等 as "etc." (list terminator)', () => {
    const content =
      '我们需要检查多个方面：用户权限、数据库连接、缓存策略、日志配置等等都需要逐一排查才能定位问题根源所在。';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('should handle empty content', () => {
    const result = detectTurningWord('');
    expect(result).toBeNull();
  });

  it('should handle content with no turning words', () => {
    const content =
      'The authentication module is well-structured and follows clean architecture principles. We should proceed with the current implementation.';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('should detect That being said', () => {
    const content =
      'The current implementation uses a simple caching strategy that works well for most cases. That being said, we should consider adding distributed caching for better scalability.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('That being said');
  });

  it('should detect Nevertheless at sentence boundary', () => {
    const content =
      'The test coverage is quite comprehensive with over 90% line coverage. Nevertheless, there are some edge cases that are not covered by the current test suite.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('Nevertheless');
  });

  it('should detect Actually at sentence boundary', () => {
    const content =
      'I think the bug is in the authentication module based on the error message. Actually, looking at the stack trace more carefully, the issue is in the database layer.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('Actually');
  });

  it('should detect But at sentence boundary', () => {
    const content =
      'The refactoring approach is cleaner and more maintainable in the long run. But it requires significant upfront investment that we may not have time for.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('But');
  });

  it('should reject But mid-sentence (balanced analysis)', () => {
    const content =
      'The refactoring approach is cleaner but it requires more upfront work. We should weigh the tradeoffs carefully before deciding.';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('should detect Chinese 但 at sentence boundary', () => {
    const content =
      '最简单的方案是直接修改数据库连接字符串，添加重试逻辑来处理网络波动。但这样只是治标不治本，根本问题在于连接池的配置不合理。';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toMatch(/但/);
  });

  it('should reject Chinese 但 mid-sentence', () => {
    const content =
      '这个方案实现简单但维护成本较高，我们需要在两者之间找到平衡点来做出最终的技术决策。';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('should detect Chinese 话说回来', () => {
    const content =
      '直接重写整个模块是最彻底的解决方案，可以在短期内解决所有已知问题。话说回来，我们需要考虑重写过程中对其他模块的影响和回归风险。';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('话说回来');
  });

  it('should detect Chinese 等一下', () => {
    const content =
      '最简单的解决方案是直接修改配置文件，添加新的环境变量来覆盖默认值。等一下，这样可能会影响其他服务的配置，需要更谨慎地处理。';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('等一下');
  });

  it('should detect On the other hand', () => {
    const content =
      'We could take the quick path and patch the existing code to handle this edge case. On the other hand, a more thorough refactoring would prevent similar issues from arising in the future.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('On the other hand');
  });

  it('should handle content with newlines before turning word', () => {
    const content =
      'Let me check the authentication module first.\n\nHowever, I realize that the issue might actually be in the database layer instead.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('However');
  });

  it('should handle content with only whitespace', () => {
    const result = detectTurningWord('   \n\n   ');
    expect(result).toBeNull();
  });
});
