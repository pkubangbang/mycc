/**
 * markdown.js — locate the three H1 sections and extract the `ops` array
 * source from the ```js fenced block identified by `const ops = [`.
 *
 * Extracts the raw JS source between the matching `[` and `]` (respecting
 * nested brackets and strings) so the evaluator can parse it into an array.
 * Throws L1Error on any structural problem.
 */

import { L1Error } from './errors.js';

// Extract the ops array from the ```js block identified by "const ops = ["
// Returns the raw JS source between [ and ]. Throws L1Error on problems.
export function extractOpsSource(content) {
  // find the ```js fenced block
  const fenceStart = content.search(/```js\s*\n/);
  if (fenceStart === -1) throw new L1Error('no ```js fenced block found');
  const afterFence = content.indexOf('\n', fenceStart) + 1;
  const fenceEnd = content.indexOf('```', afterFence);
  if (fenceEnd === -1) throw new L1Error('```js fenced block is not closed');
  const block = content.slice(afterFence, fenceEnd);

  // find the identification line
  const idLine = block.search(/const\s+ops\s*=\s*\[/);
  if (idLine === -1) throw new L1Error('identification line "const ops = [" not found in js block');

  // from the '[' after '=', find the matching ']' respecting nested brackets and strings
  const bracketStart = block.indexOf('[', idLine);
  if (bracketStart === -1) throw new L1Error('no "[" after "const ops ="');
  let depth = 0, inStr = false, strCh = '', escaped = false;
  let end = -1;
  for (let i = bracketStart; i < block.length; i++) {
    const ch = block[i];
    if (inStr) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === strCh) { inStr = false; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new L1Error('no matching "]" for ops array');
  return block.slice(bracketStart, end + 1); // includes [ and ]
}

// Locate sections by H1 heading. Returns map of heading -> {start, end}
export function locateSections(content) {
  const sections = {};
  const lines = content.split('\n');
  const headings = []; // {name, lineStart}
  for (let i = 0; i < lines.length; i++) {
    const m = /^#\s+(.+?)\s*$/.exec(lines[i]);
    if (m) headings.push({ name: m[1].trim(), lineStart: i });
  }
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const lineEnd = i + 1 < headings.length ? headings[i + 1].lineStart : lines.length;
    sections[h.name] = { lineStart: h.lineStart, lineEnd };
  }
  return { sections, lines };
}