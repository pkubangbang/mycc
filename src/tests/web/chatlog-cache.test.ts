/**
 * chatlog-cache.test.ts - unit tests for the chatlog-cache PURE CORE
 *
 * The IndexedDB I/O wrappers (readCachedChatlog / writeCachedChatlog /
 * clearCachedChatlog) cannot run in node — there is no IndexedDB — and the
 * module's openDb() is guarded to resolve null when `globalThis.indexedDB`
 * is undefined, so the wrappers degrade to no-ops here. This file therefore
 * exercises the PURE CORE only (the logic that must be correct):
 *   - buildCacheKey:        null/empty/whitespace → null; otherwise the id.
 *   - validateCacheRecord:  same sessionId + matching version → record; else null.
 *   - makeCacheRecord:      clones the message arrays + stamps version/savedAt.
 *   - pruneOtherSessions:   returns every key that is not the active one.
 *
 * The I/O wrappers' failure-tolerant contract (never throw, resolve null/
 * void on any error) is asserted separately against the node (no-IDB)
 * environment: they must resolve, not reject.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCacheKey,
  validateCacheRecord,
  makeCacheRecord,
  pruneOtherSessions,
  readCachedChatlog,
  writeCachedChatlog,
  clearCachedChatlog,
  CACHE_VERSION,
} from '../../web/src/chatlog-cache.js';
import type { ChatlogCacheRecord } from '../../web/src/chatlog-cache.js';
import type { ChatMessage } from '../../web/src/types.js';

function msg(content: string, timestamp = 1): ChatMessage {
  return { type: 'user', content, timestamp };
}

describe('buildCacheKey', () => {
  it('returns null for null / undefined / empty / whitespace', () => {
    expect(buildCacheKey(null)).toBeNull();
    expect(buildCacheKey(undefined)).toBeNull();
    expect(buildCacheKey('')).toBeNull();
    expect(buildCacheKey('   ')).toBeNull();
  });

  it('returns the trimmed sessionId for a real id', () => {
    expect(buildCacheKey('abc-123')).toBe('abc-123');
    // surrounding whitespace is trimmed so a padded id still keys correctly
    expect(buildCacheKey('  abc-123  ')).toBe('abc-123');
  });
});

describe('validateCacheRecord', () => {
  const sid = 'session-A';

  it('returns null for null / undefined records', () => {
    expect(validateCacheRecord(null, sid)).toBeNull();
    expect(validateCacheRecord(undefined, sid)).toBeNull();
  });

  it('returns the record when sessionId + version match', () => {
    const rec: ChatlogCacheRecord = {
      sessionId: sid,
      version: CACHE_VERSION,
      savedAt: 100,
      messages: [msg('hi')],
      teammateMessages: [],
    };
    expect(validateCacheRecord(rec, sid)).toBe(rec);
  });

  it('returns null when the sessionId differs (foreign session)', () => {
    const rec: ChatlogCacheRecord = {
      sessionId: 'other-session',
      version: CACHE_VERSION,
      savedAt: 100,
      messages: [msg('hi')],
      teammateMessages: [],
    };
    expect(validateCacheRecord(rec, sid)).toBeNull();
  });

  it('returns null when the version is stale (schema mismatch)', () => {
    const rec: ChatlogCacheRecord = {
      sessionId: sid,
      version: CACHE_VERSION + 999, // a future/old schema
      savedAt: 100,
      messages: [msg('hi')],
      teammateMessages: [],
    };
    expect(validateCacheRecord(rec, sid)).toBeNull();
  });

  it('honors an explicit version argument', () => {
    const rec: ChatlogCacheRecord = {
      sessionId: sid,
      version: 7,
      savedAt: 100,
      messages: [],
      teammateMessages: [],
    };
    expect(validateCacheRecord(rec, sid, 7)).toBe(rec);
    expect(validateCacheRecord(rec, sid, 8)).toBeNull();
  });
});

describe('makeCacheRecord', () => {
  it('stamps sessionId, version, savedAt and clones the message arrays', () => {
    const messages = [msg('a', 1), msg('b', 2)];
    const teammateMessages = [msg('@coder did x', 3)];
    const rec = makeCacheRecord('sid-1', messages, teammateMessages);
    expect(rec.sessionId).toBe('sid-1');
    expect(rec.version).toBe(CACHE_VERSION);
    expect(typeof rec.savedAt).toBe('number');
    expect(rec.messages).toEqual(messages);
    expect(rec.teammateMessages).toEqual(teammateMessages);
  });

  it('clones — later mutation of the source arrays does not change the record', () => {
    const messages = [msg('a', 1)];
    const rec = makeCacheRecord('sid-1', messages, []);
    messages.push(msg('b', 2)); // mutate the source after recording
    expect(rec.messages).toEqual([msg('a', 1)]); // record unchanged
  });

  it('honors an explicit version argument', () => {
    const rec = makeCacheRecord('sid-1', [], [], 42);
    expect(rec.version).toBe(42);
  });
});

describe('pruneOtherSessions', () => {
  it('returns every key that is not the active key', () => {
    expect(pruneOtherSessions(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('returns all keys when the active key is absent', () => {
    expect(pruneOtherSessions(['a', 'b'], 'z')).toEqual(['a', 'b']);
  });

  it('returns an empty list when only the active key is present', () => {
    expect(pruneOtherSessions(['only'], 'only')).toEqual([]);
  });

  it('handles an empty key list', () => {
    expect(pruneOtherSessions([], 'only')).toEqual([]);
  });
});

describe('I/O wrappers — failure-tolerant in node (no IndexedDB)', () => {
  // node has no IndexedDB; the wrappers must resolve (not reject) and yield
  // benign values. This pins the "caching is an optimization, never a
  // correctness dependency" contract: a no-IDB environment behaves exactly
  // like a cache miss.
  it('readCachedChatlog resolves null (no throw) for a real session id', async () => {
    await expect(readCachedChatlog('sid-1')).resolves.toBeNull();
  });

  it('readCachedChatlog resolves null for a null session id (no key)', async () => {
    await expect(readCachedChatlog(null)).resolves.toBeNull();
  });

  it('writeCachedChatlog resolves void (no throw) for a real session id', async () => {
    await expect(writeCachedChatlog('sid-1', [msg('a')], [])).resolves.toBeUndefined();
  });

  it('writeCachedChatlog resolves void for a null session id (no key)', async () => {
    await expect(writeCachedChatlog(null, [msg('a')], [])).resolves.toBeUndefined();
  });

  it('clearCachedChatlog resolves void (no throw) for a real session id', async () => {
    await expect(clearCachedChatlog('sid-1')).resolves.toBeUndefined();
  });

  it('clearCachedChatlog resolves void for a null session id (no key)', async () => {
    await expect(clearCachedChatlog(null)).resolves.toBeUndefined();
  });
});