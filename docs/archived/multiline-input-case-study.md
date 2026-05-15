# Case Study: Multiline Input Reload Feature

## The Request

> "when the user enters `r + enter` during p1, the temp file will be read into the prompt but no submission is fired, leaving all the input from the temp file showing on the prompt"

At the end of a user input line, typing `\` + Enter opens an external editor. After editing, a "Press Enter when done editing >" prompt (p1) waits. The user wanted a way to preview the current editor content without committing: type `r` + Enter at p1 → content loads into the main prompt (p0) → user can inspect, edit inline, or `\` + Enter again.

## The Terrain

**Key state:** `prompt.ts` is the PROMPT state handler — the entry point for every conversational turn. It calls `inputProvider.getInput()` to display p0, then optionally calls `openMultilineEditor()` if the input ends with `\`.

**The flow before changes:**

```
p0: agent >> user types, presses Enter
  → if ends with '\': openMultilineEditor()
    → writes temp file, spawns $EDITOR
    → agentIO.ask("Press Enter when done editing > ")  ← p1
    → on Enter: reads file, strips comments, returns content
  → query = content → triologue → COLLECT (auto-submitted)
```

## Trail and Error

### First attempt: print-only loop

The initial instinct was to wrap `agentIO.ask()` in a `do...while` inside `openMultilineEditor`. On `r`, re-read the temp file, `console.log()` it, and loop. This would print the content above the p1 prompt but never return to p0. The user clarified: content should appear **on the p0 input line**, not printed above.

### The real challenge

Putting content on the p0 input line seemed to require a parameter cascade: `LineEditor` → `agentIO.ask()` → `InputProvider.getInput()` → stored in `MachineEnv`. This would touch 6+ files and add a `pendingP0Content` field to the state machine.

But then `openMultilineEditor`'s return type came into focus. It returned `Promise<string | null>` — a single string with no way to signal "reload vs. submit." The user pointed out that null was no longer needed; empty content already meant cancellation. The return type became `{ action: 'submit' | 'reload', content: string }`.

### The assumption that blocked progress

The critical assumption taken for granted: **`handlePrompt` is a one-shot function.** It runs once per turn, gets input, maybe opens an editor, returns a state. The mental model was a linear pipeline, not a loop.

The user suggested recursion: detect the reload result and call `handlePrompt` again. That felt wrong at first (it would re-enter `getInput()` and block), but it pointed toward the real insight: **a `while` loop inside `handlePrompt` itself.** The variable `p0Input` carries state across iterations within a single invocation — no `MachineEnv` changes needed.

### The breakthrough structure

```typescript
let p0Input: string | null = null;
while (true) {
  p0Input = await inputProvider.getInput(p0Input ?? undefined);
  // ... exit, editor, reload handling ...
  query = p0Input;
  break;
}
```

On first iteration: `p0Input` is null → `getInput()` shows empty prompt. On reload: `p0Input = result.content` → `continue` → next iteration calls `getInput(p0Input)` → LineEditor pre-filled with content.

## The Final Plan

| # | File | Change |
|---|------|--------|
| 1 | `src/utils/multiline-input.ts` | Return `{ action, content }` object; `do...while` loop on `ask()`; `r`+Enter returns `'reload'` action |
| 2 | `src/utils/line-editor.ts` | Make `setContent()` public |
| 3 | `src/loop/agent-io.ts` | `ask()` accepts optional `initialContent`; calls `setContent()` after LineEditor creation |
| 4 | `src/loop/input-provider.ts` | `getInput()` accepts optional `initialContent`; passes to `ask()` |
| 5 | `src/loop/states/prompt.ts` | `while` loop wraps p0 + editor; reload → `continue` with pre-filled content |

P1 prompt text: `"Press Enter to submit (r to return) > "`

## Lessons

1. **Question the return type first.** A function's return shape constrains everything downstream. Changing `string | null` to a discriminated object unlocked the entire design.

2. **Loops inside handlers can replace state machine fields.** When a variable only needs to live across a few iterations within the same handler invocation, a local loop variable is cleaner than persisting into the state machine.

3. **"One-shot" is an assumption, not a law.** Handler functions don't have to be single-pass. A handler can loop internally, handling multiple sub-states before returning a final transition.

4. **Let the user clarify before coding.** The first implementation instinct (print content above p1) was wrong. Only after the user restated "on the prompt" did the real requirement become clear.

5. **Minimize the API surface.** Making `setContent` public on `LineEditor` was the right call — it reused existing logic rather than adding a new constructor option, and it enabled content setting at any time, not just at init.
