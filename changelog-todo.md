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

> **Archive**: For October 2026, see `changelog-202610.md`. For September 2026 entries, see `changelog-202609.md`. For August 2026 and earlier, see `changelog-202608.md`. For July 2026, see `changelog-202607.md`. For June 2026, see `changelog-202606.md`. For May 2026, see `changelog-202605.md`. For April 2026, see `changelog-202604.md`.

<!-- October 2026 entries rotated to changelog-202610.md on 2026-11-03. -->
<!-- Add new (November 2026 onward) entries below this line. -->

## 2026-11-08
### Features
- **Filesync**: Shared folders synced across wire peers — bind a folder with `--share <id>`/`MYCC_SHARES`/`/share`, and members whose `announce` carries the same id converge on one folder over the existing peer wire. FastCDC chunking, a content-addressed piece store (resume cursor + dedupe cache), LWW manifests with tombstones, atomic apply, and conflict copies reported to the lead by mail. The wire carries `sync-*` frames; the engine speaks transport-free `kind` messages, and `wire-codec.ts` is the only place the two vocabularies meet.
- **Filesync**: chokidar watcher + a closed scan→baseline race — the watcher is latency only, never correctness; if it cannot start the engine degrades to the 30 s gossip and still converges.
- **Filesync**: a share bound after the wires are up still finds its partners; a peer must present a share-proof before it becomes a partner.
- **Peer**: `--debug-filesync` frame audit (`.sync/<id>/frames-*.jsonl`), logging each outbound manifest per PARTNER rather than as a `*` aggregate.
- **Brief**: batching allowed — the brief-isolation gate and its skill are gone.
- **Triologue**: Title-anchor segment archiving — a `mycc_title` call closes the current paragraph and archives it under that heading.
- **WebUI**: `ChatInput` split into capability-prop components; prop-driven composer height with an IME-safe viewport.
- **Skills/Web**: the title nudge re-arms per interval instead of once per session.
### Fixes
- **Serve**: Gate WebUI activation on a successful health check; mirror plan/normal mode live instead of caching the last broadcast.
- **Grant**: Classify complex commands with the LLM instead of blocking outright in plan mode.
- **Triologue**: Stop the double write (`triologue-lite`: one call is one message); check the summary head, not the live tail, on a head splice.
- **Web**: Render backslashes verbatim in path-bearing tool messages and image logs; split the No button with a refusal reason.
- **Read**: Implement the documented `limit` argument.
- **Tests**: Pin vacuous assertions to real output (three batches); delete duplicate suites and the dead state-machine harness; mute environment-bound suites behind `RUN_SLOW=1`.
### Refactoring
- **Filesync-Manager**: Extract `@pkubangbang/filesync-manager` into its own repo and npm package (`github.com/pkubangbang/filesync-manager`, v0.1.0). The package owns disk work only — chunking, piece store, manifests/tombstones, watcher, gossip clock — and exposes transport through an injected `PeerPort`; it carries no socket, HTTP or TLS dependency, which a hardening test now enforces.
- **Filesync-Manager**: Publish a build, not raw TypeScript — `files` ships `dist/` with `.d.ts` and maps; a barrel-only contract test drives the README usage example.
- **Filesync-Manager**: Hardening gate (H1–H10) before the version froze — pending TTL, the pending cap, the request window, restart over an existing state dir, engine-level conflict preservation, atomic apply (no tmp left, planted symlink harmless), edge paths, the layer boundary, the exact barrel export set, and gossip/close teardown. Tests moved to the package root and clock-driven cases use fake timers.
- **Filesync-Manager**: `MAX_PENDING_FILES` is now a hard admission bound evicting in insertion order — it was best-effort, and a manifest burst could reach `MAX + 1`.
- **Loader**: Hot-reload project tools/skills with chokidar rather than `fs.watch`.
- **Triologue**: Delete the dead brief-merge and brief-index lookups.
- **Tests**: Consolidate suites under `src/tests/`, add a registry-driven tool-metadata test and shared `test-utils`, and give VS Code the dedicated test tsconfig.
### Docs
- **Set-title**: A title is a paragraph bookmark, not a tab name — one per chunk of finished work, retitled when the focus moves.
- **Chores-handbook**: Split into progressive-disclosure files and add Chore 5.
- **Archived**: Record the 24 features since `f09bd22` in six revert-coherent groups after the 2026-10-27 revert round.
### Chores
- **Release**: Bump version to `0.11.9`; `filesync-manager` now comes from npm (`^0.1.0`) instead of a monorepo workspace member, with the four config couplings that existed only for the in-tree package removed.
- **Merge**: PR #38 (`feat/peer-filesync`) merged into `main`.

# Todo

> Todo - Or never?
> The below todo items have inherit gap with mycc's current implementation.
> With the existing archetecture, these todos may not be easily completed.
> Let's write them down to admit our limitation.

- [ ] add e2e test using tmux, with meaningful test cases, written as a skill.
- [ ] enable "boostrap install" mode via Docker. 
- [ ] make `/save` generate a "rich" session backup in addition to the original "slim" one.
- [ ] enable "remote shell" -- make local mycc able to control remote codebase.