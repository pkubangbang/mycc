/**
 * spec.ts — topology-spec loading + validation (schema v2).
 *
 * Pure and side-effect-free apart from loadSpec()/updateSpecFile() touching the
 * filesystem. validateSpec() is the contract the `mycc-compose check` command
 * enforces and is unit-tested directly (src/tests/mycc-compose-spec.test.ts):
 * it never mutates its input and throws a descriptive Error on the first fault.
 *
 * Schema v2 (see skills/mycc-compose/schema.md):
 *   { group, peers: [{name, workdir, args, sessionId, renew}], channels: [...] }
 *   - args is ONE whitespace-split string; it MUST contain --auto or --daemon.
 *   - sessionId is null (mint) or a UUID.
 *   - renew ∈ {"always","onMismatch"} (default "onMismatch").
 */

import fs from 'fs';
import path from 'path';
import { parseArgString, LAUNCHER_FLAGS } from '../../../src/utils/arg-canonical.js';
import { sanitizeId } from '../../../src/utils/id-guard.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A peer record after validation (defaults resolved, args parsed). */
export interface NormalizedPeer {
  name: string;
  workdir: string;
  args: string;
  sessionId: string | null;
  renew: 'always' | 'onMismatch';
  parsedArgs: Record<string, unknown>;
  /** Index signature so NormalizedPeer is assignable to peers.ts's Peer. */
  [key: string]: unknown;
}

/** A channel record after validation. */
export interface NormalizedChannel {
  from: string;
  to: string;
  label: string;
  prompt: string;
}

/** A validated topology spec. */
export interface NormalizedSpec {
  group: string;
  peers: NormalizedPeer[];
  channels: NormalizedChannel[];
}

/**
 * Case-insensitive, Unicode-normalized key for name/label identity.
 *
 * Used for BOTH duplicate detection and membership lookups, so the two can
 * never disagree. Exporting it (rather than keeping it private) is deliberate:
 * `channels.ts` must fold `channels[].from`/`.to` the same way when it resolves
 * them to peers, or a name declared as `"Leader"` would validate but fail to
 * resolve downstream.
 */
