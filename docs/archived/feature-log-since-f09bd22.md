# Feature log: everything since `f09bd22`

Status: **ARCHIVED / REVERTED**. This document is the durable record of the
24 commits made on `main` after `f09bd22d73eed84068648ac621851b747bac5d66`,
grouped into six revert-coherent groups. The commits were reverted with
`git revert` (history preserved, no force-push, no rewrite) so the features can
be reworked later from a clean base. Nothing here was "undone" — every group
below is recoverable by reverting the revert commits, or by
`git checkout <sha> -- <paths>`.

Base: `f09bd22` · Head before revert: `48fb890` · Scope: 166 files,
+13,304 / −4,177 lines.

| Group | Theme | Commits (chronological) |
|---|---|---|
| A | Recap: two-field schema + authoritative todo list to the WebUI | `f028f12` `e450de1` `b52ff0c` `80a468c` `108ba03` |
| B | Recap: lead-only auto-recap replaces the `recap` tool | `8493128` `811509c` `0831ed6` |
| C | Hint round: one singleton, out-of-band state, grant denial recorder | `7e7acef` `649a54a` `4aac58b` `900ecf1` |
| D | Todo / `preventStop` stop-guard + populator delivery + WebUI todo cards | `31e9333` `ea4a2c2` `3b6c8bf` `da822d5` `48fb890` |
| E | `/auto-commit`: runtime auto-commit allow-list slash command | `e5b4032` `44ef2c8` |
| F | Crossroad preview hardening + WebUI steering boomerang fix | `7253a55` `7f47058` `71eb910` `efcfe81` |
| — | Cross-cutting defect sweep (spans C, D, F) | `bcd0dce` |

`bcd0dce` is the only commit that cannot be assigned to a single group: it is a
review follow-up that fixes defects introduced by C (`hint-round`/grant
recorder), D (`preventStop` hash echo, stale-hash lineage) and F (web socket
retirement + resolve ack). It was reverted first (see recipe).

---

## Group A — Recap two-field schema and the authoritative todo list

Commits: `f028f12`, `e450de1`, `b52ff0c`, `80a468c`, `108ba03`.

### What it did

1. **Brief anchor affordance** (`f028f12`). A brief tool result used to open
   with a receipt `[<hash>] OK`. It now opens with
   `[<hash>] ANCHOR — recap(target="<hash>") folds the work after this point`
   followed by `· open: a, b, c (+2 more)`. Teammate briefs and synthetic
   briefs (crossroad, empty-output recovery) deliberately keep `[<hash>] OK`,
   because the invitation would be false for them. Plan-mode briefs are stamped
   by the HOOK stage so they also get an anchor. One gate
   (`anchorLineToKeep`) serves both the rewind write and the size pre-check;
   refusals split "unknown hash" from "nothing after the anchor yet".
2. **Span wording** (`e450de1`). The recap progress strings no longer claim the
   span is "since your last brief"; the span is what follows the anchor. The
   abandon path announces the discard before doing it.
3. **Two-field recap schema** (`b52ff0c`). `recap` takes exactly
   `target_brief` + `summary`; the summary is copied **verbatim** into the
   anchor's tool result after a bare `[RECAP]` line. `description`, `abandon`
   and `comment` are gone (`abandon` → `summary: ""`); `target_brief` is
   required and never defaulted. The summarization fork was removed; the
   mindmap-patch fork was kept.
