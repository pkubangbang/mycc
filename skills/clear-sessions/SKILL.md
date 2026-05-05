---
name: clear-sessions
description: "Guide for clearing corrupted or outdated sessions. Use when sessions fail to load, restore, or when cleaning up stale session data."
tags: [session, cleanup, troubleshooting, corruption]
---

# Clearing Corrupted or Outdated Sessions

This guide explains how to identify and clean up corrupted or outdated session data in mycc.

## Session Architecture Overview

Sessions consist of multiple components:

| Component | Location | Purpose |
|-----------|----------|---------|
| Project sessions | `.mycc/sessions/*.json` | Session metadata (UUID, timestamps, file references) |
| User sessions | `~/.mycc-store/sessions/*.json` | User-level session storage (shadows project) |
| Transcripts | `.mycc/transcripts/*.jsonl` | Conversation logs (triologues) |
| State database | `.mycc/state.db` | SQLite DB (issues, teammates, worktrees) |
| Mail files | `.mycc/mail/*.jsonl` | Inter-agent messages |

## Types of Corruption

### 1. Empty Session Files

Sessions created but never used (no `first_query`). These are normal but can accumulate.

```bash
# Check for empty sessions (created >1 minute ago, no first_query)
find .mycc/sessions -name "*.json" -mmin +1 -exec sh -c '
  for f; do
    if ! grep -q "first_query" "$f" 2>/dev/null || grep -q "\"first_query\": \"\"" "$f"; then
      echo "Empty: $f"
    fi
  done
' _ {} +
```

### 2. Malformed JSON

Session files with incomplete or corrupted JSON content.

```bash
# Validate all session JSON files
for f in .mycc/sessions/*.json; do
  if ! jq empty "$f" 2>/dev/null; then
    echo "Invalid JSON: $f"
  fi
done
```

### 3. Missing Transcript Files

Sessions referencing non-existent triologue files.

```bash
# Check for missing transcript references
for f in .mycc/sessions/*.json; do
  lead_triologue=$(jq -r '.lead_triologue // empty' "$f" 2>/dev/null)
  if [ -n "$lead_triologue" ] && [ ! -f "$lead_triologue" ]; then
    echo "Missing lead_triologue in $f: $lead_triologue"
  fi
  
  for child in $(jq -r '.child_triologues[]? // empty' "$f" 2>/dev/null); do
    if [ ! -f "$child" ]; then
      echo "Missing child_triologue in $f: $child"
    fi
  done
done
```

### 4. Orphaned Transcripts

Transcript files not referenced by any session.

```bash
# Find orphaned transcripts
for t in .mycc/transcripts/*.jsonl; do
  basename=$(basename "$t" .jsonl)
  # Extract session ID pattern from transcript name
  # Transcripts are named: {role}-{timestamp}-triologue.jsonl
  # They should be referenced by session files
  if ! grep -rq "$t" .mycc/sessions/ 2>/dev/null; then
    echo "Orphaned transcript: $t"
  fi
done
```

### 5. Empty Transcript Files (0-byte)

**Most common issue!** Transcript files created but never written to. These indicate interrupted session starts.

**Real example found:**
```
Total transcripts: 165
Empty (0-byte): 149
```

That's 90% of transcripts being empty!

```bash
# Find empty transcripts
find .mycc/transcripts -name "*.jsonl" -size 0

# Count them
echo "Total: $(ls .mycc/transcripts/*.jsonl 2>/dev/null | wc -l)"
echo "Empty: $(find .mycc/transcripts -name '*.jsonl' -size 0 | wc -l)"

# Find sessions with empty lead_triologue
for f in .mycc/sessions/*.json; do
  lead=$(jq -r '.lead_triologue // empty' "$f" 2>/dev/null)
  if [ -n "$lead" ] && [ -f "$lead" ] && [ ! -s "$lead" ]; then
    echo "Session $f has empty lead_triologue: $lead"
  fi
done
```

### 6. Database Issues

WAL files left from unclean shutdown.

```bash
# Check for WAL files (normal during operation, may indicate crash if persistent)
ls -la .mycc/state.db-wal .mycc/state.db-shm 2>/dev/null
```

## Cleanup Procedures

### Quick Cleanup (Recommended)

The built-in cleanup removes empty sessions safely:

```bash
# This is called automatically on session start
# Removes empty sessions created >1 minute ago
```

### Quick Fix for Empty Transcripts

**Most common cleanup needed.** Remove 0-byte transcript files:

```bash
# Remove all empty transcripts
find .mycc/transcripts -name "*.jsonl" -size 0 -delete

# Verify cleanup
find .mycc/transcripts -name "*.jsonl" -size 0 | wc -l
# Should output: 0
```

### Full Session Reset

When starting fresh or after major corruption:

