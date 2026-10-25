# Pinned Todo & Stop Guard

> Design doc for persistent (pinned) todos and their **stop guard** — a
> natural-language condition that keeps a long-horizon turn alive.

## Motivation

The todo system (`src/context/shared/todo.ts`) is a temporary checklist: when
all items are marked done, the list is cleared. That works for ephemeral task
tracking but fails for two real-world use cases:

1. **Long-term reminders.** Some reminders should persist across many turns —
   an RDBMS schema definition, an invariant rule. A normal todo vanishes once
   "completed", taking the reminder with it.

2. **Long-horizon work.** Some goals cannot be honestly judged complete from
   inside a single turn: "until every test under `src/loop` passes", "until the
   migration is verified end-to-end". Left to its own judgment the agent
   declares victory early; there is no rule that makes it keep going.

The design answers both with two capabilities:

- **Pinned todos** — completed pinned todos are **not** auto-cleared; they
  persist as long-term reminders.
- **Stop guard (`preventStop`)** — a pinned todo may carry a condition. While
  it holds, the agent is **not allowed to end its turn**: the turn resumes
  with a note naming the reason.

## Design Decisions

### Why a separate `todo_pinning` tool

mycc restricts capabilities to the lead with **main-only tools**
(`scope: ['main']`), filtered out of `getToolsForScope('child')`. A dedicated
tool keeps `pinned`/`preventStop` out of the schema every teammate's LLM
sees — the control boundary is structural, not prompt-side.

- **Lead agent** sees `todo_create` + `todo_update` + `todo_pinning`.
- **Teammate** sees only `todo_create` + `todo_update`.

### Why the hash does not include the new fields

`computeHash` stays `name|done|note`. The hash exists to stop stale/
hallucinated writes: the LLM must echo the hash it last saw. `pinned` and
`preventStop` are written only through `todo_pinning`, which itself requires
the current hash — so the anti-hallucination guarantee holds without folding
them into the signature, and every existing caller stays unchanged.

### Why the guard is evaluated at STOP, not COLLECT

The guard's question is "may this turn end?", so it belongs where the turn
ends. Evaluating at STOP gives three properties:

1. **Every turn end is a checkpoint** — no dependence on the nudge throttle,
   so a long-horizon turn cannot slip past a guard because the nudge counter
   happened not to fire.
2. **Correct in auto mode** — STOP runs in `--auto`/`--daemon` (it returns
   PROMPT before AWAIT), so guards work where long-horizon runs actually live.
3. **No flicker** — the old COLLECT design reopened `done` todos, printing a
   "closed then reopened" contradiction in the nudge. A gate mutates nothing.

### Why `forkChat` (not `structuredChat`)

`structuredChat` bypasses the retry layer, accepts no `tools` (so it cannot
reuse the prompt cache) and has no `AbortSignal`. `forkChat` reuses the full
conversation prefix plus the complete tool schema, runs through `retryChat`,
and accepts a signal — so the check is cache-friendly, retried, and
ESC-interruptible. Because it returns free text, the prompt asks for a **JSON
array** and the caller parses defensively.

### One call, many guards

All candidates are batched into a **single** `forkChat` per STOP, so cost is
independent of guard count, and every guard is judged against one snapshot of
the transcript. Zero candidates → zero LLM calls.

### No safety cap — the escape is un-pinning

A HARD cap was considered and rejected: it fights the feature's purpose
(long-horizon running). The release paths are intrinsic:

- the condition stops holding, or
- the agent **un-pins** the todo (`pinned=false` also clears the guard), or
- the agent rewrites the guard with a narrower condition.

The note returned on a hold states this explicitly, so the release is always
discoverable.

#### What we DO count (and why it is not the rejected cap)

`TurnVars.preventStopHolds` records the number of **consecutive** turn ends a
guard has held (per todo id; cleared the moment that guard releases). It is
never consulted to make the decision — `checkPreventStop` still returns
`block: true` however long the guard has held. Its only job is to put the
count in front of the two readers that can act on it:

