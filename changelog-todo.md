# Preamble

This file is the `changelog` as well as `todo` for mycc project.

The changelog is recorded on daily basis, with summaries generated from LLM according to the actual code changes.
The todo items are kept without order. We pick the tasks with priority and finish them using mycc.
Once the task is marked done, it will stay in the list for an extra week after appearing in the changelog.

## The workflow

1. The user will add items to the `todo` section without order.
2. During development, an item will be picked up by evaluating the priority.
3. Once the item is done, mark it as done, togethe with a date on finish.
4. The changelog is updated on demand. Once update, todo items order than one week will be removed.

## How to update the changelog

When updating the changelog, use the following procedure:

1. **Brief first** — call `brief` to state what you are about to do. The brief becomes a recap anchor, so write it as a conclusion, not a greeting.
2. **Get git commits** for the target date range using `git log --since="YYYY-MM-DD" --until="YYYY-MM-DD" --pretty=format:"%h %ad %s" --date=short`.
3. **Group commits by date** and summarize each day's changes into meaningful categories (e.g., "New Tools", "Fixes", "Refactoring", "Documentation").
4. **Write category-style summaries** similar to the existing format (e.g., "- **feature name**: description").
5. **Update the changelog file** by adding new date sections or appending to existing ones.
6. **Clean up todo items** that appear in the changelog and are older than one week.
7. **Call `recap`** to collapse the work back to that brief and compress context. There is no checkpoint to close — `recap` alone rewinds to your last `brief`.

# Change Log

> **Archive**: For September 2026 entries, see `changelog-202609.md`. For August 2026 and earlier, see `changelog-202608.md`. For July 2026, see `changelog-202607.md`. For June 2026, see `changelog-202606.md`. For May 2026, see `changelog-202605.md`. For April 2026, see `changelog-202604.md`.

<!-- July 2026 entries rotated to changelog-202607.md on 2026-08-03. -->
<!-- August 2026 entries rotated to changelog-202608.md on 2026-09-02. -->
<!-- September 2026 entries rotated to changelog-202609.md on 2026-10-12. -->
<!-- Add new (October 2026 onward) entries below this line. -->

