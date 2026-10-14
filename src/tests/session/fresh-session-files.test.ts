/**
 * fresh-session-files.test.ts — the P2-c regression suite: the lead
 * triologue filename chooser in src/session/index.ts must be COLLISION-SAFE.
 *
 * HISTORY / WHY THIS FILE CHANGED: the suite originally drove the chooser
 * through a mocked `getPinnedSessionId()` so two same-second relaunches of the
 * SAME pinned session id wrote into one session directory. Pinned session ids
 * are GONE (sessions are never reused — each launch mints a fresh random id),
 * so that mock target no longer exists and the "same pinned dir" premise is
 * gone with it. What SURVIVES and is still worth pinning: every
 * `createNewSession()` mints a brand-new session directory, the lead triologue
 * uses the readable `triologue-lead-<sec>.jsonl` stem, and no start ever
 * truncates an existing transcript. The exclusive-create (`openSync(path,'wx')`)
 * + suffix-ladder guard in writeFreshSessionFiles() is preserved precisely so
 * that a same-second collision (should one ever recur) degrades to a fresh
 * filename instead of a silent truncation.
 *
 * SEAMS: config.ts parses process.argv ONCE at module load, and the session
 * module resolves `.mycc/...` against process.cwd() at call time — so per-test
 * cwd isolation (chdir into a temp project) keeps the real tree untouched with
 * NO mocking needed at all.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type SessionMod = typeof import('../../session/index.js');

let projectTmp = '';
let prevCwd = '';

/** Import the session module AFTER the cwd override (its path helpers
 * resolve `.mycc/...` against process.cwd() at call time). */
async function loadSession(): Promise<SessionMod> {
  return import('../../session/index.js');
}

/** List the triologue files in a session dir, sorted. */
function triologueFiles(id: string): string[] {
  const dir = path.join(projectTmp, '.mycc', 'sessions', id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith('triologue-lead-')).sort();
}

beforeEach(() => {
  prevCwd = process.cwd();
  projectTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-fresh-sess-'));
  process.chdir(projectTmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  try {
    fs.rmSync(projectTmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('writeFreshSessionFiles: fresh unique session + collision-safe filename (P2-c)', () => {
  it('each start mints a DISTINCT session dir and transcript, never truncating the previous', async () => {
    const sess = await loadSession();
    const first = sess.createNewSession();
    fs.appendFileSync(first.triologuePath, JSON.stringify({ v: 1 }) + '\n', 'utf-8');
    expect(fs.existsSync(first.triologuePath)).toBe(true);

    const second = sess.createNewSession();

    // A fresh random id per launch → different dir, different path.
    expect(second.triologuePath).not.toBe(first.triologuePath);
    expect(path.dirname(second.triologuePath)).not.toBe(path.dirname(first.triologuePath));
    // The original transcript is intact — the append survived untouched.
    expect(fs.readFileSync(first.triologuePath, 'utf-8')).toContain('"v":1');
    expect(fs.existsSync(second.triologuePath)).toBe(true);
  });

  it('keeps the plain second-precision name (stem format unchanged)', async () => {
    const sess = await loadSession();
    const init = sess.createNewSession();
    const name = path.basename(init.triologuePath);
    expect(name).toMatch(/^triologue-lead-\d+\.jsonl$/);
    expect(name).not.toMatch(/ms\.jsonl$/);
  });

  it('three starts produce three DISTINCT session dirs (none truncated)', async () => {
    const sess = await loadSession();
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      const init = sess.createNewSession();
      expect(paths).not.toContain(init.triologuePath);
      fs.appendFileSync(init.triologuePath, `gen-${i}\n`, 'utf-8');
      paths.push(init.triologuePath);
      // Each dir holds exactly its own single transcript.
      expect(triologueFiles(path.basename(path.dirname(init.triologuePath)))).toHaveLength(1);
    }
    for (let i = 0; i < 3; i++) {
      expect(fs.readFileSync(paths[i], 'utf-8')).toBe(`gen-${i}\n`);
    }
  });
});
