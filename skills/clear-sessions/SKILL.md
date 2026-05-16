---
name: clear-sessions
description: "Guide for clearing corrupted or outdated sessions. Use when sessions fail to load, restore, or when cleaning up stale session data."
tags: [session, cleanup, troubleshooting, corruption]
---

# Clearing Corrupted or Outdated Sessions

This guide explains how to identify and clean up corrupted or outdated session data in mycc.

## Session Architecture

A **session** consists of three parts:

| Component | Location | Format | Purpose |
|-----------|----------|--------|---------|
| **Session file** | `.mycc/sessions/<uuid>.json` | JSON | Metadata: UUID, timestamps, triologue path, teammates, first query |
| **Triologue** | `.mycc/transcripts/<role>-<ts>-triologue.jsonl` | JSONL (append-only) | The three-way conversation log (user ↔ assistant ↔ tool) |
| **Transcript** | (same as triologue) | — | Alias for the triologue file |

All three together form a complete session. The session JSON references its triologue via the `lead_triologue` field (absolute path).

User-level sessions in `~/.mycc-store/sessions/` follow the same structure.

No SQLite database is used — session storage is purely file-based (JSON + JSONL).

## Types of Corruption

### 1. Empty Session Files

Sessions created but never used (no `first_query`). These are normal but accumulate.

```bash
# Find sessions with empty first_query
for f in .mycc/sessions/*.json; do
  if ! grep -q '"first_query"' "$f" 2>/dev/null || grep -q '"first_query": ""' "$f" 2>/dev/null; then
    echo "Empty: $f"
  fi
done
```

### 2. Malformed JSON

Session files with incomplete or corrupted JSON content.

```bash
# Validate all session JSON files
for f in .mycc/sessions/*.json; do
  if ! python3 -c "import json; json.load(open('$f'))" 2>/dev/null; then
    echo "Invalid JSON: $f"
  fi
done
```

### 3. Missing Triologue Files

Sessions referencing non-existent triologue files.

```bash
# Check for missing triologue references
for f in .mycc/sessions/*.json; do
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
echo "Total: $(ls .mycc/transcripts/*.jsonl 2>/dev/null | wc -l)"
echo "Empty: $(find .mycc/transcripts -name '*.jsonl' -size 0 | wc -l)"

# Find sessions referencing empty triologues
for f in .mycc/sessions/*.json; do
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
for t in .mycc/transcripts/*.jsonl; do
  basename=$(basename "$t")
  if ! grep -rq "$basename" .mycc/sessions/ 2>/dev/null; then
    echo "Orphaned: $t"
  fi
done
```

## Cleanup Procedures

### Quick Fix: Remove Empty Triologues

The most common cleanup — remove 0-byte triologue files:

```bash
find .mycc/transcripts -name "*.jsonl" -size 0 -delete
echo "Remaining empty: $(find .mycc/transcripts -name '*.jsonl' -size 0 | wc -l)"
```

### Full Session Reset

When starting fresh or after major corruption:

```bash
# 1. Backup existing sessions
tar -czf /tmp/mycc-sessions-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
  .mycc/sessions .mycc/transcripts .mycc/mail 2>/dev/null

# 2. Clear all session files
rm -f .mycc/sessions/*.json

# 3. Clear all triologue files
rm -f .mycc/transcripts/*.jsonl

# 4. Clear mail files
rm -f .mycc/mail/*.jsonl

# 5. Reset worktrees
echo '[]' > .mycc/worktrees.json
```

Note: the current session's triologue is actively being written and will not be deleted by `rm`.

### Selective Cleanup

Remove only corrupted sessions:

```bash
# 1. Remove sessions with missing triologues
for f in .mycc/sessions/*.json; do
  lead=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('lead_triologue',''))" 2>/dev/null)
  if [ -n "$lead" ] && [ ! -f "$lead" ]; then
    echo "Removing: $f"
    rm "$f"
  fi
done

# 2. Remove invalid JSON session files
for f in .mycc/sessions/*.json; do
  if ! python3 -c "import json; json.load(open('$f'))" 2>/dev/null; then
    echo "Removing invalid JSON: $f"
    rm "$f"
  fi
done

# 3. Remove orphaned triologues
for t in .mycc/transcripts/*.jsonl; do
  basename=$(basename "$t")
  if ! grep -rq "$basename" .mycc/sessions/ 2>/dev/null; then
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
rm -f ~/.mycc-store/sessions/*.json

# Or validate and remove corrupted
for f in ~/.mycc-store/sessions/*.json; do
  if ! python3 -c "import json; json.load(open('$f'))" 2>/dev/null; then
    echo "Removing invalid user session: $f"
    rm "$f"
  fi
done
```

