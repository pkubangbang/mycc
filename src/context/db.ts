/**
 * db.ts - SQLite database setup and schema
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MYCC_DIR = '.mycc';
const DB_PATH = path.join(MYCC_DIR, 'state.db');

let db: Database.Database | null = null;
let currentSessionId: string | null = null;

/**
 * Set the current session context (called once at startup)
 */
export function setSessionContext(sessionId: string): void {
  currentSessionId = sessionId;
}

/**
 * Get the current session ID
 * @throws Error if session context not initialized
 */
export function getSessionContext(): string {
  if (!currentSessionId) {
    throw new Error('Session context not initialized. Call setSessionContext() first.');
  }
  return currentSessionId;
}

/**
 * Get or create the database connection
 */
export function getDb(): Database.Database {
  if (!db) {
    // Ensure .mycc directory exists
    if (!fs.existsSync(MYCC_DIR)) {
      fs.mkdirSync(MYCC_DIR, { recursive: true });
    }

    db = new Database(DB_PATH);

    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');

    // Initialize schema
    initSchema(db);
  }
  return db;
}

/**
 * Initialize database schema (includes session_id for new databases)
 */
function initSchema(db: Database.Database): void {
  // Issues table
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT,
      status TEXT DEFAULT 'pending',
      owner TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      comments TEXT DEFAULT '[]',
      session_id TEXT NOT NULL DEFAULT ''
    )
  `);

  // Issue blockages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_blockages (
      blocker_id INTEGER NOT NULL,
      blocked_id INTEGER NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (blocker_id, blocked_id),
      FOREIGN KEY (blocker_id) REFERENCES issues(id),
      FOREIGN KEY (blocked_id) REFERENCES issues(id)
    )
  `);

  // Teammates table
  db.exec(`
    CREATE TABLE IF NOT EXISTS teammates (
      name TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      status TEXT DEFAULT 'idle',
      prompt TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      session_id TEXT NOT NULL DEFAULT ''
    )
  `);

  // Worktrees table
  db.exec(`
    CREATE TABLE IF NOT EXISTS worktrees (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      session_id TEXT NOT NULL DEFAULT ''
    )
  `);

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
    CREATE INDEX IF NOT EXISTS idx_issues_owner ON issues(owner);
    CREATE INDEX IF NOT EXISTS idx_issue_blockages_blocker ON issue_blockages(blocker_id);
    CREATE INDEX IF NOT EXISTS idx_issue_blockages_blocked ON issue_blockages(blocked_id);
    CREATE INDEX IF NOT EXISTS idx_issues_session ON issues(session_id);
    CREATE INDEX IF NOT EXISTS idx_issues_session_status ON issues(session_id, status);
    CREATE INDEX IF NOT EXISTS idx_teammates_session ON teammates(session_id);
    CREATE INDEX IF NOT EXISTS idx_worktrees_session ON worktrees(session_id);
    CREATE INDEX IF NOT EXISTS idx_blockages_session ON issue_blockages(session_id);
  `);

  // Migrate legacy databases (only if session_id missing)
  migrateLegacySchema(db);
}

/**
 * Migrate legacy schema to add session_id columns
 * Only runs if database was created before session isolation was implemented
 */
function migrateLegacySchema(db: Database.Database): void {
  // Check if session_id column exists in issues table
  const columns = db.prepare(`PRAGMA table_info(issues)`).all() as { name: string }[];
  const hasSessionId = columns.some(col => col.name === 'session_id');

  if (hasSessionId) {
    // Schema is up-to-date, no migration needed
    return;
  }

  // Legacy database detected - add session_id columns
  db.exec(`ALTER TABLE issues ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`);
  db.exec(`ALTER TABLE issue_blockages ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`);
  db.exec(`ALTER TABLE teammates ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`);
  db.exec(`ALTER TABLE worktrees ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`);

  // Create indexes for session-scoped queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_session ON issues(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_session_status ON issues(session_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_teammates_session ON teammates(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_worktrees_session ON worktrees(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_blockages_session ON issue_blockages(session_id)`);
}

