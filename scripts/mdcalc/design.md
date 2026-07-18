# Markdown Calculator — Design Plan

> Status: PLAN (not yet implemented)
> Goal: Give mycc reliable numeric and date/time computation by externalizing it to a markdown file + a deterministic evaluator program. The LLM only edits the file (appends actions) and reads back results; it never does arithmetic itself.

## 1. Why this approach

LLMs are unreliable at multi-step arithmetic and date math. By moving the numbers into a structured markdown file and letting a dedicated Node.js program do the math (using `jsep`, already a mycc dependency), we get:

- **Determinism** — the program, not the LLM, computes.
- **Auditability** — the file is a self-contained, human-readable record of rules + actions + results.
- **Append-only action log** — like redux: every operation is recorded, never mutated. Re-running the action log from scratch reproduces the result table.
- **LLM-friendly** — the LLM only does two things: append an action object to the JSON array, then run the evaluator and read the result table.

## 2. File format

A single `.mdcalc.md` file with three top-level H1 sections, in fixed order:

````markdown
# 计算器规则

## 版本
0.1

## 功能简介
（自然语言说明：这个计算器做什么、可用动作、可用函数）

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

## 可用动作
- data     : 写入数字或文本
- func     : 写入公式（1D 填充）
- clear    : 清空区域
- date     : 写入日期（YYYY-MM-DD）
- time     : 写入时间（HH:mm:ss）
- datetime : 写入日期时间（YYYY-MM-DDTHH:mm:ss）

## 可用函数
SUM, AVG, MIN, MAX, COUNT, PRODUCT, STDDEV, ABS, ROUND, POW, SQRT, LOG, EXP,
YEAR, MONTH, DAY, HOUR, MINUTE, SECOND, DATEDIF, DATEADD, WEEKDAY, ...
(NOW/TODAY are intentionally omitted — they make results non-deterministic.)

# 操作记录

```js
const ops = [
  {op:'data',     area:'A1:A10', values:[1,2,3,4,5,6,7,8,9,10]},
  {op:'date',     area:'B1:B3',  values:['2026-01-15','2026-02-20','2026-03-10']},
  {op:'func',     area:'A11',    values:['SUM(A1:A10)']},
  {op:'func',     area:'C1:C3',  values:['DATEDIF(B1, B2, "d")','DATEDIF(B2, B3, "d")','DATEDIF(B1, B3, "d")']}
]
```

# 结果

| # | A | B | C |
|---|---|---|---|
| 1 | 1 | 2026-01-15 | 183 |
| 2 | 2 | 2026-02-20 | 147 |
| 3 | 3 | 2026-03-10 | 129 |
| 4 | 4 | | |
| 5 | 5 | | |
| 6 | 6 | | |
| 7 | 7 | | |
| 8 | 8 | | |
| 9 | 9 | | |
| 10| 10| | |
| 11| 55| | |
````

### 2.1 识别字符串

The action log lives inside a fenced ```js code block. The evaluator locates it by the **identification line**:

```
const ops = [
```

Everything from this line until the matching `]` (respecting nested brackets) is the JSON-serializable action array. The LLM appends new action objects before the closing `]`.

### 2.2 Result table

The result table is a standard markdown table under `# 结果`. Columns are labeled `#` (row index) then `A`, `B`, `C`, ... (fixed spreadsheet-style column letters; no renaming). Rows are `1, 2, 3, ...`. The evaluator rewrites this table after each run. The LLM should **not** hand-edit the result table — it is derived output.

Empty cells render as blank (no value between the pipes).

### 2.3 Display formats by cell type

| Cell type | Display in result table |
|-----------|------------------------|
| `num`     | `42` or `3.14` (minimal, no trailing zeros) |
| `text`    | raw string |
| `date`    | `YYYY-MM-DD` |
| `time`    | `HH:mm:ss` |
| `datetime`| `YYYY-MM-DD HH:mm:ss` (space separator) |

## 3. Action schema (append-only log)

Each entry in `ops` is an object with an `op` field and an `area` field. All ops (except `clear`) carry a `values` field that is **always a 1D array**.

### 3.1 Core rule: `values` is always an array, length must match area

