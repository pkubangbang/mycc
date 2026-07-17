# Pinned Todo & Reactivation

> Design doc for enhancing the todo system with persistent (pinned) todos and
> automatic, condition-based reactivation via `forkChat`.

## Motivation

The todo system (`src/context/shared/todo.ts`) is a temporary checklist: when
all items are marked done, the entire list is cleared. This works for ephemeral
task tracking but fails for two real-world use cases:

1. **Long-term reminders.** Some reminders should persist across many turns —
   for example, an RDBMS schema definition that must always be in the agent's
   awareness, or an invariant rule. A normal todo vanishes once "completed",
   taking the reminder with it.

2. **Associated events.** Some tasks must be re-done when an upstream event
   recurs. For example, a materialized view must be refreshed whenever its
   base tables change. Today there is no mechanism to express "when the base
   table changes, reopen this todo" — the agent cannot reliably notice the
   dependency, and there is no rule to enforce it.

This design adds two capabilities on top of the existing todo system:

- **Pinned todos** — completed pinned todos are **not** auto-cleared; they
  persist as long-term reminders.
- **Reactivation** — a pinned todo may carry a natural-language
  *reactivation condition*. After each nudge cycle, the system uses
  `forkChat` to evaluate whether the condition is met against the current
  conversation context; if so, the todo is automatically reopened.

## Design Decisions

### Why a separate `todo_pinning` tool (not new params on `todo_create`/`todo_update`)

mycc already has a mature pattern for restricting capabilities to the lead
agent: **main-only tools** carry `scope: ['main']`, and `getToolsForScope('child')`
filters them out. Teammates fetch their tools via
`silentLoader.getToolsForScope('child')`, so a main-only tool is invisible to
them by construction.

If we instead added `pinned`/`reactivate` parameters to `todo_create` and
`todo_update`, the parameters would still appear in the tool schema the
teammate's LLM sees, and the LLM could attempt to use them. A dedicated
`todo_pinning` tool (scope `['main']`) is the clean control boundary:

- **Lead agent** sees `todo_create` + `todo_update` + `todo_pinning`.
- **Teammate** sees only `todo_create` + `todo_update`.

No prompt-side workaround is needed; the tool never enters the teammate's
tool list.

### Why hash does not include the new fields

`computeHash` stays `name|done|note`. The hash's sole purpose is to prevent
LLM hallucination (stale updates): the LLM must echo the hash it last saw, so
it cannot blindly overwrite a todo it last read N turns ago. `pinned` and
`reactivate` are set only via `todo_pinning`, which itself requires the current
hash — so the anti-hallusion guarantee is preserved without folding the new
fields into the hash. This keeps `todo_create`/`todo_update` and all existing
callers (`hand_over.ts`, `tm_create.ts`, etc.) byte-for-byte unchanged.

### Why `forkChat` (not `structuredChat`)

`structuredChat` (both Ollama and DeepSeek providers) bypasses the retry layer,
does not accept `tools` (so it cannot preserve the prompt cache), and has no
`AbortSignal` support. `forkChat` reuses the full conversation prefix plus the
complete tools schema, keeping the prompt-cache hit, runs through `retryChat`
(transient-error retries), and accepts a signal. The reactivation evaluation is
non-critical, but it runs every few turns, so cache reuse and retry matter.

Because `forkChat` returns free text (not structured), the prompt asks the LLM
to return a **JSON array**, and the caller parses defensively (see Robustness).

### Reactivation runs on the same throttle cycle as the nudge

The COLLECT state already throttles the todo nudge with a counter (`nextTodoNudge`,
reset to 3 on state change, decremented each pass, fires the REMINDER at 0).
Reactivation reuses that exact cadence and runs **immediately before** the
nudge in the same pass. This gives three properties at once:

1. **Same frequency.** No extra LLM round-trips beyond the existing nudge cycle.
2. **No contradiction.** The nudge prints the todo list *after* reactivation has
   already reopened any candidates — the LLM never sees a "closed" todo that
   the next message reopens.
3. **Cache locality.** The forkChat happens right before the next LLM turn, on a
   fresh, accurate todo list.

### Reactivation is automatic and direct

The forkChat result drives `todo.updateTodo(id, hash, name, done=false)`
directly. The lead LLM does **not** decide whether to reopen — it only sees a
`SYSTEM` note informing it that a reactivation happened, then proceeds to act
on the reopened todo. This keeps the LLM in the loop without making it the
arbiter of the condition.

## Data Model

### `TodoItem` (additive, optional fields)

```ts
export interface TodoItem {
  id: number;
  name: string;
  done: boolean;
  note?: string;
  hash: string;
  pinned?: boolean;       // NEW — completed pinned items survive auto-clear
  reactivate?: string;     // NEW — natural-language reactivation condition
}
```

Both new fields are optional and default to `undefined`/`false`. Existing
callers are unaffected.

### `TodoModule` (additive methods)

```ts
export interface TodoModule {
  // ... existing methods unchanged ...
  pinTodo(id: number, hash: string, pinned: boolean, reactivate?: string): TodoItem | null;
  getReactivationCandidates(): TodoItem[];
}
```

