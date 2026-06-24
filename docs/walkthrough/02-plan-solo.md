# Walkthrough: Plan Solo Mode

> *A walkthrough of the mycc agent loop in plan mode — where the agent plans without touching code.*

---

## Prologue: Entering Plan Mode

The user wants to explore before committing to changes. They type:

```
agent >> /mode plan
```

The **SLASH** state intercepts this — the LLM never sees it. The `/mode` command routes to a handler that:

1. Sets the mode to `'plan'`
2. Changes the prompt from `agent >>` (yellow background, black text) to `plan >>` (blue background, white text)
3. Swaps the system prompt to the plan mode variant

The user can also enter plan mode via:
- `/plan on` — a dedicated slash command
- The `plan_on` tool (used by the LLM itself, with an optional `allowed_file` parameter)

Now the prompt shows:

```
plan >> I need to understand the project structure before making changes
```

---

## Act 1: The Plan Mode System Prompt

When the LLM is called in plan mode, it receives a different system prompt.

### What's Different

| Aspect | Normal Mode | Plan Mode |
|--------|-------------|-----------|
| **Prompt prefix** | `agent >>` (yellow bg, black text) | `plan >>` (blue bg, white text) |
| **Mission** | "Use tools to finish tasks" | "Produce a single, clear, actionable plan" |
| **Code changes** | Allowed | **Prohibited** |
| **Tool access** | All 30+ tools | Read-only subset |
| **Bash commands** | Full execution | READ/TEST verbs only |
| **Confusion scoring** | Standard | +1 per assistant turn |
| **LLM thinking** | `think: false` | `think: true` |

### The Plan Mode Instructions

The system prompt tells the LLM:

> *You are in PLAN MODE. Your goal is NOT to implement, but to:*
> 1. *Understand the problem thoroughly by exploring the codebase*
> 2. *Clarify assumptions and ambiguities with the user*
> 3. *Produce a SINGLE, CLEAR, ACTIONABLE plan with specific implementation steps*

It also includes a specific exit workflow:

> *1. **Show your plan FIRST** — End your turn WITHOUT using any tools*
> *2. **Then use plan_off** — After the user acknowledges your plan*

### The `allowed_file` Feature

The `plan_on` tool supports an `allowed_file` parameter. If specified, the user is asked:

```
Allow edits to this file during plan mode?
  - Press Enter or type 'y'/'yes' to allow this file
  - Type 'n'/'no' to enter strict plan mode (no files allowed)
  - Or type a different file path to allow that file instead
```

This is useful for updating a planning document (like `docs/plan.md`) while remaining in plan mode.

---

## Act 2: COLLECT — Same Pipeline, Faster Confusion

The COLLECT state runs the same pipeline as normal mode:
- Mail collection (usually empty in solo)
- Hint round check (confusion ≥ 10)
- Todo nudge (every 3 turns)
- Brief nudge (every 5 turns)
- Proactive skill discovery

But the **confusion index climbs faster**. In the HOOK state, every assistant turn adds **+1** to confusion when in plan mode:

```typescript
// From hook.ts — confusion scoring
if (ctx.core.getMode() === 'plan') {
  ctx.core.increaseConfusionIndex(1);
}
```

In plan mode, the agent can't take productive action (write files, run builds). It can only read and explore. The system accelerates the confusion clock, so **hint rounds fire sooner** — the agent gets guidance more frequently.

---

## Act 3: LLM — Exploration Mode

The LLM receives the plan mode system prompt and adapts its behavior.

### What the LLM Does

Instead of writing code, the LLM focuses on exploration:

1. **Reads files** with `read_file` to understand existing code
2. **Searches** with `grep` for patterns and references
3. **Explores** the mindmap with `recall` for project knowledge
4. **Searches the web** with `web_search` for documentation
5. **Creates todos** with `todo_create` to track planning items
6. **Uses `plan_on`** to enter plan mode with an allowed file

### What the LLM Cannot Do

The following operations are **blocked** in plan mode:

