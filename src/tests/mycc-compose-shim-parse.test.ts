/**
 * mycc-compose-shim-parse.test.ts — the P1-3 regression: parseCmdShim must
 * resolve a REAL npm-generated cmd-shim shape whose prog token is the
 * `%_prog%` indirection pointing at `%dp0%\node.exe` (SET inside IF EXIST):
 *
 *     IF EXIST "%dp0%\node.exe" SET "_prog=%dp0%\node.exe" ELSE SET "_prog=node"
 *     ...
 *     endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\bin\mycc.js" %*
 *
 * The pre-fix resolveProg REJECTED any %-bearing token → parseCmdShim null →
 * spawnDetached kept the `cmd /c` wrap → the visible-console pop
 * (docs/peer-launch-windows.md §3) the parser exists to prevent.
 *
 * parseCmdShim is module-private; it is exercised THROUGH launchPeer + the
 * LaunchPeerOpts.spawnImpl seam by asserting the (command,args) the seam
 * receives for a fixture shim under MYCC_ROOT. Windows-only: on POSIX the
 * launcher is the extensionless `mycc` fixture and parseCmdShim is gated off —
 * those runners assert the early-null contract instead.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type SpawnOptions, type ChildProcess } from 'child_process';

// UNIQUE sid per suite: the discovery store is shared by every suite that
// fails to capture MYCC_DISCOVERY_DIR (issue #8), and launchPeer's holder
// gate reads the WHOLE store — a colliding sid from another suite's leaked
// fixture poisons these launches with 'still held'. A suite-unique sid makes
// that leak benign here (one extra entry the holder gate never matches).
const SID = '1a1a1111-2222-4111-8111-111111111111';

let tempDir = '';
let binDir = '';

/** Fresh lifecycle + discovery module instances AFTER the env is set. */
type Lifecycle = typeof import('../../scripts/mycc-compose/lib/peers-lifecycle.js');
let lifecycle: Lifecycle | null = null;
async function loadLifecycle(): Promise<Lifecycle> {
  vi.resetModules();
  lifecycle = (await import('../../scripts/mycc-compose/lib/peers-lifecycle.js')) as Lifecycle;
  return lifecycle;
}

/** The peer fixture: a pinned sid, daemonless launch args. */
function peerFixture() {
  return {
    name: 'shim-peer',
    workdir: tempDir,
    sessionId: SID,
    args: '--auto --skip-healthcheck',
    renew: 'onMismatch' as const,
    parsedArgs: { _: [], 'auto': true, 'skip-healthcheck': true } as Record<string, unknown>,
  } as const;
}

/**
 * Write a REAL npm-cmd-shim-shaped launcher at <binDir>/mycc.cmd with the
 * %_prog% indirection, as `npm install -g` renders it. `bundleNode` decides
 * whether the bundled <binDir>\node.exe exists (IF-EXIST true) or not (npm's
 * ELSE semantics: bare `node`).
 */
function writeNpmShimShape(opts: { bundleNode: boolean }): void {
  fs.mkdirSync(binDir, { recursive: true });
  const entry = path.join(binDir, 'mycc.js');
  fs.writeFileSync(entry, 'setTimeout(function(){},600000);');
  if (opts.bundleNode) {
    // A fixture file, not a real exe — existence is all the resolver checks.
    fs.writeFileSync(path.join(binDir, 'node.exe'), 'fixture');
  }
  fs.writeFileSync(
    path.join(binDir, 'mycc.cmd'),
    '@echo off\r\n' +
      'SETLOCAL ENABLEDELAYEDEXPANSION\r\n' +
      'IF EXIST "%dp0%\\node.exe" (\r\n' +
      '  SET "_prog=%dp0%\\node.exe"\r\n' +
      ') ELSE (\r\n' +
      '  SET "_prog=node"\r\n' +
      ')\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\mycc.js" %*\r\n',
  );
}

/**
 * A spawnImpl that CAPTURES (command,args) instead of really spawning. The
 * captured process exits at once, so launchPeer never sees a beat and rejects
 * at the (test-shortened) timeout; the assertion happens on the capture.
 */
function capturingSpawn(): {
  seen: Array<{ command: string; args: string[] }>;
  impl: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
} {
  const seen: Array<{ command: string; args: string[] }> = [];
  const impl = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    seen.push({ command, args: [...args] });
    void options;
    return spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  };
  return { seen, impl };
}

/** Drive launchPeer with the capturing seam; the timeout rejection is expected. */
async function captureLaunchShape(timeoutMs: number): Promise<Array<{ command: string; args: string[] }>> {
  const { seen, impl } = capturingSpawn();
  const { launchPeer } = await loadLifecycle();
  await launchPeer(peerFixture() as unknown as Parameters<typeof launchPeer>[0], {
    spawnImpl: impl,
    timeoutMs,
  }).then(
    () => { /* not expected: the seam child never beats */ },
    () => { /* expected timeout rejection */ },
  );
  return seen;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-shim-'));
  binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(path.join(tempDir, 'discovery', 'heartbeat'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'discovery'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'discovery', 'identity.json'), '{}');
  process.env.MYCC_DISCOVERY_DIR = path.join(tempDir, 'discovery');
  process.env.MYCC_ROOT = tempDir; // resolveMyccLauncher → <tempDir>/bin/mycc.cmd
  writeLaunchBaseFixture();
});

