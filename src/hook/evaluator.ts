/**
 * evaluator.ts - AST-based expression evaluation using jsep
 *
 * Safely evaluates expressions without using Function constructor.
 * Parses expression to AST with jsep, then walks the tree.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import jsep from 'jsep';
import { type JsepEvaluatedNode, printJsepExpr, printJsepTree } from '../utils/jsep-expr-print';
import { agentIO } from '../loop/agent-io';
import { isDebuggingEval } from '../config.js';

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
  call?: CallContext;
}

/**
 * Build a JsepEvaluatedNode from an AST node and its evaluated value.
 * Generates the expression string from the AST and wraps the value.
 */
function makeEvaluatedNode(node: jsep.Expression, value: any): JsepEvaluatedNode {
  const expr = printJsepExpr(node);
  return Object.assign({}, node, { expr, value }) as JsepEvaluatedNode;
}

/**
 * Evaluate a jsep AST node against a context.
 * Returns a JsepEvaluatedNode with both the AST structure and the evaluated value.
 */
function evaluateNode(node: jsep.Expression, ctx: EvalContext): JsepEvaluatedNode {
  switch (node.type) {
    case 'Literal': {
      const value = (node as jsep.Literal).value;
      return makeEvaluatedNode(node, value);
    }

    case 'Identifier': {
      const name = (node as jsep.Identifier).name;
      let value: unknown;
      if (name === 'undefined') value = undefined;
      else if (name === 'null') value = null;
      else if (name === 'true') value = true;
      else if (name === 'false') value = false;
      else if (name === 'call') {
        value = ctx.call ?? {
          metadata: { filePath: '', newLoc: 0, existingLoc: 0, isDestructive: false },
          args: {},
        };
      }
      else if (name in ctx) {
        value = ctx[name as keyof EvalContext];
      }
      else {
        throw new Error(`Unknown identifier: ${name}`);
      }
      return makeEvaluatedNode(node, value);
    }

    case 'ArrayExpression': {
      const arrNode = node as jsep.ArrayExpression;
      const elements = arrNode.elements.filter((el): el is jsep.Expression => el !== null);
      const evaluatedElements = elements.map(el => evaluateNode(el, ctx));
      const value = evaluatedElements.map(e => e.value);
      const result = makeEvaluatedNode(node, value);
      // stitch evaluated children into the result for tree printing
      (result as any).elements = arrNode.elements.map(el =>
        el === null ? null : evaluatedElements.shift()!
      );
      return result;
    }

    case 'CallExpression': {
      const callNode = node as jsep.CallExpression;
      const callee = callNode.callee;
      const evaluatedArgs = callNode.arguments.map(arg => evaluateNode(arg, ctx));
      const args = evaluatedArgs.map(a => a.value);

      // Case 1: Direct function call like has('tool')
      if (callee.type === 'Identifier') {
        const idName = (callee as jsep.Identifier).name;
        if (!(idName in ctx)) {
          throw new Error(`Unknown function: ${idName}`);
        }
        const fn = ctx[idName as keyof EvalContext] as (...a: unknown[]) => unknown;
        const result = makeEvaluatedNode(node, fn(...args));
        // stitch evaluated args for tree printing (callee is Identifier, no children)
        (result as any).arguments = evaluatedArgs;
        return result;
      }

      // Case 2: Method call like obj.method() or str.includes()
      if (callee.type === 'MemberExpression') {
        const member = callee as jsep.MemberExpression;

        // seq.XXX() calls
        if (member.object.type === 'Identifier' &&
            (member.object as jsep.Identifier).name === 'seq') {
          if (member.property.type !== 'Identifier') {
            throw new Error('Dynamic seq property not supported');
          }
          const mName = (member.property as jsep.Identifier).name;
          if (!(mName in ctx)) {
            throw new Error(`Unknown seq function: ${mName}`);
          }
          const fn = ctx[mName as keyof EvalContext] as (...a: unknown[]) => unknown;
          const result = makeEvaluatedNode(node, fn(...args));
          (result as any).arguments = evaluatedArgs;
          return result;
        }

        // Regular method call on an object/array/string
        const objEval = evaluateNode(member.object, ctx);
        const obj = objEval.value;

        if (obj === null || obj === undefined) {
          throw new Error(`Cannot call method on ${obj}`);
        }

        let methodName: string;
        let propEval: JsepEvaluatedNode | null = null;
        if (member.property.type === 'Identifier') {
          methodName = (member.property as jsep.Identifier).name;
        } else if (member.property.type === 'Literal') {
          methodName = String((member.property as jsep.Literal).value);
        } else {
          propEval = evaluateNode(member.property, ctx);
          methodName = String(propEval.value);
        }

        let resultValue: unknown;
        if (typeof obj === 'string') {
          if (methodName === 'includes') resultValue = obj.includes(args[0] as string);
          else if (methodName === 'startsWith') resultValue = obj.startsWith(args[0] as string);
          else if (methodName === 'endsWith') resultValue = obj.endsWith(args[0] as string);
          else if (methodName === 'indexOf') resultValue = obj.indexOf(args[0] as string);
          else throw new Error(`Unknown string method: ${methodName}`);
        } else if (Array.isArray(obj)) {
          if (methodName === 'includes') resultValue = obj.includes(args[0]);
          else if (methodName === 'indexOf') resultValue = obj.indexOf(args[0]);
          else if (methodName === 'length') resultValue = obj.length;
          else throw new Error(`Unknown array method: ${methodName}`);
        } else if (typeof obj === 'object') {
          const method = (obj as Record<string, unknown>)[methodName];
          if (typeof method === 'function') resultValue = method.apply(obj, args);
          else resultValue = method;
        } else {
          throw new Error(`Cannot call method on ${typeof obj}`);
        }
        const result = makeEvaluatedNode(node, resultValue);
        // stitch evaluated callee children for tree printing
        const evalCallee = Object.assign({}, member, {
          object: objEval,
          property: propEval ?? member.property,
        });
        (result as any).callee = evalCallee;
        (result as any).arguments = evaluatedArgs;
        return result;
      }

      throw new Error(`Unsupported callee type: ${callee.type}`);
    }

    case 'MemberExpression': {
      const member = node as jsep.MemberExpression;
      const objEval = evaluateNode(member.object, ctx);
      const obj = objEval.value;

      let prop: string | number;
      let propEval: JsepEvaluatedNode | null = null;
      if (member.property.type === 'Identifier') {
        prop = (member.property as jsep.Identifier).name;
      } else if (member.property.type === 'Literal') {
        prop = (member.property as jsep.Literal).value as string | number;
      } else {
        propEval = evaluateNode(member.property, ctx);
        prop = propEval.value as string | number;
      }

      if (obj === null || obj === undefined) {
        throw new Error(`Cannot access property '${prop}' of ${obj}`);
      }

      let value: unknown;
      if (typeof obj === 'object') {
        value = (obj as Record<string, unknown>)[prop];
      } else {
        throw new Error(`Cannot access property on non-object`);
      }
      const result = makeEvaluatedNode(node, value);
      // stitch evaluated children into the result for tree printing
      (result as any).object = objEval;
      (result as any).property = propEval ?? member.property;
      return result;
    }

    case 'UnaryExpression': {
      const unary = node as jsep.UnaryExpression;
      const argEval = evaluateNode(unary.argument, ctx);
      const arg = argEval.value;

      let value: unknown;
      switch (unary.operator) {
        case '!': value = !arg; break;
        case '-': value = -(arg as number); break;
        case '+': value = +(arg as number); break;
        case '~': value = ~(arg as number); break;
        default:
          throw new Error(`Unknown unary operator: ${unary.operator}`);
      }
      const result = makeEvaluatedNode(node, value);
      // stitch evaluated child for tree printing
      (result as any).argument = argEval;
      return result;
    }

    case 'BinaryExpression': {
      const binary = node as jsep.BinaryExpression;
      const leftEval = evaluateNode(binary.left, ctx);
      const left = leftEval.value;

      // Short-circuit for && and ||
      if (binary.operator === '&&' && !left) {
        const result = makeEvaluatedNode(node, false);
        (result as any).left = leftEval;
        return result;
      }
      if (binary.operator === '||' && left) {
        const result = makeEvaluatedNode(node, left);
        (result as any).left = leftEval;
        return result;
      }

      const rightEval = evaluateNode(binary.right, ctx);
      const right = rightEval.value;
      const leftNum = left as number;
      const rightNum = right as number;

      let value: unknown;
      switch (binary.operator) {
        case '==': value = left == right; break; // eslint-disable-line eqeqeq
        case '===': value = left === right; break;
        case '!=': value = left != right; break; // eslint-disable-line eqeqeq
        case '!==': value = left !== right; break;
        case '<': value = leftNum < rightNum; break;
        case '<=': value = leftNum <= rightNum; break;
        case '>': value = leftNum > rightNum; break;
        case '>=': value = leftNum >= rightNum; break;
        case '+': value = leftNum + rightNum; break;
        case '-': value = leftNum - rightNum; break;
        case '*': value = leftNum * rightNum; break;
        case '/': value = leftNum / rightNum; break;
        case '%': value = leftNum % rightNum; break;
        case '&&': value = left && right; break;
        case '||': value = left || right; break;
        default:
          throw new Error(`Unknown binary operator: ${binary.operator}`);
      }
      const result = makeEvaluatedNode(node, value);
      // stitch evaluated children into the result for tree printing
      (result as any).left = leftEval;
      (result as any).right = rightEval;
      return result;
    }

    case 'ConditionalExpression': {
      const conditional = node as jsep.ConditionalExpression;
      const testEval = evaluateNode(conditional.test, ctx);
      const test = testEval.value;
      const branchEval = test
        ? evaluateNode(conditional.consequent, ctx)
        : evaluateNode(conditional.alternate, ctx);
      const result = makeEvaluatedNode(node, branchEval.value);
      // stitch evaluated children for tree printing
      (result as any).test = testEval;
      if (test) {
        (result as any).consequent = branchEval;
        (result as any).alternate = conditional.alternate;
      } else {
        (result as any).consequent = conditional.consequent;
        (result as any).alternate = branchEval;
      }
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
    const result = evaluateNode(ast, ctx);

    // Print debug output
    if (isDebuggingEval()) {
      agentIO.brief('info', 'eval', printJsepTree(result));
    }

    // Coerce to boolean
    return Boolean(result.value);
  } catch (err) {
    console.error(`[Evaluator] Failed to evaluate: ${expression}`, err);
    return false;
  }
}
