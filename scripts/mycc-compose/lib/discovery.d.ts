/**
 * Type declarations for scripts/mycc-compose/lib/discovery.js.
 *
 * The implementation is plain ESM JavaScript (so a plain `node` process can
 * load it — see the .js header). TypeScript resolves the `./discovery.js`
 * import specifier against this file, so the launcher/liveness tests at
 * src/tests/mycc-compose-peers.test.ts are fully type-checked even though
 * `allowJs` stays false. Same pattern as the sibling spec.d.ts / channels.d.ts.
 */

/** Root of all peer discovery state (overridable via MYCC_DISCOVERY_DIR). */
export declare const DISCOVERY_DIR: string;

/** Machine-wide identity registry: { [sessionId]: IdentityEntry }. */
export declare const IDENTITY_FILE: string;

/** Per-session heartbeat directory. */
export declare const HEARTBEAT_DIR: string;

/** Per-session channel file directory. */
export declare const CHANNELS_DIR: string;

/** A heartbeat older than this window is not evidence of liveness (ms). */
export declare const FRESHNESS_WINDOW_MS: number;

/** The subset of a peer record discovery needs in order to answer "is it running?". */
export interface PeerRef {
  name?: string;
  sessionId?: string | null;
  workdir?: string;
}

/** One identity registry entry as written by the running mycc instance. */
export interface IdentityEntry {
  sessionId?: string;
  pid?: number;
  workdir?: string;
  args?: string;
  updatedAt?: number;
  /** Anything else the instance may publish; discovery never assumes its shape. */
  [key: string]: unknown;
}

/** One heartbeat document as written by the running mycc instance. */
export interface HeartbeatData {
  pid?: number;
  sessionId?: string;
  updatedAt?: number;
  brief?: string;
  [key: string]: unknown;
}

/** Read the whole identity registry; {} when absent / unreadable / malformed. */
export declare function readIdentityMap(): Record<string, IdentityEntry>;

/** Read one session's heartbeat document; null when absent / unreadable / malformed. */
export declare function readHeartbeatData(sessionId: string): HeartbeatData | null;

/** True when the session's heartbeat is within FRESHNESS_WINDOW_MS of now. */
export declare function isSessionLive(sessionId: string): boolean;

/** True when the OS reports `pid` as a live process. */
export declare function isPidAlive(pid: number): boolean;

/** True when the pid recorded in the session's heartbeat is alive. */
export declare function isRecordedPidAlive(sessionId: string): boolean;

/** Absolute process start time in epoch ms, or null when not introspectable. */
export declare function getProcessStartTime(pid: number): number | null;

/**
 * True when `pid` provably started AFTER `notBeforeMs`. Used to refuse a killed
 * pid that the OS has recycled. Returns false when it cannot prove it.
 */
export declare function didPidStartAfter(pid: number, notBeforeMs: number): boolean;

/** The session's live pid: identity pid when alive, else the heartbeat pid. */
export declare function peerPid(sessionId: string): number | null;

/** The pid recorded in the session's heartbeat document, or null. */
export declare function heartbeatPid(sessionId: string): number | null;

/** Mtime (epoch ms) of the session's heartbeat file, or null when absent. */
export declare function heartbeatFileMtimeMs(sessionId: string): number | null;

/** Combined liveness: fresh heartbeat AND a live recorded pid. */
export declare function isPeerRunning(peer: PeerRef): boolean;

/** The most recent brief string for a session, or null. */
export declare function lastBrief(sessionId: string): string | null;

/** Atomically replace the identity registry with `map`. */
export declare function writeIdentityMap(map: Record<string, IdentityEntry>): void;
