# Auto Mode Design Document

> **Status**: Complete | **Target**: < 300 lines ✓ (~280 lines)

---

## 1. Overview

Auto mode enables autonomous operation without waiting for user input between turns. Uses `AutonomousProvider` which returns `null` from `getInput()`, causing the state machine to skip prompts and continue the COLLECT → LLM → HOOK → TOOL cycle automatically.

**Goals**: Unattended operation, smart auto-replies, safe interrupts (ESC/Ctrl+C), predictable behavior.

**Non-Goals**: NOT "fire and forget" (user should monitor), NOT for production, NOT full autonomy (destructive actions still need confirmation).

---

## 2. User Experience

### 2.1 Prompt States

| Mode | Prompt |
|------|--------|
| Normal | `agent >>` |
| Plan | `plan >>` |
| Auto | `(auto) >>` |

### 2.2 Entering Auto Mode

**Command**: `/mode auto`

**Flow**:
1. User types `/mode auto`
2. Prompt changes to `(auto) >>`
3. System waits for user input (not yet running)
4. User types task description and submits
5. Auto loop starts - agent works autonomously

**Empty Input**: If user just hits Enter, treat as no effect (stay in auto mode, still waiting).

**Slash Commands in Auto Mode Prompt**:
- `/help` - show help, stay in auto mode prompt
- `/mode normal` - switch to normal mode, prompt → `agent >>`
- `/mode plan` - switch to plan mode, prompt → `plan >>`
- Any other slash command - execute, stay in auto mode prompt

### 2.3 During Auto Run

**While Agent is Working**:
- Agent runs COLLECT → LLM → HOOK → TOOL loop continuously
- No user input expected during this phase
- Console shows tool outputs, LLM responses

**User Presses ESC**:
- Agent pauses at next safe checkpoint (after current tool/LLM call)
- Prompt returns: `(auto) >>`
- User can type commands or just hit Enter to continue

**After ESC**:
| User Action | Effect |
|-------------|--------|
| Hit Enter | Resume auto run (continue loop) |
| Type task | Replace current goal, continue loop |
| `/mode normal` | Exit auto mode, prompt → `agent >>` |
| `/mode plan` | Switch to plan mode, prompt → `plan >>` |
| Other slash commands | Execute, stay in auto mode |

### 2.4 Exiting Auto Mode

**Ways to Exit**:
1. `/mode normal` - explicit switch to normal mode
2. `/mode plan` - explicit switch to plan mode
3. Task completion - agent finishes and returns to auto prompt (still in auto mode)

**Note**: Task completion does NOT exit auto mode. User must explicitly switch modes to return to `agent >>`.

### 2.5 Flow Example

```
User: /mode auto
System: (auto) >>
User: Fix the bug in auth.ts
System: [auto run: tool outputs, LLM responses...]
User: ESC
System: (auto) >>
User: Enter
System: [auto run continues...]
User: ESC
User: /mode normal
System: agent >>
```

### 2.6 Visual Feedback

**Prompt Prefix**:
- `(auto) >>` - Clear visual indicator that auto mode is active
- Applies both when waiting for input AND after ESC during auto run

**Console During Auto Run**:
- Tool outputs shown normally
- Status line: `[LLM thinking...]` or `[Tool executing: <name>]`
- No blocking prompts

### 2.7 Important Constraints

- Auto mode can ONLY be activated by user via `/mode auto` command
- The agent itself cannot enter auto mode autonomously
- No CLI flag for auto mode (user must explicitly invoke)
- Empty input (just Enter) has no effect - stays in auto mode waiting

---

## 3. Auto-Reply Mechanisms

### 3.1 Three-Tier Strategy

| Priority | Type | Use Case | Example |
|----------|------|----------|---------|
| 1 | Programmatic | Simple patterns | `[y/N]` → `yes` |
| 2 | Domain-specific | Tmux, grants | "Kill session?" → `no` |
| 3 | LLM-generated | Complex questions | "Which file?" → LLM decides |

### 3.2 Programmatic Patterns

| Pattern | Auto-Reply |
|---------|------------|
| Confirmation `[y/N]` | `yes` |
| Binary choice `[1/2]` | First option |
| Retry prompt | `retry` |
| Abort prompt | `abort` |

### 3.3 Tmux Auto-Reply

| Interaction | Auto-Action |
|-------------|-------------|
| Create session? | `yes` |
| Attach to existing? | `yes` (if match) |
| Kill session? | `no` |
| Session name? | Auto-generate |

### 3.4 Implementation

```typescript
class AutoReplyProvider extends AutonomousProvider {
  getAutoReply(question: string): string | null {
    if (this.isConfirmation(question)) return 'yes';
    if (this.isRetryPrompt(question)) return 'retry';
    return null; // Fall back to LLM
  }
}
```

---

## 4. Interrupt Handling

### 4.1 ESC (Soft Interrupt)

**Purpose**: Get hold of the prompt - user regains control while children continue working.

