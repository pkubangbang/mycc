/**
 * recap-signal.test.ts — the OBSERVER half of auto-recap.
 *
 * The invariant under test: REWIND AUTHORITY IS EXTERNAL TO THE CONTEXT BEING
 * REWOUND. `evaluateRecapSignal()` reads only the brief stack (one line per
 * foldable span) plus the token usage, asks a forced `decide_recap` tool, and
 * answers `recap` / `skip` / `failed`. Nothing here reads the conversation, and
 * nothing here throws: a failed signal must leave the brief turn intact.
 *
 * The three verdicts are deliberately distinguishable:
 *   - `skip`   — a settled decision (also the safe degradation for an
 *                unaddressable target, and the short-circuit for zero candidates);
 *   - `failed` — the call threw / the user pressed ESC: NOT a decision;
 *   - `recap`  — fold to `target`, ALWAYS a hash from the candidate list.
 *
 * MOCK NOTE: `evaluateRecapSignal` builds its request BEFORE awaiting, so a
 * `mockImplementationOnce(() => { throw …})` would throw inside the code under
 * test rather than at the awaited call — that is why `resetAllMocks()` (which
 * DRAINS the `…Once` queues) is mandatory between cases: a leftover queue entry
 * silently answers the wrong test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { retryChatMock, startSpinnerMock, stopSpinnerMock } = vi.hoisted(() => ({
  retryChatMock: vi.fn(),
  startSpinnerMock: vi.fn(),
  stopSpinnerMock: vi.fn(),
}));

vi.mock('../../engine/chat-provider.js', () => ({
  retryChat: retryChatMock,
  MODEL: 'test-model',
}));

vi.mock('../../engine/chat-helpers.js', () => ({
  startSpinner: startSpinnerMock,
  stopSpinner: stopSpinnerMock,
}));

import { evaluateRecapSignal, type FoldCandidate } from '../../loop/recap-signal.js';

/** Two foldable spans, oldest first — the shape `getFoldCandidates()` returns. */
const CANDIDATES: FoldCandidate[] = [
  { hash: 'aaaa1111', message: 'mapped the parser and chose a design', id: 'brief_1', spanMessages: 4, spanTokens: 1200 },
  { hash: 'bbbb2222', message: 'landed the fix, tests green', id: 'brief_2', spanMessages: 9, spanTokens: 8600 },
];

const USAGE = { tokens: 20000, threshold: 50000 };

/** A provider response carrying exactly one `decide_recap` call. */
function verdict(args: Record<string, unknown> | string) {
  return {
    message: {
      tool_calls: [
        {
          id: 'call_decide',
          function: {
            name: 'decide_recap',
            arguments: typeof args === 'string' ? args : JSON.stringify(args),
          },
        },
      ],
    },
  };
}

/** The request the signal built, as the provider saw it. */
function lastRequest(): {
  messages: Array<{ role: string; content: string }>;
  tools: Array<{ function: { name: string } }>;
  tool_choice: string;
} {
  return retryChatMock.mock.calls[0][0];
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): the `…Once` queues must be DRAINED, or a
  // verdict set by an earlier case answers a later one.
  vi.resetAllMocks();
});

