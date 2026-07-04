/**
 * types.ts - Shared type definitions for the coding agent
 */

import type { ChildProcess } from 'child_process';
import type { JSONSchema7 } from 'json-schema';
import type { Message as OllamaMessage, ToolCall as OllamaToolCall } from 'ollama';
import { WebFetchResponse, WebSearchResult } from 'ollama';
import type { Mindmap } from './mindmap/types.js';
import type { Condition } from './hook/conditions.js';
import type { ValidationResult } from './hook/condition-validator.js';

// ============================================================================
// Ollama Type Extensions
// ============================================================================

/**
 * Extended ToolCall with id property
 * Ollama returns tool calls with unique IDs that need to be echoed back in tool responses
 */
export interface ToolCall extends OllamaToolCall {
  id: string;
}

/**
 * Categories for system-generated notes added to the conversation.
 * These are injected by the agent system (not from the actual user).
 */
export type NoteCategory =
  /** Todo nudges, status reminders */
  | 'REMINDER'
  /** Problem analysis hints generated during confusion */
  | 'HINT'
  /** Informational messages (e.g., bang command results) */
  | 'FYI'
  /** Critical notifications requiring immediate attention (ESC interrupts) */
  | 'URGENT'
  /** Checkpoint recap summaries replacing compressed message spans */
  | 'RECAP'
  /** System-level notifications (mode changes, configuration updates) */
  | 'SYSTEM_NOTIFICATION'
  /** Error notifications from the system */
  | 'SYSTEM_ERROR'
  /** Auto-claimed issue notifications for teammates */
  | 'AUTO_CLAIMED'
  /** Checkpoint markers for message compression */
  | 'CHECKPOINT'
  /** ESC wrap-up continuation messages */
  | 'WRAP_UP'
  /** Inter-agent mail messages */
  | 'MAIL'
  /** "Continue with your task" prompts */
  | 'CONTINUE'
  /** Team status updates with deadline info */
  | 'TEAM_STATUS'
  /** Timeout notifications */
  | 'TIMEOUT';

/**
 * Extended Message with tool response fields
 * - tool_name: the function name (Ollama API field)
 * - tool_call_id: hidden ID from agent's chat response (for alignment tracking)
 */
export interface Message extends OllamaMessage {
  reasoning_content?: string;
  tool_call_id?: string;
}

// ============================================================================
// Tool Definitions
// ============================================================================

/**
 * Tool definition format - tools export this interface
 * @see src/tools/bash.ts for example
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JSONSchema7;
  scope: string[]; // e.g., ['main', 'child', 'bg']
  handler: (ctx: AgentContext, args: Record<string, unknown>, signal?: AbortSignal) => string | Promise<string>;
}

/**
 * Tool definition for Ollama API
 * Matches the Ollama library's Tool interface
 */
export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type?: string;
      $defs?: unknown;
      items?: unknown;
      required?: string[];
      properties?: Record<string, {
        type?: string | string[];
        items?: unknown;
        description?: string;
        enum?: unknown[];
      }>;
    };
  };
}

/**
 * Tool scope - different tools available in different contexts
 */
export type ToolScope = 'main' | 'child';

// ============================================================================
// Mailbox
// ============================================================================

/**
 * Mailbox message
 */
export interface Mail {
  id: string;
  from: string;
  title: string;
  content: string;
  issueId?: number;
  timestamp: Date;
}

// ============================================================================
// Todo
// ============================================================================

/**
 * Todo item - temporary checklist
 */
export interface TodoItem {
  id: number;   // Unique identifier (auto-assigned on creation)
  name: string;
  done: boolean;
  note?: string;
  hash: string; // SHA256(name|done|note), first 8 hex chars — integrity signature
}

// ============================================================================
// Issue (Persisted Task)
// ============================================================================

/**
 * Issue status
 */
export type IssueStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'abandoned';

/**
 * Comment on an issue
 */
export interface IssueComment {
  poster: string; // 'system' for system messages, or agent name
  content: string;
  timestamp: Date;
}

/**
 * Issue - persisted task with blocking relationships
 */
