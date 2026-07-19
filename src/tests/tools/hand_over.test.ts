/**
 * hand_over.test.ts - Cluster A (intent validator) + Cluster B (tmux nesting)
 *
 * Covers the hand_over improvement plan Test Plan sections for Cluster A
 * (Socratic dimension-naming rejection) and Cluster B (P1-1 tmux nesting
 * self-check). Cluster C (dangerous escape + wrappers) lives in bash.test.ts.
 *
 * The hand_over handler composes several external dependencies (tmux,
 * terminal launcher, agentIO.ask, execAsync, spawn, ctx.todo). We mock
 * child_process so hasTmux()/detectTerminalLauncher() report success, and
 * mock agent-io + chat-provider so the handler never reaches the real
 * interactive prompt during the nesting-self-check tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handOverTool } from '../../tools/hand_over.js';
import { agentIO } from '../../loop/agent-io.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';

// Mock agentIO so handler never touches the real terminal.
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    ask: vi.fn(async () => 'n'),
    log: vi.fn(),
  },
}));

// Mock chat-provider (summarizeOutput path).
vi.mock('../../engine/chat-provider.js', () => ({
  retryChat: vi.fn().mockResolvedValue({ message: { content: 'summary' } }),
  MODEL: 'test-model',
}));

// Mock child_process so hasTmux()/detectTerminalLauncher()/whichSync succeed
// without requiring tmux or a GUI terminal on the test host. execAsync is
// stubbed to a no-op success so session creation never really runs.
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() }) as unknown as never),
  exec: vi.fn(),
  execSync: vi.fn((cmd: string) => {
    // whichSync probes for a binary; report success for tmux and a launcher.
    if (typeof cmd === 'string' && (cmd.startsWith('which ') || cmd.startsWith('where '))) {
      return '';
    }
    return '';
  }),
}));

// promisify(exec) → execAsync. Since we mocked exec above, the promisified
// wrapper still works; make it resolve to empty stdout so the handler's
// `await execAsync('tmux new-session ...')` and capture calls succeed.
import * as cp from 'child_process';
import { promisify } from 'util';
vi.mocked(cp.exec).mockImplementation(((
  _cmd: string,
  _opts: unknown,
  cb: (e: Error | null, r: { stdout: string; stderr: string }) => void
) => {
  cb(null, { stdout: '', stderr: '' });
  return undefined as never;
}) as never);

describe('handOverTool — metadata', () => {
  it('exposes the tool name and main-only scope', () => {
    expect(handOverTool.name).toBe('hand_over');
    expect(handOverTool.scope).toEqual(['main']);
    expect(handOverTool.input_schema.required).toContain('command');
    expect(handOverTool.input_schema.required).toContain('intent');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cluster A — intent validator (Socratic dimension-naming rejection)
// ═══════════════════════════════════════════════════════════════════════

describe('Cluster A — hand_over intent validation', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('accepts RUN USER TO enter sudo password (unchanged happy path)', async () => {
    // Happy path proceeds past validation into tmux/session creation; we only
    // assert it does NOT return one of the Socratic rejection strings.
    const result = await handOverTool.handler(ctx, {
      command: 'sudo apt install -y tmux',
      intent: 'RUN USER TO enter sudo password',
    });
    expect(result).not.toContain('Intent format is:');
    expect(result).not.toContain("doesn't match that");
    expect(result).not.toContain("doesn't mean");
  });

  it('rejects READ USER TO ... with Socratic verb hint (names "execute a command or process," never RUN)', async () => {
    const result = await handOverTool.handler(ctx, {
      command: 'sudo apt install -y tmux',
      intent: 'READ USER TO enter sudo password',
    });
    expect(result).toContain('OBJECT is right');
    expect(result).toContain('VERB "READ"');
    expect(result).toContain('execute a command or process');
    // Withholds the answer token.
    expect(result).not.toContain('RUN USER');
    expect(result).not.toMatch(/\bRUN\b.*retry/i);
  });

  it('rejects RUN SYSTEM TO ... with Socratic object hint (names "human interacting with a terminal," never USER)', async () => {
    const result = await handOverTool.handler(ctx, {
      command: 'sudo apt install -y tmux',
      intent: 'RUN SYSTEM TO enter sudo password',
    });
    expect(result).toContain('OBJECT "SYSTEM"');
    expect(result).toContain('human interacting with a terminal');
    // Withholds the answer token.
    expect(result).not.toContain('RUN USER');
    expect(result).not.toMatch(/\bUSER\b.*retry/i);
  });

  it('rejects a malformed intent with the format reminder', async () => {
    const result = await handOverTool.handler(ctx, {
      command: 'sudo apt install -y tmux',
      intent: 'garbled nonsense without TO',
    });
    expect(result).toContain('Intent format is:');
    expect(result).toContain('VERB OBJECT');
    expect(result).toContain('TO PURPOSE');
  });

  it('rejects an empty intent with the format reminder', async () => {
    const result = await handOverTool.handler(ctx, {
      command: 'sudo apt install -y tmux',
      intent: '',
    });
    // Empty intent fails parseIntent → format reminder path.
    expect(result).toContain('Intent format is:');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cluster B — P1-1 tmux nesting self-check
// ═══════════════════════════════════════════════════════════════════════

describe('Cluster B — P1-1 tmux nesting self-check', () => {
  let tempDir: string;
  let ctx: AgentContext;
  let savedTmux: string | undefined;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
    vi.clearAllMocks();
    savedTmux = process.env.TMUX;
  });

  afterEach(() => {
    removeTempDir(tempDir);
    // Restore $TMUX exactly.
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
  });

  // Helper: set $TMUX to mimic "agent is running inside tmux".
  function insideTmux() {
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
  }
  function outsideTmux() {
    delete process.env.TMUX;
  }

  it('inside tmux: rejects `tmux attach -t foo` with alternatives 1 & 2, no `unset TMUX`', async () => {
    insideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'tmux attach -t foo',
      intent: 'RUN USER TO reattach to foo',
    });
    expect(result).toContain('Cannot run');
    expect(result).toContain('tmux attach -t foo');
    // Alternative 1: user runs attach outside mycc.
    expect(result).toContain('tmux attach -t foo');
    expect(result).toMatch(/own terminal/i);
    // Alternative 2: drive remotely via send-keys / capture-pane.
    expect(result).toContain('tmux send-keys');
    expect(result).toContain('tmux capture-pane');
    // The escape hatch is deliberately NOT offered.
    expect(result).not.toContain('unset TMUX');
    expect(result).not.toMatch(/unset\s+TMUX/);
  });

  it('inside tmux: rejects `tmux -L sock attach -t foo` (covers -L socket form)', async () => {
    insideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'tmux -L sock attach -t foo',
      intent: 'RUN USER TO reattach via named socket',
    });
    expect(result).toContain('Cannot run');
    expect(result).toContain('tmux -L sock attach -t foo');
  });

  it('inside tmux: rejects `tmux switch-client -t foo`', async () => {
    insideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'tmux switch-client -t foo',
      intent: 'RUN USER TO switch client',
    });
    expect(result).toContain('Cannot run');
    expect(result).toContain('switch-client');
  });

  it('inside tmux: does NOT reject `tmux send-keys -t foo "x" Enter` (safe from inside tmux)', async () => {
    insideTmux();
    const result = await handOverTool.handler(ctx, {
      command: "tmux send-keys -t foo 'x' Enter",
      intent: 'RUN USER TO send a key to foo',
    });
    // send-keys is not an attach/switch-client → not a nesting command.
    // It proceeds past the nesting check (no "Cannot run" rejection).
    expect(result).not.toContain('Cannot run');
    expect(result).not.toContain('nested sessions');
  });

  it('inside tmux: does NOT reject `tmux new-session` / `kill-session` (safe from inside tmux)', async () => {
    insideTmux();
    const r1 = await handOverTool.handler(ctx, {
      command: 'tmux new-session -d -s bar',
      intent: 'RUN USER TO spawn a detached session',
    });
    expect(r1).not.toContain('Cannot run');
    const r2 = await handOverTool.handler(ctx, {
      command: 'tmux kill-session -t bar',
      intent: 'RUN USER TO kill a session',
    });
    expect(r2).not.toContain('Cannot run');
  });

  it('outside tmux: does NOT reject `tmux attach -t foo` ($TMUX unset)', async () => {
    outsideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'tmux attach -t foo',
      intent: 'RUN USER TO reattach to foo',
    });
    expect(result).not.toContain('Cannot run');
    expect(result).not.toContain('nested sessions');
  });
});

// Silence the unused-promisify import warning under strict configs.
void promisify;
