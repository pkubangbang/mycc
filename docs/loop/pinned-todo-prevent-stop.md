# Pinned Todo & Prevent-Stop Guard

> Design doc for the `preventStop` STOP GUARD: a pinned todo that can forbid the
> agent from finishing its turn until a stated state has been reached — and,
> since the stall-prevention extension, until the turn stops ENDING in a
> backward-ask while that state is unmet.

## Motivation

The todo system (`src/context/shared/todo.ts`) is a temporary checklist: when
all items are marked done, the list is cleared. Pinned todos survive that
clear so long-term reminders stay visible.

A reminder, however, is passive: it is visible in the prompt, and whether the
agent acts on it is left entirely to the model's goodwill. Some conditions must
be *enforced*, not remembered — "do not stop before the migration is rolled
back", "tests for the module you touched actually pass", "the schema change is
documented". The agent can claim it is finished while such a condition is still
unmet, and nothing in the loop contradicts it.

`preventStop` closes that gap: a pinned todo may carry a natural-language guard
that **blocks the end of the turn** while it holds.

### What it replaced

The earlier design gave pinned todos a `reactivate` condition: a completed
pinned todo whose condition was judged met got **reopened** (marked not done).
That changed what the checklist displayed but not what the loop allowed — the
turn could still end, and the agent could ignore the reopened item. Reopening
was a suggestion; a guard is a constraint. `preventStop` therefore takes over
the same field slot and REPLACES reactivation outright (the COLLECT pass that
evaluated `reactivate` is gone).

## Design Decisions

### The guard is a statement about state, not a reminder

The field is deliberately named `preventStop`, not `reactivate` or `until`:
the evaluator is asked one question — *has the required state been verifiably
reached?* — and a "no" has exactly one consequence, holding the turn open.

Guards are judged on **evidence**, not intent: the agent saying it will do
something is not proof it did. The evaluation prompt states this explicitly.

### One batched `forkChat` per STOP

Every guard is judged in a SINGLE call:

- `forkChat` preserves the full conversation prefix and the complete tools
  schema, so the prompt cache still hits (unlike `structuredChat`, which
  bypasses the retry layer and cannot carry tools).
- `toolChoice: 'none'` — the fork may not invoke tools.
- One call per STOP, not one per guard, so five guards cost the same as one.
- Wrapped in `escAware`: ESC (terminal or WebUI "停止") aborts the call
  immediately, so a slow endpoint cannot pin the state machine at STOP.

The fork is asked for a JSON array and parsed defensively (see Robustness).

### Staleness detection by id + hash

The evaluator must echo each guard's `id` AND `hash`. This is **not** an
anti-hallucination device — the hash is shown in the prompt, so an invented
verdict carrying the copied hash verifies. What it detects is staleness: a
guard released, re-pinned or edited between the prompt and the verdict has a
different hash, so its verdict is discarded instead of holding the turn on a
deadline that no longer exists. The defences against confabulation are the
EVIDENCE rule in the prompt and the hold escalation in `stop.ts`. The gate never mutates the todo: releasing a guard is the
agent's job (`todo_pinning(..., pinned=false)`), which keeps one authority over
the item's state.

### The gate sits after ESC, before presentation

In `stop.ts` the gate runs AFTER the neglection block and BEFORE
`presentResult()` and the auto-mode early return:

- **ESC always wins.** A user interrupt is never blocked by a guard; the
  neglection path returns PROMPT first.
- **Both modes are covered.** Auto mode short-circuits STOP early (it hands off
  to AWAIT); if the gate ran after that return, a guard would be silently
  ignored in exactly the mode where nobody is watching.
- **A hold returns COLLECT WITHOUT `markTurnBoundary()`.** The turn genuinely
  continues: `turn.*` events, hook dedup counters and `totalTurns` all persist.

The LLM learns about the hold through a `[STOP BLOCKED]` SYSTEM note naming the
todo, the guard text, and the evaluator's grounds.

### Stall prevention: judge the ending SHAPE, not only the world state

A guard that judges only *world state* ("is the goal reached?") misses a
second, independent failure: the agent can end its turn with a **backward-ask**
— "Should I now…?", "Which of these do you prefer?", "Do you want me to
continue?" — while the goal is plainly unmet. In interactive mode that is
merely annoying; in **auto mode** it is a hard stall. A question-shaped final
reply routes `STOP → PROMPT → AWAIT`, and AWAIT *parks* the loop waiting for an
external event (a user message, a peer mail) that will never arrive. Nothing
pushes the agent back to work, so the run ends with the goal unmet and the
process idling.

The guard therefore asks a second question of the same batched fork: **what
shape is the agent's final assistant message?**