```bash
# 1. Backup existing sessions (optional but recommended)
tar -czf /tmp/mycc-sessions-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
  .mycc/sessions .mycc/transcripts .mycc/mail 2>/dev/null

# 2. Clear project sessions
rm -rf .mycc/sessions/*.json

# 3. Clear transcripts (orphaned conversations)
rm -rf .mycc/transcripts/*.jsonl

# 4. Clear mail files
rm -rf .mycc/mail/*.jsonl

# 5. Remove database file entirely (will be recreated on next start)
rm -f .mycc/state.db

# 6. Clean WAL files
rm -f .mycc/state.db-wal .mycc/state.db-shm

# 7. Reset worktrees JSON
echo '[]' > .mycc/worktrees.json
```

**Note**: The sqlite3 CLI tool may not be available in all environments. Simply removing `state.db` is safe - it will be recreated automatically on the next session start.

### Selective Cleanup

Remove only corrupted sessions:

```bash
# 1. Find and remove sessions with missing transcripts
for f in .mycc/sessions/*.json; do
  lead=$(jq -r '.lead_triologue // empty' "$f" 2>/dev/null)
  if [ -n "$lead" ] && [ ! -f "$lead" ]; then
    echo "Removing session with missing transcript: $f"
    rm "$f"
  fi
done

# 2. Remove invalid JSON files
for f in .mycc/sessions/*.json; do
  if ! jq empty "$f" 2>/dev/null; then
    echo "Removing invalid JSON: $f"
    rm "$f"
  fi
done
```

### User Sessions Cleanup

User-level sessions in `~/.mycc-store/sessions/` may also need cleanup:

```bash
# List user sessions
ls -la ~/.mycc-store/sessions/

# Clear all user sessions
rm -rf ~/.mycc-store/sessions/*.json

# Or validate and remove corrupted
for f in ~/.mycc-store/sessions/*.json; do
  if ! jq empty "$f" 2>/dev/null; then
    echo "Removing invalid user session: $f"
    rm "$f"
  fi
done
```

## Recovery Procedures

### Restore from Backup

If you have backups:

```bash
# Extract backup
tar -xzf sessions-backup-YYYYMMDD.tar.gz

# Restore specific session
cp sessions-backup/UUID.json .mycc/sessions/
```

### Manually Fix Session File

If a session file has minor corruption:

```bash
# View session content
cat .mycc/sessions/UUID.json | jq .

# Fix missing required fields manually
jq '. + {first_query: "Recovered session"}' .mycc/sessions/UUID.json > /tmp/fixed.json
mv /tmp/fixed.json .mycc/sessions/UUID.json
```

### Rebuild Session from Transcript

If transcript exists but session metadata is lost:

```bash
# Create minimal session file for existing transcript
cat > .mycc/sessions/new-uuid.json << 'EOF'
{
  "version": "1.0",
  "id": "new-uuid",
  "create_time": "2024-01-01T00:00:00Z",
  "project_dir": "/path/to/project",
  "lead_triologue": ".mycc/transcripts/lead-XXXXXXX-triologue.jsonl",
  "child_triologues": [],
  "teammates": [],
  "first_query": "Recovered session"
}
EOF
```

## Diagnostic Commands

### Check Session Integrity

```bash
# Full session validation
echo "=== Checking session files ==="
for f in .mycc/sessions/*.json; do
  [ -f "$f" ] || continue
  id=$(jq -r '.id // "unknown"' "$f" 2>/dev/null)
  lead=$(jq -r '.lead_triologue // "missing"' "$f" 2>/dev/null)
  
  echo -n "Session $id: "
  if [ ! -f "$lead" ]; then
    echo "MISSING lead_triologue: $lead"
  else
    echo "OK"
  fi
done

echo ""
echo "=== Checking for empty sessions ==="
for f in .mycc/sessions/*.json; do
  [ -f "$f" ] || continue
  query=$(jq -r '.first_query // empty' "$f" 2>/dev/null)
  if [ -z "$query" ]; then
    echo "Empty first_query: $f"
  fi
done

echo ""
echo "=== Checking transcript files ==="
ls -lh .mycc/transcripts/*.jsonl | awk '{print $5, $9}' | sort -h
```

### Database Status

```bash
# Check database tables
sqlite3 .mycc/state.db ".tables"

# Count records
sqlite3 .mycc/state.db "
  SELECT 'issues' as table, COUNT(*) as count FROM issues
  UNION SELECT 'teammates', COUNT(*) FROM teammates
  UNION SELECT 'worktrees', COUNT(*) FROM worktrees;
"

# Check for orphaned records
sqlite3 .mycc/state.db "
  SELECT * FROM issue_blockages 
  WHERE blocker_id NOT IN (SELECT id FROM issues)
     OR blocked_id NOT IN (SELECT id FROM issues);
"
```

## Prevention Best Practices

### 1. Regular Cleanup

Empty sessions are cleaned automatically on startup. For manual cleanup:

