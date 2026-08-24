# Plan: lfplater Discovery via Background Skill-Manager (Hermes-inspired)

## Goal

Close the "lfplater files have no discovery mechanism" design gap in
`learn-from-past`. Instead of leaving deferred `.mycc/lfplater/` files to
rot, a **project-level opt-in** declaration in README.md triggers the lead
agent to spawn an autonomous **headless mycc peer** (cross-instance, not a
child teammate) that acts as a **skill-manager** — reviewing lfplater files,
creating/optimizing/merging skills, and reporting back via `mail_to`.

The peer is launched with `--role skill-manager`, which tags its entry in
`identity.json` so any productivity MYCC sharing the same working directory
can discover it via `peers()` and avoid spawning a duplicate.

Inspired by Hermes (Nous Research)'s closed learning loop: autonomous skill
creation after tasks, skill self-improvement, periodic knowledge persistence
— but implemented with mycc's existing cross-instance mediation machinery.

---

## Pitfall-Aware Design Choices

1. **LLM overconfidence blind-spot** (pitfall, commit `c9c4f7b`): Do NOT rely
   on the LLM voluntarily self-identifying the need to spawn a skill-manager.
   The `learn-from-past` hook message (deterministic, fires on
   `brief(confidence=10)`) carries **explicit instructions**: check README.md
   for the declaration, check `.mycc/lfplater/` for files, spawn if both true.

