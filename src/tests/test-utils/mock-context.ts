/**
 * mock-context.ts - Comprehensive AgentContext mocking utilities
 * 
 * This file provides standardized mock factories for AgentContext and its modules.
 * Use these utilities to create consistent, type-safe mocks across all test files.
 */

import { vi } from 'vitest';
import type { AgentContext, CoreModule, TodoModule, MailModule, SkillModule, IssueModule, BgModule, WtModule, TeamModule, WikiModule } from '../../types.js';

// ============================================================================
// Mock Factories
// ============================================================================

/**
 * Create a mock CoreModule with optional overrides
 */
export function createMockCore(overrides: Partial<CoreModule> = {}): CoreModule {
  return {
    getWorkDir: vi.fn(() => process.cwd()),
    setWorkDir: vi.fn(),
    getName: vi.fn(() => 'test-agent'),
    brief: vi.fn(),
    verbose: vi.fn(),
    question: vi.fn(async () => 'test response'),
    webSearch: vi.fn(async () => []),
    webFetch: vi.fn(async () => ({ title: '', content: '', links: [] })),
    imgDescribe: vi.fn(async () => 'image description'),
    requestGrant: vi.fn(async () => ({ approved: true })),
    getMode: vi.fn(() => 'normal' as const),
    getMindmap: vi.fn(() => null),
    setMindmap: vi.fn(),
    getConfusionIndex: vi.fn(() => 0),
    increaseConfusionIndex: vi.fn(),
    resetConfusionIndex: vi.fn(),
    ...overrides,
  };
}

/**
 * Create a mock TodoModule with optional overrides
 */
export function createMockTodo(overrides: Partial<TodoModule> = {}): TodoModule {
  return {
    patchTodoList: vi.fn(),
    printTodoList: vi.fn(),
    hasOpenTodo: vi.fn(() => false),
    clear: vi.fn(),
    ...overrides,
  };
}

/**
 * Create a mock MailModule with optional overrides
 */
export function createMockMail(overrides: Partial<MailModule> = {}): MailModule {
  return {
    hasNewMails: vi.fn(() => false),
    appendMail: vi.fn(),
    collectMails: vi.fn(() => []),
    ...overrides,
  };
}

/**
 * Create a mock SkillModule with optional overrides
 */
export function createMockSkill(overrides: Partial<SkillModule> = {}): SkillModule {
  return {
    loadSkills: vi.fn(async () => {}),
    listSkills: vi.fn(() => []),
    getSkill: vi.fn(() => undefined),
    ...overrides,
  };
}

/**
 * Create a mock IssueModule with optional overrides
 */
export function createMockIssue(overrides: Partial<IssueModule> = {}): IssueModule {
  return {
    createIssue: vi.fn(async () => 1),
    getIssue: vi.fn(async () => undefined),
    listIssues: vi.fn(async () => []),
    printIssues: vi.fn(async () => ''),
    printIssue: vi.fn(async () => ''),
    claimIssue: vi.fn(async () => true),
    closeIssue: vi.fn(async () => {}),
    addComment: vi.fn(async () => {}),
    createBlockage: vi.fn(async () => {}),
    removeBlockage: vi.fn(async () => {}),
    ...overrides,
  };
}

/**
 * Create a mock BgModule with optional overrides
 */
export function createMockBg(overrides: Partial<BgModule> = {}): BgModule {
  return {
    runCommand: vi.fn(async () => 1),
    printBgTasks: vi.fn(async () => ''),
    hasRunningBgTasks: vi.fn(async () => false),
    killTask: vi.fn(async () => {}),
    ...overrides,
  };
}

/**
 * Create a mock WtModule with optional overrides
 */
export function createMockWt(overrides: Partial<WtModule> = {}): WtModule {
  return {
    syncWorkTrees: vi.fn(async () => {}),
    createWorkTree: vi.fn(async () => '/tmp/worktree'),
    printWorkTrees: vi.fn(async () => ''),
    enterWorkTree: vi.fn(async () => {}),
    leaveWorkTree: vi.fn(async () => {}),
    removeWorkTree: vi.fn(async () => {}),
    getWorkTreePath: vi.fn(async () => '/tmp/worktree'),
    ...overrides,
  };
}

