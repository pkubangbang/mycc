/**
 * bash.ts - Run shell commands
 *
 * Scope: ['main', 'child', 'bg'] - Available to all agent types
 */

import { execSync } from 'child_process';
import type { ToolDefinition, AgentContext } from '../types.js';
import { getConfig } from '../config/index.js';

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'Run a shell command (blocking).',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute',
      },
    },
    required: ['command'],
  },
  scope: ['main', 'child', 'bg'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const command = args.command as string;
    const config = getConfig();
    
    // Check against dangerous commands from config
    if (config.tools.dangerousCommands.some((d) => command.includes(d))) {
      return 'Error: Dangerous command blocked';
    }
    ctx.core.brief('info', 'bash', command);
    try {
      const result = execSync(command, {
        cwd: ctx.core.getWorkDir(),
        encoding: 'utf-8',
        timeout: config.timeouts.bashCommand,
        maxBuffer: config.tools.bashMaxBuffer,
      });
      return (result || '(no output)').slice(0, config.tools.bashOutputLimit);
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string };
      return (err.stderr || err.message || 'Unknown error').slice(0, config.tools.bashOutputLimit);
    }
  },
};