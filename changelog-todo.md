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

> **Archive**: For changelog entries before August 2026, see `changelog-202607.md`. For June 2026, see `changelog-202606.md`. For May 2026, see `changelog-202605.md`. For April 2026, see `changelog-202604.md`.

<!-- July 2026 entries rotated to changelog-202607.md on 2026-08-03. -->
<!-- Add new (August 2026 onward) entries below this line. -->

## 2026-08-03
### Release
- **v0.9.7**: Mindmap patch line, mdcalc grid op, unused-variable fixes, docker bootstrap doc.
### Features
- **Mindmap Patch Line**: Recap-driven knowledge patches with two independent disk lines; explorer-agent batch tool calls + round budget steering.
- **mdcalc**: Add grid op for sparse 2D data entry.
### Fixes
- **Mindmap**: Resolve patch "7 skipped" via normalized-id lookup + orphan-prevention.
- **TypeScript**: Resolve TS6133 unused-variable errors; add `--force` flag to `/mindmap compile`.
### Docs & Chores
- **Docker**: Document bootstrap install mode.
- **Changelog**: Rotate July 2026 entries to `changelog-202607.md`; prune done todos.
- **MYCC.md**: Condense project knowledge reference.
- **Skills**: Remove stop-trigger message from lint/test-after-edit hooks.
- **Demo**: Remove demo mdcalc file.

## 2026-08-06
### Features
- **Auto Mode**: Add `--auto` autonomous mode with WAIT state and webui integration.
### Fixes
- **WebUI**: Never trigger multi-line editor in serve/webui mode.

## 2026-08-07
### Release
- **v0.10.0**: Peer discovery protocol, auto-mode state machine, triologue auto-compact, peer review fixes.
### Features
- **Peer Discovery (myccdp)**: Implement mycc discovery protocol; add `peers` tool + mediator skill; `mail_to` routes `session-id/lead` names to remote peers; add `/peer` slash command with two connection modes.
- **Auto Mode**: Rework into `AutoState` singleton with streak/autofly; STOP always → PROMPT, PROMPT owns auto-redirect; add `--allow-plan-off` CLI switch to auto-approve `plan_off` in auto mode.
- **Channel**: Wake blocked PROMPT on channel-join via `PromptAbortError`; remove `/channel connect` sub-command.
- **Triologue**: Move auto-compact to LLM stage with working-memory focus extraction.
### Fixes
- **Peer (critical)**: `identity.ts` isFresh() — add 90s absolute freshness window so dead instances return false.
- **Peer (critical)**: `mail.ts` collectMails() — atomic rename-then-read prevents mail loss during concurrent append.
- **Peer (high)**: `identity.ts` register/unregister — 3-retry read-merge-write loop handles concurrent clobber.
- **Peer (high)**: `mail_to.ts` — UUID format regex replaces `includes('-')` to prevent misrouting.
- **Peer (high)**: `config.ts` — sanitizeId() strips path separators from sessionId/channelId.
- **Peer (high)**: `agent-repl.ts` onChannelJoin — guard `setAuto(true)`+abort on `isPromptBlocked()`.
- **LLM**: Break empty-output infinite loop after a tool result.
- **Teammate**: Stop thinking spinner and notify user when teammate question is queued.
### Docs
- **README**: Explain `--token-threshold` / `TOKEN_THRESHOLD` semantics.
- **State Machine**: Document the WAIT stage and embed state machine diagram.
### Tests
- **Peer**: 3 new test files (peer-freshness, peer-concurrency, peer-guard-paths) + updated peer.test.ts and mail_to.test.ts — 2190 passed, 11 skipped, 0 failed.

## 2026-08-08
### Features
- **Shell Detection**: Detect shell once at startup; tailor prompt + exec; split agent-io.
- **Peer**: Surface instance progress via briefs + 1h listing cutoff.
- **mail_to**: Fail-fast recipient validation — reject unknown recipients up front.
### Fixes
- **shell-detect**: Detect Store-installed pwsh 7 via `access(2)` instead of `stat(2)`.
### Docs
- **Skills**: Clarify set-title (stay silent when not acting on reminder); reframe self-awareness as end-user tutor glossary; mediator — bash-only examples, shell-agnostic JSON authoring.

