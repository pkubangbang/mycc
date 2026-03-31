/**
 * team.ts - Team module: child process teammates with IPC
 */

import { fork, ChildProcess } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { TeamModule, Teammate, TeammateStatus } from '../types.js';
import { getDb } from './db.js';
import { createMail } from './mail.js';
import type { CoreModule } from '../types.js';

// ES module compatibility for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * IPC message types (parent to child)
 */
type ParentMessage =
  | { type: 'spawn'; name: string; role: string; prompt: string }
  | { type: 'message'; from: string; title: string; content: string }
  | { type: 'shutdown' };

/**
 * IPC message types (child to parent)
 */
type ChildMessage =
  | { type: 'status'; status: TeammateStatus }
  | { type: 'log'; message: string }
  | { type: 'error'; error: string };

/**
 * Team module implementation using SQLite + child processes
 */
export class TeamManager implements TeamModule {
  private core: CoreModule;
  private processes: Map<string, ChildProcess> = new Map();
  private statuses: Map<string, TeammateStatus> = new Map();

  constructor(core: CoreModule) {
    this.core = core;
  }

  /**
   * Spawn a teammate as a child process
   */
  async createTeammate(name: string, role: string, prompt: string): Promise<string> {
    // Check if teammate already exists
    const existing = this.getTeammate(name);
    if (existing && existing.status !== 'shutdown') {
      return `Error: Teammate '${name}' already exists with status ${existing.status}`;
    }

    // Insert into database
    const db = getDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO teammates (name, role, status, prompt)
      VALUES (?, ?, 'working', ?)
    `);
    stmt.run(name, role, prompt);

    // Spawn child process
    const workerPath = path.join(__dirname, 'teammate-worker.js');
    const child = fork(workerPath, [], {
      cwd: this.core.getWorkDir(),
      silent: true,
    });

    // Track process
    this.processes.set(name, child);
    this.statuses.set(name, 'working');

    // Handle stdout/stderr
    if (child.stdout) {
      child.stdout.on('data', (data: Buffer) => {
        this.core.brief('info', name, data.toString().trim());
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        this.core.brief('error', name, data.toString().trim());
      });
    }

    // Handle IPC messages from child
    child.on('message', (msg: ChildMessage) => {
      this.handleChildMessage(name, msg);
    });

    // Handle process exit
    child.on('exit', (code) => {
      this.statuses.set(name, 'shutdown');
      this.updateDbStatus(name, 'shutdown');
      this.processes.delete(name);
      this.core.brief('info', name, `Process exited (code ${code})`);
    });

    // Handle errors
    child.on('error', (err) => {
      this.core.brief('error', name, `Process error: ${err.message}`);
      this.statuses.set(name, 'shutdown');
      this.updateDbStatus(name, 'shutdown');
      this.processes.delete(name);
    });

    // Send spawn config to child via IPC
    const spawnMsg: ParentMessage = {
      type: 'spawn',
      name,
      role,
      prompt,
    };
    child.send(spawnMsg);

    return `Spawned teammate '${name}' (role: ${role}) as child process (pid: ${child.pid})`;
  }

  /**
   * Handle IPC message from child process
   */
  private handleChildMessage(sender: string, msg: ChildMessage): void {
    switch (msg.type) {
      case 'status':
        this.statuses.set(sender, msg.status);
        this.updateDbStatus(sender, msg.status);
        break;

      case 'log':
        this.core.brief('info', sender, msg.message);
        break;

      case 'error':
        this.core.brief('error', sender, msg.error);
        break;
    }
  }

  /**
   * Update status in database
   */
  private updateDbStatus(name: string, status: TeammateStatus): void {
    const db = getDb();
    const stmt = db.prepare(`
      UPDATE teammates SET status = ? WHERE name = ?
    `);
    stmt.run(status, name);
  }

  /**
   * Get teammate info
   */
  getTeammate(name: string): Teammate | undefined {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT name, role, status, prompt, created_at
      FROM teammates
      WHERE name = ?
    `);

    const row = stmt.get(name) as {
      name: string;
      role: string;
      status: string;
      prompt: string | null;
      created_at: string;
    } | undefined;

    if (!row) return undefined;

    return {
      name: row.name,
      role: row.role,
      status: row.status as TeammateStatus,
      process: this.processes.get(name),
      prompt: row.prompt || undefined,
      createdAt: new Date(row.created_at),
    };
  }

  /**
   * List all teammates
   */
  listTeammates(): { name: string; role: string; status: TeammateStatus }[] {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT name, role, status FROM teammates
    `);

    const rows = stmt.all() as Array<{
      name: string;
      role: string;
      status: string;
    }>;

    return rows.map((row) => ({
      name: row.name,
      role: row.role,
      status: (this.statuses.get(row.name) || row.status) as TeammateStatus,
    }));
  }

  /**
   * Wait for a specific teammate to finish
   */
  async awaitTeammate(name: string, timeout: number = 60000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const status = this.statuses.get(name);
      if (status === 'idle' || status === 'shutdown') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Timeout waiting for teammate ${name}`);
  }

  /**
   * Wait for all teammates to finish
   */
  async awaitTeam(timeout: number = 60000): Promise<{ allSettled: boolean }> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const allSettled = Array.from(this.statuses.values()).every(
        (s) => s === 'idle' || s === 'shutdown'
      );

      if (allSettled) {
        return { allSettled: true };
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return { allSettled: false };
  }

  /**
   * Format team info for prompt
   */
  printTeam(): string {
    const teammates = this.listTeammates();
    if (teammates.length === 0) {
      return 'No teammates.';
    }

    const lines = ['Team:'];
    for (const t of teammates) {
      lines.push(`  ${t.name} (${t.role}): ${t.status}`);
    }
    return lines.join('\n');
  }

  /**
   * Remove a teammate
   */
  removeTeammate(name: string): void {
    const child = this.processes.get(name);
    if (child && child.connected) {
      child.send({ type: 'shutdown' } as ParentMessage);
      child.disconnect();
    }

    this.processes.delete(name);
    this.statuses.delete(name);

    const db = getDb();
    const stmt = db.prepare(`DELETE FROM teammates WHERE name = ?`);
    stmt.run(name);
  }

  /**
   * Dismiss all teammates
   */
  dismissTeam(): void {
    for (const [name, child] of this.processes) {
      if (child.connected) {
        child.send({ type: 'shutdown' } as ParentMessage);
        child.disconnect();
      }
    }

    this.processes.clear();
    this.statuses.clear();

    const db = getDb();
    db.exec(`DELETE FROM teammates`);
  }

  /**
   * Send mail to a teammate
   */
  mailTo(name: string, title: string, content: string): void {
    const mail = createMail(name);
    mail.appendMail('lead', title, content);
  }

  /**
   * Broadcast to all teammates
   */
  broadcast(title: string, content: string): void {
    const teammates = this.listTeammates();
    for (const t of teammates) {
      this.mailTo(t.name, title, content);
    }
  }
}

/**
 * Create a team module instance
 */
export function createTeam(core: CoreModule): TeamModule {
  return new TeamManager(core);
}