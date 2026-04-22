/**
 * child-context/index.ts - Factory for creating child process AgentContext
 */

import type { AgentContext, SkillModule, CoreModule, TodoModule, MailModule, IssueModule, BgModule, WtModule, TeamModule, WikiModule } from '../../types.js';
import { Todo } from '../todo.js';
import { MailBox } from '../mail.js';
import { Loader } from '../loader.js';
import { ChildCore } from './core.js';
import { ChildIssue } from './issue.js';
import { ChildWt } from './wt.js';
import { ChildTeam } from './team.js';
import { ChildWiki } from './wiki.js';
import { BackgroundTasks } from '../bg.js';

/** Child process loader singleton (silent mode) */
export const silentLoader = new Loader(true);

// Re-export
export { IpcRegistry } from './ipc-registry.js';
export { ChildCore } from './core.js';
export { ChildIssue } from './issue.js';
export { ChildWt } from './wt.js';
export { ChildTeam } from './team.js';
export { ChildWiki } from './wiki.js';

/**
 * ChildContext - AgentContext for child process (teammate)
 * All write operations go through IPC to parent
 */
export class ChildContext implements AgentContext {
  private coreModule: ChildCore;
  private todoModule: Todo;
  private mailModule: MailBox;
  private skillModule: SkillModule;
  private issueModule: ChildIssue;
  private bgModule: BackgroundTasks;
  private wtModule: ChildWt;
  private teamModule: ChildTeam;
  private wikiModule: ChildWiki;

  constructor(name: string, workDir: string) {
    this.coreModule = new ChildCore(name, workDir);
    this.todoModule = new Todo();
    this.mailModule = new MailBox(name); // Worker-specific mailbox
    this.skillModule = silentLoader;
    this.issueModule = new ChildIssue();
    this.bgModule = new BackgroundTasks(this.coreModule);
    this.wtModule = new ChildWt(this.coreModule);
    this.teamModule = new ChildTeam(name); // Pass owner name for mailTo
    this.wikiModule = new ChildWiki();
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
  get wiki(): WikiModule { return this.wikiModule; }
}