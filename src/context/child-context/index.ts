/**
 * child-context/index.ts - Factory for creating child process AgentContext
 */

import type { AgentContext, SkillModule } from '../../types.js';
import { createTodo } from '../todo.js';
import { createMail } from '../mail.js';
import { createBg } from '../bg.js';
import { createLoader } from '../loader.js';
import { createChildCore } from './core.js';
import { createChildIssue } from './issue.js';
import { createChildWt } from './wt.js';
import { createChildTeam } from './team.js';

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
  const core = createChildCore(name, workDir);
  const todo = createTodo();
  const mail = createMail(name); // Worker-specific mailbox
  const skill: SkillModule = createLoader(true); // Silent mode for child process
  const issue = createChildIssue();
  const bg = createBg(core); // Use main bg directly - child runs its own bg tasks
  const wt = createChildWt(core);
  const team = createChildTeam(name); // Pass owner name for mailTo

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