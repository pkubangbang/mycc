/**
 * team.ts - Team module: child process teammates with IPC
 */

import { fork, ChildProcess } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type {
  TeamModule,
  Teammate,
  TeammateStatus,
  AgentContext,
  IpcHandlerRegistration,
  TranscriptModule,
} from '../types.js';
import { getDb } from './db.js';
import { createMail } from './mail.js';
import { createIpcRegistry, IpcRegistry } from './child-context/ipc-registry.js';
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
  | { type: 'shutdown' }
  | { type: 'db_result'; reqId: number; success: boolean; data?: unknown; error?: string };

/**
 * IPC message from child with optional request ID for response
 */
type IpcMessage = {
  type: string;
  reqId?: number;
  [key: string]: unknown;
};

/**
 * Team module implementation using SQLite + child processes
 */
export class TeamManager implements TeamModule {
  private core: CoreModule;
  private processes: Map<string, ChildProcess> = new Map();
  private statuses: Map<string, TeammateStatus> = new Map();
  private ipcRegistry: IpcRegistry;
  private transcript: TranscriptModule | null = null;

  constructor(core: CoreModule) {
    this.core = core;
    this.ipcRegistry = createIpcRegistry();

    // Register default handlers for built-in message types
    this.registerBuiltinHandlers();
  }

  /**
   * Set the transcript module for logging
   */
  setTranscript(transcript: TranscriptModule): void {
    this.transcript = transcript;
  }

  /**
   * Register built-in handlers for status, log, error, question
   */
  private registerBuiltinHandlers(): void {
    // Status handler - updates internal state
    this.ipcRegistry.register({
      messageType: 'status',
      module: 'team',
      handler: (_sender: string, payload: Record<string, unknown>) => {
        const { status } = payload as { status: TeammateStatus };
        // Note: status update is handled specially in handleChildMessage
        // because it needs access to internal state
        void status; // Suppress unused variable warning
      },
    });

    // Log handler
    this.ipcRegistry.register({
      messageType: 'log',
      module: 'team',
      handler: (sender: string, payload: Record<string, unknown>) => {
        const { message } = payload as { message: string };
        this.core.brief('info', sender, message);
      },
    });

    // Error handler
    this.ipcRegistry.register({
      messageType: 'error',
      module: 'team',
      handler: (sender: string, payload: Record<string, unknown>) => {
        const { error } = payload as { error: string };
        this.core.brief('error', sender, error);
      },
    });

    // Question handler - allows child processes to ask user questions
    // This enables the "btw" mechanism for teammates
    this.ipcRegistry.register({
      messageType: 'question',
      module: 'core',
      handler: async (sender: string, payload: Record<string, unknown>, ctx: AgentContext) => {
        const { query } = payload as { query: string };
        try {
          // Pass sender as asker so user knows who is asking
          const response = await ctx.core.question(query, sender);
          return { success: true, data: { response } };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return { success: false, error: errorMessage };
        }
      },
    });

    // Send mail handler - allows teammates to send mail through lead
    this.ipcRegistry.register({
      messageType: 'send_mail',
      module: 'team',
      handler: (sender: string, payload: Record<string, unknown>) => {
        const { to, title, content } = payload as { to: string; title: string; content: string };

        // Sending to lead
        if (to === 'lead') {
          // Mail to lead - store in lead's mailbox
          const mail = createMail('lead');
          mail.appendMail(sender, title, content);
          return { success: true, data: { to } };
        }

        // Check if recipient exists
        const recipient = this.getTeammate(to);
        if (!recipient) {
          const available = this.listTeammates()
            .map((t) => t.name)
            .join(', ') || 'none';
          return {
            success: false,
            error: `Recipient '${to}' not found. Available teammates: ${available}. Use 'lead' to message the lead agent.`,
          };
        }

        // Check if recipient is still active
        if (recipient.status === 'shutdown') {
          return {
            success: false,
            error: `Recipient '${to}' has shutdown.`,
          };
        }

        // Route mail to recipient
        this.mailTo(to, title, content, sender);
        return { success: true, data: { to } };
      },
    });
  }

  /**
   * Initialize the IPC registry with AgentContext
   * Called after all modules are created
   */
  initializeContext(ctx: AgentContext): void {
    this.ipcRegistry.setContext(ctx);
  }

  /**
   * Register an IPC handler for a message type
   */
  registerHandler(registration: IpcHandlerRegistration): void {
    this.ipcRegistry.register(registration);
  }

  /**
   * Unregister an IPC handler
   */
  unregisterHandler(messageType: string): void {
    this.ipcRegistry.unregister(messageType);
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
    child.on('message', (msg: IpcMessage) => {
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
    child.send({
      type: 'spawn',
      name,
      role,
      prompt,
    });

    return `Spawned teammate '${name}' (role: ${role}) as child process (pid: ${child.pid})`;
  }

  /**
   * Handle IPC message from child process
   */
  private handleChildMessage(sender: string, msg: IpcMessage): void {
    // Special case: status needs internal Map update (handled before registry)
    if (msg.type === 'status' && 'status' in msg) {
      const status = msg.status as TeammateStatus;
      this.statuses.set(sender, status);
      this.updateDbStatus(sender, status);
    }

    // Check for request/response pattern (has reqId)
    const hasReqId = typeof msg.reqId === 'number';

    // Dispatch to registered handlers
    this.ipcRegistry
      .dispatch(sender, msg)
      .then((result) => {
        // For request/response messages, send response back to child
        if (hasReqId && msg.reqId !== undefined) {
          this.sendResponse(sender, msg.reqId, result?.success ?? true, result?.data, result?.error);
        }
      })
      .catch((err) => {
        if (hasReqId && msg.reqId !== undefined) {
          this.sendResponse(sender, msg.reqId, false, undefined, err.message);
        }
      });
  }

  /**
   * Send a response back to child process
   */
  private sendResponse(
    sender: string,
    reqId: number,
    success: boolean,
    data?: unknown,
    error?: string
  ): void {
    const child = this.processes.get(sender);
    if (child && child.connected) {
      child.send({
        type: 'db_result',
        reqId,
        success,
        data,
        error,
      });
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
   * @param name - Teammate name
   * @param force - If true, kill the process immediately; otherwise send soft shutdown
   */
  removeTeammate(name: string, force: boolean = false): void {
    const child = this.processes.get(name);
    if (child) {
      if (force) {
        // Force kill the process
        child.kill('SIGTERM');
      } else if (child.connected) {
        // Soft shutdown: send IPC message and disconnect
        child.send({ type: 'shutdown' } as ParentMessage);
        child.disconnect();
      }
    }

    this.processes.delete(name);
    this.statuses.delete(name);

    const db = getDb();
    const stmt = db.prepare(`DELETE FROM teammates WHERE name = ?`);
    stmt.run(name);
  }

  /**
   * Dismiss all teammates
   * @param force - If true, kill processes immediately; otherwise send soft shutdown
   */
  dismissTeam(force: boolean = false): void {
    for (const [name, child] of this.processes) {
      if (force) {
        // Force kill the process
        child.kill('SIGTERM');
      } else if (child.connected) {
        // Soft shutdown: send IPC message and disconnect
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
   * @param name - Recipient name
   * @param title - Message title
   * @param content - Message content
   * @param from - Sender name (defaults to 'lead')
   */
  mailTo(name: string, title: string, content: string, from: string = 'lead'): void {
    const mail = createMail(name);
    mail.appendMail(from, title, content);

    // Log to transcript
    if (this.transcript) {
      this.transcript.logMailSend('lead', name, title, content);
    }
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