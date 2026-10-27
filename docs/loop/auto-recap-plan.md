# Auto-Recap: remove the `recap` tool, fold spans on a signal

Status: **plan (not implemented)**
Supersedes: the model-volition recap described in `brief-and-recap-rewind.md`,
`brief-recap-loopholes.md`, `src/tools/recap.ts`.

## 1. Why

The `recap` tool is never called by the LLM in practice. It is a META-TOOL
(definition in `src/tools/recap.ts`, real work in `src/loop/states/hook.ts`
`handleRecapCall`, guard in `src/loop/recap-rewind.ts`) whose whole existence
depends on the model *choosing* to fold its own history. It does not.

The `pitfall` wiki domain already records this exact failure for the earlier
"manual checkpoint tool" (hash `c5e0818f7628e7e2`): a rewind the model has to
elect is a rewind that never happens. The fix that entry prescribes is passive
anchors — every `brief` is already an anchor — and it is what this plan
completes: **the decision to fold moves out of the conversation and into a
dedicated observer that reads the brief stack.**

Root invariant worth naming, because every detail below follows from it:

> **Rewind authority is external to the context being rewound.**
> The decision is made from the brief stack (outside the transcript);
> the application is a span rewrite (inside the transcript).

The LLM still builds its context — in chunks delimited by its own `brief`
calls. It just no longer decides when a chunk is closed.

## 2. Shape of the change

```
BEFORE (model-volition)                          AFTER (observer)

  LLM calls recap(target_brief, summary)           LLM calls brief  ──┐
        │                                                             │ HOOK stage, step 4a
        ▼                                                             ▼
  HOOK step 4 → handleRecapCall                 recap-signal (retryChat, LEAD ONLY)
        │                                        ctx = brief list + usage
        ├─ validate target/args                       │
        ├─ forkChat: mindmap patch               "fold / don't fold + target"
        ├─ size pre-check                             │
        └─ rewindToLastBrief(note = model text)      ▼
                                                 on "fold":
                                                   ├─ forkChat #1: summarize span   (cached prefix)
                                                   ├─ formatOpenTodos (pure)
                                                   ├─ forkChat #2: mindmap patch   (cached prefix)
                                                   ├─ size pre-check
                                                   ├─ rewindToLastBrief(note = summary)
                                                   └─ audit record in triologue JSONL
                                                 then step 6 registers the CURRENT brief turn
```

The fold happens **on a `brief` turn**, *before* that brief is registered.
That is deliberate and is the whole reason the feature works:

* the fork prefix ends on the *previous* brief's complete round-trip →
  `assistant(tool_calls)` + `tool(result)`, which strict providers accept
  (the same constraint documented on `handlePlanScopeBrief`);
* the truncation cannot touch the in-flight turn;
* the current brief then lands as the **first message of the new chunk**:

```
[anchor + [RECAP] note] → [new brief] → work → (next fold) → [new brief] → …
```

This is the "build the context in chunks of briefs" model. The `brief` is both
the chunk boundary and the trigger; a fold is allowed to undermine the effort
invested in the brief it just wrote, because the span summary preserves it.

## 3. The recap-signal

New module: `src/loop/recap-signal.ts`.

A **dedicated `retryChat`** — *not* a `forkChat` of the conversation. Its entire
context is the brief list, so it is small, cache-independent, and cannot leak
span content.

```ts
export type RecapSignal =
  | { status: 'recap'; target: string; reason: string }   // target = brief hash
  | { status: 'skip'; reason: string }
  | { status: 'failed' };                                  // throw / abort — never fatal

export async function evaluateRecapSignal(
  candidates: FoldCandidate[],          // timely order, oldest → newest
  usage: { tokens: number; threshold: number },
  escAware?: EscAware,
): Promise<RecapSignal>;
```

`FoldCandidate` comes from the brief stack (see §4):
`{ hash, message, spanMessages, spanTokens }`.

Prompt (system): *you decide whether a finished span of an agent's work should
be folded into a summary; be conservative; fold only spans whose work is
complete or superseded.*

Prompt (user): the list, one line per candidate —

```
[d13ece84] "…brief message, ≤200 chars…"   after it: 18 msgs / ~14.2k tok
[c5e0818f] "…"                             after it: 41 msgs / ~31.0k tok
context 47.8k / 50.0k
```

