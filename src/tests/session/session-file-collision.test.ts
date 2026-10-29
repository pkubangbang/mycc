/**
 * session-file-collision.test.ts — regression suite for the
 * `session-{id}.json` EXCLUSIVE-CREATE guard in src/session/index.ts.
 *
 * HISTORY / WHY: `createSessionFile()` used a bare
 * `fs.writeFileSync(filePath, JSON.stringify(session, …))` over
 * `session-{id}.json`. A collision (two same-instant starts minting the same
 * randomUUID — ~2^-122, but possible; a stale caller-supplied id pointing at
 * an EXISTING session dir — the realistic path) would SILENTLY CLOBBER the
 * previous session's metadata (id, triologue paths, teammates, first_query)
 * out from under its owner process. The lead triologue already defends the
 * same failure mode with `fs.openSync(candidate, 'wx')` + a suffix ladder
 * (see fresh-session-files.test.ts); this suite pins the parity guard on the
 * session json itself:
 *
 * 1. caller-supplied id over an existing session → `SessionExistsError`
 *    (never overwrite, never silently regenerate an explicit id), and the
 *    pre-existing file is left BYTE-IDENTICAL;
 * 2. the pair ({triologue, session json} colocated under ONE fresh dir) is
 *    regenerated whole — via a mocked randomUUID sequence — when the session
 *    json slot is taken, and the abandoned empty triologue is unlinked so
 *    the colliding dir keeps only its own content;
 * 3. a normal fresh start still colocates both files under the minted dir
 *    and leaves no orphan (guard does not disturb the happy path).
 *
 * SEAMS: everything runs under a temp cwd (the session module resolves
 * `.mycc/...` against process.cwd() at call time), so NO real-tree path is
 * touched. randomUUID is mocked via vi.mock('crypto') — src/session/index.ts
 * binds `import { randomUUID } from 'crypto'` at module load, which vitest
 * redirects into the mock BEFORE the SUT import resolves.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Deterministic randomUUID sequence, driven per-test via `uuidQueue`.
// Node's `crypto` module is mapped to `node:crypto`, i.e. `import { randomUUID }
// from 'crypto'` in src/session/index.ts resolves to the CJS/ESM interop
// surface BELOW — a plain object spread (NOT an ESM namespace object, whose
// properties are read-only), so the property patch here is honored by the SUT.
let uuidQueue: string[] = [];

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomUUID: vi.fn(() => uuidQueue.shift() ?? 'fallback-never-used-uuid'),
  };
});

type SessionMod = typeof import('../../session/index.js');

let projectTmp = '';
let prevCwd = '';

/** Import the session module AFTER the cwd override. */
async function loadSession(): Promise<SessionMod> {
  return import('../../session/index.js');
}

beforeEach(() => {
  prevCwd = process.cwd();
  projectTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-sess-coll-'));
  process.chdir(projectTmp);
  uuidQueue = [];
});

