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

1. **Create a checkpoint** using `checkpoint` tool to focus on the task.
2. **Get git commits** for the target date range using `git log --since="YYYY-MM-DD" --until="YYYY-MM-DD" --pretty=format:"%h %ad %s" --date=short`.
3. **Group commits by date** and summarize each day's changes into meaningful categories (e.g., "New Tools", "Fixes", "Refactoring", "Documentation").
4. **Write category-style summaries** similar to the existing format (e.g., "- **feature name**: description").
5. **Update the changelog file** by adding new date sections or appending to existing ones.
6. **Clean up todo items** that appear in the changelog and are older than one week.
7. **Call recap tool** to close the checkpoint and compress context.

# Change Log

> **Archive**: For changelog entries before September 2026, see `changelog-202608.md`. For July 2026, see `changelog-202607.md`. For June 2026, see `changelog-202606.md`. For May 2026, see `changelog-202605.md`. For April 2026, see `changelog-202604.md`.

<!-- July 2026 entries rotated to changelog-202607.md on 2026-08-03. -->
<!-- August 2026 entries rotated to changelog-202608.md on 2026-09-02. -->
<!-- Add new (September 2026 onward) entries below this line. -->

## 2026-08-29
### Chores
- **Package**: Update package info.

## 2026-08-30
### Features
- **DeepSeek**: Update README and design docs for DeepSeek `web_search` support; refine the deepseek engine.

## 2026-08-31
### Fixes
- **Peer**: Show `/peer` and `peers` timestamps in local time (was UTC via `toISOString()`); add `formatLocalDateTime()` util in `src/utils/time.ts` and use it at all four call sites.

## 2026-09-01
### Features
- **ProjectContext**: Add node_modules detection populator — detects `node_modules/` in cwd and reminds the agent to exclude it from `ls`/`grep` (the grep tool auto-excludes it, but the bash tool does not); registered for lead + teammates, no-op for non-Node projects.
- **WebUI**: Add state-machine stage tag chip row (verboseLogs only) for `isWaiting` desync diagnosis — derived stage label, raw boolean chips, buffer counters, and last server message type/timestamp; add `ChatState.lastServerMsg` + `DebugSnapshot` mirror + send→running latch with 15s expiry.
### Fixes
- **Windows**: Fix PS 5.1 `Get-Content` read-side mojibake (add `$PSDefaultParameterValues['Get-Content:Encoding']='utf8'` to the 5.1 Layer-2 patch); make `bg_create` symmetric with the bash tool (use detected shell, per-shell preamble, filter CLIXML noise, add `PYTHONUTF8`).
### Refactoring
- **Prompts**: Split the 574-line `agent-prompts.ts` monolith into `prompts/{common,lead,teammate}.ts` (no barrel re-export); repoint importers + test mocks; delete stale empty `agent-prompts/` dir.

## 2026-09-02
### Refactoring
- **Prompts**: Extract the intent-lang section into `intent-lang.ts` and move the plan-base prompt to `lead.ts`; convert `common.ts` section builders to array-literal join style; replace `lines.push` with array literals in intent-lang; fix `bg.ts` lint (prefer-template). Output byte-identical (baseline round-trip test); tsc + eslint (0 warnings) + 2691 vitest tests pass.
- **AWAIT**: Rename state-machine stage `WAIT`→`AWAIT` (state file `state/wait.ts`→`state/await.ts`) and add `--disable-crossroad` flag.
- **Team**: Replace STOP's one-shot `awaitTeam` with event-polling teammate wait; unify `teammate_await` into a single `awaitTeammates` primitive; annotate stale teammate deadline in `printTeam` and document its advisory nature.
- **Coordination**: Add Counterwork, Delphi, and Scratchpad topologies.
### Docs
- **README**: Fix inconsistencies — C++ compiler only needed when building from source (native deps ship prebuilt binaries/WASM); note `@pkubangbang/mycc` is not published (must run from source); tmux is optional (only used by `hand_over`); document auto mode and daemon mode; add `--auto`/`--daemon` flags to config table.

## 2026-09-03
### Fixes
- **Collect**: Self-recover from transient errors in auto mode.

## 2026-09-06
### Fixes
- **Loop**: Drain stale steering notes on 停止/ESC neglection to break the AWAIT re-wake tight loop.
- **Display**: Strip single-vline DSML markup in the `hook.ts` brief path.

## 2026-09-07
### Features
- **Stream**: Replace the 120s total timeout with a 10s inter-token liveness check; add phase-aware liveness timeout with escalation between thinking and response phases.
- **Spinner**: Show live time + token stats after a 5s wait.
### Fixes
- **Stream**: Remove un-tracked abort listeners on the normal-completion path.
- **Peer**: Retry `rename` on Windows `EPERM` in `atomicWrite` and clean orphaned temp files.
### Refactoring
- **Utils**: Extract shared `atomicWrite` util and dedup across 8 call sites; dedup `getSessionsDir` by importing from config.

## 2026-09-08
### Features
- **WebUI**: Add synthetic flag to the brief pipeline — hide machine-originated briefs from the WebUI chat log; auto-aware `running:off` routing + unified uppercase stage vocabulary.
### Fixes
- **WebUI**: Activate Pinia before module-level store creation; remove premature `drainSteering` from `stop.ts` so steering notes surface as review cards.
### Refactoring
- **WebUI**: Drop redundant stage-row chips now that the phase enum is the single source of truth; drop dead stage-chip CSS from `ChatInput`.

