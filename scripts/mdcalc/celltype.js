/**
 * celltype.js — the cell value model: type tags, format validators, and the
 * small set of coercions (`asNum`, `toDate`, `dateOf`) shared by the function
 * table and the formula evaluator.
 *
 * A CellValue is { type, value } where type in num|text|date|time|datetime.
 */

// CellValue: { type, value } where type in num|text|date|time|datetime
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

export function validateDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(v + 'T00:00:00'); return !isNaN(d.getTime());
}
export function validateTime(v) {
  if (typeof v !== 'string' || !TIME_RE.test(v)) return false;
  const [h, m, s] = v.split(':').map(Number);
  return h >= 0 && h < 24 && m >= 0 && m < 60 && s >= 0 && s < 60;
}
export function validateDatetime(v) {
  if (typeof v !== 'string' || !DATETIME_RE.test(v)) return false;
  return !isNaN(new Date(v).getTime());
}

// Convert a date/time/datetime string to a Date for date math
export function toDate(cell) {
  if (cell.type === 'date') return new Date(cell.value + 'T00:00:00');
  if (cell.type === 'datetime') return new Date(cell.value);
  if (cell.type === 'time') {
    // time alone — anchor to 1970-01-01
    return new Date(`1970-01-01T${cell.value}`);
  }
  throw new Error(`cannot convert ${cell.type} to Date`);
}

// Coerce a CellValue to a JS number, throwing a descriptive error on non-num
// (including empty). `ctx` is an op/function name used only in the message.
export function asNum(c, ctx) {
  if (!c || c.type !== 'num') {
    const desc = !c ? 'empty' : `${c.type} (${JSON.stringify(c.value)})`;
    throw new Error(`expected num, got ${desc}`);
  }
  return c.value;
}

// `true` if the cell is a numeric cell.
export function isNum(c) { return c && c.type === 'num'; }

// Require a date/datetime/time cell; returns a JS Date.
export function dateOf(c) {
  if (!c || (c.type !== 'date' && c.type !== 'datetime' && c.type !== 'time'))
    throw new Error(`expected date/datetime/time, got ${c ? c.type : 'empty'}`);
  return toDate(c);
}