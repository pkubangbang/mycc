/**
 * functions.js — the built-in function table for formulas.
 *
 * Each function takes CellValue operands (or arrays of CellValue for range
 * args) and returns a CellValue. Type checking is enforced here: passing a
 * non-num where a num is expected throws, which surfaces as an L3 calc error
 * with the function name prefixed by the evaluator.
 *
 * Adding a new function = one entry in `FUNCS` below. No LLM change needed.
 */

import { asNum, dateOf, toDate } from './celltype.js';

export const FUNCS = {};

// Aggregation helpers operate on arrays of CellValue
function rangeNums(arr, fnName) {
  const out = [];
  for (const c of arr) {
    if (!c) continue; // skip empty for aggregation? No — design says error on non-num.
    // But empty cells in a range: treat as skip to allow sparse data; non-num errors.
    if (c.type !== 'num') throw new Error(`${fnName} requires num cells, found ${c.type} (${JSON.stringify(c.value)})`);
    out.push(c.value);
  }
  return out;
}

FUNCS.SUM = (arr) => { const n = rangeNums(arr, 'SUM'); return { type: 'num', value: n.reduce((a, b) => a + b, 0) }; };
FUNCS.AVG = (arr) => { const n = rangeNums(arr, 'AVG'); if (!n.length) throw new Error('AVG of empty range'); return { type: 'num', value: n.reduce((a, b) => a + b, 0) / n.length }; };
FUNCS.MIN = (arr) => { const n = rangeNums(arr, 'MIN'); if (!n.length) throw new Error('MIN of empty range'); return { type: 'num', value: Math.min(...n) }; };
FUNCS.MAX = (arr) => { const n = rangeNums(arr, 'MAX'); if (!n.length) throw new Error('MAX of empty range'); return { type: 'num', value: Math.max(...n) }; };
FUNCS.COUNT = (arr) => { let c = 0; for (const x of arr) if (x) c++; return { type: 'num', value: c }; };
FUNCS.COUNTNUM = (arr) => { let c = 0; for (const x of arr) if (x && x.type === 'num') c++; return { type: 'num', value: c }; };
FUNCS.PRODUCT = (arr) => { const n = rangeNums(arr, 'PRODUCT'); return { type: 'num', value: n.reduce((a, b) => a * b, 1) }; };
FUNCS.STDDEV = (arr) => {
  const n = rangeNums(arr, 'STDDEV'); if (!n.length) throw new Error('STDDEV of empty range');
  const mean = n.reduce((a, b) => a + b, 0) / n.length;
  const v = n.reduce((a, b) => a + (b - mean) ** 2, 0) / n.length;
  return { type: 'num', value: Math.sqrt(v) };
};
FUNCS.VAR = (arr) => {
  const n = rangeNums(arr, 'VAR'); if (!n.length) throw new Error('VAR of empty range');
  const mean = n.reduce((a, b) => a + b, 0) / n.length;
  return { type: 'num', value: n.reduce((a, b) => a + (b - mean) ** 2, 0) / n.length };
};
FUNCS.MEDIAN = (arr) => {
  const n = rangeNums(arr, 'MEDIAN').slice().sort((a, b) => a - b);
  if (!n.length) throw new Error('MEDIAN of empty range');
  const mid = Math.floor(n.length / 2);
  return { type: 'num', value: n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2 };
};

// Scalar math (operands are CellValue)
const numFn = (fn) => (...args) => ({ type: 'num', value: fn(...args.map(a => asNum(a, 'math'))) });
FUNCS.ABS = numFn(x => Math.abs(x));
FUNCS.FLOOR = numFn(x => Math.floor(x));
FUNCS.CEIL = numFn(x => Math.ceil(x));
FUNCS.SQRT = numFn(x => Math.sqrt(x));
FUNCS.EXP = numFn(x => Math.exp(x));
FUNCS.SIN = numFn(x => Math.sin(x));
FUNCS.COS = numFn(x => Math.cos(x));
FUNCS.TAN = numFn(x => Math.tan(x));
FUNCS.ASIN = numFn(x => Math.asin(x));
FUNCS.ACOS = numFn(x => Math.acos(x));
FUNCS.ATAN = numFn(x => Math.atan(x));
FUNCS.DEG = numFn(x => x * 180 / Math.PI);
FUNCS.RAD = numFn(x => x * Math.PI / 180);
FUNCS.ROUND = (x, d) => {
  const dv = asNum(d, 'ROUND');
  const f = Math.pow(10, dv);
  return { type: 'num', value: Math.round(asNum(x, 'ROUND') * f) / f };
};
FUNCS.POW = (b, e) => ({ type: 'num', value: Math.pow(asNum(b, 'POW'), asNum(e, 'POW')) });
FUNCS.LOG = (x, b) => {
  const xv = asNum(x, 'LOG');
  if (b === undefined || dIsNull(b)) return { type: 'num', value: Math.log(xv) };
  return { type: 'num', value: Math.log(xv) / Math.log(asNum(b, 'LOG')) };
};
FUNCS.MOD = (a, b) => { const bv = asNum(b, 'MOD'); if (bv === 0) throw new Error('MOD by zero'); return { type: 'num', value: asNum(a, 'MOD') % bv }; };
FUNCS.GCD = (a, b) => {
  let x = Math.abs(Math.trunc(asNum(a, 'GCD'))), y = Math.abs(Math.trunc(asNum(b, 'GCD')));
  while (y) { [x, y] = [y, x % y]; }
  return { type: 'num', value: x };
};
FUNCS.LCM = (a, b) => {
  const x = Math.abs(Math.trunc(asNum(a, 'LCM'))), y = Math.abs(Math.trunc(asNum(b, 'LCM')));
  if (!x || !y) return { type: 'num', value: 0 };
  const g = FUNCS.GCD({ type: 'num', value: x }, { type: 'num', value: y });
  return { type: 'num', value: Math.abs(x * y) / g.value };
};
function dIsNull(x) { return !x || x === null || x === undefined; }

