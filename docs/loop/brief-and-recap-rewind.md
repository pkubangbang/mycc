# Brief and Recap-Rewind Design

> Context management through **rewind anchors** and an **observer** that
> decides when to fold — never through a tool the model chooses to call.

## Overview

A `brief` is a **rewind anchor** once the conversation has moved past it.
A *fold* (historically "recap") collapses the conversation back to one such
brief: everything after it is replaced by the note carried in that brief's own
tool result, so the brief's text survives inside the note.

The model never folds its own context. A **recap signal** — a small, dedicated
observer context that reads only the brief stack — decides; the HOOK stage then
runs the forks and the rewrite. See
[`docs/loop/auto-recap-plan.md`](auto-recap-plan.md) for the full rationale.

```
query → tool1 → brief(A) → letterbox → query → tool2 → brief(B) → tool3 → letterbox
        ─────── span A ───────          ─────── span B ───────
                                                              ↑ brief turn → HOOK step 4a
                                                                signal: fold to A?
                                                                forks → rewind → note
```

**The anchor rule** (the private `resolveAnchor()` / `MessageStore.briefIndices`)
— a brief anchors **iff**:

1. it is **not synthetic** (see "Incidental vs. floor briefs"),
2. **its tool result exists** (an orphan `brief` call with no answer is not an
   anchor — a rewind would have nowhere to write the note), and
3. at least one message of **ACTIVITY** follows its round-trip (the assistant
   `brief` call *and* the tool result answering it).

Rule 3 is what makes a lone brief a non-anchor: the newest brief is where the
conversation currently stands, so there is nothing below it to collapse. The
moment *anything* lands after it — a tool call, a query, **or even another
brief** — it becomes history and a fold candidate. There is no separate
"consumed" marker and no pristine-result test: after a fold the anchor's
round-trip is the last thing in the history, so rule 3 alone walks the anchor
backwards.

**Fold machinery is not activity.** A fold has two outcomes and neither leaves
activity behind:

- **success** — the span is truncated and the note is written into the anchor
  `brief`'s own tool result, so the anchor's round-trip IS the last thing in the
  history;
- **failure** — nothing is rolled back. The span survives with its full detail;
  only a `loopEvents` entry and (for the user) a warning line are produced.

The old `recap` META-TOOL is gone, and with it the special case that skipped a
`recap` round-trip when measuring "activity after the brief". Legacy transcripts
containing such round-trips are out of scope and are not parsed.

### The fold candidates

`Triologue.getFoldCandidates()` returns, **oldest → newest**, every brief that
satisfies the anchor rule:

```ts
{ hash, message, id, spanMessages, spanTokens }
```

- `hash` — 8 chars of a digest of `id`; an **internal** key that lets the signal
  name a target. It is never shown to the model.
- `message` — the brief's own text (the only content the signal reads, clipped
  to 200 chars).
- `id` — the brief's tool-call id: the **compare-and-swap token** carried across
  the forks to `rewindToLastBrief()`.
- `spanMessages` / `spanTokens` — the region the fold deletes (`chars / 4`).

## The signal (the observer)

`src/loop/recap-signal.ts` — `evaluateRecapSignal(candidates, usage, escAware)`.

- **Trigger**: HOOK step 4a, on a **lead-only `brief` turn**, *before* the
  current brief is registered (see "Where the fold runs").
- **Input**: the candidate list plus `{ tokens, threshold }`. Never the
  transcript — a fold is a *shape* decision, and sending the conversation would
  pay for the very content the fold is trying to forget.
- **Transport**: a dedicated `retryChat` with one forced tool, `decide_recap`
  (`recap: boolean`, `target_brief?: string`, `reason: string`), `maxRetries: 2`,
  `noSpinner: true`; the caller-visible spinner is one `Managing the context…`
  pair wrapped around the whole call.
- **Verdict** (`RecapSignal`):

  | status | meaning | caller behaviour |
  |---|---|---|
  | `recap` | fold to `target` (a hash from the list) | forks, then rewrite |
  | `skip` | the observer looked and said no (also: empty candidate list, unknown target) | nothing folded |
  | `failed` | the call threw / ESC aborted — **not** a decision | nothing folded, logged |

- **Never throws.** A failed signal must leave the turn intact and the brief
  must still run.
- **An unaddressable `target_brief` degrades to `skip`, never to a default
  target.** Folding somewhere the observer did not choose would delete a span it
  meant to keep.

## Where the fold runs — HOOK step 4a

