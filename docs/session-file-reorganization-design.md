# Session File Reorganization

## Current State

```
.mycc/
  sessions/{uuid}.json                          ← session metadata (flat files)
  mail/{owner}.jsonl                            ← mailbox files (single file per owner)
  transcripts/{name}-{timestamp}-triologue.jsonl ← triologue files
  transcripts/transcript_{timestamp}.jsonl       ← auto-compact transcripts
  transcripts/explorer_{timestamp}.jsonl         ← explorer agent transcripts
```

## Two Problems

1. **Scattered files**: All files belonging to one session are in different folders, making it hard to find/backup/restore a complete session.
2. **Mailbox not concurrent-safe**: Single `{owner}.jsonl` file with read-then-truncate pattern. Two mycc instances in the same project directory will collide.

## Target State

```
.mycc/sessions/{session-id}/
  session-{sessionid}.json                          ← session metadata
  unread-lead-{yyyyMMddTHHmmssZ}.jsonl              ← lead's inbox
  readmail-lead-{yyyyMMddTHHmmssZ}.jsonl             ← lead's backlog
  triologue-lead-{yyyyMMddTHHmmssZ}.jsonl            ← lead's triologue
  transcript-lead-{yyyyMMddTHHmmssZ}.jsonl            ← lead's auto-compact transcripts
  unread-dev-{yyyyMMddTHHmmssZ}.jsonl                ← teammate dev's inbox
  readmail-dev-{yyyyMMddTHHmmssZ}.jsonl              ← teammate dev's backlog
  triologue-dev-{yyyyMMddTHHmmssZ}.jsonl             ← teammate dev's triologue
  transcript-dev-{yyyyMMddTHHmmssZ}.jsonl             ← teammate dev's transcripts
```

### User-Level Storage (`~/.mycc-store/sessions/`)

```
~/.mycc-store/sessions/{session-id}/
  session-{sessionid}.json                          ← copy of session metadata
  readmail-lead-{yyyyMMddTHHmmssZ}.jsonl            ← copy of lead's backlog
  triologue-lead-{yyyyMMddTHHmmssZ}.jsonl           ← copy of lead's triologue
  triologue-dev-{yyyyMMddTHHmmssZ}.jsonl            ← copy of teammate triologues
  transcript-lead-{yyyyMMddTHHmmssZ}.jsonl          ← copy of transcripts
```

The `/save` command copies the entire session directory (not just the JSON file) to `~/.mycc-store/sessions/`. The `/load` command reads from this directory structure.

### Timestamp Format

All timestamps in filenames use `yyyyMMddTHHmmssZ` format (e.g., `20260624T143052Z`):
- Sortable lexicographically
- Human-readable
- Timezone-agnostic (always UTC)
- No colons or special chars that cause issues on Windows

## Change 1: Mailbox → Unread + Readmail Backlog

Split the mailbox into "unread" and "readmail". For an agent called "dev", there will be `2 * spawn_time` mailbox files:
- `unread-dev-{timestamp}.jsonl`: the inbox. `collectMails()` reads from this file.
- `readmail-dev-{timestamp}.jsonl`: the backlog. Append-only, never truncated.

The transition on collect-mail:
1. Read content of `unread-dev-{timestamp}.jsonl`
2. Truncate the unread file (clear it)
3. Append the content to `readmail-dev-{timestamp}.jsonl`
4. Return the content (same as original behavior)

This solves the concurrency problem: multiple instances writing to the same `unread` file is still a race, but the readmail backlog preserves history. The `timestamp` in the filename also helps distinguish instances.

## Change 2: All Files Inside Session Directory

Instead of `mail/` + `sessions/` + `transcripts/` folders, now we only have `sessions/` at the top level. Each session gets its own subdirectory named by its UUID.

## Affected Features & Scenarios