## Behavior Changes in `Todo`

### Auto-clear respects pinned items

BEFORE:

```ts
if (this.items.length > 0 && this.items.every(i => i.done)) {
  this.items = [];
}
```

AFTER:

```ts
if (this.items.length > 0 && this.items.filter(i => !i.pinned).every(i => i.done)) {
  this.items = this.items.filter(i => i.pinned);
}
```

When every **non-pinned** item is done, only non-pinned items are dropped;
pinned items (done or not) remain. With no pinned items present the behavior is
identical to the original (the whole list clears).

### `printTodoList` annotates pinned items

Pinned items are prefixed with `📌` and, when a `reactivate` condition exists,
suffixed with `[reactivate: <condition>]`. The existing `[ ]` / `[x]` marker
and `hash` remain unchanged.

### `hasOpenTodo` considers reactivation candidates

```ts
hasOpenTodo(): boolean {
  return this.items.some(i => !i.done) ||
         this.items.some(i => i.pinned && i.done && i.reactivate);
}
```

A completed pinned todo with a reactivation condition counts as "open" so the
nudge/reactivation pass keeps firing for it.

### `pinTodo`

```ts
pinTodo(id, hash, pinned, reactivate?): TodoItem | null
```

Looks up the item, rejects on id-not-found or hash mismatch (same anti-hallusion
contract as `updateTodo`), then sets `pinned` and `reactivate`. The hash is
**not** recomputed — the integrity signature stays `name|done|note`.

### `getReactivationCandidates`

Returns items where `pinned && done && reactivate` — i.e. completed pinned todos
that carry a reactivation condition and therefore need evaluation.

## The `todo_pinning` Tool

```ts
{
  name: 'todo_pinning',
  description: 'Pin/unpin a todo. Pinned todos are not auto-cleared when all ' +
    'todos are completed, persisting as long-term reminders. Optionally set a ' +
    'reactivation condition (natural language): after each nudge cycle the ' +
    'system evaluates completed pinned todos against the conversation context ' +
    'and automatically reactivates those whose condition is met.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'Todo item ID to pin/unpin' },
      hash: { type: 'string', description: 'Current hash of the item (must match)' },
      pinned: { type: 'boolean', description: 'true to pin, false to unpin' },
      reactivate: { type: 'string',
        description: 'Natural language reactivation condition (only with pinned=true). ' +
          'Example: "when the users table is modified (INSERT/UPDATE/DELETE)"' },
    },
    required: ['id', 'hash', 'pinned'],
  },
  scope: ['main'],   // ← teammates never see this tool
  handler: (ctx, args) => { /* calls ctx.todo.pinTodo(...) */ },
}
```

## COLLECT State Integration

The existing todo-nudge block:

```ts
if (ctx.todo.hasOpenTodo()) {
  const currentTodoState = ctx.todo.printTodoList();
  if (currentTodoState !== turn.lastTodoState) {
    turn.nextTodoNudge = 3;
    turn.lastTodoState = currentTodoState;
  }
  turn.nextTodoNudge--;
  if (turn.nextTodoNudge === 0) {
    triologue.note('REMINDER', `Update your todos. ${ctx.todo.printTodoList()}`);
    turn.nextTodoNudge = 3;
  }
}
```

becomes:

```ts
if (ctx.todo.hasOpenTodo()) {
  const currentTodoState = ctx.todo.printTodoList();
  if (currentTodoState !== turn.lastTodoState) {
    turn.nextTodoNudge = 3;
    turn.lastTodoState = currentTodoState;
  }
  turn.nextTodoNudge--;
  if (turn.nextTodoNudge === 0) {
    // (4a) Reactivation FIRST — reopen pinned todos whose condition is met
    await checkReactivation(env, triologue);
    // (4b) Nudge SECOND — prints the now-up-to-date todo list
    triologue.note('REMINDER', `Update your todos. ${ctx.todo.printTodoList()}`);
    turn.nextTodoNudge = 3;
  }
}
```

### `checkReactivation`

```
candidates = ctx.todo.getReactivationCandidates()
if (candidates.length === 0) return                         # nothing to do
prompt = build list of {id, name, condition} + ask for JSON array reply
try:
  result = await forkChat(getMessages(), allTools, prompt, undefined, 'none')
catch err:
  verbose log; return                                       # forkChat error → skip this turn
evaluations = parseJSONLoose(result)                        # direct parse, else regex [\s\S], else give up
if (evaluations == null) { verbose log; return }
for ev in evaluations:
  if (typeof ev.id !== number || typeof ev.hash !== string || typeof ev.reopen !== boolean) continue
  if (!ev.reopen) continue
  candidate = candidates.find(c => c.id === ev.id && c.hash === ev.hash)
  if (!candidate) continue                                  # hash mismatch (hallucination) → skip
  ctx.todo.updateTodo(candidate.id, candidate.hash, candidate.name, false, candidate.note)
  triologue.note('SYSTEM', `Pinned todo #${candidate.id} "${candidate.name}" reactivated. ` +
                          `Condition "${candidate.reactivate}" was met. ${ev.reason}`)
