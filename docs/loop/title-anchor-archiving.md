# Title-Anchor Archiving (gentle segment compaction)

**Status:** plan (not yet implemented). Companion to `compact-working-memory.md`
(full autoCompact). Date: 2026-10-30.

## Motivation

Full `autoCompact` (`TOKEN_THRESHOLD`, triggered at the LLM stage in
`states/llm.ts:65-74`) is all-or-nothing: the whole conversation collapses to a
2-message summary pair via `store.replaceAll`. `mycc_title` is a natural topic
boundary the agent already maintains, so we can compact *incrementally*: on each
`mycc_title` call, archive the segment **up to and including the previous
title anchor**, keeping the tail verbatim:

```
system + populated + [chunk1 + anchorBatch] + chunk2 + mycc_titleBatch + …
   →  system + populated + summary + ack + chunk2 + mycc_titleBatch + ongoing
```

The archiving runs async in the background (fire-and-forget from the TOOL
state), so the user never feels the discontinuity. Full autoCompact remains as
the fallback when no previous anchor exists.

## Anchor definition (lookup, never cached)

Commit `d9cec7d` deleted `briefIndices`/`currentAnchorIndex`; the anchor is
therefore a **pure live-store scan at trigger time** — no stored indices, nothing
to reset on `replaceAll`/`clear`, nothing to shift after a swap. Archiving may
run any number of times per session; each run re-derives from the current array.

- A title anchor = the **entire batched round-trip** containing a `mycc_title`
  call: 1 assistant message with N `tool_calls` (one of which is
  `function.name === 'mycc_title'`) + all N following `tool` results.
- `MessageStore.titleAnchorEnds(): number[]` (new, `src/loop/triologue/store.ts`):
  scan the true array for assistant messages whose `tool_calls` include
  `mycc_title`; for each at index `a`, walk forward from `a+1` while
  `role === 'tool'` (hole-skipping, same defensive style as
  `firstMessageIndexAfter`) and record the last tool-result index = batch end.
  Uses only surviving primitives (`at`, `sliceFrom`, `firstMessageIndexAfter`).
- `previousTitleAnchorEnd(beforeAssistantIndex)` = last batch end whose
  assistant index < the current title call's assistant index. Segment to
  archive = `[0 … anchorEnd]` **inclusive**.

## Wiring: slice → summarize → swap → journal (no new param on `runAutoCompact`)

Four reusable steps; full autoCompact and archiving differ only in step 1:

1. **Slice.** Full: `deps.getRawMessages()` (whole array). Archiving:
   `store.sliceFrom(0, anchorEnd + 1)`. The `CompactDeps` adapter
   (`triologue.ts:660-664`) already injects the message source, so `compact.ts`
   keeps its exact signature — `runAutoCompact(deps, focus?, signal?, tools?)` —
   and existing callers (`triologue.ts:658`, `triologue-lite.ts:368`) are
   byte-identical. One wrinkle: `runAutoCompact` persists
   `saveTranscript(deps.getRawMessages())`; archiving needs the FULL transcript
   on disk, so archiving saves the full transcript itself before summarizing the
   slice (transcript JSONL format unchanged).
2. **Summarize** (shared, unchanged): `runAutoCompact` core in
   `src/loop/triologue/compact.ts` — `minifyMessages`, `buildSummaryPrompt`,
   concurrent focus extraction via `forkChat`, and `buildResumeRoundTrip`
   producing the parity-safe `user / assistant(brief call) / tool(brief result)`
   triple. The triple ends in `role === 'tool'`, so the message after the swap
   is a natural `tool → assistant` transition on the next LLM pass (same
   property the full compact relies on).
