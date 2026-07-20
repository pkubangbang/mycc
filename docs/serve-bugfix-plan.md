# /serve Feature — Bug Fix & Improvement Plan

> Branch: `feat/serve-webui`
> Date: 2026-07-05
> Status: Plan (awaiting approval)

---

## Pre-requisite: Fix teammate spawning (pnpm install)

### Problem
`tm_create` fails with "Teammate failed to initialize within 30s" on `feat/serve-webui`.

### Root cause
After merging `main` into `feat/serve-webui`, `pnpm install` was never run. The serve dependencies (`express`, `ws`, `vite`, `@vitejs/plugin-vue`) are declared in `package.json` and exist in the pnpm store (`node_modules/.pnpm/`), but their **symlinks are missing from `node_modules/`** (e.g., `node_modules/express` does not exist).

The teammate child process import chain:
```
teammate-worker.ts
  → child-context.ts → shared/loader.ts
  → agent-io.ts (line 18) → serve-registry.ts → serve-hub.ts
  → import express from 'express'  ← ERR_MODULE_NOT_FOUND
```

ESM module resolution fails immediately → child process crashes → parent waits 30s → timeout kills it.

### Does this happen on main?
**No.** `main`'s `package.json` has no `express`, `ws`, or `vite`. The `src/serve/` directory and the `getServeHub` import in `agent-io.ts` don't exist on main. This is **branch-specific to `feat/serve-webui`**.

### Fix
Run `pnpm install` on the `feat/serve-webui` branch to restore the missing symlinks.

### Architectural note (optimization, not a blocker)
Even after `pnpm install`, every teammate child process will load `express`, `vite`, and the entire serve stack via the transitive import chain — even when serve mode isn't active. The `getServeHub` import in `agent-io.ts` (line 18) should be made lazy (dynamic `import()`) to avoid this overhead. This is a performance optimization, not a functional bug.

---

## Context

A detailed code review of the `/serve` feature identified 1 critical bug, 3 high-severity issues, 4 medium, 4 low, and 3 nitpicks. After user feedback, the plan was refocused: `ask()` is a CLI construct and should not be patched for WebSocket — instead, the web UI should render **interactive cards** for a better UX. This document captures the final actionable plan.

---

## Phase 1 — Critical Fixes (must-do before release)

### 1.1 Guard all `ws.send()` calls

**Bug**: C1 — User input silently lost or uncaught exception when WebSocket isn't OPEN.

**Files to change**:
- `src/web/src/main.ts` — all four `chatApi` methods: `sendInput`, `sendExit`, `sendInterrupt`, `sendRetry`

**Implementation**:
1. Add a helper function `wsSend(data: object): boolean` that checks `ws && ws.readyState === WebSocket.OPEN` before sending. Returns `true` on success, `false` if socket not ready.
2. Replace all `ws?.send(JSON.stringify(...))` calls with `wsSend({ type: 'input', text })` etc.
3. If `wsSend` returns `false`, show a transient error in the UI (e.g., set a `state.connectionError` string that renders briefly in `StatusBar.vue`).

**Acceptance criteria**:
- No uncaught `InvalidStateError` when sending during reconnect.
- User sees a visible error if their input can't be delivered, not a silent drop.
- Input/Retry/Exit/Interrupt buttons are disabled when `connectionStatus !== 'connected'`.

---

### 1.2 Reset stale UI state on WS disconnect

**Bug**: M3 — Stale `isWaiting`, `isRunning`, `showRetry` after disconnect causes the C1 dead-end.

**Files to change**:
- `src/web/src/main.ts` — `ws.onclose` handler

**Implementation**:
1. In `ws.onclose`, after setting `connectionStatus = 'reconnecting'`, also reset:
   ```ts
   state.isWaiting = false;
   state.isRunning = false;
   state.showRetry = false;
   ```
2. The server's reconnect handler (`serve-hub.ts` `onWsConnection`, lines 371-373) already sends a `{ type: 'prompt', content: '' }` if `inputResolver` is active — this will re-establish `isWaiting = true` on reconnect. No server change needed.

**Acceptance criteria**:
- After WS disconnect, no stale Retry button remains.
- After reconnect, if the agent is waiting for input, the prompt state is correctly restored by the server's broadcast.

---

### 1.3 Handle serve startup failure gracefully

**Bug**: H3 — Unhandled rejection if Vite dev server or HTTP listen fails.

**Files to change**:
- `src/serve/activate.ts` — `activateServe()`

**Implementation**:
1. Wrap the body of `activateServe` in try/catch:
   ```ts
   try {
     await hub.start(port);
     // ... existing setup ...
   } catch (err) {
     const msg = err instanceof Error ? err.message : String(err);
     console.log(chalk.red(`\nFailed to start Web UI: ${msg}`));
     console.log(chalk.gray('Terminal mode continues. Fix the error and try /serve again.'));
   }
   ```