`handleAutoRecap()` in `src/loop/states/hook.ts`, immediately after
`validateBriefIsolation`, **before** plan-scope reflection (step 4b) and before
the current brief's round-trip is registered with the triologue.

The gate — every condition must hold:

- `env.scope === 'main'` (lead only; teammates run their own loop)
- `!shouldDisableRecap()` (`--disable-recap` / `MYCC_NO_RECAP=1`)
- the turn contains a `brief` call that was **not blocked**
- not in neglected (ESC) mode
- no `compactRequested` / `chat.deferredCompact` — a compaction is about to
  rewrite everything anyway
- `getFoldCandidates().length > 0`

Then, in order:

1. `evaluateRecapSignal(...)` → on anything but `recap`, emit `auto_recap` and
   return.
2. `getLastBrief(target)` — the **peek**: the span the forks will summarize and
   the CAS token they carry across the await.
3. `handleRecapForks({ fullMessages, allTools, mindmap, chunks })` —
   `Promise.all` of the summary fork and the mindmap-patch fork, one spinner
   pair `Summarizing last N chunks…`. Returns
   `{ summary, summaryError, patch, patchError, escCancelled }`.
4. **Summary floor**: no summary ⇒ warn + `auto_recap: failed`, nothing
   collapsed (there is no model on the other side to retry by hand).
5. Build the body: summary + `**User's last query (context):** …` + the live
   `### Open todos` block (`formatOpenTodos`, restored from the todo store
   because the checklist lives outside the transcript).
6. **Size ceiling**: `triologue.recapNoteSize(...) > getResultThreshold()` ⇒
   warn, nothing collapsed. Checked on the string the rewrite will actually
   store, while the store is still untouched.
7. `triologue.rewindToLastBrief(body, anchor.id, targetHash, openTodos)` — the
   CAS re-resolves the anchor; a `null` result means it moved ⇒ nothing
   collapsed.
8. Report: the `[recap]` visible block (first summary line + token delta), one
   synthesized `submitUser(..., 'steer')` audit record, `loopEvents.emit('auto_recap')`,
   then `commitMindmapPatch()`.
9. Resync `turn.lastBriefMessage` / `turn.nextBriefNudge`, set
   `chat.autoRecapFolded = true` so `handlePlanScopeBrief` does not also fire
   on the same turn.

**Why a brief turn.** `forkChat` needs a fully answered prefix. On a brief
turn, everything except the brief itself is already answered — so the current
brief (registered later) becomes the **first message of the next chunk**, and
the folded history reads:

```
[brief(A) result = note] → [brief(B)] → work → …
```

**Anti-churn is structural, not a guard.** A successful fold consumes its
target: after the rewrite, the anchor's round-trip is last, so the next signal
sees only spans that real work has opened since.

## The note

The note is the anchor brief's rewritten TOOL RESULT:

```
[RECAP]

<summary body>

**User's last query (context):** <luq>

### Open todos
[ ] 1. ...
[x] 2. ... (pinned)
```

- `buildRecapNote(summary, openTodos)` renders it; `noteWithSummary(body)` maps a
  bare body to it, so the marker and the layout cannot drift.
- `recapNoteSize()` measures `anchoredNoteLength(noteWithSummary(body))` — the
  header, not just the body, is inside the budget.
- `[RECAP]` is the protocol marker: `hashOf()` returns `null` for it and
  `stripHashPrefix()`/`resolveBriefTarget()` treat a note as
  **non-addressable**. The note can therefore never be its own anchor.
- The rewrite is a **pure overwrite**, never a stack.
- There is **no** `[<hash>] ANCHOR` line, no `recap(target_brief=…)` invitation
  and no `· open:` list. The hash stays internal to the signal, the audit record
  and the CAS token.

### Collapse walk-back

```
recap #1 (signal → fold to B) → query → tool1 → brief(A) → letterbox → query → tool2 → brief(B) → tool3
  ⇒ [brief(B) result = note₁], brief(A) still intact
recap #2 (signal → fold to A) → …
  ⇒ [brief(A) result = note₂]  (A … note₁ … note₂: information degrades monotonically)
```

- Folding an **older** brief leaves newer briefs untouched: the signal is told
  to prefer the OLDEST finished span, which frees the most context and keeps the
  most recent work intact.
- **Any activity after a fold re-arms the same anchor**: `tool3` below B makes B
  a candidate again and a second fold to B overwrites its note.
- The pre-first-brief prefix belongs to compaction (`compact.ts`), never to a
  fold.