export interface Issue {
  id: number;
  title: string;
  content: string;
  status: IssueStatus;
  owner?: string;
  blockedBy: number[]; // IDs of blocking issues
  blocks: number[]; // IDs of blocked issues
  comments: IssueComment[];
  createdAt: Date;
}

// ============================================================================
// Skill
// ============================================================================

/**
 * Skill - loaded from markdown files
 */
export interface Skill {
  name: string;
  description: string;
  keywords: string[];
  content: string;
  when?: string;  // Natural language hook condition
  sourceFile?: string;  // Source file path (relative to skills dir)
}

// ============================================================================
// Background Task
// ============================================================================

/**
 * Background task status
 */
export type BgTaskStatus = 'running' | 'completed' | 'failed' | 'killed';

/**
 * Background task - running bash command
 */
export interface BgTask {
  pid: number;
  command: string;
  startTime: Date;
  status: BgTaskStatus;
  output?: string;
}

// ============================================================================
// Worktree
// ============================================================================

/**
 * Worktree - git worktree for parallel work
 */
export interface WorkTree {
  name: string; // teammate name
  path: string; // worktree path
  branch: string; // branch name
  createdAt: Date;
  owner?: string; // teammate assigned to this worktree (if any)
}

// ============================================================================
// Teammate
// ============================================================================

/**
 * Teammate status
 */
export type TeammateStatus = 'working' | 'idle' | 'holding' | 'shutdown';

/**
 * Teammate - child process agent
 */
export interface Teammate {
  name: string;
  role: string;
  status: TeammateStatus;
  process?: ChildProcess;
  prompt?: string;
  createdAt: Date;
}

// ============================================================================
// AgentContext
// ============================================================================

/**
 * Core module interface
 */
export interface CoreModule {
  getWorkDir(): string;
  setWorkDir(dir: string): void;
  getName(): string;
  brief(level: 'info' | 'warn' | 'error', tool: string, message: string, detail?: string): void;
  /**
   * Get current confusion index (0-20 range)
   */
  getConfusionIndex(): number;
  /**
   * Increase confusion index by delta (can be negative to decrease)
   */
  increaseConfusionIndex(delta: number): void;
  /**
   * Reset confusion index to 0
   */
  resetConfusionIndex(): void;
  /**
   * Verbose logging - only outputs when -v flag is set
   * @param tool - Tool/module name
   * @param message - Log message
   * @param data - Optional data to pretty-print as JSON
   */
  verbose(tool: string, message: string, data?: unknown): void;
  /**
   * Ask user a question and wait for response
   * Used by tools to get user input during execution
   * @param query - The question to ask
   * @param asker - Optional name of who is asking (e.g., 'lead' or teammate name)
   * @param options - Optional: onEsc (value to resolve on ESC press), onEnter (value on empty Enter)
   */
  question(query: string, asker: string, options?: { onEsc?: string; onEnter?: string }): Promise<string>;
  /**
   * Search the web for information
   * @param query - The search query
   */
  webSearch(query: string): Promise<WebSearchResult[]>;
  /**
   * Fetch and parse content from a specific URL
   * @param url - The URL to fetch
   */
  webFetch(url: string): Promise<WebFetchResponse>;
  /**
   * Describe an image using the vision model
   * @param image - Base64-encoded image string or file path
   * @param prompt - Optional custom prompt for the vision model
   * @returns Description of the image
   */
  imgDescribe(image: string, prompt?: string): Promise<string>;
  /**
   * Request grant for sensitive operations (write_file, edit_file, bash)
   * Parent's Core checks mode and worktree ownership internally.
   * Child's Core sends IPC to parent for evaluation.
   * @param tool - The tool requesting grant
   * @param args - Tool arguments (path for file ops, command and intent for bash)
   * @returns Grant result with approval status and optional reason
   */
  requestGrant(tool: 'write_file' | 'edit_file' | 'bash', args: {
    path?: string;
    command?: string;
    intent?: string;
  }): Promise<{ approved: boolean; reason?: string }>;
  /**
   * Request access to a file/directory outside the workspace (cwd).
   *
   * When a tool needs to read/write/edit a path outside the project workspace,
   * this method asks the user for a session-scoped grant. The user can choose:
   *   1. Grant access to the folder (non-recursive)
   *   2. Grant access to the folder and all subdirectories
   *   3. Grant access to this file only
   *   4. Deny
   *
   * Grants are session-scoped and one-way open (never revoked).
   *
   * @param tool - The tool requesting external access
   * @param requestedPath - The resolved absolute path to check/request access for
   * @returns Result with approval status, resolved path, and optional reason
   */
  requestExternalPathAccess(
    tool: 'read_file' | 'write_file' | 'edit_file',
    requestedPath: string,
  ): Promise<{ approved: boolean; resolvedPath: string; reason?: string }>;
  /**
   * Pre-grant external path access for a directory (session-scoped, no user prompt).
   * All files within this directory and subdirectories are auto-approved
   * when requestExternalPathAccess is called.
   *
   * @param dir - Absolute path of the directory to auto-grant
   */
  addExternalAutoGrant(dir: string): void;
  /**
   * Get current agent mode ('plan' or 'normal')
   * Used by hooks to prevent false positives during planning
   * @returns 'plan' if in plan mode, 'normal' otherwise
   */
  getMode(): 'plan' | 'normal';
  /**
   * Get the loaded mindmap data
   * @returns Mindmap data or null if not loaded
   */
  getMindmap(): Mindmap | null;
  /**
   * Set the mindmap data
   */
  setMindmap(mindmap: Mindmap | null): void;
  /**
   * Wrap a slow operation with ESC-aware quick return
   * 
   * When ESC is pressed during a slow operation:
   * - The original promise continues in background
   * - onCleanUp is called immediately
   * - The result of onCleanUp is returned to caller
   * 
   * If ESC is not pressed, returns the original promise result.
   * 
   * @param operation - A function that receives an AbortController and returns the slow operation promise
   * @param onCleanUp - Called when ESC is pressed, must return the fallback result
   * @returns Original result if not interrupted, or onCleanUp result if ESC pressed
   */
  escAware<T>(operation: (abortController: AbortController) => Promise<T>, onCleanUp: () => T | Promise<T>): Promise<T>;
}

