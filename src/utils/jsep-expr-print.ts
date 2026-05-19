import jsep, { Expression, CoreExpression } from 'jsep';

/**
 * take a jsep AST, print it back out as string
 * @param expr
 */
export function printJsepExpr(expr: Expression): string {
  switch (expr.type) {
    case 'Literal': {
      const lit = expr as jsep.Literal;
      const v = lit.value;
      if (typeof v === 'string') return `'${v}'`;
      if (v === null) return 'null';
      return String(v);
    }

    case 'Identifier': {
      return (expr as jsep.Identifier).name;
    }

    case 'ArrayExpression': {
      const arr = expr as jsep.ArrayExpression;
      const elements = arr.elements
        .filter((el): el is jsep.Expression => el !== null)
        .map(el => printJsepExpr(el));
      return `[${elements.join(', ')}]`;
    }

    case 'CallExpression': {
      const call = expr as jsep.CallExpression;
      const callee = printJsepExpr(call.callee);
      const args = call.arguments.map(a => printJsepExpr(a));
      return `${callee}(${args.join(', ')})`;
    }

    case 'MemberExpression': {
      const member = expr as jsep.MemberExpression;
      const obj = printJsepExpr(member.object);
      if (member.computed) {
        const prop = printJsepExpr(member.property);
        return `${obj}[${prop}]`;
      }
      const prop = (member.property as jsep.Identifier).name;
      return `${obj}.${prop}`;
    }

    case 'UnaryExpression': {
      const unary = expr as jsep.UnaryExpression;
      const arg = printJsepExpr(unary.argument);
      if (unary.prefix) return `${unary.operator}${arg}`;
      return `${arg}${unary.operator}`;
    }

    case 'BinaryExpression': {
      const binary = expr as jsep.BinaryExpression;
      const left = printJsepExpr(binary.left);
      const right = printJsepExpr(binary.right);
      return `(${left} ${binary.operator} ${right})`;
    }

    case 'ConditionalExpression': {
      const cond = expr as jsep.ConditionalExpression;
      const test = printJsepExpr(cond.test);
      const consequent = printJsepExpr(cond.consequent);
      const alternate = printJsepExpr(cond.alternate);
      return `(${test} ? ${consequent} : ${alternate})`;
    }

    case 'Compound': {
      const compound = expr as jsep.Compound;
      return compound.body.map(s => printJsepExpr(s)).join(';\n');
    }

    case 'SequenceExpression': {
      const seq = expr as jsep.SequenceExpression;
      return seq.expressions.map(e => printJsepExpr(e)).join(', ');
    }

    case 'ThisExpression':
      return 'this';

    default:
      return `[${expr.type}]`;
  }
}

/** evaluated expr. Each node has expr and value */
export type JsepEvaluatedNode = CoreExpression & { expr: string, value: any };

/**
 * take an evaluated expr, and print it out as a tree structure
 * @param eexpr evaluated expr
 * @param indent current indentation level
 */
export function printJsepTree(eexpr: JsepEvaluatedNode, indent: number = 0): string {
  const prefix = '  '.repeat(indent);
  const nodeType = eexpr.type;
  const exprStr = eexpr.expr;
  const valueStr = formatValue(eexpr.value);

  let result = `${prefix}${nodeType}: ${exprStr} => ${valueStr}`;

  // Recurse into children based on node type
  const children = getChildNodes(eexpr);
  for (const child of children) {
    result += '\n' + printJsepTree(child as JsepEvaluatedNode, indent + 1);
  }

  return result;
}

/**
 * Format a value for tree display
 */
function formatValue(value: any): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'function') return '[Function]';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.length <= 3) return `[${value.map(formatValue).join(', ')}]`;
    return `[${value.slice(0, 3).map(formatValue).join(', ')}, ...]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    if (keys.length <= 2) {
      const pairs = keys.map(k => `${k}: ${formatValue(value[k])}`).join(', ');
      return `{${pairs}}`;
    }
    return `{${keys.length} keys}`;
  }
  return String(value);
}

/**
 * Get child evaluated nodes from a parent node
 */
function getChildNodes(node: JsepEvaluatedNode): JsepEvaluatedNode[] {
  switch (node.type) {
    case 'ArrayExpression': {
      const arr = node as jsep.ArrayExpression;
      return arr.elements.filter((el): el is JsepEvaluatedNode => el !== null && typeof el === 'object' && 'expr' in el);
    }
    case 'CallExpression': {
      const call = node as jsep.CallExpression;
      const children: JsepEvaluatedNode[] = [];
      if (call.callee && typeof call.callee === 'object' && 'expr' in call.callee) {
        children.push(call.callee as JsepEvaluatedNode);
      }
      for (const arg of call.arguments) {
        if (arg && typeof arg === 'object' && 'expr' in arg) {
          children.push(arg as JsepEvaluatedNode);
        }
      }
      return children;
    }
    case 'MemberExpression': {
      const member = node as jsep.MemberExpression;
      const children: JsepEvaluatedNode[] = [];
      if (member.object && typeof member.object === 'object' && 'expr' in member.object) {
        children.push(member.object as JsepEvaluatedNode);
      }
      if (member.property && typeof member.property === 'object' && 'expr' in member.property) {
        children.push(member.property as JsepEvaluatedNode);
      }
      return children;
    }
    case 'UnaryExpression': {
      const unary = node as jsep.UnaryExpression;
      if (unary.argument && typeof unary.argument === 'object' && 'expr' in unary.argument) {
        return [unary.argument as JsepEvaluatedNode];
      }
      return [];
    }
    case 'BinaryExpression': {
      const binary = node as jsep.BinaryExpression;
      const children: JsepEvaluatedNode[] = [];
      if (binary.left && typeof binary.left === 'object' && 'expr' in binary.left) {
        children.push(binary.left as JsepEvaluatedNode);
      }
      if (binary.right && typeof binary.right === 'object' && 'expr' in binary.right) {
        children.push(binary.right as JsepEvaluatedNode);
      }
      return children;
    }
    case 'ConditionalExpression': {
      const cond = node as jsep.ConditionalExpression;
      const children: JsepEvaluatedNode[] = [];
      if (cond.test && typeof cond.test === 'object' && 'expr' in cond.test) {
        children.push(cond.test as JsepEvaluatedNode);
      }
      if (cond.consequent && typeof cond.consequent === 'object' && 'expr' in cond.consequent) {
        children.push(cond.consequent as JsepEvaluatedNode);
      }
      if (cond.alternate && typeof cond.alternate === 'object' && 'expr' in cond.alternate) {
        children.push(cond.alternate as JsepEvaluatedNode);
      }
      return children;
    }
    case 'Compound': {
      const compound = node as jsep.Compound;
      return compound.body.filter((s): s is JsepEvaluatedNode =>
        s !== null && typeof s === 'object' && 'expr' in s
      );
    }
    case 'SequenceExpression': {
      const seq = node as jsep.SequenceExpression;
      return seq.expressions.filter((e): e is JsepEvaluatedNode =>
        e !== null && typeof e === 'object' && 'expr' in e
      );
    }
    default:
      return [];
  }
}
