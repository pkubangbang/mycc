/**
 * condition-validator.ts - Validation and testing for compiled conditions
 *
 * Provides rigorous validation gates to ensure compiled conditions are safe
 * before they are persisted to conditions.json.
 *
 * Validation Pipeline:
 * 1. Schema Validation - Check structure matches expected format
 * 2. Expression Validation - Verify condition expression syntax
 * 3. Test Evaluation - Run against mock sequence to verify execution
 * 4. Atomic Persistence - Only save after all checks pass
 */

import type { Condition, HookAction } from './conditions.js';
import jsep from 'jsep';
import { evaluateExpression } from './evaluator.js';
import { parseIntent, validateIntent } from '../context/grant/intent-parser.js';
import { extractSearchKey, matchesToolSpec, splitClauses } from './sequence.js';

/**
 * Minimal sequence interface for testing
 * Only includes methods needed for condition evaluation (new turn and session API)
 */
export interface TestableSequence {
  turnCount(tool?: string): number;
  turnLastIndex(tool: string): number;
  turnCountResult(tool: string, pattern: string, maxChars?: number): number;
  turnHadError(tool?: string): boolean;
  sessionCount(tool?: string): number;
  sessionLastIndex(tool: string): number;
  sessionCountResult(tool: string, pattern: string, maxChars?: number): number;
  sessionHadError(tool?: string): boolean;
  isPlanMode(): boolean;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Test result for condition evaluation
 */
export interface TestResult {
  passed: boolean;
  error?: string;
  evaluatedValue?: boolean;
}

/**
 * CompileResult - result of a complete compilation attempt
 */
export interface CompileResult {
  success: boolean;
  condition?: Condition;
  validation?: ValidationResult;
  test?: TestResult;
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const VALID_ACTION_TYPES = ['inject_before', 'inject_after', 'block', 'replace', 'message', 'compact'];

/**
 * Known function names (without the turn./session. prefix).
 * These are the 8 scoped functions + isPlanMode.
 * The validator checks that turn.X / session.X uses one of these names.
 */
const KNOWN_SCOPED_FUNCTIONS = new Set([
  'count', 'lastIndex', 'countResult', 'hadError',
]);

// Allowed literal values in expressions
const ALLOWED_LITERALS = ['true', 'false', 'null', 'undefined'];

// Allowed root identifiers (objects that can be accessed)
const ALLOWED_ROOTS = new Set(['turn', 'session', 'call', 'isPlanMode']);

// Dangerous identifiers that should never be allowed
const DANGEROUS_IDENTIFIERS = new Set([
  'eval', 'Function', 'require', 'import', 'process', 'fs', 'global',
  'window', 'document', 'globalThis', 'module', 'exports', '__proto__',
  'constructor', 'prototype', 'Reflect', 'Proxy', 'Buffer', 'Math',
  'JSON', 'console', 'alert', 'fetch', 'XMLHttpRequest', 'WebSocket',
]);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the root object name from a nested member expression
 */
function getRootObject(expr: jsep.MemberExpression | jsep.Expression): string | null {
  if (expr.type === 'Identifier') {
    return (expr as jsep.Identifier).name;
  } else if (expr.type === 'MemberExpression') {
    const memberExpr = expr as jsep.MemberExpression;
    if (memberExpr.object.type === 'Identifier') {
      return (memberExpr.object as jsep.Identifier).name;
    } else if (memberExpr.object.type === 'MemberExpression') {
      return getRootObject(memberExpr.object);
    }
  }
  return null;
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate an action object
 */
export function validateAction(action: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!action || typeof action !== 'object') {
    errors.push('action must be a non-null object');
    return { valid: false, errors, warnings };
  }

  const act = action as Record<string, unknown>;

  if (typeof act.type !== 'string') {
    errors.push('action.type must be a string');
    return { valid: false, errors, warnings };
  }

  if (!VALID_ACTION_TYPES.includes(act.type)) {
    errors.push(`action.type "${act.type}" is not valid. Must be one of: ${VALID_ACTION_TYPES.join(', ')}`);
    return { valid: false, errors, warnings };
  }

  switch (act.type) {
    case 'inject_before':
    case 'inject_after':
    case 'replace':
      if (typeof act.tool !== 'string' || act.tool === '') {
        errors.push(`action.tool must be a non-empty string for ${act.type}`);
      }
      if (!act.args || typeof act.args !== 'object') {
        errors.push(`action.args must be an object for ${act.type}`);
      } else {
        const args = act.args as Record<string, unknown>;
        if (args.timeout !== undefined) {
          if (typeof args.timeout !== 'number') {
            errors.push('action.args.timeout must be a number');
          } else if (args.timeout < 1 || args.timeout > 60) {
            warnings.push(`action.args.timeout ${args.timeout} will be clamped to 1-60 range`);
          }
        }
        // Validate bash tool intent format (bash requires intent language)
        if (act.tool === 'bash') {
          const intent = args.intent;
          if (typeof intent !== 'string' || intent.trim() === '') {
            errors.push('action.args.intent is required for bash tool and must follow intent language: VERB OBJECT TO PURPOSE');
          } else {
            const trimmed = intent.trim();
            const parsed = parseIntent(trimmed);
            const intentResult = validateIntent(parsed, trimmed);
            if (!intentResult.valid) {
              errors.push(`action.args.intent: ${intentResult.error}${intentResult.hint ? ` — ${intentResult.hint}` : ''}`);
            }
          }
        }
      }
      break;

    case 'block':
      if (act.reason !== undefined && typeof act.reason !== 'string') {
        errors.push('action.reason must be a string if provided');
      }
      break;
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate a condition's schema (structure only)
 */
export function validateSchema(condition: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!condition || typeof condition !== 'object') {
    errors.push('Condition must be a non-null object');
    return { valid: false, errors, warnings };
  }

  const cond = condition as Record<string, unknown>;

  if (!Array.isArray(cond.trigger) || cond.trigger.length === 0) {
    errors.push('trigger must be a non-empty array of strings');
  } else {
    for (const t of cond.trigger) {
      if (typeof t !== 'string') {
        errors.push('trigger array contains non-string value');
        break;
      }
      if (t === '') {
        warnings.push('trigger array contains empty string, will be ignored');
      }
    }
  }

  if (typeof cond.when !== 'string' || cond.when === '') {
    errors.push('when must be a non-empty string');
  }

  if (typeof cond.condition !== 'string') {
    errors.push('condition must be a string');
  } else if (cond.condition === '') {
    warnings.push('condition is empty, will always evaluate to false');
  }

  if (typeof cond.version !== 'number' || cond.version < 1) {
    errors.push('version must be a positive integer');
  }

  const actionResult = validateAction(cond.action);
  errors.push(...actionResult.errors);
  warnings.push(...actionResult.warnings);

  if (cond.history !== undefined) {
    if (!Array.isArray(cond.history)) {
      errors.push('history must be an array');
    } else {
      for (let i = 0; i < cond.history.length; i++) {
        const entry = cond.history[i];
        if (!entry || typeof entry !== 'object') {
          errors.push(`history[${i}] must be an object`);
          continue;
        }
        if (typeof entry.version !== 'number') {
          errors.push(`history[${i}].version must be a number`);
        }
        if (typeof entry.condition !== 'string') {
          errors.push(`history[${i}].condition must be a string`);
        }
        // History entries are immutable records of past versions;
        // do NOT validate their actions (old versions may not comply
        // with current validation rules, e.g., intent format requirements).
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate condition expression syntax using jsep AST parser
 * Checks for valid turn.X / session.X / isPlanMode() function calls and safe patterns
 */
export function validateExpression(expression: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!expression || expression.trim() === '') {
    return { valid: true, errors, warnings };
  }

  // Parse expression with jsep
  let ast: jsep.Expression;
  try {
    ast = jsep(expression);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Expression syntax error: ${msg}`);
    return { valid: false, errors, warnings };
  }

  // Walk the AST to validate all nodes
  const visitErrors = visitNode(ast, errors, warnings);
  errors.push(...visitErrors);

  // Check for === usage (functions return primitives)
  if (expression.includes('===')) {
    warnings.push('Using === in condition - functions return primitives, consider ==');
  }

  // Check for legacy seq.X usage
  if (/seq\./.test(expression)) {
    errors.push('Legacy "seq.X" syntax is no longer supported. Use "turn.X" or "session.X" instead.');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Recursively visit AST nodes to validate safety
 */
function visitNode(node: jsep.Expression, errors: string[], warnings: string[]): string[] {
  const newErrors: string[] = [];

  switch (node.type) {
    case 'Identifier': {
      const name = (node as jsep.Identifier).name;
      // Check for dangerous identifiers
      if (DANGEROUS_IDENTIFIERS.has(name)) {
        newErrors.push(`Forbidden identifier: ${name}`);
      }
      // Check for unknown identifiers (not literals or allowed roots)
      if (!ALLOWED_LITERALS.includes(name) && !ALLOWED_ROOTS.has(name)) {
        // Could be a variable reference outside turn/session/call context
        warnings.push(`Unknown identifier "${name}" - may not be defined`);
      }
      break;
    }

    case 'Literal': {
      // Literals (numbers, strings, booleans) are always safe
      break;
    }

    case 'CallExpression': {
      const callExpr = node as jsep.CallExpression;

      // Check if this is a turn.XXX() or session.XXX() call
      if (callExpr.callee.type === 'MemberExpression') {
        const memberExpr = callExpr.callee as jsep.MemberExpression;

        // Check for dangerous property first (e.g., obj.constructor())
        if (!memberExpr.computed && memberExpr.property.type === 'Identifier') {
          const propName = (memberExpr.property as jsep.Identifier).name;
          if (DANGEROUS_IDENTIFIERS.has(propName)) {
            newErrors.push(`Forbidden property access: ${propName}`);
          }
        }

        // Check if the object is 'turn' or 'session'
        if (memberExpr.object.type === 'Identifier') {
          const objName = (memberExpr.object as jsep.Identifier).name;

          if (objName === 'turn' || objName === 'session') {
            // Get the method name
            let methodName: string | undefined;
            if (memberExpr.property.type === 'Identifier') {
              methodName = (memberExpr.property as jsep.Identifier).name;
            }

            // Validate it's a known scoped function
            if (methodName && !KNOWN_SCOPED_FUNCTIONS.has(methodName)) {
              newErrors.push(`Unknown ${objName} method: ${objName}.${methodName}`);
            }
          } else if (objName === 'call') {
            // call.args.X.method() is allowed (e.g., call.args.command.includes())
            // call.metadata.X is a value, methods on it are allowed
            // No specific validation needed
          } else if (DANGEROUS_IDENTIFIERS.has(objName)) {
            // Reject dangerous objects
            newErrors.push(`Forbidden object: ${objName}`);
          } else {
            // Calling method on unknown object - check if it's a string method
            if (memberExpr.property.type === 'Identifier') {
              const methodName = (memberExpr.property as jsep.Identifier).name;
              // Allow common string/array methods
              const allowedMethods = ['includes', 'indexOf', 'startsWith', 'endsWith', 'slice', 'split', 'length', 'toString', 'trim', 'toLowerCase', 'toUpperCase', 'map', 'filter', 'some', 'every', 'find', 'push', 'join', 'pop', 'shift'];
              if (!allowedMethods.includes(methodName)) {
                warnings.push(`Method "${methodName}" on unknown object "${objName}" - may not be defined`);
              }
            }
          }
        } else if (memberExpr.object.type === 'MemberExpression') {
          // Chained call like call.args.command.includes()
          // Check if the root is 'call'
          const rootObj = getRootObject(memberExpr.object);
          if (rootObj && rootObj !== 'turn' && rootObj !== 'session' && rootObj !== 'call') {
            if (DANGEROUS_IDENTIFIERS.has(rootObj)) {
              newErrors.push(`Forbidden object: ${rootObj}`);
            }
          }
        }
      } else {
        // Direct function call (not turn.XXX() or session.XXX())
        if (callExpr.callee.type === 'Identifier') {
          const fnName = (callExpr.callee as jsep.Identifier).name;
          if (fnName === 'isPlanMode') {
            // isPlanMode() is the only allowed direct function call
          } else if (!ALLOWED_LITERALS.includes(fnName)) {
            newErrors.push(`Direct function call "${fnName}()" is not allowed - only turn.XXX(), session.XXX(), or isPlanMode() permitted`);
          }
        } else {
          newErrors.push('Only turn.XXX(), session.XXX(), or isPlanMode() calls are allowed');
        }
      }

      // Validate arguments
      for (const arg of callExpr.arguments || []) {
        newErrors.push(...visitNode(arg, errors, warnings));
      }
      break;
    }

    case 'MemberExpression': {
      const memberExpr = node as jsep.MemberExpression;

      // Check object being accessed
      newErrors.push(...visitNode(memberExpr.object, errors, warnings));

      // Check property (if computed, e.g., obj[expr])
      if (memberExpr.computed && memberExpr.property) {
        newErrors.push(...visitNode(memberExpr.property, errors, warnings));
      }

      // Check for dangerous property access
      if (!memberExpr.computed && memberExpr.property.type === 'Identifier') {
        const propName = (memberExpr.property as jsep.Identifier).name;
        if (DANGEROUS_IDENTIFIERS.has(propName)) {
          newErrors.push(`Forbidden property access: ${propName}`);
        }
      }

      // Check root object for dangerous identifiers
      const rootObj = getRootObject(memberExpr);
      if (rootObj && DANGEROUS_IDENTIFIERS.has(rootObj)) {
        newErrors.push(`Forbidden object: ${rootObj}`);
      }
      break;
    }

    case 'UnaryExpression': {
      const unaryExpr = node as jsep.UnaryExpression;
      newErrors.push(...visitNode(unaryExpr.argument, errors, warnings));
      break;
    }

    case 'BinaryExpression':
    case 'LogicalExpression': {
      const binaryExpr = node as jsep.BinaryExpression;
      newErrors.push(...visitNode(binaryExpr.left, errors, warnings));
      newErrors.push(...visitNode(binaryExpr.right, errors, warnings));
      break;
    }

    case 'ConditionalExpression': {
      const condExpr = node as jsep.ConditionalExpression;
      newErrors.push(...visitNode(condExpr.test, errors, warnings));
      newErrors.push(...visitNode(condExpr.consequent, errors, warnings));
      newErrors.push(...visitNode(condExpr.alternate, errors, warnings));
      break;
    }

    case 'ArrayExpression': {
      const arrayExpr = node as jsep.ArrayExpression;
      for (const elem of arrayExpr.elements || []) {
        if (elem) newErrors.push(...visitNode(elem, errors, warnings));
      }
      break;
    }

    case 'Compound': {
      // Compound expressions (separated by comma)
      const compound = node as jsep.Compound;
      for (const expr of compound.body || []) {
        newErrors.push(...visitNode(expr, errors, warnings));
      }
      break;
    }

    default: {
      // Unknown node type - be conservative
      warnings.push(`Unknown expression type: ${node.type}`);
    }
  }

  return newErrors;
}

/**
 * Validate a complete condition (schema + expression)
 */
export function validateCondition(condition: unknown): ValidationResult {
  const schemaResult = validateSchema(condition);
  const errors = [...schemaResult.errors];
  const warnings = [...schemaResult.warnings];

  if (schemaResult.valid) {
    const cond = condition as Condition;
    const exprResult = validateExpression(cond.condition);
    errors.push(...exprResult.errors);
    warnings.push(...exprResult.warnings);
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ============================================================================
// Testing Functions
// ============================================================================

/**
 * Test a condition expression against a sequence and optional call context
 * Uses jsep AST evaluator (evaluator.ts) for safe evaluation
 * without new Function(), preventing compiled-code memory leak.
 */
export function testExpression(
  expression: string,
  sequence: TestableSequence,
  callContext?: { metadata?: Record<string, unknown>; args?: Record<string, unknown> }
): TestResult {
  try {
    // Build EvalContext compatible with evaluator
    const ctx = {
      turnCount: (tool?: string) => sequence.turnCount(tool),
      turnLastIndex: (tool: string) => sequence.turnLastIndex(tool),
      turnCountResult: (tool: string, pattern: string, maxChars?: number) => sequence.turnCountResult(tool, pattern, maxChars),
      turnHadError: (tool?: string) => sequence.turnHadError(tool),
      sessionCount: (tool?: string) => sequence.sessionCount(tool),
      sessionLastIndex: (tool: string) => sequence.sessionLastIndex(tool),
      sessionCountResult: (tool: string, pattern: string, maxChars?: number) => sequence.sessionCountResult(tool, pattern, maxChars),
      sessionHadError: (tool?: string) => sequence.sessionHadError(tool),
      isPlanMode: () => sequence.isPlanMode(),
      call: callContext || {
        metadata: {
          filePath: '/mock/test.ts',
          newLoc: 100,
          existingLoc: 50,
          isDestructive: false,
        },
        args: {
          command: 'mock command',
          file_path: '/mock/test.ts',
          content: 'mock content',
        },
      },
    };

    const result = evaluateExpression(expression, ctx);
    return { passed: true, evaluatedValue: Boolean(result) };
  } catch (err) {
    return { passed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Quick smoke test - runs expression against empty mock sequence
 */
export function smokeTestExpression(expression: string): TestResult {
  const emptyMock: TestableSequence = {
    turnCount: () => 0,
    turnLastIndex: () => -1,
    turnCountResult: () => 0,
    turnHadError: () => false,
    sessionCount: () => 0,
    sessionLastIndex: () => -1,
    sessionCountResult: () => 0,
    sessionHadError: () => false,
    isPlanMode: () => false,
  };
  return testExpression(expression, emptyMock);
}

/**
 * Test a condition against multiple scenarios
 */
export function testScenarios(
  condition: Condition,
  scenarios: Array<{ name: string; sequence: TestableSequence }>
): Array<{ name: string; result: TestResult }> {
  return scenarios.map(({ name, sequence }) => ({
    name,
    result: testExpression(condition.condition, sequence),
  }));
}

// ============================================================================
// MockSequence - for testing
// ============================================================================

/**
 * MockSequence - a minimal sequence implementation for testing
 *
 * Mirrors Sequence's pattern-matching semantics so validation/testing and
 * runtime agree: tool#pattern uses matchesToolSpec() (three-class matching:
 * plain tool, skill_load#name, bash#commandPrefix with clause-splitting).
 */
export class MockSequence implements TestableSequence {
  private events: Array<{ tool: string; args: Record<string, unknown>; result: string }> = [];
  /** Session-level (never-reset) results log mirroring Sequence.sessionResultsLog */
  private sessionResultsLog: Array<{ tool: string; args: Record<string, unknown>; result: string }> = [];
  /** Session-level (never-reset) tally: tool name → count */
  private sessionTally: Map<string, number> = new Map();
  /** Session-level (never-reset) pattern log mirroring Sequence.sessionPatternLog */
  private sessionPatternLog: Array<{ tool: string; key: string }> = [];

  constructor(initialEvents: Array<{ tool: string; args: Record<string, unknown>; result: string }> = []) {
    for (const e of initialEvents) {
      this.addEventInternal(e.tool, e.args, e.result);
    }
  }

  // --- Turn-scoped ---

  turnCount(tool?: string): number {
    if (!tool) return this.events.length;
    return this.events.filter(e => matchesToolSpec(e, tool)).length;
  }

  turnLastIndex(tool: string): number {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (matchesToolSpec(this.events[i], tool)) return i;
    }
    return -1;
  }

  turnCountResult(tool: string, pattern: string, maxChars?: number): number {
    return this.events.filter(e => {
      if (tool !== '*' && !matchesToolSpec(e, tool)) return false;
      const searchText = maxChars ? e.result.slice(0, maxChars) : e.result;
      return searchText.includes(pattern);
    }).length;
  }

  turnHadError(tool?: string): boolean {
    return this.events.some(e => {
      if (tool && !matchesToolSpec(e, tool)) return false;
      const result = e.result?.toLowerCase() || '';
      return result.includes('error') || result.includes('failed');
    });
  }

  // --- Session-scoped ---

  sessionCount(tool?: string): number {
    if (!tool) return this.sessionResultsLog.length;
    if (tool.includes('#')) {
      const [toolName, pattern] = tool.split('#');
      return this.sessionPatternLog.filter(e => {
        if (e.tool !== toolName) return false;
        if (toolName === 'bash') {
          const clauses = splitClauses(e.key);
          return clauses.some(c => c.startsWith(pattern));
        }
        return e.key.includes(pattern);
      }).length;
    }
    return this.sessionTally.get(tool) || 0;
  }

  sessionLastIndex(tool: string): number {
    for (let i = this.sessionResultsLog.length - 1; i >= 0; i--) {
      if (matchesToolSpec(this.sessionResultsLog[i], tool)) return i;
    }
    return -1;
  }

  sessionCountResult(tool: string, pattern: string, maxChars?: number): number {
    return this.sessionResultsLog.filter(e => {
      if (tool !== '*' && !matchesToolSpec(e, tool)) return false;
      const searchText = maxChars ? e.result.slice(0, maxChars) : e.result;
      return searchText.includes(pattern);
    }).length;
  }

  sessionHadError(tool?: string): boolean {
    return this.sessionResultsLog.some(e => {
      if (tool && !matchesToolSpec(e, tool)) return false;
      const result = e.result?.toLowerCase() || '';
      return result.includes('error') || result.includes('failed');
    });
  }

  // --- Global ---

  isPlanMode(): boolean { return false; }

  // --- Utility ---

  addEvent(tool: string, args: Record<string, unknown> = {}, result = ''): void {
    this.addEventInternal(tool, args, result);
  }

  private addEventInternal(tool: string, args: Record<string, unknown>, result: string): void {
    const event = { tool, args, result };
    this.events.push(event);
    this.sessionResultsLog.push(event);
    this.sessionTally.set(tool, (this.sessionTally.get(tool) || 0) + 1);
    const key = extractSearchKey(event);
    if (key !== undefined) this.sessionPatternLog.push({ tool, key });
  }

  /**
   * Simulate turn boundary (clear turn-level events only)
   */
  markPromptBoundary(): void {
    this.events = [];
  }
}

/**
 * Factory function for creating mock sequences (backward-compatible)
 */
export function createMockSequence(
  events: Array<{ tool: string; args: Record<string, unknown>; result: string }> = []
): MockSequence {
  return new MockSequence(events);
}

/**
 * Alias for testExpression (backward-compatible)
 */
export const testCondition = testExpression;

/**
 * ConditionValidator namespace (backward-compatible API)
 */
export const ConditionValidator = {
  validate: validateCondition,
  validateSchema,
  validateExpression,
};

// ============================================================================
// Compilation Pipeline
// ============================================================================

/**
 * Compile condition from LLM response with validation gates
 */
export async function compileCondition(
  rawResponse: string,
  when: string,
  skillName: string,
  existingVersion: number = 0
): Promise<CompileResult> {
  // Step 1: Extract JSON from LLM response
  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { success: false, error: 'No JSON found in LLM response' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return { success: false, error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Step 2: Build condition object
  const pObj = parsed as Record<string, unknown>;
  const newVersion = existingVersion + 1;

  const condition: Condition = {
    trigger: Array.isArray(pObj.trigger) && pObj.trigger.length > 0 ? pObj.trigger : ['*'],
    when,
    condition: typeof pObj.condition === 'string' ? pObj.condition : 'true',
    action: (pObj.action as HookAction) || { type: 'message' },
    version: newVersion,
    history: [{
      version: newVersion,
      condition: typeof pObj.condition === 'string' ? pObj.condition : 'true',
      action: (pObj.action as HookAction) || { type: 'message' },
      reason: existingVersion > 0
        ? `refined via skill_compile for ${skillName}`
        : `initial compilation for ${skillName}`,
    }],
  };

  // Step 3: Validate schema and expression
  const validation = validateCondition(condition);
  if (!validation.valid) {
    return { success: false, condition, validation, error: `Validation failed: ${validation.errors.join('; ')}` };
  }

  // Step 4: Smoke test the expression
  const test = smokeTestExpression(condition.condition);
  if (!test.passed) {
    return { success: false, condition, validation, test, error: `Expression test failed: ${test.error}` };
  }

  return { success: true, condition, validation, test };
}