export function dupKey(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

/**
 * Load and parse the spec file. Throws a descriptive Error on any I/O or
 * JSON error (callers turn this into dieError).
 */
export function loadSpec(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) throw new Error(`spec file not found: ${file}`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    throw new Error(`cannot read spec file ${file}: ${(err as Error).message}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`spec file ${file} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('spec must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Validate the whole spec. Returns a normalized spec (peers with resolved
 * defaults + parsedArgs) or throws an Error. NEVER mutates the input.
 */
export function validateSpec(spec: unknown): NormalizedSpec {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new Error('spec must be a JSON object');
  }
  const s = spec as Record<string, unknown>;
  if (typeof s.group !== 'string' || (s.group as string).trim() === '') {
    throw new Error('spec.group must be a non-empty string');
  }
  if (!Array.isArray(s.peers) || s.peers.length === 0) {
    throw new Error('spec.peers must be a non-empty array');
  }
  if (!Array.isArray(s.channels)) {
    throw new Error('spec.channels must be an array (use [] for a peer-only group)');
  }

  const names = new Set<string>();
  const peers: NormalizedPeer[] = (s.peers as Record<string, unknown>[]).map((p, i) => {
    const at = `peers[${i}]`;
    if (!p || typeof p !== 'object') throw new Error(`${at} must be an object`);
    if (typeof p.name !== 'string' || (p.name as string).trim() === '') {
      throw new Error(`${at}.name must be a non-empty string`);
    }
    if (names.has(dupKey(p.name as string))) throw new Error(`duplicate peer name: "${p.name}"`);
    names.add(dupKey(p.name as string));
    if (typeof p.workdir !== 'string' || (p.workdir as string).trim() === '') {
      throw new Error(`${at}.workdir must be a non-empty absolute path`);
    }
    if (!path.isAbsolute(p.workdir as string)) {
      throw new Error(`${at}.workdir must be absolute (got "${p.workdir}")`);
    }
    if (typeof p.args !== 'string') {
      throw new Error(`${at}.args must be a string of CLI flags (got ${typeof p.args})`);
    }
    const parsedArgs = parseArgString(p.args as string);
    // A spec must never author a launcher-managed flag: the launcher injects
    // `--session-id <sid>` itself, so an authored one produces a DOUBLED flag →
    // minimist collects an array → getPinnedSessionId() returns null → the peer
    // mints a random id while the launcher polls the spec's sid → 30s timeout
    // plus an orphan process.
    for (const launcherFlag of LAUNCHER_FLAGS) {
      if (launcherFlag in parsedArgs) {
        throw new Error(
          `${at}.args must not set --${launcherFlag}: it is injected by the ` +
          `launcher at spawn time. Got: "${p.args}"`,
        );
      }
    }
    // 'daemon' is a STRING_FLAG: bare `--daemon` parses to true, `--daemon x` to 'x'.
    if (parsedArgs.auto !== true && !('daemon' in parsedArgs)) {
      throw new Error(
        `${at}.args MUST include --auto or --daemon: without it cleanupEmptySessions() ` +
        `can garbage-collect the re-pinned session dir. Got: "${p.args}"`,
      );
    }
    if (p.sessionId !== null && p.sessionId !== undefined) {
      if (typeof p.sessionId !== 'string' || !UUID_RE.test(p.sessionId as string)) {
        throw new Error(`${at}.sessionId must be null or a UUID (got ${JSON.stringify(p.sessionId)})`);
      }
    }
    const renew = (p.renew === undefined ? 'onMismatch' : p.renew) as 'always' | 'onMismatch';
    if (renew !== 'always' && renew !== 'onMismatch') {
      throw new Error(`${at}.renew must be "always" or "onMismatch" (got ${JSON.stringify(p.renew)})`);
    }
    return {
      name: p.name as string,
      workdir: p.workdir as string,
      args: p.args as string,
      sessionId: (p.sessionId as string | null | undefined) ?? null,
      renew,
      parsedArgs,
    };
  });

  const channels: NormalizedChannel[] = (s.channels as Record<string, unknown>[]).map((c, i) => {
    const at = `channels[${i}]`;
    if (!c || typeof c !== 'object') throw new Error(`${at} must be an object`);
    if (typeof c.from !== 'string' || !names.has(dupKey(c.from as string))) {
      throw new Error(`${at}.from must name a declared peer (got ${JSON.stringify(c.from)})`);
    }
    if (typeof c.to !== 'string' || !names.has(dupKey(c.to as string))) {
      throw new Error(`${at}.to must name a declared peer (got ${JSON.stringify(c.to)})`);
    }
    if (dupKey(c.from as string) === dupKey(c.to as string)) throw new Error(`${at}.from and .to must differ`);
    if (typeof c.label !== 'string' || (c.label as string).trim() === '') {
      throw new Error(`${at}.label must be a non-empty string`);
    }
    // The label becomes a FILENAME component (`<sid>-<label>.json`), and the
    // peer names are woven into the channel title. Reject any label that could
    // escape the channels directory or is illegal in a filename — e.g.
    // `x/../../identity` once overwrote the machine-wide identity.json,
    // `x/../../heartbeat/<sid>` clobbered a peer's heartbeat.
    sanitizeId(c.label, `${at}.label`);
    if (typeof c.prompt !== 'string') {
      throw new Error(`${at}.prompt must be a string (may be empty)`);
    }
    return { from: c.from as string, to: c.to as string, label: c.label as string, prompt: c.prompt as string };
  });

  // Reject duplicate channel labels (they collide on filename / channelId).
  // Compared case-folded + NFC-normalized: Windows filesystems are
  // case-insensitive, so `L` and `l` would silently collide onto ONE file
  // (the second overwriting the first while status claimed both were intact).
  const labels = new Set<string>();
  for (const c of channels) {
    const key = dupKey(c.label);
    if (labels.has(key)) throw new Error(`duplicate channel label: "${c.label}"`);
    labels.add(key);
  }

  return { group: s.group as string, peers, channels };
}

/**
 * Re-read the raw spec file, apply `mutate(raw)` to it, and write it back with
 * a stable 2-space indent. Used to persist minted session ids without losing
 * fields the validator doesn't model.
 *
 * The write is ATOMIC (tmp + rename) for the same reason channel writes are:
 * the minted session ids this persists are the sole resume prerequisite, so a
 * crash mid-write must not leave a truncated spec that no longer parses.
 */
export function updateSpecFile(file: string, mutate: (raw: Record<string, unknown>) => void): void {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  mutate(raw);
  const tmp = `${file}.mycc-compose.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, file);
}