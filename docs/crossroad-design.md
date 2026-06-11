# Crossroad Feature — Implementation Plan

## Overview

The "crossroad" feature intercepts LLM responses that contain "turning words" (indicators that the LLM is changing its mind mid-response). When detected, it:

1. **Truncates** the LLM output at the turning word
2. **Generates multiple alternative continuations** (forking in different "directions")
3. **Selects the best continuation** via a second LLM call
4. **Reconstructs the triologue** with the chosen continuation

**Key clarification from user:**
- Tool calls are NOT a precondition to skip crossroad. If LLM outputs turning words WITH tool calls, discard the tool calls and only keep the text before the turning word.
- After crossroad reconstruction, the LLM is told "continue with your work" — it will naturally generate new tool calls.
- Show spinner "LLM is at its crossroad..." during crossroad processing.
- After crossroad completes, output the chosen text to the terminal (via `presentResult`)

## Data Flow

```
LLM produces raw: "Let me check file X. However, I realize Y" + [tool_calls...]
                                    ↓
detectTurningWord() → found "However" at position 19
                                    ↓
truncate: A = "Let me check file X."  
(discard text after turning word AND all tool calls)
                                    ↓
Show spinner: "LLM is at its crossroad..."
                                    ↓
forkChat(direction="forward")  → "I'll read file X and address Y"
forkChat(direction="backward") → "Let me re-examine my assumptions first"  
forkChat(direction="synthesize") → "The core question is whether X is correct"
                                    ↓
selectBestContinuation() → picks C_best
                                    ↓
Reconstruct triologue:
  triologue.agent(A + "\n" + C_best)  // no tool_calls
  triologue.note('CONTINUE', 'continue with your work')
                                    ↓
Output chosen text to terminal via presentResult-like display
                                    ↓
Next LLM round: naturally generates new tool calls based on A + C_best
```

## Implementation Steps

### Step 1: Create `src/loop/crossroad.ts` (NEW, ~150 lines)

#### 1a. Declare turning words
```typescript
const TURNING_WORDS = [
  /\bHowever\b/i, /\bActually\b/i, /\bWait\b/i, /\bBut\b/i,
  /\bNevertheless\b/i, /\bNonetheless\b/i, /\bOn the other hand\b/i,
  /\bThat said\b/i, /\bThat being said\b/i,
  /等等/, /但/, /不过/, /然而/, /其实/, /等一下/,
];
```

#### 1b. `detectTurningWord(content: string): { word: string; index: number } | null`
- Scan content for the earliest match
- Return the matched word and its position

#### 1c. `generateContinuations(messages: Message[], prefix: string, signal?: AbortSignal): Promise<string[]>`
- Define direction prompts:
  - "Go forward": Continue in a proactive, action-oriented direction
  - "Go backward": Reconsider the basic assumptions and be cautious
  - "Synthesize at a high level": Step back and provide a higher-level abstraction
- For each direction, call `forkChat(messages, [], directionPrompt, signal)`
  - Pass `tools=[]` to constrain text-only output (no tool calls)
  - The generated text is just the continuation (post-prefix), each starting with the same foreword as the prefix ends
- Use `Promise.all` for parallelism
- Filter out empty/failed results

#### 1d. `selectBestContinuation(messages: Message[], prefix: string, continuations: string[], signal?: AbortSignal): Promise<string>`
- Build a selection prompt listing all continuations with inline numbering
- Call `retryChat` with `tools=[]` (text-only, no tool choice)
- The LLM outputs which one is best (and optionally why)
- Return the selected continuation text

#### 1e. `handleCrossroad(triologue: Triologue, originalContent: string, originalToolCalls: ToolCall[], signal?: AbortSignal): Promise<{ truncated: string; continuation: string } | null>`
- Call `detectTurningWord(originalContent)` → if null, return null
- Compute `prefix = originalContent.slice(0, turningWordIndex)`
- Call `generateContinuations(messages, prefix, signal)` → get `continuations[]`
- Call `selectBestContinuation(messages, prefix, continuations, signal)` → get `best`
- Return `{ truncated: prefix, continuation: best }`

### Step 2: Modify `src/loop/states/llm.ts`

**After** `pass.assistantContent` and `pass.rawToolCalls` are set (around line 92-93), add:

