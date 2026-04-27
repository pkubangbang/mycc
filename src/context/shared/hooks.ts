/**
 * hooks.ts - Hook execution engine for hookish skills
 *
 * Handles the execution of hook actions (inject_before, inject_after, block, replace, message)
 * with timeout support and duplicate prevention.
 */

import type { ToolCall } from '../../types.js';
import type { AgentContext } from '../../types.js';
import type { HookAction, ConditionRegistry, Condition } from './conditions.js';
import type { Sequence } from './sequence.js';

/**
 * Tool call augmented with metadata for hook evaluation
 */
export interface AugmentedToolCall extends ToolCall {
  metadata?: {
    // File metadata (for file operations)
    filePath?: string;
    isTestFile?: boolean;
    newLoc?: number;       // LOC in the new content
    existingLoc?: number;  // LOC in existing file (if exists)

    // Bash metadata
    isDestructive?: boolean;  // rm, git push --force, etc.

    // Generic
    [key: string]: unknown;
  };
}

/**
 * Result of hook execution
 */
export interface HookResult {
  action: 'proceed' | 'blocked' | 'injected';
  message?: string;
  newCalls?: ToolCall[];
}

/**
 * Result of processToolCalls
 */
export interface ProcessToolCallsResult {
  calls: AugmentedToolCall[];       // Modified array (blocked calls kept, injections added)
  blockedCalls: Map<string, string>; // toolCall.id → blocking message
  deferredMessages: string[];        // Messages to inject after tool execution
}

/**
 * Internal result for single call processing
 */
interface CallProcessResult {
  calls: AugmentedToolCall[];  // Resulting calls (may be multiple due to inject_before)
  blocked: boolean;
  blockMessage?: string;
  messages: string[];
}

/**
 * Hook action priority for evaluation order.
 * Blockers first (safety), then replacers (modification), then injectors (addition).
 */
const HOOK_PRIORITY: Record<string, number> = {
  block: 0,
  replace: 1,
  inject_before: 2,
  inject_after: 2,
  message: 3,
};

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

  /**
   * Process all hooks against an array of augmented tool calls.
   *
   * Takes the entire delta (array of tool calls with metadata) and returns a modified delta.
   * Handles all hook actions: block, replace, inject_before, inject_after, message.
   *
   * Conditions can reference:
   * - seq.* methods for history
   * - call.metadata.* for current call's metadata
   *
   * Hook priority: blockers → replacers → injectors (first wins within each group)
   */
  async processToolCalls(
    calls: AugmentedToolCall[],
    ctx: AgentContext,
    getSkill: (name: string) => { content?: string } | undefined
  ): Promise<ProcessToolCallsResult> {
    const result: ProcessToolCallsResult = {
      calls: [],              // All calls including blocked ones
      blockedCalls: new Map(), // Blocked call IDs → rejection message
      deferredMessages: [],
    };

    for (const call of calls) {
      const processResult = await this.processSingleCall(call, ctx, getSkill);

      // Always add calls to result (blocked calls are kept for visibility)
      result.calls.push(...processResult.calls);

      // Track blocked calls separately so agent-loop can return rejection
      if (processResult.blocked) {
        result.blockedCalls.set(call.id, processResult.blockMessage!);
      }

      result.deferredMessages.push(...processResult.messages);
    }

    return result;
  }

  /**
   * Process hooks for a single tool call
   */
  private async processSingleCall(
    call: AugmentedToolCall,
    ctx: AgentContext,
    getSkill: (name: string) => { content?: string } | undefined
  ): Promise<CallProcessResult> {
    const toolName = call.function.name;
    const matchedHooks = this.checkHooks(toolName);

    if (matchedHooks.length === 0) {
      return { calls: [call], blocked: false, messages: [] };
    }

    // Group hooks by priority
    const hooksByPriority = this.groupHooksByPriority(matchedHooks);
    const sortedPriorities = Array.from(hooksByPriority.keys()).sort((a, b) => a - b);

    let calls: AugmentedToolCall[] = [call];
    const messages: string[] = [];

    for (const priority of sortedPriorities) {
      for (const { name: hookName, cond } of hooksByPriority.get(priority)!) {
        const skill = getSkill(hookName);
        if (!skill) continue;

        // Evaluate condition with BOTH sequence and call metadata
        if (!this.evaluateCondition(cond.condition, call)) {
          continue;  // Condition doesn't match
        }

        const result = await this.execute(hookName, cond.action, ctx, calls, skill.content || '');

        if (result.action === 'blocked') {
          // Keep the call in array but mark as blocked with rejection message
          return { calls: [call], blocked: true, blockMessage: result.message, messages };
        }

        if (result.action === 'injected' && result.newCalls) {
          calls = result.newCalls as AugmentedToolCall[];
          // For blockers/replacers, return immediately (first wins)
          if (priority < 2) {
            return { calls, blocked: false, messages };
          }
          // For inject_before/after, continue to check other hooks
        }

        if (result.action === 'proceed' && result.message) {
          messages.push(result.message);
        }
      }
    }

    return { calls, blocked: false, messages };
  }

  /**
   * Group hooks by their action priority
   */
  private groupHooksByPriority(
    hookNames: string[]
  ): Map<number, Array<{ name: string; cond: Condition }>> {
    const result = new Map<number, Array<{ name: string; cond: Condition }>>();

    for (const hookName of hookNames) {
      const cond = this.conditions.get(hookName);
      if (!cond) continue;

      const priority = HOOK_PRIORITY[cond.action.type] ?? 3;
      if (!result.has(priority)) {
        result.set(priority, []);
      }
      result.get(priority)!.push({ name: hookName, cond });
    }

    return result;
  }

  /**
   * Evaluate a condition expression against sequence and call metadata.
   */
  private evaluateCondition(condition: string, call: AugmentedToolCall): boolean {
    try {
      // Create evaluation context with seq and call
      const seq = this.sequence;
      const callContext = {
        metadata: call.metadata || {},
        args: call.function.arguments,
      };

      // Transform condition: call.X → callContext.X
      const expr = condition
        .replace(/call\.metadata\./g, 'callContext.metadata.')
        .replace(/call\.args\./g, 'callContext.args.')
        .replace(/call\.args\b/g, 'callContext.args');

      // Safely evaluate
      const fn = new Function('seq', 'callContext', `return ${expr}`);
      return fn(seq, callContext);
    } catch {
      return false;
    }
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