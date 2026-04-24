#!/bin/bash
# clear-sessions.sh - Clean up corrupted or outdated session files
# Usage: ./clear-sessions.sh [--backup] [--dry-run] [--full]
#
# Options:
#   --backup    Create backup before cleaning (default: yes)
#   --dry-run   Show what would be deleted without deleting
#   --full      Clear everything including database records
#   --no-backup Skip backup creation
#
# See clear-sessions.md for documentation

set -e

# Enable nullglob so unmatched globs expand to nothing
shopt -s nullglob

# Parse arguments
DRY_RUN=false
FULL=false
BACKUP=true

for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --full) FULL=true ;;
    --backup) BACKUP=true ;;
    --no-backup) BACKUP=false ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=== Session Cleanup ==="
echo ""

# Count current state
count_sessions() {
  local count=0
  for f in .mycc/sessions/*.json; do
    ((count++)) || true
  done
  echo $count
}

count_transcripts() {
  local count=0
  for f in .mycc/transcripts/*.jsonl; do
    ((count++)) || true
  done
  echo $count
}

count_empty_transcripts() {
  find .mycc/transcripts -name "*.jsonl" -size 0 2>/dev/null | wc -l
}

count_user_sessions() {
  local count=0
  for f in ~/.mycc/sessions/*.json; do
    ((count++)) || true
  done
  echo $count
}

echo "Current state:"
echo "  Project sessions: $(count_sessions)"
echo "  User sessions: $(count_user_sessions)"
echo "  Transcripts: $(count_transcripts)"
echo "  Empty transcripts: $(count_empty_transcripts)"
echo ""

# Diagnostic: find issues
echo "=== Diagnostics ==="

# Invalid JSON in sessions
echo "Checking for invalid JSON sessions..."
for f in .mycc/sessions/*.json; do
  [ -f "$f" ] || continue
  if ! jq empty "$f" 2>/dev/null; then
    echo -e "  ${RED}Invalid JSON: $f${NC}"
  fi
done

# Missing transcript references
echo "Checking for missing transcript references..."
for f in .mycc/sessions/*.json; do
  [ -f "$f" ] || continue
  lead=$(jq -r '.lead_triologue // empty' "$f" 2>/dev/null)
  if [ -n "$lead" ] && [ ! -f "$lead" ]; then
    echo -e "  ${RED}Missing lead_triologue in $f: $lead${NC}"
  fi
  # Check child triologues
  children=$(jq -r '.child_triologues[]? // empty' "$f" 2>/dev/null)
  for child in $children; do
    if [ ! -f "$child" ]; then
      echo -e "  ${RED}Missing child_triologue in $f: $child${NC}"
    fi
  done
done

# Empty transcripts
echo "Checking for empty (0-byte) transcripts..."
empty_count=$(find .mycc/transcripts -name "*.jsonl" -size 0 2>/dev/null | wc -l)
if [ "$empty_count" -gt 0 ]; then
  echo -e "  ${YELLOW}Found $empty_count empty transcript files${NC}"
fi

# Sessions with empty lead_triologue
echo "Checking sessions with empty lead_triologue..."
for f in .mycc/sessions/*.json; do
  [ -f "$f" ] || continue
  lead=$(jq -r '.lead_triologue // empty' "$f" 2>/dev/null)
  if [ -n "$lead" ] && [ -f "$lead" ] && [ ! -s "$lead" ]; then
    echo -e "  ${YELLOW}Empty lead_triologue in $f${NC}"
  fi
done

echo ""

if $DRY_RUN; then
  echo -e "${YELLOW}=== DRY RUN - Nothing will be deleted ===${NC}"
fi

# Backup
if $BACKUP && ! $DRY_RUN; then
  echo "Creating backup..."
  backup_file="/tmp/mycc-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
  tar -czf "$backup_file" .mycc/sessions .mycc/transcripts 2>/dev/null || true
  echo -e "  ${GREEN}Backup: $backup_file${NC}"
  echo ""
fi

# Cleanup function
do_rm() {
  if $DRY_RUN; then
    echo "  Would remove: $1"
  else
    rm -f "$1"
    echo -e "  ${GREEN}Removed: $1${NC}"
  fi
}

# Clean empty transcripts
echo "=== Cleaning empty transcripts ==="
find .mycc/transcripts -name "*.jsonl" -size 0 2>/dev/null | while read -r f; do
  [ -n "$f" ] && do_rm "$f"
done

# Clean orphaned transcripts (not referenced by any session)
echo "Checking for orphaned transcripts..."
for t in .mycc/transcripts/*.jsonl; do
  [ -f "$t" ] || continue
  # Check if any session references this transcript
  found=false
  for s in .mycc/sessions/*.json; do
    [ -f "$s" ] || continue
    if grep -q "$t" "$s" 2>/dev/null; then
      found=true
      break
    fi
  done
  if ! $found; then
    echo -e "  ${YELLOW}Orphaned: $t${NC}"
    if $FULL; then
      do_rm "$t"
    fi
  fi
done

# Clean sessions with missing/empty transcripts
echo "=== Cleaning sessions with missing transcripts ==="
for f in .mycc/sessions/*.json; do
  [ -f "$f" ] || continue
  lead=$(jq -r '.lead_triologue // empty' "$f" 2>/dev/null)
  should_remove=false
  
  # Missing lead_triologue file
  if [ -n "$lead" ] && [ ! -f "$lead" ]; then
    echo -e "  ${YELLOW}Session missing lead_triologue: $f${NC}"
    should_remove=true
  fi
  
  # Empty lead_triologue file
  if [ -n "$lead" ] && [ -f "$lead" ] && [ ! -s "$lead" ]; then
    echo -e "  ${YELLOW}Session has empty lead_triologue: $f${NC}"
    should_remove=true
  fi
  
  if $should_remove; then
    do_rm "$f"
  fi
done

# Clean invalid JSON sessions
echo "=== Cleaning invalid JSON sessions ==="
for f in .mycc/sessions/*.json; do
  [ -f "$f" ] || continue
  if ! jq empty "$f" 2>/dev/null; then
    do_rm "$f"
  fi
done

# Clean user sessions if --full
if $FULL; then
  echo "=== Cleaning user sessions (full mode) ==="
  for f in ~/.mycc/sessions/*.json; do
    [ -f "$f" ] || continue
    do_rm "$f"
  done
fi

# Database cleanup if --full
if $FULL && ! $DRY_RUN; then
  echo "=== Resetting database tables ==="
  if command -v sqlite3 &>/dev/null; then
    sqlite3 .mycc/state.db "
      DELETE FROM issue_blockages;
      DELETE FROM issues;
      DELETE FROM teammates;
      DELETE FROM worktrees;
    " 2>/dev/null || echo "  (No database or tables empty)"
  else
    echo "  sqlite3 not found, using node..."
    # Fallback: use node with better-sqlite3
    node -e "
      const Database = require('better-sqlite3');
      const db = new Database('.mycc/state.db');
      db.exec('DELETE FROM issue_blockages; DELETE FROM issues; DELETE FROM teammates; DELETE FROM worktrees;');
      db.close();
    " 2>/dev/null || echo "  (Could not reset database)"
  fi
  
  # Clean WAL files
  rm -f .mycc/state.db-wal .mycc/state.db-shm 2>/dev/null || true
  echo "  Cleaned WAL files"
fi

# Clean mail files if --full
if $FULL; then
  echo "=== Cleaning mail files ==="
  for f in .mycc/mail/*.jsonl; do
    [ -f "$f" ] || continue
    do_rm "$f"
  done
fi

echo ""
echo "=== Final state ==="
echo "  Project sessions: $(count_sessions)"
echo "  User sessions: $(count_user_sessions)"
echo "  Transcripts: $(count_transcripts)"
echo "  Empty transcripts: $(count_empty_transcripts)"

if $DRY_RUN; then
  echo ""
  echo -e "${YELLOW}Dry run complete. Run without --dry-run to apply changes.${NC}"
else
  echo ""
  echo -e "${GREEN}Cleanup complete.${NC}"
fi