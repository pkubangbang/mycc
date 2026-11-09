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
 *   - @pkubangbang/crossroad-detector: mocked — the real client spawns an ONNX
 *     server. `detectMock` scripts the turning point per test; detection itself
 *     is NOT mycc's responsibility anymore (mycc's own regex was removed).
 *   - forkChat: mocked per-test to return controlled continuations.
 *     generateContinuations runs 3 directions via Promise.allSettled, which
 *     starts them in array order — mockImplementationByCallIndex is used to
 *     return per-direction values deterministically.
 *   - agentIO: mocked to no-op verbose/log
 *   - chat-helpers: startSpinner/stopSpinner/sleep no-op'd
 *   - stripInternalMarkup: real (pure function, no side effects)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Detection is owned by @pkubangbang/crossroad-detector, which spawns an ONNX
// inference server on first use — the package is MOCKED below so no test boots
// it. Do NOT set MYCC_CROSSROAD_DISABLE_SEMANTIC here: that flag short-circuits
// the detector entirely, so `getDetector()` returns null and every
// handleCrossroad case would stop at "detector unavailable" before generation.
// (`detect()` is therefore the ONLY detector entry point these tests stub.)

// --- Mocks ------------------------------------------------------------------

// Turning-point detector: a fake client whose detect() is scripted per test.
// `detectMock` returns null by default (= "no turn"), matching the real SDK's
// contract for "no turn detected" — the same null is also returned when the
// server is unavailable, which is why mycc no longer keeps a fallback of its own.
const detectMock = vi.fn<(content: string) => Promise<{ word: string; index: number; score: number } | null>>(
  async () => null
);
vi.mock('@pkubangbang/crossroad-detector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pkubangbang/crossroad-detector')>();
  return {
    ...actual,
    CrossroadDetector: class {
      detect = detectMock;
      dispose = async (): Promise<void> => undefined;
    }
  };
});

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
// Same shape as the mocked package: the detector client is the stub above, and
// the cut grid is the REAL segmenter, wired the way the host wires it.
import { segmentsOf } from '@pkubangbang/crossroad-detector';
import { forkChat } from '../../engine/chat-provider.js';
import { sleep } from '../../engine/chat-helpers.js';
import {
  initCrossroad,
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

// Wire the real cut grid once for the whole file (the package is mocked for the
// detector client ONLY, so its segmenter is the shipped implementation).
initCrossroad(segmentsOf);

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

  it('strips a retried response that echoes the entire already-visible prefix', () => {
    const prefix = 'First sentence. Last sentence.';
    const continuation = 'First sentence. Last sentence. Pivot to the API layer.';
    expect(stripAndValidate('Last sentence.', continuation, prefix)).toBe('Pivot to the API layer.');
  });

  it('strips the anchor and a duplicated full prefix from malformed continuation output', () => {
    const prefix = 'First sentence. Last sentence.';
    const continuation = 'Last sentence. First sentence. Last sentence. Pivot to the API layer.';
    expect(stripAndValidate('Last sentence.', continuation, prefix)).toBe('Pivot to the API layer.');
  });

  it('strips a prefix echo that is followed by a redundant re-echo of the anchor', () => {
    const prefix = 'First sentence. Last sentence.';
    // "prefix + anchor + new": the whole-prefix strip leaves the anchor behind.
    const continuation = 'First sentence. Last sentence. Last sentence. Pivot to the API layer.';
    expect(stripAndValidate('Last sentence.', continuation, prefix)).toBe('Pivot to the API layer.');
  });


  it('should handle anchor with trailing punctuation (Chinese)', () => {
    const anchor = '数据库连接正常。';
    const cont = '数据库连接正常。但缓存策略有问题。';
    expect(stripAndValidate(anchor, cont)).toBe('但缓存策略有问题。');
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


});

describe('selectBestContinuation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty string for empty continuations', async () => {
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, []);
    expect(result).toEqual({ text: '', index: -1 });
  });

  it('should return the single continuation when only one provided', async () => {
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, ['only option']);
    expect(result).toEqual({ text: 'only option', index: 0 });
    // forkChat should NOT be called when only one option
    expect(forkChat).not.toHaveBeenCalled();
  });

  it('should select option by number and return stored continuation when no second line', async () => {
    // First line is "2", no second line → returns continuations[1]
    vi.mocked(forkChat).mockImplementation(async () => '2' as never);
    const conts = ['first option', 'second option', 'third option'];
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, conts);
    expect(result).toEqual({ text: 'second option', index: 1 });
  });

  it('should use the continuation text from second line when provided and long enough', async () => {
    // First line "1", second line is >10 chars → returns the second line text
    vi.mocked(forkChat).mockImplementation(async () => '1\nThis is the full text from the second line.' as never);
    const conts = ['short', 'second', 'third'];
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, conts);
    // A PARAPHRASE IS NOT A DRAFT: the selector named option 1, so option 1 is
    // what merges. The typed-out text is discarded (it was never validated, and
    // shipping it left the card unable to name a winner).
    expect(result).toEqual({ text: 'short', index: 0 });
  });

  it('should fall back to the stored continuation when second line is too short', async () => {
    // Second line "short" is ≤10 chars → falls back to continuations[0]
    vi.mocked(forkChat).mockImplementation(async () => '1\nshort' as never);
    const conts = ['the actual first option', 'second', 'third'];
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, conts);
    expect(result).toEqual({ text: 'the actual first option', index: 0 });
  });

  it('should parse "Option N" prefix and return second line text when long enough', async () => {
    // "Option 3" parses to index 2; second line >10 chars → returns second line
    vi.mocked(forkChat).mockImplementation(async () => 'Option 3\nThird option full text here.' as never);
    const conts = ['first', 'second', 'third option'];
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, conts);
    expect(result).toEqual({ text: 'third option', index: 2 });
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
    expect(result).toEqual({ text: 'second option text here', index: 1 });
  });

  it('should fall back to first continuation when all parsing fails', async () => {
    vi.mocked(forkChat).mockImplementation(async () => 'I cannot decide.' as never);
    const conts = ['first', 'second', 'third'];
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, conts);
    expect(result).toEqual({ text: 'first', index: 0 });
  });

  it('should fall back to first continuation when forkChat throws', async () => {
    vi.mocked(forkChat).mockImplementation(async () => { throw new Error('network'); });
    const conts = ['first', 'second', 'third'];
    const result = await selectBestContinuation(MESSAGES, TOOLS, PREFIX, conts);
    expect(result).toEqual({ text: 'first', index: 0 });
  });

});

