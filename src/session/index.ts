/**
 * session/index.ts - Session file management (stateless utilities)
 *
 * Sessions are JSON files stored in:
 * - Project sessions: .mycc/sessions/
 * - User sessions: ~/.mycc/sessions/
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Session, SessionFile, SessionDisplay } from './types.js';

/**
 * Get the project sessions directory path
 */
export function getSessionsDir(): string {
  return path.join('.mycc', 'sessions');
}

/**
 * Get the user sessions directory path (~/.mycc/sessions)
 */
export function getUserSessionsDir(): string {
  return path.join(os.homedir(), '.mycc', 'sessions');
}

/**
 * Ensure a directory exists
 */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Create a new session file on fresh start.
 *
 * @param initial - Initial session data
 * @returns Object containing path and id
 */
export function createSessionFile(lead_triologue: string): string {
  const sessionsDir = getSessionsDir();
  ensureDir(sessionsDir);

  const now = new Date();
  const id = randomUUID();
  const filename = `${id}.json`;

  const session: SessionFile = {
    version: '1.0',
    id,
    create_time: now.toISOString(),
    project_dir: process.cwd(),
    lead_triologue: lead_triologue,
    child_triologues: [],
    teammates: [],
    first_query: '',
  };

  const filePath = path.join(sessionsDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');

  return filePath;
}

/**
 * Read a session file
 *
 * @param filePath - Path to session file
 * @returns Session object or null if not found/invalid
 */
export function readSession(filePath: string): Session | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const session = JSON.parse(content) as SessionFile;
    // Validate required fields
    if (!session.id || !session.create_time) {
      console.warn(`Session file missing required fields: ${filePath}`);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

/**
 * Write a session file (atomic)
 *
 * @param filePath - Path to session file
 * @param session - Session object to write
 */
export function writeSession(filePath: string, session: Session): void {
  const sessionFile: SessionFile = {
    version: '1.0',
    ...session,
  };
  fs.writeFileSync(filePath, JSON.stringify(sessionFile, null, 2), 'utf-8');
}

/**
 * Get session file path by ID
 *
 * @param id - Session ID (UUID)
 * @param preferUser - Prefer user session over project session
 * @returns Path to session file or null if not found
 */
export function getSessionPathById(id: string, preferUser = true): string | null {
  const userSessionPath = path.join(getUserSessionsDir(), `${id}.json`);
  const projectSessionPath = path.join(getSessionsDir(), `${id}.json`);

  if (preferUser && fs.existsSync(userSessionPath)) {
    return userSessionPath;
  }
  if (fs.existsSync(projectSessionPath)) {
    return projectSessionPath;
  }
  if (!preferUser && fs.existsSync(userSessionPath)) {
    return userSessionPath;
  }
  return null;
}

/**
 * Load a session by ID
 *
 * @param id - Session ID (UUID or partial)
 * @returns Session object or null if not found
 */
export function loadSessionById(id: string): Session | null {
  // Support partial ID matching (first 6+ characters)
  const sessionPath = findSessionPath(id);
  if (!sessionPath) {
    return null;
  }
  return readSession(sessionPath);
}

/**
 * Find session path by ID (supports partial IDs)
 *
 * @param id - Session ID (full or partial)
 * @returns Path to session file or null if not found
 */
function findSessionPath(id: string): string | null {
  // Try exact match first
  const exactUser = path.join(getUserSessionsDir(), `${id}.json`);
  const exactProject = path.join(getSessionsDir(), `${id}.json`);

  if (fs.existsSync(exactUser)) return exactUser;
  if (fs.existsSync(exactProject)) return exactProject;

  // Try partial match (at least 6 characters)
  if (id.length >= 6) {
    // Search in user sessions
    const userDir = getUserSessionsDir();
    if (fs.existsSync(userDir)) {
      const files = fs.readdirSync(userDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const fileId = file.replace('.json', '');
        if (fileId.startsWith(id)) {
          return path.join(userDir, file);
        }
      }
    }

    // Search in project sessions
    const projectDir = getSessionsDir();
    if (fs.existsSync(projectDir)) {
      const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const fileId = file.replace('.json', '');
        if (fileId.startsWith(id)) {
          return path.join(projectDir, file);
        }
      }
    }
  }

  return null;
}

/**
 * List all available sessions (project + user)
 *
 * @returns Array of session list items
 */
export function listSessions(): SessionDisplay[] {
  const sessions: SessionDisplay[] = [];
  const seenIds = new Set<string>();

  // Read project sessions
  const projectDir = getSessionsDir();
  if (fs.existsSync(projectDir)) {
    const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const sessionPath = path.join(projectDir, file);
      const session = readSession(sessionPath);
      if (session) {
        seenIds.add(session.id);
        sessions.push({
          id: session.id,
          create_time: session.create_time,
          project_dir: session.project_dir,
          teammates: session.teammates,
          first_query: session.first_query,
          source: 'project',
        });
      }
    }
  }

  // Read user sessions (user sessions shadow project sessions)
  const userDir = getUserSessionsDir();
  if (fs.existsSync(userDir)) {
    const files = fs.readdirSync(userDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const sessionPath = path.join(userDir, file);
      const session = readSession(sessionPath);
      if (session) {
        if (seenIds.has(session.id)) {
          // Remove project session, add user session
          const idx = sessions.findIndex((s) => s.id === session.id);
          if (idx >= 0) {
            sessions.splice(idx, 1);
          }
        }
        sessions.push({
          id: session.id,
          create_time: session.create_time,
          project_dir: session.project_dir,
          teammates: session.teammates,
          first_query: session.first_query,
          source: 'user',
        });
      }
    }
  }

  // Sort by creation time (newest first)
  sessions.sort((a, b) => b.create_time.localeCompare(a.create_time));

  return sessions;
}