Tool (forced, `tool_choice: 'required'`, mirroring `keyword-extractor.ts`):

```json
{ "name": "decide_recap",
  "parameters": { "recap": "boolean", "target_brief": "string", "reason": "string" } }
```

* `retryChat({...}, { signal, noSpinner: true, maxRetries: 2 })` — **2**, to raise
  the success rate of the structured call.
* One `startSpinner`/`stopSpinner` pair around it with the text
  **`Managing the context…`** (`retryChat` paints nothing with `noSpinner`, so
  the lead needs its own wait indicator; one pair, not refcounted — see §9).
* Nothing is written to the triologue or its JSONL during this step: the call
  touches no store, and the verdict is reported to the user via verbose log
  only (a `brief`-channel line for every brief turn would be noise).
* Validation: `recap: true` with a `target_brief` that is not in
  `getFoldCandidates()` → degrade to `skip` (never fold somewhere unnamed).
* A throw / ESC → `failed`. All three outcomes are non-fatal.

**The hash is internal only.** The model never sees a hash in a brief result
(§6); the signal sees them because it is an observer, and the loop resolves the
returned hash back to a call id locally.

## 4. Brief-stack plumbing (the only new data API)

`src/loop/triologue/brief-stack.ts`:

```ts
getFoldCandidates(): Array<{
  hash: string; message: string; id: string;
  spanMessages: number; spanTokens: number;   // estimate: spanChars / 4
}>
```

Reuses the existing `resolveAnchor` walk; no new message logic. Exposed through
`src/loop/triologue.ts` alongside `listBriefHashes`. It replaces the
model-facing `listBriefHashes(true)` / `listOpenAnchors()` prompt feed, which
are deleted (§6).

Target resolution: the signal's hash → call id. `resolveBriefTarget` (already
in `recap-note.ts`) does this and is **kept**, but is no longer reachable from
model input; only from the loop.

## 5. HOOK wiring

`src/loop/states/hook.ts`:

* **Delete** step 2b (`validateRecapIsolation` block), step 4 (`recap` meta-tool
  dispatch), and `handleRecapCall` (~280 lines).
* **Add step 4a — `maybeAutoRecap(env, turn, chat, hookResult)`**, before the
  plan-scope branch (4b):

```
runs iff ALL hold
  env.scope === 'main'                          // lead only; teammates never fold
  !shouldDisableRecap()                             // --disable-recap / MYCC_NO_RECAP=1
  this turn carries an UNBLOCKED `brief` call   // THE trigger (not an exclusion)
  !agentIO.isNeglectedMode()
  !hookResult.compactRequested && !chat.deferredCompact
  getFoldCandidates().length > 0                // something to fold into
```

No span-size gate, no cooldown, no anti-churn guard: the signal decides, and it
is given per-span sizes plus current usage. Structural self-regulation is
already present — a successful fold consumes its target (the anchor's span is
gone and `getFoldCandidates` excludes a brief with nothing after it), and the
triggering `brief` lands *after* the truncation.

Returns **`void`** — never a `HandlerResult`. Every failure path means "do not
fold, run the brief normally". (Contrast: `handleRecapCall` returned `STOP` on
ESC.)

On a successful fold set `chat.autoRecapFolded = true`; `handlePlanScopeBrief`
returns `null` when that flag is set, because a plan-mode reflection would
describe work that is now folded.

After the fold: `turn.lastBriefMessage = result.anchorMessage`,
`turn.nextBriefNudge = 5`, `turn.isFirstRound` untouched (the turn continues).
Then execution falls through to step 6, which registers the current brief turn
as the first message of the new chunk.

## 6. The fold

`src/loop/recap-rewind.ts`:

```ts
handleRecapSpan(...)  →  handleRecapForks(
  fullMessages: Message[],   // pre-registration snapshot (cache prefix)
  allTools: Tool[],          // full `main` tool list (cache)
  mindmap: Mindmap | null,
  span: Message[],           // the region about to be deleted
  anchorMessage: string,
  escAware?: EscAware,
): Promise<{ summary: string | null; patch: MindmapPatchAction | null;
              patchError: string | null; escCancelled: boolean }>
```

Three parts, **all conditional on the signal**:

