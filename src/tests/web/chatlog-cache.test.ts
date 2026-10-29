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
import { describe, it, expect, vi } from 'vitest';
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
// ───────────────────────────────────────────────────────────────────────────
// I/O wrappers against an INJECTED fake IndexedDB.
//
// The no-IDB suite above can only prove "the no-op is a no-op" — a wrapper
// that returned without ever touching the cache would pass it identically.
// These tests install a minimal in-memory IDB on globalThis.indexedDB and
// require a value to ROUND-TRIP through write → read, and to be GONE after
// clear.
// ───────────────────────────────────────────────────────────────────────────
type FakeStore = Map<string, unknown>;

function makeFakeIndexedDb(store: FakeStore) {
  const request = <T>(compute: () => T) => {
    const req = { onsuccess: null as null | (() => void), onerror: null as null | (() => void), result: undefined as T };
    queueMicrotask(() => {
      req.result = compute();
      req.onsuccess?.();
    });
    return req;
  };

  const objectStore = {
    keyPath: 'sessionId',
    get: (key: string) => request(() => store.get(key)),
    getAllKeys: () => request(() => [...store.keys()]),
    put: (rec: { sessionId: string }) => request(() => { store.set(rec.sessionId, rec); return rec.sessionId; }),
    delete: (key: string) => request(() => void store.delete(key)),
  };

  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => ({
      objectStore: () => objectStore,
      oncomplete: null,
      onerror: null,
      onabort: null,
    }),
    close: () => undefined,
  };

  const factory = {
    open: () => {
      const req = {
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
        onblocked: null as null | (() => void),
        onupgradeneeded: null as null | (() => void),
        result: undefined as unknown,
      };
      queueMicrotask(() => {
        req.result = db;
        req.onsuccess?.();
      });
      return req;
    },
  };
  return factory;
}

describe('I/O wrappers — round-trip through an injected fake IndexedDB', () => {
  it('write then read returns the same messages; clear removes the record', async () => {
    const store: FakeStore = new Map();
    vi.stubGlobal('indexedDB', makeFakeIndexedDb(store));
    try {
      expect(await readCachedChatlog('sid-1')).toBeNull(); // miss on an empty store

      await writeCachedChatlog('sid-1', [msg('hello')], [msg('@coder hi')]);
      expect([...store.keys()]).toEqual(['sid-1']);

      const rec = await readCachedChatlog('sid-1');
      expect(rec?.sessionId).toBe('sid-1');
      expect(rec?.messages).toEqual([msg('hello')]);
      expect(rec?.teammateMessages).toEqual([msg('@coder hi')]);

      await clearCachedChatlog('sid-1');
      expect(store.has('sid-1')).toBe(false);
      expect(await readCachedChatlog('sid-1')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a write prunes every OTHER session, keeping only the active one', async () => {
    // Pins the bounded-cache contract: without pruneOtherSessions wiring in
    // writeCachedChatlog the store would grow one record per session.
    const store: FakeStore = new Map([
      ['old-a', { sessionId: 'old-a', version: CACHE_VERSION, savedAt: 1, messages: [], teammateMessages: [] }],
      ['old-b', { sessionId: 'old-b', version: CACHE_VERSION, savedAt: 1, messages: [], teammateMessages: [] }],
    ]);
    vi.stubGlobal('indexedDB', makeFakeIndexedDb(store));
    try {
      await writeCachedChatlog('sid-2', [msg('new')], []);
      expect([...store.keys()]).toEqual(['sid-2']);
      expect((await readCachedChatlog('sid-2'))?.messages).toEqual([msg('new')]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
