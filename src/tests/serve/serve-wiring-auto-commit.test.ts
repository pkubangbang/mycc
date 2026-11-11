/**
 * serve-wiring-auto-commit.test.ts - the PRODUCTION registration, not a self-wired
 * callback.
 *
 * THE DEFECT THIS FILE EXISTS FOR (round 3, finding 1):
 *   `auto-commit-change-mirror.test.ts` assigns
 *   `autoState.onAutoCommitBranchesChange` ITSELF, so it proves the callback is
 *   invoked — but not that `wireServeCallbacks()` ever registers one. Deleting
 *   the registration in serve-wiring.ts would have left every test green while
 *   the WebUI stopped receiving terminal edits.
 *
 * This file installs a stub hub through the real registry seam
 * (`registerServeHubFactory`), runs the REAL `wireServeCallbacks()`, and then
 * asserts the terminal slash path reaches `broadcastAutoCommit`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';

vi.mock('../../slashes/index.js', () => ({
  slashRegistry: { register: vi.fn(), get: vi.fn(), list: vi.fn(() => []) }
}));

import { autoState, formatAutoCommitEntry } from '../../loop/auto-state.js';
import { wireServeCallbacks } from '../../loop/serve-wiring.js';
import { registerServeHubFactory } from '../../serve/serve-registry.js';
import { autoCommitCommand } from '../../slashes/auto-commit.js';

type Hub = ReturnType<typeof makeStubHub>;

function makeStubHub() {
  return {
    broadcastAutoCommit: vi.fn(),
    setAutoCommitBranchesProvider: vi.fn(),
    setAutoStateProvider: vi.fn(),
    setModeStateProvider: vi.fn(),
    setEnterAutoProvider: vi.fn(),
    broadcast: vi.fn(),
    broadcastExcept: vi.fn(),
    rejectInput: vi.fn(),
    getAutoState: vi.fn(() => false),
    getDisplayWriter: vi.fn(() => undefined),
    enterAuto: vi.fn(() => true)
  };
}

/** The slash handler mutates through ctx.core; delegate to the real AutoState.
 *  `setModeChangeReporter` is the one Core method wireServeCallbacks() calls. */
function makeContext() {
  return {
    ctx: {
      peer: { setOnChannelJoin: vi.fn() },
      core: {
        setModeChangeReporter: vi.fn(),
        getMode: () => 'normal',
        getWorkDir: () => process.cwd(),
        addAutoCommitBranches: (b: string[], a: boolean) => autoState.addAutoCommitBranches(b, a),
        removeAutoCommitBranches: (b: string[]) => autoState.removeAutoCommitBranches(b),
        clearAutoCommitBranches: () => autoState.clearAutoCommitBranches(),
        getAutoCommitBranches: () => autoState.getAutoCommitBranches()
      }
    },
    args: [] as string[],
    query: '',
    triologue: null as never,
    sessionFilePath: ''
  };
}

/**
 * Invoke the REAL slash handler. The context is a hand-built stub, so it is
 * asserted to SlashCommandContext once here instead of at every call site.
 */
async function run(args: string[]): Promise<void> {
  await autoCommitCommand.handler({ ...makeContext(), args } as never);
}

describe('wireServeCallbacks -> auto-commit mirror (production registration)', () => {
  let hub: Hub;

  beforeEach(() => {
    hub = makeStubHub();
    autoState.onAutoCommitBranchesChange = null;
    autoState.clearAutoCommitBranches();
    // Install the stub through the REAL seam: this is what the serve layer does.
    registerServeHubFactory(() => hub as never);
    wireServeCallbacks(makeContext().ctx as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    autoState.onAutoCommitBranchesChange = null;
    autoState.clearAutoCommitBranches();
    vi.restoreAllMocks();
  });

  it('REGRESSION GUARD: wireServeCallbacks installs the change callback at all', () => {
    // If this line disappears from serve-wiring.ts, nothing reaches a browser.
    expect(autoState.onAutoCommitBranchesChange).not.toBeNull();
  });

  it('a terminal `/auto-commit on <branch>` broadcasts to every client', async () => {
    await run(['/auto-commit', 'on', 'feat-x']);

    expect(hub.broadcastAutoCommit).toHaveBeenCalledTimes(1);
    expect(hub.broadcastAutoCommit).toHaveBeenCalledWith([formatAutoCommitEntry('feat-x', false)]);
  });

  it('a terminal `/auto-commit off --all` broadcasts the empty list', async () => {
    autoState.addAutoCommitBranches(['a'], false);
    hub.broadcastAutoCommit.mockClear();

    await run(['/auto-commit', 'off', '--all']);

    expect(hub.broadcastAutoCommit).toHaveBeenCalledTimes(1);
    expect(hub.broadcastAutoCommit).toHaveBeenCalledWith([]);
  });

  it('EXACTLY ONE broadcast per write (the handler never adds its own)', async () => {
    await run(['/auto-commit', 'on', 'one']);
    await run(['/auto-commit', 'on', 'two']);

    // Two writes, two frames — not four.
    expect(hub.broadcastAutoCommit).toHaveBeenCalledTimes(2);
  });

  it('installs the READ provider so the WS editor can reach AutoState', () => {
    expect(hub.setAutoCommitBranchesProvider).toHaveBeenCalledTimes(1);
    const provider = hub.setAutoCommitBranchesProvider.mock.calls[0][0] as {
      get: () => string[] | null;
    };
    // The provider is wired to the SAME singleton the terminal writes to, and
    // there is deliberately no write half: the list is edited only through the
    // `/auto-commit` slash command, so one writer and one broadcast.
    autoState.addAutoCommitBranches(['main'], false);
    expect(provider.get()).toEqual([formatAutoCommitEntry('main', false)]);
    expect('replace' in provider).toBe(false);
  });
});
