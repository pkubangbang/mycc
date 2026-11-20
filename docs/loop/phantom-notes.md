# Phantom Notes: TTL-Evicted Reminders and Egress Coalescing

> **Status:** Proposed (design approved, not implemented)
> **Date:** 2026-11-20
> **Branch:** `refactor/phantom-memory`
> **Scope:** `src/types.ts`, `src/loop/triologue.ts`, `src/loop/triologue/store.ts`,
> `src/loop/triologue/egress.ts` (new), `src/loop/reminders.ts` (new),
> `src/loop/state-machine.ts`, `src/loop/states/collect.ts`,
> `src/loop/states/collect-skill.ts`, `src/loop/hint-round.ts`,
> `src/loop/states/prompt.ts` (comment only)

## 1. Problem

The lead's conversation carries two independent defects that share one seam.

### 1.1 Recurring notes accumulate forever

COLLECT re-emits the same informational notes on a timer. Each emission is a
separate `triologue.note()` message that stays in the conversation for the rest
of the session:

| Note | Producer | Cadence | Payload |
|---|---|---|---|
| team status | `collect.ts:166` | every COLLECT pass | `printTeam()` snapshot |
| todo nudge | `collect.ts:317` | every 3 turns | full `printTodoList()` snapshot |
| brief nudge | `collect.ts:335` | every 5 turns | a **byte-identical** fixed string |
| worktree nudge | `collect.ts:352` | every 5 turns | `listWorktrees()` list |

These are *state re-snapshots*: each one makes its predecessors redundant — the
newest todo list is a superset of every older one, and the brief nudge is the
literal same bytes. Carrying every historical copy spends context on nothing.

Contrast the notes that must stay: `MAIL`, steering notes, `URGENT`/ESC, upload
paths, `hand_over` output, stop-guard holds. Those are *events* — a one-shot
fact no later message repeats, so evicting one loses information permanently.

### 1.2 Egress emits a run of consecutive user messages

`note()` stores each note as its own `role: 'user'` message. That is deliberate
and load-bearing (see the invariant at `triologue.ts:485`), but nothing converts
the run into a triologue-parity shape on the way out. `tpFix` has **no
`user_after_user` kind** (`tp-fix.ts:36-41` lists `user_after_tool`,
`note_after_tool`, `tool_no_assistant`, `duplicate_assistant`,
`agent_after_system`, `invalid_sequence`), so a run ships as N consecutive user
turns and correctness rests on both providers tolerating it.

A single COLLECT pass can emit five notes (serve-state, mail, todo, brief,
hint), so 3–5 consecutive user turns is routine, not an edge case.

## 2. Design decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Eviction is **TTL-based**, not keep-last-per-family | A snapshot whose state became empty is never superseded; keep-last would leave the last todo list or team roster showing stale contents forever. TTL ages it out on its own. `ttl: 1` reproduces "only the newest survives" exactly. |
| D2 | The clock is **assistant turns**, not wall time | Position is exact, replayable and needs no new plumbing (count `agent()` messages after the note). A wall clock would make the prompt depend on when it was rendered, defeating the prompt cache for reasons unrelated to the conversation. |
| D3 | Filtering lives in the **egress projection**, not in the store | The store is the audit record and the source for hook conditions, the skill dedup ledger and the hint analyzer's self-escalation. Mutating it would break all four. |
| D4 | Coalescing is **general**, not lead-only | `MessageStore` is shared with `triologue-lite.ts`, so teammates get parity behaviour for free. They simply never mark phantom, so the filter is a no-op for them. |
| D5 | `mail` is **never evicted** | Mail is durably recoverable (`collectMails()` appends to `readmail.jsonl` before returning), but each item is a unique one-shot directive whose value is arriving in attention exactly once. |
| D6 | `phantom` stays **in the JSONL** | Additive audit key recording which notes were phantom — useful for post-hoc debugging of what the model did and did not see. |

## 3. Data model

### 3.1 The marker

`src/types.ts`, on `Message`:

```ts
phantom?: { family: string; ttl?: number };
```

- `family` — stable reminder identity. Grouping key for debugging; not shown to
  the model.
- `ttl` — **assistant turns the note survives after its own position.**
  **Absent means never expires.**

Absent-means-infinite is deliberately not `ttl: Infinity`: `emit()` serializes
the message into the transcript, and `JSON.stringify(Infinity)` is `null`, so a
restored session would read `ttl: null` — a value that means "expire
immediately" rather than "never expire".

The marker never reaches a provider: `PROVIDER_MESSAGE_KEYS` in `store.ts` is an
allow-list, so any runtime-only field is dropped by default. Add `phantom` to
that comment's list of dropped fields.

### 3.2 Message shape on the wire

