/**
 * area.js — column-letter <-> number, cell-id parsing, and 1D area expansion.
 *
 * Columns are limited to A–Z (26 columns) in v0.1; multi-letter columns are
 * rejected by colToNumber. Rows are unbounded.
 *
 * Areas are 1D by default (used by every op except `clear`): a single cell
 * (`A1`), a column range (`A1:A10`, top-to-bottom), a row range (`A1:J1`,
 * left-to-right), or a whole column (`A:A`, expands to currently known rows via
 * maxRow). A 2D range (both row and column differ) throws in `parseArea`.
 *
 * `parseArea2D` relaxes that for the `clear` op only: it accepts a rectangular
 * 2D block (`A1:B10`) and returns every cell in row-major order, so a whole
 * block can be wiped in one action.
 *
 * `CELL_REF` is the regex used to find cell refs / ranges inside formula
 * strings (shared by the evaluator and the `copy` op).
 */

export function colToNumber(letters) {
  if (!/^[A-Z]+$/.test(letters)) throw new Error(`bad column letters: ${letters}`);
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  // v0.1: columns are limited to A–Z (26 columns). Multi-letter columns (AA, AB,
  // ...) are rejected so the result table stays a compact, single-letter grid.
  if (n > 26) throw new Error(`column ${letters} is out of range (only A–Z / 1–26 allowed)`);
  return n;
}

export function numberToCol(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Parse "A1" -> {col:1, row:1}. Returns null on bad input.
export function parseCellId(id) {
  const m = /^([A-Z]+)(\d+)$/.exec(id);
  if (!m) return null;
  return { col: colToNumber(m[1]), row: parseInt(m[2], 10) };
}

// Parse area string -> list of cell ids in order (top-to-bottom or left-to-right).
// Throws on 2D / unparseable. Whole-column "A:A" expands to currently known rows
// (caller passes maxRow). Returns { cells: string[], direction: 'col'|'row'|'single' }.
export function parseArea(area, maxRow) {
  if (!area || typeof area !== 'string') throw new Error('area is empty or not a string');
  if (area.includes(':')) {
    const [start, end] = area.split(':');
    const s = parseCellId(start), e = parseCellId(end);
    if (!s || !e) throw new Error(`unparseable area "${area}"`);

    // whole column A:A
    if (/^[A-Z]+$/.test(start) && /^[A-Z]+$/.test(end)) {
      const sc = colToNumber(start), ec = colToNumber(end);
      if (sc !== ec) throw new Error(`whole-column range must be one column, got "${area}"`);
      const cells = [];
      for (let r = 1; r <= maxRow; r++) cells.push(`${start}${r}`);
      if (cells.length === 0) throw new Error(`whole-column "${area}" has no rows (maxRow=0)`);
      return { cells, direction: 'col' };
    }

    const sameRow = s.row === e.row;
    const sameCol = s.col === e.col;
    if (!sameRow && !sameCol) throw new Error(`area "${area}" is 2D — only 1D ranges allowed`);
    const cells = [];
    if (sameCol) {
      const lo = Math.min(s.row, e.row), hi = Math.max(s.row, e.row);
      for (let r = lo; r <= hi; r++) cells.push(`${numberToCol(s.col)}${r}`);
      return { cells, direction: 'col' };
    } else {
      const lo = Math.min(s.col, e.col), hi = Math.max(s.col, e.col);
      for (let c = lo; c <= hi; c++) cells.push(`${numberToCol(c)}${s.row}`);
      return { cells, direction: 'row' };
    }
  }
  const c = parseCellId(area);
  if (!c) throw new Error(`unparseable area "${area}"`);
  return { cells: [area], direction: 'single' };
}

// Like parseArea but allows 2D rectangular ranges (e.g. `A1:B10`). Used only by
// the `clear` op, which can wipe a whole block in one action. Returns a flat
// list of cell ids in row-major order (row by row, left-to-right within a row).
// Whole-column (`A:A`) and single-cell forms behave as in parseArea.
export function parseArea2D(area, maxRow) {
  if (!area || typeof area !== 'string') throw new Error('area is empty or not a string');
  if (!area.includes(':')) {
    const c = parseCellId(area);
    if (!c) throw new Error(`unparseable area "${area}"`);
    return { cells: [area], direction: 'single' };
  }
  const [start, end] = area.split(':');
  // whole column A:A
  if (/^[A-Z]+$/.test(start) && /^[A-Z]+$/.test(end)) {
    const sc = colToNumber(start), ec = colToNumber(end);
    if (sc !== ec) throw new Error(`whole-column range must be one column, got "${area}"`);
    const cells = [];
    for (let r = 1; r <= maxRow; r++) cells.push(`${start}${r}`);
    if (cells.length === 0) throw new Error(`whole-column "${area}" has no rows (maxRow=0)`);
    return { cells, direction: 'col' };
  }
  const s = parseCellId(start), e = parseCellId(end);
  if (!s || !e) throw new Error(`unparseable area "${area}"`);
  const clo = Math.min(s.col, e.col), chi = Math.max(s.col, e.col);
  const rlo = Math.min(s.row, e.row), rhi = Math.max(s.row, e.row);
  const cells = [];
  for (let r = rlo; r <= rhi; r++) {
    for (let c = clo; c <= chi; c++) cells.push(`${numberToCol(c)}${r}`);
  }
  return { cells, direction: 'block' };
}

// Regex for cell refs like A1 and ranges like A1:A10. Shared by:
//   - formula.js (collectRefs / preprocessFormula)
//   - the `copy` op in evaluator.js (relative row shift)
// Note: it is stateful (uses .exec with /g); callers must reset lastIndex.
export const CELL_REF = /\b([A-Z]+\d+)(?::([A-Z]+\d+))?\b/g;