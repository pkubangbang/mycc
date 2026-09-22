// retire-tests.js — remove it()/test() blocks by description substring.
// Usage: node scripts/retire-tests.js <file> <desc1> [desc2 ...]
// A block is removed when its description (first string arg) CONTAINS any
// of the given substrings (case-sensitive). Block boundaries are tracked by
// counting ( ) depth from the it(/test( line; the block ends at the first
// line where depth returns to 0 (the closing `);` line).
const fs = require('fs');

const file = process.argv[2];
const needles = process.argv.slice(3);
if (!file || needles.length === 0) {
  console.error('usage: node retire-tests.js <file> <desc1> [desc2 ...]');
  process.exit(1);
}
if (!fs.existsSync(file)) { console.error('not found: ' + file); process.exit(1); }

const src = fs.readFileSync(file, 'utf8');
// Detect and preserve original line ending
const isCrlf = src.includes('\r\n');
const lines = src.split(/\r?\n/);

const out = [];
let i = 0;
let removed = 0;
const n = lines.length;

// Match a line that STARTS an it()/test() call and captures the description.
const startRe = /^(\s*)(?:it|test)\(\s*(['"])(.+?)\2/;

while (i < n) {
  const line = lines[i];
  const m = line.match(startRe);
  if (m) {
    const desc = m[3];
    const hit = needles.some(nd => desc.includes(nd));
    if (hit) {
      // Find block end by tracking paren depth across subsequent lines.
      let depth = 0;
      for (let k = 0; k < line.length; k++) {
        if (line[k] === '(') depth++;
        else if (line[k] === ')') depth--;
      }
      let j = i + 1;
      let foundEnd = false;
      while (j < n) {
        const cur = lines[j];
        // Track string literals to avoid counting parens inside strings.
        // Simple scanner: toggle inString on quote (handles most cases).
        let inStr = false, strCh = '';
        for (let k = 0; k < cur.length; k++) {
          const ch = cur[k];
          if (inStr) {
            if (ch === '\\') { k++; continue; }
            if (ch === strCh) inStr = false;
          } else {
            if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; }
            else if (ch === '(') depth++;
            else if (ch === ')') depth--;
          }
        }
        if (depth <= 0) { foundEnd = true; break; }
        j++;
      }
      if (foundEnd) {
        i = j + 1;
        removed++;
        continue;
      }
      // No end found — keep the block (safer).
    }
  }
  out.push(line);
  i++;
}

if (removed > 0) {
  const eol = isCrlf ? '\r\n' : '\n';
  // Rejoin; drop a trailing empty line if the original ended with a newline
  // so we don't accumulate blank lines after many runs.
  let result = out.join(eol);
  if (result.endsWith(eol)) result = result.slice(0, -eol.length);
  fs.writeFileSync(file, result + eol, 'utf8');
  console.log(`  removed ${removed} block(s) from ${file}`);
} else {
  console.log(`  no matches in ${file}`);
}