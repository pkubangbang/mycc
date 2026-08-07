# Auto-Compact Working Memory Preservation

> **Status:** Implemented (code-complete, all 2170 tests passing)
> **Date:** 2026-08-07
> **Scope:** `src/loop/triologue.ts`, `src/loop/states/llm.ts`, `src/loop/states/tool.ts`, `src/loop/states/hook.ts`, `src/context/teammate-worker.ts`, `src/slashes/compact.ts`

## 1. Problem

Two issues with the current auto-compact:

### 1.1 Lost recent focus

`Triologue.runAutoCompact` (triologue.ts:803-921) minifies ALL messages via `minifyMessages()` (truncating content to 500 chars, args to 200), feeds the lossy text to a fresh `retryChat` (no tools, no prompt cache), and replaces the entire history with `[summary, ack]`. The agent loses its *recent focus* — actual tool results it just produced, the file it was editing, the decision it was about to make. After compact, the agent must re-orient from the summary alone, often re-reading files or re-running commands it just touched.

### 1.2 Compact can happen anywhere — no tools available

Auto-compact currently fires from three call sites with three different tool-availability contexts:

| Caller | Location | Tools available? |
|--------|----------|-----------------|
| Tool state (context overflow) | `tool.ts:125` | ❌ No — inside tool execution loop |
| Hook state (hook-requested) | `hook.ts:349` | ❌ No — hooks processed before tool execution |
| Teammate worker | `teammate-worker.ts:408` | ❌ No — inside tool execution loop |

Because compact can fire mid-tool-execution, the `toolsProvider` callback needed for a cache-friendly `forkChat` would have to be wired into the Triologue constructor — an awkward indirection. Worse, even with a callback, the fork would fork from `getMessages()` which may not be the exact prefix the *next* LLM call will use (tools may have changed via hot-reload, scope may differ).

## 2. Solution

**Move auto-compact to the top of the LLM stage**, where:
- `tools = loader.getToolsForScope(scope)` is already a local variable (llm.ts:54, teammate-worker.ts:177)
- `triologue.getMessages()` is the exact prefix the LLM is about to use
- A `forkChat` from that prefix with those tools is a **guaranteed cache hit**

Then add a dedicated `forkChat` that extracts recent working memory from the full un-minified conversation. The focus text is concatenated into the summary user message. The post-compact shape stays two messages: `[(summary + focus), ack]`.

## 3. Architecture

### 3.1 Compact relocation: TOOL/HOOK → LLM stage

```
BEFORE (compact fires reactively, mid-tool-execution)         AFTER (compact fires proactively, top of LLM)
─────────────────────────────────────────────────             ─────────────────────────────────────────────
COLLECT → LLM → HOOK → TOOL                                   COLLECT → LLM (compact if needed) → HOOK → TOOL
                        │                                                        ▲
                        ├─ needsCompact? → compact()                             │
                        └─ continue tools                                        └─ no compact check here anymore
                                                                         
HOOK: compactRequested? → compact()                            HOOK: compactRequested? → set flag, defer to LLM
```

**Lead** (`src/loop/states/llm.ts`): Insert the compact check at the very top of `handleLlm`, before the system prompt is built and before `retryChat` is called. `tools` is already computed (line 54) and `triologue.getMessages()` is the exact array about to be sent.

**Teammate** (`src/context/teammate-worker.ts`): Insert the compact check at the top of the main loop body, right after mail collection and before `retryChat`. `tools` is already computed (line 177) and `triologue.getMessages()` is the exact array about to be sent.

### 3.2 Post-compact message shape (unchanged)

```
[
  { role: 'user',
    content: '[Conversation compressed. …]\n\n'
           + '<summary>'
           + '\n\n### Recent Working Memory\n<focus>'
           + '\n\n**Previous user instruction:** …' },
  { role: 'assistant',
    content: 'Understood. I have the context from the summary. Continuing.' },
]
```

Two messages. No structural change. The focus is a new **section inside the existing user message**, not a third message.

### 3.3 Two concurrent LLM calls

| Call | Engine | Input | Tools | Cache | Purpose |
|------|--------|-------|-------|-------|---------|
| Summary | `retryChat` (fresh) | `minifyMessages(messages)` text | none | miss (by design — minified text differs from the cached prefix) | Broad recap: accomplishments, current state, key decisions |
| Focus | `forkChat` | `triologue.getMessages()` (full, un-minified) | `tools` (full schema, already in scope) | **hit** — identical prefix to the upcoming LLM call | Immediate working memory: active task, recent tool results, current file, in-progress decisions |

Run via `Promise.all` so latency is the max of the two, not the sum.

### 3.4 Why moving to LLM stage solves the tool-list problem

At the LLM stage, `tools` is a **local variable** — not a callback, not a side-effect of some other state. The forkChat receives exactly what the next LLM call will receive:

```ts
// llm.ts (simplified)
const tools = agentIO.isNeglectedMode() ? [] : loader.getToolsForScope(scope);

// ── NEW: auto-compact at the top of LLM stage ──
if (triologue.needsCompact()) {
  await triologue.compact(turn.lastUserQuery || undefined, undefined, tools);
  // After compact, tools may need re-evaluation (neglected mode could change)
  // Fall through to the normal retryChat — it re-reads tools below
}

const response = await retryChat({ model: MODEL, messages: triologue.getMessages(), tools, ... });
```

No `toolsProvider` callback on TriologueOptions. No wiring at construction sites. The tools are simply passed as a parameter to `compact()`.

### 3.5 Focus prompt

```
Extract the current working memory from the conversation above. Focus on:
- The immediate task the agent is working on
- Recent tool results that are still relevant (file contents, command outputs, search results)
- Current file(s) being edited or examined
- In-progress decisions or next steps

Be concise but preserve specific details (function names, line numbers, file paths, exact values).
This working memory will be combined with a broader summary to maintain continuity after compaction.
Output TEXT ONLY — do NOT use any tools.
```

The prompt deliberately does **not** ask for a broad summary — that is the summary call's job. The two calls are independent: neither sees the other's output. Run concurrently via `Promise.all`, the focus is appended as a `### Recent Working Memory` section to the user message.

### 3.6 Summary prompt (unchanged)

The summary prompt keeps its existing three-section structure (Accomplishments / Current State / Key Decisions) plus the knowledge-persistence, focus-area, and user-instruction addenda. No change.

### 3.7 Backward-compatible fallback

The new `tools` parameter on `compact()` is optional. When omitted (or empty), the focus `forkChat` is skipped and `runAutoCompact` falls back to the current summary-only behavior. This means:
- The `/compact` slash command (which doesn't have tools in its `SlashCommandContext`) calls `triologue.compact(focus)` — summary-only fallback, current behavior preserved.
- Tests with `new Triologue()` continue to work unchanged.

## 4. API Changes

### 4.1 `compact()` signature — new optional `tools` parameter

```ts
// BEFORE
async compact(focus?: string, signal?: AbortSignal): Promise<void>

// AFTER
async compact(focus?: string, signal?: AbortSignal, tools?: Tool[]): Promise<void>
```

`tools` flows through to `runAutoCompact`, which uses it for the focus `forkChat`. When `tools` is omitted or empty, the focus call is skipped (fallback to summary-only).

### 4.2 `TriologueOptions` — no changes

No `toolsProvider` field needed. Tools are passed per-call, not wired at construction.

### 4.3 No constructor wiring needed

Unlike the previous design, there are **zero changes** to `agent-repl.ts` or `teammate-worker.ts` constructor calls. The tools are passed at the call site, not at construction.

## 5. File Changes

### 5.1 `src/loop/triologue.ts` — core change

**Imports**: Add `forkChat` to the chat-provider import; add `Tool` to the types import.

**`compact()` method** (line 464): Add `tools?: Tool[]` parameter, pass through to `runAutoCompact`:
```ts
async compact(focus?: string, signal?: AbortSignal, tools?: Tool[]): Promise<void> {
  const compacted = await this.runAutoCompact(focus, signal, tools);
  this.messages = compacted;
  // ... rest unchanged
}
```

**`runAutoCompact()` method** (line 803): Add `tools?: Tool[]` parameter. After the transcript save + wiki domains (unchanged), restructure the LLM call section:

```
1-5. Save transcript, get wiki domains, build summary prompt  # unchanged
6.   Build focus prompt                                       # NEW
7.   Run summary + focus concurrently via Promise.all         # NEW
       - Summary: existing retryChat (fresh, no cache)
       - Focus: forkChat(getMessages(), tools, focusPrompt, signal, 'none')
         Only if tools && tools.length > 0; else Promise.resolve('')
8.   Assemble: summaryPrefix + summary + focusSection + userQueryNote  # focusSection is NEW
```

### 5.2 `src/loop/states/llm.ts` — compact relocation (lead)

Insert compact check at the top of `handleLlm`, before the system prompt is built:

```ts
export async function handleLlm(env, turn, pass): Promise<HandlerResult> {
  const { triologue, ctx, scope } = env;

  // ── NEW: Auto-compact at the top of LLM stage ──
  // Tools are computed here (already a local variable below), and
  // triologue.getMessages() is the exact cache prefix the next LLM call
  // will use — so a forkChat inside compact() is a guaranteed cache hit.
  if (triologue.needsCompact()) {
    const compactTools = loader.getToolsForScope(scope);
    ctx.core.brief('info', 'autoCompact', 'Context threshold exceeded, compacting...');
    await triologue.compact(turn.lastUserQuery || undefined, undefined, compactTools);
    // Reset stat counts — old context is summarized away
    ctx.core.resetConfusionIndex();
    env.requestEmbeddingTracker.clear();
    env.sequence.clear();
    env.crossroadOccurred = false;
  }

  // ── Handle hook-deferred compact ──
  // If the HOOK state set a compact-requested flag (compact-on-intent-trap),
  // the compact is deferred to here (LLM stage) where tools are available.
  if (pass.deferredCompact) {
    pass.deferredCompact = false;
    const compactTools = loader.getToolsForScope(scope);
    ctx.core.brief('info', 'compact', 'Compacting context (hook-deferred)...');
    await triologue.compact(turn.lastUserQuery || undefined, undefined, compactTools);
    ctx.core.resetConfusionIndex();
    env.sequence.clear();
    env.crossroadOccurred = false;
  }

  // ... existing system prompt + retryChat logic (unchanged) ...
}
```

**Note**: `tools` is computed fresh for the compact (not reused from the later `retryChat` call) because the compact may change the message array, and the `tools` variable for `retryChat` is computed after the system prompt is set. The cost of a second `getToolsForScope` call is negligible (it returns a cached array).

### 5.3 `src/loop/states/tool.ts` — remove compact check

Remove the `needsCompact()` check and `triologue.compact()` call (lines 116-128 and 173-178). These are now handled at the LLM stage. The tool execution loop no longer needs to worry about context overflow — by the time we reach TOOL, the LLM stage has already ensured we're under threshold.

**Keep** the `skipPendingTools` calls only if they serve ESC interruption (not compact). The compact-related `skipPendingTools` calls are removed.

**After removing compact from tool.ts**, the tool loop simply executes all tools and returns to COLLECT. If a single tool result pushes us over threshold, the *next* LLM stage entry will catch it — at most one extra tool result over the threshold, which is harmless (the LLM call itself has headroom up to the model's context window, which is larger than TOKEN_THRESHOLD).

### 5.4 `src/loop/states/hook.ts` — defer compact to LLM stage

Change the hook-requested compact (lines 346-355) to **set a flag instead of compacting immediately**:

```ts
// BEFORE (hook.ts:346-355)
if (hookResult.compactRequested) {
  ctx.core.brief('info', 'compact', 'Compacting context due to intent language confusion...');
  await triologue.compact(turn.lastUserQuery || undefined);
  env.ctx.core.resetConfusionIndex();
  env.sequence.clear();
  env.crossroadOccurred = false;
  return AgentState.COLLECT;
}

// AFTER
if (hookResult.compactRequested) {
  // Defer compact to the LLM stage where tools are available for cache-friendly forkChat.
  // Set a flag on pass; llm.ts checks it at the top of the next LLM entry.
  pass.deferredCompact = true;
  // Still reset stat counts — the confusion that triggered the compact is stale
  env.ctx.core.resetConfusionIndex();
  env.sequence.clear();
  env.crossroadOccurred = false;
  return AgentState.COLLECT;
}
```

**Add `deferredCompact` to `PassData`** in `src/loop/state-machine.ts`:
```ts
export interface PassData {
  // ... existing fields ...
  /** Set by HOOK when a hook requests compact; consumed and cleared by LLM stage */
  deferredCompact: boolean;
}
```

Initialize to `false` in the COLLECT lifetime reset (state-machine.ts):
```ts
if (state === AgentState.COLLECT) {
  pass = { ..., deferredCompact: false };
}
```

### 5.5 `src/context/teammate-worker.ts` — compact relocation (teammate)

Move the compact check from inside the tool execution loop (lines 391-422) to the top of the main loop body, before the `retryChat` call:

```ts
// ── NEW: Auto-compact at the top of the loop (before LLM call) ──
if (triologue.needsCompact()) {
  const compactWatchdog = createTurnWatchdog();
  try {
    await triologue.compact(undefined, compactWatchdog.signal, tools);
  } catch (err) {
    if (err instanceof StreamAbortedError && compactWatchdog.signal.aborted) {
      const elapsed = Date.now() - turnStart;
      reportStuckTurn('compact summarization watchdog', elapsed);
      triologue.note('SYSTEM', `Auto-compact aborted by watchdog after ${Math.round(elapsed / 1000)}s...`);
    } else {
      ctx.core.brief('error', 'compact', `Compact failed: ${(err as Error).message}`);
      triologue.note('SYSTEM', `Auto-compact failed: ${(err as Error).message}. Continuing without compaction.`);
    }
  } finally {
    compactWatchdog.clearTimeout();
  }
  ctx.core.resetConfusionIndex();
  recentToolCalls.length = 0;
  // Continue to the LLM call below with fresh context
}
```

`tools` is already in scope (line 177: `const tools = silentLoader.getToolsForScope('child')`), so it's passed directly — no callback needed.

**Remove** the compact check from inside the tool execution loop (lines 391-422). The tool loop no longer needs `needsCompact()` or `skipPendingTools` for compact purposes.

### 5.6 `src/slashes/compact.ts` — no changes

The `/compact` slash command calls `triologue.compact(focus)` without the `tools` parameter — it falls back to summary-only (current behavior). The slash command's `SlashCommandContext` does not expose tools, and manual compaction doesn't need the focus extraction (the user is explicitly triggering it and can re-state their focus via the `focus` argument).

## 6. Flow Comparison

### 6.1 Lead agent — auto-compact (context overflow)

```
BEFORE                                    AFTER
──────────────────────                    ──────────────────────
COLLECT → LLM → HOOK → TOOL               COLLECT → LLM ──────────────────── → HOOK → TOOL
                        │                            │ (top, before retryChat)
                        │ needsCompact?              │ needsCompact?
                        │ → compact()                │ → compact(focus, signal, tools)
                        │ → COLLECT                  │   (forkChat with tools = cache hit)
                        │                            │ → continue to retryChat
                        └─ continue tools            └─ continue tools
                                                         (no compact check here)
```

### 6.2 Lead agent — hook-requested compact (compact-on-intent-trap)

```
BEFORE                                    AFTER
──────────────────────                    ──────────────────────
HOOK: compactRequested?                   HOOK: compactRequested?
  → compact() immediately                   → set pass.deferredCompact = true
  → COLLECT                                 → COLLECT
                                           COLLECT → LLM
                                                     │ deferredCompact?
                                                     │ → compact(focus, signal, tools)
                                                     │   (forkChat with tools = cache hit)
                                                     │ → continue to retryChat
```

### 6.3 Teammate — auto-compact

```
BEFORE                                    AFTER
──────────────────────                    ──────────────────────
[loop top]                                [loop top]
  → collect mails                           → collect mails
  → retryChat                               → needsCompact?
  → execute tools                             → compact(undefined, signal, tools)
      → needsCompact?                           (forkChat with tools = cache hit)
      → compact()                             → retryChat (fresh context)
      → break                               → execute tools
                                              (no compact check here)
```

## 7. Edge Cases

| Case | Behavior |
|------|----------|
| `tools` not passed to `compact()` (slash command, tests) | Focus `forkChat` skipped → summary-only (current behavior) |
| `tools` is empty array (neglected mode) | Same as above — fallback to summary-only |
| ESC / watchdog abort during `Promise.all` | `signal` propagates to both `retryChat` and `forkChat` → `StreamAbortedError` propagates to caller |
| `forkChat` throws (transient error) | `Promise.all` rejects → error propagates to caller (same as current summary failure) |
| Focus response is empty string | `focusSection` is `''` → no `### Recent Working Memory` section added; summary-only shape |
| Tool result pushes over threshold mid-TOOL | Next LLM stage entry catches it — at most one extra tool result over threshold (harmless; model context window > TOKEN_THRESHOLD) |
| Hook-deferred compact + needsCompact both true | LLM stage checks `needsCompact` first (proactive), then `deferredCompact` (reactive). If proactive compact already ran, `needsCompact` is false but `deferredCompact` may still be true → runs a second compact. This is acceptable (rare double-compact) and both are cache-friendly. |

## 8. Token Budget

The focus `forkChat` sends the **full** message array (un-minified) to the LLM. At the moment compaction triggers, `tokenCount > TOKEN_THRESHOLD`, so this is a single call at/above the threshold — the same cost as one normal agent turn, and cache-hot (the prefix is identical to what the next LLM call will use). The summary `retryChat` sends only the minified text (far smaller). Total cost per compaction: one cached call + one fresh small call, run concurrently.

Post-compact, the two-message result is well under the threshold (summary ≈ 1-2k tokens, focus ≈ 1-3k tokens), leaving the agent ample room to continue.

## 9. Testing

### 9.1 Test stub fix (completed)

Because the compact check moved to the **top** of `handleLlm` (before the existing `isNeglectedMode` / crossroad / `retryChat` code paths), every test file that mocks `Triologue` with an inline `vi.mock('../../../loop/triologue.js')` `TriologueStub` class must now stub `needsCompact`. Five LLM state test files had identical stubs lacking the method, causing `TypeError: triologue.needsCompact is not a function`:

- `src/tests/loop/states/llm-esc-precheck.test.ts`
- `src/tests/loop/states/llm-empty-tool-role.test.ts`
- `src/tests/loop/states/llm-esc-crossroad.test.ts`
- `src/tests/loop/states/llm-crossroad-cooldown.test.ts`
- `src/tests/loop/states/llm-esc-midcall.test.ts`

**Fix:** added `needsCompact = vi.fn(() => false);` to each `TriologueStub` (after the last method, `getMessages`). The stub returns `false` so the compact branch is skipped in these tests (they test ESC/crossroad behavior, not compaction). The shared `createPassData()` factory in `src/tests/loop/esc-test-helpers.ts` was also updated with `deferredCompact: false`.

### 9.2 Verification result

`pnpm test` — 122 files, **2170 passed**, 10 skipped, **0 failures**. `pnpm typecheck` — exit 0.

### 9.3 Future test coverage

- **New unit test** — `runAutoCompact` with a mock `tools` array:
  - Assert `forkChat` is called with `getMessages()` + the provided tools + `toolChoice: 'none'`.
  - Assert the returned user message contains both the summary and the `### Recent Working Memory` section.
  - Assert the result is exactly two messages.
- **Fallback test** — `runAutoCompact` without `tools`:
  - Assert `forkChat` is not called.
  - Assert the result matches the current summary-only shape.
- **Relocation test** — `handleLlm` with `triologue.needsCompact()` returning true:
  - Assert `compact` is called with tools before `retryChat`.
  - Assert stat counts are reset.
- **Hook-deferred test** — `handleHook` with `compactRequested`:
  - Assert `pass.deferredCompact` is set to true.
  - Assert `compact` is NOT called in hook.ts.
  - Assert `handleLlm` calls `compact` when `deferredCompact` is true.