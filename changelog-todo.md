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

# Todo

> Todo - Or never?
> The below todo items have inherit gap with mycc's current implementation.
> With the existing archetecture, these todos may not be easily completed.
> Let's write them down to admit our limitation.

- [ ] add e2e test using tmux, with meaningful test cases, written as a skill.
- [ ] enable "boostrap install" mode via Docker. 
- [ ] make `/save` generate a "rich" session backup in addition to the original "slim" one.
- [ ] enable "remote shell" -- make local mycc able to control remote codebase.