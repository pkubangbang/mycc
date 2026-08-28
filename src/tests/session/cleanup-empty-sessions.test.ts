/**
 * Regression tests for the live-session deletion guard in
 * cleanupEmptySessions (src/session/index.ts).
 *
 * Root cause being guarded against: daemon sessions never record a
 * first_query (daemons skip the interactive PROMPT state), so once a live
 * daemon session is older than 1 minute it matched the "empty session"
 * cleanup predicate and its ENTIRE session directory — mailbox, triologue,
 * progress state — was deleted by the NEXT session that started in the same
 * project. The daemon kept running deaf: cron nudges appended to a mailbox
 * path that no longer existed.
 *
 * The fix (two layers):
 * 1. cleanupEmptySessions checks the session's heartbeat file
 *    (~/.mycc-store/discovery/heartbeat/{id}.json) before deleting: a latest
 *    beat within the freshness window (90s) marks the session as owned by a
 *    live process and the directory is preserved.
 * 2. Bootstrap-auto sessions (--auto / --daemon) are seeded with
 *    HEADLESS_FIRST_QUERY_MARKER in first_query (markHeadlessSession), so
 *    the cleanup predicate `!session.first_query` categorically excludes
 *    them — no heartbeat timing involved. resolveHeadlessFirstQuery later
 *    replaces the marker with the real first query (first mail / steering
 *    note processed at COLLECT).
 *
 * These tests exercise the REAL cleanupEmptySessions against the REAL
 * heartbeat discovery dir (~/.mycc-store/discovery/heartbeat). Session dirs
 * are created under a temp cwd (.mycc/sessions) via chdir, and heartbeat
 * files are created/removed for throwaway UUIDs only — never for a real
 * running session.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanupEmptySessions, markHeadlessSession, resolveHeadlessFirstQuery, HEADLESS_FIRST_QUERY_MARKER } from '../../session/index.js';

const PROJECT_TMP = path.join(os.tmpdir(), `mycc-cleanup-test-${Date.now()}-${process.pid}`);
const USER_TMP = path.join(os.tmpdir(), `mycc-cleanup-user-${Date.now()}-${process.pid}`);
const HEARTBEAT_DIR = path.join(os.homedir(), '.mycc-store', 'discovery', 'heartbeat');

/** Created heartbeat files that must be removed after the run. */
const heartbeatFiles: string[] = [];

afterAll(() => {
  for (const f of heartbeatFiles) {
    try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ }
  }
  // Windows: the temp dirs can still hold an open handle for a moment
  // (EPERM) — retry with backoff instead of failing the run.
  const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;
  try { fs.rmSync(PROJECT_TMP, rmOpts); } catch { /* best-effort */ }
  try { fs.rmSync(USER_TMP, rmOpts); } catch { /* best-effort */ }
});