> **`values` is always an array. Its length must equal the number of cells in `area`. No scalar shortcut. A mismatch is a hard error — the evaluator aborts and reports to stderr.**

This rule is rigid by design. No ambiguity, no silent padding.

### 3.2 Ops

| op | area | values | cell type | meaning |
|----|------|--------|-----------|---------|
| `data` | 1D range or single cell | `number[]` or `string[]` | `num` or `text` | Write raw numbers or text |
| `func` | 1D range or single cell | `string[]` (formulas) | result type depends on formula | Write formula(s); evaluated on `eval` |
| `clear`| 1D range or single cell | (omitted) | — | Clear cells to empty |
| `date` | 1D range or single cell | `string[]` (`YYYY-MM-DD`) | `date` | Write date values |
| `time` | 1D range or single cell | `string[]` (`HH:mm:ss`) | `time` | Write time values |
| `datetime` | 1D range or single cell | `string[]` (`YYYY-MM-DDTHH:mm:ss`) | `datetime` | Write datetime values |

### 3.3 Area notation (1D by default; 2D allowed for `clear`)

- **Single cell**: `A1`, `B3`
- **Column range** (vertical): `A1:A10` — rows 1–10 of column A. Array maps **top-to-bottom**.
- **Row range** (horizontal): `A1:J1` — columns A–J of row 1. Array maps **left-to-right**.
- **Whole column**: `A:A` — all currently non-empty rows of column A.

Column letters are limited to **A–Z (26 columns)** in v0.1; multi-letter columns (`AA`, `AB`, …) are rejected. Rows are unbounded.

**Determining direction**: a range is a row range if start row == end row (`A1:J1`); a column range if start col == end col (`A1:A10`). A range where both row and col differ (e.g. `A1:B10`) is **2D** — it is a **hard error** for every op **except `clear`**, which may target a 2D block and wipes every cell in it in one action.

### 3.4 Validation (hard errors)

The evaluator aborts on any of these, printing a message to stderr and **not modifying the file**:

- `values` length ≠ area cell count
- 2D area (both row and col differ across endpoints)
- Unparseable area string
- `data` with a value that is neither number nor string
- `date`/`time`/`datetime` with a value that fails format validation
- Unknown `op` value
- Formula referencing an empty cell
- Circular formula reference
- Type mismatch in a function (e.g. `SUM` on a `text` cell)

## 4. Cell type model

Internally each cell is a tagged union. This lets formulas and functions enforce type correctness.

```js
{ type: 'num',      value: 42 }
{ type: 'text',      value: 'hello' }
{ type: 'date',      value: '2026-07-17' }            // ISO date string, stored as-is
{ type: 'time',      value: '14:30:00' }              // stored as-is
{ type: 'datetime',  value: '2026-07-17T14:30:00' }  // ISO 8601, stored as-is
```

**Type rules in formulas:**
- Arithmetic operators (`+ - * / %`) require `num` operands. Applying them to `date`/`time`/`text` is a hard error. Use `TIMESTAMP()` or date functions to convert first.
- Comparison operators (`< > <= >= == !=`) work on `num`; for dates use `DATEDIF` or convert via `TIMESTAMP()`.
- Aggregation functions (`SUM`, `AVG`, ...) require `num`; they **error** on non-numeric cells (do not silently skip).
- `COUNT` counts non-empty cells of any type; `COUNTNUM` counts only `num` cells.
- Date functions (`YEAR`, `DATEDIF`, ...) require `date`/`datetime`/`time` inputs as specified; type mismatch is a hard error.

## 5. Formula syntax

Formulas are jsep-parseable expressions. Cell references use `A1`-style identifiers. Ranges inside functions use `A1:A10` syntax, expanded by the evaluator to an array of values before jsep evaluation.

Examples:
- `SUM(A1:A10)` → sum of column A rows 1–10
- `A1 * B1 + C1` → arithmetic on cells
- `AVG(A1:A10) * 2` → nested
- `ROUND(AVG(A1:A10), 2)` → round to 2 decimals
- `A1 > 100 ? B1 : C1` → ternary
- `DATEDIF(B1, B2, "d")` → days between two dates (pass both explicitly; no `TODAY()`)
- `DATEADD(B1, 30, "d")` → date 30 days after B1
- `YEAR(B1)` → year of date in B1
- `TIMESTAMP(D1) + 86400` → epoch seconds + one day (manual date math)

