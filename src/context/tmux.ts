/**
 * tmux.ts - TmuxManager module for managing tmux sessions for remote SSH
 *
 * This module manages tmux sessions that can be used for remote SSH connections.
 * Sessions are project-scoped (tied to project directory) and require host
 * verification before commands can be sent.
 */

import * as path from 'path';
import { execSync } from 'child_process';
import type { TmuxModule, TmuxSessionInfo, CoreModule } from '../types.js';
import { getDb } from './db.js';

/**
 * TmuxManager - manages tmux sessions for remote SSH
 */
export class TmuxManager implements TmuxModule {
  private core: CoreModule;

  constructor(core: CoreModule) {
    this.core = core;
  }

  /**
   * Normalize project directory to a session-safe name
   * Lowercase, alphanumeric only, max 20 chars
   */
  normalizeProjectDir(projectDir: string): string {
    const baseName = path.basename(projectDir);
    return baseName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .substring(0, 20);
  }

  /**
   * Generate a unique tmux session name for the project
   * Format: mycc-[normalized-project-dir]-[serial]
   */
  async generateTmuxSessionName(projectDir: string): Promise<string> {
    const prefix = `mycc-${this.normalizeProjectDir(projectDir)}`;
    const existing = await this.getTmuxSessionsByProject(projectDir);

    // Find the next available serial number
    let serial = 1;
    const existingNames = new Set(existing.map(s => s.tmuxSessionName));

    while (existingNames.has(`${prefix}-${serial}`)) {
      serial++;
    }

    return `${prefix}-${serial}`;
  }

  /**
   * Create a new tmux session record in the database
   */
  async createTmuxSession(tmuxSessionName: string, projectDir: string, description?: string): Promise<void> {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO tmux_sessions (tmux_session_name, project_dir, description)
      VALUES (?, ?, ?)
    `);
    stmt.run(tmuxSessionName, projectDir, description || null);
  }

  /**
   * Get a tmux session by name
   */
  async getTmuxSession(tmuxSessionName: string): Promise<TmuxSessionInfo | undefined> {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT tmux_session_name, project_dir, remote_host, description, created_at, last_used_at
      FROM tmux_sessions
      WHERE tmux_session_name = ?
    `);
    const row = stmt.get(tmuxSessionName) as any;
    if (!row) return undefined;

    return {
      tmuxSessionName: row.tmux_session_name,
      projectDir: row.project_dir,
      remoteHost: row.remote_host,
      description: row.description,
      createdAt: new Date(row.created_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    };
  }

  /**
   * Get all tmux sessions for a project
   */
  async getTmuxSessionsByProject(projectDir: string): Promise<TmuxSessionInfo[]> {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT tmux_session_name, project_dir, remote_host, description, created_at, last_used_at
      FROM tmux_sessions
      WHERE project_dir = ?
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(projectDir) as any[];

    return rows.map(row => ({
      tmuxSessionName: row.tmux_session_name,
      projectDir: row.project_dir,
      remoteHost: row.remote_host,
      description: row.description,
      createdAt: new Date(row.created_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    }));
  }

  /**
   * Update remote host for a session
   */
  async setRemoteHost(tmuxSessionName: string, host: string): Promise<void> {
    const db = getDb();
    const stmt = db.prepare(`
      UPDATE tmux_sessions
      SET remote_host = ?
      WHERE tmux_session_name = ?
    `);
    stmt.run(host, tmuxSessionName);
  }

  /**
   * Update last used timestamp
   */
  async touchTmuxSession(tmuxSessionName: string): Promise<void> {
    const db = getDb();
    const stmt = db.prepare(`
      UPDATE tmux_sessions
      SET last_used_at = CURRENT_TIMESTAMP
      WHERE tmux_session_name = ?
    `);
    stmt.run(tmuxSessionName);
  }

  /**
   * Delete a tmux session record
   */
  async deleteTmuxSession(tmuxSessionName: string): Promise<void> {
    const db = getDb();
    const stmt = db.prepare(`
      DELETE FROM tmux_sessions
      WHERE tmux_session_name = ?
    `);
    stmt.run(tmuxSessionName);
  }

  /**
   * Sync tmux sessions with actual system tmux list
   * Removes records for sessions that no longer exist
   */
  async syncTmuxSessions(projectDir: string): Promise<void> {
    const dbSessions = await this.getTmuxSessionsByProject(projectDir);
    const systemSessions = await this.listSystemTmuxSessions();

    for (const dbSession of dbSessions) {
      if (!systemSessions.includes(dbSession.tmuxSessionName)) {
        // Session was killed externally - remove from DB
        await this.deleteTmuxSession(dbSession.tmuxSessionName);
        this.core.brief('info', 'tmux', `Removed stale session record: ${dbSession.tmuxSessionName}`);
      }
    }
  }

  /**
   * Verify session belongs to the specified project
   */
  async verifyTmuxSession(tmuxSessionName: string, projectDir: string): Promise<TmuxSessionInfo | null> {
    const session = await this.getTmuxSession(tmuxSessionName);

    if (!session) {
      return null;
    }

    if (session.projectDir !== projectDir) {
      throw new Error(`TmuxSession ${tmuxSessionName} belongs to different project (${session.projectDir})`);
    }

    return session;
  }

  /**
   * Check if tmux is installed on the system
   */
  isTmuxInstalled(): boolean {
    try {
      execSync('tmux -V', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List actual tmux sessions from the system
   */
  async listSystemTmuxSessions(): Promise<string[]> {
    try {
      const output = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim().split('\n').filter(name => name.length > 0);
    } catch {
      // tmux not running or no sessions
      return [];
    }
  }
}