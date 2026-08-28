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
 * Marker seeded into `first_query` for every session that BOOTSTRAPS into
 * auto mode (`--auto`, `--daemon <skill>`, bare `--daemon`). Such sessions
 * skip the interactive PROMPT state entirely (the auto gate in prompt.ts
 * returns WAIT before the bookmark capture runs), so without the marker
 * their `first_query` stays '' and cleanupEmptySessions treats them as
 * garbage once they are >1 min old — deleting the session dir out from
 * under a live process (the daemon-stall bug of 2026-08-27).
 *
 * The marker is a LIFECYCLE field, not a one-shot bookmark: when the first
 * real wake event arrives (channel first-query / peer or cron mail /
 * teammate question / webui steering note — all converge on COLLECT), the
 * COLLECT handler overwrites the marker with that event's text, so the
 * archived session ends up with its genuine first query.
 */
export const HEADLESS_FIRST_QUERY_MARKER = '[auto mode] awaiting first query';

/**
 * Absolute freshness window for treating a session as still live during
 * empty-session cleanup. Mirrors FRESHNESS_WINDOW_MS in peer/identity.ts:
 * a live instance beats every 30s, so a latest beat within 90s means the
 * owning process is alive RIGHT NOW and its session directory must not be
 * deleted.
 *
 * This is the SECOND layer of the two-layer live-session defense:
 * 1. Bootstrap-auto sessions (--auto / --daemon) carry the
 *    {@link HEADLESS_FIRST_QUERY_MARKER} in `first_query` from the start,
 *    so the cleanup predicate `!session.first_query` categorically
 *    excludes them — no timing involved.
 * 2. The heartbeat guard covers every OTHER live session with an empty
 *    first_query (idle interactive sessions, non-bootstrap peers) that
 *    the marker does not apply to.
 */
const LIVE_SESSION_HEARTBEAT_WINDOW_MS = 90_000;

/**
 * Check whether a session directory is owned by a live process: its
 * heartbeat file (~/.mycc-store/discovery/heartbeat/{id}.json) contains a
 * beat within {@link LIVE_SESSION_HEARTBEAT_WINDOW_MS} of now.
 *
 * Used as a deletion guard in {@link cleanupEmptySessions}: an empty
 * (no first_query) session that is heartbeating is NOT garbage — it is a
 * live session the marker does not cover (e.g. an idle interactive session
 * whose first keystroke has not happened yet, or a headless process
 * started by another entry point) and its owner process would break the
 * moment its mailbox/triologue files vanish (cron nudges append to the
 * mailbox path under the session dir).
 *
 * Best-effort: any read/parse error returns false (the file is then treated
 * as not-live and the normal cleanup rules apply).
 */
function hasLiveHeartbeat(sessionId: string): boolean {
  try {
    const hbFile = path.join(os.homedir(), '.mycc-store', 'discovery', 'heartbeat', `${sessionId}.json`);
    if (!fs.existsSync(hbFile)) return false;
    const parsed = JSON.parse(fs.readFileSync(hbFile, 'utf-8')) as {
      heartbeats?: unknown[];
      timestamps?: unknown[];
    };
    // Accept both current ({heartbeats}) and legacy ({timestamps}) schemas.
    const beats = Array.isArray(parsed.heartbeats) ? parsed.heartbeats : Array.isArray(parsed.timestamps) ? parsed.timestamps : [];
    const latest = beats.filter((t): t is number => typeof t === 'number').pop();
    return typeof latest === 'number' && Date.now() - latest < LIVE_SESSION_HEARTBEAT_WINDOW_MS;
  } catch {
    return false;
  }
}

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
 * Uses the temp-file + rename pattern (same as ConditionRegistry.save()):
 * writes to a temp file in the SAME directory, then atomically renames it
 * over the target. A crash mid-write leaves the temp file orphaned but the
 * main session file intact — never a truncated/corrupt session JSON that
 * would make the session unreadable on the next start.
 *
 * @param filePath - Path to session file
 * @param session - Session object to write
 */
export function writeSession(filePath: string, session: Session): void {
  const sessionFile: Session = {
    ...session,
    version: '2.0',
  };
  const content = JSON.stringify(sessionFile, null, 2);

  // Write to a temp file in the SAME directory as the target (avoids
  // cross-device rename issues), then atomically rename into place.
  const tempFile = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tempFile, content, 'utf-8');
  fs.renameSync(tempFile, filePath);
}

/**
 * Mark a bootstrap-auto session (``--auto`` / ``--daemon``) as headless by
 * seeding {@link HEADLESS_FIRST_QUERY_MARKER} into its `first_query`.
 *
 * WHY: bootstrap-auto sessions skip the interactive PROMPT state (the auto
 * gate in prompt.ts returns WAIT before the bookmark capture), so their
 * `first_query` would stay '' forever and cleanupEmptySessions would
 * garbage-collect the live session dir once it is >1 min old. The marker
 * makes the cleanup predicate categorically exclude the session — no
 * heartbeat timing involved.
 *
 * Semantics:
 * - No-op when the session file is missing/unreadable (nothing to mark).
 * - No-op when `first_query` is already set — an interactive capture or an
 *   earlier marker wins; never overwrite a real first query.
 * - Best-effort: any error is swallowed. A failed marker write must never
 *   kill process startup (the heartbeat guard is the second layer that
 *   still protects the session in that case).
 *
 * @param sessionFilePath - Path to the session-{id}.json to mark
 * @returns true when the marker was written, false otherwise
 */