3. **Swap** (shared, extracted from `compact()`'s body at `triologue.ts:673-718`
   into `installCompacted(summaryTriple, tailFrom?, maxAttempts = 3)`) — **best-effort
   with retry; all-or-nothing, never a partial swap**:
   - Build the candidate array *before* touching the store:
     `next = tailFrom === undefined ? triple : [...triple, ...store.sliceFrom(tailFrom)]`.
   - Parity pre-check on `next` (roles alternate legally, ends in a state the
     next append can follow); if invalid, log and return `false` — **the store
     is left untouched**.
   - Only then `store.replaceAll(next)` (single synchronous assignment — the
     swap itself is atomic), `store.recomputeTokenCount()`,
     `rebuildProjectContext()` — both paths re-populate project context
     (no `populate` flag; per user feedback both re-populate).
   - If any step throws, retry up to `maxAttempts` (re-deriving `next` from the
     *current* store each attempt). On final failure, keep the original store
     (triologue never swapped) and journal the attempt, then return `false`.
   - Full autoCompact calls `installCompacted(triple)` (byte-identical happy
     path); archiving calls `installCompacted(triple, anchorEnd + 1)`.
4. **Transcript persistence of the summary (control record, never reloaded):**
   the existing JSONL control pieces (`kind: 'clear'|'compact'|'rollback'`,
   `transcript.ts:120-127`, journaled via `emitControl` /
   `Triologue.onMessage`) carry **no message fields — only `{kind,
   timestamp}`** — so they are journaled markers that no collation projection
   loads back into memory. Archiving therefore additionally appends a
   `kind: 'compact'` **payload-bearing control record** (new record shape,
   e.g. `{ kind: 'compact', timestamp, summary: <text>, anchorEnd }`) that
   logs the archived summary; `isControlKind` still matches it and both
   projections skip it exactly like the bare boundary, so it is durable in the
   JSONL but **never loaded into the live triologue**. `saveTranscript` still
   writes the full pre-archive transcript first (durable record unchanged).

## Concurrency / healthy-transition guarantees

Facts established from source:

- Full compaction runs **awaited at the LLM stage** (`llm.ts:65-74`:
  `needsCompact()` at `triologue.ts:636` = `store.tokenCount > tokenThreshold`,
  or hook-set `chat.deferredCompact` in `state-machine.ts:146/270-280`), i.e. at
a turn boundary, never mid-tool-execution.
- `runAutoCompact` (`compact.ts:143`) has no internal lock; `Promise.all` over
  `retryChat` + `forkChat` is the only await window.
- `store.replaceAll` is a single synchronous array assignment — the swap itself
  is atomic; the risk window is between *reading* the messages for
  summarization and the *swap*.

Design:

1. **Single serialization chain on `Triologue`:**
   `private compactChain: Promise<void> = Promise.resolve()`. Both `compact()`
   and `compactSegment()` enqueue:
   `this.compactChain = this.compactChain.then(run).catch(logAndClear)`. All
   `replaceAll` calls therefore happen strictly one-at-a-time; the store is
   never observed half-swapped, and triologue parity holds at every instant
   because each swap installs a self-contained parity-safe block.
2. **Staleness fingerprint:** before the async summarization, snapshot
   `{ len: store.length, anchorEnd, tail: store.at(anchorEnd + 1) }`. After the
   summary resolves, re-derive `titleAnchorEnds()` and verify the store is
   unchanged (same `at(anchorEnd)` object reference, `length` not shrunk). If a
   full compact / clear / another archiving intervened, **abort the swap** —
   the full compact already subsumes the segment, and the store stays as-is.
   This is the index-drift defense: indices are never cached, always re-derived.
3. **One-archiving-at-a-time:** the chain plus an `archivingQueued` flag —
   if a `mycc_title` arrives while an archiving is still queued/running, skip
   the new trigger (the running one will have archived up to the *previous*
   anchor anyway; the newest title call is never part of its own segment).
4. **Abort:** archiving accepts an `AbortSignal` (passed through to
   `retryChat`/`forkChat`); on session teardown the signal rejects and the
   chain catch swallows it, leaving the store untouched.
5. **Trigger safety:** the trigger in `states/tool.ts` only *enqueues* — it
   never awaits, never touches the store directly; the next LLM call re-reads
   the store via `getFullMessages()`, so a mid-turn swap is invisible to the
   user (same assumption the existing LLM-stage compact relies on).

## Changes

1. `src/loop/triologue/store.ts` — add `titleAnchorEnds()` (pure live scan,
   batch-aware, hole-skipping). No state, no reset hooks.
