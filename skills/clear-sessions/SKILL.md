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

This guide explains how to identify and clean up corrupted or outdated session data in mycc.

## Session Architecture

A **session** consists of all files inside a session directory:

| Component | Location | Format | Purpose |
|-----------|----------|--------|---------|
| **Session file** | `.mycc/sessions/<uuid>/session-<uuid>.json` | JSON | Metadata: UUID, timestamps, triologue path, teammates, first query |
| **Triologue** | `.mycc/sessions/<uuid>/triologue-<role>-<ts>.jsonl` | JSONL (append-only) | The three-way conversation log (user ↔ assistant ↔ tool) |
| **Transcript** | `.mycc/sessions/<uuid>/transcript-<role>-<ts>.jsonl` | JSONL | Auto-compacted conversation summaries |
| **Mail (unread)** | `.mycc/sessions/<uuid>/unread-<owner>-<ts>.jsonl` | JSONL | Incoming mailbox messages |
| **Mail (read)** | `.mycc/sessions/<uuid>/readmail-<owner>-<ts>.jsonl` | JSONL | Read mailbox backlog |

All files for a session live in a single subdirectory under `.mycc/sessions/<session-id>/`.

User-level sessions in `~/.mycc-store/sessions/` follow the same directory structure.

No SQLite database is used — session storage is purely file-based (JSON + JSONL).

## Types of Corruption

### 1. Empty Session Files

Sessions created but never used (no `first_query`). These are normal but accumulate.

```bash
# Find sessions with empty first_query
for d in .mycc/sessions/*/; do
  f="${d}session-*.json"
  # Use ls to get the actual file (there should be one)
  json_file=$(ls "$f" 2>/dev/null | head -1)
  [ -z "$json_file" ] && continue
  if ! grep -q '"first_query"' "$json_file" 2>/dev/null || grep -q '"first_query": ""' "$json_file" 2>/dev/null; then
    echo "Empty: $json_file"
  fi
done
```

### 2. Malformed JSON

Session files with incomplete or corrupted JSON content.

```bash
# Validate all session JSON files
for f in .mycc/sessions/*/session-*.json; do
  if ! python3 -c "import json; json.load(open('$f'))" 2>/dev/null; then
    echo "Invalid JSON: $f"
  fi
done
```

### 3. Missing Triologue Files

Sessions referencing non-existent triologue files.

```bash
# Check for missing triologue references
for f in .mycc/sessions/*/session-*.json; do
  lead=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('lead_triologue',''))" 2>/dev/null)
  if [ -n "$lead" ] && [ ! -f "$lead" ]; then
    echo "Missing triologue in $f: $lead"
  fi
done
```

### 4. Empty (0-byte) Triologue Files

Triologue files created but never written to — indicates interrupted session starts.

```bash
# Find and count empty triologue files
echo "Total: $(find .mycc/sessions -name 'triologue-*.jsonl' 2>/dev/null | wc -l)"
echo "Empty: $(find .mycc/sessions -name 'triologue-*.jsonl' -size 0 | wc -l)"

# Find sessions referencing empty triologues
for f in .mycc/sessions/*/session-*.json; do
  lead=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('lead_triologue',''))" 2>/dev/null)
  if [ -n "$lead" ] && [ -f "$lead" ] && [ ! -s "$lead" ]; then
    echo "Session $f has empty triologue: $lead"
  fi
done
```

### 5. Orphaned Triologue Files

Triologue files not referenced by any session.

```bash
# Find orphaned triologues
for t in .mycc/sessions/*/triologue-*.jsonl; do
  basename=$(basename "$t")
  if ! grep -rq "$basename" .mycc/sessions/*/session-*.json 2>/dev/null; then
    echo "Orphaned: $t"
  fi
done
```

## Cleanup Procedures

### Quick Fix: Remove Empty Triologues

The most common cleanup — remove 0-byte triologue files:

```bash
find .mycc/sessions -name "triologue-*.jsonl" -size 0 -delete
echo "Remaining empty: $(find .mycc/sessions -name 'triologue-*.jsonl' -size 0 | wc -l)"
```

### Full Session Reset

When starting fresh or after major corruption:

```bash
# 1. Backup existing sessions
tar -czf /tmp/mycc-sessions-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
  .mycc/sessions 2>/dev/null

# 2. Clear all session directories
rm -rf .mycc/sessions/*/

# 3. Prune stale worktree metadata (no JSON file to reset)
git worktree prune
```

Note: the current session's triologue is actively being written and will not be deleted by `rm`.

### Selective Cleanup

Remove only corrupted sessions:

```bash
# 1. Remove sessions with missing triologues
for d in .mycc/sessions/*/; do
  f=$(ls "${d}session-*.json" 2>/dev/null | head -1)
  [ -z "$f" ] && continue
  lead=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('lead_triologue',''))" 2>/dev/null)
  if [ -n "$lead" ] && [ ! -f "$lead" ]; then
    echo "Removing session dir: $d"
    rm -rf "$d"
  fi
done

# 2. Remove invalid JSON session files
for f in .mycc/sessions/*/session-*.json; do
  if ! python3 -c "import json; json.load(open('$f'))" 2>/dev/null; then
    echo "Removing invalid JSON session dir: $(dirname "$f")"
    rm -rf "$(dirname "$f")"
  fi
done

# 3. Remove orphaned triologues
for t in .mycc/sessions/*/triologue-*.jsonl; do
  basename=$(basename "$t")
  if ! grep -rq "$basename" .mycc/sessions/*/session-*.json 2>/dev/null; then
    echo "Removing orphaned: $t"
    rm "$t"
  fi
done
```

### User Sessions Cleanup