afterEach(() => {
  process.chdir(prevCwd);
  // NOTE: no vi.restoreAllMocks here — the crypto mock is MODULE-level (vi.mock
  // factory); restoring it would clear the randomUUID implementation the SUT
  // binds at import time. Per-test isolation is done via `uuidQueue` reset in
  // beforeEach instead.
  try {
    fs.rmSync(projectTmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

const SESSION_FILE_FIELDS = [
  'version',
  'id',
  'create_time',
  'project_dir',
  'lead_triologue',
  'child_triologues',
  'teammates',
  'first_query',
] as const;

/** Materialize a PRE-EXISTING session dir + file for `id` with a canary. */
function seedExistingSession(sess: SessionMod, id: string): void {
  const sessionsDir = path.join(projectTmp, '.mycc', 'sessions');
  const dir = path.join(sessionsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const existing: Record<string, unknown> = {
    version: '2.0',
    id,
    create_time: '2026-01-01T00:00:00.000Z',
    project_dir: '/canonical/owner/dir',
    lead_triologue: '/canonical/owner/transcript.jsonl',
    child_triologues: ['/canonical/owner/child.jsonl'],
    teammates: ['canary-teammate'],
    first_query: 'canary query that must survive a collision',
  };
  // Bare write is FINE here: this seeds the collision partner, it does not
  // exercise the SUT.
  fs.writeFileSync(path.join(dir, `session-${id}.json`), JSON.stringify(existing, null, 2), 'utf-8');
  void sess; // the type import keeps the SUT binding explicit
}

describe('createSessionFile: caller-supplied id over an existing session (never overwrite)', () => {
  it('rejects with SessionExistsError and leaves the existing file byte-identical', async () => {
    const sess = await loadSession();
    seedExistingSession(sess, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');

    const filePath = path.join(projectTmp, '.mycc', 'sessions', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json');
    const before = fs.readFileSync(filePath, 'utf-8');

    // The caller explicitly names an id whose session file already exists:
    // the OLD code silently overwrote it; the guard must fail loudly instead.
    let caught: unknown;
    try {
      sess.createSessionFile('/new/start.jsonl', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('SessionExistsError');
    expect((caught as Error).message).toContain('already exists');
    expect(sess.SessionExistsError).toBeDefined(); // exported typed error
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(before); // BYTE-IDENTICAL — no clobber
  });

  it('preserves every field of the canary session (structured no-clobber proof)', async () => {
    const sess = await loadSession();
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    seedExistingSession(sess, id);

    const sessionFile = path.join(projectTmp, '.mycc', 'sessions', id, `session-${id}.json`);
    // Snapshot the seeded session BEFORE the colliding call: the only honest
    // no-clobber proof is surviving-vs-before, not surviving-vs-itself.
    const before = JSON.parse(fs.readFileSync(sessionFile, 'utf-8')) as Record<string, unknown>;

    let caught: unknown;
    try {
      sess.createSessionFile('/new/start.jsonl', id);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('SessionExistsError');

    const surviving = JSON.parse(fs.readFileSync(sessionFile, 'utf-8')) as Record<string, unknown>;
    for (const field of SESSION_FILE_FIELDS) {
      expect(surviving[field], `field ${field} was clobbered`).toEqual(before[field]);
    }
    expect(surviving.teammates).toEqual(['canary-teammate']);
    expect(surviving.first_query).toBe('canary query that must survive a collision');
    expect(surviving.lead_triologue).toBe('/canonical/owner/transcript.jsonl');
  });
});

describe('writeFreshSessionFiles: pair regeneration when the session json slot is taken', () => {
  it('regenerates the WHOLE pair under a fresh id and unlinks the abandoned triologue', async () => {
    const sess = await loadSession();

    // Attempt 1: randomUUID mints the COLLIDING id (a pre-existing session
    // already owns `session-<id1>.json`). Attempt 2: a fresh id — the pair
    // loop must regenerate and land here.
    const collidingId = '11111111-2222-4333-8444-555555555555';
    uuidQueue = [collidingId, '66666666-7777-4888-8999-aaaa00000001'];
    seedExistingSession(sess, collidingId);

    const collidingDir = path.join(projectTmp, '.mycc', 'sessions', collidingId);
    const before = fs.readFileSync(path.join(collidingDir, `session-${collidingId}.json`), 'utf-8');

    const { sessionFilePath, triologuePath } = sess.createNewSession();

    // The pair landed under the FRESH id, fully colocated.
    const sessionJson = JSON.parse(fs.readFileSync(sessionFilePath, 'utf-8'));
    expect(sessionJson.id).toBe('66666666-7777-4888-8999-aaaa00000001');
    expect(path.dirname(sessionFilePath)).toBe(path.dirname(triologuePath));
    expect(path.dirname(triologuePath)).toContain('66666666-7777-4888-8999-aaaa00000001');

    // The pre-existing session is untouched: same bytes, and the ONLY
    // triologue residue in its dir is the one WE seeded (none beyond that).
    const collidingJson = JSON.parse(fs.readFileSync(path.join(collidingDir, `session-${collidingId}.json`), 'utf-8'));
    expect(collidingJson.first_query).toBe('canary query that must survive a collision');
    expect(fs.readFileSync(path.join(collidingDir, `session-${collidingId}.json`), 'utf-8')).toBe(before);
    const residue = fs.readdirSync(collidingDir).filter((f) => f.startsWith('triologue-lead-'));
    expect(residue).toEqual([]); // abandoned empty triologue was UNLINKED

    // The minted dir holds both files of the pair.
    const mintedDirFiles = fs.readdirSync(path.dirname(triologuePath));
    expect(mintedDirFiles.some((f) => f.startsWith('triologue-lead-'))).toBe(true);
    expect(mintedDirFiles).toContain(path.basename(sessionFilePath));
  });

  it('keeps triologue and session json colocated on the happy path (guard disturbs nothing)', async () => {
    const sess = await loadSession();

    const { sessionFilePath, triologuePath } = sess.createNewSession();

    expect(fs.existsSync(triologuePath)).toBe(true);
    expect(fs.existsSync(sessionFilePath)).toBe(true);
    expect(path.dirname(triologuePath)).toBe(path.dirname(sessionFilePath));
    const sessionJson = JSON.parse(fs.readFileSync(sessionFilePath, 'utf-8'));
    expect(sessionJson.lead_triologue).toBe(triologuePath); // the json POINTS at its triologue
    expect(sessionJson.id).toBe(path.basename(path.dirname(sessionFilePath)));
  });
});