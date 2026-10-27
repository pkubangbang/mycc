import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the core-owned auto-commit allow-list (AutoState) and the
 * `/auto-commit` slash command built on it.
 *
 * `autoState` is a process-wide singleton, so every test starts by clearing the
 * list — including the launch seed, which is otherwise one-shot per process.
 */

const execMock = vi.fn();
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { exec: (...args: unknown[]) => execMock(...args) },
}));

import {
  autoState,
  parseAutoCommitEntry,
  formatAutoCommitEntry,
  autoCommitSeedFromFlag,
  AUTO_ADD_SUFFIX,
} from '../../loop/auto-state.js';
import { autoCommitCommand } from '../../slashes/auto-commit.js';
import type { SlashCommandContext } from '../../types.js';

/** Reset the singleton to an unseeded, empty list between tests. */
function resetState(): void {
  // clearAutoCommitBranches() empties the list but keeps the seeded flag, so
  // reach for the seed flag through a fresh cast to reset it too.
  autoState.clearAutoCommitBranches();
  (autoState as unknown as { autoCommitSeeded: boolean }).autoCommitSeeded = false;
}

/** Branch names currently authorized under the given mode. */
const effective = (autoMode: boolean) => autoState.effectiveAutoCommitBranches(autoMode);

describe('parseAutoCommitEntry / formatAutoCommitEntry', () => {
  it('decodes a plain entry as autoAdd=false', () => {
    expect(parseAutoCommitEntry('main')).toEqual({ branch: 'main', autoAdd: false });
  });

  it('decodes the autoAdd suffix', () => {
    expect(parseAutoCommitEntry(`main:${AUTO_ADD_SUFFIX}`)).toEqual({ branch: 'main', autoAdd: true });
  });

  it('treats an unknown suffix as part of the branch name', () => {
    expect(parseAutoCommitEntry('x:bogus')).toEqual({ branch: 'x:bogus', autoAdd: false });
  });

  it('tolerates whitespace around both halves', () => {
    expect(parseAutoCommitEntry(` main : ${AUTO_ADD_SUFFIX} `)).toEqual({ branch: 'main', autoAdd: true });
  });

  it('round-trips through formatAutoCommitEntry', () => {
    expect(parseAutoCommitEntry(formatAutoCommitEntry('dev', true))).toEqual({ branch: 'dev', autoAdd: true });
    expect(parseAutoCommitEntry(formatAutoCommitEntry('dev', false))).toEqual({ branch: 'dev', autoAdd: false });
  });
});

describe('autoCommitSeedFromFlag', () => {
  it('returns [] for an absent flag', () => {
    expect(autoCommitSeedFromFlag(undefined)).toEqual([]);
  });

  it('marks every launch-granted branch as autoAdd (the flag predates auto mode gating)', () => {
    expect(autoCommitSeedFromFlag('main, dev')).toEqual([
      `main:${AUTO_ADD_SUFFIX}`,
      `dev:${AUTO_ADD_SUFFIX}`,
    ]);
  });
});

describe('AutoState auto-commit list', () => {
  beforeEach(resetState);

  it('seeds once and ignores a second seed', () => {
    autoState.seedAutoCommitBranches(['main']);
    autoState.seedAutoCommitBranches(['other']);
    expect(autoState.getAutoCommitBranches()).toEqual([`main:${AUTO_ADD_SUFFIX}`]);
    expect(autoState.isAutoCommitSeeded()).toBe(true);
  });

  it('adds branches additively and reports what changed', () => {
    autoState.seedAutoCommitBranches(['main']);
    const added = autoState.addAutoCommitBranches(['feature/x'], false);
    expect(added).toEqual([{ branch: 'feature/x', autoAdd: false }]);
    expect(autoState.getAutoCommitBranches()).toContain('feature/x');
  });

  it('is idempotent: re-adding a branch changes nothing', () => {
    autoState.addAutoCommitBranches(['dev'], false);
    expect(autoState.addAutoCommitBranches(['dev'], false)).toEqual([]);
    expect(autoState.getAutoCommitBranches()).toEqual(['dev']);
  });

  it('upgrades a plain entry to autoAdd but never downgrades it', () => {
    autoState.addAutoCommitBranches(['dev'], false);
    expect(autoState.addAutoCommitBranches(['dev'], true)).toEqual([{ branch: 'dev', autoAdd: true }]);
    expect(autoState.getAutoCommitBranches()).toEqual([`dev:${AUTO_ADD_SUFFIX}`]);
    // A later plain add must not strip the grant.
    autoState.addAutoCommitBranches(['dev'], false);
    expect(autoState.getAutoCommitBranches()).toEqual([`dev:${AUTO_ADD_SUFFIX}`]);
  });

  it('removes by branch name regardless of provenance', () => {
    autoState.seedAutoCommitBranches(['main']);
    autoState.addAutoCommitBranches(['dev'], false);
    expect(autoState.removeAutoCommitBranches(['main'])).toEqual(['main']);
    expect(autoState.getAutoCommitBranches()).toEqual(['dev']);
    expect(autoState.removeAutoCommitBranches(['nope'])).toEqual([]);
  });

  it('off --all clears the launch seed too', () => {
    autoState.seedAutoCommitBranches(['main', 'dev']);
    const cleared = autoState.clearAutoCommitBranches();
    expect(cleared).toHaveLength(2);
    expect(autoState.getAutoCommitBranches()).toEqual([]);
  });

  it('does NOT resurrect the seed after off --all (seed is one-shot)', () => {
    autoState.seedAutoCommitBranches(['main']);
    autoState.clearAutoCommitBranches();
    autoState.seedAutoCommitBranches(['main']);
    expect(autoState.getAutoCommitBranches()).toEqual([]);
  });

  it('/reload semantics: a fresh process re-seeds the ORIGINAL flag, not the edited list', () => {
    // Current process: the flag seeds `main`, then the user edits the live list.
    autoState.seedAutoCommitBranches(['main']);
    autoState.addAutoCommitBranches(['dev'], false);
    autoState.removeAutoCommitBranches(['main']);
    expect(autoState.getAutoCommitBranches()).toEqual(['dev']);

    // /reload respawns the Lead with its ORIGINAL argv, so the seed value is
    // still ['main'] and the mutated list is gone BY CONSTRUCTION: a brand-new
    // process starts unseeded. resetState() reproduces that starting point.
    resetState();
    autoState.seedAutoCommitBranches(['main']);

    expect(autoState.getAutoCommitBranches()).toEqual([`main:${AUTO_ADD_SUFFIX}`]);
  });

  it('GET returns a copy, so callers cannot mutate the singleton', () => {
    autoState.addAutoCommitBranches(['main'], false);
    autoState.getAutoCommitBranches().push('injected');
    expect(autoState.getAutoCommitBranches()).toEqual(['main']);
  });

  describe('effectiveAutoCommitBranches (the commit gate reading)', () => {
    it('a plain entry applies only in auto mode', () => {
      autoState.addAutoCommitBranches(['dev'], false);
      expect(effective(false)).toEqual([]);
      expect(effective(true)).toEqual(['dev']);
    });

    it('an autoAdd entry applies in BOTH modes', () => {
      autoState.addAutoCommitBranches(['main'], true);
      expect(effective(false)).toEqual(['main']);
      expect(effective(true)).toEqual(['main']);
    });

    it('mixes both kinds', () => {
      autoState.seedAutoCommitBranches(['main']);
      autoState.addAutoCommitBranches(['dev'], false);
      expect(effective(false)).toEqual(['main']);
      expect(effective(true)).toEqual(['main', 'dev']);
    });
  });
});