| `ending` | Meaning | Gate action |
|---|---|---|
| `complete` | A statement of finished work / result. | Legacy `held` behaviour. |
| `blocked` | A HARD blocker (missing credential, destructive ambiguity, irreversible decision) that genuinely cannot proceed without the user. | **Allow stop, overriding `held`** — a real blocker is a legitimate stop, never deflected. |
| `question` | A backward-ask to the user (preference / confirmation / "should I…?") asked INSTEAD of acting. | Deflect when the goal is **not verifiably met** (`held !== false`). |

The verdict loop reduces this to two flags:

- `stall = (ending === 'question') && !goalMet` — the new case.
- `held = v.held || stall` — classic goal-unmet OR a stall.

`blocked` is checked *first* and short-circuits to "allow stop" before `held`
is consulted; that is the bug the first draft of this extension contained
(a declared blocker was being held because the goal was, by definition, unmet).

Because the ending classification rides in the SAME forkChat call as the guard
verdicts, stall prevention costs **zero extra round-trips**. The
`ending` field is optional in the schema and the prompt says "omit if you
cannot tell": an absent or invalid `ending` degrades to the legacy
`held`-only gate — fail-open is preserved.

### Two notes, two remedies

The hold note branches on the cause, because the fix differs:

- `[STOP BLOCKED]` (goal unmet) → "satisfy the guard with verifiable evidence,
  or release it if it no longer applies."
- `[STALL PREVENTED]` (backward-ask with the goal unmet) → "the user is not
  available to answer preference/confirmation questions in auto mode; proceed
  with the most reasonable action toward the goal and **state your assumption
  explicitly**, or — if genuinely blocked — declare the blocker as a
  STATEMENT and call `brief` with low confidence."

Escalation from the 2nd consecutive hold is likewise cause-specific: a stall
that repeats means the agent kept re-asking, so the note names the count and
both exits (act on an assumption / declare a blocker / release the guard).
`TurnVars.preventStopStalls` records the cause per todo id so the hint round
can label it.

### Escalation, and the accepted spin risk


`TurnVars.preventStopHolds` counts consecutive holds per todo id. It lives on
TurnVars precisely because a hold does not end the turn, so nothing that
normally clears state runs. From the SECOND hold the note escalates: it names
the count and the only two ways out (satisfy the guard with verifiable
evidence, or release it).

There is deliberately **no hard cap**. A cap would need a policy for "what
happens after N holds" — silently releasing the guard would defeat the feature,
and forcing PROMPT would turn a user-visible gate into a silent escape. The
residual risk is that an evaluator never accepts the evidence and the loop
keeps working; that is visible (the note and the brief both report the hold,
the hint round names it) and bounded in practice by the agent releasing the
guard. If this ever spins in the field, the fix belongs in the evaluator's
prompt (demand concrete evidence) or in an opt-in cap — not in silently
ignoring a guard.

## Data Model

```ts
export interface TodoItem {
  id: number;
  name: string;
  done: boolean;
  note?: string;
  hash: string;
  pinned?: boolean;       // completed pinned items survive auto-clear
  preventStop?: string;   // STOP-GUARD condition (replaces `reactivate`)
}

export interface TodoModule {
  // ... existing methods unchanged ...
  pinTodo(id: number, hash: string, pinned: boolean, preventStop?: string): TodoItem | null;
  getPreventStopTodos(): TodoItem[];
}
```

`getPreventStopTodos()` returns pinned todos with a guard and is **not**
filtered on `done`: the guard describes the state the work must reach, which is
independent of the todo's own checkbox.

### Hash stays `name|done|note`

`pinned` and `preventStop` are set only via `todo_pinning` (scope `['main']`),
which itself requires the current hash, so the anti-hallucination contract is
preserved without folding the new fields into the signature. Every existing
`todo_create` / `todo_update` caller is untouched.

## Behaviour Changes in `Todo`

| Method | Change |
|---|---|
| `pinTodo(id, hash, pinned, preventStop?)` | Sets/overwrites the guard when pinning; clears it when unpinning. Hash never recomputed. |
| `getPreventStopTodos()` | NEW — `pinned && preventStop`, copies. |
| `printTodoList()` | Annotates a guarded item with `[preventStop: <condition>]`. |
| `hasOpenTodo()` | Back to "some item is not done": a guard blocks the END, so it must not also drive the "keep working" nudge — otherwise the nudge and the hold fight over the same iteration. |

## STOP Integration

```
handleStop(env, turn)
  ├─ neglection block            → PROMPT (ESC always wins)
  ├─ checkPreventStop(env)       → held or stall? note [STOP BLOCKED] / [STALL PREVENTED];
  │                                return COLLECT (no turn boundary)
  ├─ presentResult()             → the final answer is displayed
  ├─ auto mode?                  → PROMPT → AWAIT
  └─ interactive teammate wait   → COLLECT / PROMPT as before
```

`checkPreventStop` returns `{ held, guard, reason, stall? }`. `stall` is set
only when the cause is a backward-ask with the goal unmet; `held` is set for
both causes, which is what keeps the branch above a single condition.