```typescript
// Crossroad detection: check for turning words in LLM output
const crossroadResult = await handleCrossroad(
  triologue,
  pass.assistantContent,
  pass.rawToolCalls,
  pass.abortController?.signal,
);
if (crossroadResult) {
  // Replace content with truncated version + selected continuation
  pass.assistantContent = crossroadResult.truncated;
  pass.crossroadContinuation = crossroadResult.continuation;
  // Discard tool calls — LLM will re-generate them after crossroad
  pass.rawToolCalls = [];
}
```

**Also**: Show spinner "LLM is at its crossroad..." (use `startSpinner('LLM is at its crossroad...')` and `stopSpinner()`)

**Imports to add**: `handleCrossroad` from `./crossroad.js`, `startSpinner`/`stopSpinner` from `../../engine/chat-helpers.js`

### Step 3: Modify `src/loop/state-machine.ts`

Add field to `PassData`:

```typescript
export interface PassData {
  // ... existing fields ...
  /** If crossroad was triggered, the best continuation text */
  crossroadContinuation?: string;
}
```

### Step 4: Modify `src/loop/states/hook.ts`

**Before** `triologue.agent(pass.assistantContent, ...)` call (around line 200), add crossroad handling:

```typescript
// Crossroad: if a continuation was selected, inject it into the assistant message
// and add a CONTINUE note so the LLM picks up from here
if (pass.crossroadContinuation) {
  // Display the chosen output to terminal
  ctx.core.brief('info', 'crossroad', pass.assistantContent + '\n' + pass.crossroadContinuation);
  
  // The agent message will still be registered below in step 5,
  // but we inject the continuation + continue note after agent()
}
```

**After** `triologue.agent(pass.assistantContent, ...)` call (around line 223), add:

```typescript
// Crossroad continuation injection
if (pass.crossroadContinuation) {
  // Append continuation to the last assistant message
  const lastMsg = triologue.getMessagesRaw().at(-1);
  if (lastMsg?.role === 'assistant') {
    lastMsg.content += '\n' + pass.crossroadContinuation;
    // Recalculate token count after modification
    // (Token count will be corrected by next needsCompact check)
  }
  // Tell LLM to continue — it will generate tool calls naturally
  triologue.note('CONTINUE', 'continue with your work');
  
  // Clear the flag to prevent double-injection
  pass.crossroadContinuation = undefined;
}
```

**NOTE**: After crossroad, since `pass.rawToolCalls = []` and the registered agent message has no tool calls, the flow goes HOOK → STOP (normal text-only response). The `triologue.note('CONTINUE', ...)` ensures that in the next COLLECT → LLM round, the LLM sees the continuation and generates fresh tool calls.

**BUT**: We need to ensure the flow goes to COLLECT instead of STOP. So after the crossroad injection, we should return `AgentState.COLLECT` directly (before the normal "No tool calls → STOP" path).

### Step 5: Handle the display of chosen output

After crossroad selects a continuation, display the complete result (prefix + continuation) to the terminal so the user sees what the LLM will proceed with. We can use `agentIO.log()` or `ctx.core.brief()` to output it.

Looking at how `presentResult` works in `stop.ts` — it uses `displayLetterBox`. For crossroad, we can use a similar approach but simpler: just log the reconstructed output with a clear marker.

### Step 6: Edge Cases

| Scenario | Handling |
|---|---|
| No turning word found | Return null, normal flow |
| Turning word at position 0 | `prefix` is empty string, continuations generated fresh |
| ESC pressed during crossroad | AbortSignal propagated; catch and fall back to original content |
| forkChat fails for some/all directions | Silently catch failures; use only successful continuations; if none, fall back to original |
| selection fails | Fall back to first successful continuation |
| Crossroad but no continuations generated | Return null, use original content as-is |

## Summary

| Step | File | Action |
|---|---|---|
| 1 | `src/loop/crossroad.ts` | CREATE — turning words, detection, generation, selection, orchestration |
| 2 | `src/loop/states/llm.ts` | EDIT — add crossroad detection after LLM response |
| 3 | `src/loop/state-machine.ts` | EDIT — add `crossroadContinuation` to `PassData` |
| 4 | `src/loop/states/hook.ts` | EDIT — inject continuation + note; return COLLECT instead of STOP |