describe('evaluateRecapSignal — verdicts', () => {
  it('folds to the hash the decider named', async () => {
    retryChatMock.mockResolvedValueOnce(
      verdict({ recap: true, target_brief: 'bbbb2222', reason: 'the fix is finished' }),
    );

    const result = await evaluateRecapSignal(CANDIDATES, USAGE);

    expect(result).toEqual({ status: 'recap', target: 'bbbb2222', reason: 'the fix is finished' });
  });

  it('honours a hash wrapped in brackets and in any case', async () => {
    // The list shows `[aaaa1111] "…"`; a model may echo the brackets verbatim.
    retryChatMock.mockResolvedValueOnce(verdict({ recap: true, target_brief: '[AAAA1111]', reason: 'done' }));

    const result = await evaluateRecapSignal(CANDIDATES, USAGE);

    expect(result).toMatchObject({ status: 'recap', target: 'aaaa1111' });
  });

  it('returns skip when the decider says no', async () => {
    retryChatMock.mockResolvedValueOnce(verdict({ recap: false, reason: 'newer work still depends on it' }));

    const result = await evaluateRecapSignal(CANDIDATES, USAGE);

    expect(result).toEqual({ status: 'skip', reason: 'newer work still depends on it' });
  });

  it('supplies a reason when the decider gives none', async () => {
    retryChatMock.mockResolvedValueOnce(verdict({ recap: false }));

    const result = await evaluateRecapSignal(CANDIDATES, USAGE);

    expect(result).toEqual({ status: 'skip', reason: 'no reason given' });
  });
});

describe('evaluateRecapSignal — an unaddressable target is a SKIP, never a default', () => {
  // Folding somewhere the decider did not choose would delete a span it meant
  // to keep — the one failure this design must not have.

  it('skips when recap=true names an unknown hash', async () => {
    retryChatMock.mockResolvedValueOnce(verdict({ recap: true, target_brief: 'ffff9999', reason: 'x' }));

    const result = await evaluateRecapSignal(CANDIDATES, USAGE);

    expect(result.status).toBe('skip');
    expect((result as { reason: string }).reason).toContain('unknown brief');
  });

  it('skips when recap=true names no target at all', async () => {
    retryChatMock.mockResolvedValueOnce(verdict({ recap: true, reason: 'x' }));

    const result = await evaluateRecapSignal(CANDIDATES, USAGE);

    expect(result.status).toBe('skip');
    expect((result as { reason: string }).reason).toContain('(none)');
  });

  it('skips when the arguments are not valid JSON', async () => {
    retryChatMock.mockResolvedValueOnce(verdict('{not json'));

    const result = await evaluateRecapSignal(CANDIDATES, USAGE);

    expect(result).toEqual({ status: 'skip', reason: 'signal returned malformed JSON' });
  });

  it('skips when the model answered without a tool call', async () => {
    retryChatMock.mockResolvedValueOnce({ message: {} });

    const result = await evaluateRecapSignal(CANDIDATES, USAGE);

    expect(result).toEqual({ status: 'skip', reason: 'signal returned no verdict' });
  });
});

describe('evaluateRecapSignal — failures are observable, not decisions', () => {
  it('reports failed when the call rejects', async () => {
    retryChatMock.mockRejectedValueOnce(new Error('network down'));

    const result = await evaluateRecapSignal(CANDIDATES, USAGE);

    expect(result).toEqual({ status: 'failed' });
  });

  it('reports failed when ESC cancels the call (escAware cleanup path)', async () => {
    // escAware wraps the provider call; on ESC it runs the cleanup and returns
    // the cleanup value, never the provider answer.
    const escAware = vi.fn(async <T,>(_fn: (ac: AbortController) => Promise<T>, cleanup: () => unknown) => cleanup());
    retryChatMock.mockResolvedValueOnce(verdict({ recap: false, reason: 'never seen' }));

    const result = await evaluateRecapSignal(CANDIDATES, USAGE, escAware as never);

    expect(escAware).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'failed' });
  });

  it('reports failed when the escAware runner rejects (provider fault)', async () => {
    // The production escAware re-throws whatever the wrapped fn threw, so a
    // provider fault reaches the signal's catch — it must degrade to `failed`.
    const escAware = vi.fn(<T,>(_fn: (ac: AbortController) => Promise<T>) => Promise.reject(new TypeError('boom')));

    await expect(evaluateRecapSignal(CANDIDATES, USAGE, escAware as never)).resolves.toEqual({ status: 'failed' });
  });

  it('never throws, whatever the provider does', async () => {
    // Without an escAware runner the call is direct; a rejecting provider still
    // yields a verdict instead of propagating.
    retryChatMock.mockRejectedValueOnce(new TypeError('boom'));

    await expect(evaluateRecapSignal(CANDIDATES, USAGE)).resolves.toEqual({ status: 'failed' });
  });
});

