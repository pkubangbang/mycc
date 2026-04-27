/**
 * sequence.ts - Query interface for conversation history
 *
 * Tracks tool executions for hook condition evaluation.
 * Events are added when tools are executed in the agent loop.
 */

import type { Triologue } from '../../loop/triologue.js';

/**
 * A single event in the sequence
 */
export interface SequenceEvent {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  timestamp: number;
}

/**
 * Sequence class - provides query interface over conversation history
 * 
 * Two data sources:
 * 1. Internal events array - tracks tool calls (populated by add())
 * 2. Triologue - tracks skill content injections (for duplicate prevention)
 */
export class Sequence {
  private events: SequenceEvent[] = [];
  private triologue?: Triologue;

  constructor(triologue?: Triologue) {
    this.triologue = triologue;
  }

  /**
   * Add an event to the sequence
   */
  add(event: SequenceEvent): void {
    this.events.push(event);
  }

  /**
   * Clear the sequence (reset on new session)
   */
  clear(): void {
    this.events = [];
  }

  /**
   * Get all events
   */
  getEvents(): SequenceEvent[] {
    return [...this.events];
  }

  /**
   * Check if a tool exists in the sequence
   */
  has(toolName: string): boolean {
    return this.events.some(e => e.tool === toolName);
  }

  /**
   * Check if any of the tools exist in the sequence
   */
  hasAny(tools: string[]): boolean {
    return tools.some(t => this.has(t));
  }

  /**
   * Check if a bash command with a specific pattern exists
   * Pattern: bash#pattern means bash command containing 'pattern'
   */
  hasCommand(pattern: string): boolean {
    // Handle bash#pattern syntax
    if (pattern.includes('#')) {
      const [tool, cmdPattern] = pattern.split('#');
      return this.events.some(e => {
        if (e.tool !== tool) return false;
        const cmd = e.args?.command;
        if (typeof cmd !== 'string') return false;
        return cmd.includes(cmdPattern);
      });
    }
    
    // Regular tool name check
    return this.has(pattern);
  }

  /**
   * Get the last event, or last event matching a tool
   */
  last(toolName?: string): SequenceEvent | undefined {
    if (!toolName) {
      return this.events[this.events.length - 1];
    }
    
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].tool === toolName) {
        return this.events[i];
      }
    }
    return undefined;
  }

  /**
   * Get the last error event (result contains 'error' or 'Error')
   * Returns the event with an additional 'message' field for convenience
   */
  lastError(): (SequenceEvent & { message: string }) | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const result = this.events[i].result?.toLowerCase() || '';
      if (result.includes('error') || result.includes('failed')) {
        return {
          ...this.events[i],
          message: this.events[i].result || '',
        };
      }
    }
    return undefined;
  }

  /**
   * Count occurrences of a tool in the sequence
   */
  count(toolName?: string): number {
    if (!toolName) {
      return this.events.length;
    }
    return this.events.filter(e => e.tool === toolName).length;
  }

  /**
   * Get events since the last occurrence of a tool
   */
  since(toolName: string): SequenceEvent[] {
    const lastIdx = this.events.map(e => e.tool).lastIndexOf(toolName);
    if (lastIdx === -1) {
      return [...this.events];
    }
    return this.events.slice(lastIdx + 1);
  }

  /**
   * Get events since the last file edit (edit_file, write_file)
   */
  sinceEdit(): SequenceEvent[] {
    const editTools = ['edit_file', 'write_file'];
    let lastIdx = -1;
    
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (editTools.includes(this.events[i].tool)) {
        lastIdx = i;
        break;
      }
    }
    
    if (lastIdx === -1) {
      return [...this.events];
    }
    return this.events.slice(lastIdx + 1);
  }

  /**
   * Check if a skill content is already in conversation (via markers)
   * Used for duplicate prevention by checking triologue messages
   */
  hasSkillInConversation(skillName: string): boolean {
    if (!this.triologue) {
      return false;
    }
    
    const hookMarker = `[Hook: ${skillName}]`;
    const skillMarker = `[Skill: ${skillName}]`;
    
    return this.triologue.getMessagesRaw().some(
      msg => msg.content?.includes(hookMarker) || msg.content?.includes(skillMarker)
    );
  }

  /**
   * Evaluate a condition expression against the sequence
   * Supports simple DSL: seq.has('tool'), seq.hasAny(['a','b']), etc.
   */
  evaluate(expression: string): boolean {
    // Create a safe evaluation context
    const ctx = {
      has: (tool: string) => this.has(tool),
      hasAny: (tools: string[]) => this.hasAny(tools),
      hasCommand: (pattern: string) => this.hasCommand(pattern),
      last: (tool?: string) => this.last(tool),
      lastError: () => this.lastError(),
      count: (tool?: string) => this.count(tool),
      since: (tool: string) => this.since(tool),
      sinceEdit: () => this.sinceEdit(),
    };

    try {
      // Simple expression evaluation
      // Replace seq.X with ctx.X
      const jsExpr = expression
        .replace(/seq\.has\(/g, 'has(')
        .replace(/seq\.hasAny\(/g, 'hasAny(')
        .replace(/seq\.hasCommand\(/g, 'hasCommand(')
        .replace(/seq\.last\(/g, 'last(')
        .replace(/seq\.lastError\(/g, 'lastError(')
        .replace(/seq\.count\(/g, 'count(')
        .replace(/seq\.since\(/g, 'since(')
        .replace(/seq\.sinceEdit\(/g, 'sinceEdit(');

      // Use Function constructor for safe evaluation
      const fn = new Function(
        'has', 'hasAny', 'hasCommand', 'last', 'lastError', 'count', 'since', 'sinceEdit',
        `return ${jsExpr}`
      );
      
      return fn(
        ctx.has, ctx.hasAny, ctx.hasCommand, ctx.last, ctx.lastError, 
        ctx.count, ctx.since, ctx.sinceEdit
      );
    } catch (err) {
      // If evaluation fails, return false
      console.error(`[Sequence] Failed to evaluate condition: ${expression}`, err);
      return false;
    }
  }
}