## 2026-08-09
### Features
- **Shell Detection**: Detect shell once at startup; tailor prompt + exec; split agent-io.
- **Peer**: Surface instance progress via briefs + 1h listing cutoff.
- **mail_to**: Fail-fast recipient validation — reject unknown recipients up front.
### Fixes
- **shell-detect**: Detect Store-installed pwsh 7 via `access(2)` instead of `stat(2)`.
### Docs & Chores
- **hand_over**: Update tool description.
- **Skills**: Clarify set-title (stay silent when not acting on reminder); reframe self-awareness as end-user tutor glossary; mediator — bash-only examples, shell-agnostic JSON authoring.

## 2026-08-10
### Features
- **Peer**: Grant read-only access to peer workDir on channel join.
- **Grant**: Whitelist `~/.mycc-store/discovery` for free read+write across instances.
### Fixes
- **git_commit**: Distinguish auto-mode rejection from user denial.
### Refactoring & Docs
- **Mediator**: Progressive-disclosure split + skill_load Location line; clarify that post-write joined/firstQuerySent=true is the success signal.

## 2026-08-11
### Features
- **WebUI**: Redesign auto-mode rocket button with warp scene and fix scroll.
- **Tool**: Add brief-triggered skill discovery.
- **screen**: Update tool to add `desktop` param.
### Fixes
- **WebUI**: Wake blocked PROMPT on auto-mode entry so pending mail is polled immediately; fix frontend type errors (add frontend typecheck to npm test); move vite and `@vitejs/plugin-vue` to dependencies.
- **crossroad**: Eliminate duplicate paragraphs in Resolved messages.
### Refactoring
- **WebUI**: Extract rocket + meteor starfield into components, add enter/exit transitions, fix meteor coverage and v-for key.
- **Core**: `Core.question()` returns structured `AskResult` instead of plain string.
### Chores
- **Deps**: Upgrade deps and fix Vue App type name clash.
### Tests
- **Agent Loop**: Add observability, mock harness, and 53 parametric path tests with hang detection.

## 2026-08-12
### Features
- **WebUI**: Add compact button in chatInput.
### Fixes
- **triologue**: Reset `wrapUpMark` on compact to prevent sparse-hole crash after `/compact`.
- **autofly**: Make streak count per-turn LLM-stage momentum.
- **screen**: Make `imgDescribe` use `retryChat` so vision calls can timeout/abort.

## 2026-08-13
### Features
- **wiki_get**: Add brief logging matching web_search/recall pattern.
### Fixes
- **Mindmap**: Add final tool as sole summary exit + budget-exhaustion fallback.
- **WebUI**: Keep chat input always enabled; gate sending instead of disabling; resolve wrap-up before draining uploaded files.
- **hook**: Make replace-on-stop safe, generalize `#pattern`, add per-turn dedup for stop+block/replace; instruct condition compiler to use `==` not `===`.
### Docs
- **Docs**: Audit all docs/ for consistency with current code.
### Tests
- **Typecheck**: Add dedicated test typecheck and align mocks with current module APIs.

## 2026-08-14
### Features
- **Hook**: Redesign hook condition API (`seq.*` → `turn.*/session.*`); prompt LLM to recompile legacy `seq.X` conditions.
- **Skill**: Add install-from-zip built-in skill.
### Fixes
- **crossroad**: Display prefix, persist decision record, add read_file aloud replay bypass.
- **WebUI**: Constrain teammate letterbox list/heading padding; unlock send button during send→running gap; preserve teammate drawer scroll position + fix lint warning.
### Tests
- **Hook**: Rewrite hook test suite for `turn.*/session.*` API + fix webui send-button lock after card submission.

## 2026-08-16
### Features
- **pretty-print**: Add "channel" type for ChannelFile rendering.
### Fixes
- **hook**: Reset hook dedup on `/clear`, `/compact`, and auto-compact.
### Refactoring
- **Core**: Restore read/write symmetry by moving display concern from read_file to bash.
- **WebUI**: Redesign chatInput + sendButton — always-enabled textarea, warning banner, steering-review card.

