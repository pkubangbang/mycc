/**
 * types.ts - Shared type definitions for the coding agent
 */

import type { ChildProcess } from 'child_process';
import type { JSONSchema7 } from 'json-schema';

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
  comments: string[];
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
export type TeammateStatus = 'working' | 'idle' | 'shutdown';

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
  brief(level: 'info' | 'warn' | 'error', tool: string, message: string): void;
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
  appendMail(from: string, title: string, content: string, issueId?: number): void;
  collectMails(): Mail[];
}

/**
 * Skill module interface
 */
export interface SkillModule {
  loadFromDir(dir: string): Promise<void>;
  listSkills(): Skill[];
  printSkills(): string;
  getSkill(name: string): Skill | undefined;
}

/**
 * Issue module interface
 */
export interface IssueModule {
  createIssue(title: string, content: string, blockedBy?: number[]): number;
  getIssue(id: number): Issue | undefined;
  listIssues(): Issue[];
  printIssues(): string;
  claimIssue(id: number, owner: string): boolean;
  closeIssue(id: number, status: 'completed' | 'failed' | 'abandoned', comment?: string): void;
  addComment(id: number, comment: string): void;
  createBlockage(blocker: number, blocked: number): void;
  removeBlockage(blocker: number, blocked: number): void;
}

/**
 * Background task module interface
 */
export interface BgModule {
  runCommand(cmd: string): number;
  printBgTasks(): string;
  hasRunningBgTasks(): boolean;
  killTask(pid: number): void;
}

/**
 * Worktree module interface
 */
export interface WtModule {
  createWorkTree(name: string, branch: string): string;
  printWorkTrees(): string;
  enterWorkTree(name: string): void;
  leaveWorkTree(): void;
  removeWorkTree(name: string): void;
}

/**
 * Team module interface
 */
export interface TeamModule {
  createTeammate(name: string, role: string, prompt: string): Promise<string>;
  getTeammate(name: string): Teammate | undefined;
  listTeammates(): { name: string; role: string; status: TeammateStatus }[];
  awaitTeammate(name: string, timeout?: number): Promise<void>;
  awaitTeam(timeout?: number): Promise<{ allSettled: boolean }>;
  printTeam(): string;
  removeTeammate(name: string): void;
  dismissTeam(): void;
  mailTo(name: string, title: string, content: string): void;
  broadcast(title: string, content: string): void;
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
  team: TeamModule;
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