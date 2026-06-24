# Walkthrough: Normal Solo Mode

> *A walkthrough of the mycc agent loop — how a single LLM agent takes a user request, moves through 6 states, and delivers results.*

---

## Prologue: The Prompt

The terminal shows `agent >>` (yellow background, black text). The user types:

```
agent >> add a fibonacci function to src/math.ts
```

And presses Enter. This starts the agent loop.

---

## State 1: PROMPT

The state machine is in **PROMPT** state, waiting for user input. When the user submits:

1. **`markPromptBoundary()`** is called on the `Sequence` — clears the per-turn events array, defining a clean turn boundary. The session-level `totalEventsCount` is preserved.
2. The input is checked for **slash commands** (`/mode`, `/plan`, `/mindmap`, etc.) — if it starts with `/`, the machine transitions to **SLASH** state instead.
3. If the input starts with `!`, it's a **bang command** — the prompt switches to magenta `run cmd !` and the command runs directly in a tmux popup.
4. Otherwise, the query is stored in `TurnVars.lastUserQuery` and the machine transitions to **COLLECT**.

The PROMPT state is the only state that interacts with the human. Everything else is the LLM and tools working autonomously.

---

## State 2: COLLECT

Before the LLM sees the query, the system prepares context. The **COLLECT** state runs several checks:

### Mail Collection
If there are pending mails from teammates, they're collected and formatted for the LLM. In solo mode, this is usually empty.

### Hint Round Check
The **Confusion Index** is checked. This is a score tracked in `ctx.core` that measures how stuck the agent is:

| Event | Score Change |
|-------|:-----------:|
| Non-repeated action tool | -1 |
| Repeated action tool | +1 |
| Tool error | +2 |
| Repeated `mail_to` | +2 |
| Assistant turn (plan mode) | +1 |

If the score reaches **10**, a **hint round** fires: the LLM is asked to analyze blockers and next steps, and the result is injected as a HINT note.

### Todo Nudge
Every **3 turns**, if there are open todos, the system reminds the LLM about them.

### Brief Nudge
Every **5 turns**, the system reminds the agent to use the `brief` tool with a confidence parameter.

### Proactive Skill Discovery
The system extracts **keywords** from the user query and searches for relevant skills. For "add a fibonacci function", it might find skills about `coding`, `typescript`, or `math`. These are loaded and made available to the LLM.

---

## State 3: LLM

Now the LLM is called. This is the most complex state.

### System Prompt Construction
A system prompt is built dynamically, containing:
- **Role definition**: "You are a coding agent..."
- **Mode-specific instructions**: Normal mode (all tools available) vs Plan mode (read-only)
- **Tool definitions**: All 30+ tools with descriptions and JSON schemas
- **Intent language table**: The VERB OBJECT TO PURPOSE format for bash
- **Project context**: README, mindmap instructions, pending hooks
- **Platform info**: Windows, PowerShell, path separators

### retryChat with escAware
The LLM call is wrapped in `escAware` — if the user presses **ESC**, the call is aborted immediately. The `retryChat` function handles retries with exponential backoff if the LLM fails to respond.

### Crossroad Detection
After the LLM responds, the **crossroad** system scans the output for **turning words** — phrases that signal uncertainty or a change in direction:

| Tier | Examples | Detection |
|------|----------|-----------|
| **Strong** | "Having said that", "On the other hand", "That being said" | Full phrase match |
| **Sentence-boundary** | "However,", "But,", "Although,", "Wait," | Word + comma at sentence start |
| **Special** | "但", "However" as interjection | Pattern-specific |

If a turning word is found:
1. **Truncate** the LLM response at the turning word
2. **Generate 3 alternative continuations** via `forkChat` (a single-turn side-chat):
   - **Go forward**: Continue the current approach
   - **Go backward**: Reconsider the approach
   - **Synthesize**: Combine both
3. **Select the best path** using another LLM call
4. **Inject the continuation** in the HOOK state via a synthetic `brief()` call

### Empty Response Handling
If the LLM returns nothing (no text, no tool calls), the system injects a synthetic `brief("Let me see what to do next.", 7)` call to nudge the LLM back into action, then retries.

---

## State 4: HOOK

Before any tool runs, the **HOOK** state evaluates all compiled hook conditions.

### Hook Evaluation
Each compiled hook has:
- **Trigger**: Which tool/event fires it (e.g., `git_commit`, `write_file`)
- **Condition**: A jsep AST expression evaluated against the `Sequence` (safe, no `eval`)
- **Action**: What to do — `inject_before`, `inject_after`, `block`, `replace`, `message`, or `compact`

For example, a `lint-after-edit` hook might:
- **Trigger**: `git_commit`
- **Condition**: `seq.has('edit_file') || seq.has('write_file')`
- **Action**: `block` — prevent the commit until lint passes

### Meta-Tool Dispatch
Two special tools — `checkpoint` and `recap` — are handled here, not in the regular TOOL state. They need access to the triologue, which is outside `AgentContext`. The HOOK state intercepts them and runs them directly.

### Crossroad Continuation Injection
If crossroad was triggered in the LLM state, the selected continuation is injected here as a synthetic `brief()` call, replacing the original tool calls. The flow goes to COLLECT so the LLM can regenerate tool calls.

### Compact Request
If a hook requests compaction (e.g., due to intent language confusion), the system compresses the conversation immediately and returns to COLLECT.

---

## State 5: TOOL

Now the LLM's tool calls are executed.

### Sequential Execution
Tool calls from the LLM response are executed **one at a time**, in order. Each tool:
1. Receives the `AgentContext` and its arguments
2. Runs its handler
3. Returns a result string

### escAware Wrapping
Each tool execution is wrapped in `escAware` — if the user presses ESC, remaining tool calls are skipped and the system enters **neglected mode**.

### Confusion Scoring
After each tool result, the confusion index is updated:
- **Exploration**: Using `read_file`, `grep`, `web_search` → no change
- **Action**: Using `write_file`, `edit_file`, `bash` → -1 if new, +1 if repeated
- **Error**: Tool returns error → +2

### Auto-Compact
After each tool result, the system checks if the token count exceeds `TOKEN_THRESHOLD` (default: 50000). If so:
1. The full conversation is saved to the triologue JSONL file
2. The LLM is called to **summarize** the conversation into a compact form
3. The summary replaces the verbose history as a `[Conversation compressed]` user/assistant pair

---

## State 6: STOP

After all tools execute (or are skipped due to ESC), the **STOP** state runs:

### Letter Box Display
The LLM's final reply is displayed in a **green-bordered letter box** (80 chars wide, Tailwind green-500 border, green-600 text) with a timestamp header.

```
.======================= 14:30:22 =======================.
I've added a fibonacci function to src/math.ts.
'========================================================='
```

### Team Await (Solo: No-op)
In solo mode, there are no teammates to wait for. But the system still checks — if teammates exist, it enters a **two-phase await**:
- **Phase 1**: Wait for working teammates to become idle
- **Phase 2**: Wait for idle teammates to shut down

### Return to PROMPT
The machine transitions back to **PROMPT**, the `agent >>` prompt reappears, and the cycle is ready to begin again.

---

## Interlude: ESC — The Emergency Brake

At any point during LLM or TOOL states, the user can press **ESC**. This triggers:

1. **LLM abort**: The current LLM call is terminated
2. **Tool skip**: Remaining tool calls are discarded
3. **Background wrap-up**: A quick text-only LLM call produces a summary response
4. **Grace period**: The wrap-up result waits 3 seconds — if the user types a new query within that time, the wrap-up is **rolled back** (truncated from the triologue). Otherwise, it's **committed** permanently.

This is **neglected mode** — the agent acknowledges the interruption and produces a concise response without executing any more tools.

---

## Data Flow: Three Tiers

Throughout this journey, data flows through three tiers:

| Tier | Scope | Contents |
|------|-------|----------|
| **MachineEnv** | Lifetime (once) | Triologue, AgentContext, HookExecutor, InputProvider |
| **TurnVars** | Per turn (PROMPT→STOP) | Last user query, nudge counters |
| **PassData** | Per pass (COLLECT→STOP) | Tool calls, assistant content, hook results, crossroad continuation |

The **MachineEnv** is constructed once when the agent starts. **TurnVars** reset at each PROMPT boundary. **PassData** resets at each COLLECT entry — meaning if crossroad triggers a regeneration, the PassData is fresh for the new pass.

---

## Conversation Log: A Realistic Example

Here's what a typical interaction looks like in the triologue. Each line is a message with its role:

```
[system]  (system prompt — 5000+ chars, not shown)
[user]    add a fibonacci function to src/math.ts
[assistant] I'll start by reading the existing file.
            tool: read_file("src/math.ts")
[tool]    (file contents...)
[assistant] I see the file. Let me add the fibonacci function.
            tool: edit_file("src/math.ts", ...)
[tool]    OK
[assistant] Let me verify.
            tool: bash("node -e \"...\"")
[tool]    55
[assistant] Done! The fibonacci function works correctly.
```

The triologue follows a strict role rotation: `system → user → assistant → tool → assistant → tool → ...`. Each assistant message can contain zero or more tool calls. Each tool call gets a separate tool response message.

---

## State Machine Diagram

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

- **Conversational turns**: PROMPT → ... → STOP → PROMPT (new turn, new TurnVars)
- **Pipeline passes**: COLLECT → LLM → HOOK → TOOL → COLLECT (multiple passes per turn)
- **Slash commands**: PROMPT → SLASH → PROMPT (same turn, no TurnVars reset)
- **STOP → COLLECT**: When teammates have pending questions or mail, or a timeout occurred

---

## Glossary

See [glossary.md](glossary.md) for definitions of terms used in this walkthrough.

---

*End of Walkthrough 1: Normal Solo Mode*