/** Session file with NO first_query (the daemon-session signature). */
function makeEmptySession(sessionsRoot: string, id: string, createdMinutesAgo: number, firstQuery = ''): void {
  const dir = path.join(sessionsRoot, '.mycc', 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const session = {
    version: '2.0',
    id,
    create_time: new Date(Date.now() - createdMinutesAgo * 60_000).toISOString(),
    project_dir: process.cwd(),
    lead_triologue: path.join(dir, `triologue-lead.jsonl`),
    child_triologues: [],
    teammates: [],
    first_query: firstQuery,
  };
  fs.writeFileSync(path.join(dir, `session-${id}.json`), JSON.stringify(session), 'utf-8');
  fs.writeFileSync(path.join(dir, 'triologue-lead.jsonl'), '', 'utf-8');
}

function writeHeartbeat(id: string, ageMs: number): void {
  fs.mkdirSync(HEARTBEAT_DIR, { recursive: true });
  const file = path.join(HEARTBEAT_DIR, `${id}.json`);
  const data = { heartbeats: [Date.now() - ageMs], briefs: [] };
  fs.writeFileSync(file, JSON.stringify(data), 'utf-8');
  heartbeatFiles.push(file);
}

describe('cleanupEmptySessions live-session guard', () => {
  it('preserves a live daemon session (fresh heartbeat, empty first_query)', () => {
    fs.mkdirSync(path.join(PROJECT_TMP, '.mycc', 'sessions'), { recursive: true });
    const id = `liveguard-${Date.now()}`;
    makeEmptySession(PROJECT_TMP, id, 30); // 30 min old — would be deleted pre-fix
    writeHeartbeat(id, 10_000); // beat 10s ago → live

    chdirTo(PROJECT_TMP);
    const removed = cleanupEmptySessions('some-other-current-session');
    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(PROJECT_TMP, '.mycc', 'sessions', id, `session-${id}.json`))).toBe(true);
    // Session dir must still contain its files (mailbox/trilogue survive).
    expect(fs.existsSync(path.join(PROJECT_TMP, '.mycc', 'sessions', id, 'triologue-lead.jsonl'))).toBe(true);
  });

  it('removes an empty session older than 1 min with a STALE heartbeat', () => {
    fs.mkdirSync(path.join(PROJECT_TMP, '.mycc', 'sessions'), { recursive: true });
    const id = `staleguard-${Date.now()}`;
    makeEmptySession(PROJECT_TMP, id, 30);
    writeHeartbeat(id, 10 * 60_000); // beat 10 min ago → dead

    chdirTo(PROJECT_TMP);
    const removed = cleanupEmptySessions('some-other-current-session');
    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(PROJECT_TMP, '.mycc', 'sessions', id))).toBe(false);
  });

  it('removes an empty session with NO heartbeat file at all', () => {
    fs.mkdirSync(path.join(PROJECT_TMP, '.mycc', 'sessions'), { recursive: true });
    const id = `nohb-${Date.now()}`;
    makeEmptySession(PROJECT_TMP, id, 30);
    // No heartbeat file written.

    chdirTo(PROJECT_TMP);
    const removed = cleanupEmptySessions('some-other-current-session');
    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(PROJECT_TMP, '.mycc', 'sessions', id))).toBe(false);
  });

  it('still skips sessions created within the last minute (unchanged behavior)', () => {
    fs.mkdirSync(path.join(PROJECT_TMP, '.mycc', 'sessions'), { recursive: true });
    const id = `recent-${Date.now()}`;
    makeEmptySession(PROJECT_TMP, id, 0); // created just now

    chdirTo(PROJECT_TMP);
    const removed = cleanupEmptySessions('some-other-current-session');
    expect(removed).toBe(0);
  });
});

