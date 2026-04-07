/**
 * context/index.ts - AgentContext class and module exports
 */

import type { AgentContext } from '../types.js';
import { createCore } from './core.js';
import { createTodo } from './todo.js';
import { createMail } from './mail.js';
import { createIssue, createIssueIpcHandlers } from './issue.js';
import { createBg } from './bg.js';
import { createWt, createWtIpcHandlers } from './wt.js';
import { createTeam, TeamManager, createTeamIpcHandlers } from './team.js';
import { Loader, createLoader } from './loader.js';
import type { SkillModule } from '../types.js';

export * from './core.js';
export * from './todo.js';
export * from './mail.js';
export * from './issue.js';
export * from './bg.js';
export * from './wt.js';
export * from './team.js';
export * from './child-context/ipc-registry.js';
export * from './child-context/index.js';
export { createLoader, Loader } from './loader.js';

/**
 * Create a complete AgentContext with all modules
 * Registers IPC handlers for modules that need them
 */
export function createAgentContext(workDir?: string, loader?: Loader): AgentContext {
  const core = createCore(workDir);

  // Use provided loader or create a new one
  const skill: SkillModule = loader ?? createLoader();

  // Create modules
  const todo = createTodo();
  const mail = createMail('lead');
  const issue = createIssue();
  const bg = createBg(core);
  const wt = createWt(core);
  const team = createTeam(core);

  // Assemble context
  const ctx: AgentContext = {
    core,
    todo,
    mail,
    skill,
    issue,
    bg,
    wt,
    team,
  };

  // Initialize TeamManager with context for IPC handling
  (team as TeamManager).initializeContext(ctx);

  // Register IPC handlers for modules that need them
  const issueHandlers = createIssueIpcHandlers();
  for (const handler of issueHandlers) {
    team.registerHandler(handler);
  }

  const wtHandlers = createWtIpcHandlers();
  for (const handler of wtHandlers) {
    team.registerHandler(handler);
  }

  const teamHandlers = createTeamIpcHandlers();
  for (const handler of teamHandlers) {
    team.registerHandler(handler);
  }

  return ctx;
}