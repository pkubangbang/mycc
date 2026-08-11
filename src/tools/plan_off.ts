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
import type { TeamManager } from '../context/parent/team.js';
import { shouldAllowPlanOff } from '../config.js';

export const planOffTool: ToolDefinition = {
  name: 'plan_off',
  description: `Switch back to normal mode (code changes allowed). Requires user confirmation. Idempotent if already in normal mode.`,
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

    // Auto-mode auto-approve: when the --allow-plan-off CLI flag is set AND
    // the lead is in auto mode, skip the user confirmation and directly
    // exit plan mode. This lets an unattended peer (started with --auto)
    // recover from a self-triggered plan_on instead of being permanently
    // locked (auto-mode question() auto-replies with onEsc:'n' → denied).
    //
    // NOTE: this getAuto() check is intentionally NOT converted to the
    // `source === 'auto'` pattern used in git_commit.ts. Unlike git_commit,
    // this check runs BEFORE question() is called (it decides whether to
    // skip the prompt entirely), so there is no AskResult.source to read.
    if (shouldAllowPlanOff() && core.getAuto()) {
      core.setMode('normal');
      const team = ctx.team as TeamManager;
      team.broadcastModeChange('normal');
      ctx.core.brief('info', 'plan_off', 'Auto-approved plan_off (auto mode + --allow-plan-off flag)');
      return `Normal mode activated (auto-approved via --allow-plan-off).\n\nCode changes are now allowed. All tools are fully functional.`;
    }

    // Transitioning from plan mode -> require user confirmation
    const prompt = `Exit plan mode and allow code changes? [y/N]`;

    const { answer: response } = await ctx.core.question(prompt, ctx.core.getName(), { onEsc: 'n' });

    // Parse response - only 'y' or 'yes' (case-insensitive) grants permission
    let normalized = response.trim().toLowerCase();
    if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
        (normalized.startsWith("'") && normalized.endsWith("'"))) {
      normalized = normalized.slice(1, -1).trim();
    }
    const granted = normalized === 'y' || normalized === 'yes';
    // [y/N] convention means Enter = No (decline). Empty/whitespace response stays in plan mode,
    // consistent with plan_on.ts's strict-mode default-on-Enter behavior.
    const denied = normalized === '' || normalized === 'n' || normalized === 'no';

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
    const team = ctx.team as TeamManager;
    team.broadcastModeChange('normal');
    ctx.core.brief('info', 'plan_off', 'Normal mode activated');
    return `Normal mode activated.\n\nCode changes are now allowed. All tools are fully functional.`;
  },
};