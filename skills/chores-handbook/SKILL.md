---
name: chores-handbook
description: >
  Reference guide for infrequent, high-risk maintenance chores on the mycc
  knowledge base (wiki/RAG) that should be performed MANUALLY rather than
  automated. Currently covers: migrating legacy WAL entries to the current
  embedding-model namespace (export → string-replace → import). Use when the
  user switches embedding models (e.g. nomic-embed-text → embeddinggemma, or to
  a different non-nomic model), when WAL entries predate the rag-provider
  abstraction (no "namespace" field), or when the user asks how to migrate /
  re-stamp / re-namespace wiki data. Do NOT automate these chores — always
  present the manual steps so the user stays in control of the data mutation.
keywords: [wiki, WAL, migrate, namespace, embedding, model switch, chores, maintenance, export, import, rag, re-namespace]
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

## Adding New Chores

When a new high-risk, low-frequency maintenance task is identified, document
it here as a new `## Chore N: <title>` section following the same shape:
background → prerequisites → numbered manual steps → verify → rollback.
Resist the temptation to automate it into a slash command; the manual flow
with an inspectable intermediate file is the safety mechanism.