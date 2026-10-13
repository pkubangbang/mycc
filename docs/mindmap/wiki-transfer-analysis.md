# Wiki Database Transfer — Integrity Analysis (Path B)

> **Status**: The integrity fixes proposed in this analysis have been implemented in `src/slashes/wiki.ts`. Layer A (file-level manifest with `content_sha256`), Layer B (per-entry hash verification via `verifyEntryHash()`), and Layer C (surfacing `put()` results) are all shipped. The export format version was bumped to `1.1` to carry the manifest.

## 1. The Integrity Gap (current state)

The export/import path (`/wiki export`, `/wiki import`) has **no integrity verification** at any of three layers where corruption could enter. A corrupted or tampered export JSON will silently pollute the target wiki database, and the import summary will *report success* for entries that were actually rejected.

### Layer 1 — File-level: no manifest / checksum

`handleExport` (slashes/wiki.ts) writes a `WikiExportData` JSON with fields `version`, `exported_at`, `project_dir`, `domains`, `entries`. There is **no checksum field** — nothing ties the bytes on disk to what was written. If the file is truncated, bit-flipped, or maliciously edited in transit, nothing detects it. `handleImport` reads the file, `JSON.parse`s it, and checks only:
```ts
if (!data.version || !Array.isArray(data.entries)) { ... 'Invalid export file' ... }
if (!Array.isArray(data.domains)) { data.domains = []; }
```
That is shape validation, not integrity validation. A structurally-valid but content-corrupted file passes.

### Layer 2 — Entry-level: per-entry hash exists but is not verified on import

Each `WALEntry` carries a `hash` field (16 hex chars = first 16 of `sha256("${domain}:${title}:${content}")`, per `wiki.ts:80-82`). This hash is the document's content-address. **The export includes this hash; the import never verifies it.**

The import loop (slashes/wiki.ts `handleImport`):
```ts
for (const entry of data.entries) {
  if (!entry.hash || !entry.document) continue;          // shape check only
  if (entry.deleted) { deletedSkipped++; continue; }
  if (entry.approved === false) { skipped++; continue; }
  try {
    await wiki.put(entry.hash, entry.document);          // <-- hash passed through
    imported++;
  } catch {
    skipped++;
  }
}
```

Crucially, `wiki.put()` (`wiki.ts:207-212`) **does** verify the hash and returns `{ success: false, error: 'Hash mismatch' }` — but **it returns, it does not throw**. The import loop discards the return value and unconditionally increments `imported++` unless `put` throws (which only happens on LanceDB/embedding errors, not on hash/domain/length validation failures). So:

- A tampered entry whose `hash` no longer matches its `document` → `put` returns `{success:false}`, import counts it as `imported++`. **Silent pollution of the success counter.**
- An entry with a domain that doesn't exist on the target → `put` returns `{success:false, error:'Unknown domain'}`, import counts `imported++`.
- An entry whose content is too short/long → `put` returns `{success:false}`, import counts `imported++`.

In all three cases the entry is **not** written to LanceDB (put short-circuits before `table.add`), so the DB itself is not polluted — but the WAL is not written either, and the user is told the import succeeded. The user has no way to know which entries actually landed.

### Layer 3 — Content validation: `put` enforces, but `import` doesn't pre-check

`put()` validates domain registration, content length (50–1000 chars), and hash. But import calls `put` directly without calling `prepare()`, so the duplicate-detection embedding check (the `DUPLICATE_THRESHOLD = 0.95` guard) is **bypassed** on import. An export from machine A could contain a document near-duplicate of one already on machine B; import would insert it because `put` only checks hash equality, not embedding similarity. This is a subtler pollution: not corruption, but loss of the de-duplication invariant.

---

## 2. Threat Model — How a Corrupted JSON Pollutes the DB

| Corruption type | Detected today? | Effect on target DB |
|---|---|---|
| File truncated / invalid JSON | ✅ `JSON.parse` throws → import aborts | None — safe |
| Valid JSON, `entries` array shape ok, but an entry's `document.content` was edited | ❌ Not detected | `put` returns `success:false` (hash mismatch), entry NOT written to LanceDB/WAL. Import reports `imported++` — **false success** |
| Entry's `hash` field edited to match tampered content | ❌ Not detected (attacker who can edit content can recompute hash) | Entry **IS** written to LanceDB + WAL — **real pollution** |
| Entry's `domain` references a domain not in `domains` array and not registered on target | ❌ Not detected upfront | `put` returns `success:false`, entry not written. Import reports `imported++` |
| Entry with content length outside 50–1000 | ❌ Not detected upfront | `put` returns `success:false`. Import reports `imported++` |
| Near-duplicate of existing target entry (embedding sim > 0.95) | ❌ Import bypasses `prepare()` | Entry written — **de-dup invariant violated** |
| `domains` array tampered (e.g. a domain renamed) | ❌ Not detected | Domain re-registered under tampered name; entries for the *real* domain name then fail `put` silently |