// Conditional
FUNCS.IF = (cond, then, else_) => {
  const cv = asNum(cond, 'IF');
  return cv ? then : else_;
};

// Lookup: VLOOKUP(key, lookup_range, return_range)
// key is a CellValue; lookup_range and return_range are arrays of CellValue
FUNCS.VLOOKUP = (key, lookupRange, returnRange) => {
  if (!lookupRange || !returnRange || !Array.isArray(lookupRange) || !Array.isArray(returnRange))
    throw new Error('VLOOKUP requires (key, lookup_range, return_range)');
  if (lookupRange.length !== returnRange.length)
    throw new Error(`VLOOKUP range length mismatch: lookup ${lookupRange.length} vs return ${returnRange.length}`);
  for (let i = 0; i < lookupRange.length; i++) {
    const c = lookupRange[i];
    if (c && c.type === key.type && c.value === key.value) return returnRange[i];
  }
  throw new Error(`VLOOKUP key ${JSON.stringify(key.value)} not found`);
};

// Date/time functions
// NOTE: NOW() and TODAY() are deliberately omitted — they make results
// non-deterministic (a file evaluates differently each run). Use explicit
// `date`/`datetime` ops for any "today"-like value the calculation needs.
FUNCS.YEAR = (c) => { const d = dateOf(c); return { type: 'num', value: d.getFullYear() }; };
FUNCS.MONTH = (c) => { const d = dateOf(c); return { type: 'num', value: d.getMonth() + 1 }; };
FUNCS.DAY = (c) => { const d = dateOf(c); return { type: 'num', value: d.getDate() }; };
FUNCS.HOUR = (c) => { const d = dateOf(c); return { type: 'num', value: d.getHours() }; };
FUNCS.MINUTE = (c) => { const d = dateOf(c); return { type: 'num', value: d.getMinutes() }; };
FUNCS.SECOND = (c) => { const d = dateOf(c); return { type: 'num', value: d.getSeconds() }; };
FUNCS.WEEKDAY = (c) => { const d = dateOf(c); let w = d.getDay(); return { type: 'num', value: w === 0 ? 7 : w }; }; // 1=Mon..7=Sun
FUNCS.DATE = (y, m, d) => {
  const yv = asNum(y, 'DATE'), mv = asNum(m, 'DATE'), dv = asNum(d, 'DATE');
  const dt = new Date(yv, mv - 1, dv);
  const p = (n) => String(n).padStart(2, '0');
  return { type: 'date', value: `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}` };
};
FUNCS.TIME = (h, m, s) => {
  const hv = asNum(h, 'TIME'), mv = asNum(m, 'TIME'), sv = asNum(s, 'TIME');
  const p = (n) => String(Math.trunc(n)).padStart(2, '0');
  return { type: 'time', value: `${p(hv)}:${p(mv)}:${p(sv)}` };
};
FUNCS.DATEDIF = (d1, d2, unit) => {
  const a = dateOf(d1), b = dateOf(d2);
  const u = unit && unit.type === 'text' ? unit.value : unit;
  if (u === 'd') return { type: 'num', value: Math.round((b - a) / 86400000) };
  if (u === 's') return { type: 'num', value: Math.round((b - a) / 1000) };
  if (u === 'm' || u === 'y') {
    // months or years difference (calendar)
    let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    if (b.getDate() < a.getDate()) months--;
    if (u === 'm') return { type: 'num', value: months };
    return { type: 'num', value: Math.trunc(months / 12) };
  }
  throw new Error(`DATEDIF unknown unit "${u}" (use "d","m","y","s")`);
};
FUNCS.DATEADD = (date, n, unit) => {
  const d = new Date(dateOf(date).getTime());
  const nv = asNum(n, 'DATEADD');
  const u = unit && unit.type === 'text' ? unit.value : unit;
  if (u === 'd') d.setDate(d.getDate() + nv);
  else if (u === 'm') d.setMonth(d.getMonth() + nv);
  else if (u === 'y') d.setFullYear(d.getFullYear() + nv);
  else throw new Error(`DATEADD unknown unit "${u}" (use "d","m","y")`);
  const p = (x) => String(x).padStart(2, '0');
  return { type: 'date', value: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` };
};
FUNCS.TIMESTAMP = (c) => { const d = dateOf(c); return { type: 'num', value: Math.floor(d.getTime() / 1000) }; };
FUNCS.FROMTS = (c) => {
  const t = asNum(c, 'FROMTS');
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return { type: 'datetime', value: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` };
};
FUNCS.DATEOF = (c) => {
  const d = dateOf(c);
  const p = (n) => String(n).padStart(2, '0');
  return { type: 'date', value: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` };
};

// re-export so evaluator type-coercion stays consistent with the function table
export { asNum, toDate };