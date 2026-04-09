/**
 * Session types for persistence and restoration
 */

/**
 * Session metadata stored in .mycc/sessions/session-{uuid}.json
 */
export interface Session {
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
 * Session file format (stored as JSON)
 */
export interface SessionFile extends Session {
  version: '1.0';
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