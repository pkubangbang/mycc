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
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';

// Mock agentIO so handler never touches the real terminal.
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    ask: vi.fn(async () => 'n'),
    log: vi.fn(),
    getAuto: vi.fn(() => false),
  },
}));

// Mock chat-provider (summarizeOutput path).
vi.mock('../../engine/chat-provider.js', () => ({
  retryChat: vi.fn().mockResolvedValue({ message: { content: 'summary' } }),
  MODEL: 'test-model',
}));

// Mock child_process so hasTmux()/detectTerminalLauncher()/whichSync succeed
// without requiring tmux or a GUI terminal on the test host. execAsync is
// stubbed to a no-op success. spawn is stubbed to return an EventEmitter that
// emits 'close' with code 0 and has unref(), so the hand_over handler's
// spawnTmux() helper (used for the new session + send-keys delivery) resolves
// cleanly instead of throwing on a missing .on().
import { EventEmitter } from 'events';
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const ee = new EventEmitter();
    // Emit 'close' with code 0 asynchronously so the 'close' listener attaches
    // first (mirrors a real subprocess completing successfully).
    queueMicrotask(() => ee.emit('close', 0));
    return Object.assign(ee, { unref: vi.fn() }) as unknown as never;
  }),
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

  it('delivers the command via a bare session + send-keys (not cmd /k shell-command)', async () => {
    // Structural contract for the Windows-fix: session creation must (1) create
    // a bare session whose shell is the startup-detected one, and (2) send-keys
    // the command into the pane verbatim — NOT pass `cmd /k ${command}` as the
    // session's initial shell-command argument (the old cmd.exe metacharacter
    // breakage). We assert on spawn's argv, turning the previously-green
    // "does not contain a rejection" into a real delivery-contract check.
    const result = await handOverTool.handler(ctx, {
      command: 'echo a & echo b > C:\\tmp\\x.txt',
      intent: 'RUN USER TO run a metacharacter command',
    });

    expect(result).not.toContain('Failed to create session');

    const calls = vi.mocked(cp.spawn).mock.calls.map((c) => c[1]) as string[][];

    // Call 1: bare new-session, with a shell name (NOT an embedded `cmd /k ...`).
    const newSessionArgs = calls.find((a) => a[0] === 'new-session');
    expect(newSessionArgs).toBeDefined();
    expect(newSessionArgs!.join(' ')).not.toContain('cmd /k');
    // The last arg is the shell name (pwsh/powershell/bash/zsh), not the command.
    const shellArg = newSessionArgs![newSessionArgs!.length - 1];
    expect(['pwsh', 'powershell', 'bash', 'zsh']).toContain(shellArg);

    // Call 2: send-keys delivers the command verbatim (with a leading-space guard)
    // + Enter, NOT embedded into an execAsync string.
    const sendKeysArgs = calls.find((a) => a[0] === 'send-keys');
    expect(sendKeysArgs).toBeDefined();
    expect(sendKeysArgs!.join(' ')).toContain(` ${'echo a & echo b > C:\\tmp\\x.txt'}`);
    expect(sendKeysArgs![sendKeysArgs!.length - 1]).toBe('Enter');
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
// Cluster B — P1-1 tmux nesting self-check (UNCONDITIONAL leading-tmux reject)
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

  it('rejects `tmux attach -t foo` with the contract message, regardless of $TMUX (inside)', async () => {
    insideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'tmux attach -t foo',
      intent: 'RUN USER TO reattach to foo',
    });
    // Rejects with the unconditional leading-tmux contract message.
    expect(result).toContain('Error:');
    expect(result).toContain('starts with `tmux`');
    expect(result).toContain('its own tmux session');
    expect(result).toContain('INNER interactive command');
    expect(result).toContain('use `bash` instead');
    // The escape hatch is deliberately NOT offered.
    expect(result).not.toMatch(/unset\s+TMUX/);
  });

  it('rejects `tmux -L sock attach -t foo` (covers -L socket form)', async () => {
    insideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'tmux -L sock attach -t foo',
      intent: 'RUN USER TO reattach via named socket',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('starts with `tmux`');
    expect(result).toContain('tmux -L sock attach -t foo');
  });

  it('rejects `tmux switch-client -t foo`', async () => {
    insideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'tmux switch-client -t foo',
      intent: 'RUN USER TO switch client',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('starts with `tmux`');
    expect(result).toContain('switch-client');
  });

  it('rejects `tmux new-session ...` — the nesting hole (now closed)', async () => {
    insideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'tmux new-session -d -s bar',
      intent: 'RUN USER TO spawn a detached session',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('starts with `tmux`');
    expect(result).toContain('new-session');
  });

  it('rejects `tmux send-keys ...` — the nesting hole (now closed)', async () => {
    insideTmux();
    const result = await handOverTool.handler(ctx, {
      command: "tmux send-keys -t foo 'x' Enter",
      intent: 'RUN USER TO send a key to foo',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('starts with `tmux`');
    expect(result).toContain('send-keys');
  });

  it('rejects `tmux kill-session -t bar` — the nesting hole (now closed)', async () => {
    insideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'tmux kill-session -t bar',
      intent: 'RUN USER TO kill a session',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('starts with `tmux`');
    expect(result).toContain('kill-session');
  });

  // (i) $TMUX-unset + `tmux attach` now rejected (previously the $TMUX-unset hole).
  it('outside tmux: rejects `tmux attach -t foo` ($TMUX unset — no longer a hole)', async () => {
    outsideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'tmux attach -t foo',
      intent: 'RUN USER TO reattach to foo',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('starts with `tmux`');
    expect(result).toContain('its own tmux session');
  });

  // (ii) $TMUX-unset + `tmux new-session ...` now rejected (the hole, outside tmux).
  it('outside tmux: rejects `tmux new-session -d -s bar` ($TMUX unset — no longer a hole)', async () => {
    outsideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'tmux new-session -d -s bar',
      intent: 'RUN USER TO spawn a detached session',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('starts with `tmux`');
  });

  // (iii) a plain foreground interactive command still passes (no nesting reject).
  // We assert the nesting self-check does NOT fire (its signatures absent) rather
  // than session-creation success: the child_process mock stubs execAsync, so the
  // downstream `tmux new-session ...` path is not what we're verifying here.
  it('inside tmux: does NOT reject a plain `ssh` (foreground interactive payload)', async () => {
    insideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'ssh user@host',
      intent: 'RUN USER TO ssh into host',
    });
    expect(result).not.toContain('starts with `tmux`');
    expect(result).not.toContain('INNER interactive command');
    expect(result).not.toContain('use `bash` instead');
  });

  it('inside tmux: does NOT reject a plain `vim file` (foreground interactive payload)', async () => {
    insideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'vim notes.txt',
      intent: 'RUN USER TO edit notes',
    });
    expect(result).not.toContain('starts with `tmux`');
    expect(result).not.toContain('INNER interactive command');
    expect(result).not.toContain('use `bash` instead');
  });

  it('inside tmux: does NOT reject a plain `sudo apt install -y tmux`', async () => {
    insideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'sudo apt install -y tmux',
      intent: 'RUN USER TO enter sudo password',
    });
    expect(result).not.toContain('starts with `tmux`');
    expect(result).not.toContain('INNER interactive command');
    expect(result).not.toContain('use `bash` instead');
  });

  it('outside tmux: does NOT reject a plain `sudo apt install -y tmux` ($TMUX unset)', async () => {
    outsideTmux();
    const result = await handOverTool.handler(ctx, {
      command: 'sudo apt install -y tmux',
      intent: 'RUN USER TO enter sudo password',
    });
    expect(result).not.toContain('starts with `tmux`');
    expect(result).not.toContain('INNER interactive command');
    expect(result).not.toContain('use `bash` instead');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cluster C — empty command ("!" only) opens an interactive shell
// Regression: the user typing just "!" at the prompt must NOT cause the
// literal text "undefined" to be typed into the pane (the old bug, from
// `command || undefined` in prompt.ts being stringified by send-keys).
// ═══════════════════════════════════════════════════════════════════════

describe('Cluster C — empty command opens an interactive shell (no "undefined")', () => {
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

  it('does NOT send-keys the literal "undefined" for an empty command', async () => {
    const result = await handOverTool.handler(ctx, {
      command: '',
      intent: 'RUN USER TO open interactive shell',
    });
    // Must reach the session path (not a validation/prereq rejection).
    expect(result).not.toContain('Failed to create session');
    expect(result).not.toContain('Intent format is:');

    const calls = vi.mocked(cp.spawn).mock.calls.map((c) => c[1]) as string[][];
    const sendKeysArgs = calls.find((a) => a[0] === 'send-keys');
    // For an empty command, send-keys must be SKIPPED entirely — the pane
    // stays at a clean shell prompt. The old bug typed ` undefined` here.
    expect(sendKeysArgs).toBeUndefined();
  });

  it('labels the result "(interactive shell)" instead of "undefined"', async () => {
    const result = await handOverTool.handler(ctx, {
      command: '',
      intent: 'RUN USER TO open interactive shell',
    });
    expect(result).toContain('User ran: (interactive shell)');
    expect(result).not.toContain('User ran: undefined');
  });

  it('records a non-undefined todo body for an empty command', async () => {
    await handOverTool.handler(ctx, {
      command: '',
      intent: 'RUN USER TO open interactive shell',
    });
    const createTodo = ctx.todo.createTodo as ReturnType<typeof vi.fn>;
    expect(createTodo).toHaveBeenCalled();
    const [, body] = createTodo.mock.calls[createTodo.mock.calls.length - 1];
    expect(body).toBe('(interactive shell)');
  });

  it('still send-keys a real command (non-empty unchanged behavior)', async () => {
    const result = await handOverTool.handler(ctx, {
      command: 'vim notes.txt',
      intent: 'RUN USER TO edit notes',
    });
    expect(result).not.toContain('Failed to create session');

    const calls = vi.mocked(cp.spawn).mock.calls.map((c) => c[1]) as string[][];
    const sendKeysArgs = calls.find((a) => a[0] === 'send-keys');
    expect(sendKeysArgs).toBeDefined();
    expect(sendKeysArgs!.join(' ')).toContain(' vim notes.txt');
    expect(sendKeysArgs![sendKeysArgs!.length - 1]).toBe('Enter');
  });
});

// Silence the unused-promisify import warning under strict configs.
void promisify;
