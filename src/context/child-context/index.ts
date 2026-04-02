/**
 * child-context/index.ts - Factory for creating child process AgentContext
 */

import type { AgentContext } from '../../types.js';
import { createTodo } from '../todo.js';
import { createMail } from '../mail.js';
import { createSkill } from '../skill.js';
import { createBg } from '../bg.js';
import { ChildCore, createChildCore } from './core.js';
import { ChildIssue, createChildIssue } from './issue.js';
import { ChildWt, createChildWt } from './wt.js';
import { ChildTeam, createChildTeam } from './team.js';
import { IpcRegistry } from './ipc-registry.js';

// Re-export
export { IpcRegistry } from './ipc-registry.js';
export { createChildCore } from './core.js';
export { createChildIssue } from './issue.js';
export { createChildWt } from './wt.js';
export { createChildTeam } from './team.js';

/**
 * Create an AgentContext for child process
 * All write operations go through IPC to parent
 */
export function createChildContext(name: string, workDir: string): AgentContext {
  const core = createChildCore(name, workDir) as ChildCore;
  const todo = createTodo();
  const mail = createMail(name); // Worker-specific mailbox
  const skill = createSkill(true); // Silent mode for child process
  const issue = createChildIssue();
  const bg = createBg(core); // Use main bg directly - child runs its own bg tasks
  const wt = createChildWt(core);
  const team = createChildTeam(name); // Pass owner name for mailTo

  // Load skills
  skill.loadSkills();

  return {
    core,
    todo,
    mail,
    skill,
    issue,
    bg,
    wt,
    team,
  };
}