/**
 * child-context/index.ts - Factory for creating child process AgentContext
 */

import type { AgentContext } from '../../types.js';
import { createTodo } from '../todo.js';
import { createMail } from '../mail.js';
import { createSkill } from '../skill.js';
import { ChildCore, createChildCore } from './core.js';
import { ChildIssue, createChildIssue } from './issue.js';
import { ChildBg, createChildBg } from './bg.js';
import { ChildWt, createChildWt, setWorkDirUpdateFn } from './wt.js';
import { IpcRegistry } from './ipc-registry.js';

// Re-export
export { IpcRegistry } from './ipc-registry.js';
export { createChildCore } from './core.js';
export { createChildIssue } from './issue.js';
export { createChildBg } from './bg.js';
export { createChildWt } from './wt.js';

/**
 * Create an AgentContext for child process
 * All write operations go through IPC to parent
 */
export function createChildContext(name: string, workDir: string): AgentContext {
  const core = createChildCore(name, workDir) as ChildCore;
  const todo = createTodo();
  const mail = createMail(name); // Worker-specific mailbox
  const skill = createSkill();
  const issue = createChildIssue();
  const bg = createChildBg();
  const wt = createChildWt();

  // Set up workDir update function for wt module
  setWorkDirUpdateFn((dir: string) => {
    core.setWorkDir(dir);
  });

  // Load skills
  skill.loadSkills();

  // team is null - child cannot spawn more teammates
  return {
    core,
    todo,
    mail,
    skill,
    issue,
    bg,
    wt,
    team: null as unknown as AgentContext['team'],
  };
}