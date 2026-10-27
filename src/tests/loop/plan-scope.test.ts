/**
 * plan-scope.test.ts — the PLAN-mode "larger scope" reflection.
 *
 * Contract (see src/loop/plan-scope.ts):
 *   - it is appended to the BRIEF'S TOOL RESULT: `OK. When thinking on the
 *     larger scope, …` — produced at the TOOL stage, never by the brief tool
 *     and never as a field on the call;
 *   - a recap of this stretch OVERWRITES it (it rides in the anchor's note slot),
 *     so it is one-shot by construction;
 *   - a failed / empty / over-budget reflection leaves the plain success result;
 *   - it must fit under tool()'s result threshold (an over-size result is
 *     dumped to a file instead of stored).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/chat-provider.js', () => ({
  forkChat: vi.fn(async () => ''),
}));
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { verbose: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn(), brief: vi.fn() },
}));

import { forkChat } from '../../engine/chat-provider.js';
import { buildPlanScopeNote, withPlanScopeNote } from '../../loop/plan-scope.js';
import { BRIEF_OK, PLAN_SCOPE_HEADING } from '../../loop/triologue/recap-note.js';
import type { Message, Tool } from '../../types.js';

const messages: Message[] = [{ role: 'user', content: 'plan the parser refactor' }];
const tools: Tool[] = [];
/** The caller's ESC-aware runner: here it just runs the operation. */
const escAware = async <T>(fn: (ac: AbortController) => Promise<T>): Promise<T> =>
  fn(new AbortController());

const BASE = {
  messages,
  tools,
  briefMessage: 'recon done',
  resultThreshold: 25_000,
  escAware,
};

describe('buildPlanScopeNote', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs the fork through escAware (so ESC can cancel it)', async () => {
    vi.mocked(forkChat).mockResolvedValue('a reflection');
    const run = vi.fn(escAware);
    await buildPlanScopeNote({ ...BASE, escAware: run as never });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('asks the four escape-hatch checks, and offers no tools and no escape-free format', async () => {
    vi.mocked(forkChat).mockResolvedValue('a reflection');
    await buildPlanScopeNote(BASE);

    const args = (vi.mocked(forkChat).mock.calls[0] as unknown[]) as [unknown, unknown, string];
    const prompt = args[2];
    // The four framings that make this a GLOBAL check, not a progress review.
    for (const label of ['TUNNEL', 'SUBLATE', 'WRONG PRB', 'REVERSIBLE']) {
      expect(prompt).toContain(`${label}:`);
    }
    // Text-only: the model is told it cannot read anything new, and that NAMING
    // a required read beats guessing what the file says.
    expect(prompt).toContain('you cannot read anything new');
    expect(prompt).toContain('needs read of');
    // "none" must stay a legal answer on every line, or the model invents a
    // tunnel to fill the format.
    // A BARE "none" is banned: it is exactly the boilerplate the reflection
    // exists to prevent. Each line must justify why the wider frame misses.
    expect(prompt).toContain('A bare "none" is NOT acceptable');
    // The old prose constraint is gone: a single paragraph cannot carry four
    // checkable claims, it collapses into restatement.
    expect(prompt).not.toContain('150-400 words');
    expect(prompt).not.toContain('one paragraph');
  });

  it('returns null when ESC cancels the fork (cleanup value)', async () => {
    vi.mocked(forkChat).mockResolvedValue('ignored');
    const cancelled = (async () => null) as never;
    expect(await buildPlanScopeNote({ ...BASE, escAware: cancelled })).toBeNull();
  });

  it('returns the paragraph normalized to the required opening', async () => {
    vi.mocked(forkChat).mockResolvedValue('you are about to rewrite parser.ts twice');
    const note = await buildPlanScopeNote(BASE);
    expect(note).toMatch(new RegExp(`^${PLAN_SCOPE_HEADING}, `));
    expect(note).toContain('rewrite parser.ts twice');
  });

  it('does not duplicate the opening when the model already wrote it', async () => {
    vi.mocked(forkChat).mockResolvedValue(`${PLAN_SCOPE_HEADING}, decide the interface first.`);
    const note = await buildPlanScopeNote(BASE);
    expect(note).toBe(`${PLAN_SCOPE_HEADING}, decide the interface first.`);
  });

  it('strips a leading reasoning echo', async () => {
    vi.mocked(forkChat).mockResolvedValue('<thinking>private monologue</thinking>\nthe real reflection');
    const note = await buildPlanScopeNote(BASE);
    expect(note).not.toContain('private monologue');
    expect(note).toContain('the real reflection');
  });

  it('returns null on an empty reflection, a fork failure, or no budget', async () => {
    vi.mocked(forkChat).mockResolvedValue('   ');
    expect(await buildPlanScopeNote(BASE)).toBeNull();

    vi.mocked(forkChat).mockRejectedValue(new Error('provider down'));
    expect(await buildPlanScopeNote(BASE)).toBeNull();

    vi.mocked(forkChat).mockResolvedValue('a reflection');
    expect(await buildPlanScopeNote({ ...BASE, resultThreshold: 400 })).toBeNull();
  });

  it('clamps to stay under the tool-result threshold', async () => {
    vi.mocked(forkChat).mockResolvedValue('word '.repeat(20_000));
    const note = (await buildPlanScopeNote(BASE))!;
    expect(withPlanScopeNote(note).length).toBeLessThan(BASE.resultThreshold);
    expect(note).toContain('…(truncated)');
  });

  it('composes with the success line as one result', () => {
    expect(withPlanScopeNote(`${PLAN_SCOPE_HEADING}, x`)).toBe(`${BRIEF_OK}. ${PLAN_SCOPE_HEADING}, x`);
  });
});
