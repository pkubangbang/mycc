# Brief and Recap-Rewind Design

> Context management through **rewind anchors**, not task boundaries.

## Overview

Every real `brief` is a **rewind anchor**. `recap` collapses the conversation
back to the *last* brief: everything after it is replaced by one note, and the
brief's own text is quoted inside that note so it survives.

There is no `checkpoint` tool any more. The old design needed one because a
checkpoint had to be *created* in one turn (producing an id) and *consumed*
later by `recap({checkpoint_id})`. With the anchor discovered by scanning the
triologue for the last `brief`, no id exists — so the split has no basis, and
the triologue is the single source of truth for where a rewind lands.

## The collapse rule

```
query → tool1 → brief(A) → letterbox → query → tool2 → brief(B) → tool3 → letterbox
recap#1 → query → tool1 → brief(A) → letterbox → query → tool2 → [recap(note₁)]
recap#2 → query → tool1 → [recap(note₂)]
```

- **recap #1** truncates at B's assistant message (the one whose `tool_calls`
  contain `brief`) and appends an `assistant('') + tool('recap', note₁)` pair.
  `note₁` starts with `[RECAP] <description>` and `Rewound past the brief: "<B's
  message>"`, so `note₁ = B's text + the span summary`.
- **recap #2** scans for the last `brief` again, skips `note₁` (it is a `recap`
  call, never a `brief` one), and lands on **A**. `note₂` summarizes
  `A … note₁` — which *contains* `note₁`, so information degrades
  monotonically instead of vanishing.

### Three invariants

| Invariant | Why it holds |
|---|---|
| `recap` is repeatable with no id argument | the anchor is always "last `brief`", re-scanned each call |
| A recap note can never be its own anchor | the scan matches `tool_calls[].function.name === 'brief'` only |
| Triologue parity is preserved | the merge pair ends on `role:'tool'`, so the next real `agent()` is the ordinary `tool → assistant` handoff |

### Incidental vs. floor briefs

Not every `brief` is an anchor. Two producers inject a `brief` round-trip only
to give the model a thinking step — `llm.ts` (empty-output recovery) and
`hook.ts` (crossroad). Their `message` is boilerplate ("Let me see what to do
next."), so rewinding to one would preserve infrastructure noise as the
surviving anchor. They are **incidental** and skipped.

The distinction is a property of the **message**: the producers set
`Message.synthetic = true` on the assistant message they inject (see
`types.ts`), and `MessageStore.findLastBriefAnchor` skips any marked message.
Never a flag in `arguments` — arguments are model-authored and this runtime
does not validate them against `input_schema`, so a model that echoed such a
flag into its own brief would disqualify itself as an anchor. Never a call-id
convention either: an invented string that rots the moment a producer forgets
it.

`synthetic` is **in-memory only**. It is set at creation inside the triologue
and stripped on egress by `MessageStore.getFullMessages()` (the provider
payload path), so the LLM never sees the marker and cannot imitate it.

The compaction resume brief is the opposite case — the **floor**. After a
compaction it is the only brief left, so skipping it would leave `recap` with
no anchor at all. `compact.ts` therefore never marks it.

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
  additionalMessage)` (truncate + merge). The array index never leaves the
  facade — a caller-held mark could go stale across a compaction.
- **Isolation**: `recap` must be called ALONE (`validateRecapIsolation`).

The handler sequence: validate args → `getLastBrief()` (null ⇒ error;
empty `span` ⇒ "already at the compaction boundary") → fork the summary and the
mindmap patch concurrently over the pre-rewind history → `rewindToLastBrief()` →
resync `turn.lastBriefMessage` / `turn.nextBriefNudge` → apply the patch.

## The note

```
[RECAP] <description>
Rewound past the brief: "<anchor brief message>"

<summary body>

**User's last query (context):** <luq>

**Next direction (recap comment — follow this):** <comment>
```

The first two lines are prepended by `rewindToLastBrief()` (it captures the
anchor text **before** the truncation deletes the pair); the rest is the
`additionalMessage` assembled by `handleRecap` in `src/loop/recap-rewind.ts`.
The steering `comment` is deliberately LAST — the final thing the conversation
sees before continuing. On the `abandon` path the summary body is replaced by a
"discarded without being summarized" note and the two LLM forks are skipped.

## Interaction with compaction

`compact()` replaces the whole message array (`replaceAll`), so it **empties the
rewind stack**: `recap` can never rewind past the most recent compaction. Not a
bug — the history no longer exists.

- The post-compact resume `brief` (`compact_resume_*`) becomes the **floor
  anchor**. A `recap` right after a compaction finds `span.length === 0` and
  declines instead of consuming the floor for nothing.
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

`MessageStore.findLastBriefAnchor()` scans `this.messages` **directly**, not
`getRaw()`: the returned index is fed to `truncateTo()`, which indexes the true
array, while `getRaw()` returns a *filtered* copy whose indices diverge when the
array carries sparse holes (wrap-up rollback, TP recovery injection, restore).

## Implementation files

| File | Purpose |
|------|---------|
| `src/tools/recap.ts` | Recap tool definition (meta-tool, handler returns empty string) |
| `src/tools/brief.ts` | Brief tool; its description teaches that briefs are rewind anchors |
| `src/loop/triologue/store.ts` | `MessageStore.findLastBriefAnchor()` |
| `src/loop/triologue.ts` | `getLastBrief()`, `rewindToLastBrief()`; private `truncateAndRecount(idx, 'recap')` |
| `src/loop/recap-rewind.ts` | `handleRecap()` (span summary), `generatePatchAction()`, `handleRecapSpan()` (both forks), `validateRecapIsolation()` |
| `src/loop/states/hook.ts` | State machine handling: detects the `recap` call, enforces isolation, invokes the rewrite or the abandon note |

## Tests

`src/tests/loop/recap-rewind.test.ts` pins the contract: no-anchor,
anchor identity, no exposed index, merge-pair shape ending on `tool`, quoted
anchor + steering last, **repeatability**, **note-never-an-anchor**,
**compaction floor**, wrap-up mark clamping, and token recount.