## Recovery Procedures

### Restore from Backup

```bash
tar -xzf /tmp/mycc-sessions-backup-YYYYMMDD.tar.gz
cp sessions-backup/*.json .mycc/sessions/
```

### Rebuild Session from Triologue

If the triologue exists but session metadata is lost:

```bash
cat > .mycc/sessions/<new-uuid>.json << 'EOF'
{
  "version": "1.0",
  "id": "<new-uuid>",
  "create_time": "2026-01-01T00:00:00Z",
  "project_dir": "/path/to/project",
  "lead_triologue": "/path/to/.mycc/transcripts/lead-XXXXXXX-triologue.jsonl",
  "child_triologues": [],
  "teammates": [],
  "first_query": "Recovered session"
}
EOF
```

### Fix Minor Session File Corruption

```bash
# View content
python3 -c "import json; print(json.dumps(json.load(open('.mycc/sessions/UUID.json')), indent=2))"

# Fix by creating a minimal replacement
# (use the triologue path from the original if still readable)
```

## Diagnostic Commands

### Session Integrity Check

```bash
echo "=== Session Integrity ==="
for f in .mycc/sessions/*.json; do
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
echo "Session files: $(ls .mycc/sessions/*.json 2>/dev/null | wc -l)"
echo "Triologue files: $(ls .mycc/transcripts/*.jsonl 2>/dev/null | wc -l)"
echo "Empty triologues: $(find .mycc/transcripts -name '*.jsonl' -size 0 2>/dev/null | wc -l)"
echo "Mail files: $(ls .mycc/mail/*.jsonl 2>/dev/null | wc -l)"
echo "User sessions: $(ls ~/.mycc-store/sessions/*.json 2>/dev/null | wc -l)"
```

## Common Issues and Solutions

### Issue: "Session not found" but file exists

**Cause:** JSON parsing failed silently (malformed or incomplete file).

**Solution:**
```bash
python3 -c "import json; json.load(open('.mycc/sessions/UUID.json'))"
# If it fails, remove the file: rm .mycc/sessions/UUID.json
```

### Issue: Session restore fails with "missing files"

**Cause:** Triologue file deleted or moved.

**Solution:**
```bash
# Remove the session referencing the missing triologue
rm .mycc/sessions/UUID.json
```

### Issue: User session shadows project session

**Cause:** A session saved to user dir (`~/.mycc-store/sessions/`) takes precedence over the project-level session with the same UUID.

**Solution:**
```bash
# Remove user session to fall back to project session
rm ~/.mycc-store/sessions/UUID.json
```

## Prevention

1. **Clean shutdowns** — Always exit cleanly (Ctrl+C or empty Enter at prompt) to allow triologue files to finalize.
2. **Regular cleanup** — Empty sessions with no `first_query` are normal; clean them periodically.
3. **Backup before risky operations** — `tar -czf /tmp/mycc-backup.tar.gz .mycc/`
4. **No database concerns** — Since there is no SQLite, there are no WAL files, locks, or table corruption to worry about.

## Verification After Cleanup

```bash
echo "=== Final Status ==="
echo "Sessions: $(ls .mycc/sessions/*.json 2>/dev/null | wc -l)"
echo "Triologues: $(ls .mycc/transcripts/*.jsonl 2>/dev/null | wc -l)"
echo "Empty triologues: $(find .mycc/transcripts -name '*.jsonl' -size 0 2>/dev/null | wc -l)"
echo "Mail files: $(ls .mycc/mail/*.jsonl 2>/dev/null | wc -l)"
```

All sessions should have valid JSON and existing, non-empty triologue files.

## Checklist

- [ ] Identified type of corruption
- [ ] Backed up important sessions before deleting
- [ ] Removed corrupted session JSON files
- [ ] Removed 0-byte triologue files
- [ ] Cleaned up orphaned triologues
- [ ] Cleared stale mail files
- [ ] Verified remaining sessions load correctly
