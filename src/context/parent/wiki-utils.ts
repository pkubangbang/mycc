/**
 * wiki-utils.ts - Pure helpers and filesystem plumbing for WikiManager.
 *
 * Extracted from src/context/parent/wiki.ts to keep that class focused on
 * LanceDB lifecycle and the wiki module contract. Everything here is either
 * a pure function (hashing, cosine similarity, WAL serialization) or a
 * stateless filesystem helper over the wiki config paths (domains.json,
 * reindex.lock freshness). None of it holds instance state.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import type { WikiDocument, WikiDomain, WALEntry } from '../../types.js';
import {
  getWikiDomainsFile,
  getWikiReindexLockFile,
  getHeartbeatFile,
  ensureDirs,
} from '../../config.js';

/** Hash is first 16 chars of SHA-256 hex digest. */
export const HASH_PATTERN = /^[a-f0-9]{16}$/;

/** Freshness window for the reindex lock — mirrors identity.ts (90s). */
export const REINDEX_FRESHNESS_MS = 90_000;

/**
 * Generate the content-addressed hash for a document:
 * sha256 of `domain:title:content`, truncated to 16 hex chars.
 */
export function generateHash(document: WikiDocument): string {
  const content = `${document.domain}:${document.title}:${document.content}`;
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Calculate cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Compare an incoming WikiDocument against a stored LanceDB record for full
 * equality across all fields: domain, title, content, AND references.
 *
 * Why full equality, not just the hash: the wiki hash is sha256 of
 * `${domain}:${title}:${content}` truncated to 16 hex chars. It does not
 * cover `references`, and a 64-bit truncated hash can in principle collide
 * between two genuinely different documents. Only a full-document match is
 * a true "already present" no-op; a hash collision between different
 * documents must NOT be falsely reported as already-existed (it would
 * silently drop a distinct document). References are compared
 * order-insensitively — they are a set, and the WAL/export round-trip may
 * reorder them.
 */
export function sameDocument(stored: Record<string, unknown>, incoming: WikiDocument): boolean {
  if ((stored.domain as string) !== incoming.domain) return false;
  if ((stored.title as string) !== incoming.title) return false;
  if ((stored.content as string) !== incoming.content) return false;
  // references: stored as a JSON string (or occasionally a native array)
  const parseStored = (): string[] => {
    const raw = stored.references;
    if (raw === null || raw === undefined) return [];
    if (Array.isArray(raw)) return raw as string[];
    if (typeof raw === 'string') {
      try { return JSON.parse(raw || '[]') as string[]; } catch { return []; }
    }
    return [];
  };
  const a = parseStored().slice().sort();
  const b = (incoming.references || []).slice().sort();
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Parse WAL file content (JSON lines format).
 * Malformed lines are skipped silently.
 */
export function parseWALFile(content: string): WALEntry[] {
  const entries: WALEntry[] = [];
  const lines = content.trim().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as WALEntry;
      entries.push(entry);
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

/**
 * Parse ASCII WAL format to JSON entries.
 */
export function parseWAL(asciiContent: string): WALEntry[] {
  const entries: WALEntry[] = [];
  const blocks = asciiContent.split(/\n(?=#)/);

  for (const block of blocks) {
    if (!block.trim()) continue;

    const entry = parseASCIIBlock(block);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

/**
 * Parse a single ASCII block.
 */
export function parseASCIIBlock(block: string): WALEntry | null {
  const lines = block.trim().split('\n');
  if (lines.length < 2) return null;

  let hash = '';
  let persistent = false;
  let approved = false;
  let timestamp = '';
  let domain = '';
  let title = '';
  const contentLines: string[] = [];
  const references: string[] = [];
  let section = '';

  for (const line of lines) {
    if (line.startsWith('# ')) {
      hash = line.slice(2);
    } else if (line === '!persistent') {
      persistent = true;
    } else if (line === '!approved') {
      approved = true;
    } else if (line.startsWith('[created_at]')) {
      timestamp = line.slice(12);
    } else if (line.startsWith('[domain]')) {
      domain = line.slice(8);
    } else if (line.startsWith('[title]')) {
      title = line.slice(7);
    } else if (line === '[content]') {
      section = 'content';
    } else if (line === '[references]') {
      section = 'references';
    } else if (section === 'content') {
      contentLines.push(line);
    } else if (section === 'references' && line.startsWith('- ')) {
      references.push(line.slice(2));
    }
  }

  return {
    timestamp,
    hash,
    document: {
      domain,
      title,
      content: contentLines.join('\n'),
      references,
    },
    approved,
    persistent,
  };
}

/**
 * Format WAL entries to ASCII format.
 */
export function formatWAL(entries: WALEntry[]): string {
  const blocks: string[] = [];

  for (const entry of entries) {
    const lines: string[] = [];
    lines.push(`# ${entry.hash}`);
    if (entry.deleted) lines.push('!deleted');
    if (entry.persistent) lines.push('!persistent');
    if (entry.approved) lines.push('!approved');
    lines.push(`[created_at]${entry.timestamp}`);
    lines.push(`[domain]${entry.document.domain}`);
    lines.push(`[title]${entry.document.title}`);
    lines.push('[content]');
    lines.push(entry.document.content);
    lines.push('[references]');
    for (const ref of entry.document.references) {
      lines.push(`- ${ref}`);
    }
    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}

/** Format date as YYYY-MM-DD. */
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Load domains from domains.json (empty array when absent or corrupt).
 */
export function loadDomains(): WikiDomain[] {
  ensureDirs();
  const domainsFile = getWikiDomainsFile();

  if (!fs.existsSync(domainsFile)) {
    return [];
  }

  try {
    const content = fs.readFileSync(domainsFile, 'utf-8');
    return JSON.parse(content) as WikiDomain[];
  } catch {
    return [];
  }
}

/**
 * Save domains to domains.json.
 */
export function saveDomains(domains: WikiDomain[]): void {
  ensureDirs();
  const domainsFile = getWikiDomainsFile();
  fs.writeFileSync(domainsFile, JSON.stringify(domains, null, 2), 'utf-8');
}

/**
 * Is a reindex-lock holder stale (its process is dead or its heartbeat is
 * older than the freshness window)? Mirrors the absolute-window check in
 * identity.ts's isFresh(), plus a PID-liveness probe.
 *
 * Windows note: `process.kill(pid, 0)` may throw EPERM for a PID that IS
 * alive but owned by another security context (an access-denied probe, not
 * a dead process). We therefore treat ANY throw here as stale rather than
 * distinguishing errno — this errs toward allowing the lock to be stolen
 * instead of deadlocking on a holder we merely cannot signal. The
 * heartbeat-freshness check below is the stronger signal and is what
 * actually decides in the ambiguous case.
 */
export function isReindexLockStale(holder: { sessionId?: string; pid?: number }): boolean {
  // PID-dead check: process.kill(pid, 0) throws if no such process (or if
  // we lack permission to signal it — see the Windows note above).
  if (typeof holder.pid === 'number' && holder.pid > 0) {
    try {
      process.kill(holder.pid, 0);
      // PID is alive — NOT stale on this signal alone. Fall through to the
      // heartbeat check, which is the stronger signal (a zombie holding the
      // lock but no longer beating is stale).
    } catch {
      // PID is dead (or unsignalable) → stale.
      return true;
    }
  }

  // Heartbeat freshness check: mirror identity.ts's absolute window.
  if (holder.sessionId) {
    const hbFile = getHeartbeatFile(holder.sessionId);
    if (fs.existsSync(hbFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(hbFile, 'utf-8')) as Record<string, unknown>;
        const ts = Array.isArray(parsed.timestamps) ? parsed.timestamps
          : Array.isArray(parsed.heartbeats) ? parsed.heartbeats
          : [];
        if (ts.length > 0) {
          const latest = ts[ts.length - 1] as number;
          return Date.now() - latest > REINDEX_FRESHNESS_MS;
        }
      } catch {
        // Corrupt heartbeat — can't confirm freshness; treat as stale so
        // we don't block forever on a dead holder.
        return true;
      }
    }
    // No heartbeat file at all — the holder may be a non-mycc process or a
    // crashed instance that never beat. Treat as stale (PID check above is
    // the tiebreaker; if the PID is alive we already returned false there).
  }

  // No PID and no usable heartbeat — conservatively treat as stale so a
  // corrupt/ancient lock doesn't block reindexing forever.
  return true;
}

/**
 * Best-effort removal of the reindex lock (safe when not held).
 */
export function releaseReindexLock(): void {
  try {
    fs.unlinkSync(getWikiReindexLockFile());
  } catch {
    // Already gone or never acquired — best-effort.
  }
}
