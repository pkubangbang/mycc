---
name: chores-handbook
description: >
  Reference guide for recurring and infrequent, high-risk maintenance chores
  on mycc that are performed MANUALLY rather than automated. Currently covers:
  (1) migrating legacy WAL entries to the current embedding-model namespace
  (export → string-replace → import); (2) running the "skipped" topical test
  suites; (3) the recurring note-template friction audit of triologue.note()
  prompt injections; (4) reclaiming stale discovery state (orphan channel files
  and heartbeat files under ~/.mycc-store/discovery). Use when the user switches
  embedding models, when WAL entries predate the rag-provider abstraction, when
  the user asks how to migrate / re-stamp / re-namespace wiki data, when a
  periodic review of the agent's injected prompt templates is due, or when the
  discovery directory has accumulated dead peers / orphan channel files and the
  user asks to clean it up. Do NOT automate these chores — always present the
  manual steps so the user stays in control of the mutation.
keywords: [wiki, WAL, migrate, namespace, embedding, model switch, chores, maintenance, export, import, rag, re-namespace, note, triologue, prompt, template, friction, audit, recurrence, discovery, channel, heartbeat, orphan, stale, cleanup, reclaim, identity]
---

# Chores Handbook

This handbook documents infrequent, high-risk maintenance chores on the mycc
knowledge base (wiki/RAG). These chores are deliberately **not automated**:
they mutate persisted data that is hard to recover, and they occur rarely
(typically once per embedding-model switch). The correct pattern is to walk
the user through the manual steps so they review every change before it is
applied.

## When to Load This Skill

- The user switched (or is about to switch) `OLLAMA_EMBEDDING_MODEL`.
- The user asks how to "migrate", "re-stamp", or "re-namespace" wiki data.
- A rebuild() warning mentions legacy WAL entries lacking a `namespace` field.
- The user wants to move wiki entries from one model's namespace to another.
- The user asks to "clean up" / "reclaim" `~/.mycc-store/discovery`, or notices
  that `channels/` or `heartbeat/` has grown large (see Chore 4).

## Core Principle: Why Manual, Not Automated

A built-in `/wiki migrate` command was deliberately removed. Rationale:

1. **Low frequency** — it runs once per embedding-model switch, perhaps a
   handful of times over the lifetime of a knowledge base.
2. **High data-corruption risk** — rewriting every WAL file in place means a
   single bug or accidental run can corrupt all historical audit data. There
   is no per-entry undo.
3. **Reversible-by-design** — the export → edit → import flow produces an
   intermediate JSON file the user can inspect, back up, and re-run. An
   in-place mutation offers no such checkpoint.

The workflow below is composed entirely of existing, general-purpose commands
(`/wiki export`, `/wiki import`, and any text editor). No dedicated migrate
code path exists in the binary.

---

## Chore 1: Migrate Legacy WAL Entries to the Current Namespace

### Background

Each WAL entry carries an optional `namespace` field naming the embedding
model that produced its vector (e.g. `"nomic-embed-text"`, `"embeddinggemma"`).
`rebuild()` only re-embeds entries whose `namespace` matches the current model.