Formula evaluation is **safe**: parsed by `jsep` (no `eval`/`Function`), walked with a restricted `EvalContext` that only knows cell values and the function table. Reuses the exact pattern from `src/hook/evaluator.ts`.

A formula's **result type** becomes the cell's type:
- Arithmetic → `num`
- Date functions returning dates → `date` or `datetime`
- `IF(cond, then, else)` → type of the taken branch

## 6. Built-in functions

Registered in the evaluator's function table. Naming is uppercase, spreadsheet-style.

### 6.1 Numeric aggregation (range → num)
| Function | Args | Description |
|----------|------|-------------|
| `SUM`    | range | Sum (errors on non-num) |
| `AVG`    | range | Arithmetic mean |
| `MIN`    | range | Minimum |
| `MAX`    | range | Maximum |
| `COUNT`  | range | Count of non-empty cells (any type) |
| `COUNTNUM`| range | Count of `num` cells only |
| `PRODUCT`| range | Product of all values |
| `STDDEV` | range | Population standard deviation |
| `VAR`    | range | Population variance |
| `MEDIAN` | range | Median |

### 6.2 Scalar math (num(s) → num)
| Function | Args | Description |
|----------|------|-------------|
| `ABS`    | x | Absolute value |
| `ROUND`  | x, digits | Round to N decimals |
| `FLOOR`  | x | Floor |
| `CEIL`   | x | Ceiling |
| `POW`    | base, exp | Power |
| `SQRT`   | x | Square root |
| `LOG`    | x, base? | Logarithm (base e if omitted) |
| `EXP`    | x | e^x |
| `SIN`/`COS`/`TAN` | x | Trig (radians) |
| `ASIN`/`ACOS`/`ATAN` | x | Inverse trig |
| `DEG`    | x | Radians → degrees |
| `RAD`    | x | Degrees → radians |
| `MOD`    | a, b | a mod b |
| `GCD`    | a, b | Greatest common divisor |
| `LCM`    | a, b | Least common multiple |

### 6.3 Conditional
| Function | Args | Description |
|----------|------|-------------|
| `IF`     | cond, then, else | Conditional; result type = type of taken branch |

### 6.4 Lookup
| Function | Args | Returns | Description |
|----------|------|---------|-------------|
| `VLOOKUP`| key, lookup_range, return_range | type of return cell | Search `lookup_range` (1D) for `key`; return the value at the same index in `return_range` (1D, same length as `lookup_range`). Errors if `key` not found, or if the two ranges have different lengths. Result type = the type of the matched return cell. |

`VLOOKUP` is the 1D-adapted version of the spreadsheet classic. Traditional `VLOOKUP(key, 2D_table, col_index)` needs a 2D range, which v0.1 rejects. Instead, the two 1D ranges name the lookup column and the return column explicitly — clearer and avoids 2D.

Example:
```
A1:A5 = names, B1:B5 = scores
VLOOKUP("Alice", A1:A5, B1:B5) → score of Alice (the return cell's type, e.g. num)
```
Key matching is **exact and type-sensitive** (`num` 5 does not match `text` "5"); no fuzzy/approximate match in v0.1. Duplicate keys → returns the **first** match. Key not found → L3 error. Range length mismatch → L3 error.

### 6.5 Date/time functions
| Function | Args | Returns | Description |
|----------|------|---------|-------------|
| `NOW`    | — | — | **Not provided** — would make results non-deterministic. Pass dates explicitly via `date`/`datetime` ops. |
| `TODAY`  | — | — | **Not provided** — same reason as `NOW`. |
| `YEAR`   | date/datetime | `num` | Year component |
| `MONTH`  | date/datetime | `num` | Month (1–12) |
| `DAY`    | date/datetime | `num` | Day of month (1–31) |
| `HOUR`   | datetime/time | `num` | Hour (0–23) |
| `MINUTE` | datetime/time | `num` | Minute (0–59) |
| `SECOND` | datetime/time | `num` | Second (0–59) |
| `WEEKDAY`| date/datetime | `num` | Day of week (1=Mon … 7=Sun) |
| `DATE`   | year, month, day | `date` | Construct date |
| `TIME`   | hour, min, sec | `time` | Construct time |
| `DATEDIF`| d1, d2, unit | `num` | Difference (d2 − d1) in `"d"`/`"m"`/`"y"` |
| `DATEADD`| date, n, unit | `date` | Add n units (`"d"`/`"m"`/`"y"`) to date |
| `TIMESTAMP` | datetime | `num` | Convert to Unix epoch seconds |
| `FROMTS` | epoch | `datetime` | Convert epoch seconds to datetime |
| `DATEOF` | datetime | `date` | Extract date part of datetime |

