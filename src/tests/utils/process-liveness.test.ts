/**
 * Regression tests for the shared process-liveness primitives.
 *
 * WHY THESE EXIST: both bugs guarded here were INVISIBLE under a friendly
 * environment — they only appeared when the environment was left alone:
 *
 *  1. `ps -o lstart=` is locale-dependent. With `LANG=zh_CN.UTF-8` it prints
 *     `日 10月 18 22:50:52 2026`, which `Date.parse` cannot read → null →
 *     `didPidStartAfter()` false → `isOriginalHolderAlive()` answers "the
 *     original holder is alive" for a RECYCLED pid. Failing open toward
 *     "alive" is the dangerous direction: it makes a restart/duplicate-name
 *     guard refuse to admit a legitimate instance, and makes `stopPeer`
 *     believe a dead peer is still running.
 *  2. `ps -o args=` truncates the command line to `COLUMNS`, so the trailing
 *     `--name <peer>` disappears and an exact-name identity match fails for a
 *     process mycc itself launched.
 *
 * The tests therefore assert the CONTRACT while the hostile environment is
 * explicitly installed — a test that only runs under the default environment
 * is not testing environment-dependence.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import {
  runPs,
  isPidAlive,
  getProcessStartTime,
  didPidStartAfter,
  isOriginalHolderAlive,
} from '../../utils/process-liveness.js';
import { readProcessCommandLine } from '../../../scripts/mycc-compose/lib/peers-lifecycle.js';

const HOSTILE_ENV = {
  LANG: 'zh_CN.UTF-8',
  LC_ALL: '',
  COLUMNS: '20',
};

let savedEnv: Record<string, string | undefined> = {};
let tempDir = '';

beforeAll(() => {
  savedEnv = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, COLUMNS: process.env.COLUMNS };
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-liveness-'));
  // Install the hostile environment in THIS process. It propagates to ps via
  // runPs's `env: {...process.env}`, which is what makes the assertions below
  // meaningful: they must hold even though the caller's env is unfriendly.
  process.env.LANG = HOSTILE_ENV.LANG;
  process.env.LC_ALL = HOSTILE_ENV.LC_ALL;
  delete process.env.COLUMNS;
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** `env` minus COLUMNS — ps truncates to an internal default when it is absent. */
function withoutColumns(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { COLUMNS: _dropped, ...rest } = env;
  return rest;
}

/** The module whose `ps` argv this suite pins (identity read for stopPeer). */
const LIFECYCLE_SRC = path.join(
  process.cwd(), 'scripts', 'mycc-compose', 'lib', 'peers-lifecycle.ts',
);

/** A live child whose argv is a known, long string we can search for.
 *
 * The argv shape mirrors a real peer launch: `node <script.js> --name <name>`
 * (a script FILE, like startMyccShapedProcess in mycc-compose-peers.test.ts).
 * `node -e <code>` is deliberately avoided: with `-e` node execs the script
 * path and `ps` sees the short-lived wrapper as `[node] <defunct>` instead of
 * the intended command line. */
function spawnNamedChild(padding: number): Promise<{ pid: number; kill: () => void }> {
  const script = path.join(tempDir, 'liveness-owner.js');
  fs.writeFileSync(script, 'setTimeout(function(){},600000);');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [script, '--name', 'grp:owner', '--pad', 'x'.repeat(padding)],
      // Deliberately NO COLUMNS in the child's env. Measured on this host:
      //   COLUMNS=20 set  → plain args= 20 bytes, -ww 289 bytes
      //   COLUMNS absent  → plain args= 20 bytes, -ww 289 bytes
      //   COLUMNS=100 set → plain args= 101 bytes, -ww 310 bytes  (name intact!)
      // An explicit COLUMNS is therefore the WRONG lever: 20 is honoured, but
      // the host's own 100 is wide enough that truncation would not occur and
      // the test would pass with `-ww` removed. Absent is also what a real
      // daemon inherits when nobody exports one.
      { stdio: 'ignore', env: withoutColumns(process.env) },
    );
    child.once('spawn', () => {
      // Let node finish exec'ing the script so `ps` reports the final argv,
      // not the transient wrapper.
      setTimeout(() => resolve({ pid: child.pid as number, kill: () => child.kill() }), 150);
    });
    child.once('error', reject);
  });
}