2. Ensure `hub.start()` failure doesn't leave `running = true` (verify `start()` sets `running = true` only after successful listen — it does, line 218).

**Acceptance criteria**:
- Port-in-use error prints a friendly message, app continues in terminal mode.
- Missing Vite deps or web directory error doesn't crash the process.

---

## Phase 2 — Interactive Card Design (replaces ask() serve path)

### Problem

`ask()` is a CLI construct with options (`onEsc`, `onEnter`, `useAsPrompt`, `initialContent`) that have no web equivalent. The current serve-mode path in `ask()` (agent-io.ts lines 587-594) broadcasts a plain `prompt` and waits for chat text — ignoring all options and producing behavioral divergence. Patching `ask()` for WebSocket is the wrong approach; the web UI should render **interactive cards** instead.

### Design

Introduce a new WS message type `'card'` for structured interactions:

#### Server → Client

```ts
interface CardMessage {
  type: 'card';
  cardId: string;          // unique ID to match response
  query: string;            // the question text
  kind: 'input' | 'confirm' | 'choice';
  options?: { label: string; value: string }[];  // for 'choice' kind
  initialContent?: string;  // pre-fill for 'input' kind
  placeholder?: string;
}
```

- **`input`**: renders a text input field + submit button. Maps from `ask()` with no special options.
- **`confirm`**: renders the query + "Yes" / "No" buttons. Maps from `ask()` calls that use `onEnter` as a default (e.g., "Press Enter to continue...").
- **`choice`**: renders the query + option buttons. Maps from `ask()` calls that have discrete options (e.g., "Retry? [Y/n]" → Yes/No buttons).

#### Client → Server

```ts
{ type: 'card-response', cardId: string, value: string }
```

#### ask() serve-mode rewrite

**File**: `src/loop/agent-io.ts` — `ask()` method, serve-mode branch (lines 587-594)

Replace the current serve-mode path:

