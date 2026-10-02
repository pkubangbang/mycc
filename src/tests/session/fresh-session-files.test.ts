/**
 * fresh-session-files.test.ts — the P2-c regression suite: the lead
 * triologue filename chooser in src/session/index.ts must be COLLISION-SAFE
 * under a same-second relaunch of the SAME pinned session id.
 *
 * Reachability (why this matters): mycc-compose pins SIDs so a relaunched
 * peer REUSES its session directory — and `up`/restart inside the same wall
 * clock second would make `triologue-lead-<sec>.jsonl` name the PREVIOUS
 * run's transcript. writeFreshSessionFiles() then wrote `''` over it with a
 * bare writeFileSync, silently truncating the append-only record the whole
 * system treats as the authoritative backlog (MYCC.md: never truncated).
 *
 * SEAMS (why mocking is required): config.ts parses process.argv ONCE at
 * module load, so process.env.MYCC_SESSION_ID does NOT drive
 * getPinnedSessionId() — the real pinned-id source must be mocked. The mock
 * is a hoisted-hook delegate (evaluated at CALL time), so a cached mock
 * graph (vi.resetModules does not clear the mock registry — the issue #9
 * lesson) stays correct across tests. Everything else — getSessionsDir()
 * (cwd-relative `.mycc/sessions`), createSessionFile — resolves lazily at
 * call time, so per-test cwd isolation (process.chdir into a temp project)
 * keeps the real tree untouched without mocking the file layer.
 *
 * What is asserted: distinct filenames under same-second starts, NO
 * truncation of an existing transcript, unchanged `triologue-lead-` stem +
 * session-dir layout, and the plain second-precision name when free.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type SessionMod = typeof import('../../session/index.js');

const hook = vi.hoisted(() => ({ pinned: null as string | null }));

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return {
    ...actual,
    // CALL-TIME delegate: the chooser reads the pin at write time, so each
    // test flips hook.pinned without re-importing anything.
    getPinnedSessionId: () => hook.pinned,
  };
});

let projectTmp = '';
let prevCwd = '';

/** Import the session module AFTER the cwd override (its path helpers
 * resolve `.mycc/...` against process.cwd() at call time). */
async function loadSession(): Promise<SessionMod> {
  vi.resetModules();
  return import('../../session/index.js');
}

/** List the triologue files in the pinned session dir, sorted. */
function triologueFiles(id: string): string[] {
  const dir = path.join(projectTmp, '.mycc', 'sessions', id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith('triologue-lead-')).sort();
}

beforeEach(() => {
  prevCwd = process.cwd();
  projectTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-fresh-sess-'));
  process.chdir(projectTmp);
  hook.pinned = null;
});

afterEach(() => {
  hook.pinned = null;
  process.chdir(prevCwd);
  try {
    fs.rmSync(projectTmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  vi.restoreAllMocks();
});

describe('writeFreshSessionFiles: collision-safe triologue filename (P2-c)', () => {
  it('two same-second starts under the SAME pinned sid yield DIFFERENT files and no truncation', async () => {
    hook.pinned = 'ffffffff-0000-4000-8000-000000000001';
    const sess = await loadSession();
    const first = sess.createNewSession();
    fs.appendFileSync(first.triologuePath, JSON.stringify({ v: 1 }) + '\n', 'utf-8');
    expect(fs.existsSync(first.triologuePath)).toBe(true);

    // The second start lands within the same wall-clock second almost
    // surely. Pre-fix this truncated `first.triologuePath` to ''.
    const second = sess.createNewSession();

    expect(second.triologuePath).not.toBe(first.triologuePath);
    // The original transcript is intact — the append survived untouched.
    expect(fs.readFileSync(first.triologuePath, 'utf-8')).toContain('"v":1');
    // Both live in the SAME session dir (layout unchanged), both exist.
    expect(triologueFiles(hook.pinned).length).toBe(2);
    expect(fs.existsSync(second.triologuePath)).toBe(true);
  });

  it('keeps the plain second-precision name when it is FREE (stem format unchanged)', async () => {
    hook.pinned = 'ffffffff-0000-4000-8000-000000000002';
    const sess = await loadSession();
    const init = sess.createNewSession();
    const name = path.basename(init.triologuePath);
    expect(name).toMatch(/^triologue-lead-\d+\.jsonl$/);
    expect(name).not.toMatch(/ms\.jsonl$/);
  });

  it('three same-second starts produce three DISTINCT transcripts (none truncated)', async () => {
    hook.pinned = 'ffffffff-0000-4000-8000-000000000003';
    const sess = await loadSession();
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      const init = sess.createNewSession();
      expect(paths).not.toContain(init.triologuePath);
      fs.appendFileSync(init.triologuePath, `gen-${i}\n`, 'utf-8');
      paths.push(init.triologuePath);
    }
    // Every file still holds exactly its own content — a later same-second
    // start never zeroed an earlier transcript.
    for (let i = 0; i < 3; i++) {
      expect(fs.readFileSync(paths[i], 'utf-8')).toBe(`gen-${i}\n`);
    }
  });
});