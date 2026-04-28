/**
 * conditions.ts - Condition registry for hookish skills
 *
 * Manages compiled conditions from natural language "when" fields.
 * Conditions are lazy-compiled via skill_compile tool.
 *
 * Safety features:
 * - Pre-validation before persistence (via ConditionValidator)
 * - Atomic file writes (temp file + rename)
 * - Backup of existing conditions.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { getMyccDir } from '../config.js';
import { Sequence } from './sequence.js';
import { ollama, MODEL } from '../ollama.js';
import { 
  validateCondition,
  compileCondition,
  type ValidationResult 
} from './condition-validator.js';

/**
 * JSON schema for condition compilation response
 */
const CONDITION_SCHEMA = {
  type: 'object',
  properties: {
    trigger: { type: 'string', description: 'Tool name or * for any tool' },
    condition: { type: 'string', description: 'Expression using seq.X functions' },
    action: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['inject_before', 'inject_after', 'block', 'replace', 'message'] },
        tool: { type: 'string' },
        args: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['type'],
    },
  },
  required: ['trigger', 'condition', 'action'],
};

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
  trigger: string;      // Tool name or '*' for any, or 'stop' for no tool calls
  when: string;         // Original natural language
  condition: string;    // Compiled expression
  action: HookAction;
  version: number;
  sourceFile?: string;  // Source skill file path (relative to skills dir)
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
   * Validates all conditions before loading.
   * Removes orphaned conditions (source file no longer exists).
   */
  async load(): Promise<{ errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!fs.existsSync(this.filePath)) {
      return { errors, warnings };
    }

    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      errors.push(`Failed to read conditions.json: ${(err as Error).message}`);
      return { errors, warnings };
    }

    // Validate JSON syntax before parsing
    let data: ConditionsFile;
    try {
      data = JSON.parse(content);
    } catch (parseErr) {
      errors.push(`Invalid JSON in conditions.json: ${(parseErr as Error).message}. File backed up.`);
      // Backup corrupted file
      this.backupCorruptedFile();
      return { errors, warnings };
    }

    const orphanedConditions: string[] = [];
    const myccDir = getMyccDir();

    // Validate each condition using ConditionValidator
    for (const [name, cond] of Object.entries(data)) {
      const result = validateCondition(cond);
      
      if (!result.valid) {
        errors.push(`Condition '${name}' failed validation: ${result.errors.join('; ')}`);
        // Don't load invalid conditions
        continue;
      }
      
      // Check for orphaned conditions (source file no longer exists)
      if (cond.sourceFile) {
        const sourcePath = path.join(myccDir, cond.sourceFile);
        if (!fs.existsSync(sourcePath)) {
          orphanedConditions.push(name);
          warnings.push(`Condition '${name}' is orphaned (source file not found: ${cond.sourceFile})`);
          continue; // Don't load orphaned conditions
        }
      }
      
      // Add warnings
      for (const warn of result.warnings) {
        warnings.push(`Condition '${name}': ${warn}`);
      }
      
      // Apply runtime fixes (timeout clamping, etc.)
      this.applyRuntimeFixes(name, cond);
      
      // Load valid condition
      this.conditions.set(name, cond);
    }

    // Clean up orphaned conditions if any were found
    if (orphanedConditions.length > 0) {
      const saveResult = await this.save();
      if (!saveResult.success) {
        warnings.push(`Failed to remove orphaned conditions: ${saveResult.error}`);
      } else {
        warnings.push(`Removed ${orphanedConditions.length} orphaned condition(s): ${orphanedConditions.join(', ')}`);
      }
    }

    return { errors, warnings };
  }

  /**
   * Backup a corrupted conditions.json file
   */
  private backupCorruptedFile(): void {
    try {
      const backupPath = `${this.filePath}.corrupted.${Date.now()}`;
      fs.renameSync(this.filePath, backupPath);
      console.error(`[Conditions] Corrupted file backed up to: ${backupPath}`);
    } catch (err) {
      console.error(`[Conditions] Failed to backup corrupted file: ${(err as Error).message}`);
    }
  }

  /**
   * Apply runtime fixes to a condition (timeout clamping, defaults)
   */
  private applyRuntimeFixes(_name: string, cond: Condition): void {
    // Clamp timeout in action args (1-300 seconds)
    if (cond.action && 'args' in cond.action && cond.action.args) {
      const args = cond.action.args as Record<string, unknown>;
      if (typeof args.timeout === 'number') {
        if (args.timeout < 1 || args.timeout > 300) {
          args.timeout = Math.min(300, Math.max(1, args.timeout));
        }
      }
    }

    // Clamp timeout in history entries
    if (cond.history) {
      for (const entry of cond.history) {
        if (entry.action && 'args' in entry.action && entry.action.args) {
          const args = entry.action.args as Record<string, unknown>;
          if (typeof args.timeout === 'number') {
            if (args.timeout < 1 || args.timeout > 300) {
              args.timeout = Math.min(300, Math.max(1, args.timeout));
            }
          }
        }
      }
    }
  }



  /**
   * Save conditions to .mycc/conditions.json atomically.
   * Uses temp file + rename to prevent corruption.
   * Creates backup of existing file before overwriting.
   */
  async save(): Promise<{ success: boolean; error?: string }> {
    const data: ConditionsFile = {};
    
    for (const [name, cond] of this.conditions) {
      data[name] = cond;
    }
    
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Backup existing file if it exists
      if (fs.existsSync(this.filePath)) {
        const backupPath = `${this.filePath}.backup`;
        fs.copyFileSync(this.filePath, backupPath);
      }

      // Write to temp file in SAME directory (avoids cross-device rename issues)
      const tempFile = `${this.filePath}.tmp.${Date.now()}`;
      
      const content = JSON.stringify(data, null, 2);
      fs.writeFileSync(tempFile, content, 'utf-8');

      // Atomic rename (works within same filesystem)
      fs.renameSync(tempFile, this.filePath);

      return { success: true };
    } catch (err) {
      const errorMsg = (err as Error).message;
      console.error(`[Conditions] Failed to save conditions.json: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Rollback to backup file
   */
  rollback(): boolean {
    const backupPath = `${this.filePath}.backup`;
    if (!fs.existsSync(backupPath)) {
      console.error('[Conditions] No backup file to rollback to');
      return false;
    }

    try {
      fs.copyFileSync(backupPath, this.filePath);
      console.log('[Conditions] Rolled back to backup');
      return true;
    } catch (err) {
      console.error(`[Conditions] Rollback failed: ${(err as Error).message}`);
      return false;
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
   * This is called by the skill_compile tool.
   * 
   * Pipeline:
   * 1. Call Ollama with structured output (JSON schema)
   * 2. Validate schema and expression
   * 3. Smoke test the expression
   * 4. Only persist if all checks pass
   * 
   * @param when Natural language "when" expression
   * @param skillName Name of the skill
   * @param skillContent Content of the skill file
   * @param existing Existing condition (for refinement)
   * @param sourceFile Optional source file path (relative to .mycc dir)
   */
  async compile(
    when: string,
    skillName: string,
    skillContent: string,
    existing?: Condition,
    sourceFile?: string
  ): Promise<{ condition?: Condition; validation?: ValidationResult; error?: string }> {
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

Available call metadata (use call.metadata.X syntax for current call):
- call.metadata.filePath: Target file path (for file operations)
- call.metadata.isTestFile: Whether the file is a test file (.test. or .spec. in name)
- call.metadata.newLoc: Lines of code in the new content
- call.metadata.existingLoc: Lines of code in existing file
- call.metadata.isDestructive: Whether bash command is destructive
- call.args.X: Direct access to tool arguments (e.g., call.args.command)

Available action types:
- inject_before: Insert tool call BEFORE trigger (requires tool and args)
- inject_after: Insert tool call AFTER trigger (requires tool and args)
- block: Block the trigger tool (optional reason)
- replace: Replace trigger with different tool (requires tool and args)
- message: Just inject a message (weak, use for reminders)

Examples:
- "run lint before commit if files changed": { "trigger": "git_commit", "condition": "seq.hasAny(['edit_file', 'write_file']) && !seq.hasCommand('bash#lint')", "action": { "type": "inject_before", "tool": "bash", "args": { "command": "pnpm lint", "intent": "pre-commit lint", "timeout": 60 } } }
- "search wiki on errors": { "trigger": "*", "condition": "seq.lastError() && !seq.has('wiki_get')", "action": { "type": "inject_before", "tool": "wiki_get", "args": { "query": "error", "domain": "pitfall" } } }
- "block force push to main": { "trigger": "bash", "condition": "call.args.command.includes('git push --force') && call.args.command.includes('main')", "action": { "type": "block", "reason": "Force push to main is prohibited" } }
- "block test files over 300 lines": { "trigger": "write_file", "condition": "call.metadata.isTestFile && call.metadata.newLoc > 300", "action": { "type": "block", "reason": "Test files cannot exceed 300 lines" } }
- "block destructive bash to main": { "trigger": "bash", "condition": "call.metadata.isDestructive && call.args.command.includes('main')", "action": { "type": "block", "reason": "Destructive operations on main branch prohibited" } }

Output a JSON object with trigger, condition, and action.`;

    try {
      // Use Ollama with structured output (JSON schema enforcement)
      const response = await ollama.chat({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        format: CONDITION_SCHEMA,
        options: { temperature: 0 },
      });

      const content = response.message.content || '';
      
      // Use the validation pipeline
      const existingVersion = existing?.version || 0;
      const result = await compileCondition(content, when, skillName, existingVersion);
      
      if (!result.success || !result.condition) {
        return {
          validation: result.validation,
          error: result.error || 'Compilation failed',
        };
      }

      // Merge history if existing
      const condition = result.condition;
      if (existing?.history && existing.history.length > 0) {
        condition.history = [...existing.history, ...(condition.history || [])];
      }

      // Store source file path if provided
      if (sourceFile) {
        condition.sourceFile = sourceFile;
      }

      // Apply runtime fixes
      this.applyRuntimeFixes(skillName, condition);
      
      // Store in memory
      this.set(skillName, condition);
      
      // Persist atomically
      const saveResult = await this.save();
      if (!saveResult.success) {
        // Rollback memory state
        if (existing) {
          this.conditions.set(skillName, existing);
        } else {
          this.conditions.delete(skillName);
        }
        return {
          condition,
          validation: result.validation,
          error: `Failed to save: ${saveResult.error}`,
        };
      }
      
      return { 
        condition,
        validation: result.validation,
      };
    } catch (err) {
      const errorMsg = (err as Error).message;
      console.error(`[Conditions] Failed to compile: ${errorMsg}`);
      return { error: errorMsg };
    }
  }

  /**
   * Refine a condition based on user feedback
   */
  async refine(
    skillName: string,
    feedback: string,
    _seq: Sequence
  ): Promise<{ condition?: Condition; validation?: ValidationResult; error?: string }> {
    const existing = this.conditions.get(skillName);
    if (!existing) {
      return { error: `Condition '${skillName}' not found` };
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