The dangerous case is row 3: an attacker (or bit-flip that happens to keep hash valid) can inject arbitrary content into the wiki, and there is no after-the-fact way to detect it because the WAL entry written by `put` looks legitimate (it carries the target's own namespace and a fresh timestamp).

---

## 3. Proposal — Three-Layer Integrity for Path B

The goal: **a corrupted export JSON must never silently pollute the wiki DB, and the import summary must report what actually happened.** No new dependencies; all primitives (`crypto.createHash`, `generateHash` scheme) already exist.

### Layer A — File-level manifest (detect transit corruption / truncation)

Add a top-level `manifest` field to `WikiExportData`:
```ts
interface WikiExportData {
  version: '1.1';                      // bump from 1.0
  exported_at: string;
  project_dir: string;
  domains: WikiDomain[];
  entries: WALEntry[];
  manifest: {                          // NEW
    entry_count: number;
    content_sha256: string;            // sha256 of canonical JSON of entries+domains
  };
}
```
- **Export**: compute `content_sha256 = sha256(JSON.stringify({domains, entries}))` and store it.
- **Import**: recompute and compare. If mismatch → abort import entirely, print the expected vs actual hash, do not touch the DB. This catches truncation, reordering, and any byte-level corruption that changes content.

Backward compat: if `manifest` is absent (importing a v1.0 file), import proceeds but prints a warning that integrity is unverified.

### Layer B — Per-entry hash verification (detect content tampering)

In `handleImport`, before calling `put`, recompute the entry hash and compare to `entry.hash`:
```ts
// mirror wiki.ts generateHash (or expose it)
function verifyEntryHash(entry: WALEntry): boolean {
  const content = `${entry.document.domain}:${entry.document.title}:${entry.document.content}`;
  const expected = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  return expected === entry.hash;
}
```
- Mismatch → increment a `hashMismatch` counter, **skip the entry** (do not call `put`), and collect the offending hashes for the summary.
- This does NOT stop a determined attacker who edits content *and* recomputes the hash — that's what Layer A's manifest is for (the manifest hash covers the entries array; changing an entry's hash field changes the manifest). Layer B catches accidental corruption of content while leaving the hash field intact, which is the common case.

### Layer C — Surface `put()` results (fix the false-success bug)

The import loop must read the `PutResult` returned by `put()`:
```ts
const result = await wiki.put(entry.hash, entry.document);
if (result.success) {
  imported++;
} else {
  putFailed++;
  putErrors.push({ hash: entry.hash, error: result.error });
}
```
And print a breakdown:
```
Import complete: 42 imported, 3 hash mismatch (skipped), 2 put failed (see below), 0 deleted entries ignored, 1 domains added
  put failures:
    - a1b2...: Unknown domain "foo"
    - c3d4...: Content too long (maximum 1000 characters)
```

This is the single most important fix — it turns silent miscounting into honest reporting, and it requires no schema change.

### Optional Layer D — Restore duplicate detection on import

Currently import calls `put` (hash-equality only), bypassing `prepare()`'s embedding-similarity duplicate check. To preserve the de-dup invariant, import could call `prepare()` first and only `put` if `prepare` returns `accepted: true`. Cost: one extra embedding generation per entry (the same cost `put` already pays). This is a behavioral choice — strict (reject near-dups) vs permissive (allow near-dups from the source machine). Recommend making it strict by default with a `--allow-duplicates` flag, since the whole point of transfer is to merge two knowledge bases cleanly.

---

## 4. Files Changed (shipped)

| File | Change | Status |
|---|---|---|
| `src/slashes/wiki.ts` | `handleExport`: add `manifest` to `WikiExportData`; `handleImport`: verify manifest (abort on mismatch), verify per-entry hash (`verifyEntryHash()`), read `put()` return value, print honest breakdown | ✅ Implemented |
| `src/slashes/wiki.ts` | `WikiExportManifest` interface, `computeManifestHash()`, `verifyEntryHash()` functions | ✅ Implemented |
| No change to `src/context/parent/wiki.ts` | `put()` already returns `PutResult` correctly — the bug was purely in the caller | ✅ Confirmed |

No changes to the database layer, WAL format, or LanceDB. The fix is localized to the import/export slash command.

---

## 5. Before / After

| | Before | After |
|---|---|---|
| Truncated/corrupted file | `JSON.parse` may throw (caught) OR silently import partial data | Manifest mismatch → abort with expected/actual hash, DB untouched |
| Entry content tampered, hash field untouched | Import counts as `imported++`, entry silently dropped by `put` | Hash-mismatch counter, entry skipped, reported in summary |
| Entry content + hash both tampered | **Silently written to DB** | Manifest mismatch (covers entries array) → abort before any `put` |
| `put` fails (unknown domain, length) | Counts as `imported++` | Counts as `putFailed`, error message listed |
| Near-duplicate of existing target entry | Written (duplicate-check bypassed) | Optional: rejected by `prepare()` unless `--allow-duplicates` |

## 6. Assumption

The manifest hash is computed over the canonical JSON of `{domains, entries}`. "Canonical" means deterministic key ordering — `JSON.stringify` of a rebuilt object (not the raw file bytes, which would be fragile to whitespace). This means a re-serialized but content-identical file still passes verification. This is the right tradeoff: we want to detect *content* corruption, not formatting drift.

## 7. Open Decision (resolved)

Layer D (restore duplicate detection via `prepare()`) was **not implemented**. Import calls `put()` directly (hash-equality only), bypassing `prepare()`'s embedding-similarity duplicate check. This remains a known limitation: an export from machine A could contain a near-duplicate of one already on machine B, and import would insert it. A future `--allow-duplicates` flag could add `prepare()` pre-checking if needed.