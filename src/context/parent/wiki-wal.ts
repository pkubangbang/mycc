/**
 * wiki-wal.ts - Stateful WAL (write-ahead log) file I/O for the wiki module.
 *
 * Extracted from src/context/parent/wiki.ts. The wiki keeps a JSON-lines WAL
 * per day under the wiki logs dir (`<logs>/YYYY-MM-DD.wal`): every stored
 * document appends a line, a delete rewrites the entry with `deleted:true`,
 * and rebuild replays all files. That read/append/rewrite/merge filesystem
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
 * Mark the WAL entry for `hash` as deleted (in the file for `date`).
 *
 * Reads the file, flips the matching entry's `deleted` flag, and writes the
 * file back as JSON lines. Best-effort: a missing file or a hash absent from
 * that date's WAL is reported through `warn` (when supplied) and returns —
 * neither is fatal, since the caller's LanceDB delete still proceeds.
 */
export function markWALEntryDeleted(
  hash: string,
  date: string,
  warn?: (message: string) => void,
): void {
  ensureDirs();
  const walPath = walPathFor(date);

  if (!fs.existsSync(walPath)) {
    // WAL file no longer exists - this is OK, just report it.
    warn?.(`WAL file not found for date ${date}`);
    return;
  }

  const entries = parseWALFile(fs.readFileSync(walPath, 'utf-8'));

  let found = false;
  for (const entry of entries) {
    if (entry.hash === hash) {
      entry.deleted = true;
      found = true;
      break;
    }
  }

  if (!found) {
    warn?.(`Entry ${hash} not found in WAL ${date}`);
    return;
  }

  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(walPath, `${lines}\n`, 'utf-8');
}

/**
 * Replay every WAL file into a single latest-wins entry list, applying the
 * rebuild filters.
 *
 * Files are read in ascending name order and later entries within a file
 * supersede earlier ones (and later files supersede earlier files), so the
 * final map matches a sequential last-write-wins replay. Entries that are
 * deleted, unapproved, or belong to a DIFFERENT RAG namespace are dropped.
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

  const merged = new Map<string, WALEntry>();
  for (const walFile of walFiles) {
    const content = fs.readFileSync(path.join(walDir, walFile), 'utf-8');
    for (const entry of parseWALFile(content)) {
      if (entry.deleted) continue;
      if (!entry.approved) continue;
      if (entry.namespace && entry.namespace !== namespace) continue;
      merged.set(entry.hash, entry); // latest wins
    }
  }

  return [...merged.values()];
}
