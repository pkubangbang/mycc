/**
 * types.ts - Shared type definitions for the coding agent
 */

import type { ChildProcess } from 'child_process';
import type { JSONSchema7 } from 'json-schema';
import type { Message as OllamaMessage, ToolCall as OllamaToolCall } from 'ollama';
import { WebFetchResponse, WebSearchResult } from 'ollama';

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
 * Extended Message with tool_call_id for tool role messages
 */
export interface Message extends OllamaMessage {
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
  handler: (ctx: AgentContext, args: Record<string, unknown>) => string | Promise<string>;
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
export type ToolScope = 'main' | 'child' | 'bg';

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
  id: number;
  name: string;
  done: boolean;
  note?: string;
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
}

// ============================================================================
// Background Task
// ============================================================================

/**
 * Background task status
 */
export type BgTaskStatus = 'running' | 'completed' | 'failed';

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
  brief(level: 'info' | 'warn' | 'error', tool: string, message: string): void;
  /**
   * Ask user a question and wait for response
   * Used by tools to get user input during execution
   * @param query - The question to ask
   * @param asker - Optional name of who is asking (e.g., 'lead' or teammate name)
   */
  question(query: string, asker: string): Promise<string>;
  /**
   * Set the question function (called by main after readline setup)
   */
  setQuestionFn(fn: (query: string) => Promise<string>): void;
  /**
   * Set the transcript module for logging
   */
  setTranscript(transcript: TranscriptModule): void;
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
}

/**
 * Transcript entry type
 */
export interface TranscriptEntry {
  timestamp: Date;
  type: 'brief' | 'question' | 'answer' | 'mail_send';
  [key: string]: unknown;
}

/**
 * Transcript module interface
 */
export interface TranscriptModule {
  log(entry: TranscriptEntry): void;
  logBrief(level: string, tool: string, message: string): void;
  logQuestion(asker: string, query: string): void;
  logAnswer(asker: string, response: string): void;
  logMailSend(from: string, to: string, title: string, content?: string): void;
}

/**
 * Todo module interface
 */
export interface TodoModule {
  patchTodoList(items: TodoItem[]): void;
  printTodoList(): string;
  hasOpenTodo(): boolean;
  clear(): void;
}

/**
 * Mail module interface
 */
export interface MailModule {
  hasNewMails(): boolean;
  appendMail(from: string, title: string, content: string, issueId?: number): void;
  collectMails(): Mail[];
  setTranscript(transcript: TranscriptModule): void;
}

/**
 * Skill module interface
 */
export interface SkillModule {
  loadSkills(): Promise<void>;
  listSkills(): Skill[];
  printSkills(): string;
  getSkill(name: string): Skill | undefined;
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
}

/**
 * Background task module interface
 * All methods are async for consistency between main and child contexts
 */
export interface BgModule {
  runCommand(cmd: string): Promise<number>;
  printBgTasks(): Promise<string>;
  hasRunningBgTasks(): Promise<boolean>;
  killTask(pid: number): Promise<void>;
}

/**
 * Worktree module interface
 * All methods are async for consistency between main and child contexts
 */
export interface WtModule {
  createWorkTree(name: string, branch: string): Promise<string>;
  printWorkTrees(): Promise<string>;
  enterWorkTree(name: string): Promise<void>;
  leaveWorkTree(): Promise<void>;
  removeWorkTree(name: string): Promise<void>;
  getWorkTreePath(name: string): Promise<string>;
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
  createTeammate(name: string, role: string, prompt: string): Promise<string>;
  getTeammate(name: string): Teammate | undefined;
  listTeammates(): { name: string; role: string; status: TeammateStatus }[];
  awaitTeammate(name: string, timeout?: number): Promise<{ waited: boolean }>;
  awaitTeam(timeout?: number): Promise<{ allSettled: boolean; waited: boolean }>;
  printTeam(): string | Promise<string>;
  removeTeammate(name: string, force?: boolean): void;
  dismissTeam(force?: boolean): void;
  mailTo(name: string, title: string, content: string, from?: string): void;
  broadcast(title: string, content: string): void;
  // IPC Handler registration
  registerHandler(registration: IpcHandlerRegistration): void;
  unregisterHandler(messageType: string): void;
  // Transcript logging
  setTranscript(transcript: TranscriptModule): void;
  // Pending questions from children
  handlePendingQuestions(): Promise<void>;
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
  wt: WtModule;
  team: TeamModule | null;
}

// ============================================================================
// Dynamic Loader
// ============================================================================

/**
 * Dynamic loader interface
 */
export interface DynamicLoader {
  loadAll(): Promise<void>;
  getTools(): ToolDefinition[];
  getTool(name: string): ToolDefinition | undefined;
  getSkills(): Skill[];
  getSkill(name: string): Skill | undefined;
  watchDirectories(): void;
  stopWatching(): void;
}

/**
 * Tool loader interface for agent loop
 */
export interface ToolLoader {
  getToolsForScope(scope: ToolScope): Tool[];
  execute(name: string, ctx: AgentContext, args: Record<string, unknown>): Promise<string>;
}