/**
 * chatlog-cache.ts - per-session IndexedDB chatlog cache
 *
 * Goal: a phone lock-screen wake should be INSTANT, not a blank screen + a
 * full /history re-fetch. So before the first render, the client hydrates the
 * chat log from a per-session IndexedDB cache, then revalidates with the
 * server via If-None-Match — a 304 keeps the hydrated state on screen.
 *
 * Architecture split (mirrors the server's serve-history.ts):
 *   - PURE CORE (testable in node, no IndexedDB):  buildCacheKey(),
 *     pruneOtherSessions(), makeCacheRecord(). These hold the logic that must
 *     be correct; the unit tests exercise them directly.
 *   - I/O WRAPPERS (browser-only, failure-tolerant):  readCachedChatlog(),
 *     writeCachedChatlog(), clearCachedChatlog(). Every path resolves to a
 *     benign value (null / void) on ANY failure — IndexedDB unavailable,
 *     quota exceeded, blocked upgrade, version mismatch, malformed record.
 *     Caching is an OPTIMIZATION, never a correctness dependency: a cache
 *     miss just means the first render waits for /history, exactly like the
 *     uncached path. So no wrapper ever throws into the hydration flow.
 *
 * Cache shape: a single IndexedDB database `mycc-chatlog` with one object
 * store `sessions` keyed by sessionId (string). Each record is
 * `{ sessionId, version, savedAt, messages, teammateMessages }`. Bumping
 * CACHE_VERSION invalidates the whole store (an old record's version
 * mismatched → treated as a miss + overwritten on next write).
 */
import type { ChatMessage } from './types';

/** Bump when the cache record shape changes; an old record is treated as a
 *  miss and overwritten on the next write. */
export const CACHE_VERSION = 1;
const DB_NAME = 'mycc-chatlog';
const STORE_NAME = 'sessions';

/** A cached chatlog record stored under the sessionId key. */
export interface ChatlogCacheRecord {
  sessionId: string;
  version: number;
  savedAt: number;
  messages: ChatMessage[];
  teammateMessages: ChatMessage[];
}

// ───────────────────────────────────────────────────────────────────────────
// PURE CORE (no IndexedDB — exercised directly by unit tests)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build the IndexedDB key for a session. A null/empty sessionId yields null
 * (the caller must skip caching in that case — there is no stable key to
 * bind a log to, and a foreign log must never be shown). Otherwise the
 * sessionId IS the key (object-store key), so this is the identity function
 * today, but isolating it lets the key scheme evolve (e.g. prefixing with a
 * version namespace) without touching the I/O wrappers.
 */
export function buildCacheKey(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  const key = sessionId.trim();
  return key.length > 0 ? key : null;
}

/**
 * Decide whether a stored record is usable for the requested sessionId:
 *   - same sessionId AND matching CACHE_VERSION → the record itself
 *   - otherwise → null (stale / foreign / schema-mismatch → treat as miss)
 *
 * Pure: takes the record + the live version constant, returns the record or
 * null. The I/O layer calls this after reading to decide whether to hydrate.
 */
export function validateCacheRecord(
  record: ChatlogCacheRecord | null | undefined,
  sessionId: string,
  version: number = CACHE_VERSION,
): ChatlogCacheRecord | null {
  if (!record) return null;
  if (record.sessionId !== sessionId) return null;
  if (record.version !== version) return null;
  return record;
}

/**
 * Build a fresh cache record for writing. Pure constructor — clones the
 * message arrays so a later in-place mutation of the live store does not
 * retroactively change the persisted record.
 */
export function makeCacheRecord(
  sessionId: string,
  messages: ChatMessage[],
  teammateMessages: ChatMessage[],
  version: number = CACHE_VERSION,
): ChatlogCacheRecord {
  return {
    sessionId,
    version,
    savedAt: Date.now(),
    messages: messages.slice(),
    teammateMessages: teammateMessages.slice(),
  };
}

/**
 * Given the keys currently in the store and the active session key, return
 * the list of OTHER-session keys to delete (prune). Keeps the cache from
 * growing unbounded across many sessions: on every write we drop every
 * record that is not the current session. Pure: takes the key list + active
 * key, returns the keys to delete.
 */
export function pruneOtherSessions(allKeys: string[], activeKey: string): string[] {
  return allKeys.filter((k) => k !== activeKey);
}

// ───────────────────────────────────────────────────────────────────────────
// I/O WRAPPERS (browser-only, failure-tolerant — never throw)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Open (or create) the `mycc-chatlog` database. Resolves with the IDBDatabase
 * or null on ANY failure (no IndexedDB, blocked upgrade, quota, etc.). The
 * onupgradeneeded handler creates the `sessions` store keyed by sessionId on
 * first open / version bump.
 *
 * Guarded for node/test environments where `indexedDB` is undefined: resolves
 * null immediately so the pure core can still be tested without a DOM.
 */
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const indexedDB: IDBFactory | undefined =
        (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
      if (!indexedDB) { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, CACHE_VERSION);
      req.onupgradeneeded = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
          }
        } catch {
          // upgrade failure → resolve null below via onerror, or a partial db
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Read the cached chatlog for a sessionId. Resolves with the validated
 * record (same sessionId + matching version) or null on any failure / miss.
 * Never rejects — a read failure degrades to "no cache" (the hydration
 * falls back to the /history fetch).
 */
export async function readCachedChatlog(sessionId: string | null | undefined): Promise<ChatlogCacheRecord | null> {
  const key = buildCacheKey(sessionId);
  if (!key) return null;
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        const rec = req.result as ChatlogCacheRecord | undefined;
        resolve(validateCacheRecord(rec ?? null, key));
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    } finally {
      // Close eagerly; a read is a one-shot operation.
      try { db.close(); } catch { /* ignore */ }
    }
  });
}

/**
 * Persist the current chatlog under the sessionId key, pruning every OTHER
 * session's record first so the store stays bounded to one session. Never
 * rejects — a write failure is silent (the cache is best-effort).
 */
export async function writeCachedChatlog(
  sessionId: string | null | undefined,
  messages: ChatMessage[],
  teammateMessages: ChatMessage[],
): Promise<void> {
  const key = buildCacheKey(sessionId);
  if (!key) return;
  const db = await openDb();
  if (!db) return;
  const record = makeCacheRecord(key, messages, teammateMessages);
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      // Prune other sessions: delete every key that is not the active one.
      const keysReq = store.getAllKeys();
      keysReq.onsuccess = () => {
        try {
          const allKeys = (keysReq.result as string[]).filter(
            (k): k is string => typeof k === 'string',
          );
          for (const other of pruneOtherSessions(allKeys, key)) {
            try { store.delete(other); } catch { /* ignore single delete fail */ }
          }
        } catch {
          // prune failure is non-fatal — the put below still writes the active record
        }
        // Write the active record.
        const putReq = store.put(record);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => resolve();
      };
      keysReq.onerror = () => resolve();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  });
}

/**
 * Clear the cached chatlog for a sessionId (e.g. on a forced reload). Never
 * rejects; a failure is silent.
 */
export async function clearCachedChatlog(sessionId: string | null | undefined): Promise<void> {
  const key = buildCacheKey(sessionId);
  if (!key) return;
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    } catch {
      resolve();
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  });
}