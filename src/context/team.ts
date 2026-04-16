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
  SendResponseCallback,
} from '../types.js';
import { getDb } from './db.js';
import { MailBox } from './mail.js';
import { IpcRegistry } from './child-context/ipc-registry.js';
import type { CoreModule } from '../types.js';
import { readSession, writeSession } from '../session/index.js';

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
  private context: AgentContext;
  private processes: Map<string, ChildProcess> = new Map();
  private statuses: Map<string, TeammateStatus> = new Map();
  private ipcRegistry: IpcRegistry;
  private sessionFilePath: string;
  private pendingQuestions: Array<{
    sender: string;
    reqId: number;
    query: string;
  }> = [];

  // Two-phase await subscribers
  private phase1Subscribers: Map<string, Set<() => void>> = new Map(); // waiting for working
  private phase2Subscribers: Map<string, Set<() => void>> = new Map(); // waiting for idle/shutdown

  constructor(context: AgentContext, sessionFilePath: string) {
    this.context = context;
    this.sessionFilePath = sessionFilePath;
    this.ipcRegistry = new IpcRegistry();
    this.ipcRegistry.setContext(context);
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
      cwd: this.context.core.getWorkDir(),
      // Pipe stdout/stderr but don't log them - child uses IPC for structured logging
      silent: true,
    });

    // Track process
    this.processes.set(name, child);
    this.statuses.set(name, 'working');

    // Handle IPC messages from child
    child.on('message', (msg: IpcMessage) => {
      this.handleChildMessage(name, msg);
    });

    // Handle process exit
    child.on('exit', (code) => {
      this.statuses.set(name, 'shutdown');
      this.updateDbStatus(name, 'shutdown');
      this.processes.delete(name);
      this.context.core.brief('info', name, `Process exited (code ${code})`);
    });

    // Handle errors
    child.on('error', (err) => {
      this.context.core.brief('error', name, `Process error: ${err.message}`);
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
  private async handleChildMessage(sender: string, msg: IpcMessage): Promise<void> {
    const reqId = typeof msg.reqId === 'number' ? msg.reqId : undefined;

    // === Notifications (no response expected) ===
    if (msg.type === 'status') {
      const status = msg.status as TeammateStatus;
      this.statuses.set(sender, status);
      this.updateDbStatus(sender, status);

      // Resolve subscribers based on status change
      if (status === 'working') {
        // Phase 1 complete: move subscribers to phase 2
        const phase1 = this.phase1Subscribers.get(sender);
        if (phase1 && phase1.size > 0) {
          const phase2 = this.phase2Subscribers.get(sender) ?? new Set();
          for (const resolve of phase1) {
            phase2.add(resolve);
          }
          this.phase2Subscribers.set(sender, phase2);
          phase1.clear();
        }
      } else if (status === 'idle' || status === 'shutdown' || status === 'holding') {
        // Phase 2 complete: resolve all waiting for finish
        const phase2 = this.phase2Subscribers.get(sender);
        if (phase2) {
          for (const resolve of phase2) {
            resolve();
          }
          phase2.clear();
        }
      }
      return;
    }

    if (msg.type === 'teammate_ready') {
      const teammateName = msg.name as string;
      const triologuePath = msg.path as string;
      if (sender !== teammateName) {
        this.context.core.brief('error', 'session', `teammate ${teammateName} ready but the actual sender is ${sender}`);
        return;
      }

      const session = readSession(this.sessionFilePath);
      if (!session) {
        this.context.core.brief('error', 'session', `session file ${triologuePath} cannot be read!`);
        return;
      }

      if (!session.teammates.includes(teammateName)) {
        session.teammates.push(teammateName);
      }
      
      if (!session.child_triologues.includes(triologuePath)) {
        session.child_triologues.push(triologuePath);
      }
      
      try {
        writeSession(this.sessionFilePath, session);
      } catch (e) {
        this.context.core.brief('error', 'session', `Cannot write session file ${triologuePath}!`);
      }
    }

    if (msg.type === 'log') {
      const message = msg.message as string;
      this.context.core.brief('info', sender, message);
      return;
    }

    if (msg.type === 'error') {
      const error = msg.error as string;
      this.context.core.brief('error', sender, error);
      return;
    }

    // Verbose logging from child (only shown in verbose mode)
    if (msg.type === 'verbose') {
      const { tool, message, data } = msg as unknown as { tool: string; message: string; data?: unknown };
      this.context.core.verbose(tool, `[${sender}] ${message}`, data);
      return;
    }

    // === Request/Response (requires response) ===
    if (reqId === undefined) {
      // No reqId means it's a notification we don't recognize
      return;
    }

    // Create sendResponse callback that sends to this specific child
    const sendResponse: SendResponseCallback = (responseType, success, data, error) => {
      this.sendResponse(sender, reqId, responseType, success, data, error);
    };

    try {
      // === Question (queue for later handling) ===
      if (msg.type === 'question') {
        this.pendingQuestions.push({
          sender,
          reqId: reqId!,
          query: msg.query as string,
        });
        return;
      }

      // === Dispatch to registered handlers ===
      await this.ipcRegistry.dispatch(sender, msg, sendResponse);
    } catch (err) {
      sendResponse('error', false, undefined, (err as Error).message);
    }
  }

  /**
   * Send a response back to child process
   */
  private sendResponse(
    sender: string,
    reqId: number,
    responseType: string,
    success: boolean,
    data?: unknown,
    error?: string
  ): void {
    const child = this.processes.get(sender);
    if (child && child.connected) {
      child.send({
        type: responseType,
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
   * Wait for a specific teammate to finish.
   *
   * Resolves on the TRANSITION from 'working' to another status, not just the being of a status.
   * - If 'holding': resolve immediately (lead should process pending questions)
   * - If 'working': wait for transition to non-working (phase 2)
   * - If 'idle'/'shutdown' or undefined: subscribe to phase 1 (will move to phase 2 when they start)
   */
  async awaitTeammate(name: string, timeout: number = 60000): Promise<{ waited: boolean }> {
    const status = this.statuses.get(name);

    // Create promise that resolves when teammate finishes their current work cycle
    const promise = new Promise<void>((resolve) => {
      if (status === 'holding') {
        // Holding means they have a question - resolve immediately
        // Lead should process pending questions
        resolve();
      } else if (status === 'working') {
        // Currently working - subscribe to phase 2 (working → non-working transition)
        const phase2 = this.phase2Subscribers.get(name) ?? new Set<() => void>();
        phase2.add(resolve);
        this.phase2Subscribers.set(name, phase2);
      } else {
        // Not working (idle/shutdown/undefined) - subscribe to phase 1
        // Will be moved to phase 2 when they start working
        // This ensures we wait for: start working → finish working transition
        const phase1 = this.phase1Subscribers.get(name) ?? new Set<() => void>();
        phase1.add(resolve);
        this.phase1Subscribers.set(name, phase1);
      }
    });

    // Race with timeout
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout waiting for teammate ${name}`)), timeout);
    });

    await Promise.race([promise, timeoutPromise]);
    return { waited: true };
  }

  /**
   * Wait for all teammates to finish.
   *
   * Implements a phased waiting strategy:
   * 1. If no teammates or all shutdown → return "no teammates" immediately
   * 2. Watch for 'holding' status every 1s → return "got question" immediately
   * 3. Wait 5 seconds for teammates to enter working state
   * 4. After 5s, if all idle/shutdown → return "no workload"
   * 5. Else watch for all to finish (idle/shutdown/holding) with timeout
   * 6. If all finish in time → return "all done", else → return "timeout"
   *
   * @returns result: "no teammates" | "got question" | "no workload" | "all done" | "timeout"
   */
  async awaitTeam(timeout: number = 60000): Promise<{ result: string }> {
    const POLL_INTERVAL_MS = 1000;
    const INITIAL_WAIT_MS = 5000;

    const teammates = this.listTeammates();

    // Step 1: Check if no teammates or all shutdown
    if (teammates.length === 0 || teammates.every((t) => t.status === 'shutdown')) {
      return { result: 'no teammates' };
    }

    // Short-circuit: holding is highest priority - return immediately
    if (teammates.some((t) => t.status === 'holding')) {
      return { result: 'got question' };
    }

    // Helper to get current statuses
    const getStatuses = () => {
      const current = this.listTeammates();
      return {
        holding: current.some((t) => t.status === 'holding'),
        working: current.some((t) => t.status === 'working'),
        allSettled: current.every((t) => t.status === 'idle' || t.status === 'shutdown'),
      };
    };

    // Step 2: Set up periodic watcher for holding status during initial wait
    const startTime = Date.now();
    let holdingDetected = false;

    // Watch for holding during the initial 5-second period
    const initialWatchPromise = new Promise<void>((resolve) => {
      const intervalId = setInterval(() => {
        const statuses = getStatuses();
        if (statuses.holding) {
          holdingDetected = true;
          clearInterval(intervalId);
          resolve();
        }
      }, POLL_INTERVAL_MS);

      // Clean up after initial wait
      setTimeout(() => {
        clearInterval(intervalId);
        resolve();
      }, INITIAL_WAIT_MS);
    });

    await initialWatchPromise;

    // If holding detected during initial watch, return immediately
    if (holdingDetected) {
      return { result: 'got question' };
    }

    // Step 3: Check status after initial wait
    const afterInitial = getStatuses();

    // Step 4: If all idle/shutdown after 5 seconds, return "no workload"
    if (afterInitial.allSettled) {
      return { result: 'no workload' };
    }

    // Step 5: At least one working - watch for completion with timeout
    const remainingTimeout = Math.max(0, timeout - (Date.now() - startTime));

    if (remainingTimeout <= 0) {
      return { result: 'timeout' };
    }

    const completionPromise = new Promise<string>((resolve) => {
      const intervalId = setInterval(() => {
        const statuses = getStatuses();
        if (statuses.holding) {
          clearInterval(intervalId);
          resolve('got question');
        } else if (statuses.allSettled) {
          clearInterval(intervalId);
          resolve('all done');
        }
      }, POLL_INTERVAL_MS);

      // Timeout
      setTimeout(() => {
        clearInterval(intervalId);
        resolve('timeout');
      }, remainingTimeout);
    });

    const result = await completionPromise;
    return { result };
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
    const mail = new MailBox(name);
    mail.appendMail(from, title, content);
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

  /**
   * Handle pending questions from children
   * Called at the start of each agent loop iteration
   */
  async handlePendingQuestions(): Promise<void> {
    while (this.pendingQuestions.length > 0) {
      const q = this.pendingQuestions.shift()!;
      try {
        const response = await this.context.core.question(q.query, q.sender);
        this.sendResponse(q.sender, q.reqId, 'question_result', true, { response });
        // Add Q&A to lead's mailbox as system reminder (FYI, no action needed)
        this.context.mail.appendMail(
          'lead',
          `Q&A from ${q.sender}`,
          `<system-reminder>
${q.sender} asked: ${q.query}
Answer: ${response}
(Answer already sent to ${q.sender} - no forwarding needed)
</system-reminder>`
        );
      } catch (err) {
        this.sendResponse(q.sender, q.reqId, 'question_result', false, undefined, (err as Error).message);
        this.context.core.brief('warn', 'question', `${q.sender}'s question was rejected`);
      }
    }
  }
}