User-level sessions in `~/.mycc-store/sessions/` may also need cleanup:

```bash
# List user sessions
ls -la ~/.mycc-store/sessions/

# Clear all user sessions
rm -rf ~/.mycc-store/sessions/*/

# Or validate and remove corrupted
for d in ~/.mycc-store/sessions/*/; do
  f=$(ls "${d}session-*.json" 2>/dev/null | head -1)
  [ -z "$f" ] && continue
  if ! python3 -c "import json; json.load(open('$f'))" 2>/dev/null; then
    echo "Removing invalid user session: $d"
    rm -rf "$d"
  fi
done
```

## Recovery Procedures

### Restore from Backup

```bash
tar -xzf /tmp/mycc-sessions-backup-YYYYMMDD.tar.gz
# The backup contains .mycc/sessions/ directories
```

### Rebuild Session from Triologue

If the triologue exists but session metadata is lost:

```bash
mkdir -p .mycc/sessions/<new-uuid>
cat > .mycc/sessions/<new-uuid>/session-<new-uuid>.json << 'EOF'
{
  "version": "2.0",
  "id": "<new-uuid>",
  "create_time": "2026-01-01T00:00:00Z",
  "project_dir": "/path/to/project",
  "lead_triologue": "/path/to/.mycc/sessions/<new-uuid>/triologue-lead-20260624T000000Z.jsonl",
  "child_triologues": [],
  "teammates": [],
  "first_query": "Recovered session"
}
EOF
```

### Fix Minor Session File Corruption

```bash
# View content
python3 -c "import json; print(json.dumps(json.load(open('.mycc/sessions/UUID/session-UUID.json')), indent=2))"

# Fix by creating a minimal replacement
# (use the triologue path from the original if still readable)
```

## Diagnostic Commands

### Session Integrity Check

```bash
echo "=== Session Integrity ==="
for f in .mycc/sessions/*/session-*.json; do
  [ -f "$f" ] || continue
  id=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('id','unknown'))" 2>/dev/null)
  lead=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('lead_triologue',''))" 2>/dev/null)
  
  echo -n "Session $id: "
  if [ -z "$lead" ]; then
    echo "MISSING lead_triologue field"
  elif [ ! -f "$lead" ]; then
    echo "MISSING triologue file: $lead"
  elif [ ! -s "$lead" ]; then
    echo "EMPTY triologue: $lead"
  else
    echo "OK"
  fi
done
```

### Summary Stats

```bash
echo "=== Storage Stats ==="
echo "Session dirs: $(ls -d .mycc/sessions/*/ 2>/dev/null | wc -l)"
echo "Session files: $(ls .mycc/sessions/*/session-*.json 2>/dev/null | wc -l)"
echo "Triologue files: $(find .mycc/sessions -name 'triologue-*.jsonl' 2>/dev/null | wc -l)"
echo "Empty triologues: $(find .mycc/sessions -name 'triologue-*.jsonl' -size 0 2>/dev/null | wc -l)"
echo "Mail files: $(find .mycc/sessions -name 'unread-*.jsonl' -o -name 'readmail-*.jsonl' 2>/dev/null | wc -l)"
echo "User sessions: $(ls -d ~/.mycc-store/sessions/*/ 2>/dev/null | wc -l)"
```

## Common Issues and Solutions

### Issue: "Session not found" but file exists

**Cause:** JSON parsing failed silently (malformed or incomplete file).

**Solution:**
```bash
python3 -c "import json; json.load(open('.mycc/sessions/UUID/session-UUID.json'))"
# If it fails, remove the directory: rm -rf .mycc/sessions/UUID
```

### Issue: Session restore fails with "missing files"

**Cause:** Triologue file deleted or moved.

**Solution:**
```bash
# Remove the session directory referencing the missing triologue
rm -rf .mycc/sessions/UUID
```

### Issue: User session shadows project session

**Cause:** A session saved to user dir (`~/.mycc-store/sessions/`) takes precedence over the project-level session with the same UUID.

**Solution:**
```bash
# Remove user session to fall back to project session
rm -rf ~/.mycc-store/sessions/UUID
```

## Prevention

1. **Clean shutdowns** — Always exit cleanly (Ctrl+C or empty Enter at prompt) to allow triologue files to finalize.
2. **Regular cleanup** — Empty sessions with no `first_query` are normal; clean them periodically.
3. **Backup before risky operations** — `tar -czf /tmp/mycc-backup.tar.gz .mycc/`
4. **No database concerns** — Since there is no SQLite, there are no WAL files, locks, or table corruption to worry about.

## Verification After Cleanup

```bash
echo "=== Final Status ==="
echo "Session dirs: $(ls -d .mycc/sessions/*/ 2>/dev/null | wc -l)"
echo "Session files: $(ls .mycc/sessions/*/session-*.json 2>/dev/null | wc -l)"
echo "Triologue files: $(find .mycc/sessions -name 'triologue-*.jsonl' 2>/dev/null | wc -l)"
echo "Empty triologues: $(find .mycc/sessions -name 'triologue-*.jsonl' -size 0 2>/dev/null | wc -l)"
echo "Mail files: $(find .mycc/sessions -name 'unread-*.jsonl' -o -name 'readmail-*.jsonl' 2>/dev/null | wc -l)"
```

All sessions should have valid JSON and existing, non-empty triologue files.

## Checklist

- [ ] Identified type of corruption
- [ ] Backed up important sessions before deleting
- [ ] Removed corrupted session directories
- [ ] Removed 0-byte triologue files
- [ ] Cleaned up orphaned triologues
- [ ] Cleared stale mail files
- [ ] Verified remaining sessions load correctly