/**
 * Todo module interface
 */
export interface TodoModule {
  createTodo(name: string, note?: string): TodoItem;
  updateTodo(id: number, hash: string, name: string, done: boolean, note?: string): TodoItem | null;
  printTodoList(): string;
  hasOpenTodo(): boolean;
  clear(): void;
  getItems(): TodoItem[];
  /** Find the todo item auto-created for a checkpoint (by note=checkpointId). Returns null if not found or already done. */
  findCheckpointTodo(checkpointId: string): TodoItem | null;
  /** Close the todo item auto-created for a checkpoint. Best-effort, no error if not found. */
  closeCheckpointTodo(checkpointId: string): void;
}

/**
 * Mail module interface
 */
export interface MailModule {
  hasNewMails(): boolean;
  appendMail(from: string, title: string, content: string, issueId?: number): void;
  collectMails(): Mail[];
  listMails(): Mail[];
  clearUnread(): void;
}

/**
 * Skill module interface
 */
export interface SkillModule {
  loadSkills(): Promise<void>;
  listSkills(): Skill[];
  getSkill(name: string): Skill | undefined;
  /**
   * List all available tools with name and description
   * Used for condition compilation to validate trigger tool names
   */
  listAllTools(): Array<{ name: string; description: string }>;
  /**
   * Compile a skill's "when" condition into a structured hook and update the
   * runtime condition registry so the hook system picks it up immediately.
   *
   * Lead process: compiles directly on the runtime ConditionRegistry (in-memory
   * update + disk persist, no restart needed).
   * Child process: compiles to disk via a temporary registry, then sends a
   * 'condition_replace' IPC message so the Lead reloads from disk.
   *
   * @param skillName - Name of the skill whose "when" field to compile
   * @param feedback - Optional refinement feedback to fold into the compile prompt
   * @returns The compile result (condition + validation + error)
   */
  compileCondition(
    skillName: string,
    feedback?: string,
  ): Promise<{ condition?: Condition; validation?: ValidationResult; error?: string }>;
  /**
   * Reload the compiled condition for a skill from disk into the runtime
   * ConditionRegistry. Used by the 'condition_replace' IPC handler so that a
   * teammate's compileCondition() (which writes to disk in the child) is
   * picked up by the Lead's in-memory registry without a restart.
   *
   * No-op (returns error) when no runtime registry is available (child process).
   */
  replaceCondition(skillName: string): Promise<{ success: boolean; error?: string }>;
}

