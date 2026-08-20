/**
 * generation.test.ts — Tests for crossroad continuation generation logic.
 *
 * Covers:
 *   - stripAndValidate: anchor validation and stripping
 *   - extractWordsBeforeTurn: prefix anchor extraction
 *   - generateContinuations: validation, retry-on-fail, skip-after-retry-fail
 *   - selectBestContinuation: selection parsing and fallbacks
 *   - handleCrossroad: end-to-end orchestration (detection → generation → selection)
 *
 * Mock strategy:
 *   - forkChat: mocked per-test to return controlled continuations.
 *     generateContinuations runs 3 directions via Promise.allSettled, which
 *     starts them in array order — mockImplementationByCallIndex is used to
 *     return per-direction values deterministically.
 *   - agentIO: mocked to no-op verbose/log
 *   - chat-helpers: startSpinner/stopSpinner/sleep no-op'd
 *   - stripInternalMarkup: real (pure function, no side effects)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ------------------------------------------------------------------

vi.mock('../../engine/chat-provider.js', () => ({
  forkChat: vi.fn(),
  MODEL: 'test-model',
}));

vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    verbose: vi.fn(),
    log: vi.fn(),
    brief: vi.fn(),
  },
}));

vi.mock('../../engine/chat-helpers.js', () => ({
  startSpinner: vi.fn(),
  stopSpinner: vi.fn(),
  sleep: vi.fn(() => Promise.resolve()),
}));

// --- Imports after mocks ----------------------------------------------------
import { forkChat } from '../../engine/chat-provider.js';
import { sleep } from '../../engine/chat-helpers.js';
import {
  detectTurningWord,
  generateContinuations,
  selectBestContinuation,
  handleCrossroad,
  stripAndValidate,
  extractWordsBeforeTurn,
} from '../../loop/crossroad.js';
import type { Message, Tool } from '../../types.js';

// --- Shared fixtures --------------------------------------------------------
const MESSAGES: Message[] = [{ role: 'user', content: 'test' }];
const TOOLS: Tool[] = [{ type: 'function', function: { name: 'bash', description: '', parameters: {} } }];
const PREFIX = 'Let me examine the database schema first to understand the relationships.';

/**
 * Queue forkChat to return values in sequence across calls.
 * Promise.allSettled starts the 3 directions in array order, so the queue
 * is consumed predictably: dir1-attempt1, dir2-attempt1, dir3-attempt1,
 * then retries in the same order.
 */
function queueForkChat(...values: (string | Error)[]): void {
  const queue = [...values];
  vi.mocked(forkChat).mockImplementation(async () => {
    const next = queue.shift();
    if (next === undefined) return '' as never;
    if (next instanceof Error) throw next;
    return next as never;
  });
}

describe('stripAndValidate', () => {
  it('should strip the anchor and return remaining content', () => {
    const anchor = 'The schema looks correct.';
    const cont = 'The schema looks correct. Let me check the API layer instead.';
    expect(stripAndValidate(anchor, cont)).toBe('Let me check the API layer instead.');
  });

  it('should return null when continuation does not start with anchor', () => {
    const anchor = 'The schema looks correct.';
    const cont = 'Let me check the API layer instead.';
    expect(stripAndValidate(anchor, cont)).toBeNull();
  });

  it('should return null when continuation is only the anchor (nothing left after strip)', () => {
    const anchor = 'The schema looks correct.';
    expect(stripAndValidate(anchor, anchor)).toBeNull();
  });

  it('should return null when continuation is anchor + whitespace only', () => {
    const anchor = 'The schema looks correct.';
    expect(stripAndValidate(anchor, anchor + '   ')).toBeNull();
  });

  it('should return continuation unchanged when anchor is empty', () => {
    const cont = 'Let me check the API layer instead.';
    expect(stripAndValidate('', cont)).toBe(cont);
  });

  it('should return continuation unchanged when anchor is empty and continuation is empty', () => {
    expect(stripAndValidate('', '')).toBe('');
  });

  it('should handle anchor with trailing punctuation (Chinese)', () => {
    const anchor = '数据库连接正常。';
    const cont = '数据库连接正常。但缓存策略有问题。';
    expect(stripAndValidate(anchor, cont)).toBe('但缓存策略有问题。');
  });

  it('should return null when anchor is non-empty but continuation is empty', () => {
    expect(stripAndValidate('anchor sentence here.', '')).toBeNull();
  });
});