- **The hold note** escalates from the 2nd hold onward: *"Held N consecutive
  turn ends. If the previous attempt did not move this condition closer to
  being met, repeating it will not help: change your approach, narrow the
  condition, or release the guard with `todo_pinning(id=…, pinned=false)`."*
- **The hint round** renders a `## Stop Guards (held)` section listing each
  held guard with its count and condition, so the analyzer names the *guard*
  as the blocker instead of advising about the todo it protects.

Both are prompt-only and cost no extra LLM calls. The counter lives on
`TurnVars` deliberately: a hold returns `COLLECT` **without**
`markTurnBoundary()`, so the turn has not ended and `TurnVars` is exactly the
scope that survives a held continuation and is cleared at a real boundary.

#### Residual risk: an incapable model can still spin

There is **no hard cap**, so a guard whose condition an evaluator keeps
affirming holds the turn indefinitely. The loop costs a full LLM stage plus one
`forkChat` per iteration, and `agent-repl.ts`'s `while (true)` has no iteration
limit. The only exit is the agent unpinning the todo — and that is a **model
decision**.

This is accepted, for these reasons:

1. **The vulnerable surface is narrow.** A spinning guard requires an agent
   competent enough to create a pinned todo *and* write a `preventStop`
   condition that a capable evaluator keeps affirming, yet not competent enough
   to notice the condition cannot be met and unpin it. The two failure modes
   pull in opposite directions; a weak model usually fails earlier — an
   unstructured guard is filtered out by `getPreventStopCandidates()` (which
   requires `pinned && preventStop?.trim()`), so no guard means no gate and no
   cost at every STOP.
2. **A cap would be a regular correctness loss** on honest long-horizon work,
   which is the whole point of the feature. Trading a rare cost for a routine
   wrong answer is a bad trade.
3. **The escalation above makes the spin visible and self-documenting** — the
   hold count is in the note the model reads every iteration and in the hint
   round's evidence. Note this is *mitigation, not prevention*: an incapable
   model may ignore both.

Operator note: the spin is reachable whenever nothing can interrupt the loop —
i.e. **any unattended run**, regardless of `--auto` / `--daemon` (the flags do
not differ here; 停止 / ESC is available iff a WebUI or Coordinator is
attached). If you run unattended with guarded todos, watch for repeated
`guard #N held` verbose lines; unpin from the UI or restart with the guard
removed.

### Fail open

Every failure path — no candidates, `forkChat` throws, ESC, non-JSON output, a
malformed entry, or an evaluator that is "unsure" — returns `block: false`:
the turn may end. A guard must never trap a turn on an infrastructure hiccup;
it re-arms on the next STOP.

## Data Model

```ts
export interface TodoItem {
  id: number;
  name: string;
  done: boolean;
  note?: string;
  hash: string;          // SHA256(name|done|note), first 8 hex chars
  pinned?: boolean;      // completed pinned items survive auto-clear
  preventStop?: string;  // stop guard — condition that keeps the turn alive
}
```

```ts
export interface TodoModule {
  pinTodo(id: number, hash: string, pinned: boolean, preventStop?: string): TodoItem | null;
  getPreventStopCandidates(): TodoItem[];
}
```

Both fields are optional and default to `undefined`/`false`, so existing
callers are unaffected (`parent-context.ts` pins positionally without a guard).

## Behavior Changes in `Todo`

### Auto-clear respects pinned items

```ts
if (this.items.length > 0 && this.items.filter(i => !i.pinned).every(i => i.done)) {
  this.items = this.items.filter(i => i.pinned);
}
```

Only non-pinned items are dropped; pinned items always remain.

### `printTodoList` annotates pinned items

`📌` prefix, and `[preventStop: <condition>]` when a guard is set.

### `hasOpenTodo` considers guards

```ts
return this.items.some(i => !i.done) ||
       this.items.some(i => i.pinned && !!i.preventStop?.trim());
```

A pinned todo carrying a guard counts as open, so the COLLECT nudge keeps the
guard visible. Whitespace-only guards are treated as absent — the model layer,
not only the tool's validator, enforces "non-empty".