describe('handleCrossroad', () => {
  /**
   * Script the detector for a test. Detection is the detector's decision now, so
   * every case that must reach generation has to say WHERE the turn is: this
   * reports the FIRST occurrence of `word` in `content`, exactly like the real
   * client does (offset of the anchor in the original text).
   */
  function scriptTurn(content: string, word: string, score = 0.9): void {
    detectMock.mockResolvedValue({ word, index: content.indexOf(word), score });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    detectMock.mockImplementation(async () => null);
  });

  it('should return null when no turning word is detected', async () => {
    const content = 'This is a normal response with no turning word anywhere in the text at all.';
    const result = await handleCrossroad(MESSAGES, content, TOOLS);
    expect(result).toBeNull();
    // forkChat should not be called (detection failed before generation)
    expect(forkChat).not.toHaveBeenCalled();
  });

  it('should return the prefix, turning segment and selected continuation', async () => {
    // The turn sits in the SECOND paragraph and a third paragraph follows it:
    // the cut segment must have real text after it to form a remainder.
    const content =
      'Let me examine the database schema first.\n\nHowever, the real issue is in the API layer.\n\nI will inspect the router next.';
    // The prefix is verbatim text before the segment, so it keeps the paragraph
    // break; only the detector's segment itself is replaced.
    const anchor = 'Let me examine the database schema first.\n\n';
    scriptTurn(content, 'However');
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
    // The prefix is everything before the segment the detector flagged, including
    // the paragraph break that closed the previous paragraph (the package leaves a
    // following run with the text BEFORE it; the leading whitespace of the segment
    // itself is trimmed off the cut).
    expect(result!.truncated).toBe(anchor);
    // The cut is the flagged UNIT — mycc joins a clause-closed segment into its
    // sentence, so the replacement is the whole paragraph, never "However,".
    // (The unit is chosen by sentence structure; the score belongs to the
    // spanning window that contained it.)
    expect(result!.cutpoint).toBe('However, the real issue is in the API layer.');
    // The remainder is not a field on CrossroadResult — it is the tail of the
    // ORIGINAL text after the cut (`?` rather than `!` so `??` below is not
    // parsed as a nullish operator).
    const contentTail = content.slice(result!.cutEnd);
    expect(contentTail ?? result!.original).toBe('\n\nI will inspect the router next.');
    expect(result!.continuation).toBe('Go backward direction.');
  });

  it('should extract wordsBeforeTurn and enforce anchor in generation', async () => {
    const content =
      'I will read the config file and the environment loader first to see how defaults are applied.\n\nWait, the issue is in the env vars.\n\nI will trace that path instead.';
    scriptTurn(content, 'Wait');
    // All 3 dirs fail validation (don't start with anchor), retry also fails → empty
    // First batch: 6 calls → empty. handleCrossroad retries → 6 more → empty → null.
    vi.mocked(forkChat).mockImplementation(async () => 'No anchor present here.' as never);

    const result = await handleCrossroad(MESSAGES, content, TOOLS);

    expect(result).toBeNull();
    // 6 (first batch) + 6 (retry batch) = 12
    expect(forkChat).toHaveBeenCalledTimes(12);
  });

  it('should handle single continuation (no selection needed)', async () => {
    const content =
      'Let me check the schema first, then trace how the rows are joined.\n\nBut the real problem is elsewhere.\n\nI will start with the join order.';
    const anchor = 'Let me check the schema first, then trace how the rows are joined.';
    scriptTurn(content, 'But');
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
    const content =
      'Let me check the schema first and the migration step after it.\n\nHowever, this needs rethinking.\n\nI will start over from the entity map.';
    scriptTurn(content, 'However');
    // forkChat returns empty string for all → stripInternalMarkup → '' → no continuation
    vi.mocked(forkChat).mockImplementation(async () => '' as never);

    const result = await handleCrossroad(MESSAGES, content, TOOLS);
    expect(result).toBeNull();
  });
});