1. **summarize the span** — `forkChat(fullMessages, allTools, prompt, signal, 'none')`.
   Prompt: *what the span found, what now holds, how the next turn should
   proceed*. No preamble, no headings duplicated in the note.
2. **render the todo list** — `formatOpenTodos(ctx.todo.getItems())`, pure, no LLM.
3. **mindmap patch** — the existing `generatePatchAction`, best-effort.

(1) and (3) run under **one** `startSpinner`/`stopSpinner` pair
(`Promise.all`), both on the same `fullMessages` + full `allTools` so they hit
the prompt cache the main loop already paid for. ESC → `escCancelled: true` →
**nothing is collapsed**, the turn continues normally.

The spinner text is **`Summarizing last N chunks…`**, where `N` is the number
of brief-delimited chunks being folded: the ordinal distance from the target
anchor to the newest foldable anchor, inclusive
(`getFoldCandidates().findIndex(c => c.hash === target)` offset). It is computed
from the candidate list the signal was given — no extra bookkeeping. When `N`
is 1 it reads `Summarizing last 1 chunk…` (singular).

Neither fork writes to the JSONL: they only produce strings. The single append
for the whole fold happens after the rewrite, in §9.

`validateRecapIsolation` is deleted with the tool it guarded.

**Cost model** (explicit, because the two call kinds differ):

| Call | Kind | Cache | Frequency |
|---|---|---|---|
| recap-signal | `retryChat` | none — fresh small context (brief list + usage) | every qualifying `brief` turn |
| span summary | `forkChat` | hits the cached prefix (full messages + full `main` tools) | only when the signal returns `recap` |
| mindmap patch | `forkChat` | same cached prefix | only when the signal returns `recap` |

Steady state is one cheap uncached `retryChat` per brief turn; the two cached
forks are paid only on an actual fold.

## 7. Injection — the rewind is called as-is

The primitive is **not refactored**. `getLastBrief`, `rewindToLastBrief` and
`recapNoteSize` keep their behaviour and signature; the loop passes:

```ts
const result = triologue.rewindToLastBrief(
  noteBody,        // the fork's summary (+ "User's last query (context)" )
  anchor.id,       // compare-and-swap token
  targetHash,      // resolved from the signal
  openTodos,       // rendered checklist
);
```

Kept from the current implementation, unchanged:

* `recapNoteSize()` pre-check before touching the store (an over-size note must
  not coexist with an already-truncated span);
* the `**User's last query (context):**` section;
* the anchor-moved CAS refusal (`result === null` → warn, nothing collapsed);
* `formatOpenTodos` as the note's third part (the live state the next turn
  resumes with);
* the post-rewind resync of `turn.lastBriefMessage` / `nextBriefNudge`.

Changed only because the visible anchor line disappears:

* `noteWithSummary(callId, body, firstLine)` → the note **is** the whole result.
  `anchorLineToKeep(firstLine)` now yields `undefined` for a plain `OK.` brief
  result, so the fallback renders the marker instead of a hash line:

```
BEFORE  [d13ece84] ANCHOR — recap(target_brief="d13ece84") folds the work after this point
        Note, a recap has reset the conversation here with summary: <body>

AFTER   [RECAP]
        <body>

        ### Open todos
        …
```

