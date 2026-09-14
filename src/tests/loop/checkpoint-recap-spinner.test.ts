/**
 * checkpoint-recap-spinner.test.ts — the recap wait indicator.
 *
 * Regression test for the "mycc looks stuck during recap" bug:
 *   forkChat hard-codes `noSpinner: true` (src/engine/chat-provider.ts), and
 *   retryChat only paints the spinner when `!noSpinner`. So the ONE long-wait
 *   forkChat caller that never started its own spinner — the recap — left the
 *   terminal completely silent for the whole summarization (~10-60s of LLM
 *   time), which reads as a hung process even though the two forks are
 *   running normally.
 *
 * The fix puts the spinner at the ORCHESTRATOR boundary instead of inside
 * forkChat: handleRecapWithPatch() owns ONE startSpinner/stopSpinner pair
 * around its concurrent Promise.all. One pair (not one per fork) because the
 * spinner is a non-refcounted module-global: the first fork to settle would
 * otherwise stopSpinner() while the other is still streaming.
 *
 * What this file pins down:
 *   - startSpinner fires ONCE, BEFORE the forks resolve
 *   - stopSpinner fires ONCE, AFTER the forks resolve (success path)
 *   - stopSpinner still fires when a fork REJECTS (finally, not happy-path)
 *   - exactly ONE startSpinner even with a mindmap (two concurrent forks)
 *   - no spinner leak on the ESC path (escAware → null cleanup result)
 *
 * Mock strategy (same shape as src/tests/crossroad/generation.test.ts):
 *   - engine/chat-provider.js: forkChat mocked, driven per call
 *   - engine/chat-helpers.js: startSpinner/stopSpinner recorded
 *   - mindmap is a hand-built minimal tree (generatePatchAction needs the root;
 *     an unrecognized patch response parses to "none", so the patch fork
 *     resolves null without exercising patch mechanics)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ------------------------------------------------------------------

vi.mock('../../engine/chat-provider.js', () => ({
  forkChat: vi.fn(),
  MODEL: 'test-model',
}));

vi.mock('../../engine/chat-helpers.js', () => ({
  startSpinner: vi.fn(),
  stopSpinner: vi.fn(),
}));

// --- Imports after mocks ----------------------------------------------------

import { forkChat } from '../../engine/chat-provider.js';
import { startSpinner, stopSpinner } from '../../engine/chat-helpers.js';
import { handleRecapWithPatch } from '../../loop/checkpoint-recap.js';
import type { Mindmap } from '../../mindmap/types.js';
import type { Message, Tool } from '../../types.js';

// --- Fixtures ---------------------------------------------------------------

const MESSAGES: Message[] = [
  { role: 'user', content: 'do the thing' },
  { role: 'assistant', content: 'working on it' },
];

/** Full tools array — present only so the forks have something to pass through. */
const TOOLS: Tool[] = [
  { type: 'function', function: { name: 'bash', description: 'run', parameters: {} } },
];

/** Minimal mindmap: the patch fork reads root + walks the tree for its outline. */
const MINDMAP: Mindmap = {
  hash: 'testhash',
  root: {
    id: '/',
    title: 'root',
    text: 'root node',
    level: 0,
    is_mycc: true,
    children: [],
  },
} as unknown as Mindmap;

/**
 * Resolve every fork only after this promise is released, so a test can assert
 * "spinner already started, forks still in flight".
 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('handleRecapWithPatch — recap wait indicator (spinner)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts the spinner before the forks settle and stops it after (success path)', async () => {
    const gate = deferred<string>();
    vi.mocked(forkChat).mockImplementation(async () => gate.promise);

    const pending = handleRecapWithPatch(
      MESSAGES,
      TOOLS,
      'explore the parser',
      null, // no mindmap → single fork
      'abc12345',
    );

    // Let the startSpinner() + Promise.all setup run to the first await.
    await Promise.resolve();
    await Promise.resolve();

    // Spinner is up WHILE the forks are still in flight.
    expect(startSpinner).toHaveBeenCalledTimes(1);
    expect(stopSpinner).not.toHaveBeenCalled();

    gate.resolve('summary text');
    const result = await pending;

    expect(result.summary).toContain('summary text');
    // Spinner is cleared once, after the wait.
    expect(stopSpinner).toHaveBeenCalledTimes(1);
  });

  it('stops the spinner even when a fork rejects (finally, not happy-path)', async () => {
    vi.mocked(forkChat).mockRejectedValue(new Error('network down'));

    await expect(
      handleRecapWithPatch(MESSAGES, TOOLS, 'explore the parser', null, 'abc12345'),
    ).rejects.toThrow('network down');

    // A leaked spinner would leave the terminal line painted forever after a
    // failed recap — the exact stuck-looking state this fix removes.
    expect(startSpinner).toHaveBeenCalledTimes(1);
    expect(stopSpinner).toHaveBeenCalledTimes(1);
  });

  it('starts exactly ONE spinner for the two concurrent forks (mindmap present)', async () => {
    // Summary fork returns prose; patch fork returns "none" (no patch warranted).
    vi.mocked(forkChat).mockResolvedValue('none');

    await handleRecapWithPatch(
      MESSAGES,
      TOOLS,
      'explore the parser',
      MINDMAP,
      'abc12345',
    );

    // Both forks ran (summary + patch decision)...
    expect(forkChat).toHaveBeenCalledTimes(2);
    // ...behind a single spinner pair. Per-fork wrapping would double-start
    // (no-op) and double-stop (clearing the line mid-recap).
    expect(startSpinner).toHaveBeenCalledTimes(1);
    expect(stopSpinner).toHaveBeenCalledTimes(1);
  });

  it('does not leak the spinner when ESC wins the race (escAware returns the cleanup value)', async () => {
    // escAware contract: on ESC the operation is abandoned and the cleanup
    // result is returned. handleRecap maps that to the "[RECAP] Cancelled"
    // sentinel; the patch fork maps it to null. Neither hits the real forkChat.
    const escAware = async <T>(
      _fn: (ac: AbortController) => Promise<T>,
      cleanup: () => T,
    ): Promise<T> => cleanup();

    const result = await handleRecapWithPatch(
      MESSAGES,
      TOOLS,
      'explore the parser',
      MINDMAP,
      'abc12345',
      escAware,
    );

    expect(result.summary).toContain('[RECAP] Cancelled');
    expect(result.patch).toBeNull();
    expect(startSpinner).toHaveBeenCalledTimes(1);
    expect(stopSpinner).toHaveBeenCalledTimes(1);
  });
});
