/**
 * Type declarations for scripts/mycc-compose/lib/peers.js.
 *
 * The implementation is plain ESM JavaScript (so a plain `node` process can
 * load it — see the .js header). TypeScript resolves the `./peers.js` import
 * specifier against this file, so the launcher/liveness tests at
 * src/tests/mycc-compose-peers.test.ts are fully type-checked even though
 * `allowJs` stays false. Same pattern as the sibling spec.d.ts / channels.d.ts.
 */

import type { PeerRef, IdentityEntry } from './discovery.js';

/** Total time a launched peer has to publish a fresh heartbeat (ms). */
export declare const LAUNCH_TIMEOUT_MS: number;

/** Poll interval while waiting for a launched peer's heartbeat (ms). */
export declare const LAUNCH_POLL_MS: number;

/** How long to wait for a previous holder to release a session id (ms). */
export declare const HOLDER_RELEASE_TIMEOUT_MS: number;

/** Poll interval while waiting for a holder release (ms). */
export declare const HOLDER_RELEASE_POLL_MS: number;

/** Peers launched per staged wave. */
export declare const WAVE_SIZE: number;

/** Delay between launch waves (ms). */
export declare const WAVE_DELAY_MS: number;

/**
 * A peer record as produced by validateSpec (see spec.d.ts), or a hand-built
 * fixture. The module reads a SUBSET of the normalized peer shape, so this
 * contract mirrors what peers.js actually reads rather than the full
 * NormalizedPeer: every field is optional except `parsedArgs`, which is the
 * only one `peerArgv()` needs. Declaring the normalized shape here instead
 * produced false TS2345 errors in tests that build partial literals.
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

/** Outcome of a launch attempt. */
export interface LaunchResult {
  status: string;
  pid?: number | null;
  reason?: string;
  code?: number | null;
  [key: string]: unknown;
}

/** A peer's live status row (`mycc-compose status`). */
export interface PeerStatusRow {
  name: string;
  sessionId: string | null;
  matched: boolean;
  running: boolean;
  pid: number | null;
  lastBrief: string | null;
  [key: string]: unknown;
}

/** Result of an identity repair pass. */
export interface RepairResult {
  repaired: string[];
  skipped?: string[];
  [key: string]: unknown;
}

export declare function sleep(ms: number): Promise<void>;

/** True when two workdirs denote the same directory. */
export declare function sameWorkdir(a: string, b: string): boolean;

/** The identity entry that matches this peer (same sid + workdir + args), or null. */
export declare function findMatchingLiveEntry(peer: Peer): IdentityEntry | null;

/** Build the argv for launching this peer (non-redacting; secrets are real values). */
export declare function peerArgv(peer: Peer): string[];

/** True only when `pid` is provably THIS mycc instance's process for `sessionId`. */
export declare function isMyccProcess(pid: number, sessionId?: string | null): boolean;

/** Stop the peer if it is ours to stop; refuses a recycled pid. */
export declare function stopPeer(peer: Peer): { stopped: boolean; reason?: string; pid?: number | null; [key: string]: unknown };

/** Wait until no live process still holds `sessionId` (or the timeout lapses). */
export declare function waitForHolderRelease(sessionId: string, timeoutMs?: number): Promise<boolean>;

/** True when a live process currently holds `sessionId`. */
export declare function isSessionHeld(sessionId: string): boolean;

/** Resolve the mycc executable path used to spawn peers. */
export declare function resolveMyccBin(): string;

/** Spawn a peer detached and resolve once it is provably up (or reject). */
export declare function launchPeer(peer: Peer): Promise<LaunchResult>;

/** Re-read/merge/write the identity registry, preserving concurrent registrations. */
export declare function repairIdentity(peers: Peer[]): RepairResult;

/** Compute a peer's live status row. */
export declare function peerStatus(peer: Peer): PeerStatusRow;

export type { PeerRef };