### `getPreventStopCandidates`

```ts
return this.items
  .filter(i => i.pinned && !!i.preventStop?.trim())
  .map(i => ({ ...i }));
```

`done` is deliberately **not** a filter: a guard is a property of the
condition, so an item that is still open but guarded gates the turn end just
like a completed one.

### `pinTodo`

Looks up the item, rejects on id-not-found or hash mismatch (the same
anti-hallucination contract as `updateTodo`), then sets `pinned` and
`preventStop`. Un-pinning **clears** the guard — that is the documented
release. The hash is not recomputed.

## The `todo_pinning` Tool

| Param | Type | Req | Description |
|---|---|---|---|
| `id` | integer | yes | Todo item ID |
| `hash` | string | yes | Current hash (anti-staleness) |
| `pinned` | boolean | yes | true to pin; false to unpin (also clears the guard) |
| `preventStop` | string | no | Stop guard — condition that keeps the turn alive |

`scope: ['main']` — teammates never see it.

## STOP State Integration

In `src/loop/states/stop.ts`, **after** the neglection wrap-up block and
**before** `presentResult()` / the auto-mode early return:

```ts
const guard = await checkPreventStop(env);
if (guard.block) {
  if (guard.note) triologue.note('SYSTEM', guard.note);
  return AgentState.COLLECT;   // turn CONTINUATION — markTurnBoundary() NOT called
}
```

Placement is load-bearing:

- **After** the neglection block → ESC always wins; a guard can never trap a
  user interrupt.
