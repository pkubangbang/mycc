# Walkthrough: Normal Team Mode

> *A walkthrough of mycc's team mode — how the lead agent spawns teammate agents, how they communicate, and how parallel work gets done.*

---

## Prologue: The Lead Decides to Delegate

The user types a complex request:

```
agent >> refactor the project: extract the math utilities into a separate module, 
         add tests, and update all imports
```

The lead agent (the main LLM process) considers this. It's three tasks:
1. Extract math utilities
2. Add tests
3. Update imports

These are **independent** — they can be done in parallel. The lead decides to spawn teammates.

---

## Act 1: Spawning Teammates

The lead calls `tm_create`:

```typescript
tm_create({
  name: "extractor",
  role: "developer",
  prompt: "You are a developer. Claim issue #1 and extract math utilities..."
})

tm_create({
  name: "tester",
  role: "tester",
  prompt: "You are a tester. Claim issue #2 and write tests..."
})

tm_create({
  name: "importer",
  role: "developer",
  prompt: "You are a developer. Claim issue #3 and update imports..."
})
```

### What Happens Under the Hood

The `TeamManager.createTeammate()` method:

1. **Spawns a child process** via `spawnTsx()` — a helper that runs `npx tsx` on the teammate worker script
2. **Sets up IPC** via `child_process.fork()` — message passing between parent and child
3. **Creates a mailbox** — a file-based append-only JSONL file at `.mycc/mail/{name}.jsonl`
4. **Registers the teammate** in the in-memory store with status `'working'`
5. **Sends the initial prompt** as the first message in the mailbox

Each teammate runs its own **autonomous agent loop** with:
- **ChildContext**: A restricted version of AgentContext where write operations go through IPC to the parent
- **silentLoader**: A Loader instance that suppresses non-critical warnings
- **Child scope tools**: A subset of tools (no `tm_create`, `tm_remove`, `tm_await`, `broadcast`, `order`, `hand_over`, `plan_on/off`)

---

## Act 2: The Teammate's Autonomous Loop