describe('extractWordsBeforeTurn', () => {
  it('should extract the last sentence (English, period boundary)', () => {
    const prefix = 'First sentence here. Second sentence here. Last sentence here.';
    expect(extractWordsBeforeTurn(prefix)).toBe('Last sentence here.');
  });

  it('should extract the last sentence (Chinese, 。boundary, no whitespace)', () => {
    const prefix = '第一句话。第二句话。最后一句话。';
    expect(extractWordsBeforeTurn(prefix)).toBe('最后一句话。');
  });

  it('should extract the last segment after a newline', () => {
    const prefix = 'First paragraph here.\n\nSecond paragraph here.';
    expect(extractWordsBeforeTurn(prefix)).toBe('Second paragraph here.');
  });

  it('should handle a single sentence (no boundary)', () => {
    const prefix = 'Only one sentence with no period';
    expect(extractWordsBeforeTurn(prefix)).toBe('Only one sentence with no period');
  });

  it('should handle mixed English and Chinese boundaries', () => {
    const prefix = 'English sentence. 中文句子。Final sentence here.';
    expect(extractWordsBeforeTurn(prefix)).toBe('Final sentence here.');
  });

  it('should handle ! and ? as sentence boundaries', () => {
    const prefix = 'Is this correct? Yes it is. Final one.';
    expect(extractWordsBeforeTurn(prefix)).toBe('Final one.');
  });

  it('should handle empty prefix', () => {
    expect(extractWordsBeforeTurn('')).toBe('');
  });

  it('should handle whitespace-only prefix', () => {
    expect(extractWordsBeforeTurn('   \n\n   ')).toBe('');
  });

  it('should trim whitespace around the extracted sentence', () => {
    const prefix = 'First.   Second with spaces.   ';
    expect(extractWordsBeforeTurn(prefix)).toBe('Second with spaces.');
  });
});