- **Before** `presentResult()` → no result letter-box for a turn that resumes.
- **Before** the auto early return → guards work in `--auto`/`--daemon`.
- **`COLLECT`, not `PROMPT`** → the turn continues; turn events, hook dedup and
  `totalTurns` all persist (the file's own boundary contract).

## `checkPreventStop` (`src/loop/states/stop-prevent-stop.ts`)

```
candidates = ctx.todo.getPreventStopCandidates()
if (candidates.length === 0) return { block: false }          # no LLM call
prompt = list {id, done-marker, name, note, condition} + ask for JSON array
try:
  result = await escAware(forkChat(messages, tools, prompt, signal, 'none'), () => '')
catch:                                     return { block: false }   # fail open
evaluations = parsePreventStopResult(result)                      # null → fail open
for ev in evaluations:
  skip unless typeof id/hash/hold are correct, hold === true
  candidate = candidates.find(c => c.id === ev.id && c.hash === ev.hash)
  skip if none                          # hash mismatch = hallucination
  return { block: true, note }          # TOPMOST held guard wins
return { block: false }
```

The gate never calls `updateTodo` — it is a gate, not a mutation.

### The note

```
Stop prevented — pinned guard #2 "Refresh materialized view user_summary" requires work to continue.
preventStop: "until the matview test passes".
Evaluator's stated grounds: the view has not been rebuilt since the last INSERT.
Keep working towards it; when the condition no longer holds the turn can end.
To release the guard early, unpin #2 (todo_pinning with pinned=false).
```

The user-defined condition is quoted verbatim (so a reader can sanity-check
it) and the grounds are explicitly attributed to the evaluator — the system
did not verify anything itself.

### forkChat prompt

```
You are deciding whether the agent is ALLOWED TO END ITS TURN.

Pinned todos carrying a stop guard:
#2 [open] "Refresh materialized view user_summary" — preventStop: "until the matview test passes"

Based on the conversation context above, for EACH todo decide whether its
preventStop condition still holds — i.e. whether the work it protects is
still unfinished.

Reply with ONLY a JSON array, no other text. Schema:
[
  {"id": <todo_id>, "hash": "<current_hash_of_this_todo>", "hold": <true|false>, "reason": "<one sentence>"}
]

Rules:
- "id": the todo ID as listed above (echo it back).
- "hash": the current hash of this todo item (from the todo list you have seen in conversation).
- "hold": true only if the condition clearly still holds and there is real work left.
- If the condition is satisfied, or you are unsure, use false.
- Do not hold the turn based on work that predates the todo's last completion.
```

The LLM supplies `hash` from what it has seen in the transcript, keeping the
anti-hallucination check active.

## Robustness

| Failure | Handling |
|---|---|
| No guards | No forkChat call; the turn may end. |
| `forkChat` throws | catch → verbose log → the turn may end. |
| ESC during the call | `escAware` returns `''` → parse fails → the turn may end. |
| Result not valid JSON | `JSON.parse`, else regex-extract `\[...\]`, else give up. |
| JSON but not an array | `Array.isArray` check → give up. |
| Entry typed wrong | per-entry `typeof` guards; skip the entry. |
| `id`/`hash` does not match | skip — prevents hallucinated holds. |
| `hold` false | skip. |
| Several guards held | the first (topmost) held guard's reason is reported. |

## Agent Prompt Documentation

The section lives in `buildPinnedTodoMessages()` (`src/loop/prompt-populators.ts`),
delivered through the project-context populator registry and registered
lead-only in `src/loop/agent-repl.ts` (never in `teammate-worker.ts` — a
teammate has no `todo_pinning` and no STOP-stage guard). It used to be
`buildPinnedTodoSection()` in `src/loop/prompts/common.ts`, inlined into the
lead's system prompt; it moved to a populator so one boundary-cadence channel
carries it (rebuilt at compact/clear, never per LLM call), leaving the system
prompt byte-stable. The open todo list itself is delivered by the separate
SHARED populator `buildTodoMessages()` (`same file`); the pinned populator
deliberately does not re-render the items. It is written in the agent's own
vocabulary — no state names, no `forkChat` — because the agent thinks in todos
and turns:

```
### Stop Guard
A pinned todo can carry a `preventStop` condition — a promise to yourself to keep working:
- Use `todo_pinning(id, hash, pinned=true, preventStop="<natural language condition>")` to set it.
- While the condition still holds you are NOT allowed to finish your turn: the turn continues,
  with a SYSTEM note naming the guard and why it held.
- Leave it out, or unpin the todo (`pinned=false`), to let the turn end.
- Use it for long-horizon work whose completion you cannot judge in a single turn
  (e.g. "until every test under src/loop passes", "until the migration is verified end-to-end").
- Example: `todo_pinning(id=2, hash="abc12345", pinned=true,
  preventStop="until the users and orders migrations both pass their tests")`
```

## Files

| File | Change |
|---|---|
| `src/types.ts` | `TodoItem.preventStop`; `TodoModule.pinTodo`/`getPreventStopCandidates` |
| `src/context/shared/todo.ts` | guard storage/clear, `📌` + `[preventStop: …]` printing, candidates, `hasOpenTodo` |
| `src/tools/todo_pinning.ts` | `preventStop` param (replaced `reactivate`) |
| `src/loop/states/stop-prevent-stop.ts` | NEW — the STOP gate (`checkPreventStop`, `parsePreventStopResult`) |
| `src/loop/states/stop.ts` | gate wired before `presentResult` / auto early-return |
| `src/loop/states/collect.ts` | COLLECT reactivation pass removed |
| `src/loop/prompts/common.ts` | "### Stop Guard" section |
| `src/tests/loop/states/stop-prevent-stop.test.ts` | parser + gate policy tests |

## Usage Example

```
# Schema as long-term pinned reminder (no guard)
todo_create(name="Schema: users table (id, name, email, created_at)")
todo_pinning(id=1, hash="<h1>", pinned=true)

# Long-horizon work guarded until verified
todo_create(name="Refresh materialized view user_summary")
todo_pinning(id=2, hash="<h2>", pinned=true,
  preventStop="until the matview test passes after the base-table change")

# user runs INSERT INTO users ...
#   → agent works; at the end of the turn STOP evaluates the guard
#   → hold → SYSTEM note → turn continues on the same task
# agent refreshes the matview, runs the test, marks #2 done
#   → guard no longer holds → the turn can end
```