```bash
# Run this periodically
find .mycc/sessions -name "*.json" -mmin +1 -exec sh -c '
  for f; do
    query=$(jq -r ".first_query // empty" "$f")
    if [ -z "$query" ]; then
      rm "$f"
    fi
  done
' _ {} +
```

### 2. Clean Shutdowns

Always exit cleanly to allow proper database and session file writes.

### 3. Backup Important Sessions

Before risky operations:

```bash
# Backup specific session
cp .mycc/sessions/important-uuid.json ~/backups/

# Or backup all
tar -czf ~/backups/mycc-$(date +%Y%m%d).tar.gz .mycc/
```

### 4. Monitor WAL Files

If WAL files persist after shutdown, database may not have closed properly:

```bash
# After ensuring no mycc processes running
rm -f .mycc/state.db-wal .mycc/state.db-shm
```

## Common Issues and Solutions

### Issue: "Session not found" but file exists

**Cause**: JSON parsing failed silently.

**Solution**:
```bash
# Validate JSON
jq empty .mycc/sessions/UUID.json
# If invalid, remove or fix manually
```

### Issue: Session restore fails with "missing files"

**Cause**: Transcript file deleted or moved.

**Solution**:
```bash
# Either remove the session
rm .mycc/sessions/UUID.json

# Or create placeholder transcript
touch .mycc/transcripts/lead-XXXX-triologue.jsonl
```

### Issue: Database locked

**Cause**: Another mycc process running or unclean shutdown.

**Solution**:
```bash
# Check for running processes
ps aux | grep mycc

# Remove lock files
rm -f .mycc/state.db-wal .mycc/state.db-shm
```

### Issue: User session shadows project session unexpectedly

**Cause**: Session saved to user dir now takes precedence.

**Solution**:
```bash
# Remove user session to use project session
rm ~/.mycc-store/sessions/UUID.json
```

### Issue: sqlite3 command not found

**Cause**: The sqlite3 CLI tool is not installed in the environment.

**Solution**: Simply delete the database file - it will be recreated:
```bash
rm -f .mycc/state.db .mycc/state.db-wal .mycc/state.db-shm
```

### Issue: better-sqlite3 module not found

**Cause**: The project doesn't include better-sqlite3 as a dependency.

**Solution**: Don't try to use Node.js for database operations. Just delete the database file.

## Practical Notes from Real Execution

### What Actually Works

1. **Backup first** - Always create a backup in `/tmp/` before cleanup
2. **Simple deletion is enough** - No need for sqlite3 CLI or better-sqlite3 module
3. **Database recreation** - `state.db` is recreated automatically on next session start
4. **Worktrees in JSON** - The project uses `worktrees.json` not the database for worktree storage
5. **Current session transcript** - Will NOT be deleted (expected behavior)

### Verification Command

After cleanup, verify with:
```bash
echo "=== Final Status ==="
echo "Sessions: $(ls .mycc/sessions/*.json 2>/dev/null | wc -l)"
echo "Transcripts: $(ls .mycc/transcripts/*.jsonl 2>/dev/null | wc -l)"
echo "Mail files: $(ls .mycc/mail/*.jsonl 2>/dev/null | wc -l)"
echo "Database: $(ls .mycc/state.db 2>/dev/null | wc -l)"
echo "Worktrees: $(cat .mycc/worktrees.json 2>/dev/null))"
```

Expected result after cleanup:
- Sessions: 0
- Transcripts: 1 (current session)
- Mail files: 0
- Database: 0
- Worktrees: []

## Checklist

When cleaning up sessions:

- [ ] Identify type of corruption
- [ ] Backup important sessions before deleting
- [ ] Remove corrupted session files
- [ ] Clean up orphaned transcripts
- [ ] Clear stale mail files
- [ ] Remove database file (no sqlite3 needed)
- [ ] Remove WAL files after shutdown
- [ ] Verify remaining sessions load correctly

---

## Quality Checklist

Before considering cleanup complete:

- [ ] All session JSON files are valid (`jq empty` passes)
- [ ] No sessions reference missing transcript files
- [ ] No sessions reference empty (0-byte) transcript files
- [ ] No orphaned transcripts remain
- [ ] Database tables are consistent (no orphaned foreign keys)
- [ ] WAL files removed (if no active processes)
- [ ] Mail directory cleaned of stale messages

## Resources

- Session source code: `src/session/index.ts`, `src/session/restoration.ts`
- Database schema: `src/context/db.ts`
- Types: `src/session/types.ts`
- **Cleanup script**: `scripts/clear-sessions.sh` (bundled with mycc)

## Quick Reference

```bash
# Dry run (see what would be deleted)
node_modules/.bin/mycc-scripts/clear-sessions.sh --dry-run

# Or if installed globally:
# clear-sessions.sh --dry-run

# Standard cleanup (backup + clean corrupted)
# clear-sessions.sh

# Full cleanup (everything including database)
# clear-sessions.sh --full

# Skip backup
# clear-sessions.sh --no-backup
```