### Three invariants

| Invariant | Why it holds |
|---|---|
| A fold note can never be its own anchor | the scan matches `tool_calls[].function.name === 'brief'` only, and `hashOf('[RECAP]')` is `null` |
| The anchor cannot move under the forks | `id` is a compare-and-swap token: peek before the await, re-resolve inside `rewindToLastBrief()`; a moved anchor refuses |
| Triologue parity is preserved | the rewritten result IS the anchor's existing `tool` message, so the history still ends on `role:'tool'` — the next real `agent()` is the ordinary `tool → assistant` handoff |

### Incidental vs. floor briefs

Not every `brief` is an anchor. Two producers inject a `brief` round-trip only
to give the model a thinking step — `llm.ts` (empty-output recovery) and
`hook.ts` (crossroad). Their `message` is boilerplate ("Let me see what to do
next."), so folding to one would preserve infrastructure noise as the surviving
anchor. They are **incidental** and skipped.

The distinction is a property of the **message**: the producers set
`Message.synthetic = true` on the assistant message they inject (see
`types.ts`), and `MessageStore.briefIndices` skips any marked message.
Never a flag in `arguments` — arguments are model-authored and this runtime
does not validate them against `input_schema`, so a model that echoed such a
flag into its own brief would disqualify itself as an anchor. Never a call-id
convention either: an invented string that rots the moment a producer forgets
it.

`synthetic` is **in-memory only**. It is set at creation inside the triologue
and stripped on egress by `MessageStore.getFullMessages()` (the provider
payload path), so the LLM never sees the marker and cannot imitate it.

The compaction resume brief is the opposite case — the **floor**. Skipping it
would leave a fresh post-compaction session with no anchor at all. `compact.ts`
therefore never marks it, and its result is a plain `OK.`. Rule 3 still applies:
right after a compaction the floor brief is the last message pair, so its span
is empty; the first real activity after the boundary arms it.

## Brief must be called alone

`brief`'s isolation rule: a turn containing `brief` may contain **nothing
else**. Enforced as HOOK step 2 (`validateBriefIsolation` from
`src/loop/triologue/brief.ts`):

- invalid turn → the assistant turn is registered and **every** call in it is
  answered with `Brief must be called alone. Other tools cannot be used in the
  same turn.`; nothing executes; a `[brief] blocked: …` yellow line is logged;
  the loop returns to `COLLECT` so the LLM re-emits the work without the brief.
- **Why** (narrowed rationale): the loop's slice arithmetic reads the anchor's
  round-trip as a clean boundary (`resolveAnchor` → `resultIndex + 1` →
  `sliceFrom`). A brief batched with other work would put unrelated results
  inside the boundary the fold measures around. Auto-recap also relies on it:
  step 4a runs *before* the current brief is registered, which is only correct
  when that brief stands alone.
- The synthetic producers (recovery `llm.ts`, crossroad, compact floor,
  `tp-fix.ts`) emit brief as the sole call of a synthetic turn registered
  directly with the triologue — they never pass HOOK dispatch, so the guard
  cannot reject them.

## Interaction with compaction

`compact()` replaces the whole message array (`replaceAll`), so it **empties the
rewind stack**: a fold can never reach past the most recent compaction. Not a
bug — the history no longer exists.

- The post-compact resume `brief` (`compact_resume_*`) becomes the **floor
  anchor** once any activity follows it. A signal right after a compaction sees
  no candidate at all (the resume pair is last).
- The compaction summary lives in the `user` message *before* that brief, so it
  is preserved by any fold at the floor.
- `MessageStore.lastQuery` is written only by `user()`, so
  `**User's last query (context)**` stays truthful even when the newest query
  was truncated away.
- The compaction summary prompt no longer instructs the model to call `recap`
  (the tool is gone). A compaction is machine-triggered and the model never
  chose it; folding is likewise machine-decided.
- **Never call `rebuildProjectContext()` from a fold path** (recorded in the
  `pitfall` wiki). It is licensed only at `compact()` / `clear()` boundaries; a
  fold rewrites the tail, not the prompt prefix.

## Two resyncs a rewind must perform

1. **`wrapUp.reset()`** — a stale ESC mark greater than the post-rewind length
   would make a later rollback do `messages.length = mark` and *extend* the
   array with holes. Done inside `rewindToLastBrief()`.
2. **`turn.lastBriefMessage` / `nextBriefNudge`** — the next brief-nudge must
   cite the anchor that survived (the current brief), not a message the model
   can no longer see. Done by `handleAutoRecap`.

## Anchor scanning and index spaces

`MessageStore.briefIndices()` scans `this.messages` **directly**, not
`getRaw()`: the returned indices are fed to `truncateTo()`, which indexes the
true array, while `getRaw()` returns a *filtered* copy whose indices diverge
when the array carries sparse holes (wrap-up rollback, TP recovery injection,
restore). The same true-array space is used by `findToolResultIndex()` /
`firstMessageIndexAfter()`, which apply rule 2.

## Observability (§9 of the plan)

1. While the signal runs: spinner `Managing the context…`; **nothing is
   appended to the JSONL**.
2. While the forks run: spinner `Summarizing last N chunks…`; **still nothing
   appended**.
3. After the rewind: the visible `[recap]` block (first summary line + token
   delta), exactly one synthesized `submitUser(..., 'steer')` JSONL record
   (`[RECAP] Folded N message(s) / ~T tokens back to brief "…" (reason). Summary:
   …`), and the existing payload-free `{kind:'recap'}` control marker emitted by
   truncation.
4. `loopEvents` gains `auto_recap` with
   `{ verdict, targetHash?, reason?, foldedMessages?, tokensBefore?, tokensAfter?}`.

`collateMessages` skips `steer` records for livelog parity; the serve projection
renders them as a bubble. Widening `ControlPiece` was rejected — a steer record
is exactly the shape of "no message of its own to append".

## Configuration

| Flag | Env | Effect |
|---|---|---|
| `--disable-recap` | `MYCC_NO_RECAP=1` | suppresses the signal and the fold entirely |

## Implementation files

| File | Purpose |
|------|---------|
| `src/loop/recap-signal.ts` | The observer: `evaluateRecapSignal()`, `decide_recap` forced tool, verdict union |
| `src/loop/recap-rewind.ts` | `handleRecapForks()` (summary + mindmap-patch forks, one spinner pair), `commitMindmapPatch()`, patch prompt/parse (`generatePatchAction` family) |
| `src/loop/states/hook.ts` | `handleAutoRecap()` at step 4a; brief isolation at step 2 |
| `src/loop/triologue/brief-stack.ts` | `getFoldCandidates()`, `recapNoteSize()`, `rewindToLastBrief()` |
| `src/loop/triologue.ts` | Facade: `getFoldCandidates()`, `getLastBrief()`, `recapNoteSize()`, `rewindToLastBrief()`; private `resolveAnchor()` + `truncateAndRecount(idx, 'recap')` |
| `src/loop/triologue/recap-note.ts` | `buildRecapNote()`, `noteWithSummary()`, `anchoredNoteLength()`, `formatOpenTodos()`, `hashOf()`, protocol constants |
| `src/loop/triologue/store.ts` | `MessageStore.briefIndices()`, `findToolResultIndex()`, `firstMessageIndexAfter()`, `rewriteToolResult()` |
| `src/loop/triologue/brief.ts` | The ONE way to read/build/merge a brief call, plus `validateBriefIsolation()` |
| `src/tools/brief.ts` | Brief tool; its description teaches that briefs divide the session and must be called alone |
| `src/utils/arg-canonical.ts` / `src/config.ts` / `src/help.ts` | `--disable-recap` / `MYCC_NO_RECAP` |

There is **no** `src/tools/recap.ts`.

## Tests

- `src/tests/loop/recap-rewind.test.ts` — rewind contract: no-anchor, anchor
  identity, rewrite-in-place shape ending on `tool`, steering last,
  repeatability, note-never-an-anchor, compaction floor, wrap-up mark clamping,
  token recount.
- `src/tests/loop/recap-rewind-{anchor,identity,regressions,scenarios}.test.ts` —
  the anchor rule against real session sequences (b1 → t → b2 → t; fold → fold;
  fold → t → fold; fold → brief → fold), the explicit target, and legacy
  regression shapes.
- `src/tests/loop/recap-rewind-spinner.test.ts` — `handleRecapForks` runs two
  forks under one spinner pair; ESC cancels both.
- `src/tests/loop/triologue-recap-note.test.ts` — note rendering, hash, protocol
  marker, addressability.
- `src/tests/loop/states/hook-brief-isolation.test.ts`,
  `hook-esc-and-brief-isolation.test.ts` — brief isolation, and step 4a's gate
  (including the ESC case).
- `src/tests/loop/triologue-brief-isolation.test.ts` — `validateBriefIsolation`.