2. `src/loop/triologue/compact.ts` — **unchanged** (no range param).
3. `src/loop/triologue.ts` —
   - extract `installCompacted(triple, tailFrom?)` from `compact()` body;
   - add `compactChain` mutex; route `compact()` through it;
   - add `async compactSegment(currentTitleAssistantIndex, signal?): Promise<boolean>`:
     derive anchor → token floor (~2k, skip trivial) → fingerprint → enqueue on
     chain → save full transcript → ranged `runAutoCompact` via a sliced
     `CompactDeps` → re-check fingerprint → `installCompacted(triple,
     anchorEnd + 1)` (best-effort retry; on final failure the store remains
     unswapped) → append the `kind:'compact'` control record carrying the
     summary to the JSONL.
4. `src/loop/states/tool.ts` — in the `for (const toolCall of hookResult.calls)`
   loop (~`:60-210`), note `toolName === 'mycc_title'`; after the loop, if seen,
   `void env.triologue.compactSegment(assistantIndexOfBatch).catch(verbose)` —
   fire-and-forget.

## Assumptions

- Anchor = end of the whole 1+N batched round-trip containing the previous
  `mycc_title` call, inclusive (user-confirmed).
- Archiving fires regardless of `TOKEN_THRESHOLD`; full autoCompact unchanged and
  remains the fallback when no previous anchor exists.
- Lead-only (`mycc_title` is `scope: ['main']`); `triologue-lite.ts` untouched.
- Transcript JSONL: the full pre-archive transcript is still saved verbatim
  (`saveTranscript`), and the archived summary is additionally journaled as a
  **payload-bearing `kind: 'compact'` control record**
  (`{ kind: 'compact', timestamp, summary, anchorEnd }`) — durable in the
  JSONL, skipped by both collation projections (`isControlKind`), therefore
  never loaded back into the live triologue.

## Peer review (b12bb1fe, channel peer-sync) — incorporated

The same-folder peer reviewed this plan and the extraction commit 48e7f11
(APPROVED 4/4). Its findings are folded in:

1. `installCompacted` owns the FULL post-swap invariant set (done in 48e7f11,
   behaviour-preserving extraction; regression test for the wrapUpMark hazard
   landed as a separate commit).
2. Shrink gate is a RATIO, not an absolute floor: compare
   `estimateTokensForMessages(summaryTriple)` against
   `estimateTokensForMessages(store.sliceFrom(0, anchorEnd + 1))` — the SAME
   estimator (`src/utils/token.ts`) on slice-vs-slice, never against
   `store.tokenCount` (which counts the whole array incl. tail).
3. Segment summaries are FOCUS-FREE BY DESIGN: focus belongs to the live tail,
   which a segment archive does not cover, so the focus fork is dropped on the
   segment path (also avoids a cache-cold summary per title change).
4. Fingerprint compares `at(anchorEnd)` object identity only (length is
   misleading across appends and clear()+repopulate).
5. The trigger anchors on the assistant index observed at execution time
   (post-hook `hookResult.calls`), not a name re-scan of pre-hook tool_calls;
   and it fires on ALL exit paths of the tool loop, including the ESC
   early-return.
6. Segment archives journal a DISTINCT control kind `kind: 'segment-archive'`
   (added deliberately to the closed `ControlEvent` union in transcript.ts,
   with a comment that boundary markers never become messages and never cut
   the collated view), so transcript readers can tell "prefix archived" from
   "conversation fully replaced".
7. The swap pre-check is inside `installCompacted` itself (no-op guard for
   full compact): build `next`, parity-check, `agentIO`-warn + return `false`
   on failure (observable, never silent), retry up to N attempts re-deriving
   from the live store; on final failure the store stays unswapped.

## Execution order (peer-agreed)

1. installCompacted extraction as standalone behaviour-preserving commit
   (done: 48e7f11) + wrap-up observable regression test (done).
2. Parity pre-check with observable `false` return inside installCompacted.
3. `compactSegment` + `titleAnchorEnds()` live scan + trigger in tool.ts.

