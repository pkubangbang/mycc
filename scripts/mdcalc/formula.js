/**
 * formula.js — formula preprocessing: collecting cell refs and replacing
 * `A1:A10` ranges with placeholder array variables (`__r0`, ...) that the
 * evaluator injects into the jsep eval context.
 *
 * Single cell refs (`A1`) are left as identifiers resolved against the grid.
 */

import { CELL_REF, parseArea } from './area.js';

// Collect all single cells referenced (expanding ranges). Returns Set of cell ids.
export function collectRefs(expr) {
  const refs = new Set();
  let m;
  CELL_REF.lastIndex = 0;
  while ((m = CELL_REF.exec(expr)) !== null) {
    if (m[2]) {
      const a = parseArea(`${m[1]}:${m[2]}`, 100000);
      for (const c of a.cells) refs.add(c);
    } else {
      refs.add(m[1]);
    }
  }
  return refs;
}

// Preprocess formula: replace A1:A10 ranges with a placeholder array variable
// that we inject into the eval context. We assign each range a name like __r0.
// Single cell refs A1 are left as identifiers resolved by the context.
export function preprocessFormula(expr) {
  const ranges = []; // {name, cells}
  let idx = 0;
  const out = expr.replace(/([A-Z]+\d+):([A-Z]+\d+)/g, (full, s, e) => {
    const a = parseArea(`${s}:${e}`, 100000);
    const name = `__r${idx++}`;
    ranges.push({ name, cells: a.cells });
    return name;
  });
  return { code: out, ranges };
}