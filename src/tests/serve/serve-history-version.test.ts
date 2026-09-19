/**
 * serve-history-version.test.ts - unit tests for computeHistoryVersion() ETag
 *
 * Covers the PURE content-derived weak ETag that /history sends for
 * If-None-Match revalidation. The only impurity is `fs.statSync` (mtimeMs/
 * size), exercised here against temp-dir fixtures so the file fingerprints
 * are real. Everything else is a pure function of the arguments.
 *
 * Key invariants under test:
 *  - Output shape is a weak ETag `W/"h<hex>"`.
 *  - Identical inputs → identical ETag (deterministic).
 *  - A durable file change (mtime/size) flips the ETag.
 *  - The transient fields (steering-length, isRunning, messageLog tail) flip
 *    the ETag — the core reason they are folded in (a 304 must never mask a
 *    state flip that lives in the body but not in the durable files).
 *  - A missing file yields a stable "null" token (no needless invalidation).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeHistoryVersion, etagMatchesIfNoneMatch } from '../../serve/serve-history.js';
import type { LogEntry } from '../../serve/serve-types.js';

const WEAK_ETAG_RE = /^W\/"h[0-9a-f]+"$/;

describe('computeHistoryVersion — shape', () => {
  it('produces a weak ETag of the form W/"h<hex>"', () => {
    const etag = computeHistoryVersion(null, null, [], 0, false);
    expect(etag).toMatch(WEAK_ETAG_RE);
  });

  it('is deterministic — identical inputs yield identical ETags', () => {
    const a = computeHistoryVersion(null, null, [], 0, false);
    const b = computeHistoryVersion(null, null, [], 0, false);
    expect(a).toBe(b);
  });
});

describe('computeHistoryVersion — durable file fingerprints', () => {
  let tmpDir: string;
  let transcriptPath: string;
  let userLogPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-version-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    userLogPath = path.join(tmpDir, 'user.log');
    fs.writeFileSync(transcriptPath, '{}\n', 'utf-8');
    fs.writeFileSync(userLogPath, '{}\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flips when the transcript file changes (size/mtime)', () => {
    const before = computeHistoryVersion(transcriptPath, userLogPath, [], 0, false);
    // Bump mtime + size by appending content. Use a small sleep so mtimeMs
    // actually moves (some filesystems have ms resolution but race on tight
    // loops); the size change alone also flips the fingerprint.
    fs.appendFileSync(transcriptPath, '{"role":"assistant","content":"more"}\n', 'utf-8');
    const after = computeHistoryVersion(transcriptPath, userLogPath, [], 0, false);
    expect(after).not.toBe(before);
  });

  it('flips when the user-log file changes', () => {
    const before = computeHistoryVersion(transcriptPath, userLogPath, [], 0, false);
    fs.appendFileSync(userLogPath, '{"type":"user","content":"hi"}\n', 'utf-8');
    const after = computeHistoryVersion(transcriptPath, userLogPath, [], 0, false);
    expect(after).not.toBe(before);
  });

  it('is stable when no file changed (same stat → same ETag)', () => {
    const a = computeHistoryVersion(transcriptPath, userLogPath, [], 0, false);
    const b = computeHistoryVersion(transcriptPath, userLogPath, [], 0, false);
    expect(a).toBe(b);
  });

  it('a missing file yields a stable token (does not vary across calls)', () => {
    const a = computeHistoryVersion(transcriptPath, null, [], 0, false);
    const b = computeHistoryVersion(transcriptPath, null, [], 0, false);
    expect(a).toBe(b);
    // And differs from the both-files-present fingerprint (the null slot is
    // not a zero stat).
    const both = computeHistoryVersion(transcriptPath, userLogPath, [], 0, false);
    expect(a).not.toBe(both);
  });

  it('a deleted file flips the ETag (present → missing)', () => {
    const present = computeHistoryVersion(transcriptPath, userLogPath, [], 0, false);
    fs.unlinkSync(userLogPath);
    const missing = computeHistoryVersion(transcriptPath, userLogPath, [], 0, false);
    expect(missing).not.toBe(present);
  });
});

describe('computeHistoryVersion — transient fields (must flip the ETag)', () => {
  let tmpDir: string;
  let transcriptPath: string;
  let userLogPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-version-tr-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    userLogPath = path.join(tmpDir, 'user.log');
    fs.writeFileSync(transcriptPath, '{}\n', 'utf-8');
    fs.writeFileSync(userLogPath, '{}\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flips when the steering queue length changes', () => {
    const a = computeHistoryVersion(transcriptPath, userLogPath, [], 0, false);
    const b = computeHistoryVersion(transcriptPath, userLogPath, [], 2, false);
    expect(b).not.toBe(a);
  });

  it('flips when isRunning changes', () => {
    const a = computeHistoryVersion(transcriptPath, userLogPath, [], 0, false);
    const b = computeHistoryVersion(transcriptPath, userLogPath, [], 0, true);
    expect(b).not.toBe(a);
  });

  it('flips when the messageLog length changes (tail grows)', () => {
    const log: LogEntry[] = [{ type: 'log', content: 'a', timestamp: 1 }];
    const a = computeHistoryVersion(transcriptPath, userLogPath, log, 0, false);
    log.push({ type: 'log', content: 'b', timestamp: 2 });
    const b = computeHistoryVersion(transcriptPath, userLogPath, log, 0, false);
    expect(b).not.toBe(a);
  });

  it('flips when the messageLog last timestamp changes (same length)', () => {
    const logA: LogEntry[] = [{ type: 'log', content: 'a', timestamp: 1 }];
    const logB: LogEntry[] = [{ type: 'log', content: 'a', timestamp: 99 }];
    const a = computeHistoryVersion(transcriptPath, userLogPath, logA, 0, false);
    const b = computeHistoryVersion(transcriptPath, userLogPath, logB, 0, false);
    expect(b).not.toBe(a);
  });

  it('an empty messageLog is stable (no spurious flips from a zero tail)', () => {
    const a = computeHistoryVersion(transcriptPath, userLogPath, [], 0, false);
    const b = computeHistoryVersion(transcriptPath, userLogPath, [], 0, false);
    expect(a).toBe(b);
  });

  it('a messageLog entry without a timestamp contributes a 0 tail (stable)', () => {
    const log: LogEntry[] = [{ type: 'log', content: 'a' /* no timestamp */ }];
    const a = computeHistoryVersion(transcriptPath, userLogPath, log, 0, false);
    const b = computeHistoryVersion(transcriptPath, userLogPath, log, 0, false);
    expect(a).toBe(b);
  });
});

