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
 *  miss and overwritten on the next write.
 *
 *  v2: the record gained `lastRenderedSeq` / `lastHistoryEtag`. Without the
 *  bump, a v1 record (rows, NO watermark) would hydrate through the legacy
 *  path while the live stream re-delivered the same rows — the duplicate
 *  bubbles seen after a refresh. A schema change must invalidate what it
 *  cannot describe. */
export const CACHE_VERSION = 2;
const DB_NAME = 'mycc-chatlog';
const STORE_NAME = 'sessions';

/**
 * Is a value accepted by the structured clone algorithm — i.e. can
 * `IDBObjectStore.put` store it?
 *
 * A chat row is JSON-shaped, so `JSON.stringify` is the honest, cheap probe:
 * anything it cannot serialise (a function, a cycle, a proxy that throws on
 * access) would make `put` throw `DataCloneError` and abort the WHOLE write.
 * One such row must cost that row, not the cache.
 */
export function isStructuredCloneable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

/** A cached chatlog record stored under the sessionId key. */
export interface ChatlogCacheRecord {
  sessionId: string;
  version: number;
  savedAt: number;
  messages: ChatMessage[];
  teammateMessages: ChatMessage[];
  /**
   * The page's display cursor (`lastRenderedSeq`) at write time.
   *
   * Cached ALONGSIDE the rows because the two are one fact: "these rows are on
   * screen" and "everything up to seq N is rendered" must be restored together.
   * Hydrating the rows without the watermark re-opened them to the live stream —
   * a reconnect's cursor started at 0, every re-delivered row was admitted, and
   * the same record appeared again (two identical bash bubbles, each with its own
   * `[HH:MM:SS]` header, gone after the next /history 200). A page refresh or an
   * HMR remount takes exactly this path.
   *
   * Optional for backward compatibility with records written before the field
   * existed: a legacy record hydrates its rows and resumes from the snapshot's
   * own maximum (see hydrateFromCache), never from 0.
   */
  lastRenderedSeq?: number;
  /** The `/history` ETag the hydrated rows were validated against (see fetchHistory). */
  lastHistoryEtag?: string | null;
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
  version: number = CACHE_VERSION
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
  cursor: { lastRenderedSeq?: number; lastHistoryEtag?: string | null } = {}
): ChatlogCacheRecord {
  return {
    sessionId,
    version,
    savedAt: Date.now(),
    messages: messages.slice(),
    teammateMessages: teammateMessages.slice(),
    // Stamped in the SAME write as the rows: a cursor persisted without them
    // (or the reverse) would hydrate a log the watermark does not describe.
    // Omitted rather than written as 0 when unknown — 0 means "nothing rendered
    // yet", which is a fact, not a default.
    ...(typeof cursor.lastRenderedSeq === 'number' ? { lastRenderedSeq: cursor.lastRenderedSeq } : {}),
    ...(cursor.lastHistoryEtag !== undefined ? { lastHistoryEtag: cursor.lastHistoryEtag } : {})
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
      const indexedDB: IDBFactory | undefined = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
      if (!indexedDB) {
        resolve(null);
        return;
      }
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
      try {
        db.close();
      } catch {
        /* ignore */
      }
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
  cursor: { lastRenderedSeq?: number; lastHistoryEtag?: string | null } = {}
): Promise<void> {
  const key = buildCacheKey(sessionId);
  if (!key) return;
  const db = await openDb();
  if (!db) return;
  const record = makeCacheRecord(key, messages, teammateMessages, CACHE_VERSION, cursor);
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      // Prune other sessions: delete every key that is not the active one.
      const keysReq = store.getAllKeys();
      keysReq.onsuccess = () => {
        try {
          const allKeys = (keysReq.result as string[]).filter((k): k is string => typeof k === 'string');
          for (const other of pruneOtherSessions(allKeys, key)) {
            try {
              store.delete(other);
            } catch {
              /* ignore single delete fail */
            }
          }
        } catch {
          // prune failure is non-fatal — the put below still writes the active record
        }
        // Write the active record.
        //
        // A throw from `store.put` (DataCloneError: a row carries a value the
        // structured clone algorithm rejects — an un-serialisable card payload
        // is the known case) is caught here ONCE and retried without the
        // offending rows, so a single bad message degrades to "this row is not
        // cached" instead of aborting the whole write on every persist.
        const attemptPut = (rows: ChatMessage[]): IDBRequest | null => {
          try {
            return store.put({ ...record, messages: rows });
          } catch {
            return null;
          }
        };
        let putReq = attemptPut(record.messages);
        if (!putReq) {
          // Drop the rows that cannot be cloned, keeping the rest.
          const safe = record.messages.filter((m) => isStructuredCloneable(m));
          putReq = attemptPut(safe) ?? attemptPut(record.messages.slice(0, 0));
        }
        if (!putReq) {
          resolve();
          return;
        }
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
      try {
        db.close();
      } catch {
        /* ignore */
      }
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
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  });
}
