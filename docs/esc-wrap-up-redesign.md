# ESC Wrap-Up Redesign: Inline Triologue with Rollback

## Problem

The current `esc-wrap-up.ts` has a triologue parity issue. When ESC interrupts
an LLM call, `startWrapUp()` manually snapshots messages and runs a background
LLM call. The wrap-up content is later injected via `injectWrapUp()`, bypassing
normal triologue append methods.

### Root Cause

`runWrapUpLLM()` manually constructs the messages array:

```ts
const messages = [
  ...triologue.getMessages(),      // snapshot at ESC time
  { role: 'user', content: WRAP_UP_USER_MESSAGE },
];
```

Problems:
1. **Manual snapshot** — bypasses `triologue.note()` / `triologue.agent()`
2. **Stale if delayed** — snapshot is frozen at ESC time; if user types between
   ESC and injection, the triologue diverges
3. **No tools** — forces `tools: []`, creating an artificial state unlike real turns
4. **`injectWrapUp()` is an external mutation** — it reaches into triologue from
   outside, bypassing TP validation and the normal state machine flow

### LN of Current Flow

Normal turn (no ESC):
```
system, user, [tool1]?, tool1!, agent
```

ESC + wrap-up committed (user submits after grace period):
```
system, user, agent_wrap, user
```
(where `user` is modified in-place: original query + `[WRAP_UP]` note appended
via `note()` combine behavior)

ESC + wrap-up discarded (user submits within grace period):
```
system, user
```
(wrap-up content is discarded, no triologue mutation occurs)

## Design: Inline Wrap-Up with Rollback

Instead of snapshotting and injecting later, **write the wrap-up turn directly
into the triologue at ESC time, and roll it back if the user submits too quickly**.

### Key Design Decisions

**1. `beginWrapUp()` always adds a separate user message** — It does NOT combine
with the last user message. This ensures `rollbackWrapUp()` can work via simple
array truncation (`messages.length = wrapUpMark`). If it combined, rollback
would need to restore the original content string, which is fragile.

**2. `wrapUpMark` stays set until explicit commit/rollback** — `finishWrapUp()`
adds the agent message but does NOT clear the mark. This allows rollback to
undo both the user_wrap note and agent_wrap response during the grace period.
Only `commitWrapUp()` clears the mark (called when user submits past grace period).

### New Triologue API

```ts
class Triologue {
  private wrapUpMark: number = -1;

  /** Record current message count, add WRAP_UP note as separate message */
  beginWrapUp(): void;

  /** Add assistant response (mark stays for potential rollback) */
  finishWrapUp(content: string): void;

  /** Permanently keep the wrap-up turn, clear the mark */
  commitWrapUp(): void;

  /** Truncate messages back to pre-wrap-up state */
  rollbackWrapUp(): void;

  /** True if beginWrapUp was called but not yet committed/rolled back */
  hasActiveWrapUp(): boolean;
}
```

### Implementation

```ts
beginWrapUp(): void {
  // Guard: cannot begin wrap-up during tool round
  if (this.getLastRole() === 'tool') {
    return; // silently ignore - TP violation would be worse
  }
  this.wrapUpMark = this.messages.length;
  // Always add as SEPARATE message (never combine with last user)
  // This guarantees rollback works via simple array truncation
  this.addMessage({
    role: 'user',
    content: `[WRAP_UP] LLM call interrupted. Please wrap up quickly and ask user for next steps.`,
  });
}

finishWrapUp(content: string): void {
  if (this.wrapUpMark === -1) return; // already rolled back or committed
  this.addMessage({ role: 'assistant', content });
  // Note: wrapUpMark is NOT cleared here — keep it for grace-period rollback
}

commitWrapUp(): void {
  // Permanently keep the wrap-up turn
  this.wrapUpMark = -1;
}

rollbackWrapUp(): void {
  if (this.wrapUpMark === -1) return; // nothing to rollback
  // Simple truncation — works because beginWrapUp added separate messages
  this.messages.length = this.wrapUpMark;
  this.tokenCount = estimateTokensForMessages(this.messages);
  // Clear pending tool calls (any from the wrap-up turn are now invalid)
  this.pendingToolCalls.clear();
  this.pendingToolCallOrder = [];
  this.wrapUpMark = -1;
}

hasActiveWrapUp(): boolean {
  return this.wrapUpMark !== -1;
}
```

### Updated `esc-wrap-up.ts`

```ts
// startWrapUp now calls triologue.beginWrapUp() instead of snapshotting
export function startWrapUp(triologue: Triologue): void {
  triologue.beginWrapUp();

  const promise = runWrapUpLLM(triologue);

  wrapUpState = {
    promise,
    content: null,
    completedAt: null,
    shown: false,
    triologue,
  };

  promise.then((content) => {
    if (wrapUpState.promise !== promise) return;
    wrapUpState.content = content;
    wrapUpState.completedAt = Date.now();

    if (content) {
      // Try to add agent response. If triologue was already rolled back
      // (user submitted quickly), this is a no-op (wrapUpMark === -1).
      triologue.finishWrapUp(content);
    }
  });
}

// Simplified public API — no more injectWrapUp()
export function isWrapUpReady(): boolean {
  return wrapUpState.content !== null && wrapUpState.content !== '';
}

export function commitWrapUp(triologue: Triologue): void {
  triologue.commitWrapUp();
  clearWrapUp();
}

export function rollbackWrapUp(triologue: Triologue): void {
  triologue.rollbackWrapUp();
  clearWrapUp();
}
```

### Updated `prompt.ts`

```ts
// Quick-return ESC: Handle wrap-up timing logic
const wrapUpAction = shouldAppendWrapUp();
if (wrapUpAction === 'append') {
  commitWrapUp(triologue);    // keep the wrap-up turn
} else {
  rollbackWrapUp(triologue);  // remove wrap-up messages
}

// Bridge tool → user gap: if last role is 'tool', insert placeholder
if (triologue.getLastRole() === 'tool') {
  triologue.agent('...');
}

// Add user message to triologue
triologue.user(query);
```

## Loop Notation (LN) Analysis

### Case 1: Normal turn (no ESC)

```
system, user, [tool1]?, tool1!, agent
```

Standard TP: system → user → assistant (tool calls) → tool → assistant.

---

### Case 2: ESC + wrap-up committed (user submits after grace period)

Sequence of triologue states:

```
# 1. User submits query1
system, user1

# 2. ESC pressed → beginWrapUp()
system, user1, user_wrap
                     ^ fresh message, never combined with user1

# 3. Wrap-up LLM completes → finishWrapUp(content)
system, user1, user_wrap, agent_wrap
                           ^ wrapUpMark still set for potential rollback

# 4. User submits query2 after 3s → commitWrapUp() + triologue.user(query2)
system, user1, user_wrap, agent_wrap, user2
```

LN: `system, user, user, agent, user`

TP validation:
- user → user: **allowed** (two user messages are idempotent for the LLM)
- user → assistant: **valid** ✓
- assistant → user: **valid** ✓

**Clean TP: no violations.**

---

### Case 3: ESC + wrap-up discarded (user submits before completion)

```
# 1. User submits query1
system, user1

# 2. ESC pressed → beginWrapUp()
system, user1, user_wrap

# 3. User submits query2 (wrap-up still running)
#    → rollbackWrapUp() truncates to wrapUpMark (2 messages)
system, user1

# 4. Bridge check: lastRole = 'user' → no bridge needed
#    triologue.user(query2) combines with user1
system, user1+user2
```

LN: `system, user`

**The wrap-up turn (user_wrap) never reaches the LLM. Clean.**

---

### Case 4: ESC + wrap-up discarded (user submits within 3s after completion)

```
# 1. User submits query1
system, user1

# 2. ESC pressed → beginWrapUp()
system, user1, user_wrap

# 3. Wrap-up LLM completes → finishWrapUp(content)
system, user1, user_wrap, agent_wrap

# 4. User submits query2 within 3s
#    → rollbackWrapUp() truncates to wrapUpMark (2 messages)
system, user1

# 5. Bridge check: lastRole = 'user' → no bridge needed
#    triologue.user(query2) combines with user1
system, user1+user2
```

LN: `system, user`

**Same as Case 3. Simple truncation removes both user_wrap and agent_wrap.**

---

### Case 5: ESC during tool execution (edge case)

If ESC is pressed during a tool execution (not LLM), the flow in `tool.ts`:

```
system, user, [tool1]?, tool1!

# ESC pressed → tool.ts calls skipPendingTools() + startWrapUp()

# skipPendingTools adds placeholder tool results
system, user, [tool1]?, tool1!, tool1_placeholder!

# startWrapUp → beginWrapUp()
system, user, [tool1]?, tool1!, tool1_placeholder!, user_wrap
```

If kept: `system, user, [tool1]?, tool1!, tool1_placeholder!, user_wrap, agent_wrap, user2`

TP: ... tool → tool → user → assistant → user
- tool → tool: allowed (consecutive tool results) ✓
- tool → user: **valid** ✓
- user → assistant: **valid** ✓
- assistant → user: **valid** ✓

If discarded: rollback removes `user_wrap` + `tool1_placeholder!` + `agent_wrap` (if added).
Then bridge tool → user gap with agent placeholder.

---

### Summary of LN patterns

| Scenario | LN | TP Violations |
|----------|----|---------------|
| Normal turn | `system, user, [tool]?, tool!, agent` | None |
| ESC + kept | `system, user, user_wrap, agent_wrap, user` | None (user→user is benign) |
| ESC + discarded (before complete) | `system, user` | None |
| ESC + discarded (after complete) | `system, user` | None |
| ESC during tool + kept | `..., tool!, tool_placeholder!, user_wrap, agent_wrap, user` | None |

## Files Changed

| File | Change |
|------|--------|
| `src/loop/triologue.ts` | Add `beginWrapUp()`, `finishWrapUp()`, `commitWrapUp()`, `rollbackWrapUp()`, `hasActiveWrapUp()`, `wrapUpMark` field |
| `src/loop/esc-wrap-up.ts` | Replace snapshot with `triologue.beginWrapUp()`, replace `injectWrapUp()`/`shouldAppendWrapUp()` with simplified API |
| `src/loop/states/prompt.ts` | Replace `injectWrapUp` + `shouldAppendWrapUp` with `commitWrapUp()` / `rollbackWrapUp()` |
| `src/loop/agent-io.ts` | Keep letter-box display polling as-is (reads from `wrapUpState.content`) |

## Benefits

1. **No snapshot** — The wrap-up note is in the triologue from the start
2. **No race** — `rollbackWrapUp()` is a simple array `.length` truncation, instant
3. **TP-safe** — LN analysis confirms no violations in any scenario
4. **Commit/Rollback pattern** — mirroring transaction semantics; clear state management
5. **Discard is cheap** — just truncate, no complex state to unwind
6. **No stale state** — `triologue.getMessages()` always returns the true current state
