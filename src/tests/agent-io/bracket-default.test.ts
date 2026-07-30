/**
 * bracket-default.test.ts - Verify ask() honors the [?/?] bracket default
 * on Enter (empty input) in the terminal path.
 *
 * Regression coverage for the centralized Enter-as-default fix in agent-io.ts:
 * previously only serve mode parsed the trailing bracket to determine the
 * default, while the terminal onDone path returned a bare '' on Enter unless
 * the caller passed an explicit onEnter. This forced every [y/N] caller to
 * patch its own "empty means default" check — the bug that caused git_commit's
 * "User responded: """ when the user pressed Enter meaning No.
 *
 * The fix adds parseBracketDefault() and uses it in the terminal onDone path:
 * on empty input, resolve to (1) explicit onEnter if set, else (2) the
 * bracket's uppercase-default token, else (3) ''. This keeps terminal and
 * serve behavior in sync.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture the onDone callback so tests can simulate user input.
let capturedOnDone: ((value: string) => void) | null = null;

vi.mock('../../utils/line-editor.js', () => {
  return {
    LineEditor: vi.fn().mockImplementation(function (this: unknown, opts: { onDone: (value: string) => void }) {
      capturedOnDone = opts.onDone;
      return {
        handleKey: vi.fn(),
        resize: vi.fn(),
        getHistory: vi.fn().mockReturnValue([]),
        close: vi.fn(),
        setContent: vi.fn(),
        setWhisper: vi.fn(),
        clearScreen: vi.fn(),
        insertAtCursor: vi.fn(),
      };
    }),
  };
});

vi.mock('../../loop/esc-wrap-up.js', () => ({
  getWrapUpState: vi.fn(() => ({ promise: null })),
  tryDisplayWrapUp: vi.fn(() => false),
  startWrapUp: vi.fn(),
  clearWrapUp: vi.fn(),
}));

import { agentIO } from '../../loop/agent-io.js';

const io = agentIO as unknown as {
  isMainProcessFlag: boolean;
  askResolver: ((value: string) => void) | null;
  askOnEsc: string | null;
  askOnEnter: string | null;
  activeLineEditor: unknown;
  askQueue: Array<() => void>;
  neglectedModeFlag: boolean;
  outputBuffer: Array<{ method: string; args: unknown[] }>;
};

describe('ask() [?/?] bracket default on Enter (terminal path)', () => {
  beforeEach(() => {
    io.isMainProcessFlag = true;
    io.askResolver = null;
    io.askOnEsc = null;
    io.askOnEnter = null;
    io.activeLineEditor = null;
    io.askQueue = [];
    io.neglectedModeFlag = false;
    io.outputBuffer = [];
    capturedOnDone = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should resolve Enter-on-empty to "n" for [y/N] (default No)', async () => {
    const ask = agentIO.ask('Commit with message: "x"? [y/N]');
    const onDone = capturedOnDone!;
    onDone(''); // user presses Enter on empty input
    expect(await ask).toBe('n');
  });

  it('should resolve Enter-on-empty to "y" for [Y/n] (default Yes)', async () => {
    const ask = agentIO.ask('Retry? [Y/n]');
    capturedOnDone!('');
    expect(await ask).toBe('y');
  });

  it('should NOT auto-default numeric brackets like [1/2/3/4] (no uppercase marker)', async () => {
    // The bracket convention marks the default via an UPPERCASE letter token
    // (e.g. [y/N] -> N). Numeric tokens have no uppercase form, so [1/2/3/4]
    // has no auto-detectable default — Enter yields ''. Callers that want a
    // numeric default must pass an explicit onEnter. This matches the
    // serve-mode card logic, which uses the same tok !== tok.toLowerCase()
    // uppercase check.
    const ask = agentIO.ask('Choose: [1/2/3/4]');
    capturedOnDone!('');
    expect(await ask).toBe('');
  });

  it('should resolve Enter-on-empty to the bracket default when a letter is uppercase', async () => {
    // [1/2/3/N] -> N is the uppercase-marked default
    const ask = agentIO.ask('Pick [1/2/3/N]');
    capturedOnDone!('');
    expect(await ask).toBe('n');
  });

  it('should still pass through a typed answer (non-empty input wins)', async () => {
    const ask = agentIO.ask('Commit with message: "x"? [y/N]');
    capturedOnDone!('y'); // user types "y"
    expect(await ask).toBe('y');
  });

  it('should let an explicit onEnter option override the bracket default', async () => {
    // Caller passes onEnter='continue' — even with a [y/N] suffix, onEnter wins.
    const ask = agentIO.ask('Press Enter to continue [y/N]', { onEnter: 'continue' });
    capturedOnDone!('');
    expect(await ask).toBe('continue');
  });

  it('should return bare "" on Enter when there is no bracket and no onEnter', async () => {
    const ask = agentIO.ask('What is your name?');
    capturedOnDone!('');
    expect(await ask).toBe('');
  });

  it('should strip a trailing "> " CLI marker before matching the bracket', async () => {
    // hand_over-style: "Save tmux session? [y/N] > "
    const ask = agentIO.ask('Save tmux session? [y/N] > ');
    capturedOnDone!('');
    expect(await ask).toBe('n');
  });

  it('should return "" on Enter for a bracket with no uppercase default token', async () => {
    // [y/n] has no uppercase token — no default defined
    const ask = agentIO.ask('Pick [y/n]');
    capturedOnDone!('');
    expect(await ask).toBe('');
  });
});