| Operation | Tool | What Happens |
|-----------|------|-------------|
| Write files | `write_file` | Grant system rejects: "Plan mode is ACTIVE" |
| Edit files | `edit_file` | Grant system rejects: "Plan mode is ACTIVE" |
| Destructive bash | `bash` with WRITE/EDIT/DELETE/BUILD/INSTALL | Bash judge rejects: "Cannot WRITE in plan mode" |
| Interactive terminal | `hand_over` | Blocked |

### Crossroad Still Works

The **crossroad** system still operates in plan mode. If the LLM's response contains turning words like "However," or "But,", the system generates alternative continuations. This is useful in plan mode because the agent is exploring multiple approaches — crossroad helps it decide which path to investigate further.

### LLM Thinking

In plan mode, the LLM call uses `think: true`, which enables the model's internal reasoning (chain-of-thought) before producing its response.

---

## Act 4: HOOK — The Plan Mode Enforcer

The HOOK state is where plan mode restrictions are enforced.

### Confusion Scoring

The HOOK state adds **+1 to confusion** per assistant turn in plan mode. This is the primary mechanism that ensures hint rounds fire during long exploration sessions.

### Hook Conditions

Hooks that normally trigger on code changes (like `lint-after-edit`, `test-after-edit`) are **inactive** in plan mode — there's nothing to commit. Hooks that need to check plan mode can use `seq.isPlanMode()` in their conditions.

### The Grant System's 5-Step Judging

The **5-step bash judging process** is the core enforcement mechanism. In plan mode, step 4 becomes a hard gate:

1. **Dangerous patterns**: Same checks (rm -rf, sudo, etc.) — unchanged
2. **Intent grammar**: Same validation — unchanged
3. **Missing intent**: Same check — unchanged
4. **Mode + verb check**: If mode is `plan` and verb is `WRITE`, `EDIT`, `DELETE`, `BUILD`, or `INSTALL`, the command is **immediately rejected** with:
   > `Cannot WRITE in plan mode. Verb "WRITE" modifies state. Switch to normal mode first or use a read-only verb like [READ] or [TEST].`
5. **LLM analysis**: Only for `RUN` verb in plan mode — LLM determines if the command is read-only or modifies state
6. **User prompt**: Only for uncertain `RUN` commands

For file operations (`write_file`, `edit_file`), the **grant-evaluator** checks plan mode separately:

```typescript
if (mode === 'plan') {
  const allowedFile = core.getAllowedFile();
  if (request.path && allowedFile && resolvedRequested === resolvedAllowed) {
    return { approved: true }; // Allowed file exception
  }
  return { approved: false, reason: 'Plan mode is ACTIVE - code changes are temporarily restricted.' };
}
```

---

## Act 5: TOOL — Read-Only Execution

Tool execution in plan mode is straightforward — only read-only tools succeed.

### What Works

```typescript
// Reading files — works
read_file({ path: "src/math.ts" })

// Searching — works
grep({ pattern: "fibonacci" })

// Knowledge — works
recall({ path: "/" })
wiki_get({ query: "project structure", domain: "project" })

// Planning — works
todo_create({ name: "Plan fibonacci implementation" })
issue_create({ title: "Add fibonacci", content: "..." })

// Read-only bash — works (with READ verb)
bash({ command: "ls src/", intent: "READ SOURCE TO explore structure" })
```

### What Fails

```typescript
// Writing — blocked
write_file({ path: "src/math.ts", content: "..." })
// Error: Plan mode: code changes are prohibited

// Editing — blocked
edit_file({ path: "src/math.ts", old_text: "...", new_text: "..." })
// Error: Plan mode: code changes are prohibited

// Destructive bash — blocked
bash({ command: "npm install lodash", intent: "INSTALL DEPENDENCY TO add lodash" })
// Error: Cannot INSTALL in plan mode. Verb "INSTALL" modifies state.
```

### Confusion Scoring in TOOL State

The TOOL state also contributes to confusion scoring:

- **Exploration tools** (`read_file`, `grep`, `web_search`, etc.): No change to confusion
- **Action tools** (`todo_create`, `issue_create`, etc.): Reduce confusion (progress being made)
- **Repetition**: Same tool repeatedly → +1 confusion
- **Errors**: Tool returns error → +2 confusion

In plan mode, since the agent mostly uses exploration tools, confusion doesn't decrease as much as in normal mode. Combined with the +1 per assistant turn from HOOK, the confusion index climbs steadily, ensuring hint rounds fire regularly.

---

## Act 6: STOP — Planning Complete

The STOP state runs normally:
- **Letter box** displays the LLM's final analysis in a green-bordered box
- **Team await** is a no-op in solo mode
- The machine returns to PROMPT

But the prompt is still `plan >>` — the agent remains in plan mode until explicitly exited.

---

## Exiting Plan Mode

The user can exit plan mode via:
- `/mode normal` — slash command (immediate, no confirmation)
- `/plan off` — alias for the above
- The `plan_off` tool (used by the LLM)

### The Confirmation Guard

When the LLM uses `plan_off`, it requires **explicit user confirmation** `[y/N]`:

```
Exit plan mode and allow code changes? [y/N]
```

Only `y` or `yes` grants permission. Any other response (including Enter) keeps the agent in plan mode. This prevents the agent from accidentally switching modes and making changes without the user's knowledge.

The `plan_off` tool is **idempotent** — calling it when already in normal mode simply returns success without prompting.

### The Two-Step Exit Protocol

The plan mode system prompt teaches the LLM a specific exit workflow:

1. **Show your plan FIRST** — End the turn without using any tools, presenting the complete plan
2. **Then use plan_off** — After the user acknowledges the plan, request to exit

This ensures the user always sees and approves the plan before the agent starts implementing.

---

## Conversation Example: A Realistic Plan Mode Session

Here's what a typical plan mode conversation looks like:

```
agent >> /mode plan
[Prompt changes to blue: plan >>]

plan >> I need to add a fibonacci function. Let me explore first.

plan >> read_file({ path: "src/math.ts" })
[System reads the file]

plan >> grep({ pattern: "fibonacci" })
[System searches — no results]

plan >> Let me check the project structure.

plan >> bash({ command: "ls src/", intent: "READ SOURCE TO explore structure" })
[System lists files]

plan >> I see the project structure. Here's my plan:

I will add a fibonacci function to src/math.ts. The implementation will:
1. Add a `fibonacci(n: number): number` function
2. Handle edge cases (n <= 0, n === 1)
3. Export the function from the module

Shall I proceed with this plan?

plan >> plan_off()
[System asks:] Exit plan mode and allow code changes? [y/N]
[User types:] y

[Prompt changes to yellow: agent >>]
agent >> Great, let me implement the fibonacci function.
```

---

## Epilogue: When to Use Plan Mode

Plan mode is ideal for:

- **Codebase exploration**: Understanding unfamiliar code before making changes
- **Architecture planning**: Designing a solution before implementing
- **Debugging investigation**: Reading logs, tracing code paths
- **Documentation review**: Reading existing docs without editing
- **Teaching scenarios**: When the user wants to learn without the agent making changes

By removing the ability to write code, the agent concentrates on understanding, analyzing, and planning. The faster confusion clock ensures the agent doesn't get stuck in an endless exploration loop.

---

## State Machine Diagram

The same 6-state machine runs in plan mode, with plan-specific behavior in each state:

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

In plan mode:
- **PROMPT**: Shows `plan >>` (blue bg, white text) instead of `agent >>`
- **SLASH**: `/mode plan` and `/plan on` enter plan mode; `/mode normal` and `/plan off` exit it
- **COLLECT**: Same pipeline, but confusion climbs faster
- **LLM**: Uses plan mode system prompt with `think: true`
- **HOOK**: Grant system rejects WRITE/EDIT/DELETE/BUILD/INSTALL verbs
- **TOOL**: Only read-only tools succeed
- **STOP**: Normal, but prompt stays `plan >>`

---

## Glossary

See [glossary.md](glossary.md) for definitions of terms used in this walkthrough.

---

*End of Walkthrough 2: Plan Solo Mode*
