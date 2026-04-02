/**
 * Default configuration values
 */

import type { AgentConfig } from './schema.js';

/**
 * Default configuration
 * These values are used when not overridden by environment variables or config file
 */
export const defaultConfig: AgentConfig = {
  llm: {
    host: 'http://127.0.0.1:11434',
    model: 'glm-5:cloud',
    apiKey: undefined,
    tokenThreshold: 50000,
    conversationSlice: 80000,
  },

  agent: {
    todoNudgeInterval: 3,
    version: '1.0.0',
  },

  timeouts: {
    bashCommand: 120000, // 2 minutes
    teammateAwait: 60000, // 1 minute
    teamAwait: 60000, // 1 minute
  },

  storage: {
    dataDir: '.mycc',
    dbName: 'state.db',
    mailDir: 'mail',
    toolsDir: 'tools',
    skillsDir: 'skills',
    transcriptsDir: 'transcripts',
  },

  tools: {
    bashMaxBuffer: 50 * 1024 * 1024, // 50 MB
    bashOutputLimit: 50000, // 50k chars
    dangerousCommands: [
      'rm -rf /',
      'rm -rf /*',
      'dd if=/dev/zero',
      ':(){ :|:& };:',
      'mkfs',
      'sudo',
      'shutdown',
      'reboot',
      'halt',
      'init 0',
      'systemctl poweroff',
      'systemctl reboot',
    ],
    mainOnlyTools: ['tm_create', 'tm_remove', 'tm_await', 'broadcast'],
  },

  prompts: {
    leadWithTeam: [
      'You are the lead of a coding agent team at {workDir}.',
      'You spawn teammates, create issues and collect results.',
      'Use tools to finish tasks. Use skills to access specialized knowledge.',
      'Report proactively using the brief tool.',
      'Read README.md or CLAUDE.md first if you feel lost about the context.',
      'You must ask for grant BEFORE "git commit" with no exception.',
      'Skills: {skills}',
    ],
    leadSolo: [
      'You are a coding agent at {workDir}.',
      'Use tools to finish tasks. Use skills to access specialized knowledge.',
      'Consider using issue_* to divide and conquor complex tasks, using todo_* for simple task tracking.',
      'You must ask for grant BEFORE "git commit" with no exception.',
      'Skills: {skills}',
    ],
    childAgent: [
      'You are a specialized agent working as part of a team.',
      'Use skills to access specialized knowledge.',
      'Use question tools to ask question to the user,',
      'use brief tools to report your progress,',
      'use mail_to tools to communicate with other teammates.',
      'Prefer concise and frank communication style. Act, but not explain.',
      'When you feel lost about the context, send mail to "lead".',
      '',
      '{identity}',
      '',
      'Skills: {skills}',
    ],
  },
};