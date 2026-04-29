/**
 * mode_set.ts - Switch between plan mode and normal mode
 *
 * This tool allows switching between plan mode (blocks code modifications)
 * and normal mode (all tools available).
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const modeSetTool: ToolDefinition = {
  name: 'mode_set',
  description: `Switch between plan mode and normal mode.

In PLAN MODE:
- Code modifications are blocked (edit_file, write_file, git_commit)
- Team spawning is blocked (tm_create)
- Use for planning, analysis, and architecture decisions

In NORMAL MODE:
- All tools are available
- Default mode for implementation work

Use this tool to control whether the session allows code changes.`,
  input_schema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['plan', 'normal'],
        description: 'The mode to switch to',
      },
    },
    required: ['mode'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const mode = args.mode as 'plan' | 'normal';

    if (mode !== 'plan' && mode !== 'normal') {
      ctx.core.brief('error', 'mode_set', `Invalid mode: ${mode}`);
      return `Error: mode must be 'plan' or 'normal', got '${mode}'`;
    }

    const previousMode = ctx.core.getMode();
    ctx.core.setMode(mode);

    ctx.core.brief('info', 'mode_set', `Mode changed from '${previousMode}' to '${mode}'`);

    if (mode === 'plan') {
      return `Mode set to 'plan'. Code modifications are now BLOCKED.

You can:
- Read files (read_file)
- Run non-destructive commands (bash)
- Create issues (issue_create)
- Plan and document

You cannot:
- Edit files (edit_file, write_file)
- Commit changes (git_commit)
- Spawn teammates (tm_create)

Use mode_set({ mode: 'normal' }) to enable code changes.`;
    } else {
      return `Mode set to 'normal'. All tools are now available.

You can:
- Modify code (edit_file, write_file)
- Commit changes (git_commit)
- Spawn teammates (tm_create)

Use mode_set({ mode: 'plan' }) to block code changes during planning.`;
    }
  },
};