# Confusion Index v2 Design

## Overview

The Confusion Index is a built-in property of `ctx.core` that quantifies how "stuck" an LLM agent is. When the index reaches a threshold (default: 10) and the message count is sufficient (≥ 6), the agent requests help differently based on context:

- **Main process**: Triggers a hint round (LLM self-analysis) in COLLECT state
- **Child processes**: Sends mail to lead requesting guidance

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

**Implementation** (in `src/context/shared/base-core.ts`, inherited by `Core` and `ChildCore`):
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

### Main Process (tool.ts + llm.ts + hook.ts)

| Event | Delta | Source | Rationale |
|-------|-------|--------|-----------|
| Brief with confidence >= 8 | `8 - confidence` (negative) | `src/tools/brief.ts` | High confidence reduces confusion |
| Brief with confidence < 8 | `8 - confidence` (positive) | `src/tools/brief.ts` | Low confidence increases confusion |
| Non-exploration tool, no semantic duplication | -1 | `src/loop/states/tool.ts` | Progress reduces confusion |
| Non-exploration tool, semantic duplication | `similarityToDelta(maxSim)` (positive) | `src/loop/states/tool.ts` via `requestEmbeddingTracker` | Repeated requests increase confusion |
| Tool error result | +2 | `src/loop/states/tool.ts` | Obstacles increase confusion |
| Crossroad fire | +2 | `src/loop/states/llm.ts` | Direction change indicates confusion |
| Plan mode assistant turn | +1 | `src/loop/states/hook.ts` | Plan mode exploration driver (sparse tool calls) |

**Brief formula**: `delta = 8 - confidence`

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

### Semantic Duplication Detection (Main Process)

The main process uses embedding-based semantic duplication detection (`src/loop/request-embedding.ts`) instead of simple tool-name matching. After each tool call, `requestEmbeddingTracker.addEntry()` records the tool name + arguments. `getMaxSimilarity()` returns the highest embedding similarity to previous calls, and `similarityToDelta()` converts it to a confusion delta. This replaces the old "same tool name in last 5 calls" heuristic.

### Child Process (teammate-worker.ts)

The child process uses a simpler repetition heuristic (`recentToolCalls` array, last 5 calls):

| Event | Delta | Rationale |
|-------|-------|-----------|
| Non-exploration action tool, not repeated | -1 | Progress |
| Non-exploration action tool, repeated | +1 | Repetition |
| `mail_to` repeated | +2 | Repeated mail is highly confusing |
| Bash read-only command | 0 | Exploration, no change |
| Tool error result | +2 | Obstacle |

### Invariant

**The confusion index is always >= 0** (clamped on increase).

---

## Tool Classification

### Exploration Tools (No Score Change)

Main process (`src/loop/states/tool.ts`):

```
read_file, web_search, web_fetch, brief,
issue_list, bg_print, tm_print, question, recall
```

Child process (`src/context/teammate-worker.ts`) uses the same set.

### Bash Tool (Child Process — Dynamic)

- **Read-only commands** (0 points): `ls`, `cat`, `pwd`, `head`, `tail`, `wc`, `find`, `which`, `git status/log/diff/branch/show/ls-files`
- **Other commands** (-1 point or +1 if repeated): Default action tool

---

## Hint Trigger

### Main Process

In `src/loop/states/collect.ts`:

```typescript
const CONFUSION_THRESHOLD = 10;
const MIN_MESSAGES_FOR_HINT = 6;

if (confusionIndex >= CONFUSION_THRESHOLD && messageCount >= MIN_MESSAGES_FOR_HINT) {
  ctx.core.brief('info', 'loop', 'Generating hint...');
  const result = await ctx.core.escAware(
    async (abortController) => {
      return await triologue.generateHintRound(abortController, confusionIndex, breakdown, pendingSkills);
    },
    () => { startWrapUp(...); return 'aborted'; }
  );
  if (result === 'aborted') {
    return AgentState.PROMPT;
  }
  ctx.core.resetConfusionIndex();
}
```

### Child Process

In `src/context/teammate-worker.ts`, after tool execution:

```typescript
const confusionIndex = ctx.core.getConfusionIndex();
const messageCount = triologue.getMessagesRaw().length;
if (confusionIndex >= CONFUSION_THRESHOLD && messageCount >= MIN_MESSAGES_FOR_HINT) {
  const lastRole = triologue.getLastRole();
  if (lastRole === 'assistant' || lastRole === 'tool') {
    ctx.team.mailTo('lead', 'Guidance request',
      `Guidance request (confusion index: ${confusionIndex}). ` +
      `I'm working but could benefit from direction or feedback. ` +
      `Current state: ${ctx.todo.hasOpenTodo() ? ctx.todo.printTodoList() : 'No active todos'}`,
      ctx.core.getName());
    ctx.core.resetConfusionIndex();
  }
}
```

---

## Brief Tool

### Required Parameter

The brief tool requires a `confidence` parameter (`src/tools/brief.ts`):

```typescript
brief(message: string, confidence: number)
```

**Implementation**:
```typescript
handler: (ctx, args) => {
  const { message, confidence } = args;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 10) {
    return 'Error: confidence parameter is required and must be a number between 0 and 10';
  }
  const deltaConfusion = 8 - confidence;
  ctx.core.increaseConfusionIndex(deltaConfusion);
  // Also records brief to peer heartbeat (lead only)
  ctx.peer.recordBrief(message, confidence);
  ctx.core.brief('info', 'brief', message, `confidence: ${confidence * 10}%`);
  return 'Status updated.';
}
```

---

## Brief Nudge

### TurnVars

```typescript
interface TurnVars {
  isFirstRound: boolean;
  nextTodoNudge: number;
  lastTodoState: string;
  nextBriefNudge: number;  // init 5
  lastUserQuery: string;
  extractedKeywords: string[];
}
```

### Nudge Logic

In `src/loop/states/collect.ts` (main process) and `src/context/teammate-worker.ts` (child):

```typescript
turn.nextBriefNudge--;
if (turn.nextBriefNudge <= 0) {
  triologue.note('REMINDER', 'Provide a brief status update using the brief tool. Example: brief("Working on X", 7)');
  turn.nextBriefNudge = 5;
}
```

### Reset on Brief Usage

In `src/loop/states/tool.ts` (main) and `src/context/teammate-worker.ts` (child):

```typescript
if (toolName === 'brief') {
  turn.nextBriefNudge = 5;
}
```

---

## Files

| File | Role |
|------|------|
| `src/types.ts` | `CoreModule` interface with 3 confusion methods |
| `src/context/shared/base-core.ts` | `confusionIndex` field + 3 methods |
| `src/tools/brief.ts` | `confidence` parameter + confusion delta |
| `src/loop/states/tool.ts` | Confusion scoring: semantic duplication, errors, brief reset |
| `src/loop/states/collect.ts` | Hint trigger (confusion ≥ 10 && messages ≥ 6) |
| `src/loop/states/llm.ts` | Crossroad +2 confusion |
| `src/loop/states/hook.ts` | Plan mode +1 per assistant turn |
| `src/loop/state-machine.ts` | `nextBriefNudge` in TurnVars |
| `src/context/teammate-worker.ts` | Child confusion scoring + guidance request to lead |
| `src/loop/request-embedding.ts` | Semantic duplication tracker (embedding similarity) |