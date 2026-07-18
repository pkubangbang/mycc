/**
 * rewrite.js — replace the `# 结果` section (and any `# 错误` section) in the
 * file with a freshly rendered result table, plus an errors block if there are
 * L2/L3 errors. Writes atomically (temp + rename) so a crash mid-write never
 * leaves a half-edited file.
 */

import path from 'path';
import fs from 'fs';
import { renderResultTable } from './render.js';

export function rewriteFile(filePath, content, grid, errors, sections) {
  // Replace the "# 结果" section content (from after heading to next H1/EOF)
  const resultStart = sections['结果'].lineStart;
  // find where the result section content ends: next H1 heading line index
  let resultEnd = sections['结果'].lineEnd;
  const lines = content.split('\n');

  // build new result table + optional errors section
  const newTable = renderResultTable(grid);
  let replacement = `# 结果\n\n${newTable}`;
  if (errors.length > 0) {
    replacement += `\n# 错误\n\n\`\`\`text\n${errors.join('\n')}\n\`\`\`\n`;
  }
  // Also strip any pre-existing "# 错误" section if it exists and we're not writing one
  // (when errors.length === 0 we still need to remove a stale 错误 section)
  // The replacement region: from resultStart to (start of 错误 section if exists, else resultEnd)
  let cutEnd = resultEnd;
  if (sections['错误']) {
    cutEnd = sections['错误'].lineEnd; // remove old errors section too
  }

  const before = lines.slice(0, resultStart).join('\n');
  const after = lines.slice(cutEnd).join('\n');
  let newContent = before + (before.endsWith('\n') || before.length === 0 ? '' : '\n') + replacement + (after.startsWith('\n') ? '' : '\n') + after;
  // normalize: ensure single trailing newline
  newContent = newContent.replace(/\n+$/, '\n');

  // atomic write: temp + rename
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, newContent, 'utf8');
  fs.renameSync(tmp, filePath);
}