## Robustness

| Failure | Handling |
|---|---|
| No guards | Return immediately — no forkChat. |
| `forkChat` throws | verbose log → no hold (fail-open). |
| Non-JSON / non-array | Try `JSON.parse`, else regex-extract `[...]`; still bad → no hold. |
| Malformed entry | `typeof` guards per entry; skip it, keep going. |
| `id`/`hash` mismatch | Skip — hallucination / stale guard. |
| ESC during the fork | `escAware` aborts → no hold; the interrupt is honoured. |
| Missing / invalid `ending` | Verdict still applies to goal state; no stall flag — degrades to the legacy `held`-only gate. |
| `ending: 'blocked'` | Allow stop regardless of `held` — a declared hard blocker overrides the guard. |
| Several guards held | Report the topmost (lowest id) — one actionable guard per STOP. |


Fail-open is the rule: a broken evaluator must never trap the agent.

## Observability

- `[STOP BLOCKED]` SYSTEM note: todo id + name, guard text, grounds, hold count
  from the 2nd hold, and the release call.
- `[STALL PREVENTED]` SYSTEM note: same fields, plus the fact that the last
  message was a question and the remedy (state an assumption and act, or
  declare a hard blocker as a statement). Escalating holds name the stall
  count.
- `ctx.core.brief('info', 'stop', ...)` on every hold — `Stop guard held
  (#<id>, hold <n>)` or `Stall prevented (#<id>, hold <n>) — backward-ask
  deflected`.
- The hint round's OUT-OF-BAND sections gain `## Stop Guards (held)`, so a
  confused analyzer sees the guard, the hold count AND the cause
  (`STALL (backward-ask with the goal unmet) — act on a stated assumption or
  declare a hard blocker` vs `goal unmet — satisfy the guard with concrete,
  verifiable evidence`) instead of inventing a blocker from repeated "I'm
  done" claims.
- The gate draws the spinner `Checking stop guards...` for the duration of its
  own fork — the terminal is otherwise blank at exactly the moment the turn
  was NOT allowed to end (see the spinner comment in
  `stop-prevent-stop.ts`).


## Files Touched

| File | Change |
|---|---|
| `src/types.ts` | `TodoItem.reactivate` → `preventStop`; `TodoModule.pinTodo` param; `getReactivationCandidates` → `getPreventStopTodos` |
| `src/context/shared/todo.ts` | guard storage, annotation, `getPreventStopTodos`, `hasOpenTodo` |
| `src/tools/todo_pinning.ts` | `preventStop` parameter + lead-facing description |
| `src/loop/states/stop-prevent-stop.ts` | NEW — batched evaluation, parse, fail-open; `ending` classification + `stall` flag |
| `src/loop/states/stop.ts` | gate placement, `[STOP BLOCKED]` / `[STALL PREVENTED]` notes, escalation, `preventStopStalls` |
| `src/loop/state-machine.ts` | `TurnVars.preventStopHolds`, `TurnVars.preventStopStalls` |
| `src/loop/states/collect.ts` | reactivation pass removed from the nudge cycle |
| `src/loop/prompts/common.ts` | Prevent-Stop Guards section replaces Reactivation |
| `src/loop/hint-round.ts` | `## Stop Guards (held)` out-of-band section, with the hold cause (stall vs goal-unmet) |
| `src/tests/**` | todo/pinning tool tests rewritten; parser + gate tests added; stall cases added to `loop/states/stop-prevent-stop.test.ts` |

## Usage Example

```
# Enforced outcome: the turn cannot end until the check passes
todo_create(name="Fix the flaky todo test")
todo_pinning(id=1, hash="<h>", pinned=true,
  preventStop="the todo test passes three times in a row and lint is clean")

# ... agent tries to stop ...
#   → STOP: checkPreventStop() → forkChat judges the guard HELD
#   → SYSTEM: [STOP BLOCKED] Pinned todo #1 … ; returns to COLLECT
# ... agent runs the test, it passes ...
#   → STOP: gate judges NOT HELD → turn ends normally

# Guard no longer applies (scope changed):
todo_pinning(id=1, hash="<current>", pinned=false)
```

### Stall example (the case the guard used to miss)

```
# Guard pinned: "the migration is rolled back and the suite is green"
# ... agent runs out of obvious next steps ...
# ... agent replies: "The suite is updated. Should I also drop the legacy
#     table, or keep it around for a release?"          ← a backward-ask, goal unmet
#   → STOP: checkPreventStop() → forkChat returns
#         {"held": true, "ending": "question", ...}
#   → stall = true → [STALL PREVENTED] … returns to COLLECT
#   → the loop does NOT park in AWAIT waiting for an answer that never comes
# ... agent states an assumption and acts, or declares a hard blocker ...
#   → its next reply ends in a STATEMENT → turn may end
```

