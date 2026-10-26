# Brief and Recap-Rewind Design

> Context management through **rewind anchors**, not task boundaries.

## Overview

A `brief` is a **rewind anchor** once the conversation has moved past it.
`recap` collapses the conversation back to the newest such brief: everything
after it is replaced by one note, and the brief's own text is quoted inside
that note so it survives.

**The anchor rule** (`Triologue.currentAnchorIndex`) — a brief anchors **iff**:

1. it is **not synthetic** (see "Incidental vs. floor briefs"),
2. **its tool result exists** (an orphan `brief` call with no answer is not an
   anchor — a rewind would have nowhere to write the note), and
3. at least one message of **ACTIVITY** follows its round-trip (the assistant
   `brief` call *and* the tool result answering it).

**The walk-back (the same rule, read backwards).** Step back from the end of
memory; skip a trailing `recap` round-trip; the first non-synthetic `brief`
followed by activity is the target; reaching the start with none means there is
nothing to collapse.

- The pre-first-brief prefix belongs to compaction (`compact.ts`), never to recap.
- A bare brief is not a target: it is where the conversation currently stands.
- A failed recap is a message, not a wall — the walk steps over its round-trip.

Rule 3 is what makes a lone brief a non-anchor: the newest brief is where the
conversation currently stands, so there is nothing below it to collapse. The
moment *anything* lands after it — a tool call, a query, **or even another
brief** — it becomes history and anchors. There is no separate "consumed"
marker and no pristine-result test: after a rewind the anchor's round-trip is
the last thing in the history, so rule 3 alone walks the anchor backwards.

**Activity excludes the recap machinery talking to itself.** A recap has two
outcomes and neither is activity:

- **success** — the span is truncated and the summary is written into the
  anchor `brief`'s own tool result, so the anchor's round-trip IS the last
  thing in the history (rule 3 is then satisfied only by real work);
- **failure** — nothing is rolled back. The call is answered with an ordinary
  TOOL-CALL ERROR result (`hook.ts fail()`); the triologue is otherwise
  byte-identical to before the attempt.

`hasMessagesAfterBrief()` therefore skips a `recap` round-trip (the assistant
call and the result answering it) by tool name. Without that,
`brief(A) → recap#1(failed)` would arm A as an anchor and the NEXT recap would
fold the user's still-unserved query into one summary — the original message
gone, its text merely quoted in the note. No message-level marker is involved:
"failed" is not a property the history needs to carry.

There is no `checkpoint` tool: the anchor is discovered by scanning the
triologue, so the triologue is the single source of truth for where a rewind
lands.

## Brief must be called alone

`brief` shares `recap`'s isolation rule: a turn containing `brief` may contain
**nothing else**. Enforced as HOOK step 2 (`validateBriefIsolation` from
`src/loop/triologue/brief.ts`), before recap's own check (step 2b):

- invalid turn → the assistant turn is registered and **every** call in it is
  answered with `Brief must be called alone. Other tools cannot be used in the
  same turn.`; nothing executes; a `[brief] blocked: …` yellow line is logged;
  the loop returns to `COLLECT` so the LLM re-emits the work without the brief.
- Why: the anchor scan (`currentAnchorIndex`) must not land on a turn that also
  carries other work. A brief-only assistant turn is a self-contained boundary,
  which keeps `rewindToLastBrief()` unambiguous.
- The synthetic producers (recovery `llm.ts`, crossroad, compact floor,
  `tp-fix.ts`) emit brief as the sole call of a synthetic turn registered
  directly with the triologue — they never pass HOOK dispatch, so the guard
  cannot reject them.

## The collapse rule

```
query → tool1 → brief(A) → letterbox → query → tool2 → brief(B) → tool3 → letterbox
recap#1 → query → tool1 → brief(A) → letterbox → query → tool2 → [brief(B) result = note₁]
recap#2 → query → tool1 → [brief(A) result = note₂]
```

- **recap #1** truncates everything AFTER B's round-trip (the assistant message
  whose `tool_calls` contain `brief`, and its tool result) and **rewrites that
  result in place**:

  ```
  assistant('', [brief("B's message", 7)]) → tool('brief', "[<hash>] ANCHOR
      Note, a recap has reset the conversation here with summary: <note₁>")
  ```

  `note₁` starts with `[RECAP] <description>` and `Rewound past the brief: "<B's
  message>"`, so the result carries `B's text + the span summary`. No summary
  turn is ever appended — the anchor's own round-trip is the survivor.