## 2026-09-10
### Fixes
- **escAware**: Register `AbortController` on the `agentIO` global slot.

## 2026-09-13
### Refactoring
- **Crossroad**: Extract the semantic detector into `@pkubangbang/crossroad-detector` and consume the published `0.1.1` package.
### Docs
- **Crossroad**: Add crossroad detector case study; bump version to `0.11.0`.

## 2026-09-14
### Features
- **Serve**: Add persistent WebUI for headless daemon; add `sendToParent` singleton wrapper for Coordinator IPC.
### Fixes
- **Recap**: Show a spinner while the recap forks run.
- **Daemon**: Display the Lead's real PID, not the wrapper's.
- **Package**: Bump version and make the repo not publishable.
### Docs
- **Skills**: Document the recap-to-mindmap blind spot in `mycc-self-awareness`; update the tool description of `hand_over`.

## 2026-09-15
### Features
- **Peer Wire**: Add cross-machine peer wire and todo previous-hash lineage ring.
### Fixes
- **Peer Wire**: Keep `socketsBySid` + `sidIndex` coherent across SID migration; make `peer_disconnect` SID-scoped (whole-pair) across the convergence window; address PR #11 review findings (sidIndex, wss reconnect, token header, payload check).
- **Daemon**: Display the Lead's real PID, not the wrapper's.

## 2026-09-16
### Features
- **Collect**: Composite keyword extraction (X+Y+Z) in the COLLECT state; outcome-gated throttle for keyword extraction.
- **Skills**: Migrate `hand-over-ethics` to built-in with content improvements.
### Fixes
- **Config**: Remove dead `--debug-prompt` flag, relocate `--debug-wire` to Debug Flags, align docs with code.
### Refactoring
- **Collect**: Extract `handleCollect` steps into 6 named functions.

## 2026-09-17
### Features
- **Output**: Suppress decoration when stdout is not a TTY; close the `--help` plain-output hole.
- **Wiki**: Render `/wiki rebuild` progress bar unconditionally.
- **Mindmap**: Show batch size (xN) in progress display for multi-call rounds.
### Fixes
- **Triologue**: Stop sanctioning auto-progression via synthetic "continue" messages; eliminate the compact→LLM `duplicate_assistant` TP violation via brief tool-call resume; drop the blanket "Continuing." from the crossroad synthetic brief; stop silently suppressing the `[HINT]` note on "no blockers".
- **Output**: Close P1 raw-write hole and P2 `--debug-ansi` TTY hole.
### Refactoring
- **Mindmap**: Re-indent the diff-mindmap progress block to 2 spaces.
### Docs
- **Skills**: Lead descriptions with function, demote trigger mechanics.
### Chores
- **Deps**: Bump package dependencies; bump patch version to `0.11.4`.

## 2026-09-18
### Features
- **Serve**: Add weak-ETag/304 to `/history` and sessionId to `/config`; configure vite `publicDir` to `.mycc/public` and add `serve-public-dir` skill.
- **Hook**: Redefine turn/session semantics with compaction-immune `totalTurns`.
### Fixes
- **Hook**: Reject bare function-only identifiers (`totalTurns`/`isPlanMode`).
- **Triologue**: Drop blanket "Continuing." from crossroad synthetic brief.
- **WebUI**: IndexedDB chatlog cache + collapse early chatlog with infinite scroll; fix reconnect session fencing + hydrate-before-mount.

## 2026-09-19
### Features
- **WebUI**: Atomic session switch, ETag-after-parse, stable `v-for` key; pure collapse-state reducer, WS gate, `historyDirty`; gate WS on `/config` success, isolate verbose-toggle from append; single-watcher collapse classifier, RFC `If-None-Match`; pure `applyObservation` transition; `historyRevision` reset signal + loadMore DOM-message scroll anchoring; measure loadMore anchor child rect + normalize cached message IDs; document loadMore anchor id-guarantee + anchor-regression tests.
### Refactoring
- **WebUI**: Rework chatlog collapse boundary control (x / t / trackingTail).

## 2026-09-20
### Features
- **Wiki**: State-machine 2FC write path + native cosine search.
- **Skill-Index/WAL**: Extract skill-index and WAL handling from `WikiManager`.
### Fixes
- **Wiki**: Key PENDING→LIVE on a per-row uuid; stop exporting the transient id.
- **Coordinator**: Launch discipline + peer-mail channel-completeness warning.

## 2026-09-21
### Features
- **Collect**: Branching skill suggestion with semantic intersection.
- **Wiki**: Fault-injected crash → restart → rebuild convergence tests (test coverage).
### Fixes
- **Collect Skill**: Reset stale turn state on fresh-session clear; reset singleton on `/clear` and double-Ctrl+L.
### Refactoring
- **Collect**: Extract hint round into `collect-hint.ts`; extract skill suggestion into `collect-skill.ts`; move discovery state into a `SkillSuggester` singleton; merge `buildSkillKeywordsMessages` populator into `extractKeywords`.

# Todo

> Todo - Or never?
> The below todo items have inherit gap with mycc's current implementation.
> With the existing archetecture, these todos may not be easily completed.
> Let's write them down to admit our limitation.

- [ ] add e2e test using tmux, with meaningful test cases, written as a skill.
- [ ] enable "boostrap install" mode via Docker. 
- [ ] make `/save` generate a "rich" session backup in addition to the original "slim" one.
- [ ] enable "remote shell" -- make local mycc able to control remote codebase.