### 1. Session Creation (`src/session/index.ts`)
- `createSessionFile()` — writes to `sessions/{id}/session-{id}.json` instead of flat file
- `createNewSession()` — creates triologue in session dir instead of `transcripts/`
- `getSessionsDir()` — returns `.mycc/sessions/` (the root)
- New: `getSessionDir(sessionId)` — returns `.mycc/sessions/{sessionId}/`
- `getSessionPathById()` — looks for `{id}/session-{id}.json`
- `findSessionPaths()` — same pattern, partial ID matching
- `listSessions()` — reads `.mycc/sessions/*/session-*.json`
- `cleanupEmptySessions()` — same pattern
- `getSessionId()` — extracts UUID from `session-{uuid}.json` filename or from directory name

### 2. Session Restoration (`src/session/restoration.ts`)
- `ensureSameTeammate()` — regex updated from `.mycc/transcripts/([^/]+)-triologue.jsonl` to `.mycc/sessions/[^/]+/triologue-([^/]+)-.*\.jsonl`
- `prepareRestoration()` — reads triologue files by path stored in session JSON (paths change but logic stays same)

### 3. `/load` Command (`src/slashes/load.ts`)
- Depends on session/index.ts and restoration.ts changes
- No direct path changes

### 4. `/save` Command (`src/slashes/save.ts`)
- `saveToUserDir()` — copies entire session directory to `~/.mycc-store/sessions/{id}/`
- Previously copied a single JSON file

### 5. `/fork` Command (`src/slashes/fork.ts`)
- `getSessionId()` needs to handle new filename format `session-{uuid}.json`

### 6. MailBox (`src/context/shared/mail.ts`)
- **New path**: `sessions/{sessionId}/unread-{owner}-{ts}.jsonl` and `readmail-{owner}-{ts}.jsonl`
- **Read/unread split**: `collectMails()` appends to readmail before truncating unread
- **Session ID**: uses `getSessionContext()` from config.ts (global, no constructor change needed)
- `getMailPath()` — removed, replaced by session-dir-based path
- `appendMail()` — writes to `unread-{owner}-{ts}.jsonl`
- `collectMails()` — reads unread, truncates it, appends to readmail, returns content
- `listMails()` — reads from unread (peek, non-destructive)
- `hasNewMails()` — checks unread file

### 7. Mail Collection (`src/loop/states/collect.ts`)
- Calls `ctx.mail.collectMails()` — no direct change, depends on MailBox

### 8. `/mail` Display (`src/slashes/mail.ts`)
- Calls `ctx.mail.listMails()` — no direct change, depends on MailBox

### 9. Lead Triologue (`src/loop/agent-repl.ts`)
- Path from session init — no direct change, but path format changes
- `onMessage` callback appends to triologue path

### 10. Lead Auto-Compact (`src/loop/triologue.ts`)
- `runAutoCompact()` — writes transcript to `sessions/{sessionId}/transcript-lead-{ts}.jsonl`
- Previously wrote to `transcripts/transcript_{timestamp}.jsonl`

### 11. Teammate Triologue (`src/context/teammate-worker.ts`)
- `createPersistentTriologue()` — creates triologue at `sessions/{sessionId}/triologue-{name}-{ts}.jsonl`
- Previously created at `transcripts/{name}-{timestamp}-triologue.jsonl`

### 12. Teammate Spawning (`src/context/parent/team.ts`)
- `createTeammate()` — generates triologue path in session dir
- Updates session file's `child_triologues` with new path format

### 13. Explorer Agent Transcripts (`src/mindmap/explorer-agent.ts`)
- `compactMessages()` — writes transcript to `sessions/{sessionId}/transcript-explorer-{ts}.jsonl`
- Previously wrote to `transcripts/explorer_{timestamp}.jsonl`

### 14. Config Helpers (`src/config.ts`)
- Remove `getMailDir()` — mail goes into session dir
- Add `getSessionDir(sessionId)` — returns `.mycc/sessions/{sessionId}/`
- Update `ensureDirs()` — no longer creates `.mycc/mail/`, creates session subdirectory structure

