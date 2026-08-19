# Recovery & Diagnostics

How to recover lost or corrupted sessions, and how to run integrity checks
and storage stats.

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

**Cause:** A session saved to user dir (`~/.mycc-store/sessions/`) takes
precedence over the project-level session with the same UUID.

**Solution:**
```bash
# Remove user session to fall back to project session
rm -rf ~/.mycc-store/sessions/UUID
```

## See also

- `corruption-types.md` — detection scripts for each corruption type.
- `cleanup-procedures.md` — how to remove corrupted sessions.
- SKILL.md — the session architecture and verification checklist.