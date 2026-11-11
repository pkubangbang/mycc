/**
 * auto-commit-slash-mirror.test.ts - THE HEADLINE SEAM
 *
 * THE DEFECT THIS FILE EXISTS FOR (round 2, finding F2):
 *   "A browser sees a grant typed in the terminal" was the stated reason
 *   `onAutoCommitBranchesChange` exists — and NOTHING tested it. The AutoState
 *   unit tests proved the stored list; the WS tests proved the handler forwards
 *   a submitted list; but no test drove the real slash command and asserted the
 *   change callback fired. Deleting the notify from `addAutoCommitBranches`
 *   would have left every suite green while the WebUI silently went stale.
 *
 * This test runs the REAL `/auto-commit` slash handler against the REAL
 * AutoState singleton and asserts the observer fires — the glue, end to end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';

// `src/slashes/auto-commit.ts` imports the slash registry, which self-registers
// the whole command set on load — one of those modules imports back through
// agent-io and the cycle resolves to an undefined command at init time. The
// registry is irrelevant to this seam, so stub it exactly as the other wiring
// tests stub their heavy neighbours.
vi.mock('../../slashes/index.js', () => ({
  slashRegistry: { register: vi.fn(), get: vi.fn(), list: vi.fn(() => []) }
}));

import { autoState, formatAutoCommitEntry } from '../../loop/auto-state.js';
import { autoCommitCommand } from '../../slashes/auto-commit.js';

/**
 * The slash handler mutates through `ctx.core` (add/remove/clear/get*), and
 * reports through `core.getMode()` + `core.getWorkDir()`. Delegating the
 * mutators to the REAL AutoState keeps this a true end-to-end seam test: the
 * slash runs, AutoState stores, the change callback fires.
 */
function makeContext() {
  return {
    ctx: {
      core: {
        getMode: () => 'normal',
        getWorkDir: () => process.cwd(),
        addAutoCommitBranches: (b: string[], a: boolean) => autoState.addAutoCommitBranches(b, a),
        removeAutoCommitBranches: (b: string[]) => autoState.removeAutoCommitBranches(b),
        clearAutoCommitBranches: () => autoState.clearAutoCommitBranches(),
        getAutoCommitBranches: () => autoState.getAutoCommitBranches()
      }
    },
    args: [] as string[],
    // The remaining SlashCommandContext fields are unused by this command.
    query: '',
    triologue: null as never,
    sessionFilePath: ''
  };
}

const context = makeContext();

/**
 * Invoke the REAL slash handler. The context is a hand-built stub, so it is
 * asserted to SlashCommandContext once here instead of at every call site.
 */
async function run(args: string[]): Promise<void> {
  await autoCommitCommand.handler({ ...context, args } as never);
}

describe('/auto-commit slash -> AutoState -> change callback (the WebUI mirror)', () => {
  let seen: string[][];

  beforeEach(() => {
    seen = [];
    autoState.onAutoCommitBranchesChange = (entries) => seen.push(entries);
    autoState.clearAutoCommitBranches();
    seen.length = 0;
    // The slash reports with console.log; keep the test output clean.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    autoState.onAutoCommitBranchesChange = null;
    autoState.clearAutoCommitBranches();
    vi.restoreAllMocks();
  });

  it('`/auto-commit on <branch>` reaches the observer', async () => {
    await run(['/auto-commit', 'on', 'feat-x']);

    expect(autoState.getAutoCommitBranches()).toEqual([formatAutoCommitEntry('feat-x', false)]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([formatAutoCommitEntry('feat-x', false)]);
  });

  it('`/auto-commit on <branch>:autoAdd` reaches the observer with the flag intact', async () => {
    await run(['/auto-commit', 'on', 'main:autoAdd']);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([formatAutoCommitEntry('main', true)]);
  });

  it('`/auto-commit off <branch>` reaches the observer', async () => {
    autoState.addAutoCommitBranches(['a', 'b'], false);
    seen.length = 0;

    await run(['/auto-commit', 'off', 'a']);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([formatAutoCommitEntry('b', false)]);
  });

  it('`/auto-commit off --all` reaches the observer', async () => {
    autoState.addAutoCommitBranches(['a', 'b'], false);
    seen.length = 0;

    await run(['/auto-commit', 'off', '--all']);

    expect(autoState.getAutoCommitBranches()).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([]);
  });

  it('a REPORT-ONLY `/auto-commit` does not notify (it mutates nothing)', async () => {
    autoState.addAutoCommitBranches(['a'], false);
    seen.length = 0;

    await run(['/auto-commit']);

    expect(seen).toEqual([]);
  });
});
