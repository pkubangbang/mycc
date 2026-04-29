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

/**
 * Minimal sequence interface for testing
 * Only includes methods needed for condition evaluation
 */
export interface TestableSequence {
  has(toolName: string): boolean;
  hasAny(tools: string[]): boolean;
  hasCommand(pattern: string): boolean;
  last(toolName?: string): unknown;
  lastError(): unknown;
  count(toolName?: string): number;
  since(toolName: string): unknown[];
  sinceEdit(): unknown[];
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

const VALID_ACTION_TYPES = ['inject_before', 'inject_after', 'block', 'replace', 'message'];

const SEQ_FUNCTIONS = ['has', 'hasAny', 'hasCommand', 'last', 'lastError', 'count', 'since', 'sinceEdit'];

// Allowed literal values in expressions
const ALLOWED_LITERALS = ['true', 'false', 'null', 'undefined'];

// Allowed root identifiers (besides seq)
const ALLOWED_ROOTS = ['seq', 'call', 'session'];

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
          } else if (args.timeout < 1 || args.timeout > 300) {
            warnings.push(`action.args.timeout ${args.timeout} will be clamped to 1-300 range`);
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

  if (typeof cond.trigger !== 'string') {
    errors.push('trigger must be a string');
  } else if (cond.trigger === '') {
    warnings.push('trigger is empty, will default to "*"');
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
        const entryActionResult = validateAction(entry.action);
        for (const err of entryActionResult.errors) {
          errors.push(`history[${i}].action: ${err}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate condition expression syntax using jsep AST parser
 * Checks for valid seq.X function calls and safe patterns
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

  // Check for === usage (seq functions return primitives)
  if (expression.includes('===')) {
    warnings.push('Using === in condition - seq functions return primitives, consider ==');
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
      if (!ALLOWED_LITERALS.includes(name) && !ALLOWED_ROOTS.includes(name)) {
        // Could be a variable reference outside seq/call context
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

      // Check if this is a seq.XXX() call
      if (callExpr.callee.type === 'MemberExpression') {
        const memberExpr = callExpr.callee as jsep.MemberExpression;

        // Check for dangerous property first (e.g., obj.constructor())
        if (!memberExpr.computed && memberExpr.property.type === 'Identifier') {
          const propName = (memberExpr.property as jsep.Identifier).name;
          if (DANGEROUS_IDENTIFIERS.has(propName)) {
            newErrors.push(`Forbidden property access: ${propName}`);
          }
        }

        // Check if the object is 'seq'
        if (memberExpr.object.type === 'Identifier') {
          const objName = (memberExpr.object as jsep.Identifier).name;

          if (objName === 'seq') {
            // Get the method name
            let methodName: string | undefined;
            if (memberExpr.property.type === 'Identifier') {
              methodName = (memberExpr.property as jsep.Identifier).name;
            }

            // Validate it's a known seq method
            if (methodName && !SEQ_FUNCTIONS.includes(methodName)) {
              newErrors.push(`Unknown seq method: seq.${methodName}`);
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
          if (rootObj && rootObj !== 'seq' && rootObj !== 'call') {
            if (DANGEROUS_IDENTIFIERS.has(rootObj)) {
              newErrors.push(`Forbidden object: ${rootObj}`);
            }
          }
        }
      } else {
        // Direct function call (not seq.XXX())
        if (callExpr.callee.type === 'Identifier') {
          const fnName = (callExpr.callee as jsep.Identifier).name;
          if (!ALLOWED_LITERALS.includes(fnName)) {
            newErrors.push(`Direct function call "${fnName}()" is not allowed - only seq.XXX() calls permitted`);
          }
        } else {
          newErrors.push('Only seq.XXX() function calls are allowed');
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
 */
export function testExpression(
  expression: string,
  sequence: TestableSequence,
  callContext?: { metadata?: Record<string, unknown>; args?: Record<string, unknown> },
  sessionContext?: { getMode: () => string }
): TestResult {
  try {
    const seqCtx = {
      has: (tool: string) => sequence.has(tool),
      hasAny: (tools: string[]) => sequence.hasAny(tools),
      hasCommand: (pattern: string) => sequence.hasCommand(pattern),
      last: (tool?: string) => sequence.last(tool),
      lastError: () => sequence.lastError(),
      count: (tool?: string) => sequence.count(tool),
      since: (tool: string) => sequence.since(tool),
      sinceEdit: () => sequence.sinceEdit(),
    };

    // Provide mock call context for call.metadata.X and call.args.X
    const call = callContext || {
      metadata: {
        filePath: '/mock/test.ts',
        isTestFile: true,
        newLoc: 100,
        existingLoc: 50,
        isDestructive: false,
      },
      args: {
        command: 'mock command',
        file_path: '/mock/test.ts',
        content: 'mock content',
      },
    };

    // Provide mock session context for session.getMode()
    const session = sessionContext || {
      getMode: () => 'normal',
    };

    const jsExpr = expression
      .replace(/seq\.has\(/g, 'has(')
      .replace(/seq\.hasAny\(/g, 'hasAny(')
      .replace(/seq\.hasCommand\(/g, 'hasCommand(')
      .replace(/seq\.last\(/g, 'last(')
      .replace(/seq\.lastError\(/g, 'lastError(')
      .replace(/seq\.count\(/g, 'count(')
      .replace(/seq\.since\(/g, 'since(')
      .replace(/seq\.sinceEdit\(/g, 'sinceEdit(')
      .replace(/call\.metadata\./g, 'call.metadata.')
      .replace(/call\.args\./g, 'call.args.')
      .replace(/call\.args\b/g, 'call.args')
      .replace(/session\.getMode\(\)/g, 'session.getMode()');

    const fn = new Function(
      'has', 'hasAny', 'hasCommand', 'last', 'lastError', 'count', 'since', 'sinceEdit', 'call', 'session',
      `"use strict"; return (${jsExpr});`
    );

    const result = fn(
      seqCtx.has, seqCtx.hasAny, seqCtx.hasCommand, seqCtx.last, seqCtx.lastError,
      seqCtx.count, seqCtx.since, seqCtx.sinceEdit, call, session
    );

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
    has: () => false,
    hasAny: () => false,
    hasCommand: () => false,
    last: () => undefined,
    lastError: () => undefined,
    count: () => 0,
    since: () => [],
    sinceEdit: () => [],
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
 */
export class MockSequence {
  private events: Array<{ tool: string; args: Record<string, unknown>; result: string }> = [];

  constructor(initialEvents: Array<{ tool: string; args: Record<string, unknown>; result: string }> = []) {
    this.events = initialEvents;
  }

  has(toolName: string): boolean { return this.events.some(e => e.tool === toolName); }
  hasAny(tools: string[]): boolean { return tools.some(t => this.has(t)); }
  
  hasCommand(pattern: string): boolean {
    if (pattern.includes('#')) {
      const [tool, cmdPattern] = pattern.split('#');
      return this.events.some(e => e.tool === tool && typeof e.args?.command === 'string' && e.args.command.includes(cmdPattern));
    }
    return this.has(pattern);
  }
  
  last(): unknown { return this.events.length === 0 ? undefined : this.events[this.events.length - 1]; }
  lastError(): undefined { return undefined; }
  count(toolName?: string): number { return toolName ? this.events.filter(e => e.tool === toolName).length : this.events.length; }
  since(): unknown[] { return []; }
  sinceEdit(): unknown[] { return []; }
  
  addEvent(tool: string, args: Record<string, unknown> = {}, result = ''): void {
    this.events.push({ tool, args, result });
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
    trigger: typeof pObj.trigger === 'string' ? pObj.trigger : '*',
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