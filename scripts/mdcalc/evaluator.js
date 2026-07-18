/**
 * evaluator.js — the two-pass evaluation pipeline.
 *
 *   Pass 1 (data pass): apply data/date/time/datetime/clear/seq/copy ops in
 *     order, writing typed values into the grid; collect L2 action errors.
 *   Pass 2 (formula pass): collect all `func` ops, build a dependency graph
 *     from cell refs inside each formula, topologically sort (cycle -> L3
 *     error), evaluate each formula with jsep + the function table, write
 *     results back with the correct type tag.
 *
 * `evaluateWithRanges` walks a jsep AST against a grid + a pre-expanded
 * range map (ranges are turned into `__rN` placeholders by preprocessFormula).
 */

import { L1Error, L2Error, L3Error } from './errors.js';
import { parseCellId, parseArea, parseArea2D, CELL_REF } from './area.js';
import {
  DATE_RE,
  validateDate,
  validateTime,
  validateDatetime,
  asNum,
  toDate,
} from './celltype.js';
import { extractOpsSource, locateSections } from './markdown.js';
import { collectRefs, preprocessFormula } from './formula.js';
import { FUNCS } from './functions.js';
import fs from 'fs';
import jsep from 'jsep';

export function evaluateFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // --- L1: locate sections ---
  const { sections, lines } = locateSections(content);
  if (!sections['操作记录']) throw new L1Error('missing section "# 操作记录"');
  if (!sections['结果']) throw new L1Error('missing section "# 结果"');

  const opsSrc = extractOpsSource(content);
  let ops;
  try {
    // Use Function constructor ONLY to parse the array literal — this is a trust
    // boundary: the source is the ops array from the file. We restrict by
    // wrapping in a function that only exposes nothing. (Alternative: JSON.parse
    // but ops uses JS array syntax with single quotes / no quotes — not strict JSON.)
    ops = (new Function(`"use strict"; return (${opsSrc});`))();
  } catch (e) {
    throw new L1Error(`ops array is not valid JS/JSON: ${e.message}`);
  }
  if (!Array.isArray(ops)) throw new L1Error(`ops is not an array (got ${typeof ops})`);

  const errors = []; // L2 + L3
  const grid = new Map(); // cellId -> CellValue
  const formulaCells = []; // {cell, expr} in order

  // Determine maxRow for whole-column ranges: highest row referenced in any area
  let maxRow = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op && typeof op.area === 'string') {
      try {
        // temporarily expand with current maxRow guess to learn actual rows
        const a = parseArea(op.area, 100000);
        for (const c of a.cells) { const m = /(\d+)$/.exec(c); if (m) maxRow = Math.max(maxRow, parseInt(m[1], 10)); }
      } catch { /* validation error will be reported below */ }
    }
  }

  // --- Pass 1: data pass ---
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] || {};
    const opName = op.op, area = op.area, values = op.values;
    try {
      if (opName === 'clear') {
        // `clear` is the only op allowed to target a 2D block (parseArea2D),
        // so a whole rectangle can be wiped in one action. All other ops stay 1D.
        const a = parseArea2D(area, maxRow);
        for (const c of a.cells) grid.delete(c);
      } else if (opName === 'data') {
        if (!Array.isArray(values)) throw new Error('values must be an array');
        const a = parseArea(area, maxRow);
        if (a.cells.length !== values.length)
          throw new Error(`values length ${values.length} ≠ area size ${a.cells.length}`);
        for (let k = 0; k < a.cells.length; k++) {
          const v = values[k];
          if (typeof v === 'number') grid.set(a.cells[k], { type: 'num', value: v });
          else if (typeof v === 'string') grid.set(a.cells[k], { type: 'text', value: v });
          else throw new Error(`value at index ${k} is ${v === null ? 'null' : typeof v} (expected number or string)`);
        }
      } else if (opName === 'date' || opName === 'time' || opName === 'datetime') {
        if (!Array.isArray(values)) throw new Error('values must be an array');
        const a = parseArea(area, maxRow);
        if (a.cells.length !== values.length)
          throw new Error(`values length ${values.length} ≠ area size ${a.cells.length}`);
        const validate = opName === 'date' ? validateDate : opName === 'time' ? validateTime : validateDatetime;
        const fmt = opName === 'date' ? 'YYYY-MM-DD' : opName === 'time' ? 'HH:mm:ss' : 'YYYY-MM-DDTHH:mm:ss';
        for (let k = 0; k < a.cells.length; k++) {
          const v = values[k];
          if (typeof v !== 'string' || !validate(v))
            throw new Error(`value at index ${k} "${v}" is not a valid ${opName} (${fmt})`);
          grid.set(a.cells[k], { type: opName, value: v });
        }
      } else if (opName === 'func') {
        if (!Array.isArray(values)) throw new Error('values must be an array of formula strings');
        const a = parseArea(area, maxRow);
        if (a.cells.length !== values.length)
          throw new Error(`values length ${values.length} ≠ area size ${a.cells.length}`);
        for (let k = 0; k < a.cells.length; k++) {
          const v = values[k];
          if (typeof v !== 'string') throw new Error(`formula at index ${k} is ${typeof v} (expected string)`);
          formulaCells.push({ cell: a.cells[k], expr: v });
        }
      } else if (opName === 'seq') {
        // Sequence fill. Expands {from,to,step} (or {value} repeat) into a values
        // array, then dispatches into the existing data (numeric) or date branch.
        //   Numeric: {op:'seq', area:'A1:A10', from:1, to:10, step:1}
        //            step defaults to 1 (or -1 if from>to). from required.
        //            If only `value` given (no from/to), repeat it to fill the area.
        //   Date:    {op:'seq', area:'B1:B12', from:'2026-01-01', step:1, unit:'m'}
        //            `unit` in d|m|y; `to` optional (else fill the area).
        // Length of the generated array must equal area size (hard L2 otherwise).
        const a = parseArea(area, maxRow);
        const n = a.cells.length;
        const hasFrom = Object.prototype.hasOwnProperty.call(op, 'from');
        const hasTo = Object.prototype.hasOwnProperty.call(op, 'to');
        const hasValue = Object.prototype.hasOwnProperty.call(op, 'value');
        if (!hasFrom && !hasValue) throw new Error('seq requires `from` (or `value` for a constant fill)');
        const stepVal = Object.prototype.hasOwnProperty.call(op, 'step') ? op.step : undefined;
        const unit = op.unit; // 'd'|'m'|'y' for dates; undefined for numeric

        let isDateSeq = false;
        let fromVal = hasFrom ? op.from : op.value;
        if (typeof fromVal === 'string' && (unit || DATE_RE.test(fromVal))) isDateSeq = true;

        if (isDateSeq) {
          if (typeof fromVal !== 'string' || !DATE_RE.test(fromVal))
            throw new Error(`seq date: from "${fromVal}" is not a valid date (YYYY-MM-DD)`);
          if (!unit || !['d', 'm', 'y'].includes(unit))
            throw new Error(`seq date: unit "${unit}" must be one of "d","m","y"`);
          const st = stepVal === undefined ? 1 : stepVal;
          if (typeof st !== 'number') throw new Error(`seq date: step must be a number, got ${typeof st}`);
          // generate date sequence into the area (or up to `to` if given)
          const vals = [];
          let cur = new Date(fromVal + 'T00:00:00');
          const p = (x) => String(x).padStart(2, '0');
          const fmt = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
          for (let k = 0; k < n; k++) {
            const d = new Date(cur);
            if (unit === 'd') d.setDate(d.getDate() + st * k);
            else if (unit === 'm') d.setMonth(d.getMonth() + st * k);
            else d.setFullYear(d.getFullYear() + st * k);
            vals.push(fmt(d));
            if (hasTo) {
              const lim = new Date(op.to + 'T00:00:00');
              if (st > 0 && d > lim) { vals.pop(); break; }
              if (st < 0 && d < lim) { vals.pop(); break; }
            }
          }
          if (vals.length !== n)
            throw new Error(`seq produced ${vals.length} values ≠ area size ${n} (adjust from/to/step)`);
          for (let k = 0; k < n; k++) {
            const v = vals[k];
            if (!validateDate(v)) throw new Error(`seq produced invalid date "${v}"`);
            grid.set(a.cells[k], { type: 'date', value: v });
          }
        } else {
          // numeric (or constant) sequence
          let vals;
          if (hasValue && !hasFrom) {
            // constant fill: repeat `value` to fill area
            if (typeof fromVal !== 'number' && typeof fromVal !== 'string')
              throw new Error(`seq value must be number or string, got ${typeof fromVal}`);
            vals = new Array(n).fill(fromVal);
          } else {
            const fv = fromVal;
            if (typeof fv !== 'number') throw new Error(`seq numeric: from must be a number, got ${typeof fv}`);
            let st = stepVal === undefined ? (hasTo && op.to < fv ? -1 : 1) : stepVal;
            if (typeof st !== 'number') throw new Error(`seq numeric: step must be a number, got ${typeof st}`);
            vals = [];
            let cur = fv, k = 0;
            for (; k < n; k++) {
              vals.push(cur);
              if (hasTo) {
                if (st > 0 && cur > op.to) { vals.pop(); break; }
                if (st < 0 && cur < op.to) { vals.pop(); break; }
              }
              cur += st;
            }
            if (vals.length !== n)
              throw new Error(`seq produced ${vals.length} values ≠ area size ${n} (adjust from/to/step)`);
          }
          for (let k = 0; k < n; k++) {
            const v = vals[k];
            if (typeof v === 'number') grid.set(a.cells[k], { type: 'num', value: v });
            else grid.set(a.cells[k], { type: 'text', value: v });
          }
        }
      } else if (opName === 'copy') {
        // Relative range copy / fill. `from` is a single source cell id, `to` is a
        // target 1D range. The source may be a formula cell or a data cell.
        //   - If source is a formula, every row number in its cell refs is shifted
        //     by delta = targetRow - sourceRow (relative row, absolute column).
        //     e.g. from:'D1' (= "B1 * 0.0035"), to:'D2:D240' => D2 = "B2 * 0.0035", ...
        //   - If source is a data/literal cell, the value is replicated as-is.
        //   - Source must be a single cell; `to` must be a 1D range or single cell.
        const fromId = op.from;
        const toArea = op.to;
        if (!fromId || typeof fromId !== 'string') throw new Error('copy requires `from` (single source cell id)');
        if (!toArea || typeof toArea !== 'string') throw new Error('copy requires `to` (target area)');
        const src = parseCellId(fromId);
        if (!src) throw new Error(`copy: source "${fromId}" is not a valid cell id`);
        if (parseCellId(toArea)) throw new Error('copy: `to` must be a range, not a single cell (use A2:A10)');
        const a = parseArea(toArea, maxRow);
        // locate the source formula, if any
        let srcExpr = null;
        for (const f of formulaCells) { if (f.cell === fromId) { srcExpr = f.expr; break; } }
        const srcCell = grid.get(fromId);
        if (!srcExpr && !srcCell) throw new Error(`copy: source cell ${fromId} is empty (write it first)`);

        for (let k = 0; k < a.cells.length; k++) {
          const tCell = a.cells[k];
          const t = parseCellId(tCell);
          const delta = t.row - src.row;
          if (delta === 0) {
            // same row: re-use the source formula verbatim
            if (srcExpr) formulaCells.push({ cell: tCell, expr: srcExpr });
            else grid.set(tCell, srcCell);
            continue;
          }
          if (srcExpr) {
            // shift row numbers on every cell-ref token by delta
            const shifted = srcExpr.replace(CELL_REF, (token, s1, s2) => {
              const shiftOne = (id) => id.replace(/(\d+)$/, (_, d) => String(Math.max(1, parseInt(d, 10) + delta)));
              if (s2) return `${shiftOne(s1)}:${shiftOne(s2)}`;
              return shiftOne(s1);
            });
            formulaCells.push({ cell: tCell, expr: shifted });
          } else {
            // literal value — replicate (no row shift needed)
            grid.set(tCell, srcCell);
          }
        }
      } else {
        throw new Error(`unknown op "${opName}" (expected data|func|clear|date|time|datetime|seq|copy)`);
      }
    } catch (e) {
      // L2 error: record and skip this op
      errors.push(new L2Error(i + 1, opName, area, e.message).message);
    }
  }

  // --- Pass 2: formula pass ---
  // Build dependency graph among formula cells
  const formulaMap = new Map(); // cell -> expr
  for (const f of formulaCells) formulaMap.set(f.cell, f.expr);

  // For each formula, find refs that are also formula cells -> dependencies
  const deps = new Map(); // cell -> Set(cell)
  for (const f of formulaCells) {
    const refs = collectRefs(f.expr);
    const d = new Set();
    for (const r of refs) if (formulaMap.has(r)) d.add(r);
    deps.set(f.cell, d);
  }

  // Topological sort with cycle detection (Kahn)
  const inDeg = new Map();
  for (const f of formulaCells) inDeg.set(f.cell, deps.get(f.cell).size);
  const queue = [];
  for (const [c, d] of inDeg) if (d === 0) queue.push(c);
  const order = [];
  const inDegCopy = new Map(inDeg);
  while (queue.length) {
    const c = queue.shift();
    order.push(c);
    for (const [other, d] of deps.entries()) {
      if (d.has(c)) {
        inDegCopy.set(other, inDegCopy.get(other) - 1);
        if (inDegCopy.get(other) === 0) queue.push(other);
      }
    }
  }

  if (order.length < formulaCells.length) {
    // cycle: report cells still with inDeg > 0
    const cycleCells = [...inDegCopy.entries()].filter(([, d]) => d > 0).map(([c]) => c);
    errors.push(`[L3:calc] cycle: ${cycleCells.join(' -> ')} (circular reference among formulas)`);
    // skip evaluating cyclic cells; evaluate the rest in order
  }

  // Evaluate formulas in topological order
  let okFormulas = 0;
  for (const cell of order) {
    const expr = formulaMap.get(cell);
    try {
      const { code, ranges } = preprocessFormula(expr);
      // resolve ranges to arrays of CellValue (empty cells -> null)
      const ctxRanges = ranges.map(r => ({ name: r.name, cells: r.cells.map(c => grid.get(c) || null) }));
      // build a range map for the evaluator
      const rangeMap = new Map(ctxRanges.map(r => [r.name, r.cells]));
      // evaluate using a custom walk that consults rangeMap
      const result = evaluateWithRanges(code, grid, rangeMap);
      grid.set(cell, result);
      okFormulas++;
    } catch (e) {
      errors.push(new L3Error(cell, expr, e.message).message);
      // leave cell blank
    }
  }

  return { grid, errors, opsCount: ops.length, formulaCount: formulaCells.length, okFormulas, sections, lines, content };
}