```

### forkChat prompt

```
You are evaluating whether any pinned todos should be reactivated (marked back to not done).

Pinned todos to evaluate:
#2 "Refresh materialized view user_summary" — Condition: "when the users table or orders table is modified (INSERT/UPDATE/DELETE)"
#5 "Rebuild search index" — Condition: "when the products table is modified (INSERT/UPDATE/DELETE/TRUNCATE)"

Based on the conversation context above, for EACH todo, determine if its reactivation condition has been met.

Reply with ONLY a JSON array, no other text. Schema:
[
  {"id": <todo_id>, "hash": "<current_hash_of_this_todo>", "reopen": <true|false>, "reason": "<one sentence>"}
]

Rules:
- "id": the todo ID as listed above (echo it back).
- "hash": the current hash of this todo item (from the todo list you've seen in conversation).
- "reopen": true only if the condition has clearly been met in the recent conversation.
- If no relevant event has occurred, or you are unsure, use false.
- Do not reactivate based on events that happened before the todo was last completed.
```

The LLM must supply `hash` by reading it back from the conversation — this keeps
the anti-hallusion check active: a fabricated hash will not match the candidate
and the entry is silently skipped.

## Robustness

| Failure | Handling |
|---|---|
| No reactivation candidates | Skip entirely — no forkChat call. |
| `forkChat` throws | `try/catch` → verbose log, return. Main loop continues; next cycle retries. |
| Result not valid JSON | Try `JSON.parse`; on failure, regex-extract `\[...\]` and retry; on failure, verbose log, skip. |
| Result is JSON but not an array | `Array.isArray` check; skip if not. |
| Entry missing/typed wrong fields | `typeof` guards per entry; skip the bad entry, keep going. |
| `id`/`hash` does not match a real candidate | Skip — prevents hallucinated reactivation. |
| `reopen` false | Skip — no state change. |

Every failure path is silent (verbose-only) and never blocks the agent loop.

## Agent Prompt Documentation

Pinned-todo and reactivation semantics are documented in the **lead-only**
prompt builders — `buildSoloNormalPrompt` and `buildTeamNormalPrompt`. The
teammate prompt (`buildTeammatePrompt`) is **not** updated: teammates cannot
see `todo_pinning`, so documenting the feature there would only confuse.

The added section lives under "## Task Management":

```
### Pinned Todos
Regular todos are auto-cleared when all are completed. Pinned todos persist:
- Use `todo_pinning(id, hash, pinned=true)` to pin a todo after creating it with `todo_create`.
- Pinned todos are NOT removed when all todos are completed.
- Use pinned todos for persistent reminders (e.g., schema definitions, invariant rules, materialized view refresh tasks).

### Reactivation
Pinned todos can be automatically reactivated (marked back to not done) when a condition is met:
- Use `todo_pinning(id, hash, pinned=true, reactivate="<natural language condition>")` to set a reactivation condition.
- After each nudge cycle, the system evaluates completed pinned todos' reactivation conditions against the conversation context via LLM.
- If the condition is met, the todo is automatically reactivated — you will see a SYSTEM note about the reactivation.
- Example: `todo_pinning(id=2, hash="abc12345", pinned=true, reactivate="when the users table or orders table is modified (INSERT/UPDATE/DELETE)")`
```

## Files Touched

| File | Change |
|---|---|
| `src/types.ts` | `TodoItem` += `pinned?`, `reactivate?`; `TodoModule` += `pinTodo`, `getReactivationCandidates` |
| `src/context/shared/todo.ts` | auto-clear skips pinned; `pinTodo`; `getReactivationCandidates`; `hasOpenTodo`; `printTodoList` 📌 |
| `src/tools/todo_pinning.ts` | NEW — main-only tool |
| `src/context/shared/registry.ts` | register `todoPinningTool` |
| `src/loop/states/collect.ts` | `checkReactivation` before nudge, same throttle cycle |
| `src/loop/agent-prompts.ts` | lead-only prompt sections |
| `src/tests/context/todo.test.ts` | NEW — pinned survival, pinTodo hash guard, candidates, hasOpenTodo |
| `MYCC.md` | user-facing docs for pinned todos + reactivation |

## RDBMS Usage Example

```
# Schema as long-term pinned reminder
todo_create(name="Schema: users table (id, name, email, created_at)")
todo_pinning(id=1, hash="<h1>", pinned=true)

# Materialized view refresh — auto-reactivates on base table change
todo_create(name="Refresh materialized view user_summary")
todo_pinning(id=2, hash="<h2>", pinned=true,
  reactivate="when the users table or orders table is modified (INSERT/UPDATE/DELETE)")

# user runs INSERT INTO users ...
#   → COLLECT cycle: checkReactivation() → forkChat judges condition met
#   → updateTodo(#2, done=false) + SYSTEM note
#   → nudge prints updated list (#2 now [ ])
# lead LLM sees SYSTEM note, refreshes the matview, marks #2 done again
# next base-table change → reactivates again
```