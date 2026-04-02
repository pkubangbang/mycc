/**
 * db.ts - SQLite database setup and schema
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const MYCC_DIR = '.mycc';
const DB_PATH = path.join(MYCC_DIR, 'state.db');

let db: Database.Database | null = null;

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
 * Initialize database schema
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
      comments TEXT DEFAULT '[]'
    )
  `);

  // Issue blockages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_blockages (
      blocker_id INTEGER NOT NULL,
      blocked_id INTEGER NOT NULL,
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Worktrees table
  db.exec(`
    CREATE TABLE IF NOT EXISTS worktrees (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
    CREATE INDEX IF NOT EXISTS idx_issues_owner ON issues(owner);
    CREATE INDEX IF NOT EXISTS idx_issue_blockages_blocker ON issue_blockages(blocker_id);
    CREATE INDEX IF NOT EXISTS idx_issue_blockages_blocked ON issue_blockages(blocked_id);
  `);
}

/**
 * Close database connection
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Clear all session data (for clean startup)
 * Clears SQLite tables and mail files
 */
export function clearSessionData(): void {
  const database = getDb();

  // Clear all tables
  database.exec(`
    DELETE FROM issue_blockages;
    DELETE FROM issues;
    DELETE FROM teammates;
    DELETE FROM worktrees;
  `);

  // Clear mail files
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
 * Ensure all runtime directories exist
 */
export function ensureDirs(): void {
  const dirs = [MYCC_DIR, getMailDir(), getToolsDir(), getSkillsDir()];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}