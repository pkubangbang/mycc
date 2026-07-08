/**
 * esc-wrap-up-lifecycle.test.ts — Layer C: ESC wrap-up state lifecycle.
 *
 * Tests the esc-wrap-up.ts module's state management in isolation:
 *   startWrapUp → (background promise) → evaluateWrapUp → commit/rollback
 *
 * Code under test (esc-wrap-up.ts):
 *   - startWrapUp(triologue, tools): calls beginWrapUp(), runs runWrapUpLLM
 *     in background, sets wrapUpState.{promise,triologue}. On resolve sets
 *     content + completedAt, calls triologue.finishWrapUp(content).
 *   - evaluateWrapUp(): returns 'commit' if content ready AND past 3s grace
 *     period; otherwise 'rollback'.
 *   - clearWrapUp(): resets singleton state.
 *   - getWrapUpState / hasPendingWrapUp / markWrapUpShown: accessors.
 *
 * The module holds a MODULE-LEVEL singleton (wrapUpState), so tests MUST call
 * clearWrapUp() in beforeEach to isolate state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

vi.mock('../../../engine/chat-provider.js', () => ({
  retryChat: vi.fn(),
  MODEL: 'test-model',
}));

vi.mock('../../../config.js', () => ({
  getApiProvider: vi.fn(() => 'ollama'),
  isVerbose: vi.fn(() => false),
}));

vi.mock('../../../utils/letter-box.js', () => ({
  displayLetterBox: vi.fn(),
}));

vi.mock('../../../loop/triologue.js', () => {
  class TriologueStub {
    beginWrapUp = vi.fn();
    finishWrapUp = vi.fn();
    commitWrapUp = vi.fn();
    rollbackWrapUp = vi.fn();
    hasActiveWrapUp = vi.fn(() => false);
    getMessages = vi.fn(() => []);
  }
  return { Triologue: TriologueStub };
});

// --- Imports after mocks -----------------------------------------------------
import {
  startWrapUp,
  evaluateWrapUp,
  clearWrapUp,
  getWrapUpState,
  hasPendingWrapUp,
  markWrapUpShown,
  displayWrapUp,
} from '../../../loop/esc-wrap-up.js';
import { retryChat } from '../../../engine/chat-provider.js';
import { displayLetterBox } from '../../../utils/letter-box.js';
import { Triologue } from '../../../loop/triologue.js';

describe('ESC wrap-up lifecycle (esc-wrap-up.ts state management)', () => {
  let triologue: Triologue;
  let realDateNow: typeof Date.now;

  beforeEach(() => {
    vi.clearAllMocks();
    clearWrapUp(); // reset module singleton before each test
    triologue = new Triologue();
    realDateNow = Date.now;
  });

  afterEach(() => {
    // Restore Date.now in case a test mocked it
    Date.now = realDateNow;
  });

  // [1] startWrapUp kicks off the lifecycle
  it('should call triologue.beginWrapUp and start a background promise on startWrapUp', async () => {
    // Make retryChat resolve so the background promise settles quickly
    vi.mocked(retryChat).mockResolvedValueOnce({
      message: { role: 'assistant', content: 'wrap-up text' },
      done: true,
    } as never);

    startWrapUp(triologue, [{ function: { name: 'bash' } }]);

    expect(triologue.beginWrapUp).toHaveBeenCalledTimes(1);
    const state = getWrapUpState();
    expect(state.promise).toBeInstanceOf(Promise);
    expect(state.triologue).toBe(triologue);

    // Wait for the background promise to settle
    await state.promise;
    // After completion, finishWrapUp is called with the content
    expect(triologue.finishWrapUp).toHaveBeenCalledWith('wrap-up text');
  });

  // [2] evaluateWrapUp returns 'rollback' when no content (not completed)
  it('should return rollback from evaluateWrapUp when wrap-up has not completed', () => {
    vi.mocked(retryChat).mockReturnValueOnce(new Promise(() => {})); // never resolves
    startWrapUp(triologue);

    expect(evaluateWrapUp()).toBe('rollback');
  });

  // [3] evaluateWrapUp returns 'rollback' when within the 3s grace period
  it('should return rollback from evaluateWrapUp when within 3s grace period', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce({
      message: { role: 'assistant', content: 'done' },
      done: true,
    } as never);

    startWrapUp(triologue);
    await getWrapUpState().promise; // wait for completion (completedAt = now)

    // Immediately after completion → within grace period
    expect(evaluateWrapUp()).toBe('rollback');
  });

  // [4] evaluateWrapUp returns 'commit' when past the 3s grace period
  it('should return commit from evaluateWrapUp when past 3s grace period', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce({
      message: { role: 'assistant', content: 'done' },
      done: true,
    } as never);

    startWrapUp(triologue);
    await getWrapUpState().promise;

    // Advance the clock past the 3s (3000ms) grace period
    const completionTime = Date.now();
    Date.now = vi.fn(() => completionTime + 3001) as never;

    expect(evaluateWrapUp()).toBe('commit');
  });

  // [5] evaluateWrapUp returns 'rollback' when content is empty (failed LLM)
  it('should return rollback from evaluateWrapUp when wrap-up content is empty', async () => {
    // retryChat returns empty content
    vi.mocked(retryChat).mockResolvedValueOnce({
      message: { role: 'assistant', content: '' },
      done: true,
    } as never);

    startWrapUp(triologue);
    await getWrapUpState().promise;

    // Even past grace period, empty content → rollback (no wrap-up to show)
    const completionTime = Date.now();
    Date.now = vi.fn(() => completionTime + 5000) as never;

    expect(evaluateWrapUp()).toBe('rollback');
  });

  // [6] hasPendingWrapUp / markWrapUpShown tracking
  it('should report pending wrap-up until marked shown', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce({
      message: { role: 'assistant', content: 'pending text' },
      done: true,
    } as never);

    startWrapUp(triologue);
    await getWrapUpState().promise;

    expect(hasPendingWrapUp()).toBe(true);
    markWrapUpShown();
    expect(hasPendingWrapUp()).toBe(false);
  });

  // [7] displayWrapUp shows non-empty content via displayLetterBox
  it('should call displayLetterBox with content when displayWrapUp is given non-empty content', () => {
    displayWrapUp('hello wrap-up');
    expect(displayLetterBox).toHaveBeenCalledWith('hello wrap-up');
  });

  // [8] clearWrapUp resets the singleton state
  it('should reset all singleton state on clearWrapUp', async () => {
    vi.mocked(retryChat).mockResolvedValueOnce({
      message: { role: 'assistant', content: 'text' },
      done: true,
    } as never);

    startWrapUp(triologue);
    await getWrapUpState().promise;

    expect(getWrapUpState().content).not.toBeNull();

    clearWrapUp();

    const state = getWrapUpState();
    expect(state.promise).toBeNull();
    expect(state.content).toBeNull();
    expect(state.completedAt).toBeNull();
    expect(state.shown).toBe(false);
    expect(state.triologue).toBeNull();
  });
});