/**
 * Issue module interface
 * All methods are async for consistency between main and child contexts
 */
export interface IssueModule {
  createIssue(title: string, content: string, blockedBy?: number[]): Promise<number>;
  getIssue(id: number): Promise<Issue | undefined>;
  listIssues(): Promise<Issue[]>;
  printIssues(): Promise<string>;
  printIssue(id: number): Promise<string>;
  claimIssue(id: number, owner: string): Promise<boolean>;
  closeIssue(id: number, status: 'completed' | 'failed' | 'abandoned', comment?: string, poster?: string): Promise<void>;
  addComment(id: number, comment: string, poster?: string): Promise<void>;
  createBlockage(blocker: number, blocked: number): Promise<void>;
  removeBlockage(blocker: number, blocked: number): Promise<void>;
  clearAll(): void;
}

/**
 * Background task module interface
 * All methods are async for consistency between main and child contexts
 */
export interface BgModule {
  runCommand(cmd: string): Promise<number>;
  /**
   * Print background tasks. If pid is provided and the task exists,
   * returns a detailed view including accumulated output (tail-capped).
   * If pid is provided but not found, returns a not-found message.
   * If pid is omitted, returns a compact status list of all tasks.
   */
  printBgTasks(pid?: number): Promise<string>;
  hasRunningBgTasks(): Promise<boolean>;
  killTask(pid: number): Promise<void>;
  /** Get task by pid (for status checking in bg_await) */
  getTask(pid: number): { pid: number; command: string; status: string; output?: string } | undefined;
}

// ============================================================================
// IPC Handler Registry
// ============================================================================

/**
 * Send response callback for IPC handlers
 * @param responseType - The response type (e.g., 'db_result', 'wt_result')
 * @param success - Whether the operation succeeded
 * @param data - Response data on success
 * @param error - Error message on failure
 */
export type SendResponseCallback = (
  responseType: string,
  success: boolean,
  data?: unknown,
  error?: string
) => void;

/**
 * IPC message handler function type
 * @param sender - Name of the child process that sent the message
 * @param payload - The message payload (excluding type discriminator)
 * @param ctx - AgentContext for accessing modules
 * @param sendResponse - Callback to send response back to child
 */
export type IpcMessageHandler = (
  sender: string,
  payload: Record<string, unknown>,
  ctx: AgentContext,
  sendResponse: SendResponseCallback
) => void | Promise<void>;

/**
 * Handler registration entry
 */
export interface IpcHandlerRegistration {
  messageType: string;
  handler: IpcMessageHandler;
  module: string; // For debugging/logging: 'issue', 'mail', 'team', etc.
}

/**
 * Team module interface
 */
export interface TeamModule {
  createTeammate(name: string, role: string, prompt: string, cwd?: string): Promise<string>;
  getTeammate(name: string): Teammate | undefined;
  listTeammates(): { name: string; role: string; status: TeammateStatus }[];
  awaitTeammate(name: string, timeout?: number): Promise<{ waited: boolean }>;
  awaitTeam(timeout?: number): Promise<{ result: string }>;
  printTeam(): string | Promise<string>;
  removeTeammate(name: string, force?: boolean): void;
  dismissTeam(force?: boolean): void;
  mailTo(name: string, title: string, content: string, from?: string, eta?: number): void;
  broadcast(title: string, content: string): void;
  // Pending questions from children
  handlePendingQuestions(): Promise<void>;
}

// ============================================================================
// Wiki (Persistent Memory)
// ============================================================================

/**
 * Document to store in the knowledge base
 */
export interface WikiDocument {
  domain: string;
  title: string;
  content: string;
  references: string[];
}

/**
 * Domain metadata stored in domains.json
 */
export interface WikiDomain {
  domain_name: string;
  description: string;
  created_at: string;
  project_folder: string;
}

/**
 * Result from wiki_prepare
 */
export interface PrepareResult {
  accepted: boolean;
  hash?: string;
  reason?: string;
}

