/**
 * plan_off.ts - Switch back to normal mode (code changes allowed)
 *
 * Scope: ['main', 'child'] - Available to all agents
 *
 * This tool switches the agent back to normal mode where code changes are allowed.
 * No parameters needed - simply returns to normal mode.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import type { Core } from '../context/parent/core.js';

export const planOffTool: ToolDefinition = {
  name: 'plan_off',
  description: `Switch back to normal mode where code changes are allowed.

Use this tool when you're done planning and want to start making code changes.
In normal mode:
- File write/edit operations are allowed
- Bash commands are allowed
- All tools are fully functional

No parameters needed.`,
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  scope: ['main'],
  handler: async (ctx: AgentContext, _args: Record<string, unknown>): Promise<string> => {
    const core = ctx.core as Core;
    core.setMode('normal');
    ctx.core.brief('info', 'plan_off', 'Normal mode activated');
    return `Normal mode activated.\n\nCode changes are now allowed. All tools are fully functional.`;
  },
};