/**
 * Close the database connection
 * Must be called on shutdown to prevent process hang
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Clear session data for the current session only
 * Clears SQLite tables and mail files for current session
 */
export function clearSessionData(): void {
  const database = getDb();
  const sessionId = currentSessionId;

  if (sessionId) {
    // Session-scoped clear: only delete data for this session
    database.prepare('DELETE FROM issue_blockages WHERE session_id = ?').run(sessionId);
    database.prepare('DELETE FROM issues WHERE session_id = ?').run(sessionId);
    database.prepare('DELETE FROM teammates WHERE session_id = ?').run(sessionId);
    database.prepare('DELETE FROM worktrees WHERE session_id = ?').run(sessionId);
  } else {
    // No session context (legacy behavior during migration)
    // Clear all tables
    database.exec(`
      DELETE FROM issue_blockages;
      DELETE FROM issues;
      DELETE FROM teammates;
      DELETE FROM worktrees;
    `);
  }

  // Clear mail files (mail is per-recipient, not session-scoped yet)
  // TODO: Consider making mail session-scoped in future
  const mailDir = getMailDir();
  if (fs.existsSync(mailDir)) {
    const mailFiles = fs.readdirSync(mailDir).filter(f => f.endsWith('.jsonl'));
    for (const file of mailFiles) {
      fs.unlinkSync(path.join(mailDir, file));
    }
  }
}

/**
 * Get the .mycc directory path
 */
export function getMyccDir(): string {
  return path.resolve(MYCC_DIR);
}

/**
 * Get the mail directory path
 */
export function getMailDir(): string {
  return path.join(MYCC_DIR, 'mail');
}

/**
 * Get the tools directory path
 */
export function getToolsDir(): string {
  return path.join(MYCC_DIR, 'tools');
}

/**
 * Get the skills directory path
 */
export function getSkillsDir(): string {
  return path.join(MYCC_DIR, 'skills');
}

/**
 * Get the sessions directory path
 */
export function getSessionsDir(): string {
  return path.join(MYCC_DIR, 'sessions');
}

/**
 * Get the longtext directory path (for large tool results)
 */
export function getLongtextDir(): string {
  return path.join(MYCC_DIR, 'longtext');
}

/**
 * Get the user-level tools directory path (~/.mycc/tools)
 */
export function getUserToolsDir(): string {
  return path.join(os.homedir(), '.mycc', 'tools');
}

/**
 * Get the user-level skills directory path (~/.mycc/skills)
 */
export function getUserSkillsDir(): string {
  return path.join(os.homedir(), '.mycc', 'skills');
}

/**
 * Get the wiki directory path (~/.mycc/wiki)
 */
export function getWikiDir(): string {
  return path.join(os.homedir(), '.mycc', 'wiki');
}

/**
 * Get the wiki logs directory path (~/.mycc/wiki/logs)
 */
export function getWikiLogsDir(): string {
  return path.join(getWikiDir(), 'logs');
}

/**
 * Get the wiki db directory path (~/.mycc/wiki/db)
 */
export function getWikiDbDir(): string {
  return path.join(getWikiDir(), 'db');
}

/**
 * Get the wiki domains file path (~/.mycc/wiki/domains.json)
 */
export function getWikiDomainsFile(): string {
  return path.join(getWikiDir(), 'domains.json');
}

/**
 * Ensure all runtime directories exist
 */
export function ensureDirs(): void {
  const dirs = [MYCC_DIR, getMailDir(), getToolsDir(), getSkillsDir(), getSessionsDir(), getLongtextDir()];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  // Wiki directories are in ~/.mycc, not project .mycc
  const wikiDirs = [getWikiDir(), getWikiLogsDir(), getWikiDbDir()];
  for (const dir of wikiDirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}