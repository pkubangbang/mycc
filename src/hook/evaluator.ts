/**
 * evaluator.ts - AST-based expression evaluation using jsep
 *
 * Safely evaluates expressions without using Function constructor.
 * Parses expression to AST with jsep, then walks the tree.
 *
 * Two scope prefixes:
 *   turn.*    — functions operating on current turn (since last user query)
 *   session.* — functions operating on entire livelog (since session start or last compact)
 * Plus global isPlanMode() and call.* context.
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
 *
 * Turn-scoped functions (operate on events since last user query):
 * - turnCount: count tool occurrences in current turn
 * - turnLastIndex: last index of a tool in current turn
 * - turnCountResult: count tool results matching a substring in current turn
 * - turnHadError: whether any tool errored in current turn
 *
 * Session-scoped functions (operate on entire livelog):
 * - sessionCount: count tool occurrences across livelog
 * - sessionLastIndex: last index of a tool across livelog
 * - sessionCountResult: count tool results matching a substring across livelog
 * - sessionHadError: whether any tool errored across livelog
 *
 * Global:
 * - isPlanMode: check if agent is in plan mode
 * - totalTurns: number of ended turns (STOP→PROMPT boundary crossings) since
 *   the in-memory session started. Compaction-immune (survives auto-compact),
 *   NOT persistence-immune (resets to 0 on restart/resume — Sequence is rebuilt
 *   fresh after session restore). Exposed only as totalTurns(); a bare
 *   `totalTurns` identifier is rejected by the validator AND throws here.
 *
 * Call context (current tool call being evaluated):
 * - call.metadata.X / call.args.X
 */
