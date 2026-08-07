/**
 * prompt-autofly.test.ts — handlePrompt auto-mode engagement gate.
 *
 * Code path under test (prompt.ts, top of handlePrompt):
 *   if (autoState.getAuto()) {                  // case 1: already on
 *     autoState.setAuto(true);                  // idempotent re-sync
 *     return AgentState.WAIT;
 *   }
 *   if (isDebugAutofly() && autoState.getStreak() > autoState.getAutoflyThreshold()) {
 *     autoState.setAuto(true);                  // engage so subsequent loops take case 1
 *     return AgentState.WAIT;
 *   }
 *
 * PROMPT is the single decision point for the WAIT redirect. STOP always
 * routes here; the initial state is always PROMPT. The threshold lives in
 * the AutoState singleton (agent-repl seeds it from --autofly=N at startup),
 * so PROMPT reads a single source of truth. These tests verify the two
 * engagement conditions and their negatives, isolating the top guard from
 * the rest of the prompt handler (input/slash/steering logic).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

// config.js: controllable isDebugAutofly / isDebuggingPrompt.
vi.mock('../../../config.js', () => ({
  isDebuggingPrompt: vi.fn(() => false),
  isDebugAutofly: vi.fn(() => false),
}));

// auto-state.js: controllable auto/streak/threshold. Tracks setAuto calls.
vi.mock('../../../loop/auto-state.js', () => {
  let auto = false;
  let streak = 0;
  let threshold = 3;
  return {
    autoState: {
      getAuto: vi.fn(() => auto),
      setAuto: vi.fn((v: boolean) => { auto = v; }),
      getStreak: vi.fn(() => streak),
      setStreak: vi.fn((n: number) => { streak = n; }),
      resetStreak: vi.fn(() => { streak = 0; }),
      getAutoflyThreshold: vi.fn(() => threshold),
      setAutoflyThreshold: vi.fn((n: number) => { threshold = n; }),
    },
  };
});

// agent-io.js: minimal stub.
vi.mock('../../../loop/agent-io.js', () => ({
  agentIO: {
    verbose: vi.fn(),
  },
}));

// state-machine.js: AgentState enum + presentResult stub.
vi.mock('../../../loop/state-machine.js', () => ({
  AgentState: {
    PROMPT: 'prompt',
    SLASH: 'slash',
    COLLECT: 'collect',
    LLM: 'llm',
    HOOK: 'hook',
    TOOL: 'tool',
    STOP: 'stop',
    WAIT: 'wait',
  },
  presentResult: vi.fn(),
}));

// serve-registry.js: hub stub — isRunning false so steering/file paths are skipped.
vi.mock('../../../serve/serve-registry.js', () => ({
  getServeHub: vi.fn(() => ({
    isRunning: vi.fn(() => false),
    getSteeringNotes: vi.fn(() => []),
    drainSteering: vi.fn(),
    drainFileUploads: vi.fn(() => []),
    appendUserLog: vi.fn(),
  })),
}));

// context/shared/loader.js: stub execute/getToolsForScope (not reached by the guard).
vi.mock('../../../context/shared/loader.js', () => ({
  loader: {
    execute: vi.fn(),
    getToolsForScope: vi.fn(() => []),
  },
}));

// session/index.js: stub readSession/writeSession.
vi.mock('../../../session/index.js', () => ({
  readSession: vi.fn(() => null),
  writeSession: vi.fn(),
}));

// states/slash.js: stub setSlashQuery.
vi.mock('../../../loop/states/slash.js', () => ({
  setSlashQuery: vi.fn(),
}));

// esc-wrap-up.js: stub evaluateWrapUp/clearWrapUp.
vi.mock('../../../loop/esc-wrap-up.js', () => ({
  evaluateWrapUp: vi.fn(),
  clearWrapUp: vi.fn(),
}));

// keyword-extractor.js: stub extractKeywords (async, returns []).
vi.mock('../../../loop/keyword-extractor.js', () => ({
  extractKeywords: vi.fn(async () => []),
}));

// engine/chat-provider.js: stub forkChat (not reached by the guard).
vi.mock('../../../engine/chat-provider.js', () => ({
  forkChat: vi.fn(),
  MODEL: 'test-model',
}));

// utils/multiline-input.js: stub openMultilineEditor (not reached by the guard).
vi.mock('../../../utils/multiline-input.js', () => ({
  openMultilineEditor: vi.fn(),
}));

// --- Import after mocks ------------------------------------------------------
import { handlePrompt, setInitialQuery } from '../../../loop/states/prompt.js';
import { AgentState } from '../../../loop/state-machine.js';
import { autoState } from '../../../loop/auto-state.js';
import { isDebugAutofly, isDebuggingPrompt } from '../../../config.js';
import { createTurnVars, createPassData, createMockMachineEnv } from '../esc-test-helpers.js';
import { Triologue } from '../../../loop/triologue.js';

// Helper: build a minimal env with a stub triologue that reports no wrap-up.
function makeEnv(): { env: ReturnType<typeof createMockMachineEnv>; triologue: Triologue } {
  const triologue = new Triologue();
  const env = createMockMachineEnv({ triologue });
  // Guard-only tests: input provider returns a sentinel so a fall-through
  // (neither engagement condition met) still resolves without hanging.
  env.inputProvider = {
    getInput: vi.fn(async () => 'sentinel-fallthrough-query'),
    setMode: vi.fn(),
    promptRetry: vi.fn(async () => false),
  } as never;
  return { env, triologue };
}

function resetState() {
  vi.mocked(autoState.getAuto).mockReturnValue(false);
  vi.mocked(autoState.getStreak).mockReturnValue(0);
  vi.mocked(autoState.getAutoflyThreshold).mockReturnValue(3);
  vi.mocked(isDebugAutofly).mockReturnValue(false);
  vi.mocked(isDebuggingPrompt).mockReturnValue(false);
  // Clear the internal auto flag by setting via the mock
  autoState.setAuto(false);
  vi.mocked(autoState.setAuto).mockClear();
}

describe('handlePrompt — auto-mode engagement gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setInitialQuery(null);
    resetState();
  });

  describe('case 1: auto mode already on', () => {
    it('returns WAIT without prompting the user', async () => {
      const { env } = makeEnv();
      vi.mocked(autoState.getAuto).mockReturnValue(true);

      const result = await handlePrompt(env, createTurnVars(), createPassData());

      expect(result).toBe(AgentState.WAIT);
      // setAuto(true) is the idempotent re-sync (no-op, keeps onAutoChange calm)
      expect(autoState.setAuto).toHaveBeenCalledWith(true);
    });

    it('does not consult the autofly trigger when auto is already on', async () => {
      const { env } = makeEnv();
      vi.mocked(autoState.getAuto).mockReturnValue(true);
      // Even with a huge streak and the flag on, case 1 short-circuits first.
      vi.mocked(autoState.getStreak).mockReturnValue(99);
      vi.mocked(isDebugAutofly).mockReturnValue(true);

      const result = await handlePrompt(env, createTurnVars(), createPassData());

      expect(result).toBe(AgentState.WAIT);
      // Case 1 short-circuits before the streak/threshold are consulted.
      expect(autoState.getStreak).not.toHaveBeenCalled();
      expect(autoState.getAutoflyThreshold).not.toHaveBeenCalled();
    });
  });

  describe('case 2: --debug-autofly autofly trigger', () => {
    it('engages auto mode and returns WAIT when streak > default threshold', async () => {
      const { env } = makeEnv();
      vi.mocked(isDebugAutofly).mockReturnValue(true);
      vi.mocked(autoState.getAutoflyThreshold).mockReturnValue(3); // singleton default
      vi.mocked(autoState.getStreak).mockReturnValue(4); // 4 > 3

      const result = await handlePrompt(env, createTurnVars(), createPassData());

      expect(result).toBe(AgentState.WAIT);
      expect(autoState.setAuto).toHaveBeenCalledWith(true); // engage so subsequent loops take case 1
    });

    it('engages auto mode and returns WAIT when streak > a custom singleton threshold', async () => {
      const { env } = makeEnv();
      vi.mocked(isDebugAutofly).mockReturnValue(true);
      vi.mocked(autoState.getAutoflyThreshold).mockReturnValue(5); // seeded from --autofly=5
      vi.mocked(autoState.getStreak).mockReturnValue(6); // 6 > 5

      const result = await handlePrompt(env, createTurnVars(), createPassData());

      expect(result).toBe(AgentState.WAIT);
      expect(autoState.setAuto).toHaveBeenCalledWith(true);
    });

    it('does NOT engage when streak equals the threshold (strict > comparison)', async () => {
      const { env } = makeEnv();
      vi.mocked(isDebugAutofly).mockReturnValue(true);
      vi.mocked(autoState.getAutoflyThreshold).mockReturnValue(3);
      vi.mocked(autoState.getStreak).mockReturnValue(3); // 3 > 3 is false

      const result = await handlePrompt(env, createTurnVars(), createPassData());

      // Falls through to normal prompting (returns COLLECT after user input)
      expect(result).toBe(AgentState.COLLECT);
      expect(autoState.setAuto).not.toHaveBeenCalledWith(true);
    });

    it('does NOT engage when streak is below the threshold', async () => {
      const { env } = makeEnv();
      vi.mocked(isDebugAutofly).mockReturnValue(true);
      vi.mocked(autoState.getAutoflyThreshold).mockReturnValue(3);
      vi.mocked(autoState.getStreak).mockReturnValue(2); // 2 > 3 is false

      const result = await handlePrompt(env, createTurnVars(), createPassData());

      expect(result).toBe(AgentState.COLLECT);
      expect(autoState.setAuto).not.toHaveBeenCalledWith(true);
    });
  });

  describe('flag off: autofly never engages regardless of streak', () => {
    it('falls through to normal prompting with a high streak and flag off', async () => {
      const { env } = makeEnv();
      vi.mocked(isDebugAutofly).mockReturnValue(false);
      vi.mocked(autoState.getStreak).mockReturnValue(100); // huge streak, but flag is off

      const result = await handlePrompt(env, createTurnVars(), createPassData());

      expect(result).toBe(AgentState.COLLECT);
      expect(autoState.setAuto).not.toHaveBeenCalledWith(true);
      // Flag is off → the threshold is never consulted.
      expect(autoState.getAutoflyThreshold).not.toHaveBeenCalled();
    });
  });
});