/**
 * session/index.ts - Session file management (stateless utilities)
 *
 * Sessions are stored in per-ID subdirectories:
 * - Project sessions: .mycc/sessions/{session-id}/session-{sessionid}.json
 * - User sessions: ~/.mycc-store/sessions/{session-id}/session-{sessionid}.json
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import type { Session, SessionDisplay, SessionInit } from './types.js';
import { prepareRestoration, readDosq, extractFirstQuery } from './restoration.js';
import { setSessionContext, getSessionArg } from '../config.js';
import { clearAll } from '../context/memory-store.js';
import { agentIO } from '../loop/agent-io.js';
import { openEditor } from '../utils/open-editor.js';

/**
 * Result of matching a session ID
 */
export interface SessionMatch {
  id: string;
  path: string;
  source: 'user' | 'project';
}

/**
 * Error thrown when a session is not found
 */
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

/**
 * Error thrown when multiple sessions match a partial ID
 */
export class AmbiguousSessionError extends Error {
  constructor(public readonly sessionId: string, public readonly matches: SessionMatch[]) {
    super(`Ambiguous session ID: ${sessionId}. Multiple matches found.`);
    this.name = 'AmbiguousSessionError';
  }
}

/**
 * Get the project sessions directory path
 */
export function getSessionsDir(): string {
  return path.join('.mycc', 'sessions');
}

/**
 * Get the user sessions directory path (~/.mycc-store/sessions)
 */
