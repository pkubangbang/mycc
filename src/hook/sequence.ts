/**
 * sequence.ts - Query interface for conversation history
 *
 * Tracks tool executions for hook condition evaluation.
 * Events are added when tools are executed in the agent loop.
 *
 * Two scope levels:
 * 1. turn.*   — events since last user query (cleared at markPromptBoundary)
 * 2. session.* — events across entire livelog (cleared only by clear(), which
 *                is co-called with triologue.compact())
 *
 * Tool spec (three-class):
 *   "toolName"             — plain tool, exact name match
 *   "skill_load#skillName" — skill_load whose args.name contains skillName
 *   "bash#commandPrefix"   — bash whose args.command, after clause-splitting
 *                            by ;/&&/||, has a clause starting with commandPrefix
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
  /** Session-level tally table: tool name → total call count across all turns */
  private toolCallTally: Map<string, number> = new Map();
  /**
   * Session-level log of (tool, searchKey) pairs for #pattern counting.
   * Never cleared at turn boundaries (unlike `events`), so session.count('tool#pattern')
   * can count matching calls across the entire livelog.
   * Each entry is { tool, key } where `key` is the arg value searched by the pattern:
   *   - bash → args.command (the clause list the pattern matches against)
   *   - other tools (e.g. skill_load) → args.name
   */
  private sessionPatternLog: Array<{ tool: string; key: string }> = [];
  /** Session-level results log for session.countResult() and session.hadError() */
  private sessionResultsLog: Array<{ tool: string; args: Record<string, unknown>; result: string }> = [];
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
    // Update session-level tally for session.count lookups
    this.toolCallTally.set(event.tool, (this.toolCallTally.get(event.tool) || 0) + 1);
    // Update session-level pattern log for session.count('tool#pattern') lookups.
    // Only record tools that carry a searchable arg (bash→command, others→name).
    const key = extractSearchKey(event);
    if (key !== undefined) {
      this.sessionPatternLog.push({ tool: event.tool, key });
    }
    // Update session-level results log for session.countResult / session.hadError
    this.sessionResultsLog.push({ tool: event.tool, args: event.args, result: event.result });
  }

  /**
   * Clear all events at turn boundary.
   * Called from PROMPT state on each new user query, so hooks only see events from the current turn.
   * Session-level data is preserved — it tracks the entire livelog.
   */
  markPromptBoundary(): void {
    this.events = [];
  }

  /**
   * Clear the sequence (reset on new session or compact)
   * Co-called with triologue.compact() / triologue.recapMessages(), so session
   * counters stay in sync with livelog content.
   */
  clear(): void {
    this.events = [];
    this.totalEventsCount = 0;
    this.toolCallTally.clear();
    this.sessionPatternLog = [];
    this.sessionResultsLog = [];
  }

  /**
   * Get all events
   */
  getEvents(): SequenceEvent[] {
    return [...this.events];
  }

  // ===================================================================
  // TURN-SCOPED API — operates on `events` array (cleared at turn boundary)
  // ===================================================================

  /**
   * Count tool occurrences since last user query (current turn).
   * @param toolSpec - Tool spec (three-class): "toolName", "skill_load#name", "bash#prefix". Omit for all tools.
   */
  turnCount(toolSpec?: string): number {
    if (!toolSpec) {
      return this.events.length;
    }
    return this.events.filter(e => matchesToolSpec(e, toolSpec)).length;
  }

  /**
   * Get the index (position) of the last occurrence of a tool in the current turn.
   * @param toolSpec - Tool spec (three-class): "toolName", "skill_load#name", "bash#prefix"
   * Returns -1 if not found. Higher index = more recent.
   *
   * Example: turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint')
   *   → true if the last edit happened after (or at same position as) the last lint run
   */
  turnLastIndex(toolSpec: string): number {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (matchesToolSpec(this.events[i], toolSpec)) return i;
    }
    return -1;
  }

  /**
   * Count tool results whose content contains a substring pattern, since last user query.
   * @param toolSpec - Tool spec (three-class), or '*' for all tools
   * @param pattern - Substring to search in the tool result
   * @param maxChars - Optional: only search the first N chars of each result.
   *                   Prevents false positives from file content read into results.
   */
  turnCountResult(toolSpec: string, pattern: string, maxChars?: number): number {
    return this.events.filter(e => {
      if (toolSpec !== '*' && !matchesToolSpec(e, toolSpec)) return false;
      const searchText = maxChars ? e.result.slice(0, maxChars) : e.result;
      return searchText.includes(pattern);
    }).length;
  }

  /**
   * Check if any tool result contains 'error'/'failed' since last user query.
   * @param toolSpec - Optional tool spec (three-class) to filter by. Omit for all tools.
   */
  turnHadError(toolSpec?: string): boolean {
    return this.events.some(e => {
      if (toolSpec && !matchesToolSpec(e, toolSpec)) return false;
      const result = e.result?.toLowerCase() || '';
      return result.includes('error') || result.includes('failed');
    });
  }

  // ===================================================================
  // SESSION-SCOPED API — operates on livelog-level data (never cleared at turn boundary)
  // ===================================================================

  /**
   * Count tool occurrences across the entire livelog (since session start or last compact).
   * @param toolSpec - Tool spec (three-class): "toolName", "skill_load#name", "bash#prefix". Omit for all tools.
   */
  sessionCount(toolSpec?: string): number {
    if (!toolSpec) {
      return this.totalEventsCount;
    }
    // tool#pattern: session-wide count of calls whose searchable arg matches
    if (toolSpec.includes('#')) {
      return this.sessionPatternLog.filter(entry => matchesSessionPatternEntry(entry, toolSpec)).length;
    }
    return this.toolCallTally.get(toolSpec) || 0;
  }

  /**
   * Get the index (position) of the last occurrence of a tool across the entire livelog.
   * Uses sessionPatternLog for tool#pattern matching, toolCallTally for plain tools.
   * Returns -1 if not found. Higher index = more recent.
   *
   * NOTE: This indexes into the session-level results log, which spans all turns.
   * The index is relative to session start, not turn start.
   */
  sessionLastIndex(toolSpec: string): number {
    for (let i = this.sessionResultsLog.length - 1; i >= 0; i--) {
      const entry = this.sessionResultsLog[i];
      if (matchesToolSpec(entry, toolSpec)) return i;
    }
    return -1;
  }

  /**
   * Count tool results whose content contains a substring pattern, across the entire livelog.
   * @param toolSpec - Tool spec (three-class), or '*' for all tools
   * @param pattern - Substring to search in the tool result
   * @param maxChars - Optional: only search the first N chars of each result.
   */
  sessionCountResult(toolSpec: string, pattern: string, maxChars?: number): number {
    return this.sessionResultsLog.filter(e => {
      if (toolSpec !== '*' && !matchesToolSpec(e, toolSpec)) return false;
      const searchText = maxChars ? e.result.slice(0, maxChars) : e.result;
      return searchText.includes(pattern);
    }).length;
  }

  /**
   * Check if any tool result contains 'error'/'failed' across the entire livelog.
   * @param toolSpec - Optional tool spec (three-class) to filter by. Omit for all tools.
   */
  sessionHadError(toolSpec?: string): boolean {
    return this.sessionResultsLog.some(e => {
      if (toolSpec && !matchesToolSpec(e, toolSpec)) return false;
      const result = e.result?.toLowerCase() || '';
      return result.includes('error') || result.includes('failed');
    });
  }

  // ===================================================================
  // LEGACY / UTILITY
  // ===================================================================

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
      turnCount: (tool?: string) => this.turnCount(tool),
      turnLastIndex: (tool: string) => this.turnLastIndex(tool),
      turnCountResult: (tool: string, pattern: string, maxChars?: number) => this.turnCountResult(tool, pattern, maxChars),
      turnHadError: (tool?: string) => this.turnHadError(tool),
      sessionCount: (tool?: string) => this.sessionCount(tool),
      sessionLastIndex: (tool: string) => this.sessionLastIndex(tool),
      sessionCountResult: (tool: string, pattern: string, maxChars?: number) => this.sessionCountResult(tool, pattern, maxChars),
      sessionHadError: (tool?: string) => this.sessionHadError(tool),
      isPlanMode: () => this.isPlanMode(),
      call,
    };

    return evaluateExpression(expression, ctx);
  }
}

// ===================================================================
// TOOL SPEC MATCHING — three-class pattern matching
// ===================================================================

/**
 * Extract the searchable arg value from an event for `tool#pattern` matching.
 *
 * The `#pattern` substring is matched against this key:
 *   - `args.command` for bash (matches a command substring, e.g. 'bash#lint')
 *   - `args.name` for other tools (e.g. 'skill_load#plan_quality' matches a
 *     skill_load call whose `name` arg contains 'plan_quality')
 *   - if `args.command` is a string it wins (bash); otherwise `args.name` is
 *     used if it is a string; otherwise the event has no searchable key and
 *     undefined is returned (the event is skipped by pattern matchers).
 *
 * Shared by Sequence (runtime) and MockSequence (validation/testing) so both
 * paths apply identical matching semantics.
 */
export function extractSearchKey(event: { args?: Record<string, unknown> }): string | undefined {
  const cmd = event.args?.command;
  if (typeof cmd === 'string') return cmd;
  const name = event.args?.name;
  if (typeof name === 'string') return name;
  return undefined;
}

/**
 * Matches an event against a three-class tool spec.
 *
 * Three classes:
 *   "toolName"             — plain tool, exact name match
 *   "skill_load#skillName" — tool=skill_load AND args.name contains skillName
 *   "bash#commandPrefix"   — tool=bash AND args.command, after clause-splitting
 *                            by ;/&&/||, has a clause starting with commandPrefix
 *
 * For patterns WITHOUT '#', falls back to exact tool name match.
 */
export function matchesToolSpec(
  event: { tool: string; args?: Record<string, unknown> },
  toolSpec: string
): boolean {
  if (toolSpec.includes('#')) {
    const [tool, pattern] = toolSpec.split('#');
    if (event.tool !== tool) return false;

    if (tool === 'bash') {
      // bash: clause-split + prefix match
      const cmd = event.args?.command;
      if (typeof cmd !== 'string') return false;
      const clauses = splitClauses(cmd);
      return clauses.some(c => c.startsWith(pattern));
    }

    // skill_load or other # patterns: substring match on args.name
    const name = event.args?.name;
    if (typeof name !== 'string') return false;
    return name.includes(pattern);
  }

  // Plain tool name: exact match
  return event.tool === toolSpec;
}

/**
 * Matches a session pattern log entry against a tool#pattern spec.
 * Used by sessionCount() for session-wide pattern counting.
 */
function matchesSessionPatternEntry(
  entry: { tool: string; key: string },
  toolSpec: string
): boolean {
  if (!toolSpec.includes('#')) return false;
  const [tool, pattern] = toolSpec.split('#');
  if (entry.tool !== tool) return false;

  if (tool === 'bash') {
    // bash: clause-split + prefix match on the stored key (args.command)
    const clauses = splitClauses(entry.key);
    return clauses.some(c => c.startsWith(pattern));
  }

  // skill_load or other: substring match on key (args.name)
  return entry.key.includes(pattern);
}

/**
 * Split a command string into clauses by ;, &&, ||.
 * Each clause is trimmed of whitespace.
 * Returns an array of clauses.
 */
export function splitClauses(command: string): string[] {
  return command
    .split(/\s*(?:;|&&|\|\|)\s*/)
    .map(c => c.trim())
    .filter(c => c.length > 0);
}