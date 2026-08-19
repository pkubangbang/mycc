# Corruption Types

Five types of session corruption, each with its detection script and
symptoms. Read the type that matches the symptom you are diagnosing.

## 1. Empty Session Files

Sessions created but never used (no `first_query`). These are normal but
accumulate.

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

## 2. Malformed JSON

Session files with incomplete or corrupted JSON content.

```bash
# Validate all session JSON files
for f in .mycc/sessions/*/session-*.json; do
  if ! python3 -c "import json; json.load(open('$f'))" 2>/dev/null; then
    echo "Invalid JSON: $f"
  fi
done
```

## 3. Missing Triologue Files

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

## 4. Empty (0-byte) Triologue Files

Triologue files created but never written to — indicates interrupted
session starts.

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

## 5. Orphaned Triologue Files

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

## See also

- `cleanup-procedures.md` — how to remove each corruption type.
- `recovery-and-diagnostics.md` — integrity check and stats scripts.
- SKILL.md — the corruption-type summary table and session architecture.