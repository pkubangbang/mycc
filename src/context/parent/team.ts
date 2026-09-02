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
  TeammateWaitReason,
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
import { stopSpinner } from '../../engine/chat-helpers.js';
import { getServeHub } from '../../serve/serve-registry.js';

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
      // awaitTeammates polls this.statuses on each 1s tick, so a status
      // change is picked up on the next poll — no subscriber plumbing.
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
        // Immediately notify the user that a question is queued. Without this,
        // the thinking spinner (if active during an LLM call) silently covers
        // the fact that a teammate is blocked and waiting for an answer. The
        // spinner is stopped here so the notification is visible; we do NOT
        // restart it — team.ts must not couple to the LLM provider's spinner
        // state. retryChat's finally-block stopSpinner() is idempotent (no-op
        // when the interval is already null), so there are no side effects.
        // The actual blocking Q&A still happens in handlePendingQuestions()
        // at the start of the next COLLECT state.
        stopSpinner();
        this.context.core.brief(
          'warn', 'question',
          `${sender} has a question waiting (will be asked when current task finishes)`,
          msg.query as string,
        );
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
   * Wait for teammate(s) to stop, responding to steering so the WebUI chat
   * is not blocked.
   *
   * This is the SINGLE unified wait primitive. It polls every 1s and returns
   * a typed {@link TeammateWaitReason} as soon as one of the caller's
   * accepted `reasons` fires, so callers (STOP, AWAIT, the `tm_await` tool)
   * can pick the next state machine node deterministically:
   *   - 'all done'  — target teammate(s) reached idle/shutdown (finished)
   *   - 'holding'   — a teammate is blocked on a question for the lead
   *   - 'mail'      — new mail arrived in the lead's mailbox (teammate OR peer)
   *   - 'steering'  — a WebUI steering note was queued by the user
   *   - 'esc'       — the user pressed ESC (neglected mode)
   *   - 'timeout'   — the max-wait safety valve fired
   *
   * Callers restrict which reasons break the wait via `opts.reasons`:
   *   - STOP includes 'all done' + 'timeout' (bounded wait for completion)
   *   - AWAIT excludes them (unbounded wait for new events); it re-calls
   *     with a short `timeoutMs` and handles 'timeout' by re-checking
   *     autoState, then re-awaiting.
   *
   * `opts.name` narrows the teammate-status checks to a single teammate
   * (used by the `tm_await` tool's `name` argument); omit it to wait for
   * all teammates.
   *
   * @param opts - { name?, timeoutMs? (default 10min), reasons? (default all) }
   * @returns the reason the wait stopped
   */
  async awaitTeammates(opts?: {
    name?: string;
    timeoutMs?: number;
    reasons?: TeammateWaitReason[];
  }): Promise<TeammateWaitReason> {
    const name = opts?.name;
    const maxWaitMs = opts?.timeoutMs ?? 10 * 60 * 1000;
    const accepted: TeammateWaitReason[] = opts?.reasons
      ?? ['all done', 'holding', 'mail', 'steering', 'esc', 'timeout'];
    const accepts = (r: TeammateWaitReason): boolean => accepted.includes(r);

    const waitStart = Date.now();

    // Helper: filter teammates by the optional `name` (single-teammate wait).
    const scopedTeammates = () => {
      const all = this.listTeammates();
      return name ? all.filter((t) => t.name === name) : all;
    };

    // First tick is immediate (no sleep), so an event already pending is
    // caught without a 1s delay. Subsequent ticks sleep 1s.
    let firstTick = true;
    while (true) {
      // ESC pressed — break so the lead can return to PROMPT.
      if (accepts('esc') && agentIO.isNeglectedMode()) {
        return 'esc';
      }

      const live = scopedTeammates();

      // A teammate is holding (has a question for the lead).
      if (accepts('holding') && live.some((t) => t.status === 'holding')) {
        return 'holding';
      }

      // No working teammates → all done. (Idle/shutdown are the resting state.)
      // Only fired when the caller accepts 'all done' (STOP does; AWAIT does not).
      if (accepts('all done') && !live.some((t) => t.status === 'working')) {
        return 'all done';
      }

      // New mail arrived in the lead's mailbox (teammate results, peer mail,
      // system reminders). Source-agnostic — callers route it the same way.
      if (accepts('mail') && this.context.mail.hasNewMails()) {
        return 'mail';
      }

      // WebUI steering note queued by the user (mid-task direction). PEEK
      // only (non-consuming) — the drain happens downstream in COLLECT's 2c
      // block, keeping a single consumption point.
      if (accepts('steering')
        && getServeHub().isRunning()
        && getServeHub().getSteeringNotes().length > 0) {
        return 'steering';
      }

      // Safety valve: max-wait exceeded while a teammate is still working.
      if (accepts('timeout') && Date.now() - waitStart >= maxWaitMs) {
        return 'timeout';
      }

      // Nothing fired — sleep briefly and re-check. The 1s poll keeps the
      // wait responsive to teammate transitions without busy-spinning.
      if (firstTick) {
        firstTick = false;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
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
        // The displayed deadline is an ADVISORY SNAPSHOT set once on the
        // child's eta_update IPC and never auto-refreshed. A re-activated
        // teammate (IDLE → WORK via mail or auto-claim) does NOT send a
        // fresh eta_update unless its first action is a mail_to(lead, eta>0).
        // So `remaining === 0` on a `working` teammate means "the previously
        // declared budget elapsed", NOT "about to terminate" — annotate it
        // explicitly so the lead does not misread a stale 0s as a live
        // countdown. Only awaitTeammates's 'timeout' reason is an
        // actionable expiry signal; this row is not.
        if (remaining > 0) {
          info += `, deadline ${deadlineStr} (${remaining}s remaining)`;
        } else {
          info += `, deadline ${deadlineStr} elapsed (re-activated; no fresh eta)`;
        }
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
        const result = await this.context.core.question(q.query, q.sender, q.options);
        this.sendResponse(q.sender, q.reqId, 'question_result', true, result);
        // Add Q&A to lead's mailbox as system reminder (FYI, no action needed)
        this.context.mail.appendMail(
          'lead',
          `Q&A from ${q.sender}`,
          `<system-reminder>
${q.sender} asked: ${result.question}
Answer: ${result.answer}
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