/**
 * context/index.ts - AgentContext class and module exports
 */

import type { AgentContext, CoreModule, TodoModule, MailModule, SkillModule, IssueModule, BgModule, WtModule, TeamModule } from '../types.js';
import { createCore } from './core.js';
import { createTodo } from './todo.js';
import { createMail } from './mail.js';
import { createSkill } from './skill.js';
import { createIssue } from './issue.js';
import { createBg } from './bg.js';
import { createWt } from './wt.js';
import { createTeam } from './team.js';

export * from './core.js';
export * from './todo.js';
export * from './mail.js';
export * from './skill.js';
export * from './issue.js';
export * from './bg.js';
export * from './wt.js';
export * from './team.js';

/**
 * Create a complete AgentContext with all modules
 */
export function createAgentContext(workDir?: string): AgentContext {
  const core = createCore(workDir);

  return {
    core,
    todo: createTodo(),
    mail: createMail('lead'),
    skill: createSkill(),
    issue: createIssue(),
    bg: createBg(core),
    wt: createWt(core),
    team: createTeam(core),
  };
}