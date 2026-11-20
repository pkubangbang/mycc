# Note Taxonomy & Stale Folding

**Status:** implemented (§9 steps 1-6 landed; verified by src/tests/fold-notes.test.ts and src/tests/fold-notes-integration.test.ts). This document records the design AND the corrections made during its line-by-line review — see §11.

## 1. Purpose

The agent's context accumulates notes that `COLLECT` re-emits on every pass
(`src/loop/states/collect.ts`). A handful of them are **renewable snapshots**:
if a note is dropped, the next `COLLECT` can reproduce an equivalent one with
no loss of information. Left in place, they replay every turn and compete with
the live task for model attention.

This document specifies how such notes are **folded out of the model's view**
once they are stale, and how note categories changed to make that decision
possible from `category + staleness` alone.

### Non-goals

| Non-goal | Why |
|---|---|
| **Saving tokens** | Folding does not change the stored message count, role sequence, or `tokenCount`. The real token weight is `tool` rows holding file contents, not notes. The benefit here is **attention hygiene** only — though `/token` does report the folded conversation, because that is the payload the provider receives (§6). |
| **Teammates** | Intended, but **not achieved structurally** — `TriologueLite` does own a `MessageStore`, so it runs the fold too. It is inert only because teammate producers emit `REMINDER`, never `NUDGE`. See §7 and §11. |
| **Folding event-like notes** | Mail, steering, uploads, hints, interrupts, and serve-state transitions cannot be recomputed. Dropping one loses information permanently. See §4. |

## 2. The single invariant

> **Write by appending only; fold at read time by `category + staleness`.**

Folding is an **outbound projection**, not a mutation of history. The message
array, its length, its role sequence, the journal, and `tokenCount` are all
untouched.

This invariant is what makes the design safe, and it rules out two tempting
alternatives:

- **Deleting messages retroactively** breaks the prompt cache (the rewrite
  lands deep inside the already-sent prefix; a recap-time
  `rebuildProjectContext()` was recorded as a cache-invalidating no-op for
  exactly this reason) and would require a new `ControlEvent` plus a matching
  branch in both transcript projections (`collateMessages` and
  `collateEntries`), and would permanently rewrite sealed session archives.
- **Keeping a cursor** (`prevLlmBoundary` and friends) assumes the message
  array is append-only. It is not: compaction, segment-archive, rollback and
  truncate all rewrite it. Any cursor silently drifts after those events.

Because fold state is derived from the array on every call, the projection
converges automatically after any of those rewrites — there is nothing to keep
in sync.

## 3. Taxonomy

The decision axis is: **can a later `COLLECT` reproduce this note's content?**

| category | meaning | lead-path producers | foldable |
|---|---|---|:---:|
| `NUDGE` **(new)** | periodically re-emitted, content recomputable | `collect.ts:167` team snapshot<br>`collect.ts:319` todo nudge<br>`collect.ts:337` brief nudge<br>`collect.ts:354` worktree nudge | **yes** |
| `REMINDER` (narrowed) | one-shot user-facing reminder | `collect.ts:195` steering<br>`collect.ts:250` uploaded files<br>`prompt.ts:362` hand-over output<br>`prompt.ts:456` uploads from an interrupted run | no |
| `SYSTEM` | one-shot system state notice | `collect.ts:104` Web UI start/stop (edge-triggered)<br>`src/loop/states/stop.ts:188` stop-guard block | no |
| `MAIL` | child/peer mail (drain semantics) | `collect.ts:150`, `collect.ts:152` | no |
| `HINT` | confusion hint / skill suggestion | `src/loop/hint-round.ts:580`, `src/loop/states/collect-skill.ts:411` | no |
| `URGENT` | ESC interrupt | `collect.ts:145` | no |

### Why split `REMINDER`

The old `REMINDER` category conflated six unrelated meanings, of which only
three are recomputable. Worse, it made **steering — a user's mid-task
direction — category-identical to a todo nudge**. Folding by the `[REMINDER]`
prefix would therefore silently discard user instructions. Provenance cannot
fix this: the distinction has to live in the category, because the category is
what the fold rule reads.

### Why exactly one new member