## 2026-08-17
### Release
- **v0.10.2**: Patch release — hook condition API redesign, agent-loop test harness, crossroad decision records, webui chatInput redesign, mindmap link-carrying patches, Windows UTF-8 stdio fix.
### Features
- **Mindmap**: Patch-added nodes carry links (term hoist without recompile).
- **Hook**: Redesign condition API (`seq.*` → `turn.*/session.*`); prompt LLM to recompile legacy `seq.X` conditions.
- **Tool**: Add brief-triggered skill discovery.
- **Screen**: Add `desktop` param for multi-monitor capture.
- **WebUI**: Redesign chatInput + sendButton (always-enabled textarea, warning banner, steering-review card); redesign auto-mode rocket button with warp scene.
- **Pretty-print**: Add "channel" type for ChannelFile rendering.
- **Skill**: Add `install-from-zip` built-in skill.
### Fixes
- **agent-exec**: Force UTF-8 stdio for native exes (python) on Windows.
- **Neglection**: Centralize wrap-up in STOP state.
- **Hook**: Reset hook dedup on `/clear`, `/compact`, and auto-compact; make replace-on-stop safe, generalize `#pattern`, add per-turn dedup for stop+block/replace; instruct condition compiler to use `==` not `===`.
- **Crossroad**: Display prefix, persist decision record, add `read_file` aloud replay bypass; eliminate duplicate paragraphs in Resolved messages.
- **WebUI**: Constrain teammate letterbox list/heading padding; unlock send button during send→running gap; preserve teammate drawer scroll position; keep chat input always enabled (gate sending instead of disabling); resolve wrap-up before draining uploaded files; wake blocked PROMPT on auto-mode entry so pending mail is polled immediately; add frontend typecheck to npm test and fix type errors.
- **Triologue**: Reset `wrapUpMark` on compact to prevent sparse-hole crash after `/compact`.
- **Autofly**: Make streak count per-turn LLM-stage momentum.
- **Screen**: Make `imgDescribe` use `retryChat` so vision calls can timeout/abort.
- **wiki_get**: Add brief logging matching web_search/recall pattern.
- **Mindmap**: Add final tool as sole summary exit + budget-exhaustion fallback.
- **hand_over**: Set session shell from detection and type command via send-keys.
- **Shell-detect**: Detect Store-installed pwsh 7 via `access(2)` instead of `stat(2)`.
- **git_commit**: Distinguish auto-mode rejection from user denial.
### Refactoring
- **Core**: `Core.question()` returns structured `AskResult` instead of plain string.
- **Mediator**: Progressive-disclosure split + `skill_load` Location line.
- **read/write**: Restore symmetry by moving display concern from `read_file` to bash.
- **WebUI**: Extract rocket + meteor starfield into components, add enter/exit transitions.
- **Shell**: Detect shell once at startup; tailor prompt + exec; split `agent-io`.
- **Deps**: Upgrade deps and fix Vue App type name clash; move vite and `@vitejs/plugin-vue` to dependencies.
### Docs
- **Docs**: Audit all `docs/` for consistency with current code.
- **Skill**: `set-title` — stay silent when not acting on the reminder; `self-awareness` — reframe as end-user tutor glossary; `mediator` — bash-only examples, shell-agnostic JSON authoring.
- **Peer**: Document that post-write joined/firstQuerySent=true is the success signal; grant read-only access to peer workDir on channel join; whitelist `~/.mycc-store/discovery` for free read+write across instances.
- **hand_over**: Update tool description.
### Peer
- **Progress**: Surface instance progress via briefs + 1h listing cutoff.
- **mail_to**: Fail-fast recipient validation — reject unknown recipients up front.
### Tests
- **Agent-loop**: Add observability, mock harness, and 53 parametric path tests with hang detection.
- **Hook**: Rewrite test suite for `turn.*/session.*` API.
- **Typecheck**: Add dedicated test typecheck and align mocks with current module APIs.

