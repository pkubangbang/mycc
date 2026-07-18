/**
 * render.js — turn the in-memory grid back into the markdown result table.
 *
 * The first column is the row index `1..N`; columns are spread-style letters
 * `A, B, ...`. Row 1 is ordinary content (often text headers) and is rendered
 * verbatim, just like any data row. The evaluator rewrites this table every
 * run — callers must not hand-edit it.
 */

import { colToNumber, numberToCol } from './area.js';

export function renderCell(cell) {
  if (!cell) return '';
  if (cell.type === 'num') {
    if (Number.isInteger(cell.value)) return String(cell.value);
    return String(cell.value);
  }
  if (cell.type === 'datetime') return cell.value.replace('T', ' ');
  return String(cell.value);
}

export function renderResultTable(grid) {
  // determine grid extents from all cells present
  let maxCol = 0, maxRow = 0;
  for (const id of grid.keys()) {
    const m = /^([A-Z]+)(\d+)$/.exec(id);
    if (!m) continue;
    maxCol = Math.max(maxCol, colToNumber(m[1]));
    maxRow = Math.max(maxRow, parseInt(m[2], 10));
  }
  if (maxCol === 0 || maxRow === 0) {
    // empty grid — render a minimal table
    return '| # | A |\n|---|---|\n';
  }
  const cols = [];
  for (let c = 1; c <= maxCol; c++) cols.push(numberToCol(c));
  const header = '| # | ' + cols.join(' | ') + ' |';
  const sep = '|---|' + cols.map(() => '---').join('|') + '|';
  const rows = [header, sep];
  // Render every row verbatim, row 1..maxRow, first column is the row number.
  // A header row (text in row 1) is just ordinary content displayed as-is.
  for (let r = 1; r <= maxRow; r++) {
    const cells = cols.map(c => renderCell(grid.get(`${c}${r}`)));
    rows.push(`| ${r} | ` + cells.join(' | ') + ' |');
  }
  return rows.join('\n') + '\n';
}