A second new member (e.g. splitting "periodic reminder" from "status
snapshot") was considered and rejected. The fold rule needs exactly one
property — *recomputable* — and that property is orthogonal to whether the note
nags or merely reports. Extra members would add regex sites, documentation, and
a gap for future misuse, without making any decision finer.

## 4. The fold rule

```
fold(note) ⇔  lead
            ∧ note.category === 'NUDGE'
            ∧ staleness(note) ≥ STALE_ASSISTANT_ROWS
```

### `lead` is structural, not a runtime check

The fold lives in `MessageStore` (§6). Only the lead's `Triologue` uses
`MessageStore`; `TriologueLite` does not. There is no `isLead` flag to get
wrong.

### `staleness` — derived, never stored

> A note's staleness is **the number of `assistant` rows that appear after it
> in the array**, recomputed on every outbound projection.

```
about to run LLM call k (one assistant row per call):
  notes injected before call k     → 0 assistant rows after → kept
  notes injected before call k-1   → 1 assistant row  after → FOLDED
  notes injected before call k-2…  → ≥2                   → FOLDED
```

Labelled by LLM call, not by COLLECT pass: a pass may span several calls (one
per tool round), and it is the assistant rows between the note and the present
that define staleness.

`STALE_ASSISTANT_ROWS = 1`, i.e. **"everything injected before the previous
`assistant` row is folded"**.

**The unit is an `assistant` row (one LLM call), not a turn.** A single turn can
contain many assistant rows — one per tool round — so a nudge emitted at
COLLECT is folded on the *second* LLM call of that same turn. Because the
throttled producers fire every 3 or 5 passes, a brief or worktree nudge is
therefore visible for roughly one LLM call. That is intentional (the nudge is
read at the moment it fires, which is the moment it is actionable) but it means
"staleness" here is a per-call counter, not a per-turn one.

**Why 1 and not 2.** A larger threshold folds an older position, moving the
first divergent message further back in the prefix and costing more prompt-cache
re-prefill on every call. 1 keeps the stable prefix as long as possible while
still eliding everything older than the previous LLM call — without claiming,
as "superseded" would, that a replacement note is guaranteed to exist (§5).

### Why an `assistant` row is a clean boundary

`note()` defers whenever `ledger.size > 0` (`src/loop/triologue.ts:460-462`), so
a `user`-role note can **never** be interposed between an assistant's
`tool_calls` and its results. An `assistant` row is therefore an unambiguous
LLM-call boundary (one exception: synthetic TpAutoFixer bridge rows, which are
not real calls — see `isBoundary` in fold-notes.ts), and staleness never has to
reason about tool batch structure.

VOCABULARY: "pass" is the right word exactly where the claim is that a boundary
fell *inside* a COLLECT cycle; "LLM call" everywhere else. Six sites originally
used the wrong one — that was a single conceptual slip, not six typos.

## 5. What a folded note looks like

The message row is kept; only its `content` is replaced:

```
[NUDGE] (earlier nudge — content elided)
```

- one line, fixed text — no original content, no imperative, no unearned
  authorization to proceed, and **no claim that a successor exists**. An earlier
  wording said "superseded by a later nudge"; that is false whenever the folded
  row was the last of its kind, which throttling makes common (todo every 3
  passes, brief and worktree every 5), so it could invite the model to skip a
  still-live obligation. `[NUDGE] (stale — omit)` was also rejected: "omit" is an
  imperative
- the `[NUDGE]` prefix is preserved so prefix-reading consumers keep working
- notes are **not merged**: each stale note becomes its own single line, so the
  "one note = one message" invariant (`triologue.ts:479-485`) holds

## 6. Insertion point

```
triologue.getMessages()                    src/loop/triologue.ts:1006
  └→ store.getFullMessages()               src/loop/triologue/store.ts:457   ← the projection the model sees
       ├─ sysPrompt
       ├─ projectContext                   ← never folded (not conversation)
       └─ conversation                     ← store.getConversationForProvider()
                                              = foldStaleNudges(getRaw()) — pure, returns a projection copy
```

`getFullMessages()` is documented in-tree as "the OUTBOUND path (`retryChat`,
explorer-agent, esc-wrap-up)" and "a single chokepoint for ALL message access",
so no projection can bypass the fold. The conversation segment is materialised
by `store.getConversationForProvider()` so the fold rule has ONE site.