4. **Authoritative todo list end to end** (`b52ff0c`, WebUI half).
   `todo_changed` is emitted from every todo mutation on the loop event bus;
   `/history` ships a bare `todos` array and folds it into its ETag; the WebUI
   is seeded on boot and on session change, receives a snapshot on WS connect,
   and keeps its rows when the field is absent. A restart re-seeds via
   `activateServe`. New modules: `src/serve/serve-todos.ts`,
   `src/web/src/todo-payload.ts`, `src/web/src/todo-header.ts`,
   `src/web/src/session-reset.ts`, `src/web/src/resolve-guard.ts`
   (the last one belongs to F but was introduced in this arc's web work).
5. **Schema review fixes** (`80a468c`). The invitation string now names the
   real argument (`target_brief`, not `target`); ESC during the mindmap-patch
   fork aborts the fold instead of collapsing the span; `abandon` is decided on
   the raw summary; the lead prompt and plan-scope text teach the two-field
   schema; refusals quote the hashes that work; new
   `hook-recap-contract.test.ts` drives the real HOOK path; serve limits
   (dedupe at the sink, code-point clamping, length-prefixed ETag token) got
   tests.
6. **Dead fork deletion** (`108ba03`). `handleRecap` + `buildRecapPrompt`
   (no production caller) were deleted from `src/loop/recap-rewind.ts`; the
   cache invariant moved to `generatePatchAction`.

### Files / surfaces
`src/loop/recap-rewind.ts`, `src/loop/states/hook.ts`,
`src/loop/triologue/{recap-note,brief-stack,compact,types,store}.ts`,
`src/tools/{recap,brief}.ts`, `src/loop/prompts/common.ts`,
`src/loop/plan-scope.ts`, `src/loop/serve-wiring.ts`,
`src/serve/{serve-todos,serve-hub,serve-registry,serve-history,activate,serve-clients}.ts`,
`src/web/src/**`, `src/context/shared/todo.ts`, `src/context/teammate-worker.ts`.

### Rework notes
This is the group most likely to be re-attempted: the recap *tool* (model
chooses the fold) exists at `f09bd22` and was still present here. Group B
deletes it — if the rework restores a model-driven fold, start from A and skip B.

---

## Group B — Lead-only automatic recap (the `recap` tool is deleted)

Commits: `8493128`, `811509c`, `0831ed6`.

### What it did

1. **Auto-recap replaces the meta-tool** (`8493128`). The `recap` tool was
   deleted (49 → 48 built-in tools). Rewind authority moved **outside** the
   context being rewound: on a brief turn, HOOK step 4a — before that brief is
   registered, so the fork prefix stays fully answered — asks
   `src/loop/recap-signal.ts`, a compact `retryChat` with a forced
   `decide_recap` tool that reads only `Triologue.getFoldCandidates()` + token
   usage, whether to fold an older span. Verdicts: `recap` / `skip` /
   `failed`; an unaddressable target degrades to `skip`, never a default; the
   signal never throws. `handleRecapForks()` runs the summary and mindmap-patch
   forks under one spinner, then `rewindToLastBrief()` truncates and rewrites
   the anchor's tool result with the `[RECAP]` note (summary + last query +
   `### Open todos`).
   Model-facing anchor vocabulary was removed: no `[<hash>] ANCHOR`, no
   `recap(target_brief=…)`, no `open:` lists — a brief result is a plain
   `OK.`. New off switch `--disable-recap` / `MYCC_NO_RECAP=1`. Lead prompt
   section becomes "Briefs and Folding".
2. **Hardening** (`811509c`). ESC becomes a fourth verdict (`esc` → STOP) for
   the signal and both forks; `failed` verdicts carry `describeError()` text;
   `AutoRecapPayload` added to the loop-event union without fabricated
   `targetHash`; snake-or-camel `tool_choice` accepted for DeepSeek;
   `getFoldCandidates()` skips orphan briefs (`resultIdx < 0`) that would
   otherwise degrade every brief turn to a permanent skip; brief messages get a
   two-tier budget (target 100 / max 200 tokens) enforced in both
   `tools/brief.ts` and the plan-scope HOOK brief; a completed fold is journaled
   as `kind: 'recap_audit'` instead of `'steer'`; `--no-recap` renamed to
   `--disable-recap`; `todo_update` may omit `done` to preserve state.
3. **Atomic post-fold commit** (`0831ed6`). `rewindToLastBrief()` is the point
   of no return; the commit is now staged by irreversibility.
   `store.tryRewriteToolResult()` is the never-throwing,
   verified rewrite-or-restore primitive; `noteIsStored()/isRecapNoteStored()`
   reconcile by evidence; token counts are recounted unconditionally after the
   truncation; the audit record is written before the loop event and the patch;
   `auto_recap` is emitted once with verdict `recap` or `partial`, naming
   defects in `reason`. No rollback is offered — the honest outcome of a late
   failure is "folded, with a listed defect".

