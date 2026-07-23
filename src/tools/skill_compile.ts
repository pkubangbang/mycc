/**
 * skill_compile.ts - Compile a skill's "when" condition into a structured hook
 *
 * Scope: ['main', 'child'] - Available to all agents
 *
 * This tool translates natural language "when" conditions into executable
 * expressions that can be evaluated against the conversation sequence.
 *
 * Lineage: compilation is delegated to ctx.skill (Loader), which owns the
 * runtime ConditionRegistry in the lead process (in-memory update + disk
 * persist, no restart needed) and falls back to disk + IPC for child
 * processes. This replaces the old approach of creating a throwaway
 * ConditionRegistry and sending a 'condition_reload' IPC message that the
 * Coordinator silently dropped.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { ConditionRegistry } from '../hook/conditions.js';

export const skillCompileTool: ToolDefinition = {
  name: 'skill_compile',
  description: `Compile a skill's "when" condition into a structured hook. Use when a skill has a "when" field but no compiled condition, or to update a hook based on user feedback.`,
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Skill name to compile',
      },
      feedback: {
        type: 'string',
        description: 'Optional user feedback for refining the condition. Use when the hook is not working as expected.',
      },
    },
    required: ['name'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const skillName = args.name as string;
    const feedback = args.feedback as string | undefined;

    // Get the skill
    const skill = ctx.skill.getSkill(skillName);
    if (!skill) {
      return `Error: Skill '${skillName}' not found.`;
    }

    // Check if skill has "when" field
    if (!skill.when) {
      // No "when" field — look up any existing compiled condition from disk
      // (read-only lookup; we don't want to compile or mutate anything here).
      const conditions = new ConditionRegistry();
      const preLoadResult = await conditions.load();
      for (const error of preLoadResult.errors) {
        ctx.core.brief('error', 'skill_compile', `Load error: ${error}`);
      }
      for (const warning of preLoadResult.warnings) {
        ctx.core.brief('warn', 'skill_compile', `Load warning: ${warning}`);
      }
      const existing = conditions.get(skillName);

      if (existing) {
        return `Skill '${skillName}' has no "when" field but has a compiled condition:\n` +
          `Trigger: ${existing.trigger}\n` +
          `Condition: ${existing.condition}\n` +
          `Action: ${JSON.stringify(existing.action)}\n` +
          `Version: ${existing.version}`;
      }

      return `Error: Skill '${skillName}' has no "when" field. Only skills with "when" conditions can be compiled.`;
    }

    // Delegate compilation to the Loader (ctx.skill), which owns the runtime
    // ConditionRegistry in the lead process. This performs an in-memory
    // update + atomic disk persist in the lead, and a disk write + IPC
    // 'condition_replace' message in child processes — no broken IPC, no
    // restart needed.
    const result = await ctx.skill.compileCondition(skillName, feedback);

    // Handle compilation result
    if (result.error) {
      const lines = [`Error compiling skill: ${result.error}`];

      if (result.validation) {
        lines.push('', 'Validation details:');
        for (const err of result.validation.errors) {
          lines.push(`  - Error: ${err}`);
        }
        for (const warn of result.validation.warnings) {
          lines.push(`  - Warning: ${warn}`);
        }
      }

      return lines.join('\n');
    }

    const condition = result.condition!;

    // Brief output — always visible summary of compilation
    ctx.core.brief('info', 'skill_compile',
      `${skillName} (v${condition.version})\nTrigger: ${condition.trigger}\nCondition: ${condition.condition}\nAction Type: ${condition.action.type}\nAction: ${JSON.stringify(condition.action)}`);

    // Build response
    const lines = [
      `Compiled '${skillName}' (v${condition.version}):`,
      ``,
      `When: ${skill.when}`,
      `Trigger: ${condition.trigger}`,
      `Condition: ${condition.condition}`,
      `Action Type: ${condition.action.type}`,
      `Action: ${JSON.stringify(condition.action, null, 2)}`,
    ];

    // Include validation warnings if any
    if (result.validation && result.validation.warnings.length > 0) {
      lines.push('', 'Warnings:');
      for (const warn of result.validation.warnings) {
        lines.push(`  - ${warn}`);
      }
    }

    if (feedback) {
      lines.push('', `Refinement reason: ${feedback}`);
    }

    if (condition.history && condition.history.length > 1) {
      lines.push('', 'History:');
      for (const h of condition.history) {
        lines.push(`  v${h.version}: ${h.condition.slice(0, 50)}${h.condition.length > 50 ? '...' : ''}`);
        if (h.reason) {
          lines.push(`    Reason: ${h.reason}`);
        }
      }
    }

    return lines.join('\n');
  },
};