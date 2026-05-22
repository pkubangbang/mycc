# Hint-Round Design Review

> **Date**: 2026-05-22
> **Reviewer**: Planning Agent
> **Scope**: Full hint-round system including confusion tracking, hint generation, and LLM context extraction

---

## 1. Overview

The hint-round system is a **meta-cognitive diagnostic** mechanism. When the LLM agent shows signs of being "stuck" (confused, looping, accumulating errors), the system triggers a self-analysis LLM call and injects structured guidance back into the conversation.

### Key Files

| File | Role |
|------|------|
| `src/context/shared/base-core.ts` | Confusion index storage (`confusionIndex` field) |
| `src/loop/states/tool.ts` | Confusion scoring after each tool execution |
| `src/loop/states/hook.ts` | Confusion scoring per assistant turn (plan mode) |
| `src/loop/states/collect.ts` | Hint trigger check, calls `generateHintRound()` |
| `src/loop/states/prompt.ts` | Confusion reset on new user query |
| `src/loop/hint-round.ts` | Core hint generation: LLM analysis + injection |
| `src/utils/llm-chat-minifier.ts` | `minifyForHint()`: context extraction for hint |
| `src/loop/triologue.ts` | `generateHintRound()` wrapper, `HintRoundContext` |
| `src/context/teammate-worker.ts` | Child process confusion handling (mail to lead) |

---

## 2. Architecture Flow

```
PROMPT ──► COLLECT ──► LLM ──► HOOK ──► TOOL ──► STOP ──► PROMPT
              │                          │
              │                   [Tool Exec]
              │                    confusion scoring:
              │                     - action tool: -1
              │                     - repeated tool: +1
              │                     - tool error: +2
              │                     - read-only: 0
              │                          │
              ▼                          ▼
         [Check confusion]
         if >= 10 && msgCount >= 6:
           → LLM self-analysis
           → inject HINT note
           → reset confusion to 0
```

### Trigger Conditions (in `collect.ts`)

```typescript
confusionIndex >= 10          // CONFUSION_THRESHOLD
messageCount >= 6             // MIN_MESSAGES_FOR_HINT
lastRole === 'assistant'      // TP-safe: assistant → user via note
```

### Confusion Scoring Rules (in `tool.ts`)

| Event | Delta |
|-------|-------|
| Exploration tool (read_file, recall, etc.) | 0 |
| Action tool, first use | -1 |
| Action tool, repeated (in last 5 calls) | +1 |
| `mail_to` repeated | +2 |
| Tool result indicates error | +2 |
| Bash read-only (ls, cat, grep, git status) | 0 |
| Bash action, first use | -1 |
| Bash action, repeated | +1 |
| Assistant turn in plan mode (`hook.ts`) | +1 |

### Reset Points

| Location | When | Why |
|----------|------|-----|
| `prompt.ts` | New user query submitted | Fresh turn, fresh score |
| `collect.ts` | After hint round fires | Hint resets confusion |

---

## 3. Hint Generation (in `hint-round.ts`)

### Steps

1. **Context Extraction**: `minifyForHint()` extracts:
   - First real user message (as `userIntent`)
   - Last 10 tool calls with status (success/error/pending)
   - Last 5 errors
   - Repetition patterns (3+ same tool)
   - Confusion score + breakdown
   - Note: system notes (REMINDER, HINT, CONTINUE, etc.) are **filtered out**

2. **Wiki Domain Discovery**: Queries wiki for available domains to suggest knowledge search

3. **LLM Prompt Construction**: Builds analysis prompt with:
   - User's intent
   - Current progress (recent tool calls)
   - Problems encountered
   - Stuck patterns
   - Available wiki domains
   - **JSON schema** for structured output

4. **LLM Call**: Calls `retryChat()` with `format: hintSchema` (JSON mode), ESC-safe via `AbortController`

5. **JSON Parsing**: Retry loop until valid JSON with all 5 required fields:
   - `blocker` (string): What's preventing progress
   - `next_step` (string): Concrete next action
   - `focus_on` (string): Key area to focus
   - `wiki_domain` (string): Domain for knowledge search
   - `wiki_query` (string): Query for knowledge search

6. **Injection**: Formats as readable markdown and injects via `ctx.note('HINT', ...)`:
   ```
   Problem Analysis:
   **Blocker:** ...
   **Next Step:** ...
   **Focus On:** ...
   **Wiki Search:** Domain="...", Query="..."
   **Pending Skill Compilation:** ...
   ```

---

## 4. Strengths

### 4.1 Self-Correction Loop
The system enables the LLM to **analyze its own stuck state** and get actionable guidance injected directly into context. This is more targeted than generic compaction or blanket context trimming.

### 4.2 ESC-Safe Abort
Full ESC interrupt support via `escAware()` + `AbortController`. If the user hits ESC during hint generation, the system aborts cleanly and returns to PROMPT immediately.

### 4.3 Child Process Differentiation
Children don't self-analyze — they **mail the lead** for guidance. This avoids recursive confusion (a child analyzing its own confusion through a potentially confused LLM) and centralizes decision-making.

### 4.4 Structured Output
Uses `format: hintSchema` (JSON mode) for reliable parsing. The retry loop handles LLM output errors gracefully, re-prompting if JSON is malformed or missing required fields.

### 4.5 Noise Filtering
`minifyForHint()` filters out system noise (REMINDER, HINT, CONTINUE, WRAP_UP notes) so the LLM analyzes only meaningful conversation content.

### 4.6 Wiki Integration
The analysis prompt includes available wiki domains, so the LLM can suggest targeted knowledge base searches as part of the recovery plan.

---

## 5. Design Observations & Potential Issues

### 5.1 Split Confusion Scoring Logic
**Observation**: Confusion scoring is split across two files — `tool.ts` handles tool-type-based scoring, `hook.ts` adds +1 per assistant turn in plan mode. This works but makes the scoring rules hard to audit.

**Risk**: A developer adding a new tool in `src/tools/` might not realize they need to update `EXPLORATION_TOOLS` or `ACTION_TOOLS` sets in `tool.ts` to get correct confusion behavior. There's no automated check.

### 5.2 Same-Model Self-Analysis
**Observation**: The hint round uses the **same LLM model** (`retryChat` with `MODEL`) as the main agent loop. If the LLM is confused/inattentive, can it effectively analyze its own confusion?

**Risk**: The hint analysis may suffer from the same attention degradation that triggered it. Consider:
- Could a different (larger or more capable) model be used for the analysis?
- Could the hint analysis prompt include the *raw* (untruncated) conversation rather than the minified version?
- The retry loop mitigates this somewhat (re-prompts on bad JSON), but doesn't fix bad analysis content.

### 5.3 No Minimum Gap Between Hints
**Observation**: After a hint fires, confusion is reset to 0. But if the agent immediately becomes confused again (e.g., 6 messages + >= 10 confusion), another hint fires immediately. The only guard is `messageCount >= 6`.

**Risk**: In edge cases, this could cause **hint looping** — rapid-fire hint rounds without meaningful progress. Consider adding a cooldown (e.g., "don't fire another hint within N turns of the last one") or a max-hints-per-turn limit.

### 5.4 Repetition Detection is Tool-Level Only
**Observation**: Repetition is detected as "same tool name in last 5 calls" (from `sequence.getEvents()`). This doesn't detect semantic repetition (e.g., calling `read_file` 4 times on different files while looking for the same information).

**Risk**: Legitimate repeated tool usage (e.g., writing 5 files with `write_file`, testing with `bash` multiple times) gets penalized as +1 per repeated call. This could inflate confusion in scenarios where repetition is expected and productive.

### 5.5 Context Extraction Format Inconsistency
**Observation**: `minifyForHint()` uses direct `truncate()` on content, producing plain text. But `minifyMessages()` (used for auto-compact) uses a compact pipe-delimited format (`ux|...`, `ax|...`, `ti|...`, `to|...`). These are inconsistent.

```
minifyForHint → plain text with truncation(...)
minifyMessages → pipe-delimited compact format (ux|ax|ti|to)
```

**Risk**: The LLM receives different formats for different purposes, which could confuse the model about the "standard" way it should read conversation history.

### 5.6 Hint Context Lacks System/Project Context
**Observation**: `getMessagesRaw()` returns only the raw conversation messages (user/assistant/tool). The hint analysis **does not see**:
- The system prompt
- Project context (README)
- Mindmap instructions
- Available tools and their descriptions

**Risk**: The hint LLM might suggest using tools that don't exist, or miss solutions that require understanding the system architecture.

### 5.7 `onHint` Callback is Effectively No-Op
**Observation**: In `agent-repl.ts`:
```typescript
// Will be notified during hint round
```
But the `onHint` callback passed to `Triologue` is just the default no-op (`() => {}`). The callback is wired into `HintRoundContext` and called as `ctx.onHint?.()` after successful generation, but nothing subscribes to it.

**Risk**: Dead code / misleading infrastructure. If intent was to log/track hint events, the callback is unused.

### 5.8 Confusion Breakdown is Heuristic
**Observation**: `generateBreakdown()` in `collect.ts` estimates turn count as `Math.ceil(events.length / 3)`. This is a rough heuristic — a single turn could have 1 tool call or 15 tool calls.

**Risk**: The breakdown shown to the LLM ("3 assistant turns, 2 tool errors, 1 repeated tool") may be inaccurate, especially with tools that have many parallel calls.

### 5.9 No Metrics/Tracking
**Observation**: There's no logging or metrics for hint round frequency, success rate, or impact. It's not possible to answer questions like:
- "How often does the hint round fire in a typical session?"
- "Does the hint round actually improve task completion?"
- "Which tools/patterns most commonly trigger hints?"

---

## 6. Child Process Behavior (teammate-worker.ts)

Children have their own confusion tracking (same scoring logic) but a different response:

```typescript
if (confusionIndex >= 10 && messageCount >= 6) {
  // Send mail to lead requesting guidance
  ctx.team.mailTo('lead', 'I\'m stuck (confusion index: ...)', helpRequest);
  ctx.core.resetConfusionIndex();
}
```

**Key difference**: Children **do not self-analyze**. They:
1. Generate a help request using LLM
2. Mail it to the lead
3. Reset confusion

The lead receives this mail in its COLLECT state and injects it as a `[MAIL]` note.

### Child-Specific Scoring (teammate-worker.ts)
- Uses same scoring as main (action -1, error +2, repetition +1, etc.)
- Additional +1 per LLM turn (in the worker's LLM callback)

---

## 7. Summary

### Well-Designed Aspects
- Self-correction via LLM self-analysis is clever and targeted
- ESC interrupt support is thorough
- Child process differentiation (mail vs self-analyze) avoids recursive confusion
- Structured JSON output with retry loop improves reliability
- Noise filtering prevents system messages from polluting analysis

### Areas for Potential Improvement
- ~~**Same-model self-analysis**~~: Consider using a different model or richer context for hint analysis *(deferred)*
- ~~**Hint cooldown**~~: Add minimum gap between hints *(accepted as-is, no cooldown needed)*
- ~~**Semantic repetition detection**~~: Go beyond tool-name matching *(accepted as-is, repetition logic is fair)*
- ~~**Full context in hints**~~: Include system prompt/project context in analysis *(deferred)*
- ~~**Metrics**~~: Track hint frequency and effectiveness *(deferred)*
- ~~**Unify context extraction formats**~~: Align `minifyForHint()` with `minifyMessages()` ✅ *done (commit 761ab12)*
- ~~**`onHint` callback**~~: Either wire it up or remove it ✅ *done (commit 44ac827)*
- ~~**Breakdown heuristic**~~: Improve turn count estimation *(deferred)*
- ~~**Tool classification**~~: Centralize tool categories *(accepted as-is, stays hardcoded)*
- ~~**Prepare error detection**~~: Only check error literals from text start *(accepted, actionable — see plan below)*

---

## 8. Action Plan: COLLECT Injection Rework

> **Date**: 2026-05-22
> **Status**: Planned
> **Scope**: Two concrete changes to `src/loop/states/collect.ts`

### Problem Summary

**Issue A — Stale `lastRole`**: `collect.ts` captures `const lastRole = triologue.getLastRole()` once at function start, then uses it for guards across all injection steps (mails, hints, nudges). After mail injection changes the actual role, subsequent step guards are checking a stale value.

**Issue B — Missing bridge for 'tool' role**: In multi-move sequences (`TOOL → COLLECT → LLM → HOOK → TOOL → ...`), COLLECT is entered with `lastRole='tool'`. The `lastRole !== 'tool'` guards silently skip ALL injections — mails, hints, and nudges are lost during these passes. Compare:

| Guard | Stale check | Behavior with stale 'tool' |
|-------|-------------|---------------------------|
| `lastRole !== 'tool'` (mails) | false | ❌ Mail skipped |
| `lastRole === 'assistant'` (hint) | false | ❌ Hint skipped |
| `lastRole !== 'tool'` (todo nudge) | false | ❌ Nudge skipped |
| `lastRole !== 'tool'` (brief nudge) | false | ❌ Nudge skipped |

### Change 1: `ensureAssistant()` bridge helper

Replace stale `lastRole` guards with an on-demand bridge that transitions `'tool' → 'assistant'` only when something actually needs to be injected.

**New helper function:**
```typescript
function ensureAssistant(tri: Triologue): void {
  if (tri.getLastRole() === 'tool') {
    tri.agent('Continuing.');
  }
}
```

**`ensureAssistant()` is called inline before each injection** (mails, hints, nudges). It uses a fresh `getLastRole()` check, so if the previous step already bridged, subsequent calls are no-ops.

### Change 2: Remove stale `lastRole` and restructure steps

**At the top of `handleCollect()`:** Remove the stale capture `const lastRole = triologue.getLastRole()`.

**Step 2 (Mails)** — Before: silently skipped if `lastRole !== 'tool'` is false.
```typescript
// BEFORE
if (lastRole !== 'tool') {
  const mails = ctx.mail.collectMails();
  if (mails.length > 0) { ... }
}

// AFTER
const mails = ctx.mail.collectMails();
if (mails.length > 0) {
  ensureAssistant(triologue);
  // ... inject mail content via note()
}
```

**Step 3 (Hint)** — Before: blocked by `lastRole === 'assistant'` stale guard.
```typescript
// BEFORE
if (confusionIndex >= 10 && messageCount >= 6) {
  if (lastRole === 'assistant') { ... hint generation ... }
}

// AFTER
if (confusionIndex >= 10 && messageCount >= 6) {
  ensureAssistant(triologue);
  // ... hint generation (LLM call, then note('HINT', ...))
}
```

**Step 4 (Todo nudge)** — Before: silently skipped if stale role is 'tool'.
```typescript
// BEFORE
if (turn.nextTodoNudge === 0 && lastRole !== 'tool') {
  triologue.note('REMINDER', `Update your todos. ${ctx.todo.printTodoList()}`);
}

// AFTER
if (turn.nextTodoNudge === 0) {
  ensureAssistant(triologue);
  triologue.note('REMINDER', `Update your todos. ${ctx.todo.printTodoList()}`);
}
```

**Step 5 (Brief nudge)** — Same pattern as step 4.

**Step 6 (CONTINUE)** — **Removed entirely.** The note `'Continue with your task.'` is noise — the LLM was already going to continue.

### Change 3: Fix `generateBreakdown()` error detection

The function currently uses `result.includes('error')` which matches the word "error" **anywhere** in text — including inside normal file content read by the agent.

**Before:**
```typescript
const errors = events.filter(e => {
    const result = e.result?.toLowerCase() || '';
    return result.includes('error') || result.includes('failed') ||
           result.includes('fatal') || result.includes('enoent') ||
           result.includes('eacces') || result.includes('eperm');
});
```

**After:**
```typescript
const errors = events.filter(e => {
    const result = e.result?.toLowerCase() || '';
    return result.startsWith('error:') || result.startsWith('error ') ||
           result.startsWith('fatal:') || result.startsWith('failed:') ||
           result.startsWith('failed ') ||
           result.includes('enoent') || result.includes('eacces') ||
           result.includes('eperm') || result.includes('permission denied');
});
```

(Keep `includes` for OS error codes like `ENOENT`/`EACCES` — those won't appear in normal file content. Change `error`, `failed`, `fatal` to use `startsWith`.)

### Files Changed

| File | Change | Risk |
|------|--------|------|
| `src/loop/states/collect.ts` | Add `ensureAssistant()` helper | Low — simple role check |
| `src/loop/states/collect.ts` | Remove stale `lastRole` capture | Low — no longer referenced |
| `src/loop/states/collect.ts` | Restructure steps 2–5 with fresh guards | Medium — changes injection timing for multi-move sequences |
| `src/loop/states/collect.ts` | Remove step 6 (CONTINUE note) | Low — noise removal |
| `src/loop/states/collect.ts` | Fix `generateBreakdown()` error detection | Low — only affects hint breakdown string |

### Verification

1. `pnpm lint` — no new warnings
2. `npx tsc --noEmit` — no type errors
3. `pnpm test` — all 1425+ tests pass
4. Manual reasoning: trace TOOL → COLLECT → LLM (multi-move) to verify mails/nudges/hints now inject instead of being skipped
