---
name: clear-sessions
description: >
  Use when sessions fail to load, restore, or when cleaning up corrupted or
  outdated session data. Covers diagnosing and fixing five corruption types:
  empty session files, malformed JSON, missing triologue files, empty (0-byte)
  triologue files, and orphaned triologue files. Also covers user-level session
  cleanup (~/.mycc-store/sessions/), selective cleanup, full session reset with
  backup, and recovery from backup. Includes diagnostic commands for session
  integrity checks and storage stats. Use for troubleshooting session corruption,
  stale session data, session restore failures, cleaning up disk space from old
  sessions, and resetting session state after major changes.
keywords: [session, cleanup, troubleshooting, corruption, restore, recovery, diagnostic, triologue, reset, stale, backup, repair]
---

# Clearing Corrupted or Outdated Sessions

> **This is a progressive-disclosure skill.** This entry file holds the
> session architecture, the corruption-type summary, and the final
> verification checklist; the detailed detection scripts, cleanup
> procedures, and recovery/diagnostics are split into sibling files in this
> folder. `read_file` the referenced file that matches the corruption type
> or operation you need.
>
> Sibling references in this skill:
> - `corruption-types.md` — The 5 corruption types in detail (empty session
>   files, malformed JSON, missing triologue, empty 0-byte triologue,
>   orphaned triologue), each with its detection script and symptoms.
> - `cleanup-procedures.md` — Quick fix (remove empty triologues), full
>   session reset with backup, selective cleanup (missing triologue / invalid
>   JSON / orphaned), user-level session cleanup.
> - `recovery-and-diagnostics.md` — Restore from backup, rebuild session from
>   triologue, fix minor corruption, session integrity check script, summary
>   stats script, common issues & solutions table.

This guide explains how to identify and clean up corrupted or outdated
session data in mycc.

## Session Architecture

A **session** consists of all files inside a session directory:

| Component | Location | Format | Purpose |
|-----------|----------|--------|---------|
| **Session file** | `.mycc/sessions/<uuid>/session-<uuid>.json` | JSON | Metadata: UUID, timestamps, triologue path, teammates, first query |
| **Triologue** | `.mycc/sessions/<uuid>/triologue-<role>-<ts>.jsonl` | JSONL (append-only) | The three-way conversation log (user ↔ assistant ↔ tool) |
| **Transcript** | `.mycc/sessions/<uuid>/transcript-<role>-<ts>.jsonl` | JSONL | Auto-compacted conversation summaries |
| **Mail (unread)** | `.mycc/sessions/<uuid>/unread-<owner>-<ts>.jsonl` | JSONL | Incoming mailbox messages |
| **Mail (read)** | `.mycc/sessions/<uuid>/readmail-<owner>-<ts>.jsonl` | JSONL | Read mailbox backlog |

All files for a session live in a single subdirectory under
`.mycc/sessions/<session-id>/`. User-level sessions in
`~/.mycc-store/sessions/` follow the same directory structure.

No SQLite database is used — session storage is purely file-based (JSON +
JSONL).

## Types of Corruption (summary)

| # | Type | Symptom | Detection / Fix |
|---|------|---------|-----------------|
| 1 | Empty session files | Session created but never used (no `first_query`); normal but accumulates | `corruption-types.md` §1; cleanup in `cleanup-procedures.md` |
| 2 | Malformed JSON | Session file has incomplete/corrupted JSON; "Session not found" but file exists | `corruption-types.md` §2; selective cleanup in `cleanup-procedures.md` |
| 3 | Missing triologue files | Session references a non-existent triologue; restore fails with "missing files" | `corruption-types.md` §3; selective cleanup in `cleanup-procedures.md` |
| 4 | Empty (0-byte) triologue files | Triologue created but never written to; interrupted session starts | `corruption-types.md` §4; quick fix in `cleanup-procedures.md` |
| 5 | Orphaned triologue files | Triologue not referenced by any session | `corruption-types.md` §5; selective cleanup in `cleanup-procedures.md` |

> **Full detection scripts for each type:** see `corruption-types.md`.
> **How to remove each type:** see `cleanup-procedures.md`.

## Prevention

1. **Clean shutdowns** — Always exit cleanly (Ctrl+C or empty Enter at
   prompt) to allow triologue files to finalize.
2. **Regular cleanup** — Empty sessions with no `first_query` are normal;
   clean them periodically.
3. **Backup before risky operations** — `tar -czf /tmp/mycc-backup.tar.gz
   .mycc/`
4. **No database concerns** — Since there is no SQLite, there are no WAL
   files, locks, or table corruption to worry about.

## Verification After Cleanup

```bash
echo "=== Final Status ==="
echo "Session dirs: $(ls -d .mycc/sessions/*/ 2>/dev/null | wc -l)"
echo "Session files: $(ls .mycc/sessions/*/session-*.json 2>/dev/null | wc -l)"
echo "Triologue files: $(find .mycc/sessions -name 'triologue-*.jsonl' 2>/dev/null | wc -l)"
echo "Empty triologues: $(find .mycc/sessions -name 'triologue-*.jsonl' -size 0 2>/dev/null | wc -l)"
echo "Mail files: $(find .mycc/sessions -name 'unread-*.jsonl' -o -name 'readmail-*.jsonl' 2>/dev/null | wc -l)"
```

All sessions should have valid JSON and existing, non-empty triologue
files.

> **Full integrity check and summary stats scripts:** see
> `recovery-and-diagnostics.md`.

## Checklist

- [ ] Identified type of corruption (see `corruption-types.md`)
- [ ] Backed up important sessions before deleting
- [ ] Removed corrupted session directories (see `cleanup-procedures.md`)
- [ ] Removed 0-byte triologue files
- [ ] Cleaned up orphaned triologues
- [ ] Cleared stale mail files
- [ ] Verified remaining sessions load correctly
- [ ] If recovery needed, restored from backup or rebuilt (see
      `recovery-and-diagnostics.md`)