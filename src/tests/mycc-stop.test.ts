/**
 * mycc-stop.test.ts — the mycc-stop CLI's three forms + the sid-native stop
 * primitive (stopPeerBySid).
 *
 * Forms under test:
 *   1. ADDRESS      mycc-stop --group <g> --name <n> [--cwd <dir>]
 *   2. SESSION ID   mycc-stop --session-id=<full-uuid>   (rejects malformed)
 *   3. LIST         mycc-stop                             (no args)
 *
 * The CLI forms are exercised END-TO-END as a child process so the real exit
 * codes are asserted (the shim does process.exit, which would kill the vitest
 * worker). The discovery store is isolated via MYCC_DISCOVERY_DIR so nothing
 * touches the developer's real ~/.mycc-store.
 *
 * stopPeerBySid is exercised directly (imported after the env override, per the
 * compose-suite module-graph discipline: discovery.ts pins DISCOVERY_DIR at
 * module load, so imports must follow the override).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mutedSlowSuite } from './utils/slow-suite.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

const ROOT = path.resolve(__dirname, '..', '..');
const STOP_BIN = path.join(ROOT, 'scripts', 'mycc-stop', 'mycc-stop.js');

let tempDir = '';
let storeDir = '';

/** Run the mycc-stop CLI as a child process; returns exit code + stdio. */
function runStop(argv: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [STOP_BIN, ...argv], {
      encoding: 'utf-8',
      env: { ...process.env, MYCC_DISCOVERY_DIR: storeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** Seed a live identity entry + heartbeat for `sid` under `storeDir`. */
function seedLivePeer(sid: string, name: string, pid: number): void {
  const hbDir = path.join(storeDir, 'heartbeat');
  fs.mkdirSync(hbDir, { recursive: true });
  fs.writeFileSync(
    path.join(hbDir, `${sid}.json`),
    JSON.stringify({ heartbeats: [Date.now()], briefs: [], pid }),
  );
  const idFile = path.join(storeDir, 'identity.json');
  const map = fs.existsSync(idFile) ? JSON.parse(fs.readFileSync(idFile, 'utf-8')) : {};
  map[sid] = { sessionId: sid, name, pid, workDir: tempDir, args: '--auto', startedAt: Date.now() };
  fs.writeFileSync(idFile, JSON.stringify(map, null, 2));
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-stop-'));
  storeDir = path.join(tempDir, 'discovery');
  fs.mkdirSync(storeDir, { recursive: true });
  // Override BEFORE any compose-lib import of a test's module graph (discovery.ts
  // pins DISCOVERY_DIR at load time) AND for the child-process CLI (which reads
  // it from the env passed in runStop).
  process.env.MYCC_DISCOVERY_DIR = storeDir;
});

afterEach(() => {
  delete process.env.MYCC_DISCOVERY_DIR;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe.skipIf(mutedSlowSuite(import.meta.url))('mycc-stop CLI — form dispatch + exit codes', () => {
  it('--help exits 0 and states the two synopses (ADDRESS + SESSION ID) and the LIST form', () => {
    const { code, stdout } = runStop(['--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/ADDRESS/);
    expect(stdout).toMatch(/SESSION ID/);
    expect(stdout).toMatch(/list running peers/);
  });

  it('bare (list form) exits 0 with an empty store and says no peers are running', () => {
    const { code, stdout } = runStop([]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/no running peers/);
  });

  it('bare (list form) prints a seeded running peer', () => {
    const sid = randomUUID();
    seedLivePeer(sid, 'grp:reviewer', process.pid);
    const { code, stdout } = runStop([]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/grp:reviewer/);
    expect(stdout).toMatch(new RegExp(sid));
  });

  it('SESSION ID: a short/malformed id is REJECTED with "not a well-formed session-id" (exit 1)', () => {
    const { code, stderr } = runStop(['--session-id=4a0ccb8']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/not a well-formed session-id/);
  });

  it('SESSION ID: a full uuid with no matching entry is not running (exit 0)', () => {
    const { code, stdout } = runStop([`--session-id=${randomUUID()}`]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/not running/);
  });

  it('ADDRESS: --group/--name with --cwd defaulting to pwd, no match → not running (exit 0)', () => {
    const { code, stdout } = runStop(['--group', 'grp', '--name', 'nope']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/is not running/);
  });

  it('ADDRESS: missing --name is a usage error (exit 2)', () => {
    const { code } = runStop(['--group', 'grp']);
    expect(code).toBe(2);
  });
});

describe('stopPeerBySid — sid-native stop (no address resolution)', () => {
  it('a full sid with no identity entry → refused-not-found (never guesses)', async () => {
    vi.resetModules();
    const stop = await import('../../scripts/mycc-compose/lib/peers-stop.js');
    const res = await stop.stopPeerBySid(randomUUID());
    expect(res.verdict).toBe('refused-not-found');
    expect(res.sessionId).not.toBeNull();
  });
});