**`/token` measures the same projection — through ONE read.** `triologue.getContextBudget()`
returns both `conversation` (tokens) and `conversationMessages` (rows), estimated
from the same `store.getConversationForProvider()` array, and the `/token` report
prints both from that single object. There is deliberately **no** message
accessor for `/token` to call: two reads could describe two payloads, and the
"messages" number would then qualify a token figure it did not come from. The
figure therefore describes the payload the next LLM call sends, not the raw
history. (Before this, both read `getRaw()`, so `/token` overstated the
conversation by the size of every folded nudge's body.)

Untouched by construction: `getMessagesRaw()`, `at()`, `length`, `tokenCount`,
the journal, and the display/livelog path. `getContextBudget` deliberately does
NOT change `tokenCount`/`needsCompact()`: compaction must keep firing on the
stored array (§2 "Non-goals: saving tokens" still holds — the fold removes no
message, so the budget the compaction threshold guards is unchanged).

## 7. Teammates — the original claim was wrong

**The first version of this section was false, and the correction matters.**

It claimed the fold lives in `MessageStore`, which "only the lead's
`Triologue` instantiates", so teammate workers "structurally cannot acquire
this behaviour". Reviewers found that `TriologueLite` imports `MessageStore`
(`triologue-lite.ts:41`), owns one (`:61`), delegates its `note()` into it
(`:297`), and returns `store.getFullMessages()` from `getMessages()` (`:520`).
A teammate worker — and the mindmap explorer (`explorer-agent.ts:771`) —
therefore **does** run this projection. There was never an `isLead` guard.

What actually keeps the fold inert for teammates is narrower and weaker:
teammate producers still emit `'REMINDER'`, never `'NUDGE'`
(`teammate-worker.ts:399/411/432/581/595/611/794`). That is a *category
assignment*, not a structural exclusion. Migrating a teammate nudge to `NUDGE`
turns folding on there with nothing to stop it.

Two ways to restore a real guarantee, neither taken yet:

1. a `foldNotes: boolean` constructor flag on `MessageStore` (the lite facade
   passes `false`), or
2. keep the fold in the `Triologue` facade rather than in the store.

Until one lands, this section is a statement of intent, and the header comment
of `src/loop/triologue/fold-notes.ts` says so explicitly.

## 8. Risks and verification

| risk | assessment |
|---|---|
| **Triologue parity (TP)** | Cannot break. The array, row count and role sequence are unchanged. `parityViolations` / `headViolations` see identical input. |
| **Journal / restore divergence** | Cannot occur. Folding writes nothing to the journal. |
| **`src/loop/hint-round.ts:412` prefix filter** | **Confirmed, must fix.** `/^\[(?:REMINDER\|WRAP_UP)\]/` — after migration, nudges no longer match, so stale nudges would be treated as ordinary conversation by the hint analyzer. Extend to `(?:NUDGE\|REMINDER\|WRAP_UP)`. Note it is a *pre*-filter, so a `[NUDGE]` line is only ever dropped from the analyzer's context — never from the model's. |
| **Web UI rendering** | **Confirmed safe — no change needed.** User bubbles are admitted by a **`user_origin` marker**, not by content prefix or journal kind: `serve-history.ts:352` is `if (role === 'user' && record.user_origin !== true) return null; // injected note`. Notes reach the journal through `addMessage()` (`triologue.ts:1173`), which is called *without* `isUserOrigin`, so `NUDGE` is suppressed exactly like every other note. |
| **Compaction cache prefix** | **Confirmed safe, and slightly improved.** `compact.ts:183` takes its focus `forkChat` prefix from `getFullMessages()`, i.e. through the same fold. The prefix is therefore byte-identical before and after a fold, where a retroactive deletion would have invalidated it. |
| **Session reload** | **Better than the earlier draft.** The category is baked into the journaled content prefix (`[NUDGE] …`), so a reloaded session still folds correctly — no in-memory provenance field is needed. |
| **Prompt cache** | The fold position is fixed relative to the current LLM call, so re-prefill is bounded by about one call, not the whole history. |
| **Half-irreversible** | Code revert is a two-way edit (drop the member). But sessions written in the interim permanently carry a `[NUDGE]` prefix, and after a revert any prefix parser (e.g. the hint filter) mis-classifies them. Accepted explicitly. |

### 8.1 Resolved before implementation

Two questions were open when this document was first drafted. Both are now
closed by reading the source:

1. **How does the Web UI hide injected notes — by content prefix or by journal
   kind?** Neither. It is the **`user_origin` marker**:
   `serve-history.ts:352` → `if (role === 'user' && record.user_origin !== true) return null; // injected note`.
   Notes are appended through `addMessage()` (`triologue.ts:1173`) without
   `isUserOrigin`, so a new category is suppressed with no UI change.
   *(The draft had assumed a prefix or `kind` list and flagged `NUDGE` as a
   possible UI regression. That risk does not exist.)*
2. **Is folding inside `getFullMessages()` safe with respect to the compaction
   cache prefix?** Yes, and it is marginally better than not folding.
   `compact.ts:183` builds the focus `forkChat` prefix from
   `getFullMessages()`, so the prefix is byte-identical on both sides of a
   fold. A retroactive deletion would have made them differ.

### 8.2 One comment was false (now fixed)

`src/loop/states/collect.ts:178` used to read *"REMINDER NoteCategory — no new
category needed."* That statement is what this design overturns. It was
rewritten in the same commit as step 2, as required.

## 9. Implementation order

| # | file | change |
|---|---|---|
| 0 | `docs/loop/note-taxonomy.md` | this document |
| 1 | `src/types.ts:45` | add `'NUDGE'` to `NoteCategory`, with a comment stating it is the only foldable member |
| 2 | `src/loop/states/collect.ts` | migrate 4 sites: `:166` `SYSTEM`→`NUDGE`; `:317` `:335` `:352` `REMINDER`→`NUDGE`; rewrite the now-false comment at `:178` (§8.2) |
| 3 | `src/loop/triologue/fold-notes.ts` (new) | pure `foldStaleNudges(messages)` + `STALE_ASSISTANT_ROWS`; header comment carries §2 and §7 |
| 4 | `src/loop/triologue/store.ts:439` | call the fold on the conversation segment |
| 5 | `src/loop/hint-round.ts:412` | extend the prefix filter to `(?:NUDGE\|REMINDER\|WRAP_UP)` |
| 6 | `src/tests/fold-notes.test.ts` | table-driven: staleness 0/1/2/3; `NUDGE` folds, the other five never do; folded output preserves length and role sequence |

## 10. Verification

1. Unit: the four staleness buckets; each of the six categories; folded output
   has identical `length` and identical `role` sequence.
2. Integration: after three consecutive LLM calls, the outbound projection
   contains complete content only for the newest nudge (src/tests/fold-notes-integration.test.ts).
3. `vp check` and `vp test`, run against the exact bytes being committed.

## 11. Review record

The change was reviewed line by line by four independent reviewers (core rule,
taxonomy split, store wiring, integration/tests). All four returned
**FIX-FIRST**; the defects were in the *justifications and documentation*, not
in the runtime logic — the projection itself was hand-traced clean on every
required array shape, and the consumer sweep (12 sites plus 3 unlisted) found no
consumer that needs true nudge text and receives folded text.

What the review changed, and why:

| # | finding | resolution |
|---|---|---|
| 1 | §7 / §2 / `types.ts` claimed teammates were *structurally* excluded. **False**: `TriologueLite` owns a `MessageStore`. | §7 rewritten as a statement of intent; the real (weak) guarantee named; two structural fixes listed as not yet taken. |
| 2 | Placeholder asserted "superseded by a later nudge" — false for throttled producers. | Neutral wording `[NUDGE] (earlier nudge — content elided)`. A *successor check* was proposed and **rejected**: it would retain the last nudge of each kind verbatim, and the team snapshot (`collect.ts:165`) and worktree nudge (`:350-358`) stop firing when their state clears — so those rows would be not merely stale but FALSE, violating §5's "no original content". |
| 3 | `[NUDGE] (stale — omit)` proposed as the fix. | Rejected: "omit" is an imperative, violating §5. A false descriptive claim would have been traded for an unearned directive. |
| 4 | `isNudge()` could elide a genuine user message starting with `[NUDGE]`. | Now requires the trailing space **and** `user_origin !== true`. |
| 5 | `compact.ts` summarised `getRawMessages()` (true text) while the focus fork used `getFullMessages()` (folded) — the fold leaked through compaction. | Summary now reads `getFullMessages()`, so it describes what the model actually saw. `saveTranscript` still persists true text. |
| 6 | The staleness model implied one assistant row per **pass**; a pass spans many LLM calls. | §4 states the unit is one LLM call. Residual per-pass phrasing was tracked and rewritten across §4/§8/§10 and two comment blocks; per-call granularity is retained deliberately — pass granularity would need the cursor §2 rejects. |
| 7 | Stale line references across §3/§6/§9; a wrong test path; a false status line. | Corrected, and re-verified line by line on the final tree rather than assumed. |
| 9 | The channel block inside `runTodoNudge` is the only foldable content that is an **address** (`mail_to(name="<session-id>/lead")`) rather than a status. | Recovery is `peer_list`; a pointer is now appended to that one nudge. Rejected alternative: appending it to the shared todo message, which would pay tokens on every todo nudge even with no channels and cannot be aged independently of the todo list. |
| 8 | No test pinned the *negative* direction — that non-recomputable producers stay `REMINDER`. | Added; that direction is the dangerous one (silent, permanent loss of a user instruction, and both union members type-check). |

Two reviewer proposals were caught by other reviewers before they reached the
code: the successor check (#2) and the "omit" wording (#3). Both would have
introduced a worse defect than the one they fixed. This is recorded because the
reasoning matters more than the verdict — the same two ideas will look
attractive again to the next reader.