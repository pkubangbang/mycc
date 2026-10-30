---
name: chores-handbook
description: >
  Index of recurring and infrequent, high-risk maintenance chores on mycc that
  are performed MANUALLY rather than automated. Each chore lives in its own
  file under chores/ and is loaded only when needed. Covers: (1) migrating
  legacy WAL entries to the current embedding-model namespace (export →
  string-replace → import); (2) running the "skipped" topical test suites;
  (3) the recurring note-template friction audit of triologue.note() prompt
  injections; (4) reclaiming stale discovery state (orphan channel files and
  heartbeat files under ~/.mycc-store/discovery); (5) why slow, PTY/tmux-driven
  boot suites must NOT be test-covered, and how to reproduce them by hand.
  Use when the user switches embedding models, when WAL entries predate the
  rag-provider abstraction, when the user asks how to migrate / re-stamp /
  re-namespace wiki data, when a periodic review of the injected prompt
  templates is due, when the discovery directory has accumulated dead peers /
  orphan channel files, or when you are about to write an automated test for a
  real-terminal startup contract. Do NOT automate these chores — always present
  the manual steps so the user stays in control of the mutation.
keywords: [wiki, WAL, migrate, namespace, embedding, model switch, chores, maintenance, export, import, rag, re-namespace, note, triologue, prompt, template, friction, audit, recurrence, discovery, channel, heartbeat, orphan, stale, cleanup, reclaim, identity, tmux, PTY, startup ordering, test not worth it, slow suite, flaky]
---

# Chores Handbook

This handbook documents infrequent, high-risk maintenance chores on mycc: wiki
migration, test-suite hygiene, prompt-template audits, discovery reclamation,
and one explicit *don't* (automated tests for PTY startup contracts). The
chores are deliberately **not automated**: they mutate persisted data that is
hard to recover, and they occur rarely. The correct pattern is to walk the user
through the manual steps so they review every change before it is applied.

> **This is a progressive-disclosure skill.** This entry file holds the
> decision points and the shared principle; the body of each chore is a sibling
> file under `chores/`. Open ONLY the one you need — most sessions need exactly
> one. Do not read all five.
>
> Sibling references in this skill:
> - `chores/01-wal-namespace-migrate.md` — Chore 1: export → stamp → import (or in-place re-stamp) legacy WAL entries.
> - `chores/02-skipped-suites.md` — Chore 2: find, run and un-skip the environment-bound suites; skip-not-delete rule.
> - `chores/03-note-friction-audit.md` — Chore 3: three-reviewer audit of `triologue.note()` call sites against six friction patterns.
> - `chores/04-discovery-reclaim.md` — Chore 4: audit → back up → delete CANDIDATE discovery/ heartbeat files.
> - `chores/05-slow-tmux-suites.md` — Chore 5: why PTY/tmux boot tests are not committed, and the manual reproduction.

## Pick your chore

| # | Chore | File | Load it when… |
|---|-------|------|---------------|
| 1 | Migrate legacy WAL entries to the current namespace | `chores/01-wal-namespace-migrate.md` | the user switches `OLLAMA_EMBEDDING_MODEL`, or asks to migrate / re-stamp / re-namespace wiki data, or `rebuild()` warns about namespace-less legacy entries |
| 2 | Run the "skipped" topical test suites | `chores/02-skipped-suites.md` | you touched code covered by a `describe.skip` / `it.skip` suite, or need to know how to find and run them |
| 3 | Recurring note-template friction audit | `chores/03-note-friction-audit.md` | a periodic review of `triologue.note()` prompt injections is due |
| 4 | Reclaim stale discovery state | `chores/04-discovery-reclaim.md` | `~/.mycc-store/discovery` has grown large, or `peer_list` shows a graveyard of dead peers / orphan channel files |
| 5 | Do NOT test-cover slow, PTY-driven boot suites | `chores/05-slow-tmux-suites.md` | you are about to write (or re-add) a tmux/real-terminal test for a startup-ordering contract — read this FIRST |

Chore 1 is the one-shot wiki migration; Chore 2 and Chore 5 both touch testing
but are different mechanisms (2 = suites that are skipped but kept; 5 = a test
that was written, proved useful, and was removed on purpose — with a manual
reproduction in its place).

## Core principle: why manual, not automated

A built-in `/wiki migrate` command was deliberately removed. Rationale:

1. **Low frequency** — it runs once per embedding-model switch, perhaps a
   handful of times over the lifetime of a knowledge base.
2. **High data-corruption risk** — rewriting every WAL file in place means a
   single bug or accidental run can corrupt all historical audit data. There
   is no per-entry undo.
3. **Reversible-by-design** — the export → edit → import flow produces an
   intermediate JSON file the user can inspect, back up, and re-run. An
   in-place mutation offers no such checkpoint.

The same reasoning generalises: every chore here has an inspectable
intermediate state and a rollback section. Keep it that way.

## Adding a new chore

Create `chores/0N-<slug>.md` with the same shape as the existing ones —
background → prerequisites → numbered manual steps → verify → rollback — add a
row to the table above, and extend the frontmatter `description`/`keywords` so
the skill still matches the situations that need it. Resist the temptation to
promote a chore to a slash command or a committed test; the manual flow with an
inspectable intermediate step *is* the safety mechanism.
