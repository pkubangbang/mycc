/**
 * prompt-upload-rollback.test.ts — regression test for the uploaded-file
 * reminder being discarded by a wrap-up rollback.
 *
 * Failure scene: the user attaches an image in the WebUI, then submits a query.
 * During the interrupted run the file upload was drained and saved as a
 * [REMINDER] note. Because triologue.note() merges a note into the last 'user'
 * message (which, after ESC, is the [WRAP_UP] message), the reminder got
 * COMBINED into the [WRAP_UP] message. Then prompt.ts called rollbackWrapUp()
 * AFTER the file drain, so the rollback truncated the combined message and the
 * model never saw the uploaded-file path — it replied "I don't see an image".
 *
 * Fix: resolve the wrap-up (commit/rollback) BEFORE draining files/steering, so
 * a [REMINDER] injected afterwards lands past the rollback point and survives.
 *
 * This test drives handlePrompt() with a live Triologue that has an active
 * wrap-up, a serve hub that reports running and returns one uploaded image,
 * and a mocked evaluateWrapUp() returning 'rollback'. It asserts the uploaded
 * file reminder is still present in the final triologue messages.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

// config.js: controllable isDebuggingPrompt / isDebugAutofly.
vi.mock('../../../config.js', () => ({
  isDebuggingPrompt: vi.fn(() => false),
  isDebugAutofly: vi.fn(() => false),
}));

// auto-state.js: controllable auto/streak/threshold.
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

// agent-io.js: minimal stub + PromptAbortError.
vi.mock('../../../loop/agent-io.js', () => {
  class PromptAbortError extends Error {
    constructor(message = 'PROMPT wait aborted by an external event') {
      super(message);
      this.name = 'PromptAbortError';
    }
  }
  return {
    agentIO: {
      verbose: vi.fn(),
    },
    PromptAbortError,
  };
});

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

// serve-registry.js: a controllable hub that reports running and returns one
// uploaded image from drainFileUploads().
const { drainFileUploads } = vi.hoisted(() => ({ drainFileUploads: vi.fn() }));
vi.mock('../../../serve/serve-registry.js', () => ({
  getServeHub: vi.fn(() => ({
    isRunning: vi.fn(() => true),
    getSteeringNotes: vi.fn(() => []),
    drainSteering: vi.fn(),
    drainFileUploads,
    appendUserLog: vi.fn(),
  })),
}));

// context/shared/loader.js: stub execute/getToolsForScope.
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

// esc-wrap-up.js: controllable evaluateWrapUp / clearWrapUp. The real rollback
// behavior lives in Triologue, so only these two are stubbed.
const { evaluateWrapUp } = vi.hoisted(() => ({ evaluateWrapUp: vi.fn() }));
vi.mock('../../../loop/esc-wrap-up.js', () => ({
  evaluateWrapUp,
  clearWrapUp: vi.fn(),
}));

// keyword-extractor.js: stub extractKeywords (async, returns []).
vi.mock('../../../loop/keyword-extractor.js', () => ({
  extractKeywords: vi.fn(async () => []),
}));

// engine/chat-provider.js: stub forkChat / MODEL.
vi.mock('../../../engine/chat-provider.js', () => ({
  forkChat: vi.fn(),
  MODEL: 'test-model',
}));

// utils/multiline-input.js: stub openMultilineEditor.
vi.mock('../../../utils/multiline-input.js', () => ({
  openMultilineEditor: vi.fn(),
}));

// --- Import after mocks ------------------------------------------------------
import { handlePrompt, setInitialQuery } from '../../../loop/states/prompt.js';
import { AgentState } from '../../../loop/state-machine.js';
import { Triologue } from '../../../loop/triologue.js';
import { createTurnVars, createChatData, createMockMachineEnv } from '../esc-test-helpers.js';

const uploadedImage = {
  filename: 'image-1786587692871.png',
  data: 'aGVsbG8=', // base64 for "hello" — content is irrelevant to the assertion
  mimeType: 'image/png',
  text: 'here is the screenshot: ',
};

describe('handlePrompt — uploaded-file reminder survives wrap-up rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setInitialQuery(null);
    drainFileUploads.mockReturnValue([uploadedImage]);
    evaluateWrapUp.mockReturnValue('rollback');
  });

  it('keeps the uploaded-file reminder in the triologue after rollback', async () => {
    const triologue = new Triologue();

    // Simulate the interrupted run: an ESC happened during a tool call, so the
    // wrap-up was begun (adds the [WRAP_UP] user message).
    triologue.beginWrapUp();

    const env = createMockMachineEnv({ triologue });
    env.inputProvider = {
      getInput: vi.fn(async () => 'here is the screenshot: '),
      setMode: vi.fn(),
      promptRetry: vi.fn(async () => false),
    } as never;

    const result = await handlePrompt(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.COLLECT);

    // The wrap-up must have been rolled back (its [WRAP_UP] message removed).
    const messages = triologue.getMessages();
    const combinedText = messages.map((m) => m.content ?? '').join('\n');
    expect(combinedText).not.toContain('[WRAP_UP] LLM call interrupted');

    // The uploaded-file reminder must survive the rollback.
    expect(combinedText).toContain('Previously uploaded file(s) (from interrupted run)');
    expect(combinedText).toContain('image-1786587692871.png');
    expect(combinedText).toContain('.mycc' + path.sep + 'uploaded'); // path uses platform sep
  });

  it('still commits (not rollback) the wrap-up when evaluateWrapUp says commit', async () => {
    evaluateWrapUp.mockReturnValue('commit');
    const triologue = new Triologue();
    triologue.beginWrapUp();
    // finishWrapUp simulates the background wrap-up LLM having produced content.
    triologue.finishWrapUp('wrapped up.');

    const env = createMockMachineEnv({ triologue });
    env.inputProvider = {
      getInput: vi.fn(async () => 'here is the screenshot: '),
      setMode: vi.fn(),
      promptRetry: vi.fn(async () => false),
    } as never;

    const result = await handlePrompt(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.COLLECT);

    const combinedText = triologue.getMessages().map((m) => m.content ?? '').join('\n');
    // Commit keeps the wrap-up turn AND the uploaded-file reminder.
    expect(combinedText).toContain('[WRAP_UP] LLM call interrupted');
    expect(combinedText).toContain('wrapped up.');
    expect(combinedText).toContain('Previously uploaded file(s) (from interrupted run)');
  });
});
