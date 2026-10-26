/**
 * hook-plan-scope.test.ts — plan-mode scope reflection at the HOOK boundary.
 *
 * The reflection is produced in the HOOK stage (states/hook.ts
 * handlePlanScopeBrief) and registered as the brief's own tool result:
 *
 *   tool('brief', "[<hash>] ANCHOR — recap(target=\"<hash>\") folds the work after this point
 *                 When thinking on the larger scope, …", callId)
 *
 * Why HOOK: this is the first point in the turn where the brief call exists in a
 * FORKABLE history — the assistant message carrying it is not registered yet, so
 * the prefix ends on a complete round-trip. (In the TOOL stage the assistant call
 * is already stored while its result is not, and a fork there would send
 * `assistant(tool_calls) → user`, which strict providers reject.)
 *
 * Contract pinned here:
 *   1. NORMAL mode → no fork, no registration: the turn proceeds to TOOL and the
 *      brief executes exactly as before;
 *   2. PLAN mode   → one fork; the turn is registered in HOOK (assistant + tool
 *      result) and COLLECT is returned, so the brief tool never runs;
 *   3. the result keeps the "OK." prefix, so it is still the recap anchor's note
 *      slot, and a later recap overwrites the reflection with the summary;
 *   4. failure / ESC / empty output → fall through to the normal turn (a
 *      reflection never fails a brief).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted, so shared mocks must come from vi.hoisted.
const { forkChat } = vi.hoisted(() => ({ forkChat: vi.fn(async () => '') }));

vi.mock('../../../engine/chat-provider.js', () => ({ forkChat }));

vi.mock('../../../loop/agent-io.js', () => {
  let neglected = false;
  return {
    agentIO: {
      isNeglectedMode: vi.fn(() => neglected),
      setNeglectedMode: vi.fn((v: boolean) => { neglected = v; }),
      log: vi.fn(),
      brief: vi.fn(),
      verbose: vi.fn(),
      warn: vi.fn(),
    },
  };
});

vi.mock('../../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => [{ function: { name: 'read_file' } }]) },
}));

vi.mock('../../../hook/hook-preprocessor.js', () => ({
  augmentToolCalls: vi.fn((calls: unknown[]) => calls),
}));

vi.mock('../../../loop/recap-rewind.js', () => ({
  validateRecapIsolation: vi.fn(() => ({ valid: true })),
  handleRecap: vi.fn(),
  handleRecapSpan: vi.fn(),
}));

vi.mock('../../../mindmap/patch.js', () => ({ applyPatchAction: vi.fn(() => true) }));
vi.mock('../../../mindmap/patch-jsonl.js', () => ({
  appendPatch: vi.fn(),
  getPatchPath: vi.fn(() => '/tmp/.mycc/mindmap-patch.jsonl'),
}));

import { handleHook } from '../../../loop/states/hook.js';
import { AgentState } from '../../../loop/state-machine.js';
import { agentIO } from '../../../loop/agent-io.js';
import { Triologue } from '../../../loop/triologue.js';
import { PLAN_SCOPE_HEADING } from '../../../loop/triologue/recap-note.js';
import {
  createTurnVars,
  createChatData,
  createMockMachineEnv,
  createMockAugmentedToolCall,
  createMockHookResult,
} from '../esc-test-helpers.js';

const REFLECTION = 'The plan assumes parser.ts exposes a token stream; decide that interface before the CLI work.';

function makeEnv(mode: 'plan' | 'normal') {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  env.ctx.core.getMode = vi.fn(() => mode) as never;
  env.ctx.core.escAware = (async (fn: (ac: AbortController) => Promise<unknown>) =>
    fn(new AbortController())) as never;
  const briefCall = createMockAugmentedToolCall('brief', { message: 'recon done', confidence: 7 });
  env.hookExecutor.processToolCalls = vi.fn(async () =>
    createMockHookResult({ calls: [briefCall] }),
  ) as never;
  const chat = createChatData({ rawToolCalls: [briefCall], assistantContent: 'briefing' });
  return { env, triologue, briefCall, chat };
}

describe('HOOK-stage plan-mode scope reflection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forkChat.mockResolvedValue(REFLECTION);
    vi.mocked(agentIO.isNeglectedMode).mockReturnValue(false);
  });

  it('NORMAL mode: no fork, and the brief is left for the TOOL stage', async () => {
    const { env, triologue, chat } = makeEnv('normal');
    const result = await handleHook(env, createTurnVars(), chat);
    expect(result).toBe(AgentState.TOOL);
    expect(forkChat).not.toHaveBeenCalled();
    // The normal turn registration happens later (step 6) — nothing is answered
    // here, and no brief RESULT was written by us.
    expect(triologue.getMessages().some((m) => m.role === 'tool')).toBe(false);
  });

  it('PLAN mode: registers the brief round-trip with the reflection and returns COLLECT', async () => {
    const { env, triologue, briefCall, chat } = makeEnv('plan');
    const result = await handleHook(env, createTurnVars(), chat);

    expect(result).toBe(AgentState.COLLECT);
    expect(forkChat).toHaveBeenCalledTimes(1);
    const msgs = triologue.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[1].role).toBe('tool');
    expect(msgs[1].tool_call_id).toBe(briefCall.id);
    // LINE 1 is the anchor line the TOOL stage would have stamped; the
    // reflection is the section under it. Plan-mode briefs are lead briefs, so
    // they are addressable like any other — this path never reaches handleTool,
    // which is why the HOOK stage stamps it itself.
    const [line1, ...body] = (msgs[1].content as string).split('\n');
    expect(line1).toMatch(/^\[[A-Za-z0-9_-]+\] ANCHOR — recap\(target="[A-Za-z0-9_-]*"\) folds the work after this point$/);
    expect(body.join('\n')).toContain(PLAN_SCOPE_HEADING);
    expect(msgs[1].content).toContain('parser.ts');
  });

  it('PLAN mode: the brief BODY still reaches the user, as its own [brief] line', async () => {
    const { env, chat } = makeEnv('plan');
    await handleHook(env, createTurnVars(), chat);

    // The `brief` tool never runs on this path, so the hook must print the
    // user's text itself — otherwise the agent's status update is invisible
    // exactly while it is planning. Same label and detail shape as brief.ts.
    const brief = vi.mocked(env.ctx.core.brief);
    const call = brief.mock.calls.find((c) => c[1] === 'brief');
    expect(call).toBeDefined();
    expect(call![2]).toBe('recon done');
    expect(call![3]).toBe('confidence: 70%');
  });

  it('PLAN mode: the reflection is a SEPARATE plan-scope block, not a note on the brief', async () => {
    const { env, chat } = makeEnv('plan');
    await handleHook(env, createTurnVars(), chat);

    const brief = vi.mocked(env.ctx.core.brief);
    const scope = brief.mock.calls.find((c) => c[1] === 'plan-scope');
    expect(scope).toBeDefined();
    // The block carries the reflection text itself — never the old fixed
    // placeholder line, which told the user nothing.
    expect(scope![2]).toContain('parser.ts');
    expect(scope![2]).not.toBe('Plan-mode scope reflection attached to this brief.');
    expect(scope![2]).not.toContain(`OK. ${PLAN_SCOPE_HEADING}`);
    expect(scope![2]).not.toContain('ANCHOR');
  });

  it('PLAN mode: the fork sees a LEGAL prefix (no unanswered tool_calls)', async () => {
    const { env, triologue, chat } = makeEnv('plan');
    triologue.user('earlier work');
    await handleHook(env, createTurnVars(), chat);

    const passed = (vi.mocked(forkChat).mock.calls[0] as unknown[])[0] as Array<{ role: string; tool_calls?: unknown }>;
    const last = passed.at(-1)!;
    // The turn's own assistant(tool_calls) must NOT be in the prefix yet.
    expect(last.role).toBe('user');
    expect(passed.some((m) => m.tool_calls && m.role === 'assistant')).toBe(false);
  });

  it('PLAN mode: the reflected brief is still a recap anchor, and a recap replaces the reflection', async () => {
    const { env, triologue, chat } = makeEnv('plan');
    await handleHook(env, createTurnVars(), chat);

    // Work after the brief → the brief anchors.
    triologue.user('next step of the work');
    const anchor = triologue.getLastBrief()!;
    expect(anchor.message).toBe('recon done');
    expect(anchor.span.map((m) => m.content)).toEqual(['next step of the work']);

    const rewound = triologue.rewindToLastBrief('SUMMARY BODY');
    expect(rewound).not.toBeNull();
    const noteSlot = triologue.getMessages().at(-1)!;
    expect(noteSlot.tool_name).toBe('brief');
    expect(noteSlot.content).toContain('SUMMARY BODY');
    expect(noteSlot.content).not.toContain(PLAN_SCOPE_HEADING);
  });

  it('PLAN mode: an empty fork falls through to the normal turn', async () => {
    forkChat.mockResolvedValue('   ');
    const { env, triologue, chat } = makeEnv('plan');
    expect(await handleHook(env, createTurnVars(), chat)).toBe(AgentState.TOOL);
    expect(triologue.getMessages().some((m) => m.role === 'tool')).toBe(false);
  });

  it('PLAN mode: a failing fork falls through — a reflection never fails a brief', async () => {
    forkChat.mockRejectedValue(new Error('provider down'));
    const { env, triologue, chat } = makeEnv('plan');
    expect(await handleHook(env, createTurnVars(), chat)).toBe(AgentState.TOOL);
    expect(triologue.getMessages().some((m) => m.role === 'tool')).toBe(false);
  });

  it('PLAN mode: ESC does not spend a fork', async () => {
    vi.mocked(agentIO.isNeglectedMode).mockReturnValue(true);
    const { env, chat } = makeEnv('plan');
    await handleHook(env, createTurnVars(), chat);
    expect(forkChat).not.toHaveBeenCalled();
  });
});