Entries created before the rag-provider abstraction have **no** `namespace`
field. After switching models, these legacy entries are treated as "unknown"
and re-embedded on the next rebuild using the *current* model. To make the
WAL self-describing (so a future rebuild doesn't re-guess), stamp each legacy
entry with the current model's namespace.

### Prerequisites

Confirm the current embedding model and namespace. The namespace equals the
configured model name:

```
# What OLLAMA_EMBEDDING_MODEL is set to
echo $env:OLLAMA_EMBEDDING_MODEL        # PowerShell
echo $OLLAMA_EMBEDDING_MODEL           # bash/zsh
```

The namespace that will be stamped = that model name (e.g. `nomic-embed-text`).

### Step 1 — Export all entries to a JSON file

In the mycc prompt:

```
/wiki export wiki-backup-pre-migrate.json
```

This writes every live (non-deleted) WAL entry plus the registered domains to
`wiki-backup-pre-migrate.json` in the project directory. Keep this file — it
is your checkpoint/backup.

### Step 2 — Inspect the export

Open `wiki-backup-pre-migrate.json`. Each entry under the `entries` array
looks like:

```json
{
  "timestamp": "2026-06-09T08:21:13.146Z",
  "hash": "5d575abb454e518b",
  "document": { "domain": "...", "title": "...", "content": "...", "references": [] },
  "approved": true
}
```

Legacy entries have **no** `"namespace"` key. Entries already stamped have
`"namespace": "<model-name>"`.

### Step 3 — Stamp the namespace via string replacement

Add a `"namespace"` field to every entry that lacks one. Use any text editor
or a scripted find-and-replace. The goal: insert `"namespace":"<MODEL>"` into
each entry object.

**Option A — Editor find-and-replace (visual, safest):**

Search for `"approved":true` and replace with
`"approved":true,"namespace":"<MODEL>"` (and likewise for `"approved":false`
if you want to stamp unapproved entries too — usually not needed, since
import skips unapproved entries anyway).

**Option B — PowerShell (one-liner):**

```powershell
$model = $env:OLLAMA_EMBEDDING_MODEL
$f = "wiki-backup-pre-migrate.json"
$c = Get-Content $f -Raw -Encoding UTF8
# Insert namespace after every "approved":true that isn't already followed by a namespace
$c = $c -replace '"approved":\s*true,', "`"approved`": true, `"namespace`": `"$model`","
# Avoid double-stamping entries that already had a namespace: undo if namespace already present right after
$c = $c -replace "(?<=`"namespace`": `"[^`"]+`",)`"namespace`": `"[^`"]+`",", ''
Set-Content $f -C $c -Encoding UTF8
```

**Option C — sed (bash/zsh):**

```bash
MODEL="${OLLAMA_EMBEDDING_MODEL:-nomic-embed-text}"
F="wiki-backup-pre-migrate.json"
# Insert namespace after "approved":true (simple approach; review diff after)
sed -i.bak "s/\"approved\":true,/\"approved\":true,\"namespace\":\"${MODEL}\",/g" "$F"
# Restore already-namespaced entries from the .bak if the regex double-stamped;
# inspect `diff "$F" "$F.bak"` before committing.
```

> **Verify after replacement:** open the file and confirm a sample entry now
> reads `"approved":true,"namespace":"<MODEL>",` and that no entry has two
> `"namespace"` keys. If unsure, prefer Option A.

### Step 4 — Back up the live WAL directory

Before importing, copy the current WAL files aside so the import can be
re-done if something goes wrong:

```powershell
Copy-Item -Recurse "$env:USERPROFILE\.mycc-store\wiki\logs" "$env:USERPROFILE\.mycc-store\wiki\logs.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
```

```bash
cp -r ~/.mycc-store/wiki/logs ~/.mycc-store/wiki/logs.bak-$(date +%Y%m%d-%H%M%S)
```

### Step 5 — Decide: in-place WAL rewrite OR fresh import

Two acceptable outcomes:

**Outcome A — Re-stamp the live WAL (audit trail stays put):**
Edit the actual `*.wal` files in `~/.mycc-store/wiki/logs/` directly with the
same string-replace from Step 3 (they are JSON-lines, one entry per line). This
keeps the historical audit files in place, now self-describing. No import
needed; a future `rebuild()` will filter correctly.

**Outcome B — Start fresh and re-import:**
Clear the vector store and re-import the stamped JSON:

```
/wiki rebuild          # re-embeds from WAL using current model
/wiki import wiki-backup-pre-migrate.json
```

Import re-embeds every entry with the current model and stamps new WAL
entries with the current namespace automatically. Use this if you also want
the vectors regenerated for the new model.

### Step 6 — Verify

```
/wiki                  # show today's WAL; entries should now show namespace
/wiki rebuild          # should process the expected number of documents
```

Spot-check that `rebuild()` no longer reports legacy entries as
namespace-less. If a `wiki_get` search returns sensible results, the
migration succeeded.

### Rollback

If anything looks wrong, restore from the backup made in Step 4:

```powershell
Remove-Item -Recurse "$env:USERPROFILE\.mycc-store\wiki\logs"
Rename-Item "$env:USERPROFILE\.mycc-store\wiki\logs.bak-<timestamp>" "$env:USERPROFILE\.mycc-store\wiki\logs"
```

```bash
rm -rf ~/.mycc-store/wiki/logs
mv ~/.mycc-store/wiki/logs.bak-<timestamp> ~/.mycc-store/wiki/logs
```

Then `/wiki rebuild` to regenerate vectors from the restored WAL.

---

## Chore 2: Run the "skipped" topical test suites

### Background

A few suites in `src/tests/` are gated behind `describe.skip` / `it.skip`
because they **spawn real child processes** or otherwise depend on the
environment (a terminal opener, a live pid, a real `host:port` endpoint). They
are kept — not deleted — so coverage is preserved; they are skipped only so the
default `pnpm test` (aka `vitest run`) stays fast and deterministic on every
platform. When you touch the code they cover, you MUST run them explicitly.

Currently skipped / environment-dependent (verify with `grep` before relying on
this list — it drifts):

- `src/tests/mycc-compose-shim-parse.test.ts` — both describes wrapped in
  `describe.skip` (OS-gated; spawns the launcher shim).
- `src/tests/mycc-compose-peers.test.ts` — the `stopPeer:`/`launchPeer:`
  describes spawn processes. (The launch-timeout case is a live `it()` again —
  it uses `opts.timeoutMs` to stay ~1s.)
- `src/tests/mycc-compose-down.test.ts` — 3 process-spawning cases (`it.skip`).
- `src/tests/mycc-compose-up-pipeline.test.ts` — spawning cases (`it.skip`).
- `src/tests/serve/peer-wire-smoke.test.ts` — pre-existing (NOT part of the
  compose PR); smoke-level.

### How to find them

```powershell
# every skip site (file:line + the reason comment usually follows)
Select-String -Path src/tests/**/*.test.ts -Pattern 'describe\.skip|it\.skip'
```

```bash
grep -rn --include='*.test.ts' -E 'describe\.skip|it\.skip' src/tests
```

### How to run ONLY the skipped tests

vitest can't "run only skipped" directly (a skip is never executed), so run the
**files** that contain the skips and temporarily un-skip the cases you need, OR
run the whole file — the skipped cases stay skipped and the live cases run:

```powershell
# Run each file that harbours skipped cases (fast; skipped cases remain skipped)
npx vitest run src/tests/mycc-compose-shim-parse.test.ts src/tests/mycc-compose-peers.test.ts src/tests/mycc-compose-down.test.ts src/tests/mycc-compose-up-pipeline.test.ts
```

To actually EXERCISE a skipped case, flip `it.skip`/`describe.skip` → `it`/
`describe` locally (or `describe.skipIf(false)`), run the file, then flip it
back. Keep the un-skip LOCAL — do not commit it.

### Two hard rules for these suites

1. **Run them through the `bash` tool, redirecting output to a file** — e.g.
   `npx vitest run <files> > .mycc/tmp-test.txt 2>&1`. A foreground bash call
   is capped at **60s** and these suites spawn processes; piping vitest output
   through `Select-String`/`Select-Object` can hang the wrapper to the cap even
   when tests finish in seconds (leaked child handles). Redirect to a file and
   read the file. For the FULL suite use a background task (`bg_create`).
   > The repo's `test-after-edit` commit hook registers only a test run invoked
   > via the `bash` tool — a `bg_create` run is invisible to it and will leave
   > `git_commit` blocked. If the hook blocks you, run at least one (even
   > trimmed) `bash`-tool vitest run before committing.

2. **Never delete a skipped case to make CI green.** The convention is
   skip-not-delete: the coverage stays, the cost is deferred. Delete only
   genuinely obsolete cases, and only with the owner's sign-off.

### Why not just un-skip them all permanently

They spawn real processes and touch real OS surfaces (terminal openers, pid
liveness, sockets). On a headless/CI box those are flaky, and on a dev box they
add tens of seconds per run. Skipping keeps the default suite portable; the
manual run above is the deliberate opt-in when the covered code changes.

---

## Chore 3: Recurring Note-Template Friction Audit

### Background

The agent's behavior is steered as much by **injected prompt templates** as by
its own reasoning. Every system-generated message the agent sees is produced by
a `triologue.note(category, message, hookName?)` call, which stores it as a
`role:'user'` message prefixed `[<CATEGORY>] ` (`src/loop/triologue.ts`). These
templates are easy to write and easy to let rot: wording that grants **unearned
authorization to progress**, fabricated example literals copied verbatim,
failure notes with **no recovery contract**, and HINT notes that **repeat**
because nothing dedupes them.

Because the templates are prose and their failure mode is a slow behavioral
drift (not a crash), they must be **re-audited on a regular cadence**. This is a
recurring chore, not a one-off.

**Cadence:** re-run when the note layer is touched, and otherwise at least once
per major cycle (or before a release). The 2026-10-09 run found 34 frictions
across 28 templates — that is the baseline to improve against.

### Prerequisites

- A clean-ish working tree (audit is read-only; keep it that way).
- The current template inventory. Enumerate every callsite:

```powershell
# All note() callsites in src/ (excludes node_modules via the grep tool)
Select-String -Path src/**/*.ts -Pattern '\.note\(' | Where-Object { $_.Path -notmatch 'node_modules' }
```

```bash
grep -rn --include='*.ts' '\.note(' src | grep -v node_modules
```

Also read the category model and the hardcoded-prefix list (they are easy to
confuse with `note()` categories): `src/types.ts` → `NoteCategory` plus the
"Hardcoded content prefixes (NOT NoteCategory values)" comment block.

### Step 1 — Snapshot the catalogue

Produce a table of every template: `id · callsite file:line · NoteCategory ·
trigger condition · verbatim string`. Group by category (`REMINDER`, `HINT`,
`URGENT`, `SYSTEM`, `MAIL`). Keep this snapshot — the next audit diffs against
it, so **you only report NEW or CHANGED frictions** (never re-list a
steady-state known item; that is the same noise the audit exists to remove).

### Step 2 — Divide and conquer the review (team pattern)

This audit is a natural **divide-and-conquer** fit (`skills/coordination/pattern-divide-conquer.md`):
split the catalogue into 3 balanced groups and give each to one reviewer,
all in parallel, then synthesize.

- **Group A — REMINDER + URGENT** (nudges, steering, uploads, interrupts).
- **Group B — HINT** (confusion hint + skill-discovery hint; also review the
  trigger/filter mechanics, not just the strings).
- **Group C — SYSTEM + MAIL** (state notifications, failures, inter-agent mail).

Each reviewer writes a report to `.mycc/code-review/<date>-REVIEW-<X>.md` with,
per friction: **id, exact friction, file:line evidence, before/after rewrite,
severity**. Create an issues per group (blocked-by nothing), plus a synthesis
issue blocked by all three. Instruct reviewers: **review only, do NOT edit
source.**

### Step 3 — Judge against the six friction patterns

Classify each finding against the known patterns (evolved from the 2026-10-09
run — extend this list as new patterns emerge):

1. **P1 Silent merge** — *(historical; the merge was removed in 99ce493)* a
   note with no `hookName` used to fold into the last user message, destroying
   attribution. Kept as a named pattern to recognize regressions.
2. **P2 Directive welded to payload** — a control directive concatenated with
   unrelated content in one note.
3. **P3 Unearned authorization to progress** — wording that sanctions forward
   motion without re-orientation ("Proceed with your tasks", "Use tools to make
   progress", imperative "Update your todos").
4. **P4 Missing recovery contract** — a failure note that omits what the loop
   does next (retry/backoff/circuit-breaker→idle) and what to change.
5. **P5 WHO-acted ambiguity** — a SYSTEM note fusing a deterministic machine
   action with LLM-authored text, or presenting a self-initiated action passively.
6. **P6 Repetition engine** — no dedupe, or an analyzer blind to its own prior
   output, so the same hint re-fires.

### Step 4 — Verify each finding at source

Do not trust the catalogue blindly: open the cited `file:line` and confirm the
string and the trigger. Line numbers drift; re-grep. Reject a finding if the
friction is already handled elsewhere (record it in a "not-a-problem" section
with the reason — a clean template is a valid audit result).

### Step 5 — Synthesize the proposal

Write `.mycc/code-review/<date>-FIX-PROPOSAL.md`: a ranked friction table, the
cross-cutting patterns, and one `FIX-n` per fix with the **exact before/after
string, file:line, and a risk note**. Include an execution order that clears
HIGH severities first. **Proposal only — apply no edits in the audit run.**

### Verify

- Every `note()` callsite from Step 1 appears in the catalogue (no omissions).
- Every reported friction has a verified `file:line` and a before/after.
- The proposal is ranked and has an execution order.
- The report set is self-consistent: synthesis references only ids present in
  the three review reports.

### Rollback / Recovery

The audit is **read-only** by construction (reports are new files under
`.mycc/code-review/`; no source is edited). If a later implementation run goes
wrong, recover via `git` (`git status` / `git diff` / `git checkout -- <path>`)
— the audit artifacts themselves are throwaway and git-ignored. Keep the audit
and the implementation as **separate passes**: audit → user approval →
implement, so a bad fix never invalidates the findings.

---

## Chore 4: Reclaim Stale Discovery State (channel files + heartbeats)

### Background

`mycc-compose down` deletes **only** the channel files it can attribute to its
own name-identified peers, by exact filename (`<resolved-sid>-<label>.json`).
It never sweeps `~/.mycc-store/discovery/channels/`. That is deliberate: a
same-label collision must never let `down` delete a sibling topology group's
live files. The cost is that the **previous generation's files are never
reclaimed** — not even across `down`. Every `renew:always` restart leaves one
more permanent orphan (audit finding **AC-2**, confirmed by two independent
auditors).

Heartbeat files accumulate the same way. `~/.mycc-store/discovery/heartbeat/`
holds one file per session id ever seen, and each carries the peer's last few
**briefs**. Nothing prunes them; the `peer_list` tool merely *hides* entries
older than 1 hour, it does not delete them.

**The owner's decision (2026-10-20): keep `down` conservative — do NOT make it
sweep.** Reclamation is a manual chore instead, because it is low-frequency
and irreversible.

### Why Manual, Not Automated

1. **Deletion is irreversible and unattributable.** A channel file records who
   owns it, but "is anyone still using this?" cannot be answered from the file:
   a peer that is merely *sleeping* (laptop closed, daemon paused for a day)
   looks identical to a dead one to any age-based rule.
2. **Heartbeat files are the only surviving history of a finished peer.** The
   `briefs` array is what `peer_list` shows for that instance. Deleting the
   file deletes that record.
3. **The right window is a judgement call.** 7 days? 30? It depends on how long
   your daemons sleep. Hard-coding a default would eventually delete something
   alive.

### Prerequisites

- Know your discovery dir. It defaults to `~/.mycc-store/discovery` and is
  overridable with `MYCC_DISCOVERY_DIR` (the same variable the compose lib and
  the tests honour).
- Make sure the instances you care about are RUNNING (so their heartbeats are
  fresh and they are automatically excluded — see the liveness rule below).

### Liveness rule (do not weaken it)

A session id is **kept** if ANY of these hold; it is a candidate only when none
do:

| Guard | Why |
|---|---|
| present in `identity.json` | it is a registered instance — the authoritative registry |
| latest heartbeat newer than **1 hour** | live now (same cutoff as `peer_list`) |
| carries a `tombstone` | a stop was requested and the peer has not yet observed it — deleting the file would lose the stop request |
| latest heartbeat within your chosen `--days` window | stale-but-young; a sleeping daemon resumes here |

### Step 1 — Inspect (read-only, always safe)

```powershell
node scripts/mycc-compose/compose-cleanup-audit.js            # human table
node scripts/mycc-compose/compose-cleanup-audit.js --json     # machine-readable
node scripts/mycc-compose/compose-cleanup-audit.js --days 30  # a more conservative window
```

The script deletes **nothing**. It prints, per file, the verdict
(`KEEP` / `CANDIDATE` / `UNKNOWN`) and the reason, plus how many briefs a
heartbeat deletion would destroy.

Read the output. Two things to look for specifically:

- **`UNKNOWN`** — a filename that does not match `<sid>-<label>.json`, or a
  heartbeat file with no timestamps. Investigate by hand; do not bulk-delete.
- **`[newer sibling exists]`** — this is the AC-2 signature: an old generation
  of a label that has a live generation. These are the safest deletions.

### Step 2 — Back up the whole discovery dir

```powershell
$src = Join-Path $HOME '.mycc-store/discovery'
$dst = Join-Path $HOME ('.mycc-store/discovery-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Copy-Item $src $dst -Recurse
"backup at $dst"
```

Do not skip this. It is the rollback (Step 5) and costs kilobytes.

### Step 3 — Delete the CANDIDATEs only

Filter on the script's verdict, not on your own glob:

```powershell
$src = Join-Path $HOME '.mycc-store/discovery'
$report = node scripts/mycc-compose/compose-cleanup-audit.js --json | ConvertFrom-Json

$report.channels  | Where-Object verdict -eq 'CANDIDATE' |
  ForEach-Object { Remove-Item (Join-Path $src ('channels/'  + $_.file)) -Force -WhatIf }
$report.heartbeats | Where-Object verdict -eq 'CANDIDATE' |
  ForEach-Object { Remove-Item (Join-Path $src ('heartbeat/' + $_.file)) -Force -WhatIf }
```

`-WhatIf` prints what would be deleted without deleting. **Review that list
against Step 1's output, then re-run the same two commands without `-WhatIf`.**

> **已验证（2026-10-20）**：在真实 store 上跑这两段 `-WhatIf`，分别列出 21 个 channel 与 69 个 heartbeat 候选，且跑完后磁盘上的文件数**不变**（22 → 22，105 → 105）。
> 注意 `-WhatIf` 会把提示写到 **stderr**，所以 `... | Measure-Object` 数到的会是 `0` —— 那是正常的，用眼睛看列出的路径即可，不要据此判断"选了 0 个"。

> Never delete `identity.json`, and never delete a file the script reports as
> `KEEP`. If you find yourself typing a wildcard (`rm *.json`, `Remove-Item *`),
> stop — that is exactly the failure mode this chore exists to avoid.

### Step 4 — Verify

```powershell
node scripts/mycc-compose/compose-cleanup-audit.js
node scripts/mycc-compose/mycc-compose.js status <your-topology.json> --json
```

- The audit script should now report `0` candidates (or fewer, never more).
- `status --json` must be unchanged for every **live** group — if a live
  group's `attribution` flipped from `present` to `absent`, you deleted
  something in use: go to Step 5 immediately.

### Step 5 — Rollback

Move the backup back:

```powershell
Remove-Item (Join-Path $HOME '.mycc-store/discovery') -Recurse -Force
Copy-Item (Join-Path $HOME '.mycc-store/discovery-backup-<timestamp>') (Join-Path $HOME '.mycc-store/discovery') -Recurse
```

### Do NOT do this as part of a code change

Reclamation must not be smuggled into `cmd-down.ts` "while we're here". AC-2
stays open on purpose: making `down` sweep would silently reintroduce the
sibling-group deletion that AC-5 fixed. If it is ever automated, it belongs in
a separate, explicitly-invoked command with this exact liveness rule.

---

## Adding New Chores

When a new high-risk, low-frequency maintenance task is identified, document
it here as a new `## Chore N: <title>` section following the same shape:
background → prerequisites → numbered manual steps → verify → rollback.
Resist the temptation to automate it into a slash command; the manual flow
with an inspectable intermediate file is the safety mechanism.