describe('generateContinuations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should validate and strip the anchor from each continuation', async () => {
    const anchor = 'The schema looks correct.';
    // All 3 dirs start with the anchor → all pass first attempt
    queueForkChat(
      'The schema looks correct. Let me proceed with the API fix.',
      'The schema looks correct. Let me proceed with the API fix.',
      'The schema looks correct. Let me proceed with the API fix.',
    );

    const results = await generateContinuations(MESSAGES, TOOLS, PREFIX, undefined, anchor);

    expect(results).toHaveLength(3);
    expect(results.every(r => r === 'Let me proceed with the API fix.')).toBe(true);
    expect(forkChat).toHaveBeenCalledTimes(3);
  });

  it('should retry once when validation fails, then succeed on retry', async () => {
    const anchor = 'The schema looks correct.';
    // Promise.allSettled runs all 3 dirs concurrently. Each dir's first attempt
    // resolves immediately; dir1's retry waits 300ms (sleep), so by the time it
    // retries, dir2 and dir3 have consumed their queue slots. Queue order:
    //   [0] dir1 attempt1 (fail), [1] dir2 attempt1 (success), [2] dir3 attempt1 (success),
    //   [3] dir1 retry (success)
    queueForkChat(
      'Let me proceed differently.',                          // dir1 attempt1 — no anchor → fail
      'The schema looks correct. Go backward now.',           // dir2 — success
      'The schema looks correct. Synthesize high level.',     // dir3 — success
      'The schema looks correct. Retried successfully.',      // dir1 retry — success
    );

    const results = await generateContinuations(MESSAGES, TOOLS, PREFIX, undefined, anchor);

    expect(results).toHaveLength(3);
    // Results are in array order: dir1, dir2, dir3
    expect(results[0]).toBe('Retried successfully.');
    expect(results[1]).toBe('Go backward now.');
    expect(results[2]).toBe('Synthesize high level.');
    // dir1 = 2 calls, dir2 = 1, dir3 = 1 → total 4
    expect(forkChat).toHaveBeenCalledTimes(4);
    // sleep called once (for the dir1 retry)
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('should skip a direction when both attempts fail validation', async () => {
    const anchor = 'The schema looks correct.';
    // dir1 fails both attempts (no anchor). dir2 and dir3 succeed first attempt.
    // Queue order (concurrent): dir1-attempt1, dir2-attempt1, dir3-attempt1,
    // then dir1-retry (after sleep).
    queueForkChat(
      'No anchor here attempt 1.',        // dir1 attempt1 — fail
      'The schema looks correct. Dir2 content.',  // dir2 — success
      'The schema looks correct. Dir3 content.',  // dir3 — success
      'Still no anchor attempt 2.',       // dir1 retry — fail → skip
    );

    const results = await generateContinuations(MESSAGES, TOOLS, PREFIX, undefined, anchor);

    // Only 2 continuations (dir1 skipped)
    expect(results).toHaveLength(2);
    expect(results).toContain('Dir2 content.');
    expect(results).toContain('Dir3 content.');
  });

  it('should return empty array when all directions fail validation after retry', async () => {
    const anchor = 'The schema looks correct.';
    // All 3 dirs fail both attempts (6 calls total)
    vi.mocked(forkChat).mockImplementation(async () => 'No anchor anywhere.' as never);

    const results = await generateContinuations(MESSAGES, TOOLS, PREFIX, undefined, anchor);

    expect(results).toEqual([]);
    // 3 directions × 2 attempts = 6 calls
    expect(forkChat).toHaveBeenCalledTimes(6);
  });

  it('should pass through continuations unchanged when anchor is empty', async () => {
    vi.mocked(forkChat).mockImplementation(async () => 'Just some content without anchor.' as never);

    const results = await generateContinuations(MESSAGES, TOOLS, PREFIX, undefined, '');

    expect(results).toHaveLength(3);
    expect(results.every(r => r === 'Just some content without anchor.')).toBe(true);
    // No retries needed (empty anchor = always valid)
    expect(forkChat).toHaveBeenCalledTimes(3);
  });

  it('should skip directions that throw (rejected promises)', async () => {
    const anchor = 'The schema looks correct.';
    // dir1: throws, dir2: success, dir3: throws
    queueForkChat(
      new Error('network error'),
      'The schema looks correct. Dir2 ok.',
      new Error('timeout'),
    );

    const results = await generateContinuations(MESSAGES, TOOLS, PREFIX, undefined, anchor);

    expect(results).toHaveLength(1);
    expect(results[0]).toBe('Dir2 ok.');
  });

  it('should reject continuation that is only the anchor (null after strip)', async () => {
    const anchor = 'The schema looks correct.';
    // dir1: only anchor → null → retry → only anchor again → skip
    // dir2: success, dir3: success
    queueForkChat(
      'The schema looks correct.',   // dir1 attempt1 — only anchor → null
      'The schema looks correct.',   // dir1 retry — same → skip
      'The schema looks correct. Dir2 ok.',
      'The schema looks correct. Dir3 ok.',
    );

    const results = await generateContinuations(MESSAGES, TOOLS, PREFIX, undefined, anchor);

    expect(results).toHaveLength(2);
  });

  it('should default wordsBeforeTurn to empty when not provided', async () => {
    vi.mocked(forkChat).mockImplementation(async () => 'Content without anchor.' as never);

    const results = await generateContinuations(MESSAGES, TOOLS, PREFIX);

    // No anchor → all pass validation without stripping
    expect(results).toHaveLength(3);
    expect(forkChat).toHaveBeenCalledTimes(3);
  });
});

