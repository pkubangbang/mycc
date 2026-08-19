# Cleanup Procedures

How to remove corrupted or outdated session data. Use the procedure that
matches the corruption type you identified (see `corruption-types.md`).

## Quick Fix: Remove Empty Triologues

The most common cleanup — remove 0-byte triologue files:

```bash
find .mycc/sessions -name "triologue-*.jsonl" -size 0 -delete
echo "Remaining empty: $(find .mycc/sessions -name 'triologue-*.jsonl' -size 0 | wc -l)"
```

## Full Session Reset

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

Note: the current session's triologue is actively being written and will
not be deleted by `rm`.

## Selective Cleanup

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

## User Sessions Cleanup

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

## See also

- `corruption-types.md` — detection scripts for each type.
- `recovery-and-diagnostics.md` — restore from backup, rebuild sessions.
- SKILL.md — the corruption-type summary table.