# Reminder retention: cadence + retention as loop-owned policy

**Status:** design, revision 2 — incorporates the two independent design reviews
(issues #3 store/triologue mechanics, #4 registry/cadence) against current source
**Supersedes:** the read-time fold (`src/loop/triologue/fold-notes.ts`)
**Related:** `docs/loop/note-taxonomy.md`, `docs/loop/todo-lineage-ring.md`,
`docs/loop/pinned-todo-prevent-stop.md`

## 1. Motivation

**(a) The todo list goes stale.** The lead's todo reminder fires every N COLLECT
rounds. The note it emits is a `NUDGE`, and `foldStaleNudges` replaces any `NUDGE`
with `[NUDGE] (earlier nudge — content elided)` as soon as **one** assistant row
follows (`STALE_ASSISTANT_ROWS = 1`). Between firings the model reads a
placeholder, not a list — it can be acting on a checklist it last saw several
rounds ago. Raising the cadence to 5 makes this worse, not better.

**(b) Foldability is decided by category, which conflates unrelated notes.**
`NUDGE` carries four unrelated things (team snapshot, todo nudge, brief nudge,
worktree nudge) and `REMINDER` carries four more (steering, uploads, hand-over
output, hook messages). `docs/loop/note-taxonomy.md` §3 already records the
damage the old `REMINDER` did by conflating user direction with a todo nudge.
The same defect remains one level down: two `NUDGE` rows are indistinguishable,
so they cannot have different lifetimes.

**(c) A parallel mechanism is being removed.** An earlier attempt added
`src/loop/todo-nudge.ts`, a `TODO_STATE` note category and a `leadTodoWriteSeq`
restart signal in TOOL. It is redundant — `printTodoList()` already renders `📌`
and `[preventStop]`, so any pin/unpin also changes the rendered state that
COLLECT compares — and it introduced a second foldability rule and an off-by-one
(it armed `INTERVAL + 1` in TOOL and skipped COLLECT's own re-arm, firing a round
late). All of it is deleted.

## 2. The model

Every reminder carries two loop-owned numbers:

| field | meaning |
|---|---|
| `every` | fire the imperative every N COLLECT rounds. **Clamped to ≤ 5** (`Math.min(n, 5)`). |
| `retention` | copies of that reminder that survive: `'zero'` = 0, `'once'` = 1 (newest), `'keep'` = unlimited. |

In one line: **cadence buys freshness; retention governs stale copies.** They are
independent, which is why the todo reminder is `once` + `every: 5` rather than
`keep`.

### 2.1 Topic is the identity; category is derived — and topic must survive deferral

A topic belongs to exactly one category, so in-scope producers name the topic and
let the registry resolve both the `[CATEGORY]` prefix and the retention:

```
noteTopic(topic, message, tag?)          // collect.ts helper: registry → category → note()
note(category, message, tag?, topic?)    // primitive; unchanged for everyone else
```

**Compatibility rule — found while sizing the diff.** `note()` has ~45 call sites
in 8 modules, and two groups are explicitly out of scope: the teammate loop
(`src/context/teammate-worker.ts`, ~18 calls) and the lite triologue
(`triologue-lite.ts:255`, which replays the same `DeferredInput`). Renaming the
first parameter to `topic` would make every one of those resolve to no registry
row — either a crash or a silent retention opt-out in a loop this design does not
own. Instead **`topic` is an optional trailing argument on the existing
primitive**: no topic ⇒ no `meta.topic` ⇒ the row matches no sweep key ⇒ `keep`
by construction. In-scope producers supply text + topic only (the category
parameter is gone at *their* call sites, via `noteTopic`), while the ~20
out-of-scope calls compile and behave exactly as today with zero edits. The
registry is therefore a list of *opted-in* topics, not a whitelist that breaks
whoever forgets to register.

**Required addition the reviews found:** `DeferredInput` stores the category *by
name* (`triologue.ts:43` — `{ kind: 'note'; category: NoteCategory; … }`, replayed
by re-entering `note(item.category, …)` at `:399`). So the deferred record must
carry **`topic`**, not just derive it at the emit site. Otherwise every note
deferred behind an outstanding tool batch (`ledger.size > 0`, `triologue.ts:473`)
loses its topic and can never be swept — a silent total retention failure on
exactly the notes that arrive mid-batch.

**The category is not changing.** `[NUDGE]` stays `[NUDGE]`; the prefix is still
baked into content at `triologue.ts:486/494`, and two things depend on it:
`hint-round.ts:418`'s analyzer filter (`^\[(?:NUDGE|REMINDER|WRAP_UP)\]`) and the
fold/anchor semantics. `NoteCategory` remains the closed union, so every derived
category is still one of the existing literals.

### 2.2 `meta.topic` is in-memory only — it must be stripped at both persistence boundaries

`Message` has no `meta` today (`types.ts:97-119`: `reasoning_content`,
`tool_call_id`, `hook_name`, `synthetic`). Adding `meta?: { topic?: string }` is
safe for **provider egress** without further work: `PROVIDER_MESSAGE_KEYS`
(`store.ts:504`) is an allow-list applied by `toProviderMessage` (`:519`) inside
`getFullMessages()` (`:478`), so a new field is dropped by default — the same
mechanism that keeps `synthetic` internal.

It is **not** automatically safe for **persistence**. Two paths serialise the
whole message object:

- `TranscriptWriter.append` destructures only `kind` and `user_origin`, then
  spreads the rest into `JSON.stringify` (`transcript.ts:759-768`).
- `compact.ts` writes `JSON.stringify(msg)` over `getRawMessages()`
  (`compact.ts:114-127`, fed at `:157`).

Unless both are updated, `meta.topic` reaches the session JSONL, `/load`
restoration and every `session-introspect` recipe. **Decision: strip `meta` at
both boundaries**, alongside `kind`/`user_origin`. `meta` is memory-only by
design; a restored session's rows carry no topic, match no sweep key, and are
never blanked — which is the intended legacy story (§7) rather than an accident.

## 3. Registry

Owned by the COLLECT stage — `src/loop/states/collect.ts`. This is the only place
either number is written. A topic maps to exactly one category.

| topic | category | every | retention | emit site |
|---|---|---|:---:|---|
| `todo` | `NUDGE` | 5 | `once` | `collect.ts` `runTodoNudge` — the live `printTodoList()` |
| `peer` | `NUDGE` | 5 | `once` | `collect.ts` `runTodoNudge` — active-channel routing block |
| `brief` | `NUDGE` | 5 | `zero` | `collect.ts` `runBriefAndWorktreeNudges` |
| `worktree` | `NUDGE` | 5 | `zero` | `collect.ts` `runBriefAndWorktreeNudges` |
| `team` | `NUDGE` | 5 | `zero` | `collect.ts` team-status snapshot (`printTeam()`) |
| `steering` | `REMINDER` | — | `keep` | `collect.ts` steering drain |
| `upload` | `REMINDER` | — | `keep` | `collect.ts` uploads; `prompt.ts` stale uploads |
| `handover` | `REMINDER` | — | `keep` | `prompt.ts` hand-over captured output |
| `hook` | `REMINDER` | — | `keep` | `states/hook.ts` deferred hook messages (hook name stays the `tag`) |
| `mail` | `MAIL` | — | `keep` | `collect.ts` mail drain |
| `urgent` | `URGENT` | — | `keep` | `collect.ts` ESC directive |
| `system` | `SYSTEM` | — | `keep` | `collect.ts` Web UI start/stop |
| `hint` | `HINT` | — | `keep` | `hint-round.ts`, `states/collect-skill.ts` |

### 3.1 `peer` is its own topic — it is not part of `todo`

The active-channel routing block currently rides inside the todo nudge (same
`note('NUDGE', …)` call). Under `once` retention the todo list would blank it,
and the block carries the exact `mail_to(name="<sid>/lead")` routing the lead
needs to reply to a peer. Separate topic, same category, so the two rows have
independent lifetimes without needing content markers.

### 3.2 Why each non-obvious row

- `brief` / `worktree` are imperatives. Once obeyed — or once the worktrees are
  removed — a retained copy is a false instruction.
- `team` is self-described "snapshot, informational", re-emitted every round
  while teammates exist. Blanking the previous copy loses nothing and removes a
  stale roster the moment a teammate finishes.
- `hook` is `keep` for a **hard, non-negotiable** reason: `hook/sequence.ts:281`
  `hasSkillInConversation()` scans `content` for `'[Hook: <name>]'` /
  `'[Skill: <name>]'` to prevent duplicate injection. **No topic whose content is
  probed there may ever be downgraded to `zero`/`once`** — blanking would defeat
  the duplicate check. This is the one place where content really does
  participate in identity; record it as a constraint on the registry.
- `steering`, `upload`, `handover`, `mail`, `urgent`, `system`, `hint` are
  **events**: no later COLLECT reproduces their content, so dropping one loses
  information permanently.
- Rows that **never enter `note()`** are structurally `keep` and out of scope:
  `[WRAP_UP]` (`triologue.ts:919`), `[COMPACT]`, the `[TP_RECOVERY]` bridge row
  (`tp-fix.ts`), and project-context populator pairs. The sweep cannot see them
  because they carry no topic; naming them here stops a future reader assuming
  the table is exhaustive of *all* injected rows.
- The teammate loop (`src/context/teammate-worker.ts`) is **out of scope**: own
  3-round counter, own `REMINDER` category, no topic, never matched.

## 4. The sweep

Runs **from COLLECT**, once per round, before the LLM call — not from the append
path.

Match key: `meta.topic === topic`. Nothing else.

**The `user_origin !== true` guard is NOT usable here.** The first review found
it vacuous in memory: `addMessage` pushes the bare message
(`triologue.ts:1189-1196`), and `user_origin` is stamped only on the *journal
copy* by `emit()`, then re-added by the writer (`transcript.ts:761`). On
`store.getRaw()` the flag is `undefined` even for genuine user rows, so
`user_origin !== true` is always true and protects nothing. Protection comes from
**topic ownership alone**: only a registry producer sets `meta.topic`, so a
genuine user row can never match. The earlier test-plan item asserting
`user_origin` is never blanked is dropped as untestable-in-fact.

| retention | when scanned |
|---|---|
| `keep` | never |
| `once` | only in the round that appends a new row for that topic; blank all but the newest |
| `zero` | every COLLECT; blank the previous round's row, so it is visible to exactly one LLM call |

"Zero" needs a definition of *unreplaced*: a `zero` row is blanked at the next
COLLECT **for that topic**, whether or not a new row was appended. That is what
makes "visible for exactly one LLM call" true even when the reminder's condition
has stopped holding (the row is still there, so it still has to be blanked).

### 4.1 Eviction mutates `content` IN PLACE; it never replaces the row

The sweep assigns `m.content = placeholder` on the existing object. It must
**not** build copies or a new array. The first review found the reason: the
segment archiver snapshots the boundary message object and later aborts when
`messageAt(anchorEnd) !== fingerprint.msg` (`segment-archive.ts:107-113`,
`:182`). Replacing objects changes identity for every blanked row and silently
turns the next queued archive into "store changed during summarization" — a
benign-looking feature loss. The old read-time fold could return copies precisely
because it never touched the store; a write-side sweep cannot.

The placeholder keeps the `[CATEGORY] ` prefix so `hint-round.ts:418`'s analyzer
filter still matches; elided content must not reach the analyzer.

What in-place content mutation preserves (all CONFIRMED by review):
length, TRUE-array indices and role sequence — so compaction cursors,
`truncateTo`'s pure `length =` cut (`store.ts:326`), rollback marks and
`getRaw()`'s hole filter are unaffected; no `assistant → assistant` transition,
so no TP bridging is needed. Serve history dedupes by `seq`, not by text
(`serve-clients.ts:165`), and `recap-note` hashes the call id (`briefNote.ts:51`),
so neither is disturbed.

**The sweep targets `store.messages` only.** Never run it against
`getFullMessages()`: `toProviderMessage` returns the *same object* when no extra
keys are present, so a sweep there would mutate `projectContext` in place and
corrupt the cache prefix.

### 4.2 The lookback is bounded by `every`

The scan walks backwards and stops after `every` rounds of that topic; it never
walks the whole session. Cost is bounded and independent of session length, and
eviction can only touch rows inside the recent window, which keeps the prefix
ahead of it byte-stable between calls.

### 4.3 Token count measures the live snapshot

After a sweep that blanked at least one row, recompute the count so `tokenCount`
describes the in-memory snapshot and the reclaimed budget really defers
compaction. `recomputeTokenCount()` exists (`store.ts:348`) and measures
`this.messages` — but **prefer `getRaw()`'s hole-filtered view**: the raw array
can contain `undefined` entries after a wrap-up rollback (documented at
`store.ts:120-129`), and `estimateTokens` dereferences `message.content`
(`utils/token.ts:79`). Ordering is safe: every `tokenCount` consumer reads it
later — `needsCompact()` at the top of the LLM stage (`llm.ts:68` →
`triologue.ts:692`) — so a blanking round's reclaim genuinely defers that round's
compaction.

Incremental bookkeeping stays correct: `incrementTokenCount` adds per append
(`store.ts:341`, called at `triologue.ts:1191`), so a post-recompute append is
consistent, and a blanked/empty content costs nothing (`utils/token.ts:79`).

## 5. Cadence — three counters, not one

The reviews refuted the earlier "collapse into one `tick()`" plan. Each counter
has semantics a shared abstraction distorts:

| counter | where | semantics |
|---|---|---|
| `nextTodoNudge` | `TurnVars` (2 init sites) | reset when the rendered todo/peer state changes; decrement; fire at 0 |
| `nextBriefNudge` | `TurnVars` | reset by the **brief tool call** in TOOL (`tool.ts`), not by state |
| `nextWtNudge` | `env` | `0` is a "probe every round" sentinel; re-arms to 5 only while worktrees exist, and stays 0 otherwise |

So: keep three counters, give each its `every` from the registry, clamp in one
helper. **No `tick()` abstraction.**

Worked example (the acceptance case): a `todo_update` in the TOOL pass of round 3
→ COLLECT(4) sees the changed rendered list → arms 5 → the imperative prints at
**COLLECT(8)**, with the list visible on rounds 4–7. (Today's code fires at 9
because it arms 6 and never re-arms — the deleted module's off-by-one.)

**Known hole, confirmed by review:** `runTodoNudge` is guarded by
`ctx.todo.hasOpenTodo() || activeChannels.length > 0`. When a write completes the
last open todo, the guard is false, so the countdown neither decrements nor
fires — and the *last* `once` row is the list the model needs to see emptied.
Fix as part of this work: run the decrement and the sweep unconditionally; skip
only the *emit* when there is nothing to say.

## 6. What is deleted

| path | reason |
|---|---|
| `src/loop/triologue/fold-notes.ts` + `src/tests/fold-notes.test.ts` + `src/tests/fold-notes-integration.test.ts` | a read-time projection is a second mechanism for a job the sweep does; `STALE_ASSISTANT_ROWS`, `FOLDED_NUDGE_TEXT`, `isNudge`, `isTodoStateNote` all go |
| the two `foldStaleNudges` call sites in `store.ts` | `getConversationForProvider` (`:425`) and the `getFullMessages` conversation loop (`:478`) |
| `src/loop/todo-nudge.ts` + `src/tests/loop/todo-nudge.test.ts` | redundant module from the earlier attempt |
| `TODO_STATE` member of `NoteCategory` (`src/types.ts`) | no longer a category |
| `leadTodoWriteSeq` / `lastTodoWriteSeq` on `TurnVars`; the TOOL hook in `states/tool.ts` | redundant restart signal |

**`getConversationForProvider()` is kept, not deleted.** Its docstring contract —
report what the provider sees rather than true text — stays true and
self-documenting after blanking, and it keeps the distinction available if a
read-time projection ever returns. It becomes `return this.getRaw();`. Its single
production caller (`triologue.ts:1137`, `getContextBudget()` → `/token`) is
behaviourally identical either way; it never feeds compaction
(`compact.ts:173/191` uses `getFullMessages()`) or `needsCompact()`
(`triologue.ts:692` reads `tokenCount`).

## 7. Migration and legacy data

- **Sealed sessions / `/load`:** `meta` is stripped at the journal boundary
  (§2.2), so restored rows carry no topic, match no sweep key and are never
  blanked. The restored backlog is a different object from the in-memory
  triologue; the sweep re-establishes freshness on the first COLLECT of the new
  session. No migration, nothing lost.
- **Compaction** summarises from `getRaw()` as before; blanked rows are still
  present, so the summariser sees the placeholder rather than a missing row.

## 8. Risks

| risk | mitigation |
|---|---|
| Sweeping changes what the provider sees mid-conversation | bounded to the `every` window; the boundary already moves when a nudge is appended |
| Object identity broken → segment archiving silently skips | mutate `content` in place, never replace the row (§4.1) |
| Sweep run against the wrong array → projectContext corrupted | sweep `store.messages` only (§4.1) |
| A content-probed note blanked (`[Hook: …]` duplicate check) | `hook` is `keep`; constraint recorded in §3.2 |
| `meta` leaking to the session JSONL | stripped at both persistence boundaries (§2.2) |
| A deferred note losing its topic | `DeferredInput` carries `topic` (§2.1) |
| Last-todo completion skips the decrement | run counter and sweep unconditionally (§5) |
| Token recompute cost | only on rounds that blanked something |

## 9. Test plan

Sweep:
- `keep` leaves every row intact — one case per `keep` topic category.
- `once` leaves exactly one unblanked row in its appending round.
- `zero` leaves none at the following COLLECT, and none when no replacement row
  is appended.
- Two rows of the same category but different topics (`todo` vs `peer`) do not
  evict each other.
- A row older than the `every` window is never touched.
- Array length, object identity and role sequence are unchanged by a sweep
  (`expect(before[i]).toBe(after[i])`).
- A blanked row still starts with `[NUDGE] ` so the analyzer filter matches.
- `tokenCount` drops by the blanked content's estimate on a blanking round and is
  untouched on a no-op round.

Metadata: `meta` never appears in a provider message (assert against
`PROVIDER_MESSAGE_KEYS`), and never appears in a transcript record or a
compaction snapshot line.

Cadence: TOOL(3) → COLLECT(8), list visible on 4–7; and the
completes-the-last-todo case still decrements (no stuck countdown).

Gate: fold/loop/state-machine suites → full suite → `npx vp check`. The three
pre-existing `src/tests/tools/test-utils.ts` `TS2552 'expect'` errors are
byte-identical to HEAD and stay out of scope.

## 10. Residual open questions

1. `team` as `zero` vs `once` — unchanged from revision 1; `zero` recommended.
2. Import direction: the registry lives in `collect.ts`, which already imports
   from `state-machine.js`. If the sweep lives beside `note()` in
   `triologue.ts`, it must not import `collect.ts` or the cycle is real. Plan:
   pass the resolved `retention` into `note()`, so `triologue.ts` needs no
   registry import.
3. `brief`'s reset lives in TOOL (`tool.ts`) today. Keep it there; the registry
   supplies only `every`, so TOOL reads one number and no state.