/** A DECEASED holder for the sid: fresh heartbeat, dead pid, registered
 * entry. launchPeer's holder gate (isSessionHeld) must pass — it cannot
 * disprove via a dead pid — so the spawn seam is actually reached; without
 * this the launch rejects 'still held' before ever capturing (the holder gate
 * assumes HELD when the heartbeat file records no pid at all). */
function writeDeadHolderHeartbeat(): void {
  const map = JSON.parse(fs.readFileSync(path.join(tempDir, 'discovery', 'identity.json'), 'utf-8')) as Record<string, unknown>;
  map[SID] = { sessionId: SID, workDir: tempDir, mailbox: 'mb', startedAt: Date.now() };
  fs.writeFileSync(path.join(tempDir, 'discovery', 'identity.json'), JSON.stringify(map));
  fs.writeFileSync(
    path.join(tempDir, 'discovery', 'heartbeat', `${SID}.json`),
    JSON.stringify({ heartbeats: [Date.now()], briefs: [], pid: 0 }),
  );
}

/** The baseline fixture shim resolveMyccLauncher finds; per-test writers
 * overwrite it. Without a pre-seeded shim, tests that never call a writer
 * would leave launchPeer's `?? 'mycc'` fallback in place. */
function writeLaunchBaseFixture(): void {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'mycc.cmd'),
    '@echo off\r\nREM placeholder, replaced per test\r\n',
  );
}

afterEach(() => {
  delete process.env.MYCC_DISCOVERY_DIR;
  delete process.env.MYCC_ROOT;
  vi.restoreAllMocks();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const isWin = process.platform === 'win32';
const d = describe.skip;

(isWin ? describe : d)('parseCmdShim: real npm _prog=%dp0% shape (P1-3, win32)', () => {
  it('bundled node.exe present → prog resolves to <shimDir>\\node.exe, no cmd /c wrap', async () => {
    writeDeadHolderHeartbeat();
    writeNpmShimShape({ bundleNode: true });
    const seen = await captureLaunchShape(2_500);
    expect(seen).toHaveLength(1);
    expect(seen[0].command).toBe(path.join(binDir, 'node.exe'));
    expect(seen[0].args[0]).toBe(path.join(binDir, 'mycc.js'));
    expect(seen[0].command.toLowerCase()).not.toMatch(/cmd$/);
  });

  it('bundled node.exe absent → prog degrades to PATH `node`, no cmd /c wrap', async () => {
    writeDeadHolderHeartbeat();
    writeNpmShimShape({ bundleNode: false });
    const seen = await captureLaunchShape(2_500);
    expect(seen).toHaveLength(1);
    expect(seen[0].command).toBe('node');
    expect(seen[0].args[0]).toBe(path.join(binDir, 'mycc.js'));
  });

  it('unparsable shim shape → keeps the documented cmd /c fallback', async () => {
    writeDeadHolderHeartbeat();
    // A shape the parser deliberately does not recognize (no quoted .js exec).
    fs.writeFileSync(
      path.join(binDir, 'mycc.cmd'),
      '@echo off\r\nmy-cli.exe %*\r\n',
    );
    const seen = await captureLaunchShape(2_500);
    expect(seen).toHaveLength(1);
    expect(seen[0].command).toBe('cmd');
    expect(seen[0].args[0]).toBe('/c');
    expect(seen[0].args[1]).toBe(path.join(binDir, 'mycc.cmd'));
  });

  it('spawned argv is the launcher real argv: prog + target + --session-id sid + args', async () => {
    writeDeadHolderHeartbeat();
    writeNpmShimShape({ bundleNode: true });
    const seen = await captureLaunchShape(2_500);
    expect(seen[0].args.slice(0, 3)).toEqual([path.join(binDir, 'mycc.js'), '--session-id', SID]);
    expect(seen[0].args).toContain('--auto');
    expect(seen[0].args.join(' ')).not.toContain('%');
  });
});

(!isWin ? describe : d)('parseCmdShim gating (POSIX)', () => {
  it('a .cmd launcher is not parsed outside win32 — the shim path reaches the seam as-is', async () => {
    // On POSIX resolveMyccLauncher only probes the extensionless name, so the
    // .cmd path never occurs; pin the gate by asserting the extensionless
    // fixture is used (spawn of the real file, no cmd /c wrap).
    fs.mkdirSync(binDir, { recursive: true });
    const shim = path.join(binDir, 'mycc');
    const entry = path.join(binDir, 'mycc.js');
    fs.writeFileSync(entry, 'setTimeout(function(){},600000);');
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
    const seen = await captureLaunchShape(2_500);
    expect(seen[0].command).toBe(shim);
    expect(seen[0].command.toLowerCase()).not.toMatch(/cmd\.exe$/);
  });
});