/**
 * Result from wiki_put
 */
export interface PutResult {
  success: boolean;
  hash: string;
  error?: string;
}

/**
 * Options for wiki_get
 */
export interface GetOptions {
  domain?: string;
  topK?: number;
  threshold?: number;
}

/**
 * Search result from wiki_get
 */
export interface SearchResult {
  document: WikiDocument;
  similarity: number;
  hash: string;
}

/**
 * WAL entry for audit/replay
 */
export interface WALEntry {
  timestamp: string;
  hash: string;
  document: WikiDocument;
  approved: boolean;
  persistent?: boolean;
  deleted?: boolean; // Marks entry as deleted from vector store
}

/**
 * Result from wiki_rebuild
 */
export interface RebuildResult {
  success: boolean;
  documentsProcessed: number;
  errors: string[];
}

/**
 * Wiki module interface for persistent memory
 */
export interface WikiModule {
  prepare(document: WikiDocument, skipDuplicateCheck?: boolean): Promise<PrepareResult>;
  put(hash: string, document: WikiDocument): Promise<PutResult>;
  get(query: string, options?: GetOptions): Promise<SearchResult[]>;
  delete(hash: string): Promise<boolean>;
  getWAL(date?: string): Promise<WALEntry[]>;
  parseWAL(asciiContent: string): WALEntry[];
  formatWAL(entries: WALEntry[]): string;
  appendWAL(entry: WALEntry): Promise<void>;
  rebuild(): Promise<RebuildResult>;
  // Domain management
  listDomains(): Promise<WikiDomain[]>;
  getDomain(name: string): Promise<WikiDomain | undefined>;
  registerDomain(name: string, description?: string): Promise<void>;
}

/**
 * AgentContext - main context object for tools
 */
export interface AgentContext {
  core: CoreModule;
  todo: TodoModule;
  mail: MailModule;
  skill: SkillModule;
  issue: IssueModule;
  bg: BgModule;
  team: TeamModule;
  wiki: WikiModule;
}

// ============================================================================
// Slash Commands
// ============================================================================

/**
 * Context passed to slash command handlers
 */
export interface SlashCommandContext {
  query: string; // Full user input (e.g., '/issues 123')
  args: string[]; // Parsed arguments (e.g., ['/issues', '123'])
  ctx: AgentContext; // Main agent context
  triologue: unknown; // Triologue instance (use 'any' to avoid circular import)
  sessionFilePath: string; // Current session file path
  /**
   * Optional output: if set by a command, this becomes the next query to process.
   * Used by /load to inject the restored session's first query.
   */
  nextQuery?: string;
  /** Sequence tracker — can be cleared by /clear or double Ctrl+L */
  sequence?: { clear(): void };
}

/**
 * Slash command definition
 */
export interface SlashCommand {
  name: string; // Command name without slash (e.g., 'team')
  description: string; // Short description for help
  aliases?: string[]; // Alternative names (e.g., ['todo'] for 'todos' command)
  handler: (context: SlashCommandContext) => Promise<void> | void;
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Error thrown when a tool result exceeds the size threshold
 * The result is dumped to a file for later retrieval
 */
export class ResultTooLargeError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly filePath: string,  // Path in .mycc/longtext/
    public readonly size: number,
    public readonly threshold: number,
    public readonly preview: string    // First N chars for preview
  ) {
    super(`Tool result too large: ${toolName} returned ${size} chars (threshold: ${threshold})`);
    this.name = 'ResultTooLargeError';
  }
}

// ============================================================================
// Dynamic Loader
// ============================================================================

/**
 * Dynamic loader interface
 * Merged: DynamicLoader + ToolLoader + SkillModule
 */
export interface DynamicLoader {
  loadAll(): Promise<void>;
  getSkill(name: string): Skill | undefined;
  watchDirectories(): void;
  stopWatching(): void;
  // ToolLoader methods (merged)
  getToolsForScope(scope: ToolScope): Tool[];
  execute(name: string, ctx: AgentContext, args: Record<string, unknown>): Promise<string>;
  // SkillModule methods (merged)
  loadSkills(): Promise<void>;
  listSkills(): Skill[];
}