export function markHeadlessSession(sessionFilePath: string): boolean {
  try {
    const session = readSession(sessionFilePath);
    if (!session || session.first_query) return false;
    session.first_query = HEADLESS_FIRST_QUERY_MARKER;
    writeSession(sessionFilePath, session);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace the headless {@link HEADLESS_FIRST_QUERY_MARKER} with the REAL
 * first query once one arrives. Called from the COLLECT handler when the
 * first genuine wake event is processed — mail (peer mail, cron nudge, or
 * a channel first-query delivered to the local mailbox), a teammate
 * question, or a webui steering note — and from the PROMPT interactive
 * bookmark capture when a user ESC-ed out of a fresh bootstrap-auto
 * session and typed the first real query. All reset sources converge on
 * this single function.
 *
 * When the session has NO first_query at all (plain interactive capture),
 * the query is written directly — this unifies the interactive bookmark
 * capture and the marker reset into one call site.
 *
 * Semantics:
 * - Marker present → replaced with the real query text.
 * - first_query empty → written with the real query text (interactive
 *   bookmark capture path).
 * - first_query already a real query → NEVER overwritten (no-op).
 * - No-op when the session file is missing/unreadable.
 * - Best-effort: any error is swallowed (a failed archive write must not
 *   break the wake-event processing or the interactive prompt flow).
 *
 * @param sessionFilePath - Path to the session-{id}.json to update
 * @param firstQuery - The real first query text (truncated to 100 chars,
 *   matching the interactive bookmark capture's truncation)
 * @returns true when first_query was written or replaced, false otherwise
 */
export function resolveHeadlessFirstQuery(sessionFilePath: string, firstQuery: string): boolean {
  try {
    const session = readSession(sessionFilePath);
    if (!session) return false;
    if (session.first_query && session.first_query !== HEADLESS_FIRST_QUERY_MARKER) return false;
    session.first_query = firstQuery.slice(0, 100);
    writeSession(sessionFilePath, session);
    return true;
  } catch {
    return false;
  }
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
 * A session survives cleanup when ANY of these holds:
 * - it has a `first_query` (interactive capture, or the
 *   {@link HEADLESS_FIRST_QUERY_MARKER} seeded for bootstrap-auto sessions
 *   — `--auto` / `--daemon`; see {@link markHeadlessSession}),
 * - it is the current session,
 * - it was created within the last minute (concurrency grace), or
 * - its owner process is still beating (fresh heartbeat — the second
 *   defense layer for live sessions the marker does not cover).
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

  // Deletion guard: skip sessions owned by a live process (fresh heartbeat).
  // This is the SECOND layer of the live-session defense: bootstrap-auto
  // sessions (--auto / --daemon) are already excluded categorically via the
  // HEADLESS_FIRST_QUERY_MARKER in first_query (see markHeadlessSession).
  // The heartbeat guard covers every OTHER live session with an empty
  // first_query — e.g. an idle interactive session whose first keystroke
  // has not happened yet. Without it, such a session matches "empty" once
  // it is >1 min old and its directory gets deleted while the owner process
  // keeps running deaf (cron nudges append to a mailbox path that no
  // longer exists).
  const isLive = (session: Session): boolean => hasLiveHeartbeat(session.id);

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
      if (session && !session.first_query && session.id !== currentSessionId && !isRecent(session) && !isLive(session)) {
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
      if (session && !session.first_query && session.id !== currentSessionId && !isRecent(session) && !isLive(session)) {
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
 *
 * SEMANTICS (per the "a session is never shared" principle):
 *   `--from <id>` does NOT reopen and continue writing into the old session.
 *   It READS the old session's files read-only, uses the LLM to re-understand
 *   them into a fresh context (the DOSQ + first-query flow), and then
 *   CONTINUES inside a BRAND NEW session (new id, new triologue file, new
 *   session json). The old session's files are sealed — never written to
 *   again.
 *
 *   Consequence: loading the same source id multiple times yields DIFFERENT
 *   new sessions, because the LLM re-understanding is non-deterministic. This
 *   "variation by re-understanding" is intentional — it is the basis for a
 *   genetic-algorithm-style branching of contexts.
 *
 * The old `session` object is used only as INPUT:
 *   - `prepareRestoration(session)` reads its triologue + child triologues and
 *     regenerates the summary pair + DOSQ.
 *   - `session.project_dir` is checked against `process.cwd()` (a session can
 *     only be branched from within its own project dir).
 *
 * Teammates from the source do NOT carry over as live processes. Their
 * narratives are recovered (via the READY-event scan inside
 * `prepareRestoration`) and injected into the new session as context text.
 */
export async function restoreSession(sessionArg: string): Promise<SessionInit> {
  console.log(chalk.cyan(`Branching new session from ${sessionArg}...`));

  let sourceSession: Session;
  try {
    sourceSession = loadSessionById(sessionArg);
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

  // Verify working directory matches the SOURCE session's project_dir. The
  // new session inherits the current cwd as its project_dir, so they must
  // match (you can only branch a session from within its own project).
  const currentDir = process.cwd();
  if (currentDir !== sourceSession.project_dir) {
    console.error(chalk.red('Working directory mismatch.'));
    console.error(chalk.yellow(`Current: ${currentDir}`));
    console.error(chalk.yellow(`Source session expects: ${sourceSession.project_dir}`));
    console.error(chalk.gray(`Run: cd "${sourceSession.project_dir}" && mycc --from ${sourceSession.id}`));
    process.exit(1);
  }

  // Check for missing triologue files. We only WARN now: prepareRestoration
  // degrades gracefully (missing lead → empty-context pair; missing children
  // → placeholder narratives via the READY-event scan). Hard-exiting here
  // would prevent the user from continuing a partially-recorded session.
  const missingFiles = [
    sourceSession.lead_triologue,
    ...sourceSession.child_triologues,
  ].filter(p => !fs.existsSync(p));

  if (missingFiles.length > 0) {
    console.warn(chalk.yellow(`[restore] Source session files missing (will degrade gracefully): ${missingFiles.join(', ')}`));
  }

  console.log(chalk.cyan('Re-understanding source transcript (LLM summarization)...'));

  const { pair, dosqPath } = await prepareRestoration(sourceSession);

  console.log(chalk.cyan('New session context generated. DOSQ at:'));
  console.log(chalk.gray(`  ${dosqPath}`));

  // Open DOSQ in editor for user review
  try {
    openEditor([dosqPath]);
    console.log(chalk.gray('Opening DOSQ file in editor...'));
  } catch {
    console.log(chalk.yellow(`Please edit the DOSQ file manually: ${dosqPath}`));
  }

  console.log(chalk.yellow('Edit the DOSQ file if needed, then save and close to continue...'));
  // notice:true renders an instruction + a single OK button in the webui
  // (NO useless text input) — the user edits the DOSQ file in their editor,
  // then clicks OK to continue. onEnter:'' makes Enter-on-empty (terminal) /
  // OK (webui) resolve to ''.
  await agentIO.ask(
    chalk.cyan('Edit the DOSQ file if needed, save and close, then click OK to continue'),
    { useAsPrompt: true, onEsc: '', onEnter: '', notice: true },
  );

  const dosqContent = readDosq(dosqPath);
  const initialQuery = extractFirstQuery(dosqContent);

  // Create a BRAND NEW session (new id, new triologue file, new session json).
  // The old session's files are never written to again — they are sealed.
  const { sessionFilePath, triologuePath } = writeFreshSessionFiles();

  console.log(chalk.gray(`Branched new session ${getSessionId(sessionFilePath).slice(0, 7)} (from ${sourceSession.id.slice(0, 7)})`));

  return { sessionFilePath, triologuePath, restoredPair: pair, initialQuery, sourceSessionId: sourceSession.id };
}

/**
 * Create the on-disk files for a fresh, empty session: a new id, a new session
 * directory, an empty lead triologue JSONL, and a session-{id}.json pointing
 * at it (child_triologues=[], teammates=[]).
 *
 * Shared by `createNewSession` (genuinely fresh start) and `restoreSession`
 * (branch from a source). Neither caller writes into any pre-existing file —
 * both produce brand-new paths, enforcing the "a session is never shared"
 * invariant at the file level.
 *
 * @returns the new session file path and triologue path.
 */
function writeFreshSessionFiles(): { sessionFilePath: string; triologuePath: string } {
  const id = randomUUID();
  const sessionDir = path.join(getSessionsDir(), id);
  ensureDir(sessionDir);

  const timestamp = Math.floor(Date.now() / 1000);
  const triologuePath = path.join(sessionDir, `triologue-lead-${timestamp}.jsonl`);
  fs.writeFileSync(triologuePath, '', 'utf-8');

  // Pass the same id so the session file lives in the same dir as the triologue
  const sessionFilePath = createSessionFile(triologuePath, id);

  return { sessionFilePath, triologuePath };
}

/**
 * Create a new session with fresh triologue and session files
 */
export function createNewSession(): SessionInit {
  const { sessionFilePath, triologuePath } = writeFreshSessionFiles();

  // Clean up empty sessions from previous runs
  const currentSessionId = getSessionId(sessionFilePath);
  const removed = cleanupEmptySessions(currentSessionId);
  if (removed > 0) {
    console.log(chalk.gray(`Cleaned up ${removed} empty session(s)`));
  }

  return { sessionFilePath, triologuePath, restoredPair: null, initialQuery: null, sourceSessionId: null };
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