### Files / surfaces
New: `src/loop/recap-signal.ts`, `docs/loop/auto-recap-plan.md`.
Heavy: `src/loop/states/hook.ts`, `src/loop/recap-rewind.ts`,
`src/loop/triologue/brief-stack.ts`, `src/tools/brief.ts`,
`src/loop/prompts/common.ts`, `src/config.ts`, `src/help.ts`,
`src/loop/loop-events.ts`, `src/tools/todo_update.ts`,
`src/utils/arg-canonical.ts`. Deleted: `src/tools/recap.ts`.

### Docs / skills touched
`README.md`, `MYCC.md`, `changelog-todo.md`, `docs/loop/{agent-loop,
auto-recap-plan,brief-and-recap-rewind,brief-recap-loopholes}.md`,
`docs/tools/agent-tools.md`, `skills/mycc-self-awareness/SKILL.md`,
`skills/brief-isolation/SKILL.md`.

### Rework notes
B changes the *observer model* of folding: the agent no longer decides. Any
rework that wants model-initiated folding must keep group A and drop B.

---

## Group C — Hint round: one singleton, out-of-band state, grant denial recorder

Commits: `7e7acef`, `649a54a`, `4aac58b`, `900ecf1`.

### What it did

1. **Singleton** (`7e7acef`). The hint round was split across
   `collect.ts → hintSuggester (states/collect-hint.ts, policy) →
   createManager(env) building a fresh HintRoundManager
   (triologue/hint-round.ts)`. Now a single process-wide `hintRound`
   singleton (`src/loop/hint-round.ts`, ~903 lines) owns policy AND mechanism;
   `AgentStateMachine`'s constructor calls `hintRound.init(env)` for scope
   `main` and `reset()` otherwise; COLLECT only calls `hintRound.run(turn)`.
   The dead `getDuplicationReport` plumbing was dropped from Triologue.
   Behaviour unchanged (gate ≥10 confusion / ≥6 messages, ESC → `stop`,
   MAX_HINT_ATTEMPTS = 3, wiki pre-filter 0.5). Deleted:
   `src/loop/states/collect-hint.ts`, `src/loop/triologue/hint-round.ts`.
2. **Out-of-band state** (`649a54a`). The analyzer prompt no longer narrates
   reconstructible facts (confusion score, fabricated `Math.ceil(events/3)`
   turn estimate, bare tool-error count). `buildStateSections()` prefixes four
   self-omitting sections: `## Todo List`, `## Mode & Write Scope` (plan mode
   only), `## Recent Permission Blocks`, `## Loop Evidence`. Todos are rendered
   from `getItems()` (never `printTodoList()`) and `sanitizeField()` flattens
   newlines, caps at 60 chars, and defuses the embedded
   `ANALYSIS_INSTRUCTION` marker.
3. **Grant denial recorder** (`4aac58b`). `Core.requestGrant` delegates to
   `evaluateGrantForLead()` and records every refused verdict into a bounded
   (8) in-memory ring `{ tool, target, reason, kind, seq }`;
   `getRecentDenials()` exposes a copy. `kind` is derived at record time from
   the verdict's own reason. Child IPC grant path deliberately not
   instrumented.
4. **Classifier deleted** (`900ecf1`). `summarizePermissionBlocks()` (regex
   over tool-result prose) removed — the section is omitted when no recorder
   exists. `getRecentDenials()` returns a deep copy.

### Files / surfaces
New: `src/loop/hint-round.ts`. Deleted: `src/loop/states/collect-hint.ts`,
`src/loop/triologue/hint-round.ts`. Heavy: `src/loop/states/collect.ts`,
`src/loop/state-machine.ts`, `src/context/parent/core.ts`,
`src/context/shared/base-core.ts`, `src/types.ts`.

### Rework notes
`# Todo List` in the hint round is consumed again by group D (`48fb890` adds
the per-item hash), so C and D are entangled in `src/loop/hint-round.ts`.

---

## Group D — Todo: `preventStop` stop guard, populator delivery, WebUI todo cards

Commits: `31e9333`, `ea4a2c2`, `3b6c8bf`, `da822d5`, `48fb890`.

### What it did

