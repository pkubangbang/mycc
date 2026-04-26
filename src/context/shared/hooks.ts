/**
 * hooks.ts - Hook execution engine for hookish skills
 *
 * Handles the execution of hook actions (inject_before, inject_after, block, replace, message)
 * with timeout support and duplicate prevention.
 */

import type { ToolCall } from '../../types.js';
import type { AgentContext } from '../../types.js';
import type { HookAction, ConditionRegistry } from './conditions.js';
import type { Sequence } from './sequence.js';

/**
 * Result of hook execution
 */
export interface HookResult {
  action: 'proceed' | 'blocked' | 'injected';
  message?: string;
  newCalls?: ToolCall[];
}

/**
 * Hook executor - evaluates conditions and executes actions
 */
export class HookExecutor {
  private conditions: ConditionRegistry;
  private sequence: Sequence;

  constructor(conditions: ConditionRegistry, sequence: Sequence) {
    this.conditions = conditions;
    this.sequence = sequence;
  }

  /**
   * Check all hooks before a tool call
   * Returns matching hook skills and their actions
   */
  checkHooks(triggerTool: string): string[] {
    return this.conditions.matches(triggerTool, this.sequence);
  }

  /**
   * Execute a hook action
   * Returns modified tool calls or blocked status
   */
  async execute(
    skillName: string,
    action: HookAction,
    ctx: AgentContext,
    pendingCalls: ToolCall[],
    skillContent: string
  ): Promise<HookResult> {
    // Check if already injected (duplicate prevention)
    if (this.conditions.hasInjected(skillName)) {
      // Already in conversation - just reference
      return {
        action: 'proceed',
        message: `[Hook: ${skillName}] (content already in conversation)`,
      };
    }

    // Mark as injected
    this.conditions.markInjected(skillName);

    switch (action.type) {
      case 'inject_before':
        return this.injectBefore(skillName, action, ctx, pendingCalls, skillContent);

      case 'inject_after':
        return this.injectAfter(skillName, action, ctx, pendingCalls, skillContent);

      case 'block':
        return this.block(skillName, action, skillContent);

      case 'replace':
        return this.replace(skillName, action, ctx, pendingCalls, skillContent);

      case 'message':
        return this.message(skillName, skillContent);
    }
  }

  /**
   * Inject a tool call before the trigger
   */
  private async injectBefore(
    skillName: string,
    action: { type: 'inject_before'; tool: string; args: Record<string, unknown>; timeout?: number },
    ctx: AgentContext,
    pendingCalls: ToolCall[],
    skillContent: string
  ): Promise<HookResult> {
    const newCall: ToolCall = {
      id: `hook-${skillName}-${Date.now()}`,
      function: {
        name: action.tool,
        arguments: action.args,
      },
    };

    // Brief context for LLM
    ctx.core.brief('info', 'hook', `[${skillName}] Injecting ${action.tool} before trigger`, skillContent.slice(0, 100));

    return {
      action: 'injected',
      newCalls: [newCall, ...pendingCalls],
    };
  }

  /**
   * Inject a tool call after the trigger
   */
  private async injectAfter(
    skillName: string,
    action: { type: 'inject_after'; tool: string; args: Record<string, unknown>; timeout?: number },
    ctx: AgentContext,
    pendingCalls: ToolCall[],
    skillContent: string
  ): Promise<HookResult> {
    const newCall: ToolCall = {
      id: `hook-${skillName}-${Date.now()}`,
      function: {
        name: action.tool,
        arguments: action.args,
      },
    };

    ctx.core.brief('info', 'hook', `[${skillName}] Injecting ${action.tool} after trigger`, skillContent.slice(0, 100));

    // Insert after first call
    const remaining = pendingCalls.slice(1);
    return {
      action: 'injected',
      newCalls: [...pendingCalls.slice(0, 1), newCall, ...remaining],
    };
  }

  /**
   * Block the trigger tool
   */
  private async block(
    skillName: string,
    action: { type: 'block'; reason?: string },
    skillContent: string
  ): Promise<HookResult> {
    const reason = action.reason || skillContent.slice(0, 200);

    return {
      action: 'blocked',
      message: `[Hook: ${skillName}] Blocked: ${reason}`,
    };
  }

  /**
   * Replace the trigger tool with a different action
   */
  private async replace(
    skillName: string,
    action: { type: 'replace'; tool: string; args: Record<string, unknown>; timeout?: number },
    ctx: AgentContext,
    pendingCalls: ToolCall[],
    skillContent: string
  ): Promise<HookResult> {
    const firstCall = pendingCalls[0];
    
    // Replace the tool call
    firstCall.function.name = action.tool;
    firstCall.function.arguments = action.args;

    ctx.core.brief('info', 'hook', `[${skillName}] Replaced trigger with ${action.tool}`, skillContent.slice(0, 100));

    return {
      action: 'injected',
      newCalls: pendingCalls,
    };
  }

  /**
   * Just inject a message (weak action)
   */
  private async message(
    skillName: string,
    skillContent: string
  ): Promise<HookResult> {
    return {
      action: 'proceed',
      message: `[Hook: ${skillName}]\n\n${skillContent}`,
    };
  }
}

/**
 * Create a ToolCall for a hook action
 */
export function createToolCall(
  toolName: string,
  args: Record<string, unknown>,
  skillName: string
): ToolCall {
  return {
    id: `hook-${skillName}-${Date.now()}`,
    function: {
      name: toolName,
      arguments: args,
    },
  };
}