Each teammate runs a simplified while-true loop (not the lead's 6-state machine). The loop has these phases:

```
┌─────────────────────────────────────────────────────────────┐
│                    Teammate Loop                            │
│                                                             │
│  1. Collect mail from file-based mailbox                     │
│  2. Check for mode change notifications                     │
│  3. Todo nudging (every 3 turns)                            │
│  4. Time reminder (every 3 rounds if budget set)             │
│  5. Build system prompt → Call LLM                          │
│  6. Execute tool calls (one by one)                         │
│  7. Check confusion index (≥10 → mail lead for help)        │
│  8. Brief nudging (every 5 turns)                           │
│                                                             │
│  If no tool calls produced:                                 │
│    → Enter IDLE state (poll for mail + auto-claim issues)   │
└─────────────────────────────────────────────────────────────┘
```

### Key Differences from the Lead

| Aspect | Lead Agent | Teammate Agent |
|--------|-----------|----------------|
| **State machine** | 6-state (PROMPT→COLLECT→LLM→HOOK→TOOL→STOP) | Simplified while-true loop |
| **Input source** | Human user via LineEditor | Mailbox polling |
| **Tool scope** | Full (`main`) | Restricted (`child`) |
| **Write operations** | Direct filesystem access | Via IPC to parent |
| **Idle behavior** | N/A (always waiting for user) | Polls mail + auto-claims issues |
| **Heartbeat** | N/A | Every 30 seconds to lead |
| **Error handling** | Retry prompt on crash | Log and continue (never crash) |

### No User Input
The teammate has no human user. Its "prompt" comes from the mailbox. In the PROMPT state, it checks for new mail instead of waiting for keyboard input.

### Restricted Tools
Teammates cannot:
- Spawn their own teammates (`tm_create`, `tm_remove`, `tm_await`)
- Broadcast to the team (`broadcast`)
- Use `order` (combined mail_to + await)
- Open interactive terminals (`hand_over`)
- Switch modes (`plan_on`, `plan_off`)

If a teammate needs these, it must **request via mail_to to the lead**.

### IPC for Write Operations
When a teammate calls `write_file` or `edit_file`, the operation goes through IPC:
1. Teammate sends a `sendRequest` to the parent
2. Parent evaluates the **grant system** (worktree ownership, mode check)
3. Parent executes the operation and sends the result back
4. Teammate receives the response and continues

### Auto-Claim
When idle, teammates automatically claim unassigned issues. The **auto-claim** system polls every **5 seconds** (`POLL_INTERVAL = 5000ms`) for issues matching:
- Status: `pending`
- No owner
- No blockers

When found, the teammate calls `issue_claim(id, owner)` atomically and starts working.

### Heartbeat
Every **30 seconds**, a working teammate sends a heartbeat to the lead via IPC:

```
[PROGRESS] 45s elapsed, still working.
```

This lets the lead know the teammate is alive and making progress.

---

## Act 3: Assigning Work via Issues

The lead creates issues for each task:

```typescript
issue_create({ title: "Extract math utilities", content: "Move math functions to src/math/" })
issue_create({ title: "Add tests for math module", content: "Write unit tests..." })
issue_create({ title: "Update imports", content: "Update all files that import math functions..." })
```

Then assigns them:

```typescript
issue_claim({ id: 1, owner: "extractor" })
issue_claim({ id: 2, owner: "tester" })
issue_claim({ id: 3, owner: "importer" })
```

And notifies via mail:

```typescript
mail_to({
  name: "extractor",
  title: "Issue #1 assigned to you",
  content: "You own issue #1: Extract math utilities to src/math/..."
})
```

### Issue Lifecycle

Each issue goes through a clear lifecycle:

```
pending → in_progress → completed
                        → failed
                        → abandoned
```

Issues can also have **blocking relationships**:

```typescript
issue_create({ title: "Refactor math utils", blockedBy: [1] })
// This issue can't be claimed until issue #1 is completed
```

When a blocker is closed, dependent issues become unblocked automatically.

### The Mail System

Mail is **file-based** — each agent has a JSONL file at `.mycc/mail/{name}.jsonl`. Messages are appended as JSON lines with:
- `id`: Unique message ID
- `from`: Sender name
- `title`: Subject
- `content`: Body
- `timestamp`: ISO date

The recipient checks their mailbox at the start of each loop iteration via `collectMails()`. `collectMails()` reads the file, truncates it (atomic read-and-clear), and returns the messages. The messages are injected into the triologue as `MAIL` notes.

---

## Act 4: Parallel Execution

Now three agents work simultaneously:

```
Lead:     [COLLECT] → [LLM] → [HOOK] → [TOOL] → [STOP] → [PROMPT]
                ↑
                | IPC
                ↓
Extractor: [COLLECT] → [LLM] → [HOOK] → [TOOL] → [STOP] → [PROMPT]
Tester:    [COLLECT] → [LLM] → [HOOK] → [TOOL] → [STOP] → [PROMPT]
Importer:  [COLLECT] → [LLM] → [HOOK] → [TOOL] → [STOP] → [PROMPT]
```

Each agent runs independently, with its own:
- **Triologue**: Separate conversation history
- **Mindmap**: Separate instance (`.mycc/mindmap-{name}.json`)
- **Confusion index**: Independent scoring
- **Tool execution**: Sequential within each agent

### Time Nudges

If a teammate has a budget (ETA deadline), the system sends **time nudges** every **3 rounds** reminding them of the remaining time. This prevents teammates from going down rabbit holes.

---

## Act 5: Communication Patterns

### mail_to — Async Messaging

The primary communication channel. Agents send async messages:

```typescript
// Teammate to lead
mail_to({
  name: "lead",
  title: "Progress on issue #1",
  content: "Extracted 3 math functions. Found a dependency on src/utils.ts — need to check if it's used elsewhere."
})

// Lead to teammate
mail_to({
  name: "extractor",
  title: "Re: dependency on src/utils.ts",
  content: "That dependency is only used in math functions. Include it in the extraction."
})
```

### broadcast — Team-Wide Announcements

For messages that everyone should see:

```typescript
broadcast({
  title: "All tasks complete — wrap up",
  content: "The refactoring is done. Please close your issues and prepare for review."
})
```

### order — Synchronous Task Assignment

The `order` tool combines `mail_to` + `tm_await` into a single call:

```typescript
order({
  name: "extractor",
  title: "Fix this specific file",
  content: "Edit src/math/fib.ts to add error handling..."
})
// Blocks until extractor completes
```

This is useful when the lead needs a specific task done before proceeding.

---

## Act 6: Monitoring and Awaiting

### Two-Phase Await

When the lead calls `tm_await()`, the system enters a **two-phase wait**:

1. **Phase 1** (working → idle): Wait for all working teammates to finish their current task. Subscribers are notified when a teammate transitions to idle.
2. **Phase 2** (idle → shutdown): Wait for idle teammates to shut down. This happens when they have no more work to do.

Each phase has a configurable timeout. If a teammate exceeds its ETA, the lead is notified.

### Issue Tracking

The lead can check progress anytime:

```typescript
issue_list()
// Issues:
//   [>] #1: Extract math utilities @extractor
//   [>] #2: Add tests for math module @tester
//   [>] #3: Update imports @importer
```

When a teammate completes an issue, they close it:

```typescript
issue_close({ id: 1, status: "completed", comment: "Extracted to src/math/", poster: "extractor" })
```

Closing a blocker automatically unblocks dependent issues.

---

## Act 7: Handling Problems

### Stuck Teammate

Each teammate tracks a **confusion index**:

| Event | Score Change |
|-------|-------------|
| Per assistant turn | +1 |
| Non-repeated action tool | -1 |
| Repeated action tool | +1 |
| Repeated mail_to | +2 |
| Tool returns error | +2 |

When the confusion index reaches **10**, the teammate sends a help request to the lead:

```
From: tester
Subject: Stuck - need guidance
Content: I'm stuck (confusion index: 10). The tests keep failing because 
         the math module exports changed. What should I test against?
```

The lead can then respond with guidance via `mail_to`.

### Missed Deadline

If a teammate exceeds its ETA, the lead is notified. The lead can:
- Extend the deadline via a new `mail_to` with updated ETA
- Reassign the work to another teammate
- Take over the task directly

### Non-Responsive Teammate

If a teammate stops responding, the lead can:
1. Check status with `tm_print`
2. Send a mail to check status
3. Force-remove with `tm_remove({ name: "tester", force: true })`

---

## Act 8: Collecting Results

When all teammates finish, the lead collects results:

```typescript
tm_await()  // Wait for all teammates

// Check results
issue_list()
// All issues should be closed

// Read final mails
// Teammates should have sent completion reports

// Clean up
tm_remove({ name: "extractor" })
tm_remove({ name: "tester" })
tm_remove({ name: "importer" })
```

The lead then reports to the user:

```typescript
brief({
  message: "Refactoring complete. Math utilities extracted to src/math/, tests added, imports updated.",
  confidence: 10
})
```

---

## Conversation Log: A Realistic Team Collaboration

The triologue for a team session shows messages from the lead, teammates, and system notes:

### Step 1: Lead spawns teammates and creates issues

```
[assistant] tm_create(name="extractor", role="dev", prompt="...")
[tool]    OK
[assistant] tm_create(name="tester", role="tester", prompt="...")
[tool]    OK
[assistant] issue_create(title="Extract math utils")
[tool]    Created issue #1
[assistant] issue_create(title="Add tests")
[tool]    Created issue #2
[assistant] issue_claim(id=1, owner="extractor")
[tool]    Claimed
[assistant] issue_claim(id=2, owner="tester")
[tool]    Claimed
```

### Step 2: Teammates auto-claim and start working

```
[user]    [MAIL] Mail from extractor: Starting work on issue #1
[assistant] (extractor's internal loop)
            tool: read_file("src/utils.ts")
[tool]    (file contents...)
[assistant] tool: write_file("src/math/index.ts", ...)
[tool]    OK
```

### Step 3: Teammate encounters a problem

```
[user]    [MAIL] Mail from tester: Stuck - need guidance
           "The tests keep failing because the math module exports changed."
[assistant] Let me check the situation.
            tool: mail_to(name="tester", content="The exports are finalized now.")
[tool]    OK
```

### Step 4: Teammate completes and reports

```
[user]    [MAIL] Mail from extractor: Issue #1 done
[user]    [MAIL] Mail from tester: Issue #2 done
[assistant] Let me collect the results.
            tool: tm_await()
[tool]    OK
[assistant] tool: issue_list()
[tool]    All issues closed
[assistant] Done! Let me report to the user.
            tool: brief("Refactoring complete.", 10)
[tool]    OK
```

In team mode, the triologue includes system-generated notes like `[MAIL]` (from teammates) and `[TEAM_STATUS]` (periodic status updates). The lead sees these as user-role messages and responds accordingly.

---

## Epilogue: The Architecture

### Process Model

```
┌─────────────────┐     IPC (fork)     ┌──────────────────┐
│   Coordinator   │◄──────────────────►│   Lead Agent     │
│  (src/index.ts) │                    │  (src/lead.ts)   │
└─────────────────┘                    └────────┬─────────┘
                                                │
                                    ┌───────────┼───────────┐
                                    │           │           │
                                    ▼           ▼           ▼
                            ┌──────────┐ ┌──────────┐ ┌──────────┐
                            │Teammate 1│ │Teammate 2│ │Teammate 3│
                            │(child)   │ │(child)   │ │(child)   │
                            └──────────┘ └──────────┘ └──────────┘
```

Three layers of processes:

1. **Coordinator** (`src/index.ts`): The parent process. Manages the Lead, forwards I/O between terminal and Lead, handles Ctrl+C/ESC, and detects directory changes for restart.

2. **Lead** (`src/lead.ts`): The main agent. Runs the 6-state machine, handles user interaction, spawns teammates, and collects results.

3. **Teammates** (`teammate-worker.ts`): Child processes. Each runs an autonomous loop with restricted tools and IPC-based write operations.

### Communication Flow

```
                    ┌─────────────────────────────────────┐
                    │         File System                 │
                    │  .mycc/mail/extractor.jsonl          │
                    │  .mycc/mail/tester.jsonl            │
                    │  .mycc/mail/importer.jsonl          │
                    └─────────────────────────────────────┘
                               ▲          │
                    mail_to    │          │  mail_to
                    (append)   │          │  (collect)
                               │          ▼
                    ┌─────────────────────────────────────┐
                    │         IPC Channel                 │
                    │  (child_process.fork)               │
                    │  - Write operations (write_file)    │
                    │  - Grant requests                   │
                    │  - Heartbeats                       │
                    │  - Status updates                   │
                    │  - Questions                        │
                    └─────────────────────────────────────┘
```

- **mail_to**: Async, file-based. The sender appends to a JSONL file; the recipient reads and clears it.
- **IPC**: Synchronous request-response. Used for write operations, grant requests, and status updates.
- **broadcast**: Sends the same mail to all teammates' mailboxes.
- **order**: mail_to + tm_await combined into one blocking call.

### Separate Mindmaps

Each agent has its own mindmap instance:
- Lead: `.mycc/mindmap.json`
- Teammate: `.mycc/mindmap-{name}.json`

This prevents race conditions on knowledge access. If teammates need to share knowledge, they use the **Wiki** (RAG) or `mail_to`.

### Key Design Decisions

1. **File-based mail over direct IPC**: Decouples agents — they don't need to be synchronized. Mail persists even if the recipient is busy.
2. **Two-phase await**: Prevents race conditions — the lead waits for work to complete before waiting for shutdown.
3. **Auto-claim**: Eliminates the need for explicit task assignment — idle teammates pick up work automatically.
4. **Child scope restrictions**: Teammates can't spawn their own teammates (prevents runaway processes). Write operations go through IPC (enforces worktree ownership).
5. **Confusion index with help request**: Teammates self-detect when they're stuck and escalate to the lead.

---

## State Machine Diagram

The lead runs the 6-state machine. Teammates run a simplified while-true loop.

### Lead's State Machine

```
        ┌────────────────────────────────────────────┐
        │                                            │
   ┌─── PROMPT ◄────────────────────┐               │
   │    │   ▲                       │               │
   │    ▼   │                       │               │
   │  SLASH─┘                       │               │
   │                                │               │
   │    ▼                           │               │
   │  COLLECT ◄─────── TOOL ─────┐ │               │
   │    │              ▲         │ │               │
   │    ▼              │         │ │               │
   │  LLM ────► HOOK ──┘       STOP ──────────────┘
   │                │              │           │
   │          has calls        no calls    has mail
   │                                        or question
   └── (pendingSlashQuery set by SLASH)
```

### Teammate's Loop

```
  [Collect Mail] → [LLM Call] → [Execute Tools] → [Check Confusion]
       │                                              │
       └── If no tools: enter IDLE state              │
           ├── Poll mailbox (5s)                       │
           ├── Auto-claim issues                      │
           └── Check shutdown flag                    │
                                                      │
              ┌───────────────────────────────────────┘
              │ (confusion ≥ 10)
              ▼
         mail_to(lead, "Stuck - need guidance")
```

---

## Glossary

See [glossary.md](glossary.md) for definitions of terms used in this walkthrough.

---

*End of Walkthrough 3: Normal Team Mode*
