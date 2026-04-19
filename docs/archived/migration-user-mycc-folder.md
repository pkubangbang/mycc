# Migration Plan: ~/.mycc → ~/.mycc-store

## Overview

Rename the user-level mycc folder from `~/.mycc` to `~/.mycc-store`.

**Rationale:**
- Avoids conflict with project-level `.mycc` folders
- Distinct name makes it clear this is a "store" for user-level data
- Still hidden (dot prefix) since it's tool-internal state
- No migration needed - tool is in beta, old folder can be discarded

## Current State

### User-level paths (~/.mycc) - TO BE CHANGED
| Path | Purpose |
|------|---------|
| `~/.mycc/.env` | Global environment configuration |
| `~/.mycc/sessions/` | User-saved sessions |
| `~/.mycc/tools/` | User-defined tools |
| `~/.mycc/skills/` | User-defined skills |
| `~/.mycc/wiki/` | Knowledge base (db, logs, domains.json) |
| `~/.mycc/wiki/db/` | LanceDB vector store |
| `~/.mycc/wiki/logs/` | WAL files (daily) |
| `~/.mycc/wiki/domains.json` | Domain registry |

### New paths (~/.mycc-store) - AFTER CHANGE
| Path | Purpose |
|------|---------|
| `~/.mycc-store/.env` | Global environment configuration |
| `~/.mycc-store/sessions/` | User-saved sessions |
| `~/.mycc-store/tools/` | User-defined tools |
| `~/.mycc-store/skills/` | User-defined skills |
| `~/.mycc-store/wiki/` | Knowledge base (db, logs, domains.json) |

### Project-level paths (.mycc)
| Path | Purpose |
|------|---------|
| `.mycc/state.db` | SQLite database (issues, teammates, worktrees) |
| `.mycc/sessions/` | Project sessions |
| `.mycc/tools/` | Project tools |
| `.mycc/skills/` | Project skills |
| `.mycc/mail/` | Mailboxes |
| `.mycc/longtext/` | Large content files |
| `.mycc/transcripts/` | Session transcripts |

## Migration Steps

### Phase 1: Code Changes

#### 1.1 Update `src/context/db.ts`
Change user-level path functions:

```typescript
// BEFORE
export function getUserToolsDir(): string {
  return path.join(os.homedir(), '.mycc', 'tools');
}

// AFTER  
export function getUserToolsDir(): string {
  return path.join(os.homedir(), '.mycc-store', 'tools');
}
```

Functions to update:
- `getUserToolsDir()` - line ~282
- `getUserSkillsDir()` - line ~289
- `getWikiDir()` - line ~296
- `getWikiLogsDir()` - calls getWikiDir() (no change needed)
- `getWikiDbDir()` - calls getWikiDir() (no change needed)
- `getWikiDomainsFile()` - calls getWikiDir() (no change needed)

#### 1.2 Update `src/session/index.ts`
Change `getUserSessionsDir()`:

```typescript
// BEFORE
export function getUserSessionsDir(): string {
  return path.join(os.homedir(), '.mycc', 'sessions');
}

// AFTER
export function getUserSessionsDir(): string {
  return path.join(os.homedir(), '.mycc-store', 'sessions');
}
```

#### 1.3 Update `src/index.ts`
Change `GLOBAL_ENV` path:

```typescript
// BEFORE
const GLOBAL_ENV = resolve(homedir(), '.mycc', '.env');

// AFTER
const GLOBAL_ENV = resolve(homedir(), '.mycc-store', '.env');
```

#### 1.4 Update `src/lead.ts`
Change `GLOBAL_ENV` path:

```typescript
// BEFORE
const GLOBAL_ENV = resolve(homedir(), '.mycc', '.env');

// AFTER
const GLOBAL_ENV = resolve(homedir(), '.mycc-store', '.env');
```

#### 1.5 Update `src/config.ts`
Change error message references:

```typescript
// BEFORE (line 153)
'Neither EDITOR nor VISUAL is set. The open-editor tool will fail. Add to ~/.mycc/.env:\n  export EDITOR=code   # VS Code\n  export EDITOR=vim    # Vim',

// AFTER
'Neither EDITOR nor VISUAL is set. The open-editor tool will fail. Add to ~/.mycc-store/.env:\n  export EDITOR=code   # VS Code\n  export EDITOR=vim    # Vim',
```

#### 1.6 Update `src/utils/open-editor.ts`
Change error message:

```typescript
// BEFORE (line 62)
'Please set it to your preferred editor. Add to ~/.mycc/.env:\n' +

// AFTER
'Please set it to your preferred editor. Add to ~/.mycc-store/.env:\n' +
```

### Phase 2: Documentation Updates

#### 2.1 Update CLAUDE.md
- Line 39: `~/.mycc/sessions` → `~/.mycc-store/sessions`

#### 2.2 Update README.md
- Line 254: `~/.mycc/wiki/` → `~/.mycc-store/wiki/`
- Line 487: `~/.mycc/wiki/db/` → `~/.mycc-store/wiki/db/`
- Line 488: `~/.mycc/wiki/logs/*.wal` → `~/.mycc-store/wiki/logs/*.wal`
- Line 489: `~/.mycc/wiki/domains.json` → `~/.mycc-store/wiki/domains.json`

#### 2.3 Update docs/user-manual-20260408.md
- Line 224: `~/.mycc/wiki/logs/` → `~/.mycc-store/wiki/logs/`
- Line 254: `~/.mycc/wiki/` → `~/.mycc-store/wiki/`
- Line 487-489: Update wiki paths

#### 2.4 Update docs/how-to-build-persistent-memory.md
- Line 97: `~/.mycc/wiki/logs/` → `~/.mycc-store/wiki/logs/`
- Line 154: `~/.mycc/wiki/logs/` → `~/.mycc-store/wiki/logs/`

#### 2.5 Update docs/how-to-restore-the-session.md
- Line 25: `~/.mycc/sessions` → `~/.mycc-store/sessions`
- Line 91: Update path in example

## File Change Summary

| File | Changes |
|------|---------|
| `src/context/db.ts` | 3 path functions |
| `src/session/index.ts` | 1 function |
| `src/index.ts` | 1 constant |
| `src/lead.ts` | 1 constant |
| `src/config.ts` | 1 error message |
| `src/utils/open-editor.ts` | 1 error message |
| `CLAUDE.md` | 1 reference |
| `README.md` | 4 references |
| `docs/user-manual-20260408.md` | 4 references |
| `docs/how-to-build-persistent-memory.md` | 2 references |
| `docs/how-to-restore-the-session.md` | 2 references |

## Backward Compatibility

**No migration** - Tool is in beta. Users with existing `~/.mycc` folder can:
1. Delete old folder and start fresh, OR
2. Manually move `~/.mycc` to `~/.mycc-store` if they want to keep data

## Risk Assessment

**Very Low Risk:**
- Path changes are isolated to specific functions
- No database schema changes
- Project-level `.mycc` unaffected
- No migration code needed

## Implementation Order

1. Update path functions in `db.ts` and `session/index.ts`
2. Update error messages in `config.ts` and `open-editor.ts`
3. Update `GLOBAL_ENV` in `index.ts` and `lead.ts`
4. Update documentation