1. **`preventStop` replaces `reactivate`** (`31e9333`). Pinned todos no longer
   reopen themselves on a throttle; a pinned todo may carry a
   natural-language `preventStop` guard. While it holds the agent cannot finish
   its turn. New `src/loop/states/stop-prevent-stop.ts`: `checkPreventStop()`
   sends ALL guards in one batched `forkChat` (`toolChoice: none`,
   escAware-wrapped), matches by id+hash against hallucination, reports the
   topmost held guard, never mutates the todo, fails open. `stop.ts` runs the
   gate after the negation block and before `presentResult()` / the auto early
   return; a hold returns COLLECT without `markTurnBoundary()`. The COLLECT
   reactivation pass was deleted. Docs: `pinned-todo-reactivation.md` →
   `pinned-todo-prevent-stop.md`.
2. **Hold escalation** (`ea4a2c2`). `TurnVars.preventStopHolds` counts
   consecutive holds per todo id (lives on TurnVars because a hold does not end
   the turn). From the 2nd hold the note escalates, naming the count and the
   release call. The hint round gains a `## Stop Guards (held)` section. No hard
   cap — the residual spin risk is documented and accepted.
3. **Populator delivery** (`3b6c8bf`). The open todo list moved off the
   per-turn/tool-result paths onto the boundary-cadence `projectContext`
   channel. `todo_create` / `todo_update` / `todo_pinning` return only the
   touched item + hash (no whole-list echo); the COLLECT "Update your todos."
   nudge is gone (`runTodoNudge` → `runChannelNudge`, peer channels only);
   `buildTodoMessages()` (shared) and `buildPinnedTodoMessages()` (lead-only)
   added; `buildPinnedTodoSection()` removed from the lead's system prompt;
   `/clear` and double-Ctrl+L empty the store before `triologue.clear()`.
4. **WebUI todo events** (`da822d5`). New
   `src/web/src/components/todo-activity.ts` (display contract outside the
   SFC); `MessageItem.vue` renders the todo brief as one icon + summary line;
   `TodoCard.vue` became a floating per-turn activity card instead of parsing a
   snapshot that no longer exists. Todo activity is LIVE-only — nothing
   replays from `/history`.
5. **Per-item hash in the hint round** (`48fb890`). `## Todo List` now appends
   ` [hash: …]` so the analyzer can name the hash to update by.

### Files / surfaces
New: `src/loop/states/stop-prevent-stop.ts`, `docs/loop/pinned-todo-prevent-stop.md`,
`src/web/src/components/todo-activity.ts`. Deleted:
`src/loop/states/collect-pinned-todo.ts`, `docs/loop/pinned-todo-reactivation.md`.
Heavy: `src/tools/{todo_create,todo_update,todo_pinning}.ts`,
`src/context/shared/todo.ts`, `src/loop/prompt-populators.ts`,
`src/loop/prompts/common.ts`, `src/loop/states/{stop,collect}.ts`,
`src/loop/hint-round.ts`, `src/web/src/components/{TodoCard,MessageItem}.vue`.

### Rework notes
Two separable halves: (a) the `preventStop` stop-guard mechanism
(`31e9333`, `ea4a2c2`), (b) the delivery change + WebUI cards
(`3b6c8bf`, `da822d5`, `48fb890`). They are in one group because
(a)'s docs and prompt text were rewritten by (b); a rework may want (a) alone.

---

## Group E — `/auto-commit` slash command

Commits: `e5b4032`, `44ef2c8`.

### What it did

- New `/auto-commit` slash (`src/slashes/auto-commit.ts`): show the list,
  `on <branch>`, `off <branch>`, `off --all`. The allow-list is runtime,
  session-scoped state on the agent context
  (`BaseCore.getAllowAutoCommitBranches()` + add/remove/clear, declared on
  `CoreModule`), not in `config.ts`; `config.getAllowAutoCommitArg()` reports
  what `--allow-auto-commit` said and `BaseCore` seeds from it once.
  `git_commit` reads `ctx.core` per call, so a slash edit applies to the next
  commit. Nothing is persisted (`/reload` reverts to the launch list). No tool
  can reach the list — human-typed only.
- `44ef2c8` gave ten hand-built `CoreModule` literals in tests the four
  allow-list methods so `typecheck:all` passes.

### Files / surfaces
New: `src/slashes/auto-commit.ts`, `src/tests/slashes/auto-commit-slash.test.ts`,
`docs` rows in `README.md`. Heavy: `src/context/shared/base-core.ts`,
`src/config.ts`, `src/tools/git_commit.ts`, `src/slashes/index.ts`,
`src/tests/test-utils/mock-context.ts`.