describe('/auto-commit slash command', () => {
  /** Minimal SlashCommandContext for the handler. */
  function makeCtx(): SlashCommandContext {
    const core = {
      getWorkDir: () => process.cwd(),
      getAuto: () => autoState.getAuto(),
      getMode: () => 'normal' as const,
      addAutoCommitBranches: (b: readonly string[], a: boolean) => autoState.addAutoCommitBranches(b, a),
      removeAutoCommitBranches: (b: readonly string[]) => autoState.removeAutoCommitBranches(b),
      clearAutoCommitBranches: () => autoState.clearAutoCommitBranches(),
    };
    return {
      query: '',
      args: ['/auto-commit'],
      ctx: { core } as unknown as SlashCommandContext['ctx'],
      triologue: null,
      sessionFilePath: '',
    };
  }

  const run = async (argv: string[]) => {
    const ctx = makeCtx();
    ctx.args = ['/auto-commit', ...argv];
    await autoCommitCommand.handler(ctx);
  };

  beforeEach(() => {
    resetState();
    execMock.mockReset();
    // Default: detached HEAD so the report path never depends on this repo.
    execMock.mockResolvedValue({ stdout: 'HEAD\n', stderr: '', interrupted: false, exitCode: 0, timedOut: false });
    // Silence the report output during tests.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('is named auto-commit', () => {
    expect(autoCommitCommand.name).toBe('auto-commit');
  });

  it('on <b> adds the branch', async () => {
    await run(['on', 'main']);
    expect(autoState.getAutoCommitBranches()).toEqual(['main']);
  });

  it('on accepts a comma list and the --auto-add flag', async () => {
    await run(['on', '--auto-add', 'main,dev']);
    expect(autoState.getAutoCommitBranches()).toEqual([
      `main:${AUTO_ADD_SUFFIX}`,
      `dev:${AUTO_ADD_SUFFIX}`,
    ]);
  });

  it('on with no branches is a usage error and changes nothing', async () => {
    await run(['on']);
    expect(autoState.getAutoCommitBranches()).toEqual([]);
  });

  it('off <b> removes just that branch', async () => {
    autoState.seedAutoCommitBranches(['main', 'dev']);
    await run(['off', 'main']);
    expect(autoState.getAutoCommitBranches()).toEqual([`dev:${AUTO_ADD_SUFFIX}`]);
  });

  it('off --all clears everything including the seed', async () => {
    autoState.seedAutoCommitBranches(['main', 'dev']);
    await run(['off', '--all']);
    expect(autoState.getAutoCommitBranches()).toEqual([]);
  });

  it('bare /auto-commit only reports (no mutation)', async () => {
    autoState.seedAutoCommitBranches(['main']);
    await run([]);
    expect(autoState.getAutoCommitBranches()).toEqual([`main:${AUTO_ADD_SUFFIX}`]);
  });

  it('an unknown subcommand changes nothing', async () => {
    autoState.seedAutoCommitBranches(['main']);
    await run(['bogus']);
    expect(autoState.getAutoCommitBranches()).toEqual([`main:${AUTO_ADD_SUFFIX}`]);
  });
});
