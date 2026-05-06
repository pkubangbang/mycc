# Confusion Index v2 Design

## Overview

The Confusion Index is a built-in property of `ctx.core` that quantifies how "stuck" an LLM agent is. When the index reaches a threshold (default: 10), the agent requests help differently based on context:

- **Main process**: Triggers a hint round (LLM self-analysis)
- **Child processes**: Sends mail to lead requesting guidance

## Key Changes from v1

| Aspect | v1 | v2 |
|--------|----|----|
| Storage | `Triologue.confusion` | `ctx.core.confusionIndex` |
| Flag | `hintGenerated` boolean | No flag (use score reset) |
| Hint trigger | Check in `Triologue.needsHintRound()` | Check in agent loop |
| Child behavior | Same as main | Mail to lead |
| Brief tool | Optional parameter | Required `confidence` parameter |
| Nudge | None | Periodic reminder to use brief |

---

## Architecture

### Core Module API

The confusion index is a first-class property of `ctx.core`:

```typescript
interface CoreModule {
  // ... existing methods ...
  
  getConfusionIndex(): number;
  increaseConfusionIndex(delta: number): void;
  resetConfusionIndex(): void;
}
```

**Implementation** (in `BaseCore`):
```typescript
protected confusionIndex: number = 0;

getConfusionIndex(): number {
  return this.confusionIndex;
}

increaseConfusionIndex(delta: number): void {
  this.confusionIndex = Math.max(0, this.confusionIndex + delta);
}

resetConfusionIndex(): void {
  this.confusionIndex = 0;
}
```

---

## Scoring Formula

### Score Updates

The confusion index changes based on:

| Event | Delta | Rationale |
|-------|-------|-----------|
| Brief with confidence >= 8 | `8 - confidence` (negative) | High confidence reduces confusion |
| Brief with confidence < 8 | `8 - confidence` (positive) | Low confidence increases confusion |
| Action tool | -1 | Progress reduces confusion |
| Tool error | +2 | Obstacles increase confusion |
| Repetition | +1 | Loops increase confusion |

**Formula**: `delta = 8 - confidence`

| Confidence | Delta | Effect |
|------------|-------|--------|
| 10 | -2 | Reduces confusion |
| 9 | -1 | Reduces confusion |
| 8 | 0 | Neutral |
| 7 | +1 | Increases confusion |
| 6 | +2 | Increases confusion |
| 5 | +3 | Increases confusion |
| 4 | +4 | Increases confusion |
| 3 | +5 | Increases confusion |
| 2 | +6 | Increases confusion |
| 1 | +7 | Increases confusion |
| 0 | +8 | Increases confusion |

### Invariant

**The confusion index is always >= 0** (clamped on increase).

---

## Tool Classification

### Exploration Tools (No Score Change)

Read-only operations:

```
read_file, web_search, web_fetch, question,
issue_list, wt_print, bg_print, tm_print, recall,
wiki_get, wiki_prepare, screen, read_picture
```

### Action Tools (-1 Point)

State-modifying operations:

```
write_file, edit_file, todo_write,
issue_create, issue_close, issue_claim, issue_comment,
blockage_create, blockage_remove,
tm_create, tm_remove,
wt_create, wt_remove,
bg_create, bg_remove,
mail_to, broadcast,
git_commit, plan_on, plan_off
```

### Bash Tool (Dynamic)

- **Read-only commands** (0 points): `ls`, `cat`, `pwd`, `head`, `tail`, `wc`, `find`, `which`, `git status/log/diff/branch/show/ls-files`
- **Other commands** (-1 point): Default action tool

---

## Hint Trigger

### Main Process

In `src/loop/states/collect.ts`:

```typescript
if (ctx.core.getConfusionIndex() >= 10) {
  agentIO.log(chalk.blue('[hint round] Generating problem analysis...'));
  const result = await triologue.generateHintRound();
  if (result === 'aborted') {
    return AgentState.PROMPT;
  }
  // generateHintRound already resets confusion
}
```

### Child Process

In `src/context/teammate-worker.ts`:

```typescript
async function checkAndRequestHelp(ctx: AgentContext, triologue: Triologue): Promise<boolean> {
  const confusionIndex = ctx.core.getConfusionIndex();
  
  if (confusionIndex < 10) {
    return false;
  }
  
  // Use LLM to generate help request
  const helpRequest = await generateHelpRequest(ctx, triologue);
  
  // Send mail to lead
  ctx.team.mailTo('lead', 'Stuck - need guidance', helpRequest);
  
  // Reset confusion
  ctx.core.resetConfusionIndex();
  
  return true;
}
```

---

