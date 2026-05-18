/**
 * sequence.ts - Query interface for conversation history
 *
 * Tracks tool executions for hook condition evaluation.
 * Events are added when tools are executed in the agent loop.
 */

import type { Triologue } from '../loop/triologue.js';
import { evaluateExpression, type EvalContext } from './evaluator.js';

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
  private totalEventsCount: number = 0; // session-level total, never cleared at turn boundary
  private triologue?: Triologue;
  private getMode: () => 'plan' | 'normal';

  constructor(triologue?: Triologue, getMode?: () => 'plan' | 'normal') {
    this.triologue = triologue;
    this.getMode = getMode || (() => 'normal');
  }

  /**
   * Add an event to the sequence
   */
  add(event: SequenceEvent): void {
    this.events.push(event);
    this.totalEventsCount++;
  }

  /**
   * Clear all events at turn boundary.
   * Called from PROMPT state on each new user query, so hooks only see events from the current turn.
   * totalEventsCount is preserved — it tracks the entire session.
   */
  markPromptBoundary(): void {
    this.events = [];
  }

  /**
   * Clear the sequence (reset on new session)
   */
  clear(): void {
    this.events = [];
    this.totalEventsCount = 0;
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
   * Get the index (position) of the last occurrence of a tool or bash command pattern.
   * Pattern syntax: "toolName" for simple tool match, "bash#pattern" for bash command substring.
   * Returns -1 if not found. Higher index = more recent.
   * 
   * Example: seq.lastIndexOf('edit_file') >= seq.lastIndexOf('bash#lint')
   *   → true if the last edit happened after (or at same position as) the last lint run
   */
  lastIndexOf(pattern: string): number {
    // Handle bash#pattern syntax
    if (pattern.includes('#')) {
      const [tool, cmdPattern] = pattern.split('#');
      for (let i = this.events.length - 1; i >= 0; i--) {
        const e = this.events[i];
        if (e.tool !== tool) continue;
        const cmd = e.args?.command;
        if (typeof cmd !== 'string') continue;
        if (cmd.includes(cmdPattern)) return i;
      }
      return -1;
    }
    
    // Regular tool name match
    return this.events.map(e => e.tool).lastIndexOf(pattern);
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
   * Count tool results whose content contains a substring pattern.
   * Scans events since the last user query (current turn).
   *
   * @param tool - Tool name to filter by, or '*' for all tools
   * @param pattern - Substring to search in the tool result
   * @param maxChars - Optional: only search the first N chars of each result.
   *                   Prevents false positives from file content read into results.
   */
  countResult(tool: string, pattern: string, maxChars?: number): number {
    return this.events.filter(e => {
      if (tool !== '*' && e.tool !== tool) return false;
      const searchText = maxChars ? e.result.slice(0, maxChars) : e.result;
      return searchText.includes(pattern);
    }).length;
  }

  /**
   * Count occurrences of a tool in the current turn (since last user query).
   */
  count(toolName?: string): number {
    if (!toolName) {
      return this.events.length;
    }
    return this.events.filter(e => e.tool === toolName).length;
  }

  /**
   * Count occurrences of a tool across the entire session.
   * Unlike count(), this is never reset at turn boundaries.
   */
  totalCount(toolName?: string): number {
    if (!toolName) {
      return this.totalEventsCount;
    }
    // Derive session-level counts from the triologue for per-tool accuracy
    if (this.triologue) {
      return this.triologue.getMessagesRaw()
        .filter(m => m.role === 'tool' && m.tool_name === toolName)
        .length;
    }
    // Fallback: approximate from in-memory total (can't distinguish by tool)
    return toolName ? 0 : this.totalEventsCount;
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
   * Check if agent is in plan mode
   * Used by hooks to prevent triggering during planning
   */
  isPlanMode(): boolean {
    return this.getMode() === 'plan';
  }

  /**
   * Evaluate a condition expression against the sequence
   * Supports simple DSL: seq.has('tool'), seq.hasAny(['a','b']), etc.
   * Uses jsep AST parsing for safe evaluation (no Function constructor).
   */
  evaluate(expression: string): boolean {
    return this.evaluateWithCall(expression, undefined);
  }

  /**
   * Evaluate a condition expression with optional call context.
   * When call context is provided, conditions can reference call.metadata.X
   * and call.args.X for the current tool call being evaluated.
   * Uses jsep AST parsing for safe evaluation (no Function constructor).
   */
  evaluateWithCall(
    expression: string,
    call?: { metadata?: Record<string, unknown>; args?: Record<string, unknown> }
  ): boolean {
    // Create evaluation context
    const ctx: EvalContext = {
      has: (tool: string) => this.has(tool),
      hasAny: (tools: string[]) => this.hasAny(tools),
      lastIndexOf: (pattern: string) => this.lastIndexOf(pattern),
      last: (tool?: string) => this.last(tool),
      lastError: () => this.lastError(),
      count: (tool?: string) => this.count(tool),
      totalCount: (tool?: string) => this.totalCount(tool),
      countResult: (tool: string, pattern: string, maxChars?: number) => this.countResult(tool, pattern, maxChars),
      since: (tool: string) => this.since(tool),
      sinceEdit: () => this.sinceEdit(),
      isPlanMode: () => this.isPlanMode(),
      call,
    };

    return evaluateExpression(expression, ctx);
  }
}