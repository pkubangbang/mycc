#!/usr/bin/env node
/**
 * mdcalc.js — CLI entry point for the Markdown Calculator.
 *
 * This file is the thin CLI layer: it routes subcommands, wires file I/O to the
 * evaluation pipeline, and prints the summary / exit code. All logic lives in
 * the sibling modules:
 *
 *   errors.js     — three error layers (L1/L2/L3)
 *   area.js       — column letters (A–Z only), cell-id + area parsing, CELL_REF
 *   celltype.js   — cell value model, format validators, asNum/toDate/dateOf
 *   markdown.js   — section location + ops-array extraction
 *   formula.js    — cell-ref collection + range preprocessing
 *   functions.js  — the built-in function table (no NOW/TODAY — non-deterministic)
 *   evaluator.js  — two-pass pipeline (data pass -> formula pass)
 *   render.js     — grid -> markdown result table
 *   rewrite.js    — atomic in-place rewrite of `# 结果` / `# 错误`
 *
 * Exposed as the `mdcalc` bin by the parent mycc package (see ../../package.json
 * `bin`). After `npm link` (or a global install of mycc), invoke from any
 * directory:
 *
 *   mdcalc              <file>   evaluate the file (default subcommand)
 *   mdcalc init         <file>   write a .mdcalc.md template to <file>
 *   mdcalc check        <file>   validate format + ops + formulas; do NOT write
 *   mdcalc help                  show this help
 *
 * Run directly during development:
 *   node scripts/mdcalc/mdcalc.js <subcommand> <file>
 */

import fs from 'fs';
import { evaluateFile } from './evaluator.js';
import { rewriteFile } from './rewrite.js';

const HELP = `mdcalc — Markdown Calculator

Usage:
  mdcalc <file>           Evaluate a .mdcalc.md file (default subcommand)
  mdcalc init <file>      Write a .mdcalc.md template to <file>
  mdcalc check <file>     Validate format + ops + formulas without writing
  mdcalc help             Show this help

Subcommands:
  (default) / eval   Replays the append-only ops log, evaluates formulas with
                     jsep (safe AST, no eval), rewrites the # 结果 table in place,
                     and writes a # 错误 section on errors. Prints a one-line
                     summary to stdout; errors to stderr.
  init               Writes a starter .mdcalc.md (rules + an empty ops log + an
                     empty result table). Refuses to overwrite an existing file.
  check              Runs the same validation as eval but does NOT modify the
                     file. Exits 0 if the file is well-formed and error-free,
                     non-zero otherwise (1 = L2/L3 errors, 2 = usage/L1).

File format (.mdcalc.md):
  Three top-level H1 sections in order:
    # 计算器规则   (rules: version, intro, workflow)
    # 操作记录     (a \`\`\`js block starting with "const ops = [")
    # 结果         (result table, rewritten by the evaluator)

Limits (v0.1):
  - Columns A–Z only (26 columns); rows unbounded.
  - 1D ranges for data/func/date/time/datetime/seq/copy; \`clear\` may use a 2D block.
  - No NOW()/TODAY() (results must be deterministic); pass dates explicitly.
  - jsep-parseable formulas; cell refs A1, ranges A1:A10.

Exit codes: 0 = OK, 1 = any L1/L2/L3 error, 2 = usage error.
`;

// Starter file written by `mdcalc init`. Header text in row 1, data from row 2.
const TEMPLATE = `# 计算器规则

## 版本
0.1

## 功能简介
<what this calculator does; row 1 = header text, data from row 2>

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 \`mdcalc <file>\` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

\`\`\`js
const ops = [
  // {op:'data', area:'A1', values:['列名']},
  // {op:'seq',  area:'A2:A13', from:1, to:12, step:1},
  // {op:'func', area:'C2',     values:['ROUND(B2 * 0.0035, 2)']},
  // {op:'copy', from:'C2',     to:'C3:C13'}
]
\`\`\`

# 结果

| # | A | B | C |
|---|---|---|---|
`;

function dieUsage(msg) {
  process.stderr.write(`${msg}\n\n${HELP}`);
  process.exit(2);
}

// --- subcommands -----------------------------------------------------------

function cmdInit(file) {
  if (!file) dieUsage('init: missing <file> argument');
  if (fs.existsSync(file)) {
    process.stderr.write(`init: file already exists: ${file} (remove it first)\n`);
    process.exit(2);
  }
  fs.writeFileSync(file, TEMPLATE, 'utf8');
  process.stdout.write(`Wrote template to ${file}\n`);
  process.exit(0);
}

function cmdCheck(file) {
  if (!file) dieUsage('check: missing <file> argument');
  if (!fs.existsSync(file)) {
    process.stderr.write(`[L1:format] file not found: ${file}\n`);
    process.exit(1);
  }
  let result;
  try {
    result = evaluateFile(file);
  } catch (e) {
    // L1 error — file not modified
    process.stderr.write(e.message + '\n');
    process.exit(1);
  }
  // check mode: do NOT rewrite the file. Just report.
  const k = result.errors.length;
  if (k === 0) {
    process.stdout.write(`OK: ${result.opsCount} ops, ${result.formulaCount} formulas, no errors. (file not modified)\n`);
    process.exit(0);
  } else {
    for (const e of result.errors) process.stderr.write(e + '\n');
    process.stdout.write(`${k} error(s) across ${result.opsCount} ops, ${result.formulaCount} formulas. (file not modified)\n`);
    process.exit(1);
  }
}

function cmdEval(file) {
  if (!file) dieUsage('missing <file> argument (or use: mdcalc help)');
  if (!fs.existsSync(file)) {
    process.stderr.write(`[L1:format] file not found: ${file}\n`);
    process.exit(1);
  }
  let result;
  try {
    result = evaluateFile(file);
  } catch (e) {
    // L1 error — file not modified
    process.stderr.write(e.message + '\n');
    process.exit(1);
  }

  // Rewrite file (results + errors section)
  try {
    rewriteFile(file, result.content, result.grid, result.errors, result.sections);
  } catch (e) {
    process.stderr.write(`[L1:format] failed to write file: ${e.message}\n`);
    process.exit(1);
  }

  const k = result.errors.length;
  if (k === 0) {
    process.stdout.write(`Evaluated ${result.okFormulas}/${result.formulaCount} formulas, ${result.opsCount} ops. OK.\n`);
    process.exit(0);
  } else {
    for (const e of result.errors) process.stderr.write(e + '\n');
    process.stdout.write(`Evaluated ${result.okFormulas}/${result.formulaCount} formulas, ${result.opsCount} ops. ${k} errors.\n`);
    process.exit(1);
  }
}

// --- routing ---------------------------------------------------------------

function main() {
  const [, , sub, file] = process.argv;

  switch (sub) {
    case undefined:
      dieUsage('no subcommand or file given');
      return; // unreachable; dieUsage exits
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      process.exit(0);
      return;
    case 'init':
      cmdInit(file);
      return;
    case 'check':
      cmdCheck(file);
      return;
    case 'eval':
      cmdEval(file);
      return;
    default:
      // No subcommand: treat `sub` as the file path (default subcommand = eval).
      cmdEval(sub);
      return;
  }
}

main();