## Brief Tool

### Required Parameter

The brief tool now requires a `confidence` parameter:

```typescript
brief(message: string, confidence: number)
```

**Description**:
> Send status updates. Use frequently.
> Confidence (0-10): 10=certain, 8=confident, 5=uncertain, 2=guessing.
> Confidence >= 8 reduces confusion, < 8 increases it.

**Implementation**:
```typescript
handler: (ctx, args) => {
  const { message, confidence } = args;
  if (confidence < 0 || confidence > 10) {
    throw new Error(`confidence must be 0-10, got ${confidence}`);
  }
  ctx.core.brief('info', 'brief', message);
  const delta = 8 - confidence;
  ctx.core.increaseConfusionIndex(delta);
  return 'Status updated.';
}
```

---

## Brief Nudge

Similar to todo nudging, the agent receives periodic reminders to use brief:

### TurnVars Addition

```typescript
interface TurnVars {
  isFirstRound: boolean;
  nextTodoNudge: number;
  lastTodoState: string;
  nextBriefNudge: number;  // New
}
```

### Nudge Logic

In `src/loop/states/collect.ts`:

```typescript
// Brief nudging
turn.nextBriefNudge--;
if (turn.nextBriefNudge <= 0) {
  triologue.user(`<reminder>Provide a brief status update using the brief tool. Example: brief("Working on X", confidence: 7)</reminder>`);
  turn.nextBriefNudge = 5;
}
```

### Reset on Brief Usage

In `src/loop/states/tool.ts`:

```typescript
if (toolName === 'brief') {
  // Reset brief nudge counter
  env.turn.nextBriefNudge = 5;
}
```

---

## Files Changed

| File | Change |
|------|--------|
| `src/types.ts` | Add 3 methods to `CoreModule` |
| `src/context/shared/base-core.ts` | Add `confusionIndex` field + 3 methods |
| `src/loop/triologue.ts` | Remove `ConfusionCalculator`, remove `hintGenerated`, use `ctx.core` |
| `src/loop/confusion-calculator.ts` | **DELETE** |
| `src/tools/brief.ts` | Add `confidence` parameter (required) |
| `src/loop/states/tool.ts` | Add confusion scoring logic |
| `src/loop/states/collect.ts` | Check confusion, trigger hint (main) |
| `src/loop/state-machine.ts` | Add `nextBriefNudge` to `TurnVars` |
| `src/context/teammate-worker.ts` | Add `checkAndRequestHelp()` for child |
| `src/loop/agent-repl.ts` | Pass `ctx` to Triologue |
| `src/loop/agent-prompts.ts` | Remove brief instruction from child prompt |

---

## Example Scenario

### Stuck Pattern

```
Step 1: brief("Reading files", 7) → delta = 1 → score = 1
Step 2: read_file (exploration) → score = 1 (no change)
Step 3: brief("Not sure what to do", 3) → delta = 5 → score = 6
Step 4: edit_file (action) → score = 5 (progress)
Step 5: Tool error (ENOENT) → score = 7 (obstacle)
Step 6: brief("Confused about path", 2) → delta = 6 → score = 13
Step 7: score >= 10 → TRIGGER HINT

[Hint generated, confusion reset to 0]

Step 8: brief("Now I understand", 9) → delta = -1 → score = 0
```

### Smooth Progress

```
Step 1: brief("Found the issue", 9) → delta = -1 → score = 0
Step 2: edit_file (action) → score = 0 (clamped)
Step 3: brief("Testing fix", 8) → delta = 0 → score = 0
Step 4: bash test (action) → score = 0
Step 5: brief("Fix verified", 10) → delta = -2 → score = 0 (clamped)
```

---

## Differences from v1

1. **No `hintGenerated` flag**: Confusion resets after hint, allowing multiple hints per turn
2. **Built into `ctx.core`**: No separate `ConfusionCalculator` class
3. **Child process support**: Children mail lead for help instead of hint rounds
4. **Brief integration**: Confidence parameter affects confusion directly
5. **Nudge system**: Periodic reminders to use brief tool

---

## Implementation Order

1. Add `confusionIndex` + methods to `BaseCore`
2. Add methods to `CoreModule` interface
3. Remove `ConfusionCalculator` from `Triologue`
4. Update `brief.ts` with `confidence` parameter
5. Add confusion scoring in `tool.ts`
6. Add hint check in `collect.ts` (main)
7. Add help request in `teammate-worker.ts` (child)
8. Add brief nudge to `TurnVars` and `collect.ts`
9. Remove brief instruction from child prompt in `agent-prompts.ts`
10. Pass `ctx` to `Triologue` constructor