describe('selectBestContinuation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty string for empty continuations', async () => {
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, []);
    expect(result).toBe('');
  });

  it('should return the single continuation when only one provided', async () => {
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, ['only option']);
    expect(result).toBe('only option');
    // forkChat should NOT be called when only one option
    expect(forkChat).not.toHaveBeenCalled();
  });

  it('should select option by number and return stored continuation when no second line', async () => {
    // First line is "2", no second line → returns continuations[1]
    vi.mocked(forkChat).mockImplementation(async () => '2' as never);
    const conts = ['first option', 'second option', 'third option'];
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, conts);
    expect(result).toBe('second option');
  });

  it('should use the continuation text from second line when provided and long enough', async () => {
    // First line "1", second line is >10 chars → returns the second line text
    vi.mocked(forkChat).mockImplementation(async () => '1\nThis is the full text from the second line.' as never);
    const conts = ['short', 'second', 'third'];
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, conts);
    expect(result).toBe('This is the full text from the second line.');
  });

  it('should fall back to the stored continuation when second line is too short', async () => {
    // Second line "short" is ≤10 chars → falls back to continuations[0]
    vi.mocked(forkChat).mockImplementation(async () => '1\nshort' as never);
    const conts = ['the actual first option', 'second', 'third'];
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, conts);
    expect(result).toBe('the actual first option');
  });

  it('should parse "Option N" prefix and return second line text when long enough', async () => {
    // "Option 3" parses to index 2; second line >10 chars → returns second line
    vi.mocked(forkChat).mockImplementation(async () => 'Option 3\nThird option full text here.' as never);
    const conts = ['first', 'second', 'third option'];
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, conts);
    expect(result).toBe('Third option full text here.');
  });

  it('should fall back to matching continuation by substring when parse fails', async () => {
    // Response doesn't start with a number, but contains a continuation's prefix.
    // selectBestContinuation checks text.includes(c.slice(0, 50)) for each c.
    // 'second option text here' slice(0,50) = 'second option text here' (full, <50).
    // The response contains 'second option' → includes('second option text here')?
    // No — it checks the FULL slice, not a prefix of it. So we craft the response
    // to contain the full continuation string.
    vi.mocked(forkChat).mockImplementation(async () => 'I think the best is: second option text here.' as never);
    const conts = ['first option text', 'second option text here', 'third option text'];
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, conts);
    expect(result).toBe('second option text here');
  });

  it('should fall back to first continuation when all parsing fails', async () => {
    vi.mocked(forkChat).mockImplementation(async () => 'I cannot decide.' as never);
    const conts = ['first', 'second', 'third'];
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, conts);
    expect(result).toBe('first');
  });

  it('should fall back to first continuation when forkChat throws', async () => {
    vi.mocked(forkChat).mockImplementation(async () => { throw new Error('network'); });
    const conts = ['first', 'second', 'third'];
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, conts);
    expect(result).toBe('first');
  });

  it('should handle out-of-range option number (fall back to first)', async () => {
    // 5 is out of range → optionMatch fails the bounds check → substring check
    // fails → first continuation
    vi.mocked(forkChat).mockImplementation(async () => '5\nsome text' as never);
    const conts = ['first', 'second', 'third'];
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, conts);
    expect(result).toBe('first');
  });
});

