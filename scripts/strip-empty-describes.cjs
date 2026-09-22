#!/usr/bin/env node
/**
 * strip-empty-describes.cjs
 *
 * Removes `describe(...)` blocks whose callback body contains ZERO `it(`/`test(`
 * calls. Vitest fails with "No test found in suite" for an empty describe().
 *
 * Model: `describe('name', () => { BODY })` — the callback `() => { BODY }` is
 * the SECOND argument INSIDE the describe parens. So we:
 *   1. Find `describe(` and track paren depth to locate the matching close `)`,
 *      while ALSO tracking brace depth inside the paren span to locate the
 *      callback body `{` (the `=>` arrow body or `function` body) and its
 *      matching `}`.
 *   2. Count `it(`/`test(` calls inside the BODY brace span.
 *   3. If zero, delete the whole describe(...) call (from `describe` through its
 *      closing `)` plus optional trailing `;`).
 *
 * Repeated until no empty describe remains (handles nesting: removing an inner
 * describe may leave an outer one empty). Idempotent.
 */
const fs = require('fs');

/** Advance a scanner over one char, respecting strings/comments. Returns the new state. */
function makeScanner() {
  return { inStr: null, esc: false, lc: false, bc: false };
}

/** Process char c (with next char nx) against scanner state; returns nothing (mutates). */
function stepScan(s, c, nx) {
  if (s.lc) { if (c === '\n') s.lc = false; return; }
  if (s.bc) { if (c === '*' && nx === '/') { s.bc = false; } return; }
  if (s.inStr) {
    if (s.esc) { s.esc = false; return; }
    if (c === '\\') { s.esc = true; return; }
    if (c === s.inStr) s.inStr = null;
    return;
  }
  if (c === '/' && nx === '/') { s.lc = true; return; }
  if (c === '/' && nx === '*') { s.bc = true; return; }
  if (c === "'" || c === '"' || c === '`') { s.inStr = c; return; }
}

/**
 * Find the span of the FIRST empty describe() call in src.
 * Returns { start, end } (end is just past the closing ')' or trailing ';'),
 * or null if no empty describe found.
 */
function findEmptyDescribe(src) {
  const re = /\bdescribe\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const callStart = m.index;            // index of 'd' in describe
    const argOpen = m.index + m[0].length - 1; // position of '('
    const scan = makeScanner();
    let parenDepth = 0;
    let braceDepth = 0;
    let bodyBraceOpen = -1;  // position of the callback body '{'
    let bodyBraceClose = -1; // position just past the callback body '}'
    let sawArrowOrFn = false;
    let i = argOpen;
    for (; i < src.length; i++) {
      const c = src[i];
      const nx = src[i + 1];
      stepScan(scan, c, nx);
      if (scan.lc || scan.bc || scan.inStr) {
        // while inside a string/comment, do not count braces/parens/arrows.
        // BUT stepScan already consumed the char; for multi-char sequences the
        // index advance of the for-loop handles it. Continue counting nothing.
        // Note: we must still let the loop advance; skip structural checks.
        // However stepScan sets bc/lc on the SAME char (e.g. '/' with nx '*'),
        // and we already processed c. So just continue.
        // One exception: we should not treat the closing quote as structural.
        // That is handled because inStr is set and we skip.
        continue;
      }
      if (c === '(') {
        parenDepth++;
        continue;
      }
      if (c === ')') {
        parenDepth--;
        if (parenDepth === 0) { i++; break; } // i now just past the describe's ')'
        continue;
      }
      // Detect arrow `=>` (only when not in string/comment).
      if (c === '=' && nx === '>' && parenDepth >= 1) {
        sawArrowOrFn = true;
        i++; // consume the '>'
        continue;
      }
      // Detect `function` keyword.
      if (c === 'f' && src.startsWith('function', i) && parenDepth >= 1) {
        sawArrowOrFn = true;
        i += 'function'.length - 1; // -1 because for-loop will ++ i
        continue;
      }
      if (c === '{') {
        if (sawArrowOrFn && bodyBraceOpen === -1 && parenDepth === 1 && braceDepth === 0) {
          // This is the callback body opener (first '{' after arrow/fn at the
          // describe's direct arg level).
          bodyBraceOpen = i;
        }
        braceDepth++;
        continue;
      }
      if (c === '}') {
        braceDepth--;
        if (bodyBraceOpen !== -1 && braceDepth === 0 && bodyBraceClose === -1) {
          bodyBraceClose = i + 1; // just past '}'
          // Body fully captured — stop scanning the rest of the describe call.
          // Continuing would swallow sibling describes' content and miscount it()/test().
          break;
        }
        continue;
      }
    }
    if (bodyBraceOpen === -1 || bodyBraceClose === -1) continue; // no callback body found
    const body = src.slice(bodyBraceOpen, bodyBraceClose);
    const callRe = /\b(?:it|test)\s*\(/g;
    const itCount = (body.match(callRe) || []).length;
    if (itCount === 0) {
      // We broke out of the loop at bodyBraceClose (just past the body '}').
      // The describe's closing ')' is the next ')' after the body, skipping
      // whitespace (and the ')' that closes the callback's `() =>` param list
      // if present — but in `() => { }` the arrow has no parens, so the next
      // ')' is the describe's). Scan forward respecting strings/comments.
      let end = bodyBraceClose;
      const scan2 = makeScanner();
      let pdepth = 0;
      for (; end < src.length; end++) {
        const c = src[end];
        const nx = src[end + 1];
        stepScan(scan2, c, nx);
        if (scan2.lc || scan2.bc || scan2.inStr) continue;
        if (c === '(') { pdepth++; continue; }
        if (c === ')') {
          if (pdepth === 0) { end++; break; } // just past the describe's ')'
          pdepth--;
          continue;
        }
      }
      // Consume trailing same-line whitespace + optional ';'.
      while (end < src.length && /[ \t]/.test(src[end])) end++;
      if (src[end] === ';') end++;
      if (src[end] === '\r') end++;
      if (src[end] === '\n') end++;
      // Trim leading blank indentation before `describe`.
      let s = callStart;
      while (s > 0 && /[ \t]/.test(src[s - 1])) s--;
      return { start: s, end: end };
    }
  }
  return null;
}

function stripEmptyDescribes(src) {
  let changed = true;
  let passes = 0;
  while (changed && passes < 30) {
    changed = false;
    passes++;
    const span = findEmptyDescribe(src);
    if (span) {
      src = src.slice(0, span.start) + src.slice(span.end);
      changed = true;
    }
  }
  return src;
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node strip-empty-describes.cjs <file...>');
    process.exit(1);
  }
  let totalRemoved = 0;
  for (const f of files) {
    let orig;
    try {
      orig = fs.readFileSync(f, 'utf8');
    } catch (e) {
      console.warn(`${f}: SKIPPED (file not found)`);
      continue;
    }
    const out = stripEmptyDescribes(orig);
    if (out !== orig) {
      const before = (orig.match(/\bdescribe\s*\(/g) || []).length;
      const after = (out.match(/\bdescribe\s*\(/g) || []).length;
      const removed = before - after;
      totalRemoved += removed;
      fs.writeFileSync(f, out, 'utf8');
      console.log(`${f}: removed ${removed} empty describe(s)`);
    }
  }
  console.log(`done. total empty describes removed: ${totalRemoved}`);
}

main();