### Rework notes
Fully independent of A–D and F; the cheapest group to re-land alone.

---

## Group F — Crossroad preview hardening + WebUI steering boomerang

Commits: `7253a55`, `7f47058`, `71eb910`, `efcfe81`.

### What it did

1. **Crossroad previews** (`7253a55`, `7f47058`). Previews are normalized to
   single-line, markdown-inert text before truncation (no broken list rows or
   code spans); the resolved outcome is included in the candidate card, as its
   own paragraph after the candidate list, sanitized with `plainPreview`.
2. **Steering boomerang** (`71eb910`). `resolveSteering()` cleared the review
   card optimistically and fire-and-forgot `wsSend`; on a dropped socket the
   backend still held the notes, and the next `/history` + PROMPT moved them
   back, letting a user submit an already-received instruction twice. Fix:
   snapshot before clearing, restore on failure, `historyDirty` to defeat the
   304, reconnect immediately.
3. **Coverage + dedupe fix** (`efcfe81`). New `src/web/src/resolve-guard.ts`
   extracts the "was the resolve delivered?" decision (unconfirmed until the
   server's steer-flush ack; a `prompt` disarms it). The rewritten
   message-dispatch test exposed a real bug — the PROMPT repopulation pushed
   every buffered note without deduping ids, stacking duplicate cards — now
   deduped by id.

### Files / surfaces
New: `src/web/src/resolve-guard.ts`. Heavy: `src/loop/crossroad.ts`,
`src/web/src/{main.ts,message-dispatch.ts}`, `src/tests/crossroad/*`,
`src/tests/web/*`.

### Rework notes
The `resolve-guard` half also carries fixes made in `bcd0dce` (socket
retirement, `ws === socket` handler guards), so revert F before `bcd0dce`'s
web half is reverted — see the recipe.

---

## Cross-cutting: `bcd0dce` (review of 2026-10-24)

Six must-fix defects that passed the suite at the time. Each was a real
behaviour regression in C, D or F:

- **stop guard** (`D`): the evaluator prompt now prints `[hash: …]` for every
  guard (hashes exist only in tool results and the throttled nudge, both of
  which compaction destroys — so after a long run every honest hold silently
  failed open); a STALE hash is accepted when the lineage ring
  (`previousHashes`) knows it; matching walks the candidate list so the
  reported guard is the topmost in todo order; `parsePreventStopResult` uses a
  balanced, string-aware JSON scan instead of greedy `/\[[\s\S]*\]/`.
- **grant denial recorder** (`C`): `classifyDenial` matches `'[intent]'` only
  (bare `intent` swallowed the dangerous-command Socratic hint); human refusals
  classified FIRST (they contain danger/batch markers); `git[_ ]commit` accepts
  both spellings; `clearDenials()` wired into `/compact` and double-Ctrl+L; out-
  of-workspace path denials recorded.
- **web steering** (`F`): `connectWebSocket` retires the previous socket and
  guards every handler with `ws === socket`; a resolve stays unconfirmed until
  the server ack.
- **tests**: `stop-prevent-stop-gate.test.ts` added (the `guard.block` wiring
  was entirely uncovered); `core.test.ts` rewritten (it asserted the buggy
  classification "by design"); hash-echo / stale-hash / balanced-extraction
  cases added.

---

## Revert recipe (what was done, and how to redo/undo it)

### Ordering rule
Groups overlap in five shared documents — `MYCC.md`, `docs/loop/agent-loop.md`,
`docs/tools/agent-tools.md`, `docs/loop/brief-and-recap-rewind.md`,
`changelog-todo.md` — each edited by 3–5 groups. Therefore: revert **highest
SHA first** (reverse chronological), so every revert applies to a tree its diff
was computed against. A per-group `git revert -n` batch is also fine for a
group whose commits are contiguous, but must still be applied group-by-group
from the newest group backwards.

Order actually used:

1. `bcd0dce` (cross-cutting, newest of the entangled set)
2. Group D: `48fb890` `da822d5` `3b6c8bf` `ea4a2c2` `31e9333`
3. Group F: `efcfe81` `71eb910` `7f47058` `7253a55`
4. Group E: `44ef2c8` `e5b4032`
5. Group C: `900ecf1` `4aac58b` `649a54a` `7e7acef`
6. Group B: `0831ed6` `811509c` `8493128`
7. Group A: `108ba03` `80a468c` `b52ff0c` `e450de1` `f028f12`

Rationale for B before A: `8493128` deletes `src/tools/recap.ts`, which A's
`80a468c`/`108ba03`/`b52ff0c` modify. Reverting B first removes the tool, then
A's reverts restore and modify it cleanly.

### Practical commands

```bash
# one commit at a time, newest first
git revert --no-edit <sha>

# or a contiguous group in one commit
git revert --no-edit --no-commit <newest> <older> ... <oldest>
git commit -m "revert(group X): <theme>"
```

Conflicts were expected only in the five shared docs and in
`src/loop/states/hook.ts`, which carried edits from three groups. Resolve by
taking the base (`f09bd22`) side of a hunk only when the surrounding text is
still the pre-feature wording; otherwise reword to match the restored code.

### Undo the revert (when a rework starts)
`git revert <revert-sha>` re-applies a whole group atomically, or
`git checkout <original-sha> -- <paths>` to re-import individual files.

### Verification gate
`npm test` (= `typecheck:all` + vitest) and `npm run typecheck:web`. At
`48fb890` the gate was 257–258 files / ~3831 tests. After the full revert the
tree must match `f09bd22`:

```bash
git diff f09bd22 HEAD --stat   # expected: empty
```

---

## Quick reference: commit → primary files

| Commit | Subject | Primary files |
|---|---|---|
| `f028f12` | brief anchor names object/address/span | `triologue/brief-stack.ts`, `triologue/recap-note.ts`, `tools/brief.ts`, `states/tool.ts` |
| `e450de1` | recap span wording + abandon announce | `states/hook.ts` |
| `b52ff0c` | recap two-field schema + WebUI todo panel | `tools/recap.ts`, `states/hook.ts`, `serve/serve-todos.ts`, `web/src/**` |
| `80a468c` | invitation matches schema, ESC refuses | `recap-rewind.ts`, `states/hook.ts`, `web/src/main.ts` |
| `108ba03` | delete dead summarization fork | `loop/recap-rewind.ts` |
| `8493128` | lead-only auto-recap replaces recap tool | `loop/recap-signal.ts`, `tools/recap.ts` (deleted), `states/hook.ts` |
| `811509c` | harden auto-recap, cap brief messages, audit | `recap-signal.ts`, `triologue/brief.ts`, `triologue/transcript.ts` |
| `0831ed6` | atomic post-fold commit | `triologue/store.ts`, `triologue/brief-stack.ts`, `triologue.ts` |
| `7e7acef` | hint-round singleton | `loop/hint-round.ts` (new), `states/collect.ts` |
| `649a54a` | hint-round out-of-band state | `loop/hint-round.ts` |
| `4aac58b` | grant refusal recorder | `context/parent/core.ts` |
| `900ecf1` | permission fallback no-op | `loop/hint-round.ts`, `context/parent/core.ts` |
| `31e9333` | preventStop replaces reactivate | `loop/states/stop-prevent-stop.ts` (new), `types.ts` |
| `ea4a2c2` | stop-guard escalation | `stop-prevent-stop.ts`, `hint-round.ts` |
| `3b6c8bf` | todo list via populators | `loop/prompt-populators.ts`, `tools/todo_*.ts` |
| `da822d5` | WebUI todo event cards | `web/src/components/**` |
| `e5b4032` | `/auto-commit` slash | `slashes/auto-commit.ts` (new), `context/shared/base-core.ts` |
| `44ef2c8` | test fixtures for allow-list | `src/tests/**` |
| `7253a55` | sanitize crossroad previews | `loop/crossroad.ts` |
| `7f47058` | separate crossroad outcome | `loop/crossroad.ts` |
| `71eb910` | steering boomerang fix | `web/src/main.ts` |
| `efcfe81` | steering coverage + dedupe | `web/src/resolve-guard.ts` (new) |
| `bcd0dce` | six must-fix review defects | `stop-prevent-stop.ts`, `context/parent/core.ts`, `web/src/main.ts` |
| `48fb890` | todo hash in hint-round list | `loop/hint-round.ts` |
