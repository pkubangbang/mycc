/**
 * file-lock-crossproc.test.ts — the property the round-1 file-lock unit tests
 * did NOT prove: REAL cross-process mutual exclusion.
 *
 * The original file-lock.test.ts could only test creation/release/stale-reclaim
 * because two synchronous `withFileLock()` calls in one thread cannot overlap
 * (the acquire loop is synchronous). That leaves the actual invariant — "two
 * PROCESSES never hold the lock at once" — untested, which is exactly the
 * defect class the lock was introduced to close (identity.json lost update).
 *
 * This suite spawns N child `node` processes that each (a) acquire the lock,
 * (b) append a timestamped "enter" line, (c) sleep a bit while holding it,
 * (d) append "exit", (e) release — then asserts the recorded intervals never
 * overlap. The children import the REAL src/utils/file-lock.ts through the same
 * tsx ESM loader the compose bin uses.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

let tmp = '';
let lockTarget = '';
let logFile = '';

/** Absolute path to the repo root (two levels up from src/tests). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-flock-xp-'));
  lockTarget = path.join(tmp, 'guarded.json');
  logFile = path.join(tmp, 'intervals.log');
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(lockTarget, '{}');
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/**
 * The worker script each child runs: acquire the lock, record enter/exit with
 * timestamps into the shared log, hold briefly, release. The lock target and
 * log path come from argv so one script serves all children.
 */
describe('withFileLock: real cross-process mutual exclusion', () => {
  it('N concurrent processes never hold the lock at the same time', () => {
    // Each child: enter-timestamp, busy-hold ~150ms, exit-timestamp.
    //
    // The worker script is written INTO REPO_ROOT (not the temp dir) so that
    // `import 'tsx/esm/api'` resolves `tsx` from the repo's node_modules — ESM
    // resolves bare specifiers relative to the IMPORTING SCRIPT's location, not
    // the child's cwd, so a script in %TEMP% cannot find tsx. REPO_ROOT also
    // lets the worker import file-lock via the plain relative path './src/...'.
    const script = `
      import { register } from 'tsx/esm/api';
      register();
      const { withFileLock } = await import('./src/utils/file-lock.ts');
      const fs = await import('fs');
      const target = process.argv[2];
      const log = process.argv[3];
      const HOLD_MS = 150;
      withFileLock(target, () => {
        const enter = Date.now();
        const end = enter + HOLD_MS;
        while (Date.now() < end) { /* hold */ }
        fs.appendFileSync(log, enter + ' ' + end + '\\n');
      });
    `;
    const scriptFile = path.join(REPO_ROOT, `.mycc-flock-worker-${process.pid}.mjs`);
    fs.writeFileSync(scriptFile, script);

    try {
      const N = 4;
      const children = [];
      for (let i = 0; i < N; i++) {
        children.push(
          spawnSync(
            process.execPath,
            ['--import', 'tsx', scriptFile, lockTarget, logFile],
            { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 30_000 },
          ),
        );
      }
      for (const c of children) {
        expect(c.status, `child exited non-zero: ${c.stderr}`).toBe(0);
      }

      const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
      expect(lines.length, 'each child recorded exactly one hold interval').toBe(N);
      const intervals = lines.map((l) => {
        const [enter, exit] = l.split(' ').map(Number);
        return { enter, exit };
      });
      intervals.sort((a, b) => a.enter - b.enter);
      for (let i = 1; i < intervals.length; i++) {
        // No overlap: the previous interval must have ended before this one began.
        expect(
          intervals[i].enter >= intervals[i - 1].exit,
          `overlap detected between ${JSON.stringify(intervals[i - 1])} and ${JSON.stringify(intervals[i])}`,
        ).toBe(true);
      }
    } finally {
      try {
        fs.rmSync(scriptFile, { force: true });
      } catch {
        // best-effort
      }
    }
  }, 40_000);
});