## 2026-10-26
### Fixes
- **WebUI todo panel**: the floating panel showed DUPLICATE todo items — one item created, updated and pinned in a turn rendered three rows (`📌 pinned #7` + `☐ updated #7` + `☐ created #7`, header `×3`). Root cause: the panel reconstructed the list by parsing `todo_create` / `todo_update` / `todo_pinning` briefs, which are EVENTS, not state — the transcript proved each brief is emitted once, so there was nothing to dedupe. Replaced with the authoritative todo list. New `src/serve/serve-todos.ts` defines the wire snapshot (`{type:'todos', todos:[{id,name,done,pinned,preventStop?,note?}]}`; `hash` and the lineage ring are deliberately excluded, and free-form text is clamped to 500 chars) plus `wireTodoSnapshot(seed)`, which subscribes ONCE to the `todo_changed` event on `loopEvents` (payload `{items, source}`, the whole list) from `wireServeCallbacks()` — the sole production emitter. The event is emitted inside the mutation in `Todo`, so it is observable through `captureLoopEvents()` and can have several subscribers; emitting from the mutation (rather than from each tool) is what makes `/clear`, `/todos clear`, the double-Ctrl+L clear, `recordRemotePeerTodo`, `tm_create`/`tm_remove` and `hand_over` reach the panel at all — a per-tool emit covers only the three todo tools. The listener resolves the hub with `tryGetServeHub()` (never queued, never materializing one) so a terminal run retains nothing. THE SEED is re-published by `resyncTodoSnapshot()`, called from `activateServe()` after `hub.start()` — the ONLY seam that runs on both the first start and every `/serve` RE-ENTRY. It is deliberately NOT a registration hook: `registerServeHubFactory` is reached only from `ServeHub`'s constructor and `ensureServeHub`'s `if (!factory)` branch, so a stop → `/serve` in one process re-registers nothing and a hook would never fire, leaving `/history` at `todos: null` and the panel blank until the next mutation. The re-publish compares against the hub's current snapshot synchronously, so repeating it never emits a duplicate frame. `ServeHub.broadcastTodoList()` stores the last snapshot and fans it out WITHOUT touching `messageLog`; `GET /history` returns `todos` as a BARE `TodoListEntry[]` (not the `{type,todos}` wrapper — that shape mismatch wiped the panel on every reload) and folds the list into the ETag via `computeHistoryVersion`'s `extraToken`, so a todo-only change can never be masked by a 304. `ServeHub.stop()` clears the cached snapshot on a GENUINE shutdown, gated on `!this.restarting` like `setWebUiUp` and the steering clear — so a 重启 recycle keeps the panel instead of blanking it. Frontend: `TodoListEntry` in `types.ts` (the frame type is not re-declared client-side — `todo-payload.ts` owns the runtime shape), one normaliser (`src/web/src/todo-payload.ts`: `parseTodoList`/`parseTodoFrame`) for BOTH transports, a `todos` ref in the chat store, a `todos` branch in `applyServerMessage` (full replacement — never a merge — and no phase/log side effects), a `/history` seed and a session-change clear in `main.ts`, and `TodoCard.vue` rewritten to render one row per id (open first, then done — a pinned row is marked by 📌 and bold weight, not by its position; header `TODO n/m done (pinned xK)`, built by the pure `todoHeader()` in `src/web/src/todo-header.ts` so the string is testable without a component mount; pin/guard markers). The temporary `todo-activity.ts` brief-parser and its test are DELETED, along with the `isTodoCard` render path in `MessageItem.vue` — todo briefs now render as ordinary chat lines. Tests (91 cases; every lock below was PROVEN by reintroducing the bug it guards and watching the named file go red): `serve-todos.test.ts` (12: one row per id, ordering, field whitelist, empty list, no aliasing, plus the `/history` bare-array seed via the exported `historyTodosField` — reverting it to the wrapper turns this red — and a seed round-trip through the real client normaliser), `serve-history-etag.test.ts` (13: the token is asserted through the exported `todoEtagToken` and folded through `computeHistoryVersion` — reverting to a length-based token turns 5 red, including the end-to-end fold), `todo-payload.test.ts` (13: both `/history` shapes including the wrapper that caused the bug, hostile rows, id dedupe, frame-null-keeps-panel), `todo-onchange.test.ts` (13: every mutation fires including `clear()`, a rejected mutation does not, copy semantics INCLUDING a cloned lineage ring, per-listener isolation (a throwing listener neither aborts the mutation nor starves later listeners), the no-listener O(n) guard (a spy proves getItems() is not called without subscribers), replace-not-stack, ids never reused — deleting the `emitChanged('clear')` in `clear()` turns these red), `session-change-todos.test.ts` (5: calls the real `resetSessionState` from `src/web/src/session-reset.ts` — deleting its `store.todos` line turns 4 red), `chat-store-todos.test.ts` (5: drives `applyServerMessage` against the REAL Pinia store, not a hand-rolled stub) and `message-dispatch-todos.test.ts` (5: replacement, no duplicate rows, empty clears, no phase/log effects, malformed frame ignored), plus `wire-todo-snapshot.test.ts` (12: the serve-side subscriber — a `todo_changed` frame reaches the hub, ordered delivery, teardown, the `hash`/`previousHashes` whitelist, and THE SEED against the REAL `serve-registry`: an earlier version mocked the registry and so passed against an ordering that never happens in production, where the attach-time seed was silently dropped and a mid-session `/serve` left the panel empty until the next mutation). The seed is re-published by `resyncTodoSnapshot()`, called from `activateServe()` after `hub.start()` — the only seam that runs on the first start AND on every `/serve` re-entry (and it also carries the `--serve` boot path). Registration hooks are NOT used: `registerServeHubFactory` is reached only from `ServeHub`'s constructor and `ensureServeHub`'s `if (!factory)` branch, so a stop → `/serve` inside one process re-registers nothing.
### Features
- **`/auto-commit` slash command**: Human-typed control over the auto-commit allow-list at runtime — `/auto-commit` shows the current branches, `on <branch>` adds one, `off <branch>` removes one, `off --all` clears the list.
### Refactoring
- **Auto-commit store relocated to `ctx.core`**: the allow-list is runtime, session-scoped state (like `workDir`), so it now lives on `BaseCore` — `allowAutoCommitBranches` plus `getAllowAutoCommitBranches()` (copy) / `addAllowAutoCommitBranch()` / `removeAllowAutoCommitBranch()` / `clearAllowAutoCommitBranches()`, all also declared on the `CoreModule` interface so lead, teammate and mocks share one shape. `src/config.ts` is back to PARSE-ONLY: `isAllowAutoCommit()` and the mutable array are gone, replaced by `getAllowAutoCommitArg()` which only reports what `--allow-auto-commit` said on the command line; `BaseCore`'s constructor seeds the list from it once. `git_commit` now reads `ctx.core.getAllowAutoCommitBranches()` per call (no config import), so a slash edit is effective on the next commit with no restart. The "the agent can never self-grant" guarantee is unchanged — no tool reaches the list, only a human-typed slash command.
- **`/reload` does NOT inherit runtime edits** (documented at both sites): `/reload` replays the original launch argv, so the respawned lead re-seeds from `--allow-auto-commit` alone — a runtime `on` is lost and a runtime `off --all` is undone. Nothing is persisted by design.
### Tests
- **Auto-commit**: new `src/tests/slashes/auto-commit-slash.test.ts` drives the REAL command end-to-end against a behavioural mock core (14 cases: display/OFF, add, dedupe, remove, absent no-op, clear, already-empty, usage on missing operand, unknown subcommand, case-insensitive, and "git_commit sees the slash edit immediately"). `tools/test-utils.ts` + `test-utils/mock-context.ts` gained a real mutable allow-list, `git-commit.test.ts` seeds the grant through `ctx.core` instead of a config mock, and `context/core.test.ts`'s config mock exports `getAllowAutoCommitArg`.

