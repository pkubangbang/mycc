/**
 * skill_compile.ts - Compile a skill's "when" condition into a structured hook
 *
 * Scope: ['main', 'child'] - Available to all agents
 *
 * This tool translates natural language "when" conditions into executable
 * expressions that can be evaluated against the conversation sequence.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { ConditionRegistry } from '../context/shared/conditions.js';

export const skillCompileTool: ToolDefinition = {
  name: 'skill_compile',
  description: `Compile a skill's "when" condition into a structured hook.

Use this when:
- A skill has a "when" field but no compiled condition
- You need to update a hook condition based on user feedback
- You want to see the current compiled condition for a skill

The compilation asks the LLM to translate natural language "when" into:
- trigger: which tool fires the hook
- condition: executable expression using seq.X functions
- action: what to do (inject_before, inject_after, block, replace, message)

Returns the compiled condition with version history.`,
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
      // Check if there's already a compiled condition
      const conditions = new ConditionRegistry();
      await conditions.load();
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

    // Get or create condition registry
    const conditions = new ConditionRegistry();
    await conditions.load();

    // Get existing condition if any
    const existing = conditions.get(skillName);

    // Compile
    try {
      const condition = await conditions.compile(
        skill.when,
        skillName,
        skill.content,
        existing
      );

      // Build response
      const lines = [
        `Compiled '${skillName}' (v${condition.version}):`,
        ``,
        `When: ${skill.when}`,
        `Trigger: ${condition.trigger}`,
        `Condition: ${condition.condition}`,
        `Action: ${JSON.stringify(condition.action, null, 2)}`,
      ];

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
    } catch (err) {
      return `Error compiling skill: ${(err as Error).message}`;
    }
  },
};