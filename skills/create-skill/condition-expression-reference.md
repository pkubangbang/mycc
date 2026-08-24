# Condition Expression Reference (Hookish Skills)

> **Read this only when writing a hookish `when` condition.** It is a separate
> file from `SKILL.md` so it does not bloat the backbone — load it on demand
> with `read_file(path="skills/create-skill/condition-expression-reference.md")`.

The compiled condition expression is a boolean expression evaluated against the
current tool call and the conversation history. It uses a safe jsep-based
evaluator — no `eval`, no `Function` constructor. Source of truth:
`src/hook/evaluator.ts` and `src/hook/sequence.ts`.

## Two Scope Levels

| Scope | Prefix | Cleared at turn boundary? | Use for |
|-------|--------|---------------------------|---------|
| **Turn** | `turn.*` | Yes (cleared on each new user query) | "since the user's last message" |
| **Session** | `session.*` | No (persists across turns; cleared only on compact/new session) | "at any point in this session" |

> **Common pitfall:** a `brief(confidence=10)` that marks task completion often
> lands in a turn with NO work tools (e.g. a brief-only turn reporting edits made
> in an *earlier* turn). A turn-scoped check (`turn.count('edit_file') > 0`) would
> miss it. Use session-scoped (`session.count('edit_file') > 0`) when the guard
> is about "did real work happen at all", not "did it happen this exact turn".

## Available Functions

### Turn-scoped (since last user query)

| Function | Signature | Returns | Example |
|----------|-----------|---------|---------|
| `turn.count` | `turn.count(toolSpec?)` | number | `turn.count('edit_file') > 0` |
| `turn.lastIndex` | `turn.lastIndex(toolSpec)` | number (-1 if not found) | `turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint')` |
| `turn.countResult` | `turn.countResult(toolSpec, pattern, maxChars?)` | number | `turn.countResult('bash', 'error') > 0` |
| `turn.hadError` | `turn.hadError(toolSpec?)` | boolean | `turn.hadError()` |

### Session-scoped (entire livelog since session start / last compact)

| Function | Signature | Returns | Example |
|----------|-----------|---------|---------|
| `session.count` | `session.count(toolSpec?)` | number | `session.count('edit_file') > 0` |
| `session.lastIndex` | `session.lastIndex(toolSpec)` | number (-1 if not found) | `session.lastIndex('edit_file') > session.lastIndex('bash#pnpm lint')` |
| `session.countResult` | `session.countResult(toolSpec, pattern, maxChars?)` | number | `session.countResult('bash', 'error') > 0` |
| `session.hadError` | `session.hadError(toolSpec?)` | boolean | `session.hadError()` |

### Global

| Function | Signature | Returns | Example |
|----------|-----------|---------|---------|
| `isPlanMode` | `isPlanMode()` | boolean | `!isPlanMode()` |

### Call context (the current tool call being evaluated)

| Accessor | Type | Example |
|----------|------|---------|
| `call.args.X` | any | `call.args.confidence == 10` |
| `call.metadata.X` | any | `call.metadata.isDestructive == true` |

`call.metadata` includes: `filePath`, `newLoc`, `existingLoc`, `isDestructive`.

## Tool Specs (three-class matching)

All `turn.*` and `session.*` count/lastIndex functions accept a **tool spec** —
a string that selects which tool calls to count. Three classes:

| Class | Syntax | Matches | Example |
|-------|--------|---------|---------|
| **Plain tool** | `"toolName"` | exact tool name match | `"edit_file"`, `"write_file"`, `"git_commit"` |
| **skill_load + name** | `"skill_load#skillName"` | `skill_load` whose `args.name` contains `skillName` | `"skill_load#plan_quality"` |
| **bash + prefix** | `"bash#commandPrefix"` | `bash` whose `args.command`, after clause-splitting by `;`/`&&`/`\|\|`, has a clause starting with `commandPrefix` | `"bash#pnpm lint"`, `"bash#git commit"` |

- Omit the tool spec entirely (`turn.count()` / `session.count()`) to count **all** tool calls.
- Use `'*'` as the tool spec in `countResult`/`hadError` to match all tools: `turn.countResult('*', 'error')`.

## Operators

| Category | Operators |
|----------|-----------|
| Comparison | `==` `===` `!=` `!==` `<` `<=` `>` `>=` |
| Arithmetic | `+` `-` `*` `/` `%` |
| Logical | `&&` `\|\|` `!` |
| Ternary | `cond ? a : b` |
| Grouping | `( ... )` |

Short-circuit evaluation is supported (`&&` and `||`).

## Literals & Member Access

- **Numbers:** `10`, `5`, `0`
- **Strings:** `'edit_file'`, `"bash#pnpm lint"` (single or double quotes)
- **Booleans:** `true`, `false`
- **Arrays:** `['edit_file', 'write_file']` — supports `.includes(x)` and `.indexOf(x)`
- **`undefined` / `null`** as identifiers
- **String methods:** `.includes()`, `.startsWith()`, `.endsWith()`, `.indexOf()`
- **Array methods:** `.includes()`, `.indexOf()`, `.length`

## Complete Examples

The `learn-from-past` skill's compiled condition:

```
call.args.confidence == 10 && !isPlanMode() && session.count() > 5 && (session.count('edit_file') > 0 || session.count('write_file') > 0 || session.count('bash') > 0)
```

Reads: "the current call is a `brief` with `confidence == 10`, AND we are not in
plan mode, AND more than 5 tool calls happened this session, AND at least one
edit/write/bash happened at any point in this session."

Another example — the `lint-after-edit` hook fires before `git_commit` if files
were edited but lint hasn't run since:

```
turn.count('edit_file') > 0 && turn.lastIndex('bash#pnpm lint') == -1
```

## Debugging

Use `--debug-eval` to print the parsed AST tree for each hook condition during
evaluation. Useful when developing hookish skills with custom `when` conditions.

## Pitfalls

- **No `hasAny` / `seq.*` functions:** older skills referenced `seq.hasAny(...)`
  or `seq.totalCount()`. These do NOT exist in the current evaluator. Use
  `session.count(toolSpec) > 0` (for "any") and `session.count() > N` (for total).
- **Turn vs session scope mismatch:** `turn.count('edit_file')` is 0 in a turn
  that only calls `brief`, even if edits happened earlier. Choose the scope that
  matches the *intent* of the guard.
- **`bash#prefix` matches a clause start, not a substring:** `"bash#git commit"`
  matches `git commit -m "x"` but NOT `echo "git commit"`. Clause-splitting is
  by `;`/`&&`/`||`.
- **Quoting:** string literals need quotes inside the expression
  (`'edit_file'`), but the `when` frontmatter field itself is a YAML string —
  use the natural-language form there; `skill_compile` produces the expression.