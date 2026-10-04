/**
 * peers-types.ts — the shared vocabulary of the peer subsystem.
 *
 * Holds the types, the timing constants, and the two path/arg helpers that
 * derive purely from a `Peer` record. Every other peers-* module depends on
 * this one; nothing in here depends on them.
 */

import path from 'path';

import { formatLaunchArgs, LAUNCHER_FLAGS } from '../../../src/utils/arg-canonical.js';
import type { lastBrief } from './discovery.js';

// --- shapes ----------------------------------------------------------------

/**
 * A peer record as produced by validateSpec, or a hand-built fixture. The
 * module reads a SUBSET of the normalized peer shape, so every field is
 * optional except `parsedArgs`, which is the only one `peerArgv()` needs.
 */
export interface Peer {
  name?: string;
  workdir?: string;
  sessionId?: string | null;
  args?: string;
  renew?: 'always' | 'onMismatch';
  parsedArgs?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A peer's live status row (`mycc-compose status`). */
export interface PeerStatusRow {
  name: string;
  sessionId: string | null;
  live: boolean;
  matching: boolean;
  lastBrief: ReturnType<typeof lastBrief>;
}

// --- timing ----------------------------------------------------------------

/** How long to wait for a launched peer to register + beat, per peer. */
export const LAUNCH_TIMEOUT_MS = 30_000;
/** Poll interval while waiting for a launched peer to come up. */
export const LAUNCH_POLL_MS = 500;
/**
 * How long `launchPeer` waits for a previous holder of the same session id to
 * die before it refuses to spawn a duplicate (see the renew path in cmdUp:
 * `stopPeer` SIGTERMs, then the replacement starts while the old instance may
 * still be inside its graceful teardown).
 */
export const HOLDER_RELEASE_TIMEOUT_MS = 5_000;
/** Poll interval while waiting for a holder to release the session id. */
export const HOLDER_RELEASE_POLL_MS = 200;
/** Staged-wave size: launching ~20 at once drops identity registrations (§6.4). */
export const WAVE_SIZE = 5;
/** Delay between waves, giving identity.json writes time to settle. */
export const WAVE_DELAY_MS = 1_500;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- derived helpers -------------------------------------------------------

/**
 * The args string recorded in a repaired identity.json entry — the display
 * form of the peer's args, launcher-managed flags stripped. Mirrors what
 * register() would have stored, so a backfilled entry compares equal under
 * argsMatch (i.e. is a no-op for the next `up`).
 */
export function peerIdentityArgs(peer: Peer): string {
  return formatLaunchArgs(peer.parsedArgs ?? {});
}

/**
 * The mailbox path a peer's LEAD reads: <workdir>/.mycc/sessions/<sid>/
 * unread-lead.jsonl.
 *
 * This mirrors the lead's own convention (parent-context.ts:
 * `path.resolve(getSessionDir(sid), 'unread-lead.jsonl')`, where getSessionDir
 * joins MYCC_DIR='.mycc' against the process cwd = the peer's workdir). It MUST
 * be resolved against the peer's workdir, NOT os.homedir(): MailBox.sessionDir()
 * polls the project-local path, so a user-store mailbox registered here would
 * never be read — the peer reports `live` while the mail sits unconsumed
 * (the G3 root cause).
 */
export function peerMailboxPath(peer: Peer): string {
  return path.resolve(
    peer.workdir as string,
    '.mycc',
    'sessions',
    peer.sessionId as string,
    'unread-lead.jsonl',
  );
}

/** True when `key` is one of the flags the launcher owns (never spec-authored). */
export function isLauncherFlag(key: string): boolean {
  return LAUNCHER_FLAGS.includes(key);
}