describe('handleCrossroad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null when no turning word is detected', async () => {
    const content = 'This is a normal response with no turning word anywhere in the text at all.';
    const result = await handleCrossroad(MESSAGES, content, TOOLS);
    expect(result).toBeNull();
    // forkChat should not be called (detection failed before generation)
    expect(forkChat).not.toHaveBeenCalled();
  });

  it('should return truncated prefix and selected continuation', async () => {
    const content = 'Let me examine the database schema first. However, the real issue is in the API.';
    const anchor = 'Let me examine the database schema first.';
    // generation: 3 dirs, each starts with anchor → all pass
    // selection: "2" with no second line → returns continuations[1]
    queueForkChat(
      `${anchor} Go forward direction.`,
      `${anchor} Go backward direction.`,
      `${anchor} Synthesize direction.`,
      '2',
    );

    const result = await handleCrossroad(MESSAGES, content, TOOLS);

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(anchor);
    expect(result!.continuation).toBe('Go backward direction.');
  });

  it('should extract wordsBeforeTurn and enforce anchor in generation', async () => {
    const content = 'I will check the config file. Wait, the issue is in the env vars.';
    const anchor = 'I will check the config file.';
    // All 3 dirs fail validation (don't start with anchor), retry also fails → empty
    // First batch: 6 calls → empty. handleCrossroad retries → 6 more → empty → null.
    vi.mocked(forkChat).mockImplementation(async () => 'No anchor present here.' as never);

    const result = await handleCrossroad(MESSAGES, content, TOOLS);

    expect(result).toBeNull();
    // 6 (first batch) + 6 (retry batch) = 12
    expect(forkChat).toHaveBeenCalledTimes(12);
  });

  it('should handle single continuation (no selection needed)', async () => {
    const content = 'Let me check the schema first. But the real problem is elsewhere.';
    const anchor = 'Let me check the schema first.';
    // dir1 succeeds, dir2 throws, dir3 fails validation twice → only 1 continuation
    queueForkChat(
      `${anchor} Only valid direction.`,   // dir1 success
      new Error('fail'),                    // dir2 throws
      'No anchor.',                         // dir3 attempt1 fail
      'Still no anchor.',                   // dir3 retry fail
    );

    const result = await handleCrossroad(MESSAGES, content, TOOLS);

    expect(result).not.toBeNull();
    expect(result!.continuation).toBe('Only valid direction.');
    // No selection call (single continuation → returned directly)
  });

  it('should return null when all continuations are empty after retry', async () => {
    const content = 'Let me check the schema first. However, this needs rethinking.';
    // forkChat returns empty string for all → stripInternalMarkup → '' → no continuation
    vi.mocked(forkChat).mockImplementation(async () => '' as never);

    const result = await handleCrossroad(MESSAGES, content, TOOLS);
    expect(result).toBeNull();
  });
});

describe('handleCrossroad — turning word detection integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should detect Chinese turning word and generate continuation', async () => {
    // Prefix must exceed MIN_PREFIX_LENGTH (30) AND suffix must exceed
    // MIN_SUFFIX_LENGTH (15) for detection to fire.
    // Prefix = 30 chars, suffix = 16 chars (但根本问题可能在配置文件里的设置上。)
    const content = '我们需要检查数据库连接和缓存策略以及日志配置来定位这个问题。但根本问题可能在配置文件里的设置上。';
    const anchor = '我们需要检查数据库连接和缓存策略以及日志配置来定位这个问题。';
    // generation: 3 dirs, each starts with anchor
    // selection: "3" → returns continuations[2]
    queueForkChat(
      `${anchor} 重新检查配置。`,
      `${anchor} 回顾基础假设。`,
      `${anchor} 从更高层次综合。`,
      '3',
    );

    const result = await handleCrossroad(MESSAGES, content, TOOLS);

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(anchor);
    expect(result!.continuation).toBe('从更高层次综合。');
  });

  it('should detect turning word at position 0 and use empty anchor', async () => {
    // "However" at position 0 — allowed (commitment was in prior turns)
    const content = 'However, we should reconsider the entire approach from scratch.';
    // Position 0 → prefix is '' → wordsBeforeTurn is '' → no anchor enforcement
    vi.mocked(forkChat).mockImplementation(async () => 'Some continuation text here.' as never);

    const result = await handleCrossroad(MESSAGES, content, TOOLS);

    // Prefix empty → anchor empty → continuations pass without stripping
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe('');
  });
});