describe('evaluateRecapSignal — short-circuit', () => {
  it('skips without an LLM call when there is nothing to fold', async () => {
    const result = await evaluateRecapSignal([], USAGE);

    expect(result).toEqual({ status: 'skip', reason: 'no foldable span yet' });
    expect(retryChatMock).not.toHaveBeenCalled();
    expect(startSpinnerMock).not.toHaveBeenCalled();
  });
});

describe('evaluateRecapSignal — the prompt', () => {
  it('shows EXACTLY one line per candidate, oldest first, with its size', async () => {
    retryChatMock.mockResolvedValueOnce(verdict({ recap: false, reason: 'no' }));

    await evaluateRecapSignal(CANDIDATES, USAGE);

    const user = lastRequest().messages.find((m) => m.role === 'user')!.content;
    const lines = user.split('\n').filter((l) => l.startsWith('['));
    expect(lines).toHaveLength(CANDIDATES.length);
    expect(lines[0]).toContain('[aaaa1111]');
    expect(lines[0]).toContain('"mapped the parser and chose a design"');
    expect(lines[0]).toContain('4 msgs / ~1.2k tok');
    expect(lines[1]).toContain('[bbbb2222]');
    expect(lines[1]).toContain('9 msgs / ~8.6k tok');
  });

  it('clips a runaway brief message to 200 chars', async () => {
    retryChatMock.mockResolvedValueOnce(verdict({ recap: false, reason: 'no' }));
    const long: FoldCandidate = {
      ...CANDIDATES[0],
      message: 'x'.repeat(500),
    };

    await evaluateRecapSignal([long], USAGE);

    const user = lastRequest().messages.find((m) => m.role === 'user')!.content;
    const quoted = user.split('\n').find((l) => l.startsWith('['))!.match(/"([^"]*)"/)![1];
    expect(quoted.length).toBe(200); // 199 chars + the ellipsis
    expect(quoted.endsWith('…')).toBe(true);
  });

  it('reports context usage on the same scale as the span sizes', async () => {
    retryChatMock.mockResolvedValueOnce(verdict({ recap: false, reason: 'no' }));

    await evaluateRecapSignal(CANDIDATES, { tokens: 10000, threshold: 50000 });

    const user = lastRequest().messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('Context usage: 10.0k / 50.0k tokens (20%).');
  });

  it('forces a single structured-output tool and a bounded retry budget', async () => {
    retryChatMock.mockResolvedValueOnce(verdict({ recap: false, reason: 'no' }));

    await evaluateRecapSignal(CANDIDATES, USAGE);

    const req = lastRequest();
    expect(req.tools.map((t) => t.function.name)).toEqual(['decide_recap']);
    expect(req.tool_choice).toBe('required');
    // TWO retries around a structured call that MUST produce a tool call;
    // the caller owns the only visible spinner, so the inner one is off.
    expect(retryChatMock.mock.calls[0][1]).toMatchObject({ maxRetries: 2, noSpinner: true });
  });

  it('paints ONE spinner pair — "Managing the context" — around the whole call', async () => {
    retryChatMock.mockResolvedValueOnce(verdict({ recap: false, reason: 'no' }));

    await evaluateRecapSignal(CANDIDATES, USAGE);

    expect(startSpinnerMock).toHaveBeenCalledTimes(1);
    expect(startSpinnerMock).toHaveBeenCalledWith(expect.stringContaining('Managing the context'));
    expect(stopSpinnerMock).toHaveBeenCalledTimes(1);
  });

  it('stops the spinner even when the call rejects', async () => {
    retryChatMock.mockRejectedValueOnce(new Error('boom'));

    await evaluateRecapSignal(CANDIDATES, USAGE);

    expect(stopSpinnerMock).toHaveBeenCalledTimes(1);
  });
});