```ts
if (getServeHub().isRunning()) {
  const cardId = `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  
  // Determine card kind from AskOptions
  let kind: 'input' | 'confirm' | 'choice' = 'input';
  let options: { label: string; value: string }[] | undefined;
  
  // Retry? [Y/n] pattern → choice card
  if (/retry/i.test(query) && options?.onEnter !== undefined) {
    kind = 'choice';
    options = [
      { label: 'Yes', value: 'y' },
      { label: 'No', value: 'n' },
    ];
  }
  // onEnter with empty-string default → confirm card  
  else if (options?.onEnter !== undefined) {
    kind = 'confirm';
    options = [
      { label: 'Continue', value: options.onEnter },
      { label: 'Cancel', value: options.onEsc ?? '' },
    ];
  }
  
  getServeHub().broadcastCard({
    type: 'card',
    cardId,
    query,
    kind,
    options,
    initialContent: options?.initialContent,
  });
  
  const result = await getServeHub().waitForCardResponse(cardId);
  
  if (result === null) {
    // serve stopped mid-card — fall back to terminal
    return options?.onEsc ?? null;
  }
  return result;
}
```

#### ServeHub changes

**File**: `src/serve/serve-hub.ts`

1. Add `broadcastCard(card: CardMessage)` — broadcasts to all clients, logs to messageLog.
2. Add `waitForCardResponse(cardId: string): Promise<string | null>` — returns a promise stored in a `Map<string, resolver>` keyed by `cardId`.
3. In `onWsMessage`, handle `type: 'card-response'` — look up resolver by `cardId`, resolve it, delete from map.
4. In `stop()`, reject all pending card resolvers with `null` (same pattern as `abortInput()`).
5. In `abortInput()` (called by `stop()`), also clear all card resolvers.

#### Frontend changes

**New file**: `src/web/src/components/CardItem.vue`

Props: `{ card: CardMessage }`
Renders based on `kind`:
- `input`: `<textarea>` + submit button. Pre-fill with `initialContent`. Submit calls `chatApi.sendCardResponse(cardId, value)`.
- `confirm`: query text + buttons from `options`. Click sends the option's `value`.
- `choice`: query text + buttons from `options`. Click sends the option's `value`.

After response sent, the card component should disable itself (greyed out) to prevent double-submit.

**File**: `src/web/src/main.ts`

1. Add `CardMessage` to `ChatMessage` type union (or as a separate reactive list — simpler to add as a message type).
2. In `ws.onmessage`, handle `type: 'card'` — push to `state.messages` with a `card` field.
3. Add `chatApi.sendCardResponse(cardId, value)` — sends `{ type: 'card-response', cardId, value }` via guarded `wsSend`.

**File**: `src/web/src/types.ts`

Add:
```ts
export interface CardOption { label: string; value: string; }
export interface CardPayload {
  cardId: string;
  query: string;
  kind: 'input' | 'confirm' | 'choice';
  options?: CardOption[];
  initialContent?: string;
  placeholder?: string;
}
```

Extend `ChatMessage` with optional `card?: CardPayload` field. Add `'card'` to `MessageType`.

**File**: `src/web/src/components/ChatLog.vue`

Add `CardItem` rendering:
```html
<CardItem v-for="card in activeCards" :key="card.cardId" :card="card" />
```
Or render inline within the message list when `msg.type === 'card'`.

### Migration of existing ask() callers

The `WebInputProvider.promptRetry()` (web-input-provider.ts lines 53-68) currently broadcasts a plain `prompt: 'Retry? [Y/n]'`. This should be migrated to the card system — broadcast a `choice` card instead, so the frontend renders Yes/No buttons.

### Acceptance criteria

- `ask()` in serve mode renders an interactive card, not a chat-input prompt.
- `onEsc`, `onEnter` options are honored via card buttons.
- Card resolvers are cleaned up on serve stop (no dangling promises).
- `promptRetry` renders Yes/No buttons instead of requiring typed text.
- No behavioral divergence between terminal and web UI for any `ask()` call pattern.

---

## Phase 3 — Polish (lower priority, can batch later)

### 3.1 Print "Web UI stopped" on ESC exit

**Bug**: M4  
**File**: `src/loop/agent-io.ts` (lines 198-206)  
**Change**: After `hub.stop()`, call `console.log(chalk.yellow('\nWeb UI stopped. Terminal input restored.'))` to match `gracefulShutdown()` output.

### 3.2 Merge messageLog into /history alongside transcript

**Bug**: M1 — brief/log/warn/error output during WS disconnect is lost on reconnect.  
**File**: `src/serve/serve-hub.ts` — `readHistory()`  
**Change**: When `transcriptPath` is set, also include `messageLog` entries that are NOT already represented in the transcript (deduplicate by content+timestamp proximity). Alternatively, always include messageLog entries appended after transcript entries.

### 3.3 Fix transcript history timestamps

**Bug**: L1  
**File**: `src/serve/serve-hub.ts` — `readHistory()`  
**Change**: Parse timestamp from triologue JSONL if the `Message` object includes one. If not available, omit the `timestamp` field entirely rather than setting `0`.

### 3.4 Echo retry answer as user bubble

**Bug**: L2  
**File**: `src/web/src/main.ts` — `sendRetry()`  
**Change**: Add `state.messages.push({ type: 'user', content: answer, timestamp: Date.now() })`.

### 3.5 Use stable keys in v-for

**Bug**: L4  
**File**: `src/web/src/components/ChatLog.vue` (line 56)  
**Change**: Add a unique `id` field to `ChatMessage` (incrementing counter or `timestamp + type + random`). Use it as `:key` instead of array index.

---

## Explicitly Dropped / Not Bugs

- **H1, H2** (ask() returning '' vs null, ignored onEnter): Solved by Phase 2 interactive card design. Not patched individually.
- **M2** (submitInput drops input when no resolver): Mitigated by Phase 2 — card responses are matched by `cardId`, so the resolver always exists when a response arrives. For free-text input via `WebInputProvider`, the state machine should be in prompt state when input is expected; if not, the input is genuinely spurious.
- **N1** (WS not closed on beforeunload): Non-issue — server detects disconnect via `onclose`.
- **N2** (verbose toggle independence): By design — the toggle filters what's already sent, not backend verbosity.
- **N3** (linkify XSS): Safe in practice — `html: false` + `linkify` only matches http/https/email.

---

## Implementation Order

```
Phase 1.1 (guard ws.send)  ─┐
Phase 1.2 (reset UI state)  ├─ all independent, can be done in parallel
Phase 1.3 (startup failure) ─┘

Phase 2 (interactive cards) — depends on Phase 1 being merged
  2a. Backend: ServeHub card API + agent-io.ts ask() rewrite
  2b. Frontend: CardItem.vue + types + main.ts handler
  2c. Migration: promptRetry → choice card

Phase 3 (polish) — can be done anytime after Phase 1
  3.1–3.5 are all independent single-file changes
```

## Estimated Effort

| Phase | Items | Effort |
|-------|-------|--------|
| Phase 1 | 3 fixes | ~1 hour (small, independent) |
| Phase 2 | Card system | ~3-4 hours (new component + protocol + migration) |
| Phase 3 | 5 polish items | ~1 hour (single-file changes each) |
| **Total** | | **~5-6 hours** |