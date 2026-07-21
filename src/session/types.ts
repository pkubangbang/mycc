/**
 * Session types for persistence and restoration
 */

/**
 * Session metadata stored in .mycc/sessions/session-{uuid}.json
 */
export interface Session {
  /** Session file format version */
  version: '2.0';
  /** Session ID (UUID from filename) */
  id: string;
  /** Creation timestamp (ISO 8601) */
  create_time: string;
  /** Project directory (process.cwd() at session start) */
  project_dir: string;
  /** Path to lead's triologue file */
  lead_triologue: string;
  /** List of child triologues */
  child_triologues: string[];
  /** List of teammate names */
  teammates: string[];
  /** User's first query (bookmark title, truncated) */
  first_query: string;
}

/**
 * Session list item for display
 */
export interface SessionDisplay {
  id: string;
  create_time: string;
  project_dir: string;
  teammates: string[];
  first_query: string;
  source: 'project' | 'user';
}

/**
 * Result of session initialization
 */
export interface SessionInit {
  sessionFilePath: string;
  triologuePath: string;
  restoredPair: import('./restoration.js').SummaryPair | null;
  initialQuery: string | null;
  /**
   * The session id this one was derived from, if any.
   *
   * - Set when the session was branched via `--from <id>` / `/fork` (the
   *   `restoreSession` path): the value is the SOURCE session's id (the old,
   *   now-sealed session). Surfaces like the startup banner use it to show
   *   "Session: <newId> (forked from <sourceId>)".
   * - null for a genuinely fresh session (`createNewSession`): there is no
   *   source, so the banner shows just "Session: <newId>".
   *
   * Note: this is metadata for display only — the new session is fully
   * independent (new id, new triologue file, new session json). The source
   * session's files stay read-only and are never written to.
   */
  sourceSessionId?: string | null;
}