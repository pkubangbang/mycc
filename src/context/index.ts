/**
 * context/index.ts - AgentContext class and module exports
 */

import type { AgentContext } from '../types.js';
import { createCore } from './core.js';
import { createTodo } from './todo.js';
import { createMail } from './mail.js';
import { createSkill } from './skill.js';
import { createIssue, createIssueIpcHandlers } from './issue.js';
import { createBg } from './bg.js';
import { createWt, createWtIpcHandlers } from './wt.js';
import { createTeam, TeamManager } from './team.js';
import { createTranscript } from './transcript.js';

export * from './core.js';
export * from './todo.js';
export * from './mail.js';
export * from './skill.js';
export * from './issue.js';
export * from './bg.js';
export * from './wt.js';
export * from './team.js';
export * from './child-context/ipc-registry.js';
export * from './child-context/index.js';
export * from './transcript.js';

/**
 * Create a complete AgentContext with all modules
 * Registers IPC handlers for modules that need them
 */
export function createAgentContext(workDir?: string): AgentContext {
  const core = createCore(workDir);
  const skill = createSkill();

  // Create transcript for logging
  const transcript = createTranscript();

  // Create modules
  const todo = createTodo();
  const mail = createMail('lead');
  const issue = createIssue();
  const bg = createBg(core);
  const wt = createWt(core);
  const team = createTeam(core);

  // Set transcript on modules that need it
  core.setTranscript(transcript);
  mail.setTranscript(transcript);
  team.setTranscript(transcript);

  // Load skills from both project skills/ and .mycc/skills/
  skill.loadSkills();

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

  return ctx;
}