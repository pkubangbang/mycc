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
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeHistoryVersion, etagMatchesIfNoneMatch } from '../../serve/serve-history.js';
import { lastSeqInFile } from '../../loop/triologue/transcript.js';


const WEAK_ETAG_RE = /^W\/"h[0-9a-f]+"$/;

describe('computeHistoryVersion — shape', () => {
  it('produces a weak ETag of the form W/"h<hex>"', () => {
    const etag = computeHistoryVersion(null, 0, false);
    expect(etag).toMatch(WEAK_ETAG_RE);
  });

  it('is deterministic — identical inputs yield identical ETags', () => {
    const a = computeHistoryVersion(null, 0, false);
    const b = computeHistoryVersion(null, 0, false);
    expect(a).toBe(b);
  });
});

describe('computeHistoryVersion — durable file fingerprint', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-version-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, '{}\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flips when the transcript file changes (size/mtime) — the user journal lives there', () => {
    const before = computeHistoryVersion(transcriptPath, 0, false);
    // Appending a user-input journal record is a transcript append, so the
    // same fingerprint that catches a new turn catches a new user bubble.
    fs.appendFileSync(transcriptPath, '{"role":"user","content":"hi","kind":"steer","user_origin":true}\n', 'utf-8');
    const after = computeHistoryVersion(transcriptPath, 0, false);
    expect(after).not.toBe(before);
  });

  it('is stable when no file changed (same stat → same ETag)', () => {
    const a = computeHistoryVersion(transcriptPath, 0, false);
    const b = computeHistoryVersion(transcriptPath, 0, false);
    expect(a).toBe(b);
  });

  it('a missing transcript path yields a stable token (does not vary across calls)', () => {
    const a = computeHistoryVersion(null, 0, false);
    const b = computeHistoryVersion(null, 0, false);
    expect(a).toBe(b);
    // And differs from the present-file fingerprint (the null slot is not a
    // zero stat).
    const present = computeHistoryVersion(transcriptPath, 0, false);
    expect(a).not.toBe(present);
  });

  it('a deleted file flips the ETag (present → missing)', () => {
    const present = computeHistoryVersion(transcriptPath, 0, false);
    fs.unlinkSync(transcriptPath);
    const missing = computeHistoryVersion(transcriptPath, 0, false);
    expect(missing).not.toBe(present);
  });
});

describe('computeHistoryVersion — transient fields (must flip the ETag)', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-version-tr-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, '{}\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flips when the steering queue length changes', () => {
    const a = computeHistoryVersion(transcriptPath, 0, false);
    const b = computeHistoryVersion(transcriptPath, 2, false);
    expect(b).not.toBe(a);
  });

  it('flips when isRunning changes', () => {
    const a = computeHistoryVersion(transcriptPath, 0, false);
    const b = computeHistoryVersion(transcriptPath, 0, true);
    expect(b).not.toBe(a);
  });

  it('flips when the journal advances (same file, one more record)', () => {
    // The display cursor: the ETag must invalidate on ANY journaled record, or
    // the client's post-open revalidation would 304 over a gap. Same size and
    // same mtime would be indistinguishable by stat alone — the last `seq`
    // states the count directly.
    fs.writeFileSync(transcriptPath, JSON.stringify({ role: 'assistant', content: 'a', kind: 'new', seq: 1 }) + '\n');
    const a = computeHistoryVersion(transcriptPath, 0, false);
    fs.appendFileSync(transcriptPath, JSON.stringify({ role: 'assistant', content: 'b', kind: 'new', seq: 2 }) + '\n');
    const b = computeHistoryVersion(transcriptPath, 0, false);
    expect(b).not.toBe(a);
  });

  it('the journal cursor is what flips it — a re-read with no new record keeps the same seq', () => {
    // mtime alone would flip on any rewrite, so the interesting guarantee is
    // narrower and stronger: with no new record, the CURSOR is unchanged, and
    // it is the cursor (not mtime) that tells the client "nothing was journaled
    // while your socket was opening".
    const line = JSON.stringify({ role: 'assistant', content: 'a', kind: 'new', seq: 7 }) + '\n';
    fs.writeFileSync(transcriptPath, line);
    expect(lastSeqInFile(transcriptPath)).toBe(7);
    fs.writeFileSync(transcriptPath, line);
    expect(lastSeqInFile(transcriptPath)).toBe(7);
  });

  it('an empty transcript is stable (no spurious flips from a zero cursor)', () => {
    fs.writeFileSync(transcriptPath, '');
    const a = computeHistoryVersion(transcriptPath, 0, false);
    const b = computeHistoryVersion(transcriptPath, 0, false);
    expect(a).toBe(b);
  });

  it('a log append in the FALLBACK window flips the ETag (else a 304 freezes an unseen body)', () => {
    // While the transcript holds no records, /history's BODY is the in-memory
    // messageLog, and broadcast()/broadcastCard() can append to it without
    // touching any file. If the version ignored the log there, a client holding
    // the tag would get a 304 for a body it has never seen — a chat frozen until
    // something unrelated changed. The term is gated on the SAME predicate
    // readHistory uses, which is what `false` says here.
    fs.writeFileSync(transcriptPath, '');
    const log = [{ type: 'log' as const, content: 'one', timestamp: 1 }];
    const empty = computeHistoryVersion(transcriptPath, 0, false, [], false);
    const one = computeHistoryVersion(transcriptPath, 0, false, log, false);
    expect(empty).not.toBe(one);
    // Length alone is not enough: a bounded log that shifts (oldest dropped,
    // newest appended, same length) must still flip via the tail timestamp.
    const shifted = [{ type: 'log' as const, content: 'two', timestamp: 2 }];
    expect(computeHistoryVersion(transcriptPath, 0, false, shifted, false)).not.toBe(one);
  });

  it('IGNORES the log once the transcript owns the body (no pointless 200s)', () => {
    // Same file, same durable inputs, log differs → identical ETag, because the
    // log is not a body source in this window.
    fs.writeFileSync(transcriptPath, JSON.stringify({ role: 'assistant', content: 'a', kind: 'new', seq: 1 }) + '\n');
    const log = [{ type: 'log' as const, content: 'stale', timestamp: 9 }];
    const a = computeHistoryVersion(transcriptPath, 0, false, log, true);
    const b = computeHistoryVersion(transcriptPath, 0, false, log, true);
    expect(a).toBe(b);
    expect(a).toBe(computeHistoryVersion(transcriptPath, 0, false));
  });
});

describe('computeHistoryVersion — combined input independence', () => {
  it('two distinct input sets produce distinct ETags', () => {
    const a = computeHistoryVersion(null, 0, false);
    const b = computeHistoryVersion(null, 1, true);
    expect(a).not.toBe(b);
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
    const etag = computeHistoryVersion(null, 0, false);
    // Client stores the exact server ETag and sends it back → 304.
    expect(etagMatchesIfNoneMatch(etag, etag)).toBe(true);
    // A different history (isRunning flipped) yields a different ETag → no 304.
    const etag2 = computeHistoryVersion(null, 0, true);
    expect(etag).not.toBe(etag2);
    expect(etagMatchesIfNoneMatch(etag, etag2)).toBe(false);
  });
});
