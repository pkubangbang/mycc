/**
 * parent-context.ts - ParentContext for main/lead process
 */

import type { AgentContext, IpcHandlerRegistration, WikiModule } from '../types.js';
import { Core } from './parent/core.js';
import { Todo } from './shared/todo.js';
import { MailBox } from './shared/mail.js';
import { IssueManager } from './parent/issue.js';
import { BackgroundTasks } from './shared/bg.js';
import { WorktreeManager } from './parent/wt.js';
import { TeamManager } from './parent/team.js';
import { WikiManager } from './parent/wiki.js';
import { loader } from './shared/loader.js';
import { evaluateGrant } from './parent/grant.js';
import type { CoreModule, TodoModule, MailModule, SkillModule, IssueModule, BgModule, WtModule, TeamModule } from '../types.js';

// Re-export loader for convenience
export { loader };

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
  private wikiModule: WikiManager;

  constructor(sessionFilePath: string) {
    this.coreModule = new Core(); // Uses process.cwd() by default
    this.skillModule = loader;
    this.todoModule = new Todo();
    this.mailModule = new MailBox('lead');
    this.issueModule = new IssueManager();
    this.bgModule = new BackgroundTasks(this.coreModule);
    this.wtModule = new WorktreeManager(this.coreModule);
    // Pass 'this' to TeamManager - context is used lazily so this is safe
    this.teamModule = new TeamManager(this, sessionFilePath);
    this.wikiModule = new WikiManager(this.coreModule);
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

  /**
   * Initialize IPC handlers for child process communication
   * Must be called after context is created
   */
  initializeIpcHandlers(): void {
    // Register all IPC handlers
    const handlers: IpcHandlerRegistration[] = [
      // Issue handlers
      {
        messageType: 'db_issue_get',
        module: 'issue',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { id } = payload as { id: number };
          const issue = await ctx.issue.getIssue(id);
          sendResponse('db_result', true, issue);
        },
      },
      {
        messageType: 'db_issue_list',
        module: 'issue',
        handler: async (_sender, _payload, ctx, sendResponse) => {
          const issues = await ctx.issue.listIssues();
          sendResponse('db_result', true, issues);
        },
      },
      {
        messageType: 'db_issue_create',
        module: 'issue',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { title, content, blockedBy = [] } = payload as {
            title: string;
            content: string;
            blockedBy?: number[];
          };
          const id = await ctx.issue.createIssue(title, content, blockedBy);
          sendResponse('db_result', true, { id });
        },
      },
      {
        messageType: 'db_issue_claim',
        module: 'issue',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { id, owner } = payload as { id: number; owner: string };
          const claimed = await ctx.issue.claimIssue(id, owner);
          sendResponse('db_result', true, { claimed });
        },
      },
      {
        messageType: 'db_issue_close',
        module: 'issue',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { id, status, comment, poster } = payload as {
            id: number;
            status: 'completed' | 'failed' | 'abandoned';
            comment?: string;
            poster?: string;
          };
          await ctx.issue.closeIssue(id, status, comment, poster);
          sendResponse('db_result', true);
        },
      },
      {
        messageType: 'db_issue_comment',
        module: 'issue',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { id, comment, poster } = payload as { id: number; comment: string; poster?: string };
          await ctx.issue.addComment(id, comment, poster);
          sendResponse('db_result', true);
        },
      },
      {
        messageType: 'db_block_add',
        module: 'issue',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { blocker, blocked } = payload as { blocker: number; blocked: number };
          await ctx.issue.createBlockage(blocker, blocked);
          sendResponse('db_result', true);
        },
      },
      {
        messageType: 'db_block_remove',
        module: 'issue',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { blocker, blocked } = payload as { blocker: number; blocked: number };
          await ctx.issue.removeBlockage(blocker, blocked);
          sendResponse('db_result', true);
        },
      },
      // Worktree handlers
      {
        messageType: 'wt_create',
        module: 'wt',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { name, branch } = payload as { name: string; branch: string };
          const result = await ctx.wt.createWorkTree(name, branch);
          const match = result.match(/at (.+) on branch/);
          const wtPath = match ? match[1] : '';
          sendResponse('wt_result', true, { path: wtPath });
        },
      },
      {
        messageType: 'wt_print',
        module: 'wt',
        handler: async (_sender, _payload, ctx, sendResponse) => {
          const output = await ctx.wt.printWorkTrees();
          sendResponse('wt_result', true, output);
        },
      },
      {
        messageType: 'wt_get_path',
        module: 'wt',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { name } = payload as { name: string };
          try {
            const path = await ctx.wt.getWorkTreePath(name);
            sendResponse('wt_result', true, { path });
          } catch (err) {
            sendResponse('wt_result', false, undefined, (err as Error).message);
          }
        },
      },
      {
        messageType: 'wt_remove',
        module: 'wt',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { name } = payload as { name: string };
          await ctx.wt.removeWorkTree(name);
          sendResponse('wt_result', true);
        },
      },
      // Team handlers
      {
        messageType: 'team_print',
        module: 'team',
        handler: async (_sender, _payload, ctx, sendResponse) => {
          try {
            const result = ctx.team.printTeam();
            sendResponse('team_result', true, { message: result });
          } catch (err) {
            sendResponse('team_result', false, undefined, (err as Error).message);
          }
        },
      },
      // Wiki handlers
      {
        messageType: 'wiki_prepare',
        module: 'wiki',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { document } = payload as { document: Parameters<WikiModule['prepare']>[0] };
          const result = await ctx.wiki.prepare(document);
          sendResponse('wiki_result', true, result);
        },
      },
      {
        messageType: 'wiki_put',
        module: 'wiki',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { hash, document } = payload as { hash: string; document: Parameters<WikiModule['put']>[1] };
          const result = await ctx.wiki.put(hash, document);
          sendResponse('wiki_result', true, result);
        },
      },
      {
        messageType: 'wiki_get',
        module: 'wiki',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { query, options } = payload as { query: string; options?: Parameters<WikiModule['get']>[1] };
          const results = await ctx.wiki.get(query, options);
          sendResponse('wiki_result', true, results);
        },
      },
      {
        messageType: 'wiki_delete',
        module: 'wiki',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { hash } = payload as { hash: string };
          const result = await ctx.wiki.delete(hash);
          sendResponse('wiki_result', true, result);
        },
      },
      {
        messageType: 'wiki_wal_get',
        module: 'wiki',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { date } = payload as { date?: string };
          const entries = await ctx.wiki.getWAL(date);
          sendResponse('wiki_result', true, entries);
        },
      },
      {
        messageType: 'wiki_wal_append',
        module: 'wiki',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { entry } = payload as { entry: Parameters<WikiModule['appendWAL']>[0] };
          await ctx.wiki.appendWAL(entry);
          sendResponse('wiki_result', true);
        },
      },
      {
        messageType: 'wiki_rebuild',
        module: 'wiki',
        handler: async (_sender, _payload, ctx, sendResponse) => {
          const result = await ctx.wiki.rebuild();
          sendResponse('wiki_result', true, result);
        },
      },
      // Domain handlers
      {
        messageType: 'wiki_domains_list',
        module: 'wiki',
        handler: async (_sender, _payload, ctx, sendResponse) => {
          const domains = await ctx.wiki.listDomains();
          sendResponse('wiki_result', true, domains);
        },
      },
      {
        messageType: 'wiki_domain_get',
        module: 'wiki',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { name } = payload as { name: string };
          const domain = await ctx.wiki.getDomain(name);
          sendResponse('wiki_result', true, domain);
        },
      },
      {
        messageType: 'wiki_domain_register',
        module: 'wiki',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { name, description } = payload as { name: string; description?: string };
          await ctx.wiki.registerDomain(name, description);
          sendResponse('wiki_result', true);
        },
      },
      // Core handlers
      {
        messageType: 'core_img_describe',
        module: 'core',
        handler: async (_sender, payload, ctx, sendResponse) => {
          const { image, prompt } = payload as { image: string; prompt?: string };
          try {
            const result = await ctx.core.imgDescribe(image, prompt);
            sendResponse('core_result', true, { description: result });
          } catch (err) {
            sendResponse('core_result', false, undefined, (err as Error).message);
          }
        },
      },
      // Grant handler
      {
        messageType: 'grant_request',
        module: 'grant',
        handler: async (sender, payload, ctx, sendResponse) => {
          const { tool, path, command } = payload as {
            tool: 'write_file' | 'edit_file' | 'bash';
            path?: string;
            command?: string;
          };
          // Cast to Core to access getMode() (implementation-only method)
          const core = ctx.core as Core;
          const result = await evaluateGrant(sender, { tool, path, command }, core);
          sendResponse('grant_result', true, result);
        },
      },
    ];

    for (const handler of handlers) {
      this.teamModule.registerHandler(handler);
    }
  }
}