- **recap #2** scans for the anchor again. B's round-trip is now the LAST thing
  in the history, so rule 2 skips it and the scan lands on **A**, whose result
  is rewritten with `note₂` (summarizing `A … note₁`, so information degrades
  monotonically instead of vanishing).
- **Any activity after a rewind re-arms the same anchor.** `tool3` after
  `recap#1` puts activity below B again, so a second recap targets **B** and
  **overwrites** its note — the rewrite is a pure overwrite, never a stack.
- A lone brief after a rewind (`recap#1 → brief(C)`) is **not** an anchor by
  itself; the scan returns to B. One more brief after C makes C anchor.

### Three invariants

| Invariant | Why it holds |
|---|---|
| `recap` is repeatable with no id argument | the anchor is always "newest non-synthetic `brief` with activity after it", re-scanned each call |
| A recap note can never be its own anchor | the scan matches `tool_calls[].function.name === 'brief'` only, and a rewind leaves the anchor's round-trip last (rule 2 then skips it) |
| Triologue parity is preserved | the rewritten result IS the anchor's existing `tool` message, so the history still ends on `role:'tool'` — the next real `agent()` is the ordinary `tool → assistant` handoff |

### Incidental vs. floor briefs

Not every `brief` is an anchor. Two producers inject a `brief` round-trip only
to give the model a thinking step — `llm.ts` (empty-output recovery) and
`hook.ts` (crossroad). Their `message` is boilerplate ("Let me see what to do
next."), so rewinding to one would preserve infrastructure noise as the
surviving anchor. They are **incidental** and skipped.

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
would leave `recap` with no anchor at all after a compaction. `compact.ts`
therefore never marks it. Rule 2 still applies: right after a compaction the
floor brief is the last message pair, so its span is empty and the handler
declines; the first real activity after the boundary arms it.

## ⚠️ Architecture: Meta-Tools

**Key Decision**: `recap` is a **meta-tool**, NOT a regular tool.

Regular tools receive `AgentContext` (`core`, `todo`, `mail`, …). The triologue
(message history manager) is **NOT** part of AgentContext because:

1. **Separation of concerns**: triologue belongs to the agent loop, not the tool context
2. **Lifecycle mismatch**: tools are short-lived units; triologue spans the conversation
3. **Access pattern**: only the state machine should manage message history directly

**Implementation pattern**

- **Tool definition** (`src/tools/recap.ts`): name, description, parameters for
  LLM visibility; the handler returns `''`.
- **State machine** (`src/loop/states/hook.ts`): detects a `recap` call before
  regular tool execution, runs the real logic with `env.triologue`, and returns
  `COLLECT` without calling the regular handler.
- **Rewind primitive** (`src/loop/triologue.ts`): `getLastBrief()` (read-only
  peek: `{ message, confidence, id, span }`) and `rewindToLastBrief(description,
  additionalMessage, expectedBriefCallId?)` (truncate + rewrite the anchor's tool
  result). Both read ONE private resolution (`resolveAnchor()`), which returns
  the anchor's tool-result index alongside the message: the span start and the
  truncation point are the same number, so they cannot disagree. The array index
  never leaves the facade — a caller-held mark could go stale across a
  compaction; the caller carries `expectedBriefCallId` (the brief's tool-call
  id alone — never the array index, never the arguments; an id that a
  malformed/restored history reuses resolves to the MOST RECENT such call, so an
  older anchor's span is never truncated on a guess) and the rewind refuses when
  it moved. The id is a compare-and-swap token, NOT a locator: the anchor itself
  is found by walking back from the end of the triologue.
- **Isolation**: `recap` must be called ALONE (`validateRecapIsolation`,
  HOOK step 2b). `brief` carries the same rule (`validateBriefIsolation` in
  `src/loop/triologue/brief.ts`, HOOK step 2) — see "Brief must be called
  alone" below.

The handler sequence: validate args → `getLastBrief()` (null ⇒ "No brief found
to rewind to"; empty `span` ⇒ "Nothing to collapse — there is no new activity
past your last brief") → fork the summary and the
mindmap patch concurrently over the pre-rewind history → **summary floor**
(`hasUsableSummary()`: empty / whitespace / `[RECAP] …` / below
`MIN_RECAP_SUMMARY_CHARS` ⇒ refuse, nothing truncated) → **size ceiling**
(`recapNoteSize() > resultThreshold` ⇒ refuse, nothing truncated) →
`rewindToLastBrief()` → resync `turn.lastBriefMessage` / `turn.nextBriefNudge` →
apply the patch.

Every refusal answers the recap call and returns `COLLECT` so the model can
retry. A refusal rolls NOTHING back — no truncation, no rewrite of an earlier
brief's result — and, since the recap tool never produces activity, it can
never be folded by the next recap (see the anchor rule).

## The note

The note is the anchor brief's rewritten TOOL RESULT:

```
[<hash>] ANCHOR                      <- line 1: the anchor line, written once, never rewritten
Note, a recap has reset the conversation here with summary: <body>   <- line 2: the recap's note

<body> =
[RECAP] <description>
Rewound past the brief: "<anchor brief message>"

<summary body>

**User's last query (context):** <luq>

**Next direction (recap comment — follow this):** <comment>
```

A `· open:` list is appended to line 1 when other foldable anchors exist: the newest
up to 3, then `(+N more)` for the remainder (a count, never an offer — there is no tool
that enumerates anchors). A rewind retires the whole ` — recap(…)` clause, so a folded
anchor's line 1 is `[<hash>] ANCHOR`.

The note is appended by `noteWithSummary()` in
`src/loop/triologue/recap-note.ts` (the same module that renders line 1, so the
marker and the anchor line cannot drift). It APPENDS: line 1 is kept, minus the
`recap(target_brief=…)` invitation, which is retired because the span it names is now
gone.

### The brief result line: `[<hash>] ANCHOR — recap(target_brief="<hash>") folds the work after this point`

Every brief result starts with a short **hash** — 8 characters of a digest of
the brief's tool-call id — followed by the call that folds to it. `briefResultLine()`
renders it, `stampBriefResult()` applies it idempotently (a result that already
carries a `[<hash>]` prefix is left alone), and `briefHash()` derives the hash.

Two callers deliberately do NOT get that line, and render `briefReceiptLine()`
(`[<hash>] OK`) instead, because the invitation would be false:

- a **teammate's** brief — `brief` is `['main', 'child']` but `recap` is
  `['main']`, so a child must not be told to call a tool it does not have;
- a **synthetic** brief (crossroad, empty-output recovery) — it is not in
  `store.briefIndices()`, so every `recap(target_brief=…)` naming it is refused.

The hash exists so the model can **name** an anchor: it is exactly the token
`recap` takes in `target` (the shown hash or the full call id both resolve). A
rewind APPENDS its note under line 1 and retires the `recap(target_brief=…)`
invitation — `[<hash>] ANCHOR — recap(…)` becomes `[<hash>] ANCHOR` — because the
span the call names is now gone. The hash survives, so a later recap can still
address the same brief once new activity lands after it.

### `recap(target_brief=…)`

`recap` takes an optional `target`:

- **names the last brief** (nothing after it yet) → a distinct refusal: `that brief has nothing after it yet — recap folds the work that follows an anchor`. The hash exists; it is simply not foldable until new work lands below it.
- **empty** (the normal case) → the default anchor: the newest *solidified*
  brief, i.e. one with meaningful activity after its round-trip. Recap
  round-trips do not count as activity.
- **given** → the brief carrying that hash / id. An explicit target **wins over
  the solidified rule**: it may name a brief that the conversation has not
  visibly moved past, as long as *something* follows its round-trip.
- An explicit target **never falls back**. If no brief matches, the call is
  answered with an error quoting the addressable hashes and **nothing is
  collapsed** — silently collapsing elsewhere would delete a span the model did
  not choose.
- A target naming the **last** brief has nothing beneath it to collapse, so it
  is refused the same way. The
`[RECAP]` header + quoted anchor are prepended by `rewindToLastBrief()` (it
captures the anchor text **before** the truncation); the rest is the
`additionalMessage` assembled by `handleRecap` in `src/loop/recap-rewind.ts`.
The steering `comment` is deliberately LAST — the final thing the conversation
sees before continuing. On the `abandon` path the summary body is replaced by a
"discarded without being summarized" note and the two LLM forks are skipped.

## Interaction with compaction

`compact()` replaces the whole message array (`replaceAll`), so it **empties the
rewind stack**: `recap` can never rewind past the most recent compaction. Not a
bug — the history no longer exists.

- The post-compact resume `brief` (`compact_resume_*`) becomes the **floor
  anchor** once any activity follows it. A `recap` right after a compaction
  finds no anchor at all (the resume pair is last), and one before any new
  activity finds `span.length === 0` and declines — instead of consuming the
  floor for nothing.
- The compaction summary lives in the `user` message *before* that brief, so it
  is preserved by any rewind at the floor.
- `MessageStore.lastQuery` is written only by `user()`, so
  `**User's last query (context)**` stays truthful even when the newest query
  was truncated away.
- The compaction summary prompt ends with a `## Managing your context with
  recap` section (see `buildSummaryPrompt()` in
  `src/loop/triologue/compact.ts`): a compaction is machine-triggered, so the
  model never chose it, and this is where it learns that it now owns its
  context — call `recap` when the context feels heavy or when it is stuck in a
  dead loop (with a steering `comment`), and use `target` only to collapse
  further back than the newest usable brief. It deliberately does **not** tell
  the model to `brief` first: a recap submerges the whole span, briefs included.
  `emitControl('compact')` is untouched — it only journals a live-log boundary.

## Two resyncs a rewind must perform

1. **`wrapUp.reset()`** — a stale ESC mark greater than the post-rewind length
   would make a later rollback do `messages.length = mark` and *extend* the
   array with holes. Done inside `rewindToLastBrief()`.
2. **`turn.lastBriefMessage` / `nextBriefNudge`** — the next brief-nudge must
   cite the anchor that survived, not a message the model can no longer see.
   Done by the handler.

## Anchor scanning and index spaces

`MessageStore.briefIndices()` scans `this.messages` **directly**, not
`getRaw()`: the returned indices are fed to `truncateTo()`, which indexes the
true array, while `getRaw()` returns a *filtered* copy whose indices diverge
when the array carries sparse holes (wrap-up rollback, TP recovery injection,
restore). The same true-array space is used by `findToolResultIndex()` /
`firstMessageIndexAfter()`, which apply rule 2.

## Implementation files

| File | Purpose |
|------|---------|
| `src/tools/recap.ts` | Recap tool definition (meta-tool, handler returns empty string) |
| `src/tools/brief.ts` | Brief tool; its description teaches that briefs are rewind anchors and must be called alone |
| `src/loop/triologue/store.ts` | `MessageStore.briefIndices()`, `findToolResultIndex()`, `firstMessageIndexAfter()`, `rewriteToolResult()` |
| `src/loop/triologue.ts` | `getLastBrief()`, `rewindToLastBrief()`; private `truncateAndRecount(idx, 'recap')` |
| `src/loop/recap-rewind.ts` | `handleRecap()` (span summary), `generatePatchAction()`, `handleRecapSpan()` (both forks), `validateRecapIsolation()` |
| `src/loop/triologue/brief.ts` | The ONE way to read/build/merge a brief call, plus `validateBriefIsolation()` |
| `src/loop/states/hook.ts` | State machine handling: enforces brief isolation (step 2) and recap isolation (step 2b), detects the `recap` call, invokes the rewrite or the abandon note |

## Tests

`src/tests/loop/recap-rewind.test.ts` pins the contract: no-anchor,
anchor identity, no exposed index, rewrite-in-place shape ending on `tool`,
quoted anchor + steering last, **repeatability**, **note-never-an-anchor**,
**compaction floor**, wrap-up mark clamping, and token recount.
`src/tests/loop/recap-rewind-scenarios.test.ts` pins the anchor rule against
the sequences a real session produces (b1 → t → b2 → t; recap → recap;
recap → t → recap; recap → brief → recap), plus the explicit `target`
scenarios: an earlier brief wins over a newer solidified one, an unknown hash
refuses without touching history, a full call id resolves, and a target naming
the last brief is refused.
`src/tests/loop/triologue-brief-isolation.test.ts` covers `validateBriefIsolation`;
`src/tests/loop/states/hook-brief-isolation.test.ts` pins the wholesale
rejection (every call answered, hook processing skipped) and the lone-brief path.