## 2026-08-18
### Features
- **Serve (steering)**: Replace negative discard/send-as-query semantics with a single positive "boomerang" API — `resolveSteering(sendIds)` atomically clears the backend queue, submits selected notes as a combined query, and drops the rest (no re-buffering, no double injection); add id-based SteeringReviewCard + `steer-resolve` WS message.
- **Serve (steering)**: Extract `steering-queue.ts` as a pure, testable module (no agent-io dep).
- **WebUI**: Extract `message-dispatch.ts` (DOM-free pure dispatch) as the single chokepoint for all WS state transitions; add `debug.ts` (`window.__myccDebug` enable/inject/snapshot/reset seam) so tests drive the exact same dispatch path as live WS events.
- **WebUI**: Add DebugPanel.vue (debugMode flag in ChatState).
### Fixes
- **Bang command**: Bare `!` no longer coerces to `undefined` — pass the empty string through; `hand_over` skips send-keys on empty command (leaves a clean shell prompt) and labels todo/header "(interactive shell)".
- **WebUI**: Responsive ChatInput toolbar + image-only send.
- **Config**: `ensureGitignore` uses `/.mycc/*` not `/.mycc/`.
- **WebUI**: Stabilize resize handle touch dragging + overlay teammate drawer on narrow screens.
### Refactoring
- **Serve**: Split `serve-hub.ts` (1227 lines) into 7 cohesive ≤500-line modules — `serve-types`, `serve-utils`, `serve-clients`, `serve-history`, `serve-disconnect-timer`, `serve-ws-handler`, slimmed `serve-hub` facade; embed multi-browser user-bubble sync in `serve-ws-handler` (broadcastExcept so a query/steering note typed in one browser appears live in every other connected browser, skipping the optimistic sender).
### Tests
- **Serve**: 17 new steering-queue + message-dispatch unit tests.
- **hand_over**: 4 regression tests (Cluster C) for the bare `!` bang command.
### Docs
- **Serve**: Add E2E test doc.