### 15. User Session Storage (`src/session/index.ts`)
- `saveToUserDir()` — copies entire session directory
- `getUserSessionsDir()` — returns `~/.mycc-store/sessions/` (unchanged)
- `listSessions()` — reads `sessions/*/session-*.json` from both project and user dirs
- `findSessionPaths()` — same pattern

### 16. Session Validation (`src/session/index.ts`)
- `validateSession()` — path checks stay same, just different paths

### 17. Session Types (`src/session/types.ts`)
- Bump `version` to `'2.0'`

### 18. clear-sessions Skill (`.mycc/skills/clear-sessions.md`)
- Update all bash commands:
  - `sessions/*/session-*.json` instead of `sessions/*.json`
  - `sessions/*/triologue-*.jsonl` instead of `transcripts/*.jsonl`
  - No more `transcripts/` or `mail/` directories
  - User sessions: `~/.mycc-store/sessions/*/session-*.json`

### 19. session-introspect Skill (`.mycc/skills/session-introspect.md`)
- Update all bash commands and path references
- Same pattern changes as clear-sessions

### 20. Tests (`src/tests/tp-violation/tp-auto-fixer.test.ts`)
- Update mock values for `getMailDir`/`getSessionsDir`

### 21. Worktree System (`src/context/parent/wt.ts`, `src/context/worktree-store.ts`)
- **No change** — uses `.worktrees/` directory and `worktrees.json`, not session/mail/transcript paths

### 22. In-Memory Store (`src/context/memory-store.ts`)
- **No change** — in-memory only, no file paths

## Implementation Order

### Phase 1: Core Infrastructure
1. **`src/config.ts`** — Remove `getMailDir()`, add `getSessionDir(sessionId)`, update `ensureDirs()`
2. **`src/session/types.ts`** — Bump version to `'2.0'`
3. **`src/session/index.ts`** — Update all path helpers, session creation, listing, search

### Phase 2: Mail System
4. **`src/context/shared/mail.ts`** — Read/unread split, new paths, use `getSessionContext()` for session ID

### Phase 3: Triologue & Transcript Paths
5. **`src/loop/triologue.ts`** — Auto-compact writes to session dir
6. **`src/context/teammate-worker.ts`** — Triologue in session dir
7. **`src/context/parent/team.ts`** — Teammate triologue path in session dir
8. **`src/mindmap/explorer-agent.ts`** — Explorer transcripts in session dir

### Phase 4: Slash Commands
9. **`src/slashes/save.ts`** — Copy entire session directory
10. **`src/slashes/load.ts`** — Depends on session/index.ts changes
11. **`src/slashes/fork.ts`** — `getSessionId()` handles new format

### Phase 5: Restoration & Validation
12. **`src/session/restoration.ts`** — Update regex in `ensureSameTeammate()`

### Phase 6: Skills & Tests
13. **`.mycc/skills/clear-sessions.md`** — Update all paths
14. **`.mycc/skills/session-introspect.md`** — Update all paths
15. **`src/tests/tp-violation/tp-auto-fixer.test.ts`** — Update mock values

## Key Design Decisions

1. **MailBox gets session ID from global context**: Use `getSessionContext()` from `config.ts` (already available globally). `MailBox` constructor no longer needs session ID — it reads from the global context. This avoids threading session ID through all the context constructors.

2. **Two functions for sessions dir**: `getSessionsDir()` returns `.mycc/sessions/` (the root, for listing/searching). `getSessionDir(sessionId)` returns `.mycc/sessions/{sessionId}/` (for file operations within a session).

3. **Explorer agent transcripts go to current session dir**: Explorer runs during mindmap compilation, which happens during a session. Write to `sessions/{currentSessionId}/transcript-explorer-{ts}.jsonl`. If no session context (e.g., during setup), fall back to a temp location.

4. **User session mirrors project structure**: `~/.mycc-store/sessions/{id}/session-{id}.json` + triologue copies. `/save` copies the entire session directory. `/load` reads from this directory structure.

5. **No migration from old format**: Design for the future. Old sessions in the flat format are left as-is. New sessions use the new directory structure.
