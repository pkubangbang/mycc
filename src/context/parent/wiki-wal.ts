/**
 * wiki-wal.ts - Stateful WAL (write-ahead log) file I/O for the wiki module.
 *
 * Extracted from src/context/parent/wiki.ts. The wiki keeps a JSON-lines WAL
 * per day under the wiki logs dir (`<logs>/YYYY-MM-DD.wal`): every stored
 * document appends a line, a delete appends a `deleted:true` TOMBSTONE (last
 * write wins), and rebuild replays all files. That read/append/merge filesystem
 * concern is what lives here — it is independent of LanceDB, so it is
 * separated from WikiManager.
 *
 * The PURE serializers (parseWALFile / parseWAL / formatWAL) stay in
 * wiki-utils.ts; this module is the stateless filesystem plumbing that reads
 * and writes the files those serializers produce.
 *
 * None of these functions hold instance state. Diagnostics that the caller
 * wants routed to its own logger are pushed through the optional `warn`
 * callback rather than an injected Core, so this module imports neither
 * WikiManager nor Core.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WALEntry } from '../../types.js';
import { getWikiLogsDir, ensureDirs } from '../../config.js';
import { parseWALFile, formatDate } from './wiki-utils.js';

/** Resolve the WAL file path for a given date (default: today). */
function walPathFor(date?: string): string {
  const targetDate = date || formatDate(new Date());
  return path.join(getWikiLogsDir(), `${targetDate}.wal`);
}

/**
 * Read and parse the WAL for a date (default: today). Returns [] when the
 * file is absent — an empty WAL is not an error.
 */
export function readWAL(date?: string): WALEntry[] {
  const walPath = walPathFor(date);
  if (!fs.existsSync(walPath)) {
    return [];
  }
  return parseWALFile(fs.readFileSync(walPath, 'utf-8'));
}

/**
 * Append a single entry to today's WAL as one JSON line.
 */
export function appendWALEntry(entry: WALEntry): void {
  ensureDirs();
  const walPath = walPathFor();
  fs.appendFileSync(walPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

/**
 * Append many entries to today's WAL in a SINGLE write (one JSON line each).
 * Used by the batch-put path so a batch is one filesystem append, not N.
 */
export function appendWALEntries(entries: WALEntry[]): void {
  if (entries.length === 0) return;
  ensureDirs();
  const walPath = walPathFor();
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  fs.appendFileSync(walPath, `${lines}\n`, 'utf-8');
}

/**
 * Replay every WAL file into a single latest-wins entry list, applying the
 * rebuild filters.
 *
 * Files are read in ascending name order and later entries within a file
 * supersede earlier ones (and later files supersede earlier files), so the
 * final map matches a sequential last-write-wins replay.
 *
 * IMPORTANT: the fold runs over ALL entries FIRST, then the filters are
 * applied to the surviving (latest) entry of each hash. Filtering during the
 * fold would be wrong: a delete appends a `deleted:true` TOMBSTONE rather than
 * rewriting the live line, so an early `if (deleted) continue` would let the
 * earlier live entry win and never let the tombstone supersede it (the deleted
 * document would be resurrected on rebuild). Folding first makes the tombstone
 * the latest entry for its hash, and the `deleted` filter then drops it.
 *
 * A hash whose LATEST entry is deleted / unapproved / foreign-namespace is
 * excluded; a hash whose latest entry is live and in-namespace is kept.
 *
 * `namespace` is passed in (rather than imported from the rag provider) so
 * this module stays free of that dependency; the caller supplies its current
 * namespace. Entries lacking a `namespace` field are legacy (pre-rag-provider)
 * and are KEPT — they get re-embedded with the current model on rebuild.
 *
 * Returns [] when the WAL directory does not exist.
 */
export function mergeWALEntries(namespace: string): WALEntry[] {
  const walDir = getWikiLogsDir();
  if (!fs.existsSync(walDir)) {
    return [];
  }

  const walFiles = fs.readdirSync(walDir)
    .filter((f) => f.endsWith('.wal'))
    .sort();

  // 1. Fold — latest wins, over ALL entries (tombstones included).
  const merged = new Map<string, WALEntry>();
  for (const walFile of walFiles) {
    const content = fs.readFileSync(path.join(walDir, walFile), 'utf-8');
    for (const entry of parseWALFile(content)) {
      merged.set(entry.hash, entry);
    }
  }

  // 2. Filter the surviving latest entry per hash.
  const result: WALEntry[] = [];
  for (const entry of merged.values()) {
    if (entry.deleted) continue;
    if (!entry.approved) continue;
    if (entry.namespace && entry.namespace !== namespace) continue;
    result.push(entry);
  }

  return result;
}
