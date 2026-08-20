# Crossroad Feature

> **Status:** Implemented in `src/loop/crossroad.ts` (~577 lines). Cooldown added later (see `docs/crossroad-cooldown.md`).

## Overview

The "crossroad" feature intercepts LLM responses that contain "turning words" — indicators that the LLM is changing its mind mid-response. When detected, it:

1. **Truncates** the LLM output at the turning word (keeps prefix A)
2. **Generates 3 alternative continuations** via `forkChat` in different directions (forward / backward / synthesize)
3. **Selects the best continuation** via a second `forkChat` call
4. **Merges** the continuation into the assistant message in the HOOK state, discarding original tool calls — the LLM regenerates them in the next COLLECT round

Tool calls ARE now a precondition to SKIP crossroad. If the LLM emits tool calls alongside turning words, crossroad is skipped entirely — the tool calls execute normally. Crossroad only fires on text-only responses (no tool calls) containing turning words. After crossroad fires (text-only path), the LLM naturally generates new tool calls based on the prefix + continuation.

## Turning Word Detection

### Tiered approach

Detection uses three tiers to reduce false positives. A genuine "turning word" means the LLM is reversing course mid-response — distinct from ordinary conjunctions used for balanced analysis.

**Tier 1 — Strong turning signals** (`STRONG_TURNING_WORDS`):
Always flagged, subject only to position checks.
- `Having said that`, `That being said`, `On the other hand`
- `话说回来`, `等一下`

**Tier 2 — Sentence-boundary conjunctions** (`SENTENCE_BOUNDARY_TURNING_WORDS`):
Only flagged when at a sentence/paragraph start (not mid-sentence).
- `However`, `Nevertheless`, `Nonetheless`, `That said`, `Actually`, `But`
- `然而`, `但`, `不过`, `其实` (Chinese — only after sentence-ending punctuation `。！？` or newline)

**Tier 3 — Special patterns** (`SPECIAL_TURNING_PATTERNS`):
Disambiguation encoded directly in the regex.
- `Wait` as interjection (followed by punctuation, NOT "wait for/until/to")
- `等等` as interjection (followed by punctuation, NOT "etc." list terminator)

### Position guards

All matches must pass:
- `MIN_PREFIX_LENGTH = 30` — enough content before the turn (LLM committed to a direction). Exception: position 0 is always allowed (the LLM's commitment was in conversation history, not the current response).
- `MIN_SUFFIX_LENGTH = 15` — enough content after the turn (not just trailing rhetoric).

### `detectTurningWord(content: string): { word: string; index: number } | null`

Scans all three tiers, returns the earliest valid match. Uses `isAtSentenceBoundary()` to check whether a tier-2 match starts a new sentence/paragraph.

## Continuation Generation

### `generateContinuations(messages, tools, prefix, signal, wordsBeforeTurn): Promise<string[]>`

Three directions, run in parallel via `Promise.allSettled`:

| Direction | Description |
|-----------|-------------|
| `go forward` | Continue proactively, action-oriented, decisive steps |
| `go backward` | Reconsider assumptions, be cautious, re-examine foundations |
| `synthesize at a high level` | Step back, higher-level abstraction, reframe the problem |

Each direction uses `forkChat(messages, tools, fullPrompt, signal, 'none', CROSSROAD_RETRY_CONFIG)`:
- `tools` are passed (NOT empty `[]`) to preserve the prompt cache prefix.
- `toolChoice: 'none'` constrains output to text-only.
- `CROSSROAD_RETRY_CONFIG`: 10s first-token timeout, 30s response timeout, 1 retry.

### Anchor-based validation

Each continuation MUST start by repeating the anchor sentence (the last sentence of the prefix) verbatim. This enforces a clean dovetail: the continuation picks up exactly where the prefix left off.

- `extractWordsBeforeTurn(prefix)` — splits on English/Chinese sentence boundaries and newlines, returns the last sentence.
- `stripAndValidate(wordsBeforeTurn, continuation)` — checks the continuation starts with the anchor; strips it, returning only the new content. Returns `null` if validation fails (continuation didn't start with anchor, or was only the anchor).
- On validation failure, the direction is retried once. If the retry also fails, the direction is skipped.

### `stripInternalMarkup`

All raw continuation text is passed through `stripInternalMarkup()` (from `letter-box.ts`) before validation, removing any letter-box formatting artifacts.

## Continuation Selection

### `selectBestContinuation(messages, tools, prefix, continuations, signal): Promise<string>`

- If 0 continuations: returns `''`
- If 1 continuation: returns it directly (no LLM call needed)
- If 2+: builds a selection prompt listing all options, calls `forkChat` with `toolChoice: 'none'`. Parses the response for an option number. Falls back to first continuation if parsing fails.

Uses `forkChat` (not `retryChat`) with `tools` for cache preservation.

## Orchestrator

### `handleCrossroad(messages, originalContent, _originalToolCalls, tools, signal): Promise<CrossroadResult | null>`

```typescript
interface CrossroadResult {
  truncated: string;    // prefix (text before the turning word)
  continuation: string; // best continuation text (anchor stripped)
}
```

Flow:
1. `detectTurningWord(originalContent)` → if null, return null
2. `prefix = originalContent.slice(0, match.index).trim()`
3. `wordsBeforeTurn = extractWordsBeforeTurn(prefix)`
4. `startSpinner('LLM is at its crossroad...')`
5. `generateContinuations(messages, tools, prefix, signal, wordsBeforeTurn)` → if empty, retry once with 500ms delay. If still empty, return null.
6. `selectBestContinuation(messages, tools, prefix, continuations, signal)` → best
7. `stopSpinner()` (in `finally` block)
8. Log all alternatives with selected marker via `agentIO.brief('info', 'crossroad', ...)` (markdown format for terminal + web UI)
9. Return `{ truncated: prefix, continuation: best }`

## Integration with the State Machine

### LLM state (`src/loop/states/llm.ts`)

After the LLM response is stored on `pass`, crossroad runs BEFORE the empty-output check:

```typescript
if (tools.length > 0 && chat.rawToolCalls.length === 0) {
  // Cooldown gate: if crossroad fired last pass, skip this pass
  if (env.crossroadOccurred) {
    env.crossroadOccurred = false;  // consume cooldown
  } else {
    const crossroadResult = await ctx.core.escAware(
      async (abortController) => {
        return await handleCrossroad(
          triologue.getMessages(),
          pass.assistantContent,
          tools,
          abortController.signal,
        );
      },
      () => null,  // ESC during crossroad → return null (transparent skip)
    );
    // ESC pressed during crossroad → return to PROMPT
    if (agentIO.isNeglectedMode()) {
      stopSpinner();
      return AgentState.PROMPT;
    }
    if (crossroadResult) {
      pass.assistantContent = crossroadResult.truncated;
      pass.crossroadContinuation = crossroadResult.continuation;
      pass.rawToolCalls = [];  // no tool calls to discard (guard ensured this)
      ctx.core.increaseConfusionIndex(2);  // unconditional +2
      env.crossroadOccurred = true;  // arm cooldown for next pass
    } else {
      env.crossroadOccurred = false;
    }
  }
} else {
  // Tool calls present OR no tools available — reset flag
  env.crossroadOccurred = false;
}
```

Key points:
- Crossroad only runs when `tools.length > 0 && rawToolCalls.length === 0` — a tool call means the LLM committed to an action, and crossroad's purpose is to resolve indecision, not redirect a committed action. Running crossroad on a response that has tool calls would truncate the LLM's reasoning, discard its tool calls, and inject an alien continuation as its "own" thinking — a mis-direction that intimidates the LLM away from calling mid-thought tools like `brief` (whose reasoning text naturally contains hedging language like "However", "But", "Wait" that triggers detection).
- Wrapped in `escAware` so ESC during crossroad processing returns null (transparent skip, uses original output as-is).
- ESC during crossroad → immediate return to PROMPT.
- Cooldown gate (`crossroadOccurred` flag): crossroad skips detection for one pass after firing.
- Confusion index +2 is unconditional (not conditional on consecutive fires, since cooldown makes consecutive fires impossible).

### HOOK state (`src/loop/states/hook.ts`)

Crossroad is a first-class branch handled BEFORE normal agent registration:

```typescript
if (pass.crossroadContinuation) {
  const finalContent = `${pass.assistantContent || ''} ${pass.crossroadContinuation}`;
  const briefCallId = Math.random().toString(36).slice(2, 10);
  triologue.agent(finalContent, [{
    id: briefCallId,
    function: {
      name: 'brief',
      arguments: { message: 'Refining my approach. Continuing.', confidence: 7 },
    },
  }], pass.assistantReasoningContent);
  triologue.tool('brief', briefResult, briefCallId);  // see wording below

  // Inject deferred hook messages
  for (const dm of hookResult.deferredMessages) {
    triologue.note('REMINDER', dm.message, dm.hookName);
  }

  pass.crossroadContinuation = undefined;
  return AgentState.COLLECT;
}
```

Key points:
- Continuation is joined with a space (natural prose continuation, not a paragraph break).
- A synthetic `brief()` tool call is injected (NOT a `note('CONTINUE', ...)`) to give the LLM a thinking trace and actively engage it. The message is phrased neutrally (`"Refining my approach. Continuing."`) — it frames the crossroad as a refinement, not a rescue, so the LLM does not feel it was "lost" and needed saving.
- The `brief` tool result uses non-alarming wording: `"A direction refinement was applied to your response. To display the full response to the user, run: bash(...)"` instead of `"Crossroad triggered. To report the decision..."`. The replay mechanism (running `mycc-pretty-print --type=crossroad <path>` via bash with `display=true`) is retained — it lets the LLM show the user the full reconstructed response. The alarm language was removed because "triggered" and "report the decision" implied the LLM did something wrong, which intimidated it away from mid-thought tools.
- Deferred hook messages are injected so the LLM sees them in the next round.
- Flow goes to `COLLECT` (not `STOP`) so the LLM regenerates tool calls.
- Stop-trigger hooks on the empty `rawToolCalls` are intentionally NOT carried forward.

### PassData field

```typescript
// In src/loop/state-machine.ts
export interface PassData {
  // ... other fields ...
  crossroadContinuation?: string;
}
```

## Edge Cases

| Scenario | Handling |
|---|---|
| No turning word found | Return null, normal flow |
| Turning word at position 0 | Allowed (LLM's commitment was in conversation history) |
| ESC pressed during crossroad | `escAware` returns null → transparent skip, uses original output. If `isNeglectedMode()`, returns PROMPT immediately. |
| forkChat fails for some/all directions | Silently caught via `Promise.allSettled`; only successful directions included. If none, retried once. If still none, return null. |
| Selection fails | Falls back to first successful continuation |
| All continuations fail anchor validation | Direction skipped; if all fail, retry once; if still empty, return null |
| No tools available (neglected mode) | Crossroad skipped entirely (`tools.length > 0` gate) |

## Cooldown

See `docs/crossroad-cooldown.md` for the cooldown mechanism: after crossroad fires, the `crossroadOccurred` flag is set, causing the next LLM pass to skip crossroad detection. This lets the LLM execute its committed actions without immediate re-triggering.