/**
 * Regression tests for session-ID resolution in findSessionPaths /
 * loadSessionById (src/session/index.ts).
 *
 * Background — session-management (dir-7) Bug 3 ("findSessionMatches bare
 * startsWith prefix ambiguity"): the original finding flagged a bare
 * `dir.startsWith(id)` prefix match that let a short prefix resolve to
 * multiple session directories, producing ambiguous `/load` candidates.
 * Inspection of the current source showed the ambiguity is ALREADY handled
 * (exact match returns first; multiple partial matches throw
 * AmbiguousSessionError with the candidate list), but that behavior had ZERO
 * test coverage. These tests lock the current correct resolution semantics so
 * a regression to the bare-startsWith ambiguity is caught:
 *   1. exact match returns a single match (user session shadows project);
 *   2. a unique partial prefix (>=6 chars) resolves to one session;
 *   3. an ambiguous partial prefix (matches multiple) throws
 *      AmbiguousSessionError carrying every candidate;
 *   4. no match throws SessionNotFoundError;
 *   5. a partial prefix shorter than 6 chars does NOT trigger partial scan
 *      (the id.length >= 6 gate) — it reports not-found rather than scanning.
 *
 * Isolation: os.homedir() is mocked to a temp dir so getUserSessionsDir()
 * (~/.mycc-store/sessions) lands inside the temp tree, and the test chdir's
 * into a temp project so getSessionsDir() (.mycc/sessions, cwd-relative)
 * lands there too. Nothing touches the real ~/.mycc-store or the real
 * project's .mycc/sessions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Holder object read by the HOISTED vi.mock factory below. vi.mock is
// hoisted above every let/const declaration, so the factory cannot close
// over a plain `const tmp = {}` (temporal dead zone at call time during
// transitive imports). vi.hoisted() runs the initializer at the top of
// the module, before any import, so the holder is live when the mocked
// homedir() is first called.
const tmp = vi.hoisted(() => ({ home: '', project: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    // Redirect getUserSessionsDir() (~/.mycc-store/sessions) into the temp
    // home so the test never touches the real user session store.
    homedir: () => tmp.home,
  };
});

// Import AFTER the mock is registered.
import {
  findSessionPaths,
  loadSessionById,
  SessionNotFoundError,
  AmbiguousSessionError,
} from '../../session/index.js';

/** Write a valid session directory + session-{id}.json under a sessions root. */
function writeSession(sessionsRoot: string, id: string): string {
  const dir = path.join(sessionsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  const session = {
    version: '2.0',
    id,
    create_time: new Date().toISOString(),
    project_dir: tmp.project,
    lead_triologue: path.join(dir, 'triologue-lead.jsonl'),
    child_triologues: [],
    teammates: [],
    first_query: 'test query',
  };
  const file = path.join(dir, `session-${id}.json`);
  fs.writeFileSync(file, JSON.stringify(session), 'utf-8');
  fs.writeFileSync(path.join(dir, 'triologue-lead.jsonl'), '', 'utf-8');
  return file;
}

const projectSessionsDir = () => path.join(tmp.project, '.mycc', 'sessions');
const userSessionsDir = () => path.join(tmp.home, '.mycc-store', 'sessions');

let originalCwd = '';

beforeEach(() => {
  tmp.home = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-sess-home-'));
  tmp.project = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-sess-proj-'));
  for (const d of [projectSessionsDir(), userSessionsDir()]) {
    fs.mkdirSync(d, { recursive: true });
  }
  originalCwd = process.cwd();
  process.chdir(tmp.project);
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;
  try { fs.rmSync(tmp.home, rmOpts); } catch { /* best-effort */ }
  try { fs.rmSync(tmp.project, rmOpts); } catch { /* best-effort */ }
});

describe('findSessionPaths / loadSessionById resolution', () => {
  it('exact match returns a single match (project session)', () => {
    const id = 'aa11aa11-bb22-cc33-dd44-ee55ff660077';
    writeSession(projectSessionsDir(), id);

    const matches = findSessionPaths(id);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(id);
    expect(matches[0].source).toBe('project');
    // getSessionsDir() is cwd-relative (".mycc/sessions"), so the returned
    // path is relative — join the relative dir with the id to match.
    expect(matches[0].path).toBe(path.join('.mycc', 'sessions', id, `session-${id}.json`));
  });

  it('exact match: a user session shadows a project session with the same id', () => {
    const id = 'bb22bb22-cc33-dd44-ee55-ff6677880011';
    writeSession(projectSessionsDir(), id);
    writeSession(userSessionsDir(), id);

    const matches = findSessionPaths(id);
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe('user');
    expect(matches[0].path).toBe(path.join(userSessionsDir(), id, `session-${id}.json`));
  });

  it('a unique partial prefix (>=6 chars) resolves to one session', () => {
    const id = 'cc33cc33-dd44-ee55-ff66-011223344556';
    writeSession(projectSessionsDir(), id);
    const prefix = id.slice(0, 8); // 8-char unique prefix

    const matches = findSessionPaths(prefix);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(id);
  });

  it('an ambiguous partial prefix throws AmbiguousSessionError with every candidate', () => {
    // Two session ids sharing a common 8-char prefix → the prefix is ambiguous.
    const idA = 'dd44dd44-0000-0000-0000-000000000001';
    const idB = 'dd44dd44-0000-0000-0000-000000000002';
    writeSession(projectSessionsDir(), idA);
    writeSession(projectSessionsDir(), idB);
    const prefix = idA.slice(0, 8); // matches both

    const matches = findSessionPaths(prefix);
    expect(matches).toHaveLength(2);
    const ids = matches.map((m) => m.id).sort();
    expect(ids).toEqual([idA, idB].sort());

    // loadSessionById surfaces the ambiguity as a typed error carrying the list.
    expect(() => loadSessionById(prefix)).toThrow(AmbiguousSessionError);
    try {
      loadSessionById(prefix);
      throw new Error('expected AmbiguousSessionError');
    } catch (err) {
      if (!(err instanceof AmbiguousSessionError)) throw err;
      expect(err.sessionId).toBe(prefix);
      expect(err.matches).toHaveLength(2);
    }
  });

  it('a partial prefix shorter than 6 chars does NOT scan (id.length >= 6 gate)', () => {
    // The partial-match branch is gated on id.length >= 6. A shorter prefix
    // that WOULD match multiple sessions returns no candidates instead of
    // scanning — so it reports SessionNotFoundError, not AmbiguousSessionError.
    // This documents the current gate behavior (a deliberate guard against
    // absurdly short prefixes matching everything).
    const idA = 'ee55ee55-0000-0000-0000-000000000001';
    const idB = 'ee55ee55-0000-0000-0000-000000000002';
    writeSession(projectSessionsDir(), idA);
    writeSession(projectSessionsDir(), idB);
    const shortPrefix = idA.slice(0, 4); // 4 chars — below the gate

    expect(findSessionPaths(shortPrefix)).toEqual([]);
    expect(() => loadSessionById(shortPrefix)).toThrow(SessionNotFoundError);
  });

  it('no match throws SessionNotFoundError', () => {
    writeSession(projectSessionsDir(), 'ff66ff66-0000-0000-0000-000000000099');
    const missing = 'not-a-real-session-id-00000000';

    expect(findSessionPaths(missing)).toEqual([]);
    expect(() => loadSessionById(missing)).toThrow(SessionNotFoundError);
  });

  it('partial match: a user session shadows a project session with the same id', () => {
    // The partial-match branch dedups by id so a session present in BOTH
    // stores is reported once, as the user copy (user shadows project).
    const id = '00770077-aaaa-bbbb-cccc-ddddeeeeffff';
    writeSession(projectSessionsDir(), id);
    writeSession(userSessionsDir(), id);
    const prefix = id.slice(0, 8);

    const matches = findSessionPaths(prefix);
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe('user');
  });

  it('partial match aggregates across user and project stores with distinct ids', () => {
    // Same prefix, different ids in different stores → two distinct candidates
    // (no dedup, since the ids differ).
    const idUser = '11221122-0000-0000-0000-000000000001';
    const idProj = '11221122-0000-0000-0000-000000000002';
    writeSession(userSessionsDir(), idUser);
    writeSession(projectSessionsDir(), idProj);
    const prefix = idUser.slice(0, 8);

    const matches = findSessionPaths(prefix);
    expect(matches).toHaveLength(2);
    const sources = matches.map((m) => m.source).sort();
    expect(sources).toEqual(['project', 'user']);
  });
});