describe('runPs — the single ps invocation primitive', () => {
  it('ignores a non-C locale: `lstart` comes back in a form Date.parse can read', () => {
    // The raw ps, WITHOUT the pinned locale, in the hostile env.
    const raw = execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {
      encoding: 'utf-8',
      env: { ...process.env, LANG: HOSTILE_ENV.LANG, LC_ALL: HOSTILE_ENV.LC_ALL },
    }).trim();
    // Premise check: this host's zh_CN ps must actually produce a locale-
    // specific (unparseable) stamp, otherwise the test below proves nothing.
    const premiseHolds = !Number.isFinite(Date.parse(raw));
    if (!premiseHolds) {
      // Nothing to prove on a host whose zh_CN.UTF-8 ps falls back to English.
      expect(Date.parse(raw)).toBeGreaterThan(0);
    }

    const pinned = runPs(['-p', String(process.pid), '-o', 'lstart=']).trim();
    expect(Number.isFinite(Date.parse(pinned))).toBe(true);
  });

  it('does not truncate the command line to COLUMNS', async () => {
    const PADDING = 200; // far beyond COLUMNS=20
    const child = await spawnNamedChild(PADDING);
    try {
      // GUARD THE MEASUREMENT: assert the argv the module actually builds.
      // Calling readProcessCommandLine alone cannot catch a missing `-ww` —
      // if both the module and the test lost it, the test would agree with
      // the bug. This reads the module SOURCE and pins the flag.
      const src = fs.readFileSync(LIFECYCLE_SRC, 'utf-8');
      expect(src).toMatch(/'ps'|runPs\(/);
      expect(src).toMatch(/\['-ww',\s*'-p'/);

      // BEHAVIOUR: with a narrow width the plain read truncates and loses the
      // identity tail — this is the defect, reproduced.
      //
      // COLUMNS is forced onto the MEASURING ps invocation, not the child: ps
      // reads terminal width from its OWN env, and `runPs` inherits
      // `process.env` (COLUMNS deleted in beforeAll → ps's default, which on
      // this host is wide enough to keep the name). Without forcing it here
      // the "plain read truncates" premise silently holds-and-passes and the
      // test cannot see a removed `-ww`.
      const raw = execFileSync('ps', ['-p', String(child.pid), '-o', 'args='], {
        encoding: 'utf-8',
        env: { ...process.env, COLUMNS: '20' },
      }).trim();
      expect(raw.length).toBeLessThanOrEqual(21);
      expect(raw).not.toContain('--name grp:owner');

      // CONTRACT: the module's reader recovers the full command line even
      // though the caller's env carries the same narrow width.
      const savedColumns = process.env.COLUMNS;
      process.env.COLUMNS = '20';
      let wide: string;
      try {
        wide = (readProcessCommandLine(child.pid) ?? '').trim();
      } finally {
        if (savedColumns === undefined) delete process.env.COLUMNS;
        else process.env.COLUMNS = savedColumns;
      }
      expect(wide).toContain('--name grp:owner');
      expect(wide.length).toBeGreaterThan(raw.length);
    } finally {
      child.kill();
    }
  });
});

describe('getProcessStartTime — locale-independent (recycled-pid detection)', () => {
  it('resolves a start time for this very process under LANG=zh_CN.UTF-8', () => {
    const startedAt = getProcessStartTime(process.pid);
    // The bug's observable effect: a NULL here means every caller downstream
    // concludes "unknown start time" → "original holder is alive".
    expect(startedAt).not.toBeNull();
    expect(Number.isFinite(startedAt as number)).toBe(true);
    // Sanity: this process started in the past, not the future.
    expect(startedAt as number).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('returns null for a pid that does not exist (unknown, not "started recently")', () => {
    expect(getProcessStartTime(2_147_483_647)).toBeNull();
  });
});

describe('didPidStartAfter / isOriginalHolderAlive — the recycled-pid decision', () => {
  it('detects a pid that started AFTER the heartbeat (recycled)', async () => {
    const child = await spawnNamedChild(10);
    try {
      // Give the process a moment so its own start time is clearly in the past.
      const heartbeatBeforeStart = Date.now() - 60 * 60 * 1_000; // an hour ago
      expect(didPidStartAfter(child.pid, heartbeatBeforeStart)).toBe(true);
      expect(isOriginalHolderAlive(child.pid, heartbeatBeforeStart)).toBe(false);
    } finally {
      child.kill();
    }
  });

  it('treats a pid that started BEFORE the heartbeat as the original holder', async () => {
    const child = await spawnNamedChild(10);
    try {
      const heartbeatAfterStart = Date.now() + 60 * 60 * 1_000; // an hour ahead
      expect(didPidStartAfter(child.pid, heartbeatAfterStart)).toBe(false);
      expect(isOriginalHolderAlive(child.pid, heartbeatAfterStart)).toBe(true);
    } finally {
      child.kill();
    }
  });

  it('fails CLOSED on unknown start time: an unknown pid is never assumed recycled', () => {
    // A pid with no process at all is simply not alive.
    expect(isPidAlive(2_147_483_647)).toBe(false);
    expect(isOriginalHolderAlive(2_147_483_647, Date.now())).toBe(false);
    // A missing heartbeat timestamp is not evidence of recycling.
    expect(isOriginalHolderAlive(process.pid, 0)).toBe(true);
  });
});