describe('HEADLESS_FIRST_QUERY_MARKER lifecycle', () => {
  it('preserves a bootstrap-auto (marker) session even with a STALE heartbeat', () => {
    // The categorical exclusion: the marker alone must protect the session,
    // independent of heartbeat liveness (covers a heartbeat write hiccup
    // >90s on a LIVE daemon/auto session, and leaves dead headless
    // sessions as archives — same semantics as interactive sessions).
    fs.mkdirSync(path.join(PROJECT_TMP, '.mycc', 'sessions'), { recursive: true });
    const id = `marker-${Date.now()}`;
    makeEmptySession(PROJECT_TMP, id, 30, HEADLESS_FIRST_QUERY_MARKER);
    writeHeartbeat(id, 10 * 60_000); // beat 10 min ago → dead, marker still protects

    chdirTo(PROJECT_TMP);
    const removed = cleanupEmptySessions('some-other-current-session');
    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(PROJECT_TMP, '.mycc', 'sessions', id, `session-${id}.json`))).toBe(true);
  });

  it('markHeadlessSession seeds the marker into an empty session', () => {
    const id = `mark-${Date.now()}`;
    const dir = path.join(USER_TMP, id);
    fs.mkdirSync(dir, { recursive: true });
    const sessionPath = path.join(dir, `session-${id}.json`);
    const session = {
      version: '2.0',
      id,
      create_time: new Date().toISOString(),
      project_dir: process.cwd(),
      lead_triologue: path.join(dir, 'triologue-lead.jsonl'),
      child_triologues: [],
      teammates: [],
      first_query: '',
    };
    fs.writeFileSync(sessionPath, JSON.stringify(session), 'utf-8');

    expect(markHeadlessSession(sessionPath)).toBe(true);
    const after = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    expect(after.first_query).toBe(HEADLESS_FIRST_QUERY_MARKER);
  });

  it('markHeadlessSession no-ops when first_query is already set', () => {
    const id = `markkeep-${Date.now()}`;
    const dir = path.join(USER_TMP, id);
    fs.mkdirSync(dir, { recursive: true });
    const sessionPath = path.join(dir, `session-${id}.json`);
    const session = {
      version: '2.0',
      id,
      create_time: new Date().toISOString(),
      project_dir: process.cwd(),
      lead_triologue: path.join(dir, 'triologue-lead.jsonl'),
      child_triologues: [],
      teammates: [],
      first_query: 'a real user query',
    };
    fs.writeFileSync(sessionPath, JSON.stringify(session), 'utf-8');

    expect(markHeadlessSession(sessionPath)).toBe(false);
    const after = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    expect(after.first_query).toBe('a real user query');
  });

  it('markHeadlessSession no-ops on a missing session file', () => {
    const id = `markmiss-${Date.now()}`;
    const missing = path.join(USER_TMP, id, `session-${id}.json`);
    expect(markHeadlessSession(missing)).toBe(false);
  });

  it('resolveHeadlessFirstQuery writes into an empty first_query (interactive capture path)', () => {
    // Empty first_query → written directly (the interactive bookmark capture
    // in prompt.ts relies on this branch — a plain interactive session has no
    // marker, only a missing/empty first_query).
    const id = `resolveempty-${Date.now()}`;
    const dir = path.join(USER_TMP, id);
    fs.mkdirSync(dir, { recursive: true });
    const sessionPath = path.join(dir, `session-${id}.json`);
    const session = {
      version: '2.0',
      id,
      create_time: new Date().toISOString(),
      project_dir: process.cwd(),
      lead_triologue: path.join(dir, 'triologue-lead.jsonl'),
      child_triologues: [],
      teammates: [],
      first_query: '',
    };
    fs.writeFileSync(sessionPath, JSON.stringify(session), 'utf-8');

    expect(resolveHeadlessFirstQuery(sessionPath, 'x'.repeat(150))).toBe(true);
    const after = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    expect(after.first_query).toBe('x'.repeat(100));
  });

  it('resolveHeadlessFirstQuery replaces only the marker, never a real query', () => {
    // Marker → replaced with the real first event text (truncated to 100).
    const idA = `resolve-${Date.now()}`;
    const dirA = path.join(USER_TMP, idA);
    fs.mkdirSync(dirA, { recursive: true });
    const pathA = path.join(dirA, `session-${idA}.json`);
    const sessionA = {
      version: '2.0',
      id: idA,
      create_time: new Date().toISOString(),
      project_dir: process.cwd(),
      lead_triologue: path.join(dirA, 'triologue-lead.jsonl'),
      child_triologues: [],
      teammates: [],
      first_query: HEADLESS_FIRST_QUERY_MARKER,
    };
    fs.writeFileSync(pathA, JSON.stringify(sessionA), 'utf-8');

    expect(resolveHeadlessFirstQuery(pathA, 'x'.repeat(150))).toBe(true);
    const afterA = JSON.parse(fs.readFileSync(pathA, 'utf-8'));
    expect(afterA.first_query).toBe('x'.repeat(100));

    // Real query → untouched.
    const idB = `resolvekeep-${Date.now()}`;
    const dirB = path.join(USER_TMP, idB);
    fs.mkdirSync(dirB, { recursive: true });
    const pathB = path.join(dirB, `session-${idB}.json`);
    const sessionB = {
      version: '2.0',
      id: idB,
      create_time: new Date().toISOString(),
      project_dir: process.cwd(),
      lead_triologue: path.join(dirB, 'triologue-lead.jsonl'),
      child_triologues: [],
      teammates: [],
      first_query: 'genuine first query',
    };
    fs.writeFileSync(pathB, JSON.stringify(sessionB), 'utf-8');

    expect(resolveHeadlessFirstQuery(pathB, 'later event')).toBe(false);
    const afterB = JSON.parse(fs.readFileSync(pathB, 'utf-8'));
    expect(afterB.first_query).toBe('genuine first query');
  });
});

/** cleanupEmptySessions reads ./  .mycc/sessions relative to cwd. */
function chdirTo(dir: string): void {
  process.chdir(dir);
}