Functions are extensible: adding a new function = adding one entry to the function table in `mdcalc.js`. No LLM change needed.

## 7. Evaluator program

### 7.1 Two deliverables

1. **Standalone script (mini-project)**: `scripts/mdcalc/mdcalc.js` + sibling modules — a Node.js CLI, the core engine. No TypeScript build needed (runs directly). The code is split into small ES modules under `scripts/mdcalc/` (errors, area, celltype, markdown, formula, functions, evaluator, render, rewrite), with `mdcalc.js` as the thin entry point. Node resolves `jsep` from the parent mycc `node_modules` (no separate install). The entry script is exposed as the **`mdcalc` bin** by the parent mycc package (see `package.json` `bin`), so after `npm link` the LLM invokes `mdcalc <file>` from any directory — no relative-path coupling to the mycc repo. It is **not** a dynamically-loaded mycc tool, so it stays out of `src/tools/` and `.mycc/tools/`.
2. **Skill**: `skills/mdcalc/SKILL.md` — teaches the LLM the file format, action schema, the `seq`/`copy` ops, a template, and the workflow (write_file → edit_file → `bash` run `mdcalc <file>` → read_file). There is **no `mdcalc` tool**; the LLM drives the evaluator with ordinary file tools + `bash` + `read_file`.

### 7.2 Standalone script CLI

After `npm link` (or a global install of mycc), the script is on PATH as `mdcalc`. The first argument is a subcommand; if it is a file path (i.e. not one of `init`/`check`/`help`), the default subcommand `eval` runs on it.

```
mdcalc <file>            # default: evaluate (replay ops, evaluate formulas, rewrite # 结果)
mdcalc eval <file>       # same as the default
mdcalc init <file>       # write a starter .mdcalc.md template (refuses to overwrite)
mdcalc check <file>      # validate format + ops + formulas; do NOT modify the file
mdcalc help              # print usage
```

Run directly during development (no install):

```
node scripts/mdcalc/mdcalc.js <subcommand> <path-to-mdcalc-file>
```

