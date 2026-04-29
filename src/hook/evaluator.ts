/**
 * evaluator.ts - AST-based expression evaluation using jsep
 *
 * Safely evaluates expressions without using Function constructor.
 * Parses expression to AST with jsep, then walks the tree.
 */

import jsep from 'jsep';

/**
 * Context for expression evaluation
 */
export interface EvalContext {
  has: (tool: string) => boolean;
  hasAny: (tools: string[]) => boolean;
  hasCommand: (pattern: string) => boolean;
  last: (tool?: string) => unknown;
  lastError: () => unknown;
  count: (tool?: string) => number;
  since: (tool: string) => unknown[];
  sinceEdit: () => unknown[];
}

/**
 * Evaluate a jsep AST node against a context
 */
function evaluateNode(node: jsep.Expression, ctx: EvalContext): unknown {
  switch (node.type) {
    case 'Literal':
      return (node as jsep.Literal).value;

    case 'Identifier': {
      const name = (node as jsep.Identifier).name;
      // Handle special identifiers
      if (name === 'undefined') {
        return undefined;
      }
      if (name === 'null') {
        return null;
      }
      if (name === 'true') {
        return true;
      }
      if (name === 'false') {
        return false;
      }
      if (name in ctx) {
        return ctx[name as keyof EvalContext];
      }
      throw new Error(`Unknown identifier: ${name}`);
    }

    case 'ArrayExpression': {
      const arrNode = node as jsep.ArrayExpression;
      return arrNode.elements
        .filter((el): el is jsep.Expression => el !== null)
        .map(el => evaluateNode(el, ctx));
    }

    case 'CallExpression': {
      const callNode = node as jsep.CallExpression;
      const callee = callNode.callee;

      // Evaluate arguments first
      const args = callNode.arguments.map(arg => evaluateNode(arg, ctx));

      // Case 1: Direct function call like has('tool')
      if (callee.type === 'Identifier') {
        const fnName = (callee as jsep.Identifier).name;
        if (!(fnName in ctx)) {
          throw new Error(`Unknown function: ${fnName}`);
        }
        const fn = ctx[fnName as keyof EvalContext] as (...args: unknown[]) => unknown;
        return fn(...args);
      }

      // Case 2: Method call like obj.method() or str.includes()
      if (callee.type === 'MemberExpression') {
        const member = callee as jsep.MemberExpression;
        
        // Check if this is seq.X (object is 'seq' identifier)
        if (member.object.type === 'Identifier' && 
            (member.object as jsep.Identifier).name === 'seq') {
          // This is seq.X() - treat as direct context call
          if (member.property.type !== 'Identifier') {
            throw new Error('Dynamic seq property not supported');
          }
          const fnName = (member.property as jsep.Identifier).name;
          if (!(fnName in ctx)) {
            throw new Error(`Unknown seq function: ${fnName}`);
          }
          const fn = ctx[fnName as keyof EvalContext] as (...args: unknown[]) => unknown;
          return fn(...args);
        }

        // Regular method call on an object/array/string
        const obj = evaluateNode(member.object, ctx);
        
        if (obj === null || obj === undefined) {
          throw new Error(`Cannot call method on ${obj}`);
        }

        // Get method name
        let methodName: string;
        if (member.property.type === 'Identifier') {
          methodName = (member.property as jsep.Identifier).name;
        } else if (member.property.type === 'Literal') {
          methodName = String((member.property as jsep.Literal).value);
        } else {
          methodName = String(evaluateNode(member.property, ctx));
        }

        // Handle common methods
        if (typeof obj === 'string') {
          if (methodName === 'includes') {
            return obj.includes(args[0] as string);
          }
          if (methodName === 'startsWith') {
            return obj.startsWith(args[0] as string);
          }
          if (methodName === 'endsWith') {
            return obj.endsWith(args[0] as string);
          }
          if (methodName === 'indexOf') {
            return obj.indexOf(args[0] as string);
          }
          throw new Error(`Unknown string method: ${methodName}`);
        }

        if (Array.isArray(obj)) {
          if (methodName === 'includes') {
            return obj.includes(args[0]);
          }
          if (methodName === 'indexOf') {
            return obj.indexOf(args[0]);
          }
          if (methodName === 'length') {
            return obj.length;
          }
          throw new Error(`Unknown array method: ${methodName}`);
        }

        // For objects, try to call the method
        if (typeof obj === 'object') {
          const method = (obj as Record<string, unknown>)[methodName];
          if (typeof method === 'function') {
            return method.apply(obj, args);
          }
          // It might be a property, not a method
          return method;
        }

        throw new Error(`Cannot call method on ${typeof obj}`);
      }

      throw new Error(`Unsupported callee type: ${callee.type}`);
    }

    case 'MemberExpression': {
      const member = node as jsep.MemberExpression;
      const obj = evaluateNode(member.object, ctx);

      let prop: string | number;
      if (member.property.type === 'Identifier') {
        prop = (member.property as jsep.Identifier).name;
      } else if (member.property.type === 'Literal') {
        prop = (member.property as jsep.Literal).value as string | number;
      } else {
        prop = evaluateNode(member.property, ctx) as string | number;
      }

      if (obj === null || obj === undefined) {
        throw new Error(`Cannot access property '${prop}' of ${obj}`);
      }

      if (typeof obj === 'object') {
        return (obj as Record<string, unknown>)[prop];
      }
      throw new Error(`Cannot access property on non-object`);
    }

    case 'UnaryExpression': {
      const unary = node as jsep.UnaryExpression;
      const arg = evaluateNode(unary.argument, ctx);

      switch (unary.operator) {
        case '!': return !arg;
        case '-': return -(arg as number);
        case '+': return +(arg as number);
        case '~': return ~(arg as number);
        default:
          throw new Error(`Unknown unary operator: ${unary.operator}`);
      }
    }

    case 'BinaryExpression': {
      const binary = node as jsep.BinaryExpression;
      const left = evaluateNode(binary.left, ctx);
      const right = evaluateNode(binary.right, ctx);

      // For numeric operations, cast to number
      const leftNum = left as number;
      const rightNum = right as number;

      switch (binary.operator) {
        // Loose equality (for DSL flexibility with null/undefined)
        case '==': {
          // eslint-disable-next-line eqeqeq
          return left == right;
        }
        case '===': return left === right;
        case '!=': {
          // eslint-disable-next-line eqeqeq
          return left != right;
        }
        case '!==': return left !== right;
        case '<': return leftNum < rightNum;
        case '<=': return leftNum <= rightNum;
        case '>': return leftNum > rightNum;
        case '>=': return leftNum >= rightNum;
        case '+': return leftNum + rightNum;
        case '-': return leftNum - rightNum;
        case '*': return leftNum * rightNum;
        case '/': return leftNum / rightNum;
        case '%': return leftNum % rightNum;
        case '&&': return left && right;
        case '||': return left || right;
        default:
          throw new Error(`Unknown binary operator: ${binary.operator}`);
      }
    }

    case 'ConditionalExpression': {
      const conditional = node as jsep.ConditionalExpression;
      const test = evaluateNode(conditional.test, ctx);
      return test
        ? evaluateNode(conditional.consequent, ctx)
        : evaluateNode(conditional.alternate, ctx);
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
      .replace(/seq\.hasCommand\(/g, 'hasCommand(')
      .replace(/seq\.last\(/g, 'last(')
      .replace(/seq\.lastError\(/g, 'lastError(')
      .replace(/seq\.count\(/g, 'count(')
      .replace(/seq\.since\(/g, 'since(')
      .replace(/seq\.sinceEdit\(/g, 'sinceEdit(');

    // Parse to AST
    const ast = jsep(jsExpr);

    // Evaluate the AST
    const result = evaluateNode(ast, ctx);

    // Coerce to boolean
    return Boolean(result);
  } catch (err) {
    console.error(`[Evaluator] Failed to evaluate: ${expression}`, err);
    return false;
  }
}