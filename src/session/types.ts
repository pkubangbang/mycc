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
}