export interface EvalContext {
  turnCount: (tool?: string) => number;
  turnLastIndex: (tool: string) => number;
  turnCountResult: (tool: string, pattern: string, maxChars?: number) => number;
  turnHadError: (tool?: string) => boolean;
  sessionCount: (tool?: string) => number;
  sessionLastIndex: (tool: string) => number;
  sessionCountResult: (tool: string, pattern: string, maxChars?: number) => number;
  sessionHadError: (tool?: string) => boolean;
  isPlanMode: () => boolean;
  totalTurns: () => number;
  call?: CallContext;
  /**
   * Optional observer invoked when evaluation throws (e.g. a condition does
   * `call.args.command.includes(...)` on a call whose `args.command` is
   * undefined). Lets the caller attribute the failure to a specific hook
   * (skill name) so it can be surfaced for recompilation — see
   * ConditionRegistry.matches(). Absent in ad-hoc/test contexts, where the
   * failure is simply logged. Never throws: the observer is wrapped.
   */
  onEvalError?: (error: Error) => void;
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
 * Evaluate a jsep AST node against a context, attaching the failing node's
 * source text to any thrown error so callers can report WHERE evaluation died,
 * not just what went wrong (e.g. "…while evaluating: call.args.command").
 *
 * Recursion goes through evaluateNodeInner; the wrapper re-enters evaluateNode
 * so every sub-expression reports the deepest node that actually failed first.
 * The `nodeText` property is attached only if not already present, so the
 * innermost (most specific) failing node wins.
 */
function evaluateNode(node: jsep.Expression, ctx: EvalContext): JsepEvaluatedNode {
  try {
    return evaluateNodeInner(node, ctx);
  } catch (err) {
    if (err instanceof Error && !('nodeText' in err)) {
      let text: string;
      try {
        text = printJsepExpr(node);
      } catch {
        text = `<${node.type}>`;
      }
      (err as Error & { nodeText?: string }).nodeText = text;
    }
    throw err;
  }
}

/**
 * Evaluate a jsep AST node against a context.
 * Returns a JsepEvaluatedNode with both the AST structure and the evaluated value.
 */
function evaluateNodeInner(node: jsep.Expression, ctx: EvalContext): JsepEvaluatedNode {
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
        const resolved = ctx[name as keyof EvalContext];
        // A bare Identifier that resolves to a function is a misuse: the only
        // legal function reference is as a CallExpression callee (e.g.
        // `isPlanMode()` / `totalTurns()`). A bare `isPlanMode` or `totalTurns`
        // would otherwise coerce to `true` via Boolean(fn), producing a
        // silently always-truthy condition. (The validator rejects this too,
        // but defend-in-depth so a stale persisted condition can't slip through.)
        if (typeof resolved === 'function') {
          throw new Error(`Identifier "${name}" is a function and must be called as ${name}(), not referenced as a value`);
        }
        value = resolved;
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

      // Case 1: Direct function call like isPlanMode()
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

        // turn.XXX() and session.XXX() calls
        if (member.object.type === 'Identifier' &&
            ((member.object as jsep.Identifier).name === 'turn' ||
             (member.object as jsep.Identifier).name === 'session')) {
          if (member.property.type !== 'Identifier') {
            throw new Error('Dynamic property not supported on turn/session');
          }
          const mName = (member.property as jsep.Identifier).name;
          if (!(mName in ctx)) {
            throw new Error(`Unknown function: ${(member.object as jsep.Identifier).name}.${mName}`);
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
 * Evaluate an expression string using jsep AST.
 * Preprocesses turn.X( / session.X( → X( and keeps isPlanMode() as-is.
 * jsep doesn't understand the turn/session objects, so we strip the prefix
 * and resolve the function name directly from the EvalContext.
 */
export function evaluateExpression(expression: string, ctx: EvalContext): boolean {
  try {
    // Preprocess: replace turn.X( / session.X( with X( (jsep doesn't understand turn/session objects)
    // isPlanMode() is a direct identifier, no prefix needed.
    const jsExpr = expression
      .replace(/turn\.count\(/g, 'turnCount(')
      .replace(/turn\.lastIndex\(/g, 'turnLastIndex(')
      .replace(/turn\.countResult\(/g, 'turnCountResult(')
      .replace(/turn\.hadError\(/g, 'turnHadError(')
      .replace(/session\.count\(/g, 'sessionCount(')
      .replace(/session\.lastIndex\(/g, 'sessionLastIndex(')
      .replace(/session\.countResult\(/g, 'sessionCountResult(')
      .replace(/session\.hadError\(/g, 'sessionHadError(')
      .replace(/isPlanMode\(/g, 'isPlanMode(') // no-op, kept for clarity
      .replace(/totalTurns\(/g, 'totalTurns('); // no-op, kept for clarity

    // Parse to AST
    const ast = jsep(jsExpr);

    // Evaluate the AST
    const result = evaluateNode(ast, ctx);

    // Print debug output
    if (isDebuggingEval()) {
      agentIO.brief('info', 'eval', printJsepTree(result), undefined, { synthetic: true });
    }

    // Coerce to boolean
    return Boolean(result.value);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // The failing AST node (attached by the evaluateNode wrapper) tells the
    // user WHERE evaluation died, e.g. `call.args.command` — without it the
    // message says only that something was undefined.
    const nodeText = (error as Error & { nodeText?: string }).nodeText;

    // Friendly, non-alarming notice instead of a raw stack trace. The raw
    // console.error was scary to users and buried under Node frames; a
    // condition that fails to evaluate is NOT a crash — the hook simply does
    // not fire this time (see the self-healing path below).
    //
    // We keep the raw detail at verbose level for debugging, and emit a short
    // plain-language line the user can actually read. Both are synthetic
    // (machine-originated) so the WebUI chat log stays clean.
    agentIO.brief(
      'warn',
      'hook',
      `A hook condition could not be checked and was skipped.`,
      `Expr: ${expression}\n` +
        (nodeText ? `Failed at: ${nodeText}\n` : '') +
        `Reason: ${error.message}`,
      { synthetic: true },
    );
    if (isDebuggingEval()) {
      agentIO.verbose('hook', `Evaluator detail: ${expression}`, error.stack ?? String(err));
    }

    // Report the failure to the caller so it can be attributed to a specific
    // hook and surfaced for recompilation. Guarded so a broken observer can
    // never turn a soft failure into a hard crash.
    try {
      ctx.onEvalError?.(error);
    } catch {
      /* observer must never throw into the evaluator */
    }

    return false;
  }
}