## 2026-10-25
### Refactoring
- **Todo system**: `todo_create` / `todo_update` / `todo_pinning` no longer echo the whole open list — each returns only the touched item with its current hash; the COLLECT todo nudge ("Update your todos.") is removed (the state is renamed `runTodoNudge` → `runChannelNudge`, keeping only the peer-channel nudge, and `TurnVars.nextTodoNudge`/`lastTodoState` → `nextChannelNudge`/`lastChannelState`; the teammate loop's duplicate nudge is deleted).
- **Todo context populators**: new `buildTodoMessages()` (shared, `## Task Management` usage + live `## Todo List` snapshot, rebuilt at startup/compact/clear so the list survives auto-compaction, starts empty) and `buildPinnedTodoMessages()` (lead-only pinned-todo/stop-guard prose) in `src/loop/prompt-populators.ts`; `buildPinnedTodoSection()` is deleted from `prompts/common.ts` and its text no longer ships in the lead's system prompt.
- **Clear ordering**: `/clear` and double-Ctrl+L now empty the todo store BEFORE `triologue.clear()`, so the post-clear populator snapshot renders `No todos.` instead of resurrecting the old list.
### Fixes
- **Todo staleness (covered, not rebuilt)**: with the nudge gone, the boundary-only snapshot can lag the store for writers that mutate it mid-run. This is deliberately NOT patched with a mid-run `rebuildProjectContext()` — that would re-render the populator output and break the cache-stable prompt prefix. Instead the hint round's `buildStateSections()` already renders its own live, sanitized `## Todo List` from `getItems()` (plus the `## Stop Guards (held)` evidence) and closes the gap until the next natural boundary. `/todos`, the peer-wire pinned reminder and `slashes/todos.ts` all rely on that, and each says so in a comment so nobody "helpfully" adds a rebuild later.
- **Prompt**: `buildTodoMessages` no longer advertises `/todos` as an escape hatch (terminal-only — the agent cannot invoke a slash, and a teammate has no REPL); the two contradicting doc comments are reconciled — 📌/`[preventStop]` markers DO appear in the snapshot (`printTodoList()` verbatim), only the USAGE prose is lead-only.
- **Tests**: add `todo-pinning.test.ts` (was absent — its no-echo change was completely unlocked, covering every happy/error branch + the brief arity); make `todo-create.test.ts`'s no-echo assertion non-vacuous (real list stub); replace the misleading `not.toContain('preventStop')` populator assertion with a positive guarded-item case plus a `/todos`-not-a-tool check; fix stale `nextTodoNudge`/`lastTodoState` references in `docs/`.

## 2026-08-29
### Chores
- **Package**: Update package info.

## 2026-08-30
### Features
- **DeepSeek**: Update README and design docs for DeepSeek `web_search` support; refine the deepseek engine.

## 2026-08-31
### Fixes
- **Peer**: Show `/peer` and `peers` timestamps in local time (was UTC via `toISOString()`); add `formatLocalDateTime()` util in `src/utils/time.ts` and use it at all four call sites.

## 2026-10-02
### Refactoring
- **Compose**: Readability pass over peer-lifecycle doc comments; fail-fast launch for `mycc-compose`.

## 2026-10-03
### Fixes
- **Compose**: Parse real npm shims (`%dp0%` prog) and pin stop identity to the session id; preserve repeated-flag multiplicity in `argsMatch`; honor `allowStop` for `renew:always` (no destructive restart on cron); `down --stop` stops before deleting channels and exits non-zero on a refused stop; reject unsupported remote URLs and bare daemon; allow omitted secret args in peer matching.
- **Session**: Collision-safe lead triologue filename under pinned-sid same-second relaunch.
### Tests
- **Compose**: Cover omitted-secret matching, daemon/remote URL validation.

## 2026-10-04
### Features
- **mycc-compose**: Declarative peer topology — atomic pinned-sid ownership claim, strict identity lock, close the identity lost-update race, port-required remotes.

## 2026-10-07
### Fixes
- **mycc-compose**: `down` always terminates peers.

## 2026-10-08
### Features
- **Vision**: Support `screen`/`read_picture` under the DeepSeek provider.
- **bg**: Bound completion on process exit, not stdio EOF.
### Fixes
- **bg**: Detect completion on process exit, not stdio close; wait for output finalization in `bg_await`, not just process exit.
- **Stop**: Mode-aware teammate wait — isolate wake-reason from user interrupt; bounded teammate wait (STOP must not accept `mail`/`steering`).
### Refactoring
- **Stop**: Extract mode-aware teammate-wait handling.

## 2026-10-09
### Features
- **Auto-Commit**: Add `--allow-auto-commit <branches>` (env `MYCC_ALLOW_AUTO_COMMIT`) — an auto-mode pre-authorization that lets the lead run `git_commit` on comma-separated allow-listed branches without the interactive prompt. Fail-closed: NORMAL mode only (`plan` short-circuits), detached HEAD / unlisted branch falls through to the normal deny path, and every auto-approved commit carries an `Auto-Committed-By: mycc --allow-auto-commit` + `Auto-Commit-Branch: <branch>` trailer. Mirrors `--allow-plan-off` (checks `getAuto()` BEFORE `question()`, never the `source==='auto'` pattern). Pair with CI on protected branches — the flag is a narrow launch-time grant, not a security boundary.
### Fixes
- **Notes**: De-fang the skill `[HINT]` nudge and stop re-announcing suggested skills; drop the fabricated `brief` example from the lead nudge; de-duplicate and de-fabricate the teammate cadence nudges; drop the fabricated `eta` literal from the budget nudge; give the auto-claim note an actor + close contract; stop asserting worktrees are "stale" before the remove advice; make the teammate plan-mode note state the real parent grant gate; split the ESC directive from the mail payload in neglected mode; give MAIL notes explicit reply routing + peer/sender annotation.
- **Confusion**: Stop charging teammates for probe-misses and PowerShell reads.
- **Triologue**: Close all `tool_calls` interposition paths + add a `tp-violation` probe; flush deferred inputs on `duplicate_assistant` recovery.
### Refactoring
- **Config/Prompts**: Remove `ensureGitignore()` (and its `isInsideGitRepo()` helper + `ensureDirs()` call), which silently created/edited the user's `.gitignore` on every startup; replace it with a `## Project Ignore` system-prompt section (`buildProjectIgnoreSection()` in `prompts/common.ts`, wired into `buildCommonSections()`) telling the agent to keep `.mycc/` out of version control and to add `/.mycc/*` only when the task actually touches git.
- **Steering**: `SteeringManager` refactor — loop-homed singleton + three delivery seams.
### Docs
- **Crossroad**: Add crossroad detector case study.
### Chores
- **Release**: Bump version to `0.11.6`.

## 2026-10-10
### Features
- **Serve**: Lazy-load the serveHub stack off the plain-boot path.
### Fixes
- **Notes**: Wake-source note for headless daemons; tell the LLM when the Web UI starts and stops; frame the team-status note as an informational snapshot; name the originating hook on deferred-message notes; attribute the bang-command pane capture to the user's handed-over terminal.
- **Hint**: Drop the empty wiki field, fold the pending-skill line, name the brief tool; let the analyzer see its own prior hints and escalate instead of repeating.
- **Skill**: Grant exactly one retry pass on an empty `freeformQuery`.
- **Teammate**: Count the failure before reporting it and stop promising a retry on the idle turn; honest failure notes (conditional orientation + real lead-notify outcome); give the auto-compact notes an actionable lever.
- **Collect**: Attribute the pinned-todo reactivation note to the evaluator.
- **Loop**: Preserve `lastUserQuery` on replay + confusion on a failed hint; address PR #30 simulation-review findings + repair gates; guard recap roots and isolate retry prompt failures; preserve steering arrivals and de-duplicate crossroad prefixes; bound hint retries and repair the deferred tool flow; keep production trace memory bounded.
- **Serve**: Clean up a partially-initialized serve stack on `start()` failure; settle the input wait on failed `restartServe`; publish `webui-down` on failed `restartServe`; address PR #29 human review (2 P1 + 1 P2).
- **Crossroad**: Accept continuations after stripping the full prefix.
- **agent-io**: Latch serve shutdown against repeated ESC.
- **Reload**: Forward the lead's full launch argv on `/reload`.
- **Hook**: Surface WHERE a failing condition died + thread real call context.
### Refactoring
- **Collect**: Extract the pinned-todo reactivation pass into `collect-pinned-todo.ts`.
### Docs
- **Coordination**: Add Pattern 11 Simulation Review (aggregation-root simulation).
- **Triologue**: Clarify provider-aware deferred replay.
### Tests
- **Loop**: Cover deferred compact and bounded hint retries; cover the summary prompt contract.
- **Prompt**: Preserve steering added during synthesis; import the synthesis provider in the steering race test.

### Fixes
- **Recap**: Provenance of an infrastructure-injected `brief` is now a property of the MESSAGE (`Message.synthetic`, marked at creation by `Triologue.agent(..., { synthetic: true })` in the `llm.ts` empty-output recovery and `hook.ts` crossroad paths) instead of a registry or a call-id convention — `MessageStore.findLastBriefAnchor` skips marked messages, so `recap` never rewinds to boilerplate. The marker is stripped on egress by `MessageStore.getFullMessages()`, so it can never reach a provider (and therefore never be echoed back as model output). The compaction resume brief stays UNMARKED — it is the floor.

## 2026-10-12
### Refactoring
- **Hint**: Own the hint round at the composition root + actionable wiki pre-filter — the facade (`Triologue`) no longer carries RAG-layer knowledge (`wiki?` removed from `TriologueOptions`); `compact()` takes caller-injected `domains` data instead of reading a `wiki` module; construct a fresh `HintRoundManager` per round instead of memoizing on the singleton (avoids silently promoting the dependency lifetime from per-facade to per-process).
### Tests
- **Compact**: Add the required `domains` field to the `CompactDeps` fixture.
### Chores
- **Merge**: PR #31 (`feat/wiki-hint-refactor`) merged into `main`.

## 2026-10-13
### Features
- **Serve**: Exclude the `.mycc` tree (and public `index.html`) from the Vite watcher via chokidar `ignored`, stopping the WebUI full-reload flicker.
- **Docs**: Reorganize `docs/` into topic subfolders, archive drifted documents, update inbound references, and record the teammate-as-MCP-client PoC (not implemented).
### Fixes
- **Config**: Raise default `TOKEN_THRESHOLD` from 50000 to 100000.
### Docs
- **Skills**: Fix stale claims in `mycc-self-awareness` (verified against `src`).
### Chores
- **Logging**: Gate skill re-index chatter behind `-v`; log skill scheduling as a paired line.

## 2026-10-14
### Features
- **Stop**: Add the `mycc-stop` CLI plus a shared stop-by-address / stop-by-sid primitive, and tombstone peer self-termination so stopped peers stay stopped.
- **Peer**: Readable flat `/peer` output with full session ids and an optional name.
### Fixes
- **Compose**: Identify peers by durable name instead of session id (schema, channels, status, down); fail fast on uncertain peer ownership and treat an absent identity entry as released in `waitForPeerGone`; gate daemon dedup on a live pid; cull stopped peers from `identity.json` on `down`; sequence restart so a launch never races a peer shutdown.
- **Peer**: Centralize pid liveness with a pid-reuse guard; preserve stop discovery and pending tombstones.
- **Session**: Guard session-file creation with an exclusive `wx` open.
### Docs
- **Peer**: Align tombstone docs with the implementation; fix test typecheck.
### Chores
- **Merge**: PR #32 (`fix/compose-peer-name-identity`) and PR #33 (`fix/serve-suppress-public-html-reload`) merged into `main`.

## 2026-10-15
### Fixes
- **Serve**: Serve `.mycc/public` via Express static instead of Vite's `publicDir`.
### Docs
- **Skills**: Bundle a Flappy Bird demo (with autopilot scripts and trained nets) into `serve-public-dir`.

## 2026-10-16
### Fixes
- **Crossroad**: Correct the display order and refine the best-of-three brief layout.
- **mycc-compose**: Actionable headless-launch guidance; repair the scripts eslint scope.

## 2026-10-17
### Fixes
- **Team**: Prevent teammate silent-death from malformed required-arg calls.

## 2026-10-18
### Fixes
- **Platform**: Pin `ps` locale/width, guard `git_commit` stdin `EPIPE`, and make spec fixtures platform-aware.

## 2026-10-20
### Features
- **Recap**: Checkpoint removed — `brief` is now the sole `recap` rewind anchor.
### Fixes
- **Peer**: Validate identity entries at the parse boundary.
- **mycc-compose**: Strict args validation, filename-based channel ownership, and explicit exit-code contracts.

## 2026-10-21
### Features
- **Recap**: `recap` writes its summary into the anchor brief's tool result.
### Fixes
- **Recap**: Close brief/recap rewind loopholes (H1 H2 M1 M2 L1) — anchor resolution, empty-summary refusal, and message-identity checks at the HOOK stage.
- **Prompts**: Stop teaching `recap` in the `brief` tool description.
### Refactoring
- **Triologue**: Brief provenance is a message property (`Message.synthetic`) with allow-list egress, so synthetic briefs can never reach a provider.
### Docs
- **Loop**: Document the brief/recap rewind model and its loopholes; add a checkpoint-and-recap reference.
### Chores
- **Merge**: PR #34 (`refactor/brief-provenance`) merged into `main`.

## 2026-10-22
### Features
- **Recap**: Hashed brief results — `brief` returns a `[<hash>]` anchor; `recap` accepts an explicit `target` hash and states the inclusive result search bound.
- **Hook**: Plan-mode scope reflection on every `brief` (HOOK stage), via `src/loop/plan-scope.ts`; narrow `mycc_title`/`read_read` to the main agent and purge the dead `broadcast` tool.
- **Prompt**: Teach `brief` + `recap` as a context stack in the lead prompt.
### Fixes
- **Recap**: Write the note into the *resolved* brief result (not the first id match); anchor brief results by tool NAME too and simplify anchor identity.
- **Peer**: Stop Windows liveness probes leaking stderr into the terminal.
- **Web**: Keep the chat toolbar shrink-to-fit so the last textarea line stays selectable.
- **Wiki**: Token-based content limit for `wiki_prepare`/`wiki_put`, shared by all embedding models (later unified to 10–1000 tokens).
### Refactoring
- **Tests**: Consolidate root-level compose/hooks suites and tools/loop/surface suites under `src/tests/`; add a registry-driven tool metadata test and shared `test-utils`; delete never-run skipped suites and add real mindmap tree-walk tests.
### Docs
- **Skills**: Add the `brief-isolation` hook skill; refresh `mycc-self-awareness`.
### Chores
- **Merge**: PR #36 (`fix/recap-anchor-tool-name`) merged into `main`.

## 2026-10-23
### Features
- **Recap**: Explicit `recap` target hash with a hashed brief-result digest.
### Refactoring
- **Recap**: Extract `BriefStackManager` into `src/loop/triologue/brief-stack.ts`.
- **Hint**: Drop the compact signal from the hint round; `collect-hint` and `HintRoundManager` shrink accordingly.
### Fixes
- **Web**: Stop the `发送` label wrapping and reclaim the narrow-screen gutter in the chat input.
- **Prompt**: Recap guidance is now taught in ONE place. The lead prompt's `## Briefs and Recap` section gained the missing trigger — when the direction drifts, the default is `recap(abandon=true)` (no LLM fork, no mindmap patch) and a summarising recap is the exception; the stale "pops the topmost frame / each pop rewinds one brief further" bullet was rewritten to the stack model with a `target` anchor ("pops frames back to a target", repeatedly for an explicit `<hash>`). The duplicated `## Managing your context with recap` block was removed from the compaction summary prompt (`buildSummaryPrompt()`), which now ends with the conversation body, so the policy no longer gets a second, drifting copy injected into the context. `prompt-budget` re-ratifies `soloNormal` at the measured 7304 (the old ±15% cap left no room for the trigger) and `src/tests/loop/prompts/brief-recap-scope.test.ts` pins the new wording.
- **Intent**: Diagnose a lone bare PARAM token as one word — `tokenizeParams` priority 7 used the two-token pair wording ("missing '=' between key and value") for the single-token branch, so a PARAM like `git_state` was reported as if the parser had split it into a `key value` pair. The single-token branch now says the token is a bare token missing `'='` and is not a key/value pair; the pair wording is reserved for two adjacent bare tokens. Regression tests cover `READ DATA git_state TO …`, a bare token followed by a well-formed PARAM, and the true `git state` pair.

# Todo

> Todo - Or never?
> The below todo items have inherit gap with mycc's current implementation.
> With the existing archetecture, these todos may not be easily completed.
> Let's write them down to admit our limitation.

- [ ] add e2e test using tmux, with meaningful test cases, written as a skill.
- [ ] enable "boostrap install" mode via Docker. 
- [ ] make `/save` generate a "rich" session backup in addition to the original "slim" one.
- [ ] enable "remote shell" -- make local mycc able to control remote codebase.
- [ ] `/auto-commit` runtime edits are session-only — decide whether a runtime `off` should be persistable to `.mycc/.env` (currently a restart re-seeds from `--allow-auto-commit`).