* `recapNoteSize()` measures that same rendered string (the size rule and the
  writer stay ONE rule — see `buildRecapNote`'s header comment).

**Summary floor.** The summary is now machine-generated. An unusable one
(empty / under `MIN_RECAP_SUMMARY_CHARS` / whitespace) is a reason to *keep the
span*: warn + `agentIO.verbose`, fold nothing, run the turn normally. The model
is never asked to retry — there is no model in this loop.

## 8. Remove the anchor vocabulary from what the LLM sees

With `recap` gone there is no model-side address, and a hash in a brief result
would be an affordance pointing at a deleted tool. `brief` therefore returns
plain `OK.` and nothing else.

`src/loop/triologue/recap-note.ts` — **delete**:

| Symbol | Why it dies |
|---|---|
| `BRIEF_ANCHOR_WORD`, `briefResultLine`, `foldCall` | printed the address + the call shape |
| `hasFoldInvitation`, `withoutFoldInvitation` | existed only to retire the call shape after a fold |
| `withOpenAnchors`, `OPEN_LIST_MAX` | listed *other* anchors the model could choose |
| `stampBriefResult`, `briefStampedLength` | stamped the anchor line into the tool result |
| `briefReceiptLine` | the child/synthetic receipt of the same line |
| `hashOf`, `stripHashPrefix` | read the `[<hash>]` prefix back |
| `anchoredNoteLength` | measured anchor line + note; replaced by a plain note length |

**Keep**: `BRIEF_HASH_LENGTH`, `briefHash` (internal — signal list + audit),
`PLAN_SCOPE_HEADING`, `hasPlanScopeSection`, `OPEN_TODOS_HEADING`,
`formatOpenTodos`, `resolveBriefTarget` (internal target resolution),
`buildRecapNote` (header simplified to the bare `[RECAP]` marker; the
`Rewound past the brief: "…"` line is dropped — the anchor message is preserved
in the audit record instead), `noteWithSummary`.

(`BRIEF_OK` was subsequently inlined — it was a one-word constant (`'OK'`) read
by four call sites, so the literal `'OK.'` now appears where the result is
built and `recap-note.ts` no longer exports it.)

Other call sites:

| File | Change |
|---|---|
| `src/tools/recap.ts` | **delete** |
| `src/context/shared/registry.ts` | drop import (L55) + array entry (L110) |
| `src/loop/states/tool.ts` | drop the `brief` stamping branch and `childBriefReceipt`; a brief result is returned untouched |
| `src/loop/states/hook.ts` | crossroad brief → plain `OK` (drop `briefReceiptLine`, drop `openAnchors` in `handlePlanScopeBrief`) |
| `src/loop/states/llm.ts` | empty-output recovery brief → plain `OK` |
| `src/loop/triologue/compact.ts` | floor brief → plain `OK` |
| `src/loop/plan-scope.ts` | drop `openAnchors` dep; budget = `resultThreshold - 'OK.'.length - overhead` |
| `src/loop/triologue/brief-stack.ts` | `anchorLineToKeep` reduced to "no anchor line to keep"; `listBriefHashes` / `listOpenAnchors` / `targetRefusal` deleted (replaced by `getFoldCandidates`); the "a `recap` round-trip is not activity" skip rule is dropped with the tool (legacy sessions are not parsed — see §15) |
| `src/loop/prompts/common.ts` | rewrite `buildBriefRecapSection()` (no `recap(...)`, no hashes, no anchor/checkpoint vocabulary): *finished spans are folded automatically; a `[RECAP]` note replaces everything after the last brief and is authoritative — read it as your current state; write briefs self-contained because a summary of the span follows them*. Fix L158 ("rewind your own exploration") |
| `src/tools/brief.ts` | comment block only (the anchor contract it referenced is gone) |

**`validateBriefIsolation` + the `brief-isolation` skill stay.** Their old
justification ("the model needs an unambiguous target") died with `recap`; the
surviving one is narrower and is what must be written down: the anchor's
round-trip must be a clean boundary for the loop's slice arithmetic
(`resolveAnchor` → `resultIndex + 1` → `sliceFrom`). A brief batched with other
calls still yields a well-defined but *mid-turn* boundary that the slice and
the TP-parity handoff were never designed to reason about.

## 9. Observability and the audit trail

One trigger produces three reporting moments, in this order. **The invariant is
append ORDER, not spinner text:** the session JSONL gains exactly one record per
fold, and it is appended only after the rewind has completed.

| # | When | Terminal | JSONL |
|---|---|---|---|
| 1 | signal evaluating | spinner `Managing the context…` | **nothing** |
| 2 | signal said `recap`, forks running | spinner `Summarizing last N chunks…` | **nothing** |
| 3 | rewind succeeded | `[recap]` block | **one** `recap_audit` record |

Non-`recap` verdicts stop at #1: `skip` / `failed` / ESC produce no #2, no #3,
no append — the brief turn proceeds as if the feature were off.

**1. Signal spinner** — call site: top of `maybeAutoRecap()` (`states/hook.ts`,
step 4a), immediately before `evaluateRecapSignal(...)`; `stopSpinner()` in its
`finally`. The signal `retryChat` is `noSpinner`, so this is the lead's only
wait indicator. Its store surface is zero: it is handed a plain
`FoldCandidate[]` + usage numbers and returns a verdict — no triologue read, no
write, no message.

**2. Fold spinner** — call site: inside `handleRecapForks()` (`recap-rewind.ts`),
one `startSpinner('Summarizing last N chunks…')` / `stopSpinner()` pair around
the `Promise.all` of summary + patch (the pair already exists there for the
patch fork; only the text and the `N` are new). Both forks return strings; no
`triologue.*` call happens inside the pair.

**TTY-ONLY CAVEAT.** `startSpinner()` is a no-op when `isPlainOutput()` is true
(piped stdout, or `--debug-ansi`), so the two spinner strings are **not**
asserted in tests — they are a `--debug-ansi`-off manual check (§13). What tests
assert is the append-order invariant above: `captureLoopEvents()` + a transcript
writer spy must show **zero** records between the brief turn starting and the
rewind returning, then exactly one `recap_audit`.

**3. After the rewind, two things:**

```
ctx.core.brief('info', 'recap', summaryText.split('\n')[0] …)   // the visible "recap" block
triologue.journalRecapAudit(auditFields)                         // the synthesized JSONL record
```

The user-facing block is the existing `recap` channel that `handleRecapCall`
already used, so the terminal rendering is unchanged:

```
[recap] Span complete; direction superseded
        (47,812 → 12,040 tokens)
```

The JSONL record is a **`recap_audit`** — its OWN non-user kind, written by
`Triologue.journalRecapAudit()`. It is *not* `submitUser(…, 'steer')` (the
shape an earlier draft of this plan chose). Why that was wrong: `'steer'` is
the user-input journal, and the transcript is the single source of truth for
WebUI right-side user bubbles — so every past fold was reconstructed as
something the user had typed after a serve reload. `'steer'` is ALSO the kind
carried by genuine typed steering notes, so filtering `'steer'` at read time
would have deleted real user bubbles. A fold has no user behind it (the
decision is made outside the conversation), so it needs a kind of its own.

`recap_audit` is neither a user-journal record nor a boundary marker:

* **BOTH projections skip it** — `collateMessages` (restoration) yields no
  message and `collateEntries` (serve `/history`) yields no bubble. A restored
  session gains no phantom user turn;
* it is distinct from `{kind:'recap'}`, the payload-free truncation mark
  `truncateAndRecount` emits. Conflating them would make one kind mean two
  things in a single stream;
* it carries **no `role`** (so no projection can mistake it for a message) and
  a `content` string (so it stays greppable), plus the structured `audit`
  fields. `readTranscript` refuses a `recap_audit` record that carries a
  `role`, or that has no `content` string;
* like `submitUser`, it is journal-only: no store push, no ledger touch, no
  `lastUserQuery` write, therefore no TP-parity risk mid-turn. `triologue.user()`
  would instead land a real `role:'user'` between the anchor's `tool` result and
  the next `assistant` — a `tool → user` TP violation;
* one record per fold, carrying what an auditor needs:

```
[RECAP] Folded 18 messages / ~14.2k tokens back to brief
"…target message, ≤120 chars…" (span complete; direction superseded).
Summary: <the full [RECAP] body>
```

## 10. Configuration

* `src/config.ts` — `shouldDisableRecap(): boolean` → `MYCC_NO_RECAP === '1'`.
* `src/help.ts` + `README.md` flag table — `--disable-recap`
  (*"Disable automatic span folding (auto-recap); briefs then only report
  status"*). No env fallback for the CLI flag, mirroring `shouldAllowPlanOff`'s
  anti-stale-env comment.
* Default: **enabled**.

## 11. Docs, skills, knowledge

* `docs/loop/brief-and-recap-rewind.md` — rewrite around the observer model
  (replaces the tool-volition narrative).
* `docs/loop/brief-recap-loopholes.md` — re-cut the contract table C1–C10:
  C1 (failure does not roll back) becomes "a failed signal/fork folds nothing";
  C2 ("recap round-trip is not activity") is **deleted** — the rule existed to stop a
  tool-produced round-trip from counting as span activity, and that tool is gone
  (legacy sessions are not parsed, §15); C3 (summary
  floor) becomes "keep the span"; C5/C9 (anchor identity / result-by-name)
  unchanged; C10 unchanged.
* `docs/tools/agent-tools.md` — remove `recap`; main-only tools 14 → 13.
* `docs/loop/agent-loop.md` — HOOK stage now has a 4a branch.
* `MYCC.md` — terminology (`brief and recap`), the main-only tool list, the
  `recap` META-TOOL mention.
* `skills/brief-isolation/SKILL.md` — restate the rationale per §8.
* wiki `pitfall` — record the outcome (auto-recap replaced volition) once
  implemented, so future plans do not re-litigate it.

## 12. Tests

**Delete**
`src/tests/loop/states/hook-recap-contract.test.ts`,
`src/tests/loop/states/recap-rewind-empty-summary.test.ts`,
`src/tests/loop/states/hook-esc-recap.test.ts`.

**Rewrite** (anchor text is gone; behaviour otherwise similar)
`recap-rewind.test.ts` (82 anchor hits), `recap-rewind-regressions.test.ts` (44),
`recap-rewind-scenarios.test.ts` (35), `triologue-recap-note.test.ts` (33),
`recap-rewind-anchor.test.ts` (31), `recap-rewind-identity.test.ts` (22),
`recap-note-open-todos.test.ts` (13), `hook-plan-scope.test.ts` (10),
`prompts/brief-recap-scope.test.ts` (6).

**Adjust** (call-shape only)
`loop/mock-harness.ts`, `loop/path-generator.ts`,
`states/hook-brief-isolation.test.ts`,
`states/hook-esc-and-brief-isolation.test.ts`,
`triologue-piece-contract.test.ts`, `triologue.test.ts`,
`tools/brief.test.ts`, `loop/prompt-budget.test.ts`.

**New**
* `src/tests/loop/recap-signal.test.ts` — three verdicts; invalid/absent
  `target_brief` → `skip`; `failed` on throw; `maxRetries: 2`; the prompt
  contains exactly one line per candidate in timely order.
* `src/tests/loop/states/auto-recap-hook.test.ts` —
  folds at step 4a **before** the current brief is registered; the current
  brief survives as the first message of the new chunk; TP parity holds
  (`tool → assistant(tool_calls: brief) → tool`); `--disable-recap`, neglected mode,
  `compactRequested`, non-brief turns, empty candidate list and `failed` all
  fold nothing; plan-scope reflection is skipped on a fold turn; summary/patch
  forks receive the un-minified prefix + full tool list (cache invariant).
* `src/tests/loop/transcript-recap-audit.test.ts` — after a fold the JSONL gains
  exactly one `{kind:'recap_audit', content}` record (no `role`); BOTH `collateMessages`
  and `collateEntries` skip it, so replay/livelog parity is unchanged AND no user
  bubble is rendered; nothing is appended while the signal or the forks run.

## 13. Verification

```
npm run typecheck:all      → 0 error
npx vitest run             → green
npm run lint               → 0 new
```

Manual (a real terminal — the spinners are suppressed under `--debug-ansi`, so
check the spinners with plain `mycc`, and the notes/JSONL with either):

1. `recap` is absent from the tool schema the model receives.
2. Every `brief` result is exactly `OK.` — no hash, no `ANCHOR`, no `· open:`.
3. After a valid brief, the spinner reads `Managing the context…`, and the
   session JSONL does not grow during it.
4. On a `recap` verdict the spinner becomes `Summarizing last N chunks…`
   (`N` = chunks folded), and the JSONL still does not grow.
5. A fold produces exactly one `[RECAP]` note, positioned as the last thing
   before the new chunk's brief, plus one `[recap]` display block
   (`<first summary line>` / `(47,812 → 12,040 tokens)`).
6. Exactly one `{kind:'recap_audit'}` audit record per fold; reloading
   the session (`/load`) shows no phantom user bubble from it.
7. The next turn resumes from the note; open todos render with `#id` + `hash`.
8. `--disable-recap` suppresses all folding — no spinners, no notes, no records;
   briefs still report normally.

## 14. Execution order

| Phase | Work | Files |
|---|---|---|
| 0 | config flag + help | `config.ts`, `help.ts` |
| 1 | `getFoldCandidates()` + triologue exposure + `auto_recap` loop event | `triologue/brief-stack.ts`, `triologue.ts`, `loop-events.ts` |
| 2 | `recap-signal.ts` + its tests | new module, new test |
| 3 | `handleRecapForks` (summary + todos + patch) | `recap-rewind.ts` |
| 4 | HOOK wiring: delete 2b/4, add 4a | `states/hook.ts` |
| 5 | vocabulary removal (all call sites) | `recap-note.ts`, `tool.ts`, `llm.ts`, `compact.ts`, `plan-scope.ts`, `brief-stack.ts`, `prompts/common.ts`, `tools/brief.ts` |
| 6 | delete `recap` tool + registry | `tools/recap.ts`, `registry.ts` |
| 7 | audit: `journalRecapAudit(fields)` after the rewind + display block | `states/hook.ts` + a `recap_audit` kind in `transcript.ts` |
| 8 | docs, skills, wiki | §11 |
| 9 | test sweep + verification | §12, §13 |

Phases 1–4 are additive (the old path still works); phase 5–6 is the cut-over
and must land as one commit, because after it no brief result carries an
anchor line.

## Status (implemented)

Phases 0–9 are complete. What the plan asked for, as landed:

- Flags: `--disable-recap` / `MYCC_NO_RECAP=1` (`arg-canonical.ts`, `config.ts#shouldDisableRecap`,
  `help.ts`, README).
- `src/loop/recap-signal.ts` — `evaluateRecapSignal()`, forced `decide_recap`,
  `recap` / `skip` / `failed`, unknown target → `skip`, never throws, one
  `Managing the context…` spinner pair, `maxRetries: 2`.
- `src/loop/triologue/brief-stack.ts#getFoldCandidates()` (+ facade
  `Triologue.getFoldCandidates()`).
- `src/loop/recap-rewind.ts#handleRecapForks()` — summary + mindmap-patch forks
  under one `Summarizing last N chunks…` spinner, `commitMindmapPatch()`.
- `src/loop/states/hook.ts` step 4a `handleAutoRecap()` — lead-only, before the
  triggering brief is registered, every failure folds nothing, `[recap]` block +
  one `journalRecapAudit(…)` + `loopEvents` `auto_recap`,
  `chat.autoRecapFolded` suppresses plan-scope reflection.
- Anchor vocabulary removed from every model-facing surface (`brief` result is
  `OK.`; `recap-note.ts` renders `[RECAP]` + summary + `### Open todos`).
- `src/tools/recap.ts` deleted; registry cleaned.
- Docs/skills/README/MYCC.md rewritten — see §11.

**Tests:** `src/tests/loop/recap-signal.test.ts` (new), auto-recap cases in
`hook-esc-and-brief-isolation.test.ts` (fold / ESC / failed summary / skip verdict /
`--disable-recap` / non-brief turn / fork inputs), every anchor-vocabulary assertion
rewritten.

**Gates (2026-10-27):**

```
npm run typecheck:all   → 0 error
npx vitest run          → 257 files passed, 3809 tests passed (5 skipped)
npm run lint            → 0 errors (4 pre-existing prefer-template warnings)
```

## 15. Risks

1. **Cache invariant** — the summary and patch forks must receive the
   un-minified `fullMessages` and the complete `main` tool list, or they lose
   the prefix cache. Asserted in `auto-recap-hook.test.ts`.
2. **Prompt churn** — removing the anchor vocabulary touches ~200 lines across
   9 source files and 9 test suites, but every change is mechanical deletion;
   no behavioural coupling remains once the tool is gone.
3. **First-turn timing** — the fold runs before the triggering brief is
   registered. If a future branch registers the assistant message earlier
   (e.g. hooks running after registration), the fork prefix becomes
   `assistant(tool_calls) → user` and strict providers 400. The 4a ordering
   comment must stay adjacent to the call.
4. **Legacy transcripts are out of scope — no compatibility shims.** Sessions
   written before this change are not parsed by the new code path, so nothing
   has to keep understanding `[<hash>] ANCHOR …` results or `recap` round-trips.
   That is why the `recap`-round-trip skip rule and the `hashOf` / `hash`
   readers can be deleted outright rather than kept as legacy branches: a
   fresh session is the only input, and the migration cost is falling on the
   old sessions, not on the code.
