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
 * Read a peer's normalized `remotes` as a real `string[]` (empty when absent).
 *
 * Why an accessor instead of reading `peer.remotes` directly: `NormalizedPeer`
 * carries an index signature `[key: string]: unknown` (so it is assignable to
 * the looser `Peer` type in peers.ts). When a consumer reads `peer.remotes`,
 * TypeScript resolves it THROUGH the index signature (→ `unknown`/`{}`) rather
 * than the declared `remotes?: string[]`, so `.map`/`.length`/iteration all
 * fail (tsconfig.scripts.json: "Property 'map' does not exist on type '{}'").
 *
 * The parameter type carries its OWN `[key: string]: unknown` index signature
 * (mirroring NormalizedPeer's): without it TS treats `{ remotes?: string[] }`
 * as a WEAK type (all-optional properties) and rejects a `NormalizedPeer`
 * argument with TS2559 "no properties in common" — the index signature on the
 * argument side does not count as a declared member for weak-type overlap.
 * Adding the index signature to the parameter satisfies weak-type assignability
 * while keeping this helper decoupled from the `NormalizedPeer` name.
 */
export function getRemotes(peer: { remotes?: string[]; [key: string]: unknown }): string[] {
  return Array.isArray(peer.remotes) ? peer.remotes : [];
}

/**
 * Normalize a remote URL to a canonical key for duplicate + mutual-dial
 * detection: trimmed, trailing slashes stripped, scheme + host lowercased.
 * The port is preserved as-authored (so `http://H:3191` and `http://h:3191`
 * fold together but `http://h:3191` and `http://h:3192` do not). Path/query
 * are dropped — a remote serve endpoint is a host:port, not a path (the wire
 * dials `/peer/ws` on whatever host:port is given; an authored path would be
 * ignored by parseWireTarget, so two URLs differing only by path are the same
 * endpoint and must dedupe).
 */
function remoteUrlKey(raw: string): string {
  let u = raw.trim().replace(/\/+$/, '');
  const schemeMatch = u.match(/^(https?):\/\/(.+)$/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    let rest = schemeMatch[2];
    const slash = rest.indexOf('/');
    if (slash >= 0) rest = rest.slice(0, slash); // drop path/query
    // Lowercase the host (before the port colon); keep IPv6 brackets intact.
    const lastColon = rest.lastIndexOf(':');
    if (lastColon > 0 && /^\d+$/.test(rest.slice(lastColon + 1))) {
      const host = rest.slice(0, lastColon).toLowerCase();
      const port = rest.slice(lastColon + 1);
      u = `${scheme}://${host}:${port}`;
    } else {
      u = `${scheme}://${rest.toLowerCase()}`;
    }
  } else {
    // Bare host:port (no scheme) — parseWireTarget treats it as http. Fold
    // the host case the same way.
    const slash = u.indexOf('/');
    if (slash >= 0) u = u.slice(0, slash);
    const lastColon = u.lastIndexOf(':');
    if (lastColon > 0 && /^\d+$/.test(u.slice(lastColon + 1))) {
      u = `${u.slice(0, lastColon).toLowerCase()}:${u.slice(lastColon + 1)}`;
    } else {
      u = u.toLowerCase();
    }
  }
  return u;
}

/**
 * Validate + normalize ONE peer's `remotes` field. Returns the normalized
 * string[] (or undefined when absent/empty). Enforces:
 *   - must be an array of strings (if present); undefined/[] = no remotes.
 *   - each URL parses via `new URL(u)` with scheme ∈ {http, https} and a
 *     non-empty hostname. (A bare `host:port` without a scheme is accepted
 *     too — parseWireTarget handles it — by prepending `http://` for the
 *     URL-constructor check only; the stored value keeps the author's form.)
 *   - no DUPLICATE URLs within this peer's list (compared via remoteUrlKey).
 *   - no SELF-DIAL: a remote URL whose host is localhost/127.0.0.1 AND whose
 *     port equals THIS peer's own `--serve` port (extracted from parsedArgs).
 *     The spec cannot know the peer's external hostname, so host-identity is
 *     matched only on the loopback aliases; a non-loopback self-dial (the
 *     peer's LAN IP) is not caught here — connectPeer's same-store sid filter
 *     (wire-client.ts step 1.5) is the backstop for that.
 *
 * The CROSS-PEER mutual-dial rule (same URL declared by two different peers)
 * runs in validateSpec AFTER the peers array is built — it needs every peer's
 * normalized list. See docs/remotes-design-decision.md §"Direction / dedupe".
 */
function normalizeRemotes(
  p: Record<string, unknown>,
  at: string,
  parsedArgs: Record<string, unknown>,
): string[] | undefined {
  if (p.remotes === undefined || p.remotes === null) return undefined;
  if (!Array.isArray(p.remotes)) {
    throw new Error(`${at}.remotes must be an array of URL strings (got ${typeof p.remotes})`);
  }
  if (p.remotes.length === 0) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  // This peer's own serve port for self-dial rejection. `--serve` parses to
  // true (bare) or a number/string (with value). A bare `--serve` uses the
  // default port 3173, but the author did not name a port so we cannot know it
  // matches a remote port precisely — only an EXPLICIT --serve <port> is a
  // reliable self-dial signal. (config.ts getServePort applies the same rule.)
  const ownServe = parsedArgs.serve;
  const ownPort = typeof ownServe === 'number' ? ownServe
    : (typeof ownServe === 'string' && /^\d+$/.test(ownServe) ? Number(ownServe) : null);
  for (let j = 0; j < p.remotes.length; j++) {
    const rAt = `${at}.remotes[${j}]`;
    const raw = p.remotes[j];
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error(`${rAt} must be a non-empty URL string`);
    }
    // parseWireTarget accepts bare host:port (no scheme). For the URL-
    // constructor scheme/host check, normalize to http:// when no scheme.
    // BUT: a non-http scheme on the AUTHORED value (ws://, ftp://, ...) must
    // be rejected on its OWN merits BEFORE the prepend — otherwise `ws://h:1`
    // becomes `http://ws://h:1`, `new URL` parses host `ws` (protocol http:),
    // and both the scheme + host checks pass while the author asked for ws.
    const authoredScheme = /^([a-z][a-z0-9+.\-]*):\/\//i.exec(raw);
    if (authoredScheme) {
      const s = authoredScheme[1].toLowerCase();
      if (s !== 'http' && s !== 'https') {
        throw new Error(`${rAt} must use http or https (got "${s}" in "${raw}")`);
      }
    }
    const forCheck = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    let u: URL;
    try {
      u = new URL(forCheck);
    } catch {
      throw new Error(`${rAt} is not a valid URL: "${raw}"`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`${rAt} must use http or https (got "${u.protocol.replace(':', '')}" in "${raw}")`);
    }
    // Empty-host check: `new URL('http:///path')` parses hostname as `"path"`
    // (Node collapses the empty authority), so u.hostname is non-empty even
    // though the author wrote no host. Reject when the AUTHORED host segment
    // (between `://` and the first `/` of the path) is empty or whitespace.
    if (authoredScheme) {
      const afterScheme = raw.slice(authoredScheme[0].length);
      const hostSeg = afterScheme.split('/')[0];
      if (hostSeg.trim() === '') {
        throw new Error(`${rAt} must have a non-empty host (got "${raw}")`);
      }
    } else if (!u.hostname) {
      // Bare host:port (no scheme) — rely on the constructor's hostname.
      throw new Error(`${rAt} must have a non-empty host (got "${raw}")`);
    }
    // Duplicate within this peer's list.
    const key = remoteUrlKey(raw);
    if (seen.has(key)) {
      throw new Error(`${at}.remotes has a duplicate URL: "${raw}"`);
    }
    seen.add(key);
    // Self-dial: loopback host + port == this peer's explicit --serve port.
    if (ownPort !== null) {
      const hostLower = u.hostname.toLowerCase();
      const isLoopback = hostLower === 'localhost' || hostLower === '127.0.0.1' || hostLower === '::1';
      const rPort = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
      if (isLoopback && rPort === ownPort) {
        throw new Error(
          `${rAt} is a self-dial: ${hostLower}:${rPort} is this peer's own --serve port ` +
          `(${ownPort}). Declare the dialer on exactly ONE side; the NAT'd peer dials out.`,
        );
      }
    }
    out.push(raw);
  }
  return out;
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
  const peers: NormalizedPeer[] = (s.peers as Record<string, unknown>[]).map((p, i): NormalizedPeer => {
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
    // remotes?: string[] — URLs of REMOTE mycc instances this local peer should
    // dial once up (see docs/remotes-design-decision.md). validateSpec enforces
    // per-URL + per-peer invariants here; the CROSS-PEER mutual-dial rule runs
    // after the peers array is built (it needs every peer's normalized list).
    // The `as string[] | undefined` is load-bearing: NormalizedPeer carries an
    // index signature `[key: string]: unknown`, which would otherwise widen
    // this field to `{}` and break every downstream `.map`/`.length`/iteration
    // (tsconfig.scripts.json errors at cmd-up.ts:52/75/94 + spec.ts:308/309).
    const remotes = normalizeRemotes(p, at, parsedArgs);
    return {
      name: p.name as string,
      workdir: p.workdir as string,
      args: p.args as string,
      sessionId: (p.sessionId as string | null | undefined) ?? null,
      renew,
      remotes: remotes as string[] | undefined,
      parsedArgs,
    };
  });

  // Cross-peer MUTUAL-DIAL rejection (docs/remotes-design-decision.md
  // §"Direction / dedupe"): `remotes` is one-sided ("this peer dials URL Y").
  // If the SAME URL is declared by TWO different peers, that is the practical
  // mutual-dial signature for a 2-node spec — both sides would dial the same
  // endpoint, and the wire's pair-dedupe convergence would have to resolve it
  // at runtime instead of the spec refusing it up front. The rule the spec
  // enforces: a remote URL key (see remoteUrlKey) may appear in at most ONE
  // peer's list. (A richer "A dials B's URL and B dials A's URL" check needs
  // each peer's own serve endpoint as identity, which the spec does not
  // reliably carry; same-URL-across-peers is the sound, catch-all form.)
  const urlOwners = new Map<string, string>(); // remoteUrlKey → first peer name
  for (const peer of peers) {
    const peerRemotes = getRemotes(peer);
    if (peerRemotes.length === 0) continue;
    for (const raw of peerRemotes) {
      const key = remoteUrlKey(raw);
      const firstOwner = urlOwners.get(key);
      if (firstOwner) {
        throw new Error(
          `mutual dial rejected: remote URL "${raw}" is declared by both ` +
          `peer "${firstOwner}" and peer "${peer.name}". Declare the dialer on ` +
          `exactly ONE side (the NAT'd peer that cannot accept).`,
        );
      }
      urlOwners.set(key, peer.name);
    }
  }

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