export function getUserSessionsDir(): string {
  return path.join(os.homedir(), '.mycc-store', 'sessions');
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
 * Creates a subdirectory .mycc/sessions/{id}/ and writes session-{id}.json inside it.
 *
 * @param lead_triologue - Path to the lead's triologue file
 * @param id - Optional session ID (UUID). If not provided, a new one is generated.
 * @returns Path to the session file
 */
export function createSessionFile(lead_triologue: string, id?: string): string {
  const sessionsDir = getSessionsDir();
  ensureDir(sessionsDir);

  const now = new Date();
  const sessionId = id || randomUUID();
  const sessionDir = path.join(sessionsDir, sessionId);
  ensureDir(sessionDir);
  const filename = `session-${sessionId}.json`;

  const session: Session = {
    version: '2.0',
    id: sessionId,
    create_time: now.toISOString(),
    project_dir: process.cwd(),
    lead_triologue,
    child_triologues: [],
    teammates: [],
    first_query: '',
  };

  const filePath = path.join(sessionDir, filename);
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
    const session = JSON.parse(content) as Session;
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
  const sessionFile: Session = {
    ...session,
    version: '2.0',
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
  const userSessionPath = path.join(getUserSessionsDir(), id, `session-${id}.json`);
  const projectSessionPath = path.join(getSessionsDir(), id, `session-${id}.json`);

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
 * @returns Session object
 * @throws SessionNotFoundError if session not found
 * @throws AmbiguousSessionError if multiple sessions match the partial ID
 */
export function loadSessionById(id: string): Session {
  const matches = findSessionPaths(id);

  if (matches.length === 0) {
    throw new SessionNotFoundError(id);
  }

  if (matches.length > 1) {
    throw new AmbiguousSessionError(id, matches);
  }

  const session = readSession(matches[0].path);
  if (!session) {
    throw new SessionNotFoundError(id);
  }

  return session;
}

/**
 * Find all session paths matching an ID (supports partial IDs)
 *
 * @param id - Session ID (full or partial)
 * @returns Array of matching session paths with metadata
 */
export function findSessionPaths(id: string): SessionMatch[] {
  const matches: SessionMatch[] = [];

  // Try exact match first (subdirectory + session-{id}.json)
  const exactUser = path.join(getUserSessionsDir(), id, `session-${id}.json`);
  const exactProject = path.join(getSessionsDir(), id, `session-${id}.json`);

  const userExists = fs.existsSync(exactUser);
  const projectExists = fs.existsSync(exactProject);

  // For exact match: user session shadows project session
  if (userExists) {
    return [{ id, path: exactUser, source: 'user' }];
  }
  if (projectExists) {
    return [{ id, path: exactProject, source: 'project' }];
  }

  // Try partial match (at least 6 characters)
  if (id.length >= 6) {
    // Search in user sessions
    const userDir = getUserSessionsDir();
    if (fs.existsSync(userDir)) {
      const dirs = fs.readdirSync(userDir).filter((d) => {
        const sessionFile = path.join(userDir, d, `session-${d}.json`);
        return fs.statSync(path.join(userDir, d)).isDirectory() && fs.existsSync(sessionFile);
      });
      for (const dir of dirs) {
        if (dir.startsWith(id)) {
          matches.push({ id: dir, path: path.join(userDir, dir, `session-${dir}.json`), source: 'user' });
        }
      }
    }

    // Search in project sessions
    const projectDir = getSessionsDir();
    if (fs.existsSync(projectDir)) {
      const dirs = fs.readdirSync(projectDir).filter((d) => {
        const sessionFile = path.join(projectDir, d, `session-${d}.json`);
        return fs.statSync(path.join(projectDir, d)).isDirectory() && fs.existsSync(sessionFile);
      });
      for (const dir of dirs) {
        if (dir.startsWith(id)) {
          // Check if same ID already found in user sessions (user shadows project)
          const alreadyFound = matches.find((m) => m.id === dir);
          if (!alreadyFound) {
            matches.push({ id: dir, path: path.join(projectDir, dir, `session-${dir}.json`), source: 'project' });
          }
        }
      }
    }
  }

  return matches;
}

/**
 * List all available sessions (project + user)
 *
 * @returns Array of session list items
 */
export function listSessions(): SessionDisplay[] {
  const sessions: SessionDisplay[] = [];
  const seenIds = new Set<string>();

  // Read project sessions (iterate subdirectories)
  const projectDir = getSessionsDir();
  if (fs.existsSync(projectDir)) {
    const dirs = fs.readdirSync(projectDir).filter((d) => {
      const sessionFile = path.join(projectDir, d, `session-${d}.json`);
      return fs.statSync(path.join(projectDir, d)).isDirectory() && fs.existsSync(sessionFile);
    });
    for (const dir of dirs) {
      const sessionPath = path.join(projectDir, dir, `session-${dir}.json`);
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
    const dirs = fs.readdirSync(userDir).filter((d) => {
      const sessionFile = path.join(userDir, d, `session-${d}.json`);
      return fs.statSync(path.join(userDir, d)).isDirectory() && fs.existsSync(sessionFile);
    });
    for (const dir of dirs) {
      const sessionPath = path.join(userDir, dir, `session-${dir}.json`);
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

  // Sort by creation time (oldest first, newest at the bottom)
  sessions.sort((a, b) => a.create_time.localeCompare(b.create_time));

  return sessions;
}

/**
 * Save session to user directory
 * Copies the entire session subdirectory to ~/.mycc-store/sessions/{id}/
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

  // Copy entire session directory
  const srcDir = path.dirname(sessionPath);
  const destDir = path.join(userDir, session.id);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Copy all files from source session directory to user directory
  const files = fs.readdirSync(srcDir);
  for (const file of files) {
    const srcFile = path.join(srcDir, file);
    const destFile = path.join(destDir, file);
    if (fs.statSync(srcFile).isFile()) {
      fs.copyFileSync(srcFile, destFile);
    }
  }

  return path.join(destDir, `session-${session.id}.json`);
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
 * Extracts UUID from `session-{uuid}.json` filename or from parent directory name.
 *
 * @param filePath - Path to session file
 * @returns Session ID (UUID)
 */
export function getSessionId(filePath: string): string {
  const basename = path.basename(filePath, '.json');
  // Handle both old format (plain UUID) and new format (session-{uuid})
  if (basename.startsWith('session-')) {
    return basename.slice('session-'.length);
  }
  return basename;
}

/**
 * Clean up empty session files (sessions with no first_query)
 * Skips files created within 1 minute to prevent concurrency issues.
 *
 * @param currentSessionId - Session ID to preserve (the current session)
 * @returns Number of removed empty sessions
 */
export function cleanupEmptySessions(currentSessionId: string): number {
  let removed = 0;
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;

  const isRecent = (session: Session): boolean => {
    const createTime = new Date(session.create_time).getTime();
    return createTime > oneMinuteAgo;
  };

  const isSessionDir = (dir: string): boolean => {
    const sessionFile = path.join(dir, `session-${path.basename(dir)}.json`);
    return fs.existsSync(sessionFile);
  };

  // Clean up project sessions
  const projectDir = getSessionsDir();
  if (fs.existsSync(projectDir)) {
    const dirs = fs.readdirSync(projectDir).filter((d) => {
      const fullPath = path.join(projectDir, d);
      return fs.statSync(fullPath).isDirectory() && isSessionDir(fullPath);
    });
    for (const dir of dirs) {
      const sessionPath = path.join(projectDir, dir, `session-${dir}.json`);
      const session = readSession(sessionPath);
      if (session && !session.first_query && session.id !== currentSessionId && !isRecent(session)) {
        // Remove the entire session directory
        const sessionDir = path.join(projectDir, dir);
        const files = fs.readdirSync(sessionDir);
        for (const file of files) {
          fs.unlinkSync(path.join(sessionDir, file));
        }
        fs.rmdirSync(sessionDir);
        removed++;
      }
    }
  }

  // Clean up user sessions
  const userDir = getUserSessionsDir();
  if (fs.existsSync(userDir)) {
    const dirs = fs.readdirSync(userDir).filter((d) => {
      const fullPath = path.join(userDir, d);
      return fs.statSync(fullPath).isDirectory() && isSessionDir(fullPath);
    });
    for (const dir of dirs) {
      const sessionPath = path.join(userDir, dir, `session-${dir}.json`);
      const session = readSession(sessionPath);
      if (session && !session.first_query && session.id !== currentSessionId && !isRecent(session)) {
        // Remove the entire session directory
        const sessionDir = path.join(userDir, dir);
        const files = fs.readdirSync(sessionDir);
        for (const file of files) {
          fs.unlinkSync(path.join(sessionDir, file));
        }
        fs.rmdirSync(sessionDir);
        removed++;
      }
    }
  }

  return removed;
}

/**
 * Restore an existing session by ID
 */
export async function restoreSession(sessionArg: string): Promise<SessionInit> {
  console.log(chalk.cyan(`Loading session: ${sessionArg}`));

  let session: Session;
  try {
    session = loadSessionById(sessionArg);
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      console.error(chalk.red(`Session not found: ${sessionArg}`));
      process.exit(1);
    }
    if (err instanceof AmbiguousSessionError) {
      console.error(chalk.red('Ambiguous session ID. Multiple matches found:'));
      for (const match of err.matches) {
        console.error(chalk.yellow(`  [${match.id.slice(0, 7)}] ${match.source} session`));
      }
      console.error(chalk.gray('Use a longer session ID prefix.'));
      process.exit(1);
    }
    throw err;
  }

  // Verify working directory matches session's project_dir
  const currentDir = process.cwd();
  if (currentDir !== session.project_dir) {
    console.error(chalk.red('Working directory mismatch.'));
    console.error(chalk.yellow(`Current: ${currentDir}`));
    console.error(chalk.yellow(`Session expects: ${session.project_dir}`));
    console.error(chalk.gray(`Run: cd "${session.project_dir}" && mycc --session ${session.id}`));
    process.exit(1);
  }

  // Validate session files exist
  const missingFiles = [
    session.lead_triologue,
    ...session.child_triologues,
  ].filter(p => !fs.existsSync(p));

  if (missingFiles.length > 0) {
    console.error(chalk.red(`Session files missing: ${missingFiles.join(', ')}`));
    process.exit(1);
  }

  console.log(chalk.cyan('Restoring session...'));

  const { pair, dosqPath } = await prepareRestoration(session);

  console.log(chalk.cyan('Session restored. DOSQ generated at:'));
  console.log(chalk.gray(`  ${dosqPath}`));

  // Open DOSQ in editor for user review
  try {
    openEditor([dosqPath]);
    console.log(chalk.gray('Opening DOSQ file in editor...'));
  } catch {
    console.log(chalk.yellow(`Please edit the DOSQ file manually: ${dosqPath}`));
  }

  console.log(chalk.yellow('Edit the DOSQ file if needed, then save and close to continue...'));
  await agentIO.ask(chalk.cyan('Press Enter when ready to continue >'), true);

  const dosqContent = readDosq(dosqPath);
  const initialQuery = extractFirstQuery(dosqContent);
  const triologuePath = session.lead_triologue;
  const sessionFilePath = getSessionPathById(session.id)
    || path.join(getSessionsDir(), session.id, `session-${session.id}.json`);

  console.log(chalk.gray(`Restored session: ${session.id.slice(0, 7)}`));

  return { sessionFilePath, triologuePath, restoredPair: pair, initialQuery };
}

/**
 * Create a new session with fresh triologue and session files
 */
export function createNewSession(): SessionInit {
  // Generate session ID first so we can create the session directory
  const id = randomUUID();
  const sessionDir = path.join(getSessionsDir(), id);
  ensureDir(sessionDir);

  const timestamp = Math.floor(Date.now() / 1000);
  const triologuePath = path.join(sessionDir, `triologue-lead-${timestamp}.jsonl`);
  fs.writeFileSync(triologuePath, '', 'utf-8');

  // Pass the same id so session file goes in the same directory as triologue
  const sessionFilePath = createSessionFile(triologuePath, id);

  // Clean up empty sessions from previous runs
  const currentSessionId = getSessionId(sessionFilePath);
  const removed = cleanupEmptySessions(currentSessionId);
  if (removed > 0) {
    console.log(chalk.gray(`Cleaned up ${removed} empty session(s)`));
  }

  return { sessionFilePath, triologuePath, restoredPair: null, initialQuery: null };
}

/**
 * Initialize session - restore existing or create new
 * Sets session context before any database operations.
 */
export async function initializeSession(): Promise<SessionInit> {
  const sessionArg = getSessionArg();

  // Step 1: Get or create session to obtain session ID
  let result: SessionInit;
  if (sessionArg) {
    result = await restoreSession(sessionArg);
  } else {
    result = createNewSession();
  }

  // Step 2: Set session context for all database operations
  const sessionId = getSessionId(result.sessionFilePath);
  setSessionContext(sessionId);

  // Step 3: For NEW sessions, clear any orphan data from this session ID
  // (Restored sessions should keep their existing data)
  if (!sessionArg) {
    clearAll();
  }

  return result;
}