2. **Skills should be problem-focused** (pitfall #3/#4): The skill-manager
   skill contains zero channel-file mechanics or identity-meta-logic. The
   `mediator` skill handles spawning; `--role` handles identity labeling; the
   skill-manager skill handles the *work* (read lfplater, search/create/merge
   skills, report back).

3. **Complexity within domain, simple connection model**: The `--role` flag
   is the simple connection-layer addition (one field in identity.json). All
   skill-management complexity lives in the skill-manager's own workflow.

---

## Architecture Overview

```
┌─ Productivity MYCC (lead, no --role) ──────────────────────────┐
│                                                                │
│  1. brief(confidence=10) → learn-from-past hook fires            │
│  2. Hook message: "check README.md + .mycc/lfplater/"           │
│  3. If both true: spawn skill-manager peer                      │
│     bg_create("mycc --auto --role skill-manager ...")           │
│  4. Author channel file pair with firstQuery                     │
│  5. Peer processes lfplater files → mails report back            │
│  6. Lead receives [MAIL] report → bg_remove(pid)                │
│                                                                │
│  Discovery (any productivity MYCC in same workDir):              │
│  peers() → filter by role=="skill-manager" && same workDir      │
│  && fresh heartbeat → found! mail work to it, don't spawn dup    │
└────────────────────────────────────────────────────────────────┘
         │ --role skill-manager
         ▼
┌─ Skill-Manager MYCC (headless peer, --auto --role skill-manager) ┐
│                                                                  │
│  1. Registers in identity.json with role: "skill-manager"        │
│  2. Channel poll delivers firstQuery → loads skill-manager skill  │
│  3. Scans .mycc/lfplater/ → processes each file                    │
│  4. skill_search → create (create-skill) / optimize (edit_file)   │
│  5. Merges duplicates conservatively                              │
│  6. Mails report to lead via mail_to("<leadSessionId>/lead")      │
│  7. Done — lead tears down with bg_remove(pid)                    │
└──────────────────────────────────────────────────────────────────┘
```

---

## Scope: What Changes

### Source code changes (the `--role` mechanism — general infrastructure)

| # | File | Change |
|---|------|--------|
| 1 | `src/config.ts` | Parse `--role` CLI flag + `MYCC_ROLE` env var; expose `getRole()` accessor |
| 2 | `src/types.ts` | Add optional `role?: string` to `IdentityEntry` interface |
| 3 | `src/peer/identity.ts` | Pass `role` through `IdentityManager` constructor → include in `register()` write |
| 4 | `src/peer/peer.ts` | Pass `role` through `PeerManager` constructor → `IdentityManager` |
| 5 | `src/context/parent-context.ts` | Read `getRole()` from config → pass to `PeerManager` constructor |

### Skill-layer changes (the skill-manager workflow + learn-from-past extension)

| # | File | Change |
|---|------|--------|
| 6 | `.mycc/conditions.json` | Fix corrupted v2 message text for `learn-from-past` |
| 7 | `skills/skill-manager/SKILL.md` | **NEW** — the skill loaded by the headless peer's `firstQuery` |
| 8 | `skills/learn-from-past/SKILL.md` | (a) Update hook message with skill-manager spawning instructions; (b) add "Autonomous Skill-Manager" section; (c) update Trigger section to v2 `turn.*`/`session.*` API |

### What does NOT change

- The `learn-from-past` hook **condition** and **action type** (`message`) stay the same.
- `bg_create`, `peers()`, channel files, `firstQuery`, `mail_to` — all existing infrastructure, untouched.
- The `--role` mechanism is **general** — not hardcoded to "skill-manager". Any future role
  ("reviewer", "test-runner", "doc-writer") can use `--role <name>` with zero further code changes.

---

## Implementation Steps

### Step 1: `src/config.ts` — Parse `--role` / `MYCC_ROLE`

Add `role` to the minimist `string` array and the `buildCmdArgsEnv` map:

```typescript
// In the minimist options, add to string[]:
string: [
  // ... existing entries ...
  'role',
],

// In buildCmdArgsEnv map, add:
'role': 'MYCC_ROLE',
```

Add an accessor:

```typescript
/**
 * Get the instance role label (--role CLI flag or MYCC_ROLE env var).
 * Used to tag the instance's identity.json entry so peers can discover
 * instances by role (e.g. "skill-manager"). Returns undefined if no role
 * is set (the default for productivity instances).
 *
 * Reads parsed CLI args directly (not process.env) to avoid inheriting
 * a stale MYCC_ROLE env var from a parent process.
 */
export function getRole(): string | undefined {
  const r = args.role;
  return (typeof r === 'string' && r.length > 0) ? r : undefined;
}
```

### Step 2: `src/types.ts` — Add `role?` to `IdentityEntry`

```typescript
export interface IdentityEntry {
  sessionId: string;
  workDir: string;
  mailbox: string;
  startedAt: number;
  role?: string;  // Optional role label (--role CLI flag / MYCC_ROLE env)
}
```

### Step 3: `src/peer/identity.ts` — Thread `role` through constructor + register

Add a `role` parameter to the `IdentityManager` constructor:

```typescript
export class IdentityManager {
  private sessionId: string;
  private workDir: string;
  private mailboxPath: string;
  private role?: string;
  // ...

  constructor(sessionId: string, workDir: string, mailboxPath: string, role?: string) {
    this.sessionId = sessionId;
    this.workDir = workDir;
    this.mailboxPath = mailboxPath;
    this.role = role;
  }
```

In `register()`, include `role` in the entry:

```typescript
register(): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    const map = readIdentityMap();
    map[this.sessionId] = {
      sessionId: this.sessionId,
      workDir: this.workDir,
      mailbox: this.mailboxPath,
      startedAt: Date.now(),
      ...(this.role ? { role: this.role } : {}),
    };
    writeIdentityMap(map);
    // ... existing verify logic ...
  }
}
```

The spread `...(this.role ? { role } : {})` keeps the entry clean when no
role is set (no `role: undefined` in the JSON).

### Step 4: `src/peer/peer.ts` — Thread `role` through `PeerManager`

```typescript
export class PeerManager implements PeerModule {
  private identity: IdentityManager;
  private channel: ChannelManager;

  constructor(sessionId: string, workDir: string, mailboxPath: string, role?: string) {
    this.identity = new IdentityManager(sessionId, workDir, mailboxPath, role);
    this.channel = new ChannelManager(sessionId, this.identity, mailboxPath);
  }
  // ... rest unchanged ...
}
```

### Step 5: `src/context/parent-context.ts` — Read `getRole()` and pass it

```typescript
import { getRole } from '../config.js';
// ...

constructor(sessionFilePath: string) {
  // ... existing ...
  const peerSessionId = getSessionId(sessionFilePath);
  const peerWorkDir = process.cwd();
  const peerMailboxPath = path.resolve(getSessionDir(peerSessionId), 'unread-lead.jsonl');
  this.peerModule = new PeerManager(peerSessionId, peerWorkDir, peerMailboxPath, getRole());
}
```

### Step 6: Fix corrupted v2 message text (`.mycc/conditions.json`)

Manually edit `.mycc/conditions.json` to restore the correct message text
from the v1 history entry (`"ask the user — briefly — whether to:"` instead
of `"ask the user choice to:"`). Then run `skill_compile(name="learn-from-past")`
to produce a clean v3.

### Step 7: Create `skills/skill-manager/SKILL.md`

```markdown
---
name: skill-manager
description: >
  Background skill-management workflow for a headless mycc peer launched with
  --role skill-manager. Loaded via firstQuery when the lead agent spawns a
  skill-manager to process accumulated .mycc/lfplater/ files. Reviews each
  lfplater file, searches for existing skills via skill_search, creates new
  skills (via create-skill workflow) or optimizes existing ones (via
  edit_file), merges duplicated skills, and reports completion back to the
  lead via mail_to. Inspired by Hermes (Nous Research) closed learning loop.
  Runs autonomously in --auto mode with no human at the terminal.
keywords: [skill-manager, lfplater, background, autonomous, headless, hermes,
  skill, create, optimize, merge, review, mail_to, cross-instance, peer,
  closed-learning-loop]
---

# Skill Manager (Background Peer Workflow)

## Purpose

You are a headless mycc peer spawned by the lead agent to act as a
skill-manager. Your job: process accumulated `.mycc/lfplater/` files,
turning captured experiences into reusable skills. You run autonomously
in `--auto` mode — no human is at your terminal.

## Reply Contract

When your work is complete, report results to the lead agent:

  mail_to(name="<leadSessionId>/lead", title="skill-manager report",
          content="summary of what you did")

The `leadSessionId` was provided in your `firstQuery`. Do NOT reply by
writing prose to your terminal — nobody is reading it. Use `mail_to`.

## Workflow

### Step 1: Scan lfplater directory

- List `.mycc/lfplater/` for pending `.md` files.
- If empty: mail the lead "no lfplater files to process" and finish.
- If files exist: read each one with `read_file`.

### Step 2: Process each lfplater file

For each file:

1. Extract the captured context: task, outcome, key files, approach,
   pitfalls, suggested skill name, suggested keywords.
2. Use `skill_search` with the suggested keywords to find existing skills.
3. Decide: create new or optimize existing?
   - **Existing relevant skill found**: `skill_load` it, analyze for gaps,
     use `edit_file` to add the new insight/pitfall/example.
   - **No relevant skill**: use the `create-skill` workflow
     (`skill_load(name="create-skill")`) to create a new skill in
     `.mycc/skills/` following its template and quality guidance.
4. After processing, delete the lfplater file (it's consumed).

### Step 3: Merge duplicated skills

After processing all files, scan `.mycc/skills/` for overlapping skills:

- Use `skill_search` with broad keywords to find similar skills.
- If two skills cover the same domain with clear overlap, merge them:
  - Keep the one with better structure/coverage.
  - Use `edit_file` to absorb unique content from the other.
  - Delete the redundant file.
- Be conservative — only merge when duplication is clear and unambiguous.

### Step 4: Report to lead

Mail the lead a summary:

  mail_to(name="<leadSessionId>/lead", title="skill-manager report",
          content="Processed N lfplater files. Created: X. Optimized: Y.
                  Merged: Z. Skipped (trivial): W. Details: ...")

Then you are done. The lead will `bg_remove` you.

## Guardrails

- **Do not create trivial skills** — if an lfplater file describes routine
  work, skip it and note it in the report.
- **Do not modify source code** — you only touch `.mycc/skills/` and
  `.mycc/lfplater/`.
- **Do not run indefinitely** — process the files, report, and stop.
- **Respect existing skill structure** — when optimizing, enhance; do not
  rewrite from scratch.
```

### Step 8: Extend `skills/learn-from-past/SKILL.md`

#### 8a: Update the "Hook Message" section

The injected REMINDER message is extended with explicit skill-manager
spawning instructions (per pitfall #1 — explicit instructions, not LLM
self-identification). The new message:

```
[REMINDER] A task was just reported complete (brief confidence=10). The
experience you just built is valuable and already yours — but it's easy to
lose once this context moves on.

You may offer the user a quick choice to preserve it. If the work taught
something worth reusing, ask the user — briefly — whether to:
1. **yes** — turn this success into a reusable skill (run
   `skill_load(name="learn-from-past")` for the full workflow)
2. **no** — continue without saving
3. **later** — defer for now; drop a pointer in `.mycc/lfplater/` to revisit
   later

This is entirely the user's call, and you are free to skip asking — for
example if the work was routine, the user is mid-flow, or they've already
declined a similar offer. Ask at most once per completed task.

---

**Skill-Manager Autospawn (if applicable):** If the user chose "later" (or
if `.mycc/lfplater/` already has pending files), AND this project's README.md
declares automatic skill maintenance (look for phrases like "automatically
maintains skills", "auto-improve skills", or similar intent), consider
spawning a background skill-manager peer to process the lfplater files
autonomously. First, check if a skill-manager is already running: call
`peers()` and look for an instance with role "skill-manager" in the same
working directory with a fresh heartbeat. If found, mail it the new work
instead of spawning a duplicate. If not found, spawn a new peer with
`bg_create(command="cd <workdir>; mycc --auto --role skill-manager
--skip-healthcheck")`, verify via `peers()`, then author a channel file pair
(see `skills/mediator/channel-files.md`) with a firstQuery instructing the
peer to `skill_load(name="skill-manager")`. After it reports back via
`mail_to`, tear it down with `bg_remove(pid)`. Only spawn if lfplater files
actually exist — do not spawn on an empty directory.
```

#### 8b: Add "Autonomous Skill-Manager" section

After the "lfplater File Format" section, add:

```markdown
## Autonomous Skill-Manager (Project-Level Opt-In)

### Opt-in Signal: README.md Declaration

When a project's README.md declares that it "automatically maintains its
skills" (or similar wording — "auto-improve skills", "self-improving
skills", etc.), the lead agent treats this as a standing instruction to
spawn a background skill-manager when lfplater files accumulate.

The README.md content is injected into the LLM context at every session
start via `triologue.setReadmeMd()` as a `[Project Context - README.md from
project root, FYI]` user/assistant pair. The hook message (injected on
`brief(confidence=10)`) explicitly instructs the agent to check for this
declaration — the agent does not need to self-identify the need (per the
LLM overconfidence pitfall, commit c9c4f7b).

### Discovery: Finding an Existing Skill-Manager

Before spawning, check if a skill-manager is already running for this
working directory:

1. Call `peers()` to list online instances.
2. Filter for entries where `role == "skill-manager"` AND `workDir` matches
   the current working directory AND the heartbeat is fresh.
3. If found: mail new work to it via
   `mail_to(name="<skillManagerSessionId>/lead", ...)` — do NOT spawn a
   duplicate.
4. If not found: proceed to spawn.

### Spawning Pattern (Cross-Instance Peer with --role)

The skill-manager is a **headless mycc peer** with `--role skill-manager`,
not a child teammate — for full autonomy (separate session, separate LLM
context, independent ESC/interrupt). The `--role` flag tags the peer's
identity.json entry so other MYCCs can discover it.

1. Launch a headless peer in the same working directory with --role:
   `bg_create(command="cd <workdir>; mycc --auto --role skill-manager --skip-healthcheck")`
2. Verify it is online: `peers()` — confirm the new peer appears with a
   fresh heartbeat and `role: "skill-manager"`.
3. Author a channel file pair (see `skills/mediator/channel-files.md` for
   the schema) with a `firstQuery` that:
   - Instructs the peer to `skill_load(name="skill-manager")`
   - Provides the lead's session-id for the reply contract
4. The peer's 5s channel poll delivers the `firstQuery` to its mailbox.
5. The peer loads `skill-manager`, processes lfplater files, and mails the
   report back via `mail_to(name="<leadSessionId>/lead", ...)`.
6. After receiving the report, tear down the peer: `bg_remove(pid=<pid>)`.

### Guardrails

- **Only spawn if lfplater files exist** — never spawn on an empty
  `.mycc/lfplater/` directory.
- **One skill-manager per working directory** — check `peers()` for an
  existing role-tagged instance before spawning. If found, mail it work
  instead.
- **Always tear down** — after the report arrives, `bg_remove` the peer.
- **Respect "no"** — if the user declined the 3-way choice with "no", do
  not spawn a skill-manager for that task. The autospawn only applies to
  the "later" path (or pre-existing lfplater files).
- **User can disable** — remove the README.md declaration to disable
  project-level auto-skill-maintenance. The opt-in is purely declarative.

### Why Cross-Instance (Not Child Teammate)

A child teammate shares the lead's session and LLM context — it competes
for attention and tokens. A cross-instance peer has its own session, its
own context budget, and its own ESC behavior. For background skill
maintenance that may involve reading multiple files, searching skills, and
writing new skills, a separate instance is the right isolation boundary.

This pattern is inspired by Hermes (Nous Research)'s closed learning loop:
autonomous skill creation after tasks, skill self-improvement during use,
and periodic knowledge persistence.

### The --role Flag (General Infrastructure)

The `--role` CLI flag is a **general mechanism** — not hardcoded to
"skill-manager". It adds an optional `role` field to the instance's
identity.json entry at registration time. Any future role ("reviewer",
"test-runner", "doc-writer") can use `--role <name>` with zero further code
changes. Productivity MYCCs run without `--role` (the field is absent from
their identity entry). This opens a frontier of role-tagged MYCC swarms
that collaborate via the existing cross-instance peer-discovery model.
```

#### 8c: Update Trigger section to v2 API

Replace the v1 `seq.*` references with the v2 `turn.*`/`session.*` API:

**BEFORE (v1, current):**
```
- `call.args.confidence == 10` — the agent reported 100% certainty
- `!seq.isPlanMode()` — not in plan mode
- `seq.totalCount() > 5` — at least 5 tool calls this session
- `seq.hasAny(['edit_file', 'write_file', 'bash'])` — real work tools this turn
```

**AFTER (v2, target):**
```
- `call.args.confidence == 10` — the agent reported 100% certainty
- `!isPlanMode()` — not in plan mode
- `session.count() > 5` — at least 5 tool calls this session
- `turn.count('edit_file') > 0 || turn.count('write_file') > 0 || turn.count('bash') > 0` — real work tools this turn
```

---

## File Dependency Graph

```
Step 1 (config.ts)      ─┐
Step 2 (types.ts)        ─┤── Source code: --role plumbing (independent of skill layer)
Step 3 (identity.ts)    ─┤
Step 4 (peer.ts)        ─┤
Step 5 (parent-context) ─┘

Step 6 (conditions.json) — independent (bug fix)
Step 7 (skill-manager)   — independent (new skill)
Step 8a (hook message)   ─┐
Step 8b (autonomous sec) ─┤── All edit learn-from-past/SKILL.md (different sections)
Step 8c (API docs)       ─┘   8b depends on Step 7 (references skill-manager)

After Step 8a: re-compile learn-from-past via skill_compile
```

**Recommended execution order:**
1. Steps 1-5 (source code, `--role` plumbing)
2. Step 6 (fix conditions.json)
3. Step 7 (create skill-manager)
4. Steps 8a → 8b → 8c (extend learn-from-past)
5. Re-compile `learn-from-past` via `skill_compile`

---

## Testing

- **`--role` plumbing**: Launch `mycc --auto --role skill-manager --skip-healthcheck`,
  check `peers()` output shows the role field. Verify a plain `mycc` (no `--role`)
  has no role field in identity.json.
- **Peer tests**: Existing `src/tests/peer/peer.test.ts` needs updating to
  pass the new `role?` constructor param (optional, so existing tests pass
  unchanged, but add a test for role-tagged registration).
- **End-to-end**: With README.md declaring auto-maintenance and lfplater files
  present, trigger `brief(confidence=10)` and verify the hook message includes
  the skill-manager spawning instructions.