/**
 * Create a mock TeamModule with optional overrides
 */
export function createMockTeam(overrides: Partial<TeamModule> = {}): TeamModule {
  return {
    createTeammate: vi.fn(async () => ''),
    getTeammate: vi.fn(() => undefined),
    listTeammates: vi.fn(() => []),
    awaitTeammate: vi.fn(async () => ({ waited: false })),
    awaitTeam: vi.fn(async () => ({ result: '' })),
    printTeam: vi.fn(() => ''),
    removeTeammate: vi.fn(),
    dismissTeam: vi.fn(),
    mailTo: vi.fn(),
    broadcast: vi.fn(),
    handlePendingQuestions: vi.fn(async () => {}),
    ...overrides,
  };
}

/**
 * Create a mock WikiModule with optional overrides
 */
export function createMockWiki(overrides: Partial<WikiModule> = {}): WikiModule {
  return {
    prepare: vi.fn(async () => ({ accepted: true, hash: 'test-hash' })),
    put: vi.fn(async () => ({ success: true, hash: 'test-hash' })),
    get: vi.fn(async () => []),
    delete: vi.fn(async () => true),
    getWAL: vi.fn(async () => []),
    parseWAL: vi.fn(() => []),
    formatWAL: vi.fn(() => ''),
    appendWAL: vi.fn(async () => {}),
    rebuild: vi.fn(async () => ({ success: true, documentsProcessed: 0, errors: [] })),
    listDomains: vi.fn(async () => []),
    getDomain: vi.fn(async () => undefined),
    registerDomain: vi.fn(async () => {}),
    checkSkillsDomain: vi.fn(async () => false),
    ...overrides,
  };
}

// ============================================================================
// Full Context Mocks
// ============================================================================

/**
 * Options for creating a mock AgentContext
 */
export interface MockContextOptions {
  workdir?: string;
  core?: Partial<CoreModule>;
  todo?: Partial<TodoModule>;
  mail?: Partial<MailModule>;
  skill?: Partial<SkillModule>;
  issue?: Partial<IssueModule>;
  bg?: Partial<BgModule>;
  wt?: Partial<WtModule>;
  team?: Partial<TeamModule>;
  wiki?: Partial<WikiModule>;
}

/**
 * Create a complete mock AgentContext with sensible defaults.
 * 
 * @param options - Override specific module functions or provide custom workdir
 * @returns A fully typed AgentContext mock
 * 
 * @example
 * // Basic usage
 * const ctx = createMockContext();
 * 
 * @example
 * // With custom workdir
 * const ctx = createMockContext({ workdir: '/tmp/test-dir' });
 * 
 * @example
 * // With custom core behavior
 * const ctx = createMockContext({
 *   core: {
 *     brief: vi.fn(() => 'Brief output'),
 *   }
 * });
 */
export function createMockContext(options: MockContextOptions = {}): AgentContext {
  const workdir = options.workdir ?? process.cwd();
  
  return {
    core: createMockCore({ 
      getWorkDir: () => workdir,
      ...options.core 
    }),
    todo: createMockTodo(options.todo),
    mail: createMockMail(options.mail),
    skill: createMockSkill(options.skill),
    issue: createMockIssue(options.issue),
    bg: createMockBg(options.bg),
    wt: createMockWt(options.wt),
    team: createMockTeam(options.team),
    wiki: createMockWiki(options.wiki),
  };
}

/**
 * Create a minimal mock AgentContext with only core module.
 * Useful for tests that don't need the full context.
 */
export function createMinimalMockContext(workdir?: string): AgentContext {
  return {
    core: createMockCore({ getWorkDir: () => workdir ?? process.cwd() }),
    todo: {} as TodoModule,
    mail: {} as MailModule,
    skill: {} as SkillModule,
    issue: {} as IssueModule,
    bg: {} as BgModule,
    wt: {} as WtModule,
    team: {} as TeamModule,
    wiki: {} as WikiModule,
  };
}