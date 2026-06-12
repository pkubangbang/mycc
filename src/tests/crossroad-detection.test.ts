/**
 * Tests for the refined detectTurningWord logic.
 * Verifies that true turning words are detected and false positives are filtered.
 */
import { describe, it, expect } from 'vitest';
import { detectTurningWord } from '../loop/crossroad.js';

describe('detectTurningWord — true positives (should detect)', () => {
  it('detects However at sentence boundary after committed plan', () => {
    const content =
      'Let me check the authentication module first. I will read through the login flow carefully. However, I realize that the issue might actually be in the database layer instead.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('However');
  });

  it('detects Having said that', () => {
    const content =
      'The current architecture uses a monolithic design which has served us well for the past two years. Having said that, we should consider migrating to microservices for better scalability.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('Having said that');
  });

  it('detects Wait as interjection (followed by comma)', () => {
    const content =
      'I think the best approach is to refactor the entire authentication module from scratch. Wait, that would be too disruptive — let me reconsider a more incremental approach.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('Wait');
  });

  it('detects Wait as interjection (followed by exclamation)', () => {
    const content =
      'We should deploy this change directly to production since it has passed all the unit tests and integration tests. Wait! We forgot to check the staging environment configuration first.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('Wait');
  });

  it('detects Chinese 然而 at sentence boundary', () => {
    const content =
      '我们需要先仔细检查用户权限模块，确保所有的认证逻辑都是正确无误的。然而，我发现问题可能出在数据库连接层，而不是权限模块本身。';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toMatch(/然而/);
  });

  it('detects Chinese 等一下', () => {
    const content =
      '最简单的解决方案是直接修改配置文件，添加新的环境变量来覆盖默认值。等一下，这样可能会影响其他服务的配置，需要更谨慎地处理。';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('等一下');
  });

  it('detects Chinese 话说回来', () => {
    const content =
      '直接重写整个模块是最彻底的解决方案，可以在短期内解决所有已知问题。话说回来，我们需要考虑重写过程中对其他模块的影响和回归风险。';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('话说回来');
  });

  it('detects On the other hand', () => {
    const content =
      'We could take the quick path and patch the existing code to handle this edge case. On the other hand, a more thorough refactoring would prevent similar issues from arising in the future.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('On the other hand');
  });
});

describe('detectTurningWord — false positives (should NOT detect)', () => {
  it('rejects But mid-sentence (balanced analysis)', () => {
    const content =
      'The refactoring approach is cleaner but it requires more upfront work. We should weigh the tradeoffs carefully before deciding.';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('rejects However mid-sentence (not at sentence boundary)', () => {
    const content =
      'This solution works for small projects, however it does not scale well to larger codebases with many contributors.';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('rejects Wait for (instruction, not interjection)', () => {
    const content =
      'Now we need to compile the project. Wait for the build to complete before running the tests, as the test suite depends on the compiled output.';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('rejects Wait until (instruction)', () => {
    const content =
      'The deployment process takes about five minutes to complete. Wait until you see the success notification in the dashboard before proceeding with the verification steps.';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('rejects Wait to (instruction)', () => {
    const content =
      'Before making any changes to the production configuration, wait to receive approval from the security team. This is a mandatory step in our compliance process.';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('rejects Actually mid-sentence (clarification, not turn)', () => {
    const content =
      'The function signature is actually quite simple once you understand the type parameters and how they interact with the generic constraints.';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('rejects short prefix (no commitment before turn)', () => {
    const content =
      'Let me check. However, I think we should look elsewhere for the root cause of this issue.';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('rejects Chinese 等等 as etc. (list terminator)', () => {
    const content =
      '我们需要检查多个方面：用户权限、数据库连接、缓存策略、日志配置等等都需要逐一排查才能定位问题根源所在。';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('rejects Chinese 但 mid-sentence (conjunction)', () => {
    const content =
      '这个方案实现简单但维护成本较高，我们需要在两者之间找到平衡点来做出最终的技术决策。';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('rejects Chinese 其实 mid-sentence (clarification)', () => {
    const content =
      '这个问题其实比看起来要复杂得多，涉及到底层架构的多个组件之间的交互和依赖关系。';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('rejects Chinese 不过 mid-sentence (conjunction)', () => {
    const content =
      '代码质量不错不过测试覆盖率还可以进一步提升，建议添加更多的边界条件测试用例。';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });
});

describe('detectTurningWord — edge cases', () => {
  it('rejects turning word at very end (no suffix content)', () => {
    const content =
      'The authentication module needs a complete rewrite to support the new requirements. However';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('rejects turning word at very start (no prefix)', () => {
    const content =
      'However, I think we should reconsider the entire approach to this problem from a different angle.';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('rejects empty content', () => {
    const result = detectTurningWord('');
    expect(result).toBeNull();
  });

  it('rejects content with no turning words', () => {
    const content =
      'The authentication module is well-structured and follows clean architecture principles. We should proceed with the current implementation.';
    const result = detectTurningWord(content);
    expect(result).toBeNull();
  });

  it('detects the earliest turning word when multiple exist', () => {
    const content =
      'First we need to examine the database schema carefully to understand the relationships. However, the real issue might be in the API layer. But we should also check the caching logic to be thorough.';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toBe('However');
  });

  it('detects Chinese 但 at sentence boundary (after period)', () => {
    const content =
      '最简单的方案是直接修改数据库连接字符串，添加重试逻辑来处理网络波动。但这样只是治标不治本，根本问题在于连接池的配置不合理。';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toMatch(/但/);
  });

  it('detects Chinese 其实 at sentence boundary (after period)', () => {
    const content =
      '表面上看这个bug是由于空指针引起的，只需要加一个null检查就能修复。其实，深层原因是整个初始化流程的设计有问题，需要重新梳理对象生命周期。';
    const result = detectTurningWord(content);
    expect(result).not.toBeNull();
    expect(result!.word).toMatch(/其实/);
  });
});
