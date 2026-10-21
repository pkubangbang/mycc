# Brief and Recap-Rewind Design

> Context management through **rewind anchors**, not task boundaries.

## Overview

A `brief` is a **rewind anchor** once the conversation has moved past it.
`recap` collapses the conversation back to the newest such brief: everything
after it is replaced by one note, and the brief's own text is quoted inside
that note so it survives.

**The anchor rule** (`Triologue.currentAnchorIndex`) — a brief anchors **iff**:

1. it is **not synthetic** (see "Incidental vs. floor briefs"), and
2. **at least one message follows its round-trip** (the assistant `brief` call
   *and* the tool result answering it).

Rule 2 is what makes a lone brief a non-anchor: the newest brief is where the
conversation currently stands, so there is nothing below it to collapse. The
moment *anything* lands after it — a tool call, a query, **or even another
brief** — it becomes history and anchors. There is no separate "consumed"
marker and no pristine-result test: after a rewind the anchor's round-trip is
the last thing in the history, so rule 2 alone walks the anchor backwards.

There is no `checkpoint` tool any more. The old design needed one because a
checkpoint had to be *created* in one turn (producing an id) and *consumed*
later by `recap({checkpoint_id})`. With the anchor discovered by scanning the
triologue for the last `brief`, no id exists — so the split has no basis, and
the triologue is the single source of truth for where a rewind lands.

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
  assistant('', [brief("B's message", 7)]) → tool('brief', "OK Note, a recap has
      reset the conversation here with summary: <note₁>")
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
  peek: `{ message, confidence, span }`) and `rewindToLastBrief(description,
  additionalMessage)` (truncate + rewrite the anchor's tool result). The array
  index never leaves the facade — a caller-held mark could go stale across a
  compaction.
- **Isolation**: `recap` must be called ALONE (`validateRecapIsolation`,
  HOOK step 2b). `brief` carries the same rule (`validateBriefIsolation` in
  `src/loop/triologue/brief.ts`, HOOK step 2) — see "Brief must be called
  alone" below.

The handler sequence: validate args → `getLastBrief()` (null ⇒ "No brief found
to rewind to"; empty `span` ⇒ "Nothing to collapse — there is no new activity
past your last brief") → fork the summary and the
mindmap patch concurrently over the pre-rewind history → `rewindToLastBrief()` →
resync `turn.lastBriefMessage` / `turn.nextBriefNudge` → apply the patch.

## The note

The note is the anchor brief's rewritten TOOL RESULT:

```
OK Note, a recap has reset the conversation here with summary: <body>

<body> =
[RECAP] <description>
Rewound past the brief: "<anchor brief message>"

<summary body>

**User's last query (context):** <luq>

**Next direction (recap comment — follow this):** <comment>
```

The `OK Note, …` marker is added by `noteWithSummary()` in
`src/loop/triologue/recap-note.ts` (the same module owns the pristine `OK`
literal, so the marker and the "still anchors" test cannot drift). The
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
recap → t → recap; recap → brief → recap).
`src/tests/loop/triologue-brief-isolation.test.ts` covers `validateBriefIsolation`;
`src/tests/loop/states/hook-brief-isolation.test.ts` pins the wholesale
rejection (every call answered, hook processing skipped) and the lone-brief path.