describe('handleCrossroad — turning point integration (detector-owned)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectMock.mockImplementation(async () => null);
  });

  it('should split the content at the detector-reported turning point', async () => {
    // The turn sits in the second paragraph and a third follows it, so the cut
    // segment has text after it to form a remainder.
    const content =
      '我们需要再仔细检查一遍数据库连接的配置方式，以及缓存层的失效策略是否真的生效了。\n\n但根本问题可能在配置文件里。\n\n先从这里开始排查一下配置的加载顺序。';
    const anchor = '我们需要再仔细检查一遍数据库连接的配置方式，以及缓存层的失效策略是否真的生效了。\n\n';
    detectMock.mockResolvedValueOnce({ word: '但', index: content.indexOf('但'), score: 0.93 });
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
    // The package closes the flagged segment at the sentence terminator, so the
    // sentence is the unit that is replaced (the turn itself is the only sentence
    // after the paragraph break).
    expect(result!.cutpoint).toBe('但根本问题可能在配置文件里。');
    expect(result!.cutStart).toBe(anchor.length);
    // The three segments reassemble the untouched response.
    expect(result!.truncated + result!.cutpoint + result!.original).toBe(content);
    expect(result!.continuation).toBe('从更高层次综合。');
  });

  it('should report the whole flagged segment as the cutpoint', async () => {
    const content =
      'Let me examine the database schema first.\n\nHowever, the real issue is in the API layer.\n\nI will inspect the router next.';
    // The anchor (used for the continuation echo) is the last sentence; the
    // PREFIX also carries the paragraph break that closed that paragraph —
    // the rule: a segment starts where its preceding boundary run ENDS, so the
    // run belongs to the text before it.
    const anchor = 'Let me examine the database schema first.';
    const prefix = 'Let me examine the database schema first.\n\n';
    detectMock.mockResolvedValueOnce({ word: 'However', index: content.indexOf('However'), score: 0.88 });
    queueForkChat(
      `${anchor} Go forward direction.`,
      `${anchor} Go backward direction.`,
      `${anchor} Synthesize direction.`,
      '2',
    );

    const result = await handleCrossroad(MESSAGES, content, TOOLS);

    // The cutpoint is the UNIT, not the turning word: the whole sentence the turn
    // opens, without the paragraph mark before it and without the leading space
    // the package keeps inside  Wait,.
    expect(result!.truncated).toBe(prefix);
    expect(result!.cutpoint).toBe('However, the real issue is in the API layer.');
    expect(result!.original).toBe('\n\nI will inspect the router next.');
    expect(result!.selectedIndex).toBe(1);
  });

  it('should return null when the detector reports no turn (no local fallback)', async () => {
    // The old regex would have matched "However" here. Detection is now the
    // detector's decision alone: a null answer means crossroad does not fire.
    const content = 'Let me examine the database schema first. However, the real issue is in the API.';
    detectMock.mockResolvedValueOnce(null);

    const result = await handleCrossroad(MESSAGES, content, TOOLS);

    expect(result).toBeNull();
    expect(forkChat).not.toHaveBeenCalled();
  });

  it('should return null — not throw — when the detector rejects', async () => {
    const content = 'Let me examine the database schema first. However, the real issue is in the API.';
    detectMock.mockRejectedValueOnce(new Error('server unavailable'));

    const result = await handleCrossroad(MESSAGES, content, TOOLS);

    expect(result).toBeNull();
    expect(forkChat).not.toHaveBeenCalled();
  });

  it('should not fire when the detector match yields an unusable cut', async () => {
    // "However" at position 0 leaves no prefix: the continuation has nothing to
    // anchor on, so the detector's answer is rejected rather than applied.
    const content = 'However, we should reconsider the entire approach from scratch.';
    detectMock.mockResolvedValueOnce({ word: 'However', index: 0, score: 0.91 });

    const result = await handleCrossroad(MESSAGES, content, TOOLS);

    expect(result).toBeNull();
    expect(forkChat).not.toHaveBeenCalled();
  });
});