// Walk a jsep AST for `expr` against `grid` (single cells) and `rangeMap`
// (placeholder names __rN -> CellValue[] from pre-expanded ranges).
export function evaluateWithRanges(expr, grid, rangeMap) {
  const ast = jsep(expr);
  function evalNode(node) {
    switch (node.type) {
      case 'Literal': {
        const v = node.value;
        if (typeof v === 'number') return { type: 'num', value: v };
        if (typeof v === 'string') return { type: 'text', value: v };
        throw new Error(`unsupported literal: ${JSON.stringify(v)}`);
      }
      case 'Identifier': {
        const name = node.name;
        if (name.startsWith('__r')) {
          if (!rangeMap.has(name)) throw new Error(`internal: unknown range ${name}`);
          return rangeMap.get(name);
        }
        if (name === 'true') return { type: 'num', value: 1 };
        if (name === 'false') return { type: 'num', value: 0 };
        if (/^[A-Z]+\d+$/.test(name)) {
          const c = grid.get(name);
          if (!c) throw new Error(`references empty cell ${name}`);
          return c;
        }
        throw new Error(`unknown identifier: ${name}`);
      }
      case 'ArrayExpression':
        return node.elements.filter(e => e !== null).map(evalNode);
      case 'CallExpression': {
        const fname = node.callee.type === 'Identifier' ? node.callee.name : null;
        if (!fname || !(fname in FUNCS)) throw new Error(`unknown function "${fname}"`);
        const args = node.arguments.map(evalNode);
        try { return FUNCS[fname](...args); }
        catch (e) { throw new Error(`${fname}: ${e.message}`); }
      }
      case 'UnaryExpression': {
        const arg = evalNode(node.argument);
        const av = asNum(arg, 'unary');
        if (node.operator === '-') return { type: 'num', value: -av };
        if (node.operator === '+') return { type: 'num', value: +av };
        if (node.operator === '!') return { type: 'num', value: av ? 0 : 1 };
        throw new Error(`unsupported unary operator ${node.operator}`);
      }
      case 'BinaryExpression': {
        const left = evalNode(node.left);
        const right = evalNode(node.right);
        const op = node.operator;
        if (['+', '-', '*', '/', '%'].includes(op)) {
          const l = asNum(left, op), r = asNum(right, op);
          let v;
          if (op === '+') v = l + r;
          else if (op === '-') v = l - r;
          else if (op === '*') v = l * r;
          else if (op === '/') { if (r === 0) throw new Error('divide by zero'); v = l / r; }
          else if (op === '%') { if (r === 0) throw new Error('modulo by zero'); v = l % r; }
          return { type: 'num', value: v };
        }
        if (['<', '>', '<=', '>=', '==', '!=', '===', '!=='].includes(op)) {
          let lv, rv;
          if (left && right && left.type === right.type && ['date', 'time', 'datetime'].includes(left.type)) {
            lv = toDate(left).getTime(); rv = toDate(right).getTime();
          } else {
            lv = asNum(left, op); rv = asNum(right, op);
          }
          let v;
          if (op === '<') v = lv < rv;
          else if (op === '>') v = lv > rv;
          else if (op === '<=') v = lv <= rv;
          else if (op === '>=') v = lv >= rv;
          else if (op === '==' || op === '===') v = lv === rv;
          else v = lv !== rv;
          return { type: 'num', value: v ? 1 : 0 };
        }
        if (op === '&&' || op === '||') {
          const l = asNum(left, op), r = asNum(right, op);
          return { type: 'num', value: (op === '&&' ? (l && r) : (l || r)) ? 1 : 0 };
        }
        throw new Error(`unsupported binary operator ${op}`);
      }
      case 'ConditionalExpression': {
        const test = evalNode(node.test);
        const tv = asNum(test, '?:');
        return tv ? evalNode(node.consequent) : evalNode(node.alternate);
      }
      case 'Compound': {
        if (!node.body || !node.body.length) throw new Error('empty compound');
        let v;
        for (const b of node.body) v = evalNode(b);
        return v;
      }
      default:
        throw new Error(`unsupported node type: ${node.type}`);
    }
  }
  const result = evalNode(ast);
  if (Array.isArray(result)) throw new Error('formula result is a range, not a single value');
  if (!result || typeof result !== 'object' || !('type' in result)) throw new Error('formula did not produce a cell value');
  return result;
}