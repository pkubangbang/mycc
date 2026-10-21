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

# Todo

> Todo - Or never?
> The below todo items have inherit gap with mycc's current implementation.
> With the existing archetecture, these todos may not be easily completed.
> Let's write them down to admit our limitation.

- [ ] add e2e test using tmux, with meaningful test cases, written as a skill.
- [ ] enable "boostrap install" mode via Docker. 
- [ ] make `/save` generate a "rich" session backup in addition to the original "slim" one.
- [ ] enable "remote shell" -- make local mycc able to control remote codebase.