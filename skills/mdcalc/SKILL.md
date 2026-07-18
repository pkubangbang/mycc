---
name: mdcalc
description: >
  Use the Markdown Calculator (mdcalc) to do multi-step numeric and date math
  DETERMINISTICALLY — so the LLM never computes arithmetic itself. A .mdcalc.md
  file has three sections: "# 计算器规则" (rules), "# 操作记录" (an append-only
  action log inside a ```js block starting with "const ops = ["), and "# 结果"
  (result table). You append action objects (data/func/clear/date/time/datetime/seq/copy)
  to the ops array with edit_file, then run the `mdcalc` CLI via the bash tool
  (`mdcalc <file>`) to evaluate it, then read the result table back with read_file.
  The evaluator (jsep-based, no eval) does ALL the math; you only compose actions
  and read results. Use for sums, averages, formulas, loan schedules, VLOOKUP,
  date differences, any calculation where LLM arithmetic would be unreliable.
keywords: [mdcalc, calculator, arithmetic, formula, sum, average, date, loan, schedule, jsep, deterministic, seq, copy, table, init, check, clear]
---

# Markdown Calculator (mdcalc)

mdcalc moves the numbers into a structured markdown file and a dedicated Node
program computes them. The LLM **never** performs arithmetic — it only composes
action objects and reads back results. Use this for any multi-step numeric or
date calculation where doing the math by hand (or in your head) would be wrong.

## How to invoke the evaluator

`mdcalc` is a CLI installed via the mycc package's `bin` field (see
`package.json`). After `npm link` (or a global install of mycc), the `mdcalc`
command is on PATH and works from **any directory** — invoke it with the bash
tool. The first argument is a subcommand; if it is a file path (not
`init`/`check`/`help`), the default subcommand `eval` runs on it.

```
mdcalc <file>          # default: evaluate (replay ops, evaluate formulas, rewrite # 结果)
mdcalc eval <file>     # same as default
mdcalc init <file>     # write a starter .mdcalc.md template (refuses to overwrite)
mdcalc check <file>    # validate format + ops + formulas WITHOUT writing the file
mdcalc help            # print usage
```

`eval` reads the file, replays the `ops` log, evaluates formulas with jsep
(safe AST, no `eval`), rewrites the `# 结果` table in place, and writes a
`# 错误` section on errors. stdout: a one-line summary; stderr: error lines;
exit codes `0` = OK, `1` = any L1/L2/L3 error, `2` = usage error.

`check` runs the same validation as `eval` but does **not** modify the file —
use it to sanity-check an ops log before committing. `init` writes a template
you can fill in.

The `.mdcalc.md` file path can be absolute or relative to the agent's work dir.
You do NOT need to know where the evaluator script lives — just call `mdcalc`.

### Limits (v0.1)

- **Columns A–Z only** (26 columns); rows are unbounded.
- **1D ranges** for `data`/`func`/`date`/`time`/`datetime`/`seq`/`copy`.
  `clear` is the sole exception: it accepts a **2D block** (e.g. `A1:B10`) and
  wipes every cell in it in one action.
- **No `NOW()`/`TODAY()`** — results must be deterministic; pass dates via ops.

## The three-step workflow

1. **Write the file** (write_file) — start from the template below. Put real
   header text in row 1 (e.g. 期次/期初本金/...) and data from row 2 onward.
2. **Append actions** (edit_file) — add `{op:...}` objects to the `ops` array,
   before the closing `]`.
3. **Evaluate** (bash) — run `mdcalc <file>` via the bash tool. Then **read the
   result** with read_file (or read the bash stdout summary + the file's
   `# 结果` section).

Drive it with `write_file` / `edit_file` (ordinary file tools) + `bash` running
`mdcalc <file>` (evaluate) + `read_file` (read results). The CLI resolves
portably from PATH; do not call the evaluator by a relative script path.

## File template

````markdown
# 计算器规则

## 版本
0.1

## 功能简介
<what this calculator does; also note: row 1 = header text, data from row 2>

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

```js
const ops = [
  {op:'data', area:'A1', values:['期次']},
  {op:'data', area:'B1', values:['期初本金']},
  // ...more header cells in row 1...
  {op:'seq',  area:'A2:A13', from:1, to:12, step:1},
  {op:'data', area:'B2:B13', values:[...]},
  {op:'func', area:'C2',     values:['ROUND(B2 * 0.0035, 2)']},
  {op:'copy', from:'C2',     to:'C3:C13'}
]
```

# 结果

| # | A | B | C |
|---|---|---|---|
````

The evaluator rewrites everything from `# 结果` onward — do not hand-edit the
result table. Row 1 is just ordinary content: put text headers there and they
display verbatim; data rows follow from row 2. The first column (`#`) is the
row number 1..N.

## Action schema

Each op has `op`, `area` (or `from`+`to` for `copy`), and (except `clear`,
`seq`, `copy`) `values`. **`values` is always an array whose length must equal
the number of cells in `area` — a mismatch is a hard error.**

| op | fields | meaning |
|----|--------|---------|
| `data` | `area`, `values` (number[]/string[]) | raw numbers or text |
| `func` | `area`, `values` (string[] of formulas) | formulas, evaluated on eval |
| `clear` | `area` | clear cells to empty (the only op that accepts a 2D block like `A1:B10`) |
| `date` / `time` / `datetime` | `area`, `values` (string[] `YYYY-MM-DD` / `HH:mm:ss` / `YYYY-MM-DDTHH:mm:ss`) | typed date cells |
| `seq` | `area`, `from`/`to`/`step`/`unit`/`value` | **sequence fill** (see below) |
| `copy` | `from` (single cell), `to` (range) | **relative range copy / fill** (see below) |

### `seq` — sequence fill (avoids writing every value)

Generates a sequence into `area`. Generated length must equal area size (hard
error otherwise).

```js
{op:'seq', area:'A2:A241', from:1, to:240, step:1}           // 1,2,...,240
{op:'seq', area:'B2:B5',   from:10, to:2, step:-2}           // 10,8,6,4,2
{op:'seq', area:'C2:C241', value:4166.67}                     // constant 4166.67 ×240
{op:'seq', area:'D2:D13',  from:'2026-01-01', step:1, unit:'m'} // 12 monthly dates
```

- Numeric: `from` required; `step` defaults to `1` (or `-1` if `to < from`);
  `to` optional (else fill the whole area). `value` (instead of `from`) repeats
  a constant.
- Date: triggered by a `YYYY-MM-DD` `from` or a `unit` (`'d'`/`'m'`/`'y'`);
  `step` defaults to `1`.

### `copy` — relative range copy (avoids writing every formula)

Copies one source cell across a target range with **relative row** semantics
(spreadsheet fill-down). `from` must already be written by a prior op.

```js
{op:'func', area:'C2', values:['ROUND(B2 * 0.0035, 2)']},
{op:'copy', from:'C2', to:'C3:C241'}   // C3=ROUND(B3*0.0035,2), ..., C241=ROUND(B241*0.0035,2)
```

- **Formula source**: every row number in the formula's cell refs shifts by
  `delta = targetRow - sourceRow`; column letters stay fixed (relative row,
  absolute column). Range refs `A1:A10` have both endpoints shifted.
- **Literal source**: the value is replicated verbatim.
- **Empty source** is a hard error — write the source cell first.

## Formulas

jsep-parseable expressions. Cell refs are `A1` identifiers; ranges inside
functions use `A1:A10` (expanded to an array). Examples: `SUM(A1:A10)`,
`A1 * B1 + C1`, `ROUND(AVG(A1:A10), 2)`, `A1 > 100 ? B1 : C1`,
`DATEDIF(B1, B2, "d")` (pass both dates explicitly), `VLOOKUP("x", A1:A5, B1:B5)`.

Built-in functions: aggregation (`SUM, AVG, MIN, MAX, COUNT, COUNTNUM,
PRODUCT, STDDEV, VAR, MEDIAN`), scalar math (`ABS, ROUND, FLOOR, CEIL, POW,
SQRT, LOG, EXP, MOD, GCD, LCM, SIN, COS, ...`), conditional `IF`, lookup
`VLOOKUP`, date/time (`YEAR, MONTH, DAY, DATEDIF, DATEADD, TIMESTAMP, ...`).

**No `NOW()` / `TODAY()`** — they would make results non-deterministic (a file
would evaluate differently each run). Pass any "today"-like value explicitly
via a `date`/`datetime` op.

## Keeping display and computation consistent

To show two decimals AND have the rounded value feed into later calculations,
wrap the **formula** in `ROUND(..., 2)` — do NOT rely on display-only rounding.

```js
{op:'func', area:'D2', values:['ROUND(B2 * 0.0035, 2)']},
{op:'copy', from:'D2', to:'D3:D241'}
```

## Errors (three layers)

The CLI prints errors to stderr AND writes a `# 错误` section in the file.

| layer | when | format |
|-------|------|--------|
| L1 format | markdown structure broken / ops block not valid JS | `[L1:format] ...` (file NOT modified) |
| L2 action | an op is invalid (length mismatch, bad area, unknown op) | `[L2:action] op #N ...` |
| L3 calc | a formula fails (parse, type, cycle, div-by-zero, empty ref) | `[L3:calc] cell <id> ...` |

L2/L3 are collected (not abort-on-first), so fix them in one pass and re-run.

## Worked examples

Sixteen ready-to-run `.mdcalc.md` examples live in `skills/mdcalc/examples/`. Each
is a self-contained file (rules + ops log + populated result table) demonstrating a
distinct op/function combination. Re-run any with `mdcalc <file>` via bash, then
`read_file` its `# 结果` section.

| File | Demonstrates |
|------|---------------|
| `examples/01-sum-avg.mdcalc.md` | `data` + `SUM/AVG/MIN/MAX` |
| `examples/02-weighted-avg.mdcalc.md` | multi-column `data`, `func` across rows, `copy` |
| `examples/03-growth-rate.mdcalc.md` | row-over-row percent change, `ROUND`, `copy` |
| `examples/04-equal-payment-loan.mdcalc.md` | equal-payment loan schedule, `seq`, `POW`, `func`+`copy` ×4 |
| `examples/05-compound-interest.mdcalc.md` | `seq` years, `POW` compound growth, growth % |
| `examples/06-date-diff.mdcalc.md` | `date` ops, `DATEDIF(..., "d")`, `SUM` (no `TODAY()`) |
| `examples/07-dateadd-renewal.mdcalc.md` | `DATEADD` to compute expiry dates from a start date |
| `examples/08-vlookup-grade.mdcalc.md` | `VLOOKUP` exact-match grade lookup |
| `examples/09-if-commission.mdcalc.md` | nested `IF` tiered commission rate |
| `examples/10-statistics.mdcalc.md` | `COUNT/COUNTNUM/SUM/AVG/MIN/MAX/MEDIAN/STDDEV/VAR` |
| `examples/11-rounding.mdcalc.md` | `ROUND(x,d)` vs `FLOOR` vs `CEIL` |
| `examples/12-count-vs-countnum.mdcalc.md` | `COUNT` (any non-empty) vs `COUNTNUM` (num only); why `SUM` can't cross text |
| `examples/13-mod-gcd-lcm.mdcalc.md` | `MOD/GCD/LCM` integer math |
| `examples/14-time-workhours.mdcalc.md` | `time`/`datetime` ops, `DATEDIF(..., "s")` → hours |
| `examples/15-clear-2d-block.mdcalc.md` | `clear` with a 2D block (`B2:C3`) — the only 2D op |
| `examples/16-loan-plan.mdcalc.md` | large-scale 12-period equal-principal loan: `seq` + `func`+`copy` across 6 columns, `ROUND` everywhere |

## Reference

Full format spec and design rationale: `scripts/mdcalc/design.md`.
The evaluator implementation lives in the `scripts/mdcalc/` directory (the
`mdcalc.js` entry + its sibling modules), exposed as the `mdcalc` bin.