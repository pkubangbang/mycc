/**
 * plan_off.ts - Switch back to normal mode (code changes allowed)
 *
 * Scope: ['main'] - Only available to main agent (only main maintains mode state)
 *
 * This tool switches the agent back to normal mode where code changes are allowed.
 * REQUIRES USER CONFIRMATION when transitioning from plan mode to prevent automatic bypass.
 *
 * Idempotent: Calling plan_off when already in normal mode simply returns success.
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

IMPORTANT: When in plan mode, this tool requires user confirmation before exiting.
The tool will ask the user [y/N] and only proceed if the user confirms.

Idempotent: If already in normal mode, returns success without prompting.`,
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  scope: ['main'],
  handler: async (ctx: AgentContext, _args: Record<string, unknown>): Promise<string> => {
    const core = ctx.core as Core;
    const currentMode = core.getMode();

    // Idempotent: already in normal mode, no action needed
    if (currentMode === 'normal') {
      ctx.core.brief('info', 'plan_off', 'Already in normal mode');
      return `Already in normal mode.\n\nCode changes are allowed. All tools are fully functional.`;
    }

    // Transitioning from plan mode -> require user confirmation
    const prompt = `Exit plan mode and allow code changes? [y/N]`;

    const response = await ctx.core.question(prompt, ctx.core.getName());

    // Parse response - only 'y' or 'yes' (case-insensitive) grants permission
    let normalized = response.trim().toLowerCase();
    if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
        (normalized.startsWith("'") && normalized.endsWith("'"))) {
      normalized = normalized.slice(1, -1).trim();
    }
    const granted = normalized === 'y' || normalized === 'yes';
    const denied = normalized === 'n' || normalized === 'no';

    if (denied) {
      ctx.core.brief('info', 'plan_off', 'User declined - staying in plan mode');
      return 'User declined. Staying in plan mode. Code changes remain prohibited.';
    }

    if (!granted) {
      ctx.core.brief('info', 'plan_off', `User responded: "${response}"`);
      return `User did not confirm exiting plan mode. User's response: "${response}"\n\nYou remain in plan mode. Ask for clarification if needed, or request permission again with plan_off.`;
    }

    // User granted permission - exit plan mode
    core.setMode('normal');
    ctx.core.brief('info', 'plan_off', 'Normal mode activated');
    return `Normal mode activated.\n\nCode changes are now allowed. All tools are fully functional.`;
  },
};