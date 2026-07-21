/**
 * team.ts - Team module: child process teammates with IPC
 */

import { ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type {
  TeamModule,
  Teammate,
  TeammateStatus,
  AgentContext,
  IpcHandlerRegistration,
  SendResponseCallback,
} from '../../types.js';
import chalk from 'chalk';
import { getSessionDir } from '../../config.js';
import { getProjectRoot, spawnTsx } from '../../utils/tsx-run.js';
import * as MemoryStore from '../memory-store.js';
import { MailBox } from '../shared/mail.js';
import { IpcRegistry } from '../ipc-registry.js';
import { readSession, writeSession, getSessionId } from '../../session/index.js';
import { agentIO } from '../../loop/agent-io.js';

// Project root for resolving paths
const PROJECT_ROOT = getProjectRoot();

/**
 * IPC message types (parent to child)
 */
type ParentMessage =
  | { type: 'spawn'; name: string; role: string; prompt: string; sessionId: string; cwd?: string }
  | { type: 'message'; from: string; title: string; content: string }
  | { type: 'shutdown' }
  | { type: 'mode_change'; mode: 'plan' | 'normal' }
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
 * Team module implementation using in-memory storage + child processes
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
    options?: { onEsc?: string; onEnter?: string };
  }> = [];

  // Two-phase await subscribers
  private phase1Subscribers: Map<string, Set<() => void>> = new Map(); // waiting for working
  private phase2Subscribers: Map<string, Set<() => void>> = new Map(); // waiting for idle/shutdown

  // ETA/deadline tracking per teammate (from eta_update IPC)
  private teammateEta: Map<string, {
    deadlineMs: number;     // Absolute deadline in ms (eta * 1000)
    updatedAt: number;      // When this ETA was last set
  }> = new Map();

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
   * Waits for the child to send 'teammate_ready' before returning
   */
  async createTeammate(name: string, role: string, prompt: string, cwd?: string): Promise<string> {
    // Check if teammate already exists
    const existing = this.getTeammate(name);
    if (existing && existing.status !== 'shutdown') {
      return `Error: Teammate '${name}' already exists with status ${existing.status}`;
    }

    // Determine working directory: use provided cwd (e.g., a worktree) or lead's workdir
    const spawnCwd = cwd || this.context.core.getWorkDir();

    // Generate triologue path in session directory
    const sessionId = getSessionId(this.sessionFilePath);
    const sessionDir = getSessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const triologuePath = path.join(sessionDir, `triologue-${name}-${timestamp}.jsonl`);

    // Register in session file BEFORE spawning child
    const session = readSession(this.sessionFilePath);
    if (session) {
      if (!session.teammates.includes(name)) {
        session.teammates.push(name);
      }
      if (!session.child_triologues.includes(triologuePath)) {
        session.child_triologues.push(triologuePath);
      }
      writeSession(this.sessionFilePath, session);
    }

    // Store in memory
    MemoryStore.createTeammate(name, role, prompt);

    // Clear stale unread mail from a previous incarnation of this teammate
    const mailbox = new MailBox(name);
    mailbox.clearUnread();

    // Spawn child process using tsx.
    // Spawn with the LEAD's workdir as cwd so the teammate's relative `.mycc/`
    // store resolves to the same project store the lead uses (shared
    // session/mail/issues/mindmap). The `cwd` param above is NOT the process
    // cwd — it's the teammate's sandboxed WORKDIR, sent via IPC and enforced
    // by the grant system (writes confined to WORKDIR; reads outside it stay
    // allowed).
    const child = spawnTsx({
      script: path.join(PROJECT_ROOT, 'src', 'context', 'teammate-worker.ts'),
      cwd: this.context.core.getWorkDir(),
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
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
      MemoryStore.updateTeammateStatus(name, 'shutdown');
      this.processes.delete(name);
      // Route the exit notice into the teammate's own drawer (not the main
      // chat log) by using the @name/tool label convention. The `exit` tool
      // tag doubles as a sentinel: the WebUI treats a teammate whose LAST
      // message has toolTag==='exit' as "retired" (已完成). This lets the
      // TeammateCard collapse to a thin trigger once every teammate is done.
      // (Re-activation appends a newer non-exit message, clearing the state.)
      this.context.core.brief('info', `@${name}/exit`, `Process exited (code ${code})`);
    });

    // Handle errors
    child.on('error', (err) => {
      this.context.core.brief('error', name, `Process error: ${err.message}`);
      this.statuses.set(name, 'shutdown');
      MemoryStore.updateTeammateStatus(name, 'shutdown');
      this.processes.delete(name);
    });

    // Send spawn config to child via IPC (with pre-assigned triologue path and session ID)
    child.send({
      type: 'spawn',
      name,
      role,
      prompt,
      triologuePath,
      sessionId,
      cwd: spawnCwd,
    });

    // Wait for 'teammate_ready' notification with 30s timeout
    const ready = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        child.removeAllListeners('message');
        resolve(false);
      }, 30000);

      const handler = (msg: IpcMessage) => {
        if (msg.type === 'teammate_ready' && msg.name === name) {
          clearTimeout(timeout);
          child.removeListener('message', handler);
          resolve(true);
        }
      };
      child.on('message', handler);
    });

    if (!ready) {
      child.kill('SIGTERM');
      return `Error: Teammate '${name}' failed to initialize within 30s. The child process was killed.`;
    }

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
      MemoryStore.updateTeammateStatus(sender, status);

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
      // Teammate is ready - path already registered in createTeammate()
      // Just verify sender matches and log
      const teammateName = msg.name as string;
      if (sender !== teammateName) {
        this.context.core.brief('error', 'session', `teammate ${teammateName} ready but the actual sender is ${sender}`);
        return;
      }
      this.context.core.brief('info', teammateName, 'Teammate ready');
      return;
    }

    if (msg.type === 'eta_update') {
      // Teammate sent a time budget (absolute ETA)
      const etaMsg = msg as unknown as { eta: number; sender: string };
      const deadlineMs = etaMsg.eta * 1000;
      this.teammateEta.set(etaMsg.sender, { deadlineMs, updatedAt: Date.now() });
      const deadlineStr = new Date(deadlineMs).toLocaleTimeString();
      const banner = chalk.bgCyan.black.bold(
        ` ${etaMsg.sender} will be finishing the task by ${deadlineStr} `
      );
      this.context.core.brief('info', 'eta_update', banner);
      return;
    }

    if (msg.type === 'log') {
      const message = msg.message as string;
      const detail = msg.detail as string | undefined;
      const tool = msg.tool as string | undefined;
      // Build the @-prefix teammate label for the WebUI teammate timeline.
      // @sender/tool routes the message into state.teammateMessages instead
      // of the main chat log. Without a tool tag (rare), fall back to
      // @sender. See the "@-prefix teammate label convention" in MYCC.md.
      const label = tool ? `@${sender}/${tool}` : `@${sender}`;
      this.context.core.brief('info', label, message, detail);
      return;
    }

    if (msg.type === 'error') {
      const error = msg.error as string;
      const detail = msg.detail as string | undefined;
      const tool = msg.tool as string | undefined;
      // Same @-prefix routing as the log handler above — teammate errors go
      // to the teammate timeline, not the main chat log.
      const label = tool ? `@${sender}/${tool}` : `@${sender}`;
      this.context.core.brief('error', label, error, detail);
      return;
    }

    // Verbose logging from child (only shown in verbose mode)
    if (msg.type === 'verbose') {
      const { tool, message, data } = msg as unknown as { tool: string; message: string; data?: unknown };
      this.context.core.verbose(tool, `[${sender}] ${message}`, data);
      return;
    }

    // Condition replacement notification from a teammate's skill_compile call.
    // A teammate (child process) has no runtime ConditionRegistry, so its
    // loader.compileCondition() writes the compiled condition to disk and
    // sends this notification. We reload the Lead's in-memory registry from
    // disk so the hook system picks up the new condition without a restart.
    // Fire-and-forget (no reqId, no response).
    if (msg.type === 'condition_replace') {
      const { skillName } = msg as unknown as { skillName: string };
      const result = await this.context.skill.replaceCondition(skillName);
      if (!result.success) {
        this.context.core.brief('warn', sender,
          `condition_replace for '${skillName}' failed: ${result.error}`);
      } else {
        this.context.core.brief('info', sender,
          `Hook condition for '${skillName}' reloaded from disk`);
      }
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
          options: msg.options as { onEsc?: string; onEnter?: string } | undefined,
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
   * Get teammate info
   */
  getTeammate(name: string): Teammate | undefined {
    const stored = MemoryStore.getTeammate(name);
    if (!stored) return undefined;

    return {
      name: stored.name,
      role: stored.role,
      status: (this.statuses.get(name) || stored.status) as TeammateStatus,
      process: this.processes.get(name),
      prompt: stored.prompt,
      createdAt: stored.createdAt,
    };
  }

  /**
   * List all teammates
   */
  listTeammates(): { name: string; role: string; status: TeammateStatus }[] {
    const stored = MemoryStore.listTeammates();
    return stored.map((t) => ({
      name: t.name,
      role: t.role,
      status: (this.statuses.get(t.name) || t.status) as TeammateStatus,
    }));
  }

  /**
   * Wait for a specific teammate to finish.
   *
   * Uses the teammate's ETA (from mail_to) as the dynamic timeout.
   * Polls every 1s for status changes and deadline extensions.
   * - If 'idle'/'shutdown': resolve immediately (finished)
   * - If 'holding': resolve immediately (need to answer question)
   * - If 'working': wait for status change or deadline expiry
   *
   * @param defaultTimeout - Fallback timeout in ms when no ETA is set (default: 5min)
   */
  async awaitTeammate(name: string, defaultTimeout: number = 300000): Promise<{ waited: boolean }> {
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

    // Dynamic timeout with poll-based deadline tracking
    const timeoutPromise = new Promise<void>((resolve) => {
      let lastCheck = 0;
      const poll = () => {
        // ESC pressed — resolve immediately so the lead can return to PROMPT
        if (agentIO.isNeglectedMode()) {
          resolve(); return;
        }

        const currentStatus = this.statuses.get(name);
        if (currentStatus === 'idle' || currentStatus === 'shutdown') {
          resolve(); return; // finished
        }

        // Check if the teammate sent mail to lead — resolve so lead can read it
        if (this.context.mail.hasNewMails()) {
          resolve(); return; // mail waiting — let lead read and respond
        }

        const eta = this.teammateEta.get(name);
        if (eta) {
          if (eta.updatedAt > lastCheck) {
            lastCheck = eta.updatedAt; // deadline was extended
          }
          if (Date.now() >= eta.deadlineMs) {
            // Deadline passed — notify lead via brief
            this.context.core.brief('warn', name,
              `Deadline ${new Date(eta.deadlineMs).toLocaleTimeString()} passed. ` +
              `Use tm_await to wait longer, tm_remove to terminate.`);
            resolve(); return;
          }
        } else if (lastCheck === 0) {
          lastCheck = Date.now(); // start default timeout
        } else if (Date.now() - lastCheck >= defaultTimeout) {
          resolve(); return; // default timeout expired
        }

        setTimeout(poll, 1000);
      };
      poll();
    });

    await Promise.race([promise, timeoutPromise]);
    return { waited: true };
  }

  /**
   * Wait for all teammates to finish.
   *
   * Uses each teammate's ETA deadline as the dynamic timeout.
   * Resolves as soon as one teammate raises a question (holding).
   *
   * @returns result: "no teammates" | "got question" | "all done" | "timeout"
   */
  async awaitTeam(_timeout?: number): Promise<{ result: string }> {
    const teammates = this.listTeammates();

    // No teammates or all shutdown
    if (teammates.length === 0 || teammates.every((t) => t.status === 'shutdown')) {
      return { result: 'no teammates' };
    }

    // Holding is highest priority — return immediately
    const holding = teammates.find((t) => t.status === 'holding');
    if (holding) {
      return { result: 'got question' };
    }

    // If nobody is working, no need to wait
    const working = teammates.filter((t) => t.status === 'working');
    if (working.length === 0) {
      return { result: 'all done' };
    }

    // Wait for each working teammate via awaitTeammate (which respects ETA deadlines)
    await Promise.all(working.map((t) => this.awaitTeammate(t.name)));

    // After all resolves, check final state
    const finalTeammates = this.listTeammates();
    const finalHolding = finalTeammates.some((t) => t.status === 'holding');
    if (finalHolding) {
      return { result: 'got question' };
    }

    return { result: 'all done' };
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
      let info = `  ${t.name} (${t.role}): ${t.status}`;
      const eta = this.teammateEta.get(t.name);
      if (eta && t.status === 'working') {
        const remaining = Math.max(0,
          Math.round((eta.deadlineMs - Date.now()) / 1000));
        const deadlineStr = new Date(eta.deadlineMs).toLocaleTimeString();
        info += `, deadline ${deadlineStr} (${remaining}s remaining)`;
      }
      lines.push(info);
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
        // Soft shutdown: send IPC message (do NOT disconnect - child exits cooperatively)
        child.send({ type: 'shutdown' } as ParentMessage);
      }
    }

    this.processes.delete(name);
    this.statuses.delete(name);
    this.teammateEta.delete(name);
    MemoryStore.removeTeammate(name);
  }

  /**
   * Dismiss all teammates
   * @param force - If true, kill processes immediately; otherwise send soft shutdown
   */
  dismissTeam(force: boolean = false): void {
    for (const [, child] of this.processes) {
      if (force) {
        // Force kill the process
        child.kill('SIGTERM');
      } else if (child.connected) {
        // Soft shutdown: send IPC message (do NOT disconnect - child exits cooperatively)
        child.send({ type: 'shutdown' } as ParentMessage);
      }
    }

    this.processes.clear();
    this.statuses.clear();

    // Remove all from memory store
    for (const name of MemoryStore.listTeammates().map((t) => t.name)) {
      MemoryStore.removeTeammate(name);
    }
  }

  /**
   * Send mail to a teammate
   * @param name - Recipient name
   * @param title - Message title
   * @param content - Message content
   * @param from - Sender name (defaults to 'lead')
   * @param _eta - Optional time budget in seconds. Ignored by parent (only child sends IPC).
   */
  mailTo(name: string, title: string, content: string, from: string = 'lead', _eta?: number): void {
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
   * Broadcast mode change to all teammates via IPC
   * Sends immediate notification so teammates can reset tool aversion
   * @param mode - The new mode ('plan' or 'normal')
   */
  broadcastModeChange(mode: 'plan' | 'normal'): void {
    const teammates = this.listTeammates();
    for (const t of teammates) {
      const child = this.processes.get(t.name);
      if (child && child.connected) {
        child.send({ type: 'mode_change', mode });
      }
    }
    this.context.core.brief('info', 'mode_change', `Broadcasted to ${teammates.length} teammates`);
  }

  /**
   * Handle pending questions from children
   * Called at the start of each agent loop iteration
   */
  async handlePendingQuestions(): Promise<void> {
    while (this.pendingQuestions.length > 0) {
      const q = this.pendingQuestions.shift()!;
      try {
        const response = await this.context.core.question(q.query, q.sender, q.options);
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