`eval` (default):
- Reads the file
- Parses the `ops` array from the ```js fenced block (identified by `const ops = [`)
- **Pass 1 (data pass)**: apply `data`/`date`/`time`/`datetime`/`clear` ops in order, writing typed values into the grid (`clear` may target a 2D block)
- **Pass 2 (formula pass)**: collect all `func` ops, build dependency graph from cell references inside each formula, topologically sort, evaluate each formula with jsep + function table, write results back with correct type
- Rewrites the `# 结果` table in-place
- Writes the updated file back atomically (temp + rename)

`check`: runs the same parsing + data pass + formula pass as `eval` but **does not write** the file; prints errors to stderr and exits 0 (clean) / 1 (L2/L3 errors) / 2 (usage/L1).

`init`: writes the bundled template (rules + an empty ops log + an empty result table) to `<file>`, refusing to overwrite an existing file.

Exit codes: `0` = OK, `1` = any L1/L2/L3 error, `2` = usage error.
- Prints a short summary to stdout: `Evaluated N formulas, M data cells. OK.`

### 7.3 Internal data model

In-memory grid: `Map<string, CellValue>` keyed by cell id `A1`, `B3`, etc., where `CellValue` is the tagged union from §4. Two passes:

1. **Data pass** — apply all `data`/`date`/`time`/`datetime`/`clear` ops in order, writing typed values with format validation.
2. **Formula pass** — collect all `func` ops, build dependency graph from cell references inside each formula, topologically sort, evaluate each formula with jsep + function table, write results back with correct type tag.

Circular references → error to stderr, file not modified.

### 7.4 jsep integration

Reuse the `jsep` package (already in `package.json`). The evaluator builds an `EvalContext` where:
- Identifiers like `A1` resolve to the current grid cell value (returns the `.value`, with type checking)
- Range tokens `A1:A10` are pre-expanded to arrays before jsep parsing (regex preprocessing step, same pattern as `evaluateExpression` in `src/hook/evaluator.ts`)
- Call expressions dispatch to the function table

This keeps evaluation safe (no `eval`) and consistent with mycc's existing hook evaluator.

### 7.5 Skill (`skills/mdcalc/SKILL.md`)

Instead of a dedicated tool, mdcalc is exposed as a **skill**: a markdown doc the
LLM loads on demand that explains the file format, action schema (including
`seq`/`copy`), a ready template, and the workflow. The LLM uses ordinary tools:
- `write_file` — create the `.mdcalc.md` from the template (header in row 1, data from row 2)
- `edit_file` — append `{op:...}` objects to the `ops` array
- `bash` — run `mdcalc <file>` (the CLI installed via the parent package's `bin`)
- `read_file` — read the updated `# 结果` (and `# 错误`) section

No `ToolDefinition` is registered; the tool list stays lean and the capability
is discoverable via `skill_search` / `skill_load`.

## 8. LLM workflow

1. LLM `skill_load`s `mdcalc` (or `skill_search` finds it) to learn the format + template.
2. LLM calls `write_file` to create the `.mdcalc.md` from the template (header in row 1, data from row 2).
3. LLM calls `edit_file` to append action objects to the `ops` array.
4. LLM calls `bash` with `mdcalc <file>`.
5. LLM calls `read_file` to read the updated `# 结果` table and reports the number to the user.

The LLM never performs arithmetic. It only composes actions and reads results.

## 9. Error reporting

The evaluator reports errors with precise layer and location information. There are **three error layers**, each with its own message format. Errors are reported to **stderr** (for the LLM/bash caller) AND, when the file format itself is valid, written into a **`# 错误` (errors) section at the bottom of the file** so the file stays self-contained.

### 9.1 The three error layers

| Layer | When | Example message format | File written? |
|-------|------|------------------------|---------------|
| **L1 — File format** | The markdown structure is wrong (missing sections, `ops` block not found, not valid JSON array, etc.) | `[L1:format] <where> <what>` | **No** — can't safely write to a malformed file; stderr only |
| **L2 — Action validation** | An individual op object is invalid (bad area, length mismatch, bad type, unknown op, bad date format) | `[L2:action] op #N (op=..., area=...) <what>` | **Yes** — file format is valid, so errors go into the `# 错误` section |
| **L3 — Calculation** | A formula fails during evaluation (jsep parse error, type mismatch, circular ref, unknown function, div by zero, empty cell ref) | `[L3:calc] cell <id> formula "<expr>" <what>` | **Yes** — same |

### 9.2 Message format (detailed)

**L1 — File format errors** (stderr only):
```
[L1:format] missing section "# 操作记录"
[L1:format] ops block not found: no line starting with "const ops = ["
[L1:format] ops array is not valid JSON: SyntaxError: Unexpected token at position 42
[L1:format] ops is not an array (got object)
[L1:format] section "# 结果" table header missing or malformed
```
On L1 errors the evaluator prints to stderr and exits with code 1. The file is **not modified** because we can't trust its structure.

**L2 — Action validation errors** (stderr + `# 错误` section):
```
[L2:action] op #3 (op=data, area=A1:A10) values length 9 ≠ area size 10
[L2:action] op #5 (op=date, area=B1:B3) value "2026-13-99" is not a valid date (YYYY-MM-DD)
[L2:action] op #7 (op=func, area=D1:D2) area is 2D (A1:B2) — only 1D ranges allowed
[L2:action] op #9 (op=unknown, area=A1) unknown op "unknown" (expected data|func|clear|date|time|datetime)
[L2:action] op #11 (op=data, area=A1) value is null (expected number or string)
```
`op #N` is the **1-based index** in the `ops` array, so the LLM can find the exact line to fix. The evaluator collects **all** L2 errors (does not abort on the first), then reports them together. The file's `# 结果` table is not regenerated; only the `# 错误` section is written.

**L3 — Calculation errors** (stderr + `# 错误` section):
```
[L3:calc] cell A12 formula "SUM(A1:A10) + A20" references empty cell A20
[L3:calc] cell B5 formula "SUM(C1:C10)" type error: SUM requires num cells, C3 is text ("hello")
[L3:calc] cell C1 formula "A1 / B1" divide by zero
[L3:calc] cell D2 formula "UNKNOWFN(1)" unknown function "UNKNOWFN"
[L3:calc] cell E1 formula "A1 + B1" type error: operator + requires num operands, B1 is date
[L3:calc] cycle: A1 -> B1 -> A1 (circular reference among formulas)
[L3:calc] cell F3 formula "SQRT(A1)" jsep parse error: Unexpected token ")"
```
L3 errors are also collected, not aborted on first. On a cycle, the evaluator lists the full cycle path. The `# 结果` table is regenerated only for cells that evaluated successfully; failed formula cells are left **blank** with the error recorded in `# 错误`.

### 9.3 The `# 错误` (errors) section

Appended at the **bottom of the file** (after `# 结果`). It is **rewritten on every run** — the evaluator replaces any existing `# 错误` section wholesale, so it always reflects the current state.

- **No errors** → the section is omitted entirely (or contains a single line `OK` — see §9.4 for the choice; default: omitted so the file stays clean).
- **Has errors** → a fenced ```text block listing all L2 and L3 errors, one per line, in layer/index order (L2 first by op index, then L3 by cell id).

Example file tail after a run with errors:
````markdown
# 结果

| # | A | B |
|---|---|---|
| 1 | 1 | |
| 2 | 2 | |

# 错误

```text
[L2:action] op #2 (op=date, area=B1:B2) value "2026-13-99" is not a valid date (YYYY-MM-DD)
[L3:calc] cell A3 formula "SUM(A1:A2) + C1" references empty cell C1
```
````

### 9.4 Success vs failure output

| Outcome | stdout | stderr | Exit code | `# 结果` table | `# 错误` section |
|---------|--------|--------|-----------|----------------|------------------|
| All OK  | `Evaluated N formulas, M data cells. OK.` | (empty) | 0 | regenerated | omitted |
| L2/L3 errors | `Evaluated N formulas, M data cells. K errors.` (K = error count) | all error lines | 1 | regenerated for successful cells only | written with all errors |
| L1 format error | (empty) | all error lines | 1 | unchanged | unchanged (can't trust file) |

### 9.5 Implementation notes for error reporting

- The evaluator keeps an `errors: string[]` array through the run. L1 errors throw immediately (can't continue). L2 and L3 errors are pushed and the run continues to collect as many as possible.
- For L2, validation happens in the data pass: each op is validated before being applied; invalid ops are skipped (not applied) but recorded.
- For L3, formula evaluation is wrapped in try/catch per cell; a failed formula leaves its cell blank and pushes an error. Cycles are detected during topological sort (not per-cell).
- The `# 错误` section is located by the `# 错误` H1 heading; everything from it to EOF is replaced. If absent, it's appended after `# 结果`.
- Writing errors into the file means the LLM can `read_file` the file and see both the (partial) results and the exact errors without parsing stderr — fully self-contained.

## 10. Implementation plan (when approved)

### 10.1 Files to create

| File | Purpose |
|------|---------|
| `scripts/mdcalc/mdcalc.js` | CLI entry point (exposed as the `mdcalc` bin by the parent mycc `package.json`); wires file I/O to the pipeline and prints the summary / exit code |
| `scripts/mdcalc/errors.js` | The three error layers (L1 format / L2 action / L3 calc) |
| `scripts/mdcalc/area.js` | Column letters, cell-id + 1D area parsing, the `CELL_REF` regex |
| `scripts/mdcalc/celltype.js` | Cell value model, format validators, `asNum`/`toDate`/`dateOf` |
| `scripts/mdcalc/markdown.js` | H1 section location + `ops`-array extraction from the ```js block |
| `scripts/mdcalc/formula.js` | Cell-ref collection + `A1:A10` range preprocessing |
| `scripts/mdcalc/functions.js` | The built-in function table (aggregation, math, conditional, lookup, date/time) |
| `scripts/mdcalc/evaluator.js` | The two-pass pipeline (data pass → formula pass) + jsep AST walk |
| `scripts/mdcalc/render.js` | Grid → markdown result table |
| `scripts/mdcalc/rewrite.js` | Atomic in-place rewrite of `# 结果` / `# 错误` |
| `skills/mdcalc/SKILL.md` | Skill that teaches the LLM the format, template, `seq`/`copy` ops, and the write_file→edit_file→bash→read_file workflow |
| `skills/mdcalc/examples/16-loan-plan.mdcalc.md` | Worked example: a 12-period equal-principal loan schedule demonstrating seq/copy/func |
| `scripts/mdcalc/design.md` | This design doc |

### 10.2 Implementation steps

The evaluator is split into small ES modules under `scripts/mdcalc/` (see §10.1), each owning one concern. Steps build leaves-first:

1. **Leaf modules** — no internal deps:
   - `errors.js` — `L1Error` / `L2Error` / `L3Error` with the message formats from §9.2
   - `area.js` — `A1` / `A1:A10` / `A1:J1` / `A:A` parsing; column letters ↔ numbers; direction detection (row vs col); 2D rejection; the `CELL_REF` regex
   - `celltype.js` — tagged union `num`/`text`/`date`/`time`/`datetime`; ISO date/time/datetime validators (strict → L2 on bad format); `asNum` / `toDate` / `dateOf` coercions
2. **Mid modules** — depend on leaves:
   - `markdown.js` — extract `ops` array from the ```js block identified by `const ops = [`; locate H1 sections; detect missing/malformed structure → L1 errors
   - `formula.js` — `collectRefs` (expand ranges) + `preprocessFormula` (replace `A1:A10` with `__rN` placeholders)
   - `functions.js` — the full function table from §6 with type checking (re-exports `asNum`/`toDate` for the evaluator)
   - `render.js` — grid → markdown table with type-aware display formats; failed formula cells blank
3. **Pipeline** — depend on all of the above:
   - `evaluator.js` — `evaluateFile`: data pass (validate each op → collect L2, skip invalid, apply valid in order; includes `seq`/`copy`); formula pass (jsep parse, dependency graph, topological sort → cycles as L3, evaluate per cell in try/catch → collect L3, infer result type); `evaluateWithRanges` walks the jsep AST against grid + range map
   - `rewrite.js` — atomic in-place rewrite (temp + rename) of `# 结果` and `# 错误`
4. **CLI entry** — `mdcalc.js`: arg validation, run `evaluateFile`, `rewriteFile`, print summary to stdout / errors to stderr, set exit code per §9.4. Register as the `mdcalc` bin in the parent `package.json`.
5. **Skill** — `skills/mdcalc/SKILL.md`: format, template, `seq`/`copy` ops, and the write_file→edit_file→`bash` (`mdcalc <file>`)→read_file workflow. No `ToolDefinition`.
6. **Test manually** — sample `.mdcalc.md` files: (a) clean run with numbers/dates/formulas, (b) L2 action errors, (c) L3 calc errors, (d) L1 format error. Verify error messages and file output. (The bundled `examples/16-loan-plan.mdcalc.md` exercises the happy path; the other 15 examples each isolate one op/function.)
7. **Add vitest unit tests** for the evaluator core (area parsing, type validation, formula evaluation, date functions, and each error layer).

### 10.3 Dependencies

- `jsep` — already in `package.json` (^1.4.0). No new dependency.
- Node.js >= 18 — already required by mycc.
- No new npm packages.

### 10.4 What is NOT in scope (v0.1)

- No 2D ranges for data/func/date/time/datetime/seq/copy — 1D only (`clear` is the sole exception: it may wipe a 2D block)
- Columns limited to A–Z (26); no multi-letter columns
- No `NOW()`/`TODAY()` — results must be deterministic; pass dates explicitly
- No multi-sheet support (single table per file)
- No external data import (CSV etc.) — LLM uses `data` ops to enter values
- No chart/visualization
- No undo/redo (the append-only log IS the history; to undo, remove the last op and re-run)
- No timezone support (all date/time is local; `TIMESTAMP` uses local epoch)