/**
 * Save session to user directory
 *
 * @param sessionPath - Path to project session file
 * @returns Path to saved user session file
 */
export function saveToUserDir(sessionPath: string): string {
  const session = readSession(sessionPath);
  if (!session) {
    throw new Error(`Cannot save: session file not found: ${sessionPath}`);
  }

  const userDir = getUserSessionsDir();
  ensureDir(userDir);

  const destPath = path.join(userDir, `${session.id}.json`);
  fs.copyFileSync(sessionPath, destPath);

  return destPath;
}

/**
 * Validate a session (check all referenced files exist)
 *
 * @param session - Session object
 * @returns Validation result with list of missing files
 */
export function validateSession(session: Session): { valid: boolean; missingFiles: string[] } {
  const missingFiles: string[] = [];

  // Check lead triologue
  if (!fs.existsSync(session.lead_triologue)) {
    missingFiles.push(session.lead_triologue);
  }

  // Check child triologues
  for (const triologuePath of session.child_triologues) {
    if (!fs.existsSync(triologuePath)) {
      missingFiles.push(triologuePath);
    }
  }

  return {
    valid: missingFiles.length === 0,
    missingFiles,
  };
}

/**
 * Get session ID from file path
 *
 * @param filePath - Path to session file
 * @returns Session ID (UUID)
 */
export function getSessionId(filePath: string): string {
  return path.basename(filePath, '.json');
}

/**
 * Clean up empty session files (sessions with no first_query)
 *
 * @param currentSessionId - Session ID to preserve (the current session)
 * @returns Number of removed empty sessions
 */
export function cleanupEmptySessions(currentSessionId: string): number {
  let removed = 0;

  // Clean up project sessions
  const projectDir = getSessionsDir();
  if (fs.existsSync(projectDir)) {
    const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const sessionPath = path.join(projectDir, file);
      const session = readSession(sessionPath);
      if (session && !session.first_query && session.id !== currentSessionId) {
        fs.unlinkSync(sessionPath);
        removed++;
      }
    }
  }

  // Clean up user sessions
  const userDir = getUserSessionsDir();
  if (fs.existsSync(userDir)) {
    const files = fs.readdirSync(userDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const sessionPath = path.join(userDir, file);
      const session = readSession(sessionPath);
      if (session && !session.first_query && session.id !== currentSessionId) {
        fs.unlinkSync(sessionPath);
        removed++;
      }
    }
  }

  return removed;
}