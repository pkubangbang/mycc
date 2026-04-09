/**
 * context/index.ts - AgentContext class and module exports
 */

import type { AgentContext } from '../types.js';
import { Core } from './core.js';
import { Todo } from './todo.js';
import { MailBox } from './mail.js';
import { IssueManager, createIssueIpcHandlers } from './issue.js';
import { BackgroundTasks } from './bg.js';
import { WorktreeManager, createWtIpcHandlers } from './wt.js';
import { TeamManager, createTeamIpcHandlers } from './team.js';
import { Loader } from './loader.js';
import type { CoreModule, TodoModule, MailModule, SkillModule, IssueModule, BgModule, WtModule, TeamModule } from '../types.js';

export * from './core.js';
export * from './todo.js';
export * from './mail.js';
export * from './issue.js';
export * from './bg.js';
export * from './wt.js';
export * from './team.js';
export * from './child-context/ipc-registry.js';
export * from './child-context/index.js';
export { Loader } from './loader.js';

/**
 * ParentContext - AgentContext for main/lead process
 * Implements AgentContext with getters for each module
 */
export class ParentContext implements AgentContext {
  private coreModule: Core;
  private todoModule: Todo;
  private mailModule: MailBox;
  private skillModule: SkillModule;
  private issueModule: IssueManager;
  private bgModule: BackgroundTasks;
  private wtModule: WorktreeManager;
  private teamModule: TeamManager;

  constructor(loader?: Loader) {
    this.coreModule = new Core(); // Uses process.cwd() by default
    this.skillModule = loader ?? new Loader();
    this.todoModule = new Todo();
    this.mailModule = new MailBox('lead');
    this.issueModule = new IssueManager();
    this.bgModule = new BackgroundTasks(this.coreModule);
    this.wtModule = new WorktreeManager(this.coreModule);
    this.teamModule = new TeamManager(this.coreModule);
  }

  // Getters for each module
  get core(): CoreModule { return this.coreModule; }
  get todo(): TodoModule { return this.todoModule; }
  get mail(): MailModule { return this.mailModule; }
  get skill(): SkillModule { return this.skillModule; }
  get issue(): IssueModule { return this.issueModule; }
  get bg(): BgModule { return this.bgModule; }
  get wt(): WtModule { return this.wtModule; }
  get team(): TeamModule { return this.teamModule; }

  /**
   * Initialize IPC handlers for child process communication
   * Must be called after context is created
   */
  initializeIpcHandlers(): void {
    // Initialize TeamManager with context for IPC handling
    this.teamModule.initializeContext(this);

    // Register IPC handlers for modules that need them
    const issueHandlers = createIssueIpcHandlers();
    for (const handler of issueHandlers) {
      this.teamModule.registerHandler(handler);
    }

    const wtHandlers = createWtIpcHandlers();
    for (const handler of wtHandlers) {
      this.teamModule.registerHandler(handler);
    }

    const teamHandlers = createTeamIpcHandlers();
    for (const handler of teamHandlers) {
      this.teamModule.registerHandler(handler);
    }
  }
}