**Behavior**:
- ESC pressed → Coordinator sends `neglection` IPC to Lead
- Lead's LLM call aborted, neglected mode activated
- **Children are NOT interrupted** - they continue working
- Output buffering activated (logs queued)
- User gets prompt back, can review and type commands

**This is intentional**: Children keep working in background while user interacts with Lead.

### 4.2 ESC vs Ctrl+C

| Aspect | ESC | Ctrl+C |
|--------|-----|--------|
| Purpose | Get prompt back | Exit application |
| Lead | Pauses, enters neglected mode | Killed |
| Children | **Continue working** | Killed |
| Recovery | Resume with `continue` | Restart required |

### 4.3 Edge Cases

| Case | Problem | Solution |
|------|---------|----------|
| Grant timeout | 5s timeout, Lead slow | Auto-approve in auto mode |
| Lost IPC | Parent crash, child hangs | Child timeout (30s) |

---

## 5. Implementation Details

### 5.1 All Interaction Points

| File | Function | Auto-Mode Action |
|------|----------|------------------|
| `src/tools/question.ts` | `questionTool` | Auto-reply via provider |
| `src/tools/git_commit.ts` | `[y/N]` confirm | Auto-approve |
| `src/tools/hand_over.ts` | `[y/N]` session | Skip or auto-close |
| `src/loop/input-provider.ts` | `UserInputProvider` | **SWAP** to AutonomousProvider |
| `src/loop/agent-io.ts` | `ask()` | Bypass in auto mode |
| `src/setup/wizard.ts` | `runWizard()` | Skip or use defaults |
| `src/slashes/load.ts` | `/load` | Auto-continue |
| `src/loop/agent-repl.ts` | Health check | Auto-retry |

### 5.2 change_mode Tool

**Purpose**: Allow the LLM to switch between normal and plan modes programmatically.

**Scope**: Main process only. Cannot switch to/from auto mode.

**Interface**:
```typescript
{
  name: 'change_mode',
  scope: 'main',
  parameters: { mode: { type: 'string', enum: ['normal', 'plan'] } }
}
```

**Behavior**:
| Current | Target | Result |
|---------|--------|--------|
| normal | plan | ✓ Switch |
| plan | normal | ✓ Switch |
| auto | any | ✗ Error |
| any | auto | ✗ Error |

**Use Cases**: LLM decides to switch to plan mode for analysis, or back to normal for implementation.

### 5.2 Child-Main IPC

**Architecture**: `Terminal → Coordinator → Lead → Teammates`

**Question Flow**:
```
ChildCore.question() → IPC 'question' → pendingQuestions[]
  → handleCollect() → handlePendingQuestions() → ctx.core.question() → USER
  → IPC 'question_result' → Child
```

**Key**: Questions are QUEUED, only processed at COLLECT state.

**Grant Flow** (5s timeout!):
```
ChildCore.requestGrant() → evaluateGrant() → approve/deny
```

### 5.3 State Variables

```typescript
// AgentIO
neglectedModeFlag: boolean;
llmAbortController: AbortController | null;

// MachineEnv
inputProvider: InputProvider;  // UserInputProvider | AutonomousProvider

// Core
modeState: 'plan' | 'normal' | 'auto' = 'normal';
```

### 5.4 Event Loop

**Normal**: `PROMPT → [user input] → COLLECT → LLM → HOOK → TOOL → PROMPT`

**Auto**: `PROMPT → [null] → COLLECT → LLM → HOOK → TOOL → COLLECT` (loops until ESC or completion)

---

## 6. Integration Points

### 6.1 Entry/Exit

**Entry**: `/mode auto` command only.
- No CLI flag
- Agent cannot self-activate
- User must explicitly invoke

**Exit**: `/mode normal`, `/stop`, or task completion.

### 6.2 Implementation Checklist

| Priority | File | Change |
|----------|------|--------|
| **P1** | `src/loop/input-provider.ts` | Add `AutoReplyProvider` with pattern matching |
| **P1** | `src/tools/change_mode.ts` | **New tool** - switch between normal/plan (main scope only) |
| **P2** | `src/context/parent/grant.ts` | Auto-approve in auto mode |
| **P2** | `src/context/parent/core.ts` | Add `'auto'` to mode type |
| **P2** | `src/tools/git_commit.ts` | Auto-approve in auto mode |
| **P2** | `src/tools/hand_over.ts` | Skip or auto-close session |
| **P3** | `src/context/child/core.ts` | Add question timeout (30s) |
| **P3** | `src/slashes/mode.ts` | Add `auto` as third mode option |

**Entry Point**: `/mode auto` command only - no CLI flag, agent cannot self-activate.

**Child Process Behavior**: ESC only interrupts Lead; children continue working. This is intentional - user gets prompt back while background work continues.

---

## Revision History

| Date | Changes |
|------|--------|
| 2026-04-29 | Initial structure, all sections, child IPC analysis, interaction inventory |