```
STORE (unchanged, per-note identity preserved)
  [user "[SYSTEM] [team status — snapshot] …"]
  [user "[MAIL] Mail from …"]
  [user "[REMINDER] Update your todos. …"]        ← phantom {family:'todo-nudge', ttl:4}
  [user "[REMINDER] Provide a brief status …"]    ← phantom {family:'brief-nudge', ttl:1}
  [user "[HINT] Problem Analysis: …"]             ← phantom {family:'hint', ttl:1}

EGRESS (getFullMessages)
  [user "[SYSTEM] [team status — snapshot] …\n\n[MAIL] Mail from …\n\n[REMINDER] Update your todos. …"]
                                                  ← one coalesced user message
```

Coalescing joins adjacent note messages with `\n\n`. Each `[CATEGORY] ` prefix is
retained inside the blob, so every content anchor readers rely on
(`isHintNote`, hint-round's own filter) still works on the raw store, and the
model still sees unambiguous attribution.

## 4. The egress projection

New `src/loop/triologue/egress.ts`, two pure functions:

```
ageOut(messages)    // walk from the tail, counting assistant turns seen;
                    // drop a phantom note when turnsAfter >= ttl.
                    // Absent ttl → never dropped.
coalesce(messages)  // merge adjacent user messages that begin with a
                    // [CATEGORY] prefix, joined by "\n\n".
```

`MessageStore.getFullMessages()` (`store.ts:438`) becomes:

```
system → projectContext → coalesce(ageOut(conversation))
```

**Order is forced.** Coalescing first would build a blob from notes that are
about to be dropped, and a note ageing out of the middle of a run would be
unrecoverable.

**Attribution safety.** A real user query has no `[CATEGORY] ` prefix, so it
breaks a run naturally and is never absorbed into a note blob. The prefix list is
`REMINDER | HINT | URGENT | SYSTEM | MAIL` (`NoteCategory`, `types.ts`), matching
the established practice in `collect-skill.ts:86` and `hint-round.ts`'s
`/^\[(?:REMINDER|WRAP_UP)\]/` filter.

`getFullMessages()` is already the single outbound chokepoint, so every consumer
inherits the behaviour with no new call sites:

| Consumer | Path |
|---|---|
| main LLM call (`llm.ts` → `triologue.getMessages()`) | `triologue.ts:1007` |
| compact focus fork | `compact.ts:183` |
| segment archiving | `segment-archive.ts:163` |
| teammate LLM call | `triologue-lite.ts:521` |

Consumers that bypass it and keep full visibility (by design):

| Consumer | Path | Why it must see everything |
|---|---|---|
| hook conditions | `sequence.ts:290` (`getMessagesRaw`) | counters and skill markers must not shift |
| skill dedup ledger | `collect-skill.ts:306` (`getMessagesRaw`) | prevents re-suggesting the same skill forever |
| hint analyzer | `hint-round.ts` (`getMessagesRaw`) | deliberately reads its own prior `[HINT]` notes to escalate instead of repeating |
| compact summary prompt | `compact.ts` (`getRawMessages`) | the summary is built from the full record |
| token accounting | `getTokenCount()` | see §7 |

## 5. Reminder registry

Only the four **timer-driven** nudges move into the registry — they are the ones
that today duplicate the same shape (counter → threshold → emit → re-arm) with
three different conventions on two different tiers:

| Reminder | Field | Today |
|---|---|---|
| todo nudge | `TurnVars.nextTodoNudge` = 3 | `state-machine.ts:84`, reset `:259-261`, `:295-297` |
| todo dedup | `TurnVars.lastTodoState` | `state-machine.ts:85` |
| brief nudge | `TurnVars.nextBriefNudge` = 5 | `state-machine.ts:86` |
| worktree nudge | `MachineEnv.nextWtNudge` = 0 sentinel | `state-machine.ts:78` |

### 5.1 Interface

New `src/loop/reminders.ts`:

```ts
export interface Reminder {
  /** Stable identity: the phantom family key and the counter key. Never shown to the LLM. */
  id: string;
  /** The note() category — decides the [CATEGORY] prefix the model reads. */
  category: NoteCategory;
  /** Fire every N turns. */
  every: number;
  /** Assistant turns the note survives in the provider view. */
  ttl: number;
  /** Cheap short-circuit: does this reminder have anything to say at all? */
  isActive(env: MachineEnv, turn: TurnVars): boolean;
  /** Produce the note body from live context, or null to stay silent.
   *  MUST be side-effect free (see §5.3). */
  build(env: MachineEnv, turn: TurnVars): Promise<string | null>;
}
```

### 5.2 Registry contents

| id | category | `every` | `ttl` | `build()` |
|---|---|---|---|---|
| `team-status` | `SYSTEM` | 3 | 2 | `printTeam()` unless `'No teammates.'` |
| `todo-nudge` | `REMINDER` | 3 | 4 | `Update your todos. ${printTodoList()}` |
| `brief-nudge` | `REMINDER` | 5 | 1 | the fixed brief string |
| `worktree-nudge` | `REMINDER` | 1 | 8 | `listWorktrees(cwd)` lines |

`worktree-nudge` uses `every: 1` to preserve today's semantics. Its current
`0`-sentinel means "check every pass, emit only when worktrees exist"; a genuine
`every: 5` would let a worktree created and removed inside one window go
unmentioned. Suppression comes from the identical-body rule and `ttl: 8`
instead of the counter.

`todo-nudge` folds in `lastTodoState`: the identical-body rule (below) subsumes
"reset the counter when the snapshot changed".

### 5.3 Runner

```
1. builds = Promise.all(active reminders → build())     ← parallel, side-effect free
2. for (r of REMINDERS)                                 ← registry order, serial
     if (body === r.lastBody) { re-arm; continue }
     r.lastBody = body
     note(r.category, body, undefined, { phantom: { family: r.id, ttl: r.ttl } })
     re-arm counter to r.every
```

**Fan-out on build, serial on emit.** Parallelizing `build()` buys the async
reads (git, IPC); parallelizing the *emit* would make transcript piece order a
function of which `await` resolved first. `transcript.ts` collation and the
serve projection both read that order, so it must stay deterministic.

**`build()` must be side-effect free** because every build runs before any
emit. Today `runTodoNudge` mutates `turn.nextTodoNudge` and `turn.lastTodoState`
inside its own body; that moves into the runner.

**Identical-body suppression** is a runner responsibility, not a per-reminder
one: if the produced body is byte-identical to the last emission, re-arm without
emitting. This kills the redundant brief nudge (an identical string every 5
turns) and the repeated todo list, at zero context cost.

State: one `Map<string, number>` on `MachineEnv`, replacing the four scattered
fields and both reset sites.

## 6. Producers that stay put

These keep their current producer and gain only the marker. They do not fit the
registry, and the reason is recorded here so a later refactor does not
re-litigate it.

| Site | Category | Change | Why not a reminder |
|---|---|---|---|
| `collect.ts:104` serve-state | `SYSTEM` | none | module-level edge flag + exported `reconcileServeStateAfterClear()` called from `agent-repl.ts:328` and `slashes/clear.ts:48`; fires twice per session |
| `collect.ts:145` ESC | `URGENT` | none | event, carries a live directive |
| `collect.ts:150,152` mail | `MAIL` | `phantom: {family:'mail'}` (no ttl) | **drain, not a producer**: `collectMailsAndInput()` returns `firstSteerNote` which flows into `skillSuggester.suggestSkill(env, turn, firstSteerNote)` (`collect.ts:401`); a `string \| null` return has nowhere to put it |
| `collect.ts:193` steering | `REMINDER` | none | user-authored direction; loss is permanent |
| `collect.ts:248` uploads | `REMINDER` | none | event; the paths are the only record |
| `hint-round.ts:574` hint | `HINT` | `{family:'hint', ttl:1}` | async, confusion-gated (`CONFUSION_THRESHOLD = 10`) |
| `collect-skill.ts:411` skill hint | `HINT` | `{family:'skill-hint', ttl:6}` | async, query/cooldown-gated |

`hint-round.ts` emits through its private `note()` helper (`:604`), which must
forward `opts`. The compact resume brief (`compact.ts`) is **not** marked — it is
the floor anchor: after a compaction it is the only brief left, so marking it
would leave a reader with no anchor at all.

## 7. Plumbing: the deferred-input path

`note()` may be deferred when tool calls are outstanding. `DeferredInput`
(`triologue.ts:41`) buffers `{kind:'note', category, text, hookName}`
(`deferInput` at `:350`, guarded at `:461`) and is replayed through
`this.note(...)` at `:386`.

**The marker must be carried on `DeferredInput`.** Otherwise a note deferred
behind an outstanding tool batch is replayed without its family and lives
forever — a silently unbounded leak that only appears mid-batch.

`triologue-lite.ts` needs no change: teammates never set the marker, and its
`DeferredInput` is a separate type.

## 8. Consequences

### 8.1 Prompt cache

- **Coalescing** moves the invalidation boundary from "the newly appended note"
  to "the last assistant message" — the tail block is rewritten each turn, so
  the cache is lost from one message earlier. This is strictly smaller than the
  per-turn hint churn already accepted today.
- **TTL expiry** invalidates at the expiring note's own position, independent of
  any user action. For `todo-nudge` (`ttl: 4`) that is at most one drop per
  4-turn window. It is inherent to never lingering, and it is bounded.

### 8.2 Token accounting

`getTokenCount()` still counts phantom notes, so `needsCompact()` measures a
prompt that is no longer being sent. Auto-compaction therefore fires slightly
**early**. This is conservative and accepted; it is not compensated in this
change. If it ever matters, subtract phantom tokens in the overflow check only,
keeping `getTokenCount()` as the store's true size for `/token`.

### 8.3 View divergence

The store, `getRaw()`, the JSONL backlog and the WebUI transcript projection all
retain every note. Only the provider view diverges. This is the intended
property: the user's view *should* record that a nudge was emitted, and
`phantom` in each JSONL line documents it.

### 8.4 Stale comment to correct

`prompt.ts:383` and the header of `prompt-upload-rollback.test.ts:7` both assert
"`triologue.note()` merges into the last user message". That is false since the
no-merge refactor. The `prompt.ts` copy is load-bearing prose justifying an
ordering constraint ("resolve wrap-up BEFORE the steering/file-drain block")
that no longer has a hazard behind it — it invites someone to re-derive logic
from a stale premise. Correct the prose; keep the logic.

## 9. Tests

New:

- `src/tests/loop/phantom-ttl-egress.test.ts`
  - notes stay individual messages in `getRaw()`
  - `ttl: 1` survives its own turn, drops after the next assistant message
  - `ttl: 4` ages out on turn 5 with no replacement
  - absent `ttl` never expires
  - three adjacent notes coalesce into one user message, in order, all prefixes
    intact
  - a real user query breaks the run and is never absorbed
  - an unmarked note passes through uncoalesced when isolated
  - teammate path (`triologue-lite`) coalesces and never filters
- `src/tests/loop/reminder-registry.test.ts`
  - each reminder fires at its `every` cadence
  - identical body re-arms without emitting
  - state change re-arms without waiting for the counter
  - emit order follows registry order, not build resolution order
  - a deferral mid-batch preserves the phantom family

Updated (each edit justified as an intended behaviour change, never silenced):
`triologue.test.ts:80`, `triologue-piece-contract.test.ts:82`,
`serve-history-invariant.test.ts:74`.

Gate: `vp check` and `vp test`.

## 10. Rejected alternatives

| Alternative | Rejected because |
|---|---|
| Mutate the store (sweep or `truncateTo`) | Index drift for `wrapUpMark` (already delta-shifted for compact, `triologue.ts:866-871`) and `titleAnchorEnds`; `assistant→assistant` adjacency needs `duplicate_assistant` repair; breaks the `one note = one message` invariant |
| Rewrite one persistent hint message in place | The WebUI's single-record-stream projection would never observe the rewrite; the backlog would lose a line per hint |
| `ttl: Infinity` for never-evict | `JSON.stringify(Infinity)` → `null` in the transcript; a restored session reads it as expire-immediately |
| Wall-clock TTL | Non-deterministic prompt across replays; cache invalidates on the hour |
| Keep-last-per-family instead of TTL | A snapshot whose state became empty is never superseded and lingers forever |
| `projectContext` populator as the never-evict channel | Stateless and rebuilt only at `compact`/`clear`, so it can express "always" but never "every N turns" |
| A `bg-status` reminder | No bg injection exists in COLLECT today; it would be a new capability, not a refactor. Also blocked on a real bug: `printBgTasks()` (`bg.ts:233`) trims finished tasks beyond `MAX_FINISHED_TASKS` **after** listing them, so a pid shown in the list can answer "No background task with pid N" when the model calls `bg_print(pid)` for its `tail`. Needs a pure `formatBgTasks()` split first. |
| Include `serve-state` / `mail` in the registry | Both fail "pure function of `(env, turn)`": serve-state owns module-level state and an exported reset; mail is a drain whose return value feeds the skill suggester |

## 11. File inventory

New:

- `src/loop/triologue/egress.ts`
- `src/loop/reminders.ts`
- `src/tests/loop/phantom-ttl-egress.test.ts`
- `src/tests/loop/reminder-registry.test.ts`

Edited:

- `src/types.ts` — `Message.phantom`
- `src/loop/triologue.ts` — `note()` opts, `DeferredInput` carrier
- `src/loop/triologue/store.ts` — `getFullMessages()` projection
- `src/loop/state-machine.ts` — counters → one map
- `src/loop/states/collect.ts` — call the runner; three `run*Nudge` helpers dissolve
- `src/loop/states/collect-skill.ts` — mark the hint
- `src/loop/hint-round.ts` — mark the hint; forward opts in its note helper
- `src/loop/states/prompt.ts` — stale comment only

Untouched: `src/context/shared/bg.ts`, `src/tools/bg_print.ts`,
`src/context/shared/mail.ts`, `src/loop/triologue/transcript.ts`,
`src/loop/triologue/compact.ts`, `src/loop/triologue/truncate.ts`,
`src/loop/triologue/tp-fix.ts`, `src/loop/triologue-lite.ts`.