describe('computeHistoryVersion — combined input independence', () => {
  it('two distinct input sets produce distinct ETags', () => {
    const a = computeHistoryVersion(null, null, [], 0, false);
    const b = computeHistoryVersion(null, null, [], 1, true);
    const c = computeHistoryVersion(null, null, [{ type: 'log', content: 'x', timestamp: 5 }], 1, true);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });
});

describe('etagMatchesIfNoneMatch — RFC 7232 §3.2 (If-None-Match)', () => {
  // The /history handler uses this instead of manual `===` equality so the
  // conditional handles multi-tag headers, the `*` wildcard, and weak vs
  // strong equivalent tags per RFC 7232. The server always emits weak tags
  // of the form W/"h<hex>".
  const CURRENT = 'W/"h1a2b3c"';

  it('no header → false (no precondition → not 304)', () => {
    expect(etagMatchesIfNoneMatch(undefined, CURRENT)).toBe(false);
    expect(etagMatchesIfNoneMatch(null, CURRENT)).toBe(false);
    expect(etagMatchesIfNoneMatch('', CURRENT)).toBe(false);
    expect(etagMatchesIfNoneMatch('   ', CURRENT)).toBe(false);
  });

  it('exact single-tag match (same weak tag) → true', () => {
    expect(etagMatchesIfNoneMatch('W/"h1a2b3c"', CURRENT)).toBe(true);
  });

  it('strong-vs-weak equivalent tag → true (weak comparison ignores W/)', () => {
    // RFC 7232 §2.3.2: If-None-Match uses weak comparison, so a strong tag
    // (no W/) and a weak tag (W/) with the same opaque-tag are equivalent.
    expect(etagMatchesIfNoneMatch('"h1a2b3c"', CURRENT)).toBe(true);
  });

  it('a non-matching single tag → false', () => {
    expect(etagMatchesIfNoneMatch('W/"hdeadbeef"', CURRENT)).toBe(false);
    expect(etagMatchesIfNoneMatch('"hdeadbeef"', CURRENT)).toBe(false);
  });

  it('`*` wildcard → true (matches any current representation)', () => {
    expect(etagMatchesIfNoneMatch('*', CURRENT)).toBe(true);
    expect(etagMatchesIfNoneMatch(' * ', CURRENT)).toBe(true);
  });

  it('multi-tag header: the matching tag is in the list → true', () => {
    // The prior `inm === etag` equality would have FAILED here (the whole
    // header string !== the single current ETag). RFC 7232 says 304 if ANY
    // listed tag matches.
    expect(etagMatchesIfNoneMatch('"foo", W/"h1a2b3c"', CURRENT)).toBe(true);
    expect(etagMatchesIfNoneMatch('W/"h1a2b3c", "bar"', CURRENT)).toBe(true);
    expect(etagMatchesIfNoneMatch('"a", "b", W/"h1a2b3c", "d"', CURRENT)).toBe(true);
  });

  it('multi-tag header: none match → false', () => {
    expect(etagMatchesIfNoneMatch('"foo", W/"bar", "baz"', CURRENT)).toBe(false);
  });

  it('whitespace around tags in a multi-tag list is tolerated', () => {
    expect(etagMatchesIfNoneMatch('"foo" , W/"h1a2b3c" , "bar"', CURRENT)).toBe(true);
  });

  it('a malformed current ETag → false (never 304 on a bad server tag)', () => {
    expect(etagMatchesIfNoneMatch('W/"h1a2b3c"', 'not-a-valid-etag')).toBe(false);
    expect(etagMatchesIfNoneMatch('W/"h1a2b3c"', 'W/unterminated')).toBe(false);
  });

  it('malformed tokens in the header are skipped, valid ones still matched', () => {
    // A bare unquoted token is not a valid entity-tag; it is skipped, but a
    // later valid matching token still yields 304.
    expect(etagMatchesIfNoneMatch('bogus, W/"h1a2b3c"', CURRENT)).toBe(true);
    expect(etagMatchesIfNoneMatch('bogus, nope', CURRENT)).toBe(false);
  });

  it('round-trips with a real computeHistoryVersion ETag', () => {
    const etag = computeHistoryVersion(null, null, [], 0, false);
    // Client stores the exact server ETag and sends it back → 304.
    expect(etagMatchesIfNoneMatch(etag, etag)).toBe(true);
    // A different history (isRunning flipped) yields a different ETag → no 304.
    const etag2 = computeHistoryVersion(null, null, [], 0, true);
    expect(etag).not.toBe(etag2);
    expect(etagMatchesIfNoneMatch(etag, etag2)).toBe(false);
  });
});