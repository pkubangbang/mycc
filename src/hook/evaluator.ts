/**
 * evaluator.ts - AST-based expression evaluation using jsep
 *
 * Safely evaluates expressions without using Function constructor.
 * Parses expression to AST with jsep, then walks the tree.
 */

import jsep from 'jsep';

const DEBUG = process.env.DEBUG_EVALUATOR === '1' || process.env.DEBUG_EVALUATOR === 'true';

/**
 * Call context for expression evaluation (optional, only available during actual tool call)
 */
export interface CallContext {
  metadata?: {
    filePath?: string;
    newLoc?: number;
    existingLoc?: number;
    isDestructive?: boolean;
    [key: string]: unknown;
  };
  args?: Record<string, unknown>;
}

/**
 * Context for expression evaluation
 */
export interface EvalContext {
  has: (tool: string) => boolean;
  hasAny: (tools: string[]) => boolean;
  lastIndexOf: (pattern: string) => number;
  last: (tool?: string) => unknown;
  lastError: () => unknown;
  count: (tool?: string) => number;
  totalCount: (tool?: string) => number;
  countResult: (tool: string, pattern: string, maxChars?: number) => number;
  since: (tool: string) => unknown[];
  sinceEdit: () => unknown[];
  isPlanMode: () => boolean;
  call?: CallContext;  // Optional call context
}

/**
 * Produce a human-readable summary of a jsep AST node for debug logging.
 */
function nodeSummary(node: jsep.Expression): string {
  switch (node.type) {
    case 'Literal':
      return JSON.stringify((node as jsep.Literal).value);
    case 'Identifier':
      return (node as jsep.Identifier).name;
    case 'BinaryExpression': {
      const bin = node as jsep.BinaryExpression;
      return `${nodeSummary(bin.left)} ${bin.operator} ${nodeSummary(bin.right)}`;
    }
    case 'UnaryExpression': {
      const un = node as jsep.UnaryExpression;
      return `${un.operator}${nodeSummary(un.argument)}`;
    }
    case 'CallExpression': {
      const call = node as jsep.CallExpression;
      const calleeStr = nodeSummary(call.callee);
      const argCount = call.arguments.length;
      return `${calleeStr}(${argCount} arg${argCount !== 1 ? 's' : ''})`;
    }
    case 'MemberExpression': {
      const mem = node as jsep.MemberExpression;
      return `${nodeSummary(mem.object)}.${nodeSummary(mem.property)}`;
    }
    case 'ConditionalExpression': {
      const cond = node as jsep.ConditionalExpression;
      return `${nodeSummary(cond.test)} ? ${nodeSummary(cond.consequent)} : ${nodeSummary(cond.alternate)}`;
    }
    case 'ArrayExpression': {
      const arr = node as jsep.ArrayExpression;
      return `[${arr.elements.length} element${arr.elements.length !== 1 ? 's' : ''}]`;
    }
    default:
      return node.type;
  }
}

/**
 * Evaluate a jsep AST node against a context.
 * Produces compact debug output when DEBUG_EVALUATOR is set.
 *
 * Output format:
 *   [eval] <nodeSummary> => <result>
 */
function evaluateNode(node: jsep.Expression, ctx: EvalContext, originalExpr: string): unknown {
  const result = evaluateNodeImpl(node, ctx, 0, `expr: ${originalExpr}`);
  if (DEBUG) {
    console.log(`[eval] ${nodeSummary(node)} => ${JSON.stringify(result)}`);
  }
  return result;
}

/**
 * Evaluate a jsep AST node against a context (inner implementation).
 * @param depth - nesting level for debug indentation
 * @param label - debug label prefix for this node (e.g. "expr:", "LHS:")
 */
function evaluateNodeImpl(node: jsep.Expression, ctx: EvalContext, depth: number, label: string): unknown {
  // Debug logging is handled at the top level in evaluateNode — no per-node logging needed.
  const dlog = () => {};

  switch (node.type) {
    case 'Literal': {
      const val = (node as jsep.Literal).value;
      dlog(`- ${label} => ${JSON.stringify(val)}`);
      return val;
    }

    case 'Identifier': {
      const name = (node as jsep.Identifier).name;
      let result: unknown;
      if (name === 'undefined') {
        result = undefined;
      } else if (name === 'null') {
        result = null;
      } else if (name === 'true') {
        result = true;
      } else if (name === 'false') {
        result = false;
      } else if (name === 'call') {
        if (ctx.call) {
          result = ctx.call;
        } else {
          result = {
            metadata: {
              filePath: '',
              newLoc: 0,
              existingLoc: 0,
              isDestructive: false,
            },
            args: {},
          };
        }
      } else if (name in ctx) {
        result = ctx[name as keyof EvalContext];
      } else {
        throw new Error(`Unknown identifier: ${name}`);
      }
      dlog(`- ${label} => ${JSON.stringify(result)}`);
      return result;
    }

    case 'ArrayExpression': {
      const arrNode = node as jsep.ArrayExpression;
      dlog(`- ${label}`);
      const elements = arrNode.elements.filter((el): el is jsep.Expression => el !== null);
      const arr: unknown[] = [];
      for (let i = 0; i < elements.length; i++) {
        arr.push(evaluateNodeImpl(elements[i], ctx, depth + 1, `[${i}]:`));
      }
      return arr;
    }

    case 'CallExpression': {
      const callNode = node as jsep.CallExpression;
      const callee = callNode.callee;
      dlog(`- ${label} ${nodeSummary(callNode)}`);

      // Evaluate arguments
      const args = callNode.arguments.map((arg, i) =>
        evaluateNodeImpl(arg, ctx, depth + 1, `arg[${i}]:`));

      let result: unknown;

      // Case 1: Direct function call like has('tool')
      if (callee.type === 'Identifier') {
        const fnName = (callee as jsep.Identifier).name;
        if (!(fnName in ctx)) {
          throw new Error(`Unknown function: ${fnName}`);
        }
        const fn = ctx[fnName as keyof EvalContext] as (...a: unknown[]) => unknown;
        result = fn(...args);
        dlog(`  => ${JSON.stringify(result)}`);
        return result;
      }

      // Case 2: Method call like obj.method() or str.includes()
      if (callee.type === 'MemberExpression') {
        const member = callee as jsep.MemberExpression;

        if (member.object.type === 'Identifier' &&
            (member.object as jsep.Identifier).name === 'seq') {
          if (member.property.type !== 'Identifier') {
            throw new Error('Dynamic seq property not supported');
          }
          const fnName = (member.property as jsep.Identifier).name;
          if (!(fnName in ctx)) {
            throw new Error(`Unknown seq function: ${fnName}`);
          }
          const fn = ctx[fnName as keyof EvalContext] as (...a: unknown[]) => unknown;
          result = fn(...args);
          dlog(`  => ${JSON.stringify(result)}`);
          return result;
        }

        // Regular method call on an object/array/string
        const obj = evaluateNodeImpl(member.object, ctx, depth + 1, 'obj:');

        if (obj === null || obj === undefined) {
          throw new Error(`Cannot call method on ${obj}`);
        }

        let methodName: string;
        if (member.property.type === 'Identifier') {
          methodName = (member.property as jsep.Identifier).name;
        } else if (member.property.type === 'Literal') {
          methodName = String((member.property as jsep.Literal).value);
        } else {
          methodName = String(evaluateNodeImpl(member.property, ctx, depth + 1, 'prop:'));
        }

        if (typeof obj === 'string') {
          if (methodName === 'includes') result = obj.includes(args[0] as string);
          else if (methodName === 'startsWith') result = obj.startsWith(args[0] as string);
          else if (methodName === 'endsWith') result = obj.endsWith(args[0] as string);
          else if (methodName === 'indexOf') result = obj.indexOf(args[0] as string);
          else throw new Error(`Unknown string method: ${methodName}`);
        } else if (Array.isArray(obj)) {
          if (methodName === 'includes') result = obj.includes(args[0]);
          else if (methodName === 'indexOf') result = obj.indexOf(args[0]);
          else if (methodName === 'length') result = obj.length;
          else throw new Error(`Unknown array method: ${methodName}`);
        } else if (typeof obj === 'object') {
          const method = (obj as Record<string, unknown>)[methodName];
          if (typeof method === 'function') result = method.apply(obj, args);
          else result = method;
        } else {
          throw new Error(`Cannot call method on ${typeof obj}`);
        }

        dlog(`  => ${JSON.stringify(result)}`);
        return result;
      }

      throw new Error(`Unsupported callee type: ${callee.type}`);
    }

    case 'MemberExpression': {
      const member = node as jsep.MemberExpression;
      dlog(`- ${label}`);
      const obj = evaluateNodeImpl(member.object, ctx, depth + 1, 'obj:');

      let prop: string | number;
      if (member.property.type === 'Identifier') {
        prop = (member.property as jsep.Identifier).name;
      } else if (member.property.type === 'Literal') {
        prop = (member.property as jsep.Literal).value as string | number;
      } else {
        prop = evaluateNodeImpl(member.property, ctx, depth + 1, 'prop:') as string | number;
      }

      if (obj === null || obj === undefined) {
        throw new Error(`Cannot access property '${prop}' of ${obj}`);
      }

      if (typeof obj === 'object') {
        const result = (obj as Record<string, unknown>)[prop];
        dlog(`  .${prop} => ${JSON.stringify(result)}`);
        return result;
      }
      throw new Error(`Cannot access property on non-object`);
    }

    case 'UnaryExpression': {
      const unary = node as jsep.UnaryExpression;
      dlog(`- ${label} (${unary.operator})`);
      const arg = evaluateNodeImpl(unary.argument, ctx, depth + 1, 'arg:');

      let result: unknown;
      switch (unary.operator) {
        case '!': result = !arg; break;
        case '-': result = -(arg as number); break;
        case '+': result = +(arg as number); break;
        case '~': result = ~(arg as number); break;
        default:
          throw new Error(`Unknown unary operator: ${unary.operator}`);
      }
      dlog(`  => ${JSON.stringify(result)}`);
      return result;
    }

    case 'BinaryExpression': {
      const binary = node as jsep.BinaryExpression;
      const { operator } = binary;
      dlog(`- ${label}`);
      dlog(`  - operator: ${operator}`);

      // Evaluate LHS
      const left = evaluateNodeImpl(binary.left, ctx, depth + 1, 'LHS:');

      // Short-circuit for && and ||
      let shortCircuited = false;
      if (operator === '&&' && !left) {
        shortCircuited = true;
      } else if (operator === '||' && left) {
        shortCircuited = true;
      }

      if (shortCircuited) {
        dlog(`  - RHS: skipped`);
        const result = operator === '&&' ? false : true;
        dlog(`  => ${JSON.stringify(result)}`);
        return result;
      }

      // Evaluate RHS
      const right = evaluateNodeImpl(binary.right, ctx, depth + 1, 'RHS:');

      const leftNum = left as number;
      const rightNum = right as number;

      let result: unknown;
      switch (operator) {
        case '==': result = left == right; break; // eslint-disable-line eqeqeq
        case '===': result = left === right; break;
        case '!=': result = left != right; break; // eslint-disable-line eqeqeq
        case '!==': result = left !== right; break;
        case '<': result = leftNum < rightNum; break;
        case '<=': result = leftNum <= rightNum; break;
        case '>': result = leftNum > rightNum; break;
        case '>=': result = leftNum >= rightNum; break;
        case '+': result = leftNum + rightNum; break;
        case '-': result = leftNum - rightNum; break;
        case '*': result = leftNum * rightNum; break;
        case '/': result = leftNum / rightNum; break;
        case '%': result = leftNum % rightNum; break;
        case '&&': result = left && right; break;
        case '||': result = left || right; break;
        default:
          throw new Error(`Unknown binary operator: ${operator}`);
      }
      dlog(`  => ${JSON.stringify(result)}`);
      return result;
    }

    case 'ConditionalExpression': {
      const conditional = node as jsep.ConditionalExpression;
      dlog(`- ${label}`);
      const test = evaluateNodeImpl(conditional.test, ctx, depth + 1, 'test:');
      dlog(`  => ${test ? 'consequent' : 'alternate'}`);
      const result = test
        ? evaluateNodeImpl(conditional.consequent, ctx, depth + 1, 'consequent:')
        : evaluateNodeImpl(conditional.alternate, ctx, depth + 1, 'alternate:');
      return result;
    }

    default:
      throw new Error(`Unsupported node type: ${node.type}`);
  }
}

/**
 * Evaluate an expression string using jsep AST
 * Replaces seq.X calls with direct function calls
 */
export function evaluateExpression(expression: string, ctx: EvalContext): boolean {
  try {
    // Preprocess: replace seq.X with X (jsep doesn't understand seq object)
    const jsExpr = expression
      .replace(/seq\.has\(/g, 'has(')
      .replace(/seq\.hasAny\(/g, 'hasAny(')
      .replace(/seq\.lastIndexOf\(/g, 'lastIndexOf(')
      .replace(/seq\.last\(/g, 'last(')
      .replace(/seq\.lastError\(/g, 'lastError(')
      .replace(/seq\.totalCount\(/g, 'totalCount(')
      .replace(/seq\.count\(/g, 'count(')
      .replace(/seq\.countResult\(/g, 'countResult(')
      .replace(/seq\.since\(/g, 'since(')
      .replace(/seq\.sinceEdit\(/g, 'sinceEdit(')
      .replace(/seq\.isPlanMode\(/g, 'isPlanMode(');

    // Parse to AST
    const ast = jsep(jsExpr);

    // Evaluate the AST
    const result = evaluateNode(ast, ctx, expression);

    // Coerce to boolean
    return Boolean(result);
  } catch (err) {
    console.error(`[Evaluator] Failed to evaluate: ${expression}`, err);
    return false;
  }
}