## 2026-08-19
### Features
- **mycc-mail CLI**: Add global `mycc-mail` bin (cross-instance / cronjob-triggered mail by looking up a target lead's mailbox in `~/.mycc-store/discovery/identity.json` and appending a JSONL line).
- **mail_to**: Scope the `mail_to` tool down to intra-session communication only (lead ↔ teammates within one mycc instance); slash-bearing `<uuid>/lead` names rejected with an error pointing to the `mycc-mail` CLI.
- **Serve**: Print all reachable URLs in startup banner — enumerate every LAN IP (Local: + Network: lines, Vite-style) instead of just the first.
- **Serve**: Warn about Windows Defender Firewall on LAN-visible `--host` startup (win32 + truthy host only) with the exact one-line `netsh` remediation command.
### Refactoring
- **Skills**: Refactor 3 stocked skills (coordination, mycc-self-awareness, clear-sessions) to progressive-disclosure structure (monolithic SKILL.md → entry file + sibling `.md` files loaded on demand via read_file).

## 2026-08-20
### Fixes
- **mail_to (revert)**: Restore `mail_to` peer IPC; keep `mycc-mail` CLI for external triggers only. The a7a0750 DRY migration pushed a system-level concern (inter-instance messaging) into the user-level tool layer (bash), where the bash-judge LLM classifier blocked peer mail in plan mode. Peer communication returns to the tool layer as a direct IPC call (`mail_to` → `ctx.peer.sendPeerMail`), bypassing the bash-judge pipeline; skills + tests reverted to pre-a7a0750 state.
- **Crossroad**: Skip crossroad when tool calls present — gate on `rawToolCalls.length === 0` so a committed tool call (e.g. mid-thought `brief`) isn't truncated by an alien continuation; soften the response wording ("Resolved my direction..." → "Refining my approach. Continuing.").
- **Config**: Move `node-linker=hoisted` from `.npmrc` to `pnpm-workspace.yaml` (pnpm v11+ reads non-auth settings from there), silencing npm's "Unknown project config node-linker" warning.
### Tests
- **Crossroad**: Add "skip crossroad when tool calls present"; fix mock leakage (mockReset in beforeEach); update existing crossroad-firing tests to use text-only responses.
### Docs
- **Crossroad**: Update `crossroad-design.md` (new guard + softened wording).

## 2026-08-21
### Features
- **WebUI (shiki)**: Integrate shiki syntax highlighting (dual-theme github-light/github-dark, `defaultColor:false`) so a single render switches colors with the WebUI theme toggle via CSS variables — no re-highlighting; fenced code blocks and bash command cards (`bash` + `bg_create` labels) render as highlighted cards; `bg_create` pre-exec brief keeps label/content raw so it renders as a highlighted card titled "bg_create".
- **Slash**: Add `/reload` command to restart only the Lead process, reusing the Coordinator — no `--from` (conversation cleared), no new terminal; if `/serve` was active the new Lead rebinds the web UI to the same port (browser auto-reconnects).
### Fixes
- **WebUI**: Remove free-text textarea from choice cards (bracket-suffix `[1/2/3/4]` prompts) — the backend silently discarded it as Deny since `requestExternalPathAccess()` only parses the option numbers; confirm cards (git_commit feedback, plan_on custom path) keep their textarea.
- **Serve**: Add 'notice' card kind for `/load` & `--from` DOSQ confirmation — instruction + single OK button, no free-text input (driven by new inert `AskOptions.notice` flag, only changes the webui card kind).
- **Platform**: Expose coordinator PID to lead agent (`MYCC_COORDINATOR_PID` env) and add a Process PIDs subsection to the platform prompt so broad kill commands can exclude the coordinator (prevents lead self-kill when stopping dev servers).
### Docs
- **Slash**: Add `docs/reload-design.md` (full design doc with effect-boundary table — coordinator-resident modules like `index.ts`/`config.ts` are NOT reloaded) + `/reload` section in `slash-commands.md`.

## 2026-08-26
### Fixes
- **Crossroad (revert + brief exemption)**: Revert the `f7a2af8` guard that skipped crossroad whenever ANY tool call was present — it over-suppressed genuine direction reversals. Replace with a `brief`-only exemption (Option B): crossroad runs when `tools.length > 0 && !isBriefOnly` (where `isBriefOnly = rawToolCalls.length > 0 && every call is brief`). A `brief`-only response is mid-thought narration whose text naturally contains "However"/"But"/"Wait" (Tier 2 turning words) as hedging — NOT a genuine reversal; firing on it truncates reasoning and discards a harmless status call (a mis-direction documented in `crossroad-1787189812709.json`). A NON-brief tool call (read_file, bash, edit_file, ...) alongside turning words IS a committed action the LLM then pivoted away from — crossroad fires and discards ALL tool calls (including any `brief`); the LLM regenerates them after the continuation. Peer-reviewed by a 4-member team (parity-auditor, loop-analyst, detection-quality, test-coverage) over 97 real-world session files.
- **Crossroad (stale-continuation leak)**: When crossroad produces an empty prefix (turning word at position 0, allowed by the `MIN_PREFIX_LENGTH=30` exception), the empty-output handler's `continue` re-entered the retry loop without clearing `chat.crossroadContinuation`/`crossroadFilePath`, so the next pass's unrelated LLM response reached HOOK and the crossroad branch merged a STALE continuation onto it. Fix: clear both fields before the `continue`.
### Tests
- **Crossroad**: `llm-crossroad-cooldown.test.ts` — rename Test 5 to brief-only exemption; add Test 5b (non-brief `bash` + turning word → crossroad fires, tool calls discarded) and Test 5c (brief + bash → crossroad fires, BOTH discarded); restore `bash` tool calls to Tests 1-3 that `f7a2af8` had stripped. `llm-esc-crossroad.test.ts` — restore the `bash` tool call to Test 2. All 22 llm state tests + 93 crossroad unit tests pass.
### Docs
- **Crossroad**: Update `docs/crossroad-design.md` for Option B — overview (brief-only exemption vs non-brief fire), code snippet aligned to `chat.` + `isBriefOnly` guard, key points, and edge cases (brief-only exemption row + stale-continuation empty-prefix row); correct ESC-during-crossroad to return STOP (not PROMPT).

# Todo

> Todo - Or never?
> The below todo items have inherit gap with mycc's current implementation.
> With the existing archetecture, these todos may not be easily completed.
> Let's write them down to admit our limitation.

- [ ] add e2e test using tmux, with meaningful test cases, written as a skill.
- [ ] enable "boostrap install" mode via Docker. 
- [ ] make `/save` generate a "rich" session backup in addition to the original "slim" one.
- [ ] enable "remote shell" -- make local mycc able to control remote codebase.