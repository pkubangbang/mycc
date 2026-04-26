/**
 * conditions.ts - Condition registry for hookish skills
 *
 * Manages compiled conditions from natural language "when" fields.
 * Conditions are lazy-compiled via skill_compile tool.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getMyccDir } from '../../config.js';
import { Sequence } from './sequence.js';

/**
 * Action types for hooks
 */
export type HookAction =
  | { type: 'inject_before'; tool: string; args: Record<string, unknown>; timeout?: number }
  | { type: 'inject_after'; tool: string; args: Record<string, unknown>; timeout?: number }
  | { type: 'block'; reason?: string }
  | { type: 'replace'; tool: string; args: Record<string, unknown>; timeout?: number }
  | { type: 'message' };

/**
 * Condition history entry
 */
export interface ConditionHistory {
  version: number;
  condition: string;
  action: HookAction;
  reason?: string;
}

/**
 * Compiled condition
 */
export interface Condition {
  trigger: string;      // Tool name or '*' for any
  when: string;         // Original natural language
  condition: string;    // Compiled expression
  action: HookAction;
  version: number;
  history?: ConditionHistory[];
}

/**
 * Conditions.json structure
 */
export interface ConditionsFile {
  [skillName: string]: Condition;
}

/**
 * Condition registry - manages compiled conditions
 */
export class ConditionRegistry {
  private conditions: Map<string, Condition> = new Map();
  private pending: Set<string> = new Set();  // Skills with "when" but no condition
  private injected: Set<string> = new Set();  // Skills already injected in conversation
  private filePath: string;

  constructor() {
    this.filePath = path.join(getMyccDir(), 'conditions.json');
  }

  /**
   * Load conditions from .mycc/conditions.json
   */
  async load(): Promise<void> {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const data: ConditionsFile = JSON.parse(content);
      
      for (const [name, cond] of Object.entries(data)) {
        this.conditions.set(name, cond);
      }
    } catch (err) {
      console.error(`[Conditions] Failed to load conditions.json: ${(err as Error).message}`);
    }
  }

  /**
   * Save conditions to .mycc/conditions.json
   */
  async save(): Promise<void> {
    const data: ConditionsFile = {};
    
    for (const [name, cond] of this.conditions) {
      data[name] = cond;
    }
    
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[Conditions] Failed to save conditions.json: ${(err as Error).message}`);
    }
  }

  /**
   * Get a condition by skill name
   */
  get(skillName: string): Condition | undefined {
    return this.conditions.get(skillName);
  }

  /**
   * Set a condition
   */
  set(skillName: string, condition: Condition): void {
    this.conditions.set(skillName, condition);
    this.pending.delete(skillName);
  }

  /**
   * Check if a skill needs compilation (has "when" but no condition)
   */
  needsCompilation(skillName: string): boolean {
    return this.pending.has(skillName);
  }

  /**
   * Mark a skill as needing compilation
   */
  markPending(skillName: string): void {
    if (!this.conditions.has(skillName)) {
      this.pending.add(skillName);
    }
  }

  /**
   * Mark a skill as injected in conversation (for duplicate prevention)
   */
  markInjected(skillName: string): void {
    this.injected.add(skillName);
  }

  /**
   * Check if a skill has been injected in this session
   */
  hasInjected(skillName: string): boolean {
    return this.injected.has(skillName);
  }

  /**
   * Clear injected markers (for new session)
   */
  clearInjected(): void {
    this.injected.clear();
  }

  /**
   * Find all conditions that match a trigger tool
   */
  findByTrigger(trigger: string): Condition[] {
    const matched: Condition[] = [];
    
    for (const cond of this.conditions.values()) {
      if (cond.trigger === '*' || cond.trigger === trigger) {
        matched.push(cond);
      }
    }
    
    return matched;
  }

  /**
   * Match conditions against the sequence and return skill names
   */
  matches(trigger: string, seq: Sequence): string[] {
    const matched: string[] = [];
    
    for (const [name, cond] of this.conditions) {
      // Skip if already injected (duplicate prevention)
      if (this.hasInjected(name)) {
        continue;
      }
      
      // Check trigger
      if (cond.trigger !== '*' && cond.trigger !== trigger) {
        continue;
      }
      
      // Evaluate condition
      if (seq.evaluate(cond.condition)) {
        matched.push(name);
      }
    }
    
    return matched;
  }

  /**
   * Compile a "when" expression into condition + action
   * This is called by the skill_compile tool
   */
  async compile(
    when: string,
    skillName: string,
    skillContent: string,
    existing?: Condition
  ): Promise<Condition> {
    // Import ollama dynamically to avoid circular dependency
    const { retryChat, MODEL } = await import('../../ollama.js');
    
    const existingInfo = existing
      ? `Current version ${existing.version}:
Condition: ${existing.condition}
Action: ${JSON.stringify(existing.action)}`
      : 'No existing condition (first compilation)';

    const prompt = `You are compiling a skill hook into a structured condition and action.

Skill name: ${skillName}
Natural language condition: "${when}"
Skill content:
${skillContent}

${existingInfo}

Available condition functions (use seq.X syntax):
- seq.has(toolName): Check if tool exists in sequence
- seq.hasAny([tool1, tool2]): Check if any tool exists
- seq.hasCommand(pattern): Check bash command contains pattern (e.g., "bash#lint")
- seq.last(toolName?): Get last event (optionally filtered by tool)
- seq.lastError(): Get last error event
- seq.count(toolName?): Count tool occurrences
- seq.since(toolName): Events after last occurrence
- seq.sinceEdit(): Events after last file edit

Available action types:
- inject_before: Insert tool call BEFORE trigger
- inject_after: Insert tool call AFTER trigger
- block: Block the trigger tool
- replace: Replace trigger with different tool
- message: Just inject a message (weak, use for reminders)

Respond in JSON format only:
{
  "trigger": "tool_name or *",
  "condition": "expression using seq.X functions",
  "action": { "type": "...", ... }
}

Examples:
- "run lint before commit if files changed": { "trigger": "git_commit", "condition": "seq.hasAny(['edit_file', 'write_file']) && !seq.hasCommand('bash#lint')", "action": { "type": "inject_before", "tool": "bash", "args": { "command": "pnpm lint", "intent": "pre-commit lint", "timeout": 60 } } }
- "search wiki on errors": { "trigger": "*", "condition": "seq.lastError() && !seq.has('wiki_get')", "action": { "type": "inject_before", "tool": "wiki_get", "args": { "query": "error", "domain": "pitfall" } } }
- "block force push to main": { "trigger": "bash", "condition": "seq.last().args.command.includes('git push --force') && seq.last().args.command.includes('main')", "action": { "type": "block", "reason": "Force push to main is prohibited" } }

Only output the JSON, no explanation.`;

    try {
      const response = await retryChat({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }]
      });

      const content = response.message.content || '';
      
      // Extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }
      
      const parsed = JSON.parse(jsonMatch[0]);
      
      // Build condition with history
      const newVersion = (existing?.version || 0) + 1;
      const condition: Condition = {
        trigger: parsed.trigger || '*',
        when,
        condition: parsed.condition || 'true',
        action: parsed.action || { type: 'message' },
        version: newVersion,
        history: [
          ...(existing?.history || []),
          {
            version: newVersion,
            condition: parsed.condition || 'true',
            action: parsed.action || { type: 'message' },
            reason: existing ? 'refined via skill_compile' : 'initial compilation'
          }
        ]
      };
      
      // Store and persist
      this.set(skillName, condition);
      await this.save();
      
      return condition;
    } catch (err) {
      console.error(`[Conditions] Failed to compile: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Refine a condition based on user feedback
   */
  async refine(
    skillName: string,
    feedback: string,
    _seq: Sequence
  ): Promise<Condition> {
    const existing = this.conditions.get(skillName);
    if (!existing) {
      throw new Error(`Condition '${skillName}' not found`);
    }
    
    // Get skill content from loader (will be passed in)
    const skillContent = `Refining based on feedback: ${feedback}`;
    
    return this.compile(
      existing.when,
      skillName,
      skillContent,
      existing
    );
  }
}