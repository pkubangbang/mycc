/**
 * auto-commit-slash.test.ts - Tests for the /auto-commit SLASH command.
 *
 * The command edits the LIVE allow-list that `git_commit` reads when deciding
 * whether to skip the interactive confirmation. That list lives on the agent
 * context (`ctx.core`, next to `workDir`) — config.ts is parse-only now — so
 * these tests drive the REAL command against the behavioural mock core from
 * test-utils, which keeps its own array exactly like BaseCore does. That way
 * the assertion is end-to-end: run the slash, then read what `git_commit`
 * would read.
 *
 * Covered cases:
 *   - bare `/auto-commit` shows the current list, and OFF when empty;
 *   - `on <branch>` adds, and is idempotent for a duplicate;
 *   - `off <branch>` removes, and reports a no-op for an absent branch;
 *   - `off --all` clears everything;
 *   - missing branch / unknown subcommand produce usage output, never a
 *     silent success;
 *   - every operand path still reprints the resulting list so the user sees
 *     the new state.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMockContext } from '../test-utils/mock-context.js';
import type { AgentContext, SlashCommandContext } from '../../types.js';

import { autoCommitCommand } from '../../slashes/auto-commit.js';

/** Drive the command with `/auto-commit <operands>`, capturing stdout. */
function run(operands: string[], ctx: AgentContext): string {
  const lines: string[] = [];
  const args = ['/auto-commit', ...operands];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.map((x) => String(x)).join(' '));
  });
  try {
    const slashCtx = {
      query: args.join(' '),
      args,
      ctx,
      triologue: undefined,
      sessionFilePath: '',
    } as unknown as SlashCommandContext;
    autoCommitCommand.handler(slashCtx);
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

/** Seed the context's live list (stands in for the `--allow-auto-commit` flag). */
function seed(ctx: AgentContext, branches: string[]): void {
  for (const b of branches) ctx.core.addAllowAutoCommitBranch(b);
  vi.clearAllMocks();
}

/** What `git_commit` would see right now. */
function current(ctx: AgentContext): string[] {
  return ctx.core.getAllowAutoCommitBranches();
}

describe('/auto-commit slash command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is registered under the expected name', () => {
    expect(autoCommitCommand.name).toBe('auto-commit');
  });

  it('bare invocation reports the list is empty (feature OFF)', () => {
    const out = run([], createMockContext());
    expect(out).toContain('empty');
    expect(out).toContain('OFF');
  });

  it('bare invocation lists the current branches with their count', () => {
    const ctx = createMockContext();
    seed(ctx, ['main', 'release/1.2']);
    const out = run([], ctx);
    expect(out).toContain('2 branches');
    expect(out).toContain('- main');
    expect(out).toContain('- release/1.2');
  });

  it('on <branch> adds the branch to ctx.core and reprints the list', () => {
    const ctx = createMockContext();
    const out = run(['on', 'main'], ctx);
    expect(current(ctx)).toEqual(['main']);
    expect(out).toContain("Added 'main'");
    expect(out).toContain('- main');
  });

  it('on <branch> is idempotent for a duplicate', () => {
    const ctx = createMockContext();
    seed(ctx, ['main']);
    const out = run(['on', 'main'], ctx);
    expect(current(ctx)).toEqual(['main']);
    expect(out).toContain('already');
  });

  it('on without a branch prints usage instead of changing anything', () => {
    const ctx = createMockContext();
    const out = run(['on'], ctx);
    expect(current(ctx)).toEqual([]);
    expect(out).toContain('Missing branch');
    expect(out).toContain('Usage');
  });

  it('off <branch> removes only that branch', () => {
    const ctx = createMockContext();
    seed(ctx, ['main', 'dev']);
    const out = run(['off', 'main'], ctx);
    expect(current(ctx)).toEqual(['dev']);
    expect(out).toContain("Removed 'main'");
    expect(out).not.toContain('- main');
  });

  it('off <branch> reports a no-op for an absent branch', () => {
    const ctx = createMockContext();
    seed(ctx, ['main']);
    const out = run(['off', 'feature/x'], ctx);
    expect(current(ctx)).toEqual(['main']);
    expect(out).toContain('was not in the auto-commit allow-list');
  });

  it('off --all clears every branch', () => {
    const ctx = createMockContext();
    seed(ctx, ['main', 'dev', 'release/1.2']);
    const out = run(['off', '--all'], ctx);
    expect(current(ctx)).toEqual([]);
    expect(out).toContain('Cleared');
    expect(out).toContain('main, dev, release/1.2');
    expect(out).toContain('OFF');
  });

  it('off --all on an already empty list says so', () => {
    const out = run(['off', '--all'], createMockContext());
    expect(out).toContain('already empty');
  });

  it('off without a branch prints usage', () => {
    const ctx = createMockContext();
    seed(ctx, ['main']);
    const out = run(['off'], ctx);
    expect(current(ctx)).toEqual(['main']);
    expect(out).toContain('Missing branch');
  });

  it('an unknown subcommand prints usage and leaves the list untouched', () => {
    const ctx = createMockContext();
    seed(ctx, ['main']);
    const out = run(['toggle', 'dev'], ctx);
    expect(current(ctx)).toEqual(['main']);
    expect(out).toContain('Unknown /auto-commit subcommand');
    expect(out).toContain('Usage');
  });

  it('the subcommand is case-insensitive', () => {
    const ctx = createMockContext();
    run(['ON', 'main'], ctx);
    expect(current(ctx)).toEqual(['main']);
    run(['OFF', 'main'], ctx);
    expect(current(ctx)).toEqual([]);
  });

  it('the list read by git_commit reflects the slash edit immediately', () => {
    const ctx = createMockContext();
    expect(current(ctx)).toEqual([]);
    run(['on', 'main'], ctx);
    // No restart, no re-read of config: the context's array IS the store.
    expect(current(ctx)).toEqual(['main']);
    run(['off', '--all'], ctx);
    expect(current(ctx)).toEqual([]);
  });
});
