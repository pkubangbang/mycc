# WebUI Phase FSM + Steering Race Fix — Design Document

> **Status:** Revised — both peer reviews incorporated (DeepSeek `26eec3c3` + glm-5.3-flash `51b87cc7`)
> **Date:** 2026-09-07
> **Author:** Lead agent (session `cc9de7e7`)
> **Related:** `docs/compact-working-memory.md`, pitfall wiki (hashes `3ce8cc9a`, `861a9673`, `8ed42cfa`)

---

## 1. Problem Statement

### 1.1 The Clear-Before-Review Race

When the user presses ESC (or clicks 停止) during a hint round with steering
notes buffered, the notes are silently lost — neither consumed by the agent
nor surfaced as review cards.

**Root cause:** `stop.ts` (inside the neglection block) calls `getServeHub().drainSteering()` which:
1. Clears the backend `steeringQueue`
2. Broadcasts `steer-flush` → frontend clears `steeringBuffer`

Then `stop.ts` returns `PROMPT` → `web-input-provider.ts:43` broadcasts
`prompt` → frontend `message-dispatch.ts:81-86` checks `steeringBuffer` →
**already empty** (cleared by the preceding `steer-flush`) → no review card
surfaced.

The `drainSteering()` return value (the note texts) is **ignored** in
`stop.ts` — the notes are discarded, not consumed.

### 1.2 The Loose-Flag Problem

The frontend manages interaction state via 4 independent boolean flags:

| Flag | Meaning |
|------|---------|
| `isWaiting` | PROMPT pending user input (also true during card — see §2.2) |
| `isRunning` | Agent actively processing |
| `isAutoMode` | Auto mode (AWAIT instead of PROMPT) |
| `hasPendingCard` | Interactive card pending response |

4 booleans = **16 possible combinations**, but only **6 are valid**:

| Valid combination | Phase |
|-------------------|-------|
| F, F, F, F | `idle` (transient vacuum) |
| F, F, F, F + justSubmitted | `submitted` (send→running gap) |
| F, T, *, F | `working` |
| T, F, F, F | `prompt` |
| T, F, F, T | `card` (isWaiting=true AND hasPendingCard=true today) |
| F, F, T, F | `await` |

The remaining 10 combinations are **invalid but reachable** due to race
conditions between server messages. `ChatInput.vue:424-427` already has a
hand-rolled priority cascade to *infer* the current phase from these flags,
proving the implicit state machine exists but is not enforced.

> **Peer finding (glm-5.3-flash `51b87cc7`):** The current `card` handler
> sets `isWaiting=true` AND `hasPendingCard=true` simultaneously. The
> `isWaiting` getter must therefore be `phase === 'prompt' || phase === 'card'`
> to preserve this semantics. All `isWaiting` consumers (especially
> `showSteeringReview` in ChatInput.vue) must be audited.

---

## 2. Solution: Phase as Source of Truth (Pinia Store)

### 2.1 Design Principle

Replace the 4 loose flags with a single `phase` enum stored in a Pinia
store. Most flags become **derived computed getters** — they can never reach
an invalid combination because they are projections of a single enum value.

```
phase (source of truth) → isRunning, hasPendingCard, hasReview (derived)
phase + isAutoMode (orthogonal boolean) → isWaiting (derived)
```

> **Peer finding (glm-5.3-flash):** `isAutoMode` must stay as an orthogonal
> boolean, NOT derived from `phase === 'await'`. Rationale: `working`-in-auto
> and `working`-in-manual are the same UI phase, but the diagnostic chip row
> needs to show the auto flag while running. Deriving auto from `phase==='await'`
> would lose the auto chip during `working` and complicate the `auto:on while
> working` transition. `await` is the phase entered on `auto:on` when NOT
> working; `auto:on` while `working` just flips the boolean.

### 2.2 The 6 Phases

> **Peer finding (glm-5.3-flash):** 5 phases is one short. The
> `submitted` phase covers the send→running gap (backend is inside PROMPT
> doing keyword extraction / steering synthesis — LLM calls before
> `running:on`). Folding it into `working` is defensible only if a
> `justSubmittedAt` timestamp is kept for the diagnostic stage row; a real
> phase is preferred since it's the only one with a time-based exit.

```typescript
type WebuiPhase = 'idle' | 'submitted' | 'working' | 'prompt' | 'card' | 'await';
```

| Phase | Meaning | Server signal(s) | Input box state |
|-------|---------|-------------------|-----------------|
| `idle` | Transient vacuum between `running:off` and next signal | (gap) | Enabled (routes to steer) |
| `submitted` | Send→running gap; backend doing post-input LLM work | (client-side optimistic) | Enabled (routes to steer) |
| `working` | Agent actively processing (confirmed by `running:on`) | `running:on` | Enabled (routes to steer) |
| `prompt` | Waiting for user input | `prompt` + `running:off` | Enabled (routes to input) |
| `card` | Interactive card pending response | `card` | Disabled (reply on card) |
| `await` | Auto mode, idle, waiting for events | `auto:on` (no running) | Enabled (routes to steer) |

> **Peer finding (DeepSeek):** `idle` must be kept as a distinct phase. It is
> genuinely reachable: after `running:off` (working→idle) there is a real
> window before the next `prompt`/`card`/`auto:on` arrives. Making it
> "impossible" would force a synthetic transition. The right framing is that
> `idle` is **transient** — the no-deadlock invariant enforces it must be
> resolved by the next event.

### 2.3 Orthogonal Data (Not Part of Phase)

These can co-occur with any phase and are stored independently:

- `isAutoMode: boolean` — **orthogonal boolean** (not derived from phase).
  `working`-in-auto and `working`-in-manual are the same phase; the auto
  flag is independent. `await` is the idle-auto phase; `auto:on` while
  `working` flips the boolean without changing phase.
- `steeringBuffer: SteeringNote[]` — buffered notes (chips in buffer bar)
- `pendingSteeringReview: SteeringNote[]` — review card notes (co-occurs with `prompt` only)
- `messages`, `teammateMessages` — chat history
- `inputText`, `pendingFiles` — input state
- `connectionStatus`, `showRetry`, `verboseLogs`, `darkMode`, `debugMode`
- `lastServerMsg` — diagnostic (written for EVERY wire type before branching)

### 2.4 Derived Getters

```typescript
const isWaiting      = computed(() => phase.value === 'prompt' || phase.value === 'card');
const isRunning      = computed(() => phase.value === 'working' || phase.value === 'submitted');
const hasPendingCard = computed(() => phase.value === 'card');
const hasReview      = computed(() => pendingSteeringReview.value.length > 0);
// isAutoMode is NOT derived — it is an orthogonal ref (see §2.3)
```

> **Peer finding (glm-5.3-flash):** `isWaiting` must be
> `phase === 'prompt' || phase === 'card'` because the current `card` handler
> sets `isWaiting=true` AND `hasPendingCard=true`. All `isWaiting` consumers
> must be audited — especially `showSteeringReview` in ChatInput.vue which
> gates on `isWaiting`.

> **Peer finding (DeepSeek):** `isRunning` should be
> `phase === 'working' || phase === 'submitted'` so the send→running gap
> still reads as "running" to consumers that check `isRunning` for the
> spinner/animation.

### 2.5 Phase Transition Table

Driven by server messages in `applyServerMessage` and client-side optimistic
transitions in `chatApi`. Both call store actions — the store is the single
mutation surface (see §2.7).

> **Peer finding (DeepSeek):** There is NO `esc` message type in the wire
> protocol. The frontend's interrupt button sends `{ type: 'interrupt' }`,
> and the server handles it via `agentIO.triggerNeglection()` — it does NOT
> broadcast an `esc` message back. The ESC path is fully covered by the
> server's subsequent broadcasts (`running:off`, `auto:off`, `prompt`). The
> `esc` column has been REMOVED from the transition table.

> **Peer finding (glm-5.3-flash):** `running:off` must be a **NO-OP unless
> `phase === 'working'`**. On reconnect, `serve-hub.ts:522` sends `prompt`
> BEFORE `running:off` (~line 526). If `running:off` unconditionally mapped
> to `idle`, it would break `isWaiting` on every reconnect by overwriting a
> valid `prompt` phase. Normal turn end also sends `running:off` before
> `prompt`, so the `idle` transient is expected — but the NO-OP guard
> prevents reconnect reordering from clobbering a stable phase.

```
                + running:on    + running:off       + prompt        + card     + auto:on       + auto:off    + card-response
idle            → working        (no-op)             → prompt        → card      → await         (no-op)       (n/a)
submitted       → working        (no-op)             → prompt        → card      → await         (no-op)       (n/a)
working         (no-op)          → idle               → prompt        → card      (stay, flip auto) (no-op)    (n/a)
prompt          → working        (no-op)             (stay prompt)   → card      → await         (no-op)       (n/a)
card            → working        (no-op)             → prompt        (n/a)      (n/a)           (no-op)       → working
await           → working        (no-op)             → prompt        → card      (stay await)    → idle        (n/a)
```

**Key rules:**
- `running:off` is a NO-OP unless `phase === 'working'` (→ `idle`) or
  `phase === 'submitted'` (→ `idle`). This prevents reconnect reordering
  from clobbering a stable `prompt`/`card`/`await` phase.
- `auto:off` is a NO-OP unless `phase === 'await'` (→ `idle`, then corrected
  by imminent `prompt`). Do NOT clear `pendingSteeringReview` on `auto:off`
  (only `auto:on` abandons review).
- `card-response → working` always (optimistic, matching `sendInput`).

> **Peer finding (DeepSeek):** `card` can also be cleared by disconnect
> (`ws.onclose` resets `hasPendingCard` in `main.ts`). The transition table
> handles wire messages; the disconnect-clear path is handled separately in
> the `onclose` handler (sets phase to `idle`, clears `hasPendingCard`).

**Steering-specific transitions** (orthogonal, do not change phase):

| Event | Condition | Effect |
|-------|-----------|--------|
| `steer-echo` | any phase | Push note to `steeringBuffer` |
| `steer-flush` | any phase | Clear `steeringBuffer` |
| `prompt` | `steeringBuffer.length > 0` + non-auto | Move to `pendingSteeringReview`, clear buffer |
| `prompt` | `steeringBuffer.length > 0` + auto | Clear buffer (abandon) |
| `auto:on` | any | Clear `pendingSteeringReview`, set `isAutoMode=true` |
| `steer-resolve` | any | Clear `pendingSteeringReview` + `steeringBuffer` (optimistic) |

**Client-side optimistic transitions** (in `chatApi`, via store actions):

| Action | Effect |
|--------|--------|
| `sendInput(text)` | `phase → submitted` (optimistic, before `running:on` arrives) |
| `sendCardResponse` | `phase → working` (optimistic — agent resumes TOOL→LLM) |
| `sendExit` / `sendInterrupt` | No phase change (server drives via subsequent broadcasts) |
| `sendAuto()` | No optimistic phase change (server confirms via `auto:on`) |

> **Peer finding (DeepSeek):** The `justSubmitted` latch (ChatInput.vue) is
> NOT fully replaceable by `phase === 'working'`. The `submitted` phase
> covers the send→running gap where the backend is inside PROMPT doing
> post-input LLM work (keyword extraction / steering synthesis) before
> broadcasting `running:on`. The 15s expiry timer remains as a safety net:
> if the backend is genuinely desynced, `submitted` must eventually expire
> back to `idle` so the vacuum diagnostic surfaces. The `submitted` phase
> makes this explicit instead of hiding it in a side-flag.

### 2.6 Pinia Store Structure

```typescript
// src/web/src/stores/chat-store.ts
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { ChatMessage, SteeringNote, FileInfo, ConnectionStatus } from '../types';

export type WebuiPhase = 'idle' | 'submitted' | 'working' | 'prompt' | 'card' | 'await';

export const useChatStore = defineStore('chat', () => {
  // ── Source of truth ──
  const phase = ref<WebuiPhase>('idle');

  // ── Orthogonal boolean (NOT derived from phase) ──
  const isAutoMode = ref(false);

  // ── Orthogonal data ──
  const steeringBuffer = ref<SteeringNote[]>([]);
  const pendingSteeringReview = ref<SteeringNote[]>([]);
  const messages = ref<ChatMessage[]>([]);
  const teammateMessages = ref<ChatMessage[]>([]);
  const inputText = ref('');
  const pendingFiles = ref<FileInfo[]>([]);
  const connectionStatus = ref<ConnectionStatus>('disconnected');
  const showRetry = ref(false);
  const verboseLogs = ref(false);
  const darkMode = ref(localStorage.getItem('mycc-theme') === 'dark');
  const debugMode = ref(false);
  const lastServerMsg = ref<{ type: string; at: number } | undefined>(undefined);

  // ── Derived flags ──
  const isWaiting      = computed(() => phase.value === 'prompt' || phase.value === 'card');
  const isRunning      = computed(() => phase.value === 'working' || phase.value === 'submitted');
  const hasPendingCard = computed(() => phase.value === 'card');
  const hasReview      = computed(() => pendingSteeringReview.value.length > 0);

  // ── Store actions (single mutation surface — see §2.7) ──
  function setPhase(newPhase: WebuiPhase): void {
    phase.value = newPhase;
  }
  function setAutoMode(value: boolean): void {
    isAutoMode.value = value;
    if (value) pendingSteeringReview.value.splice(0);
  }

  return {
    phase, isAutoMode, steeringBuffer, pendingSteeringReview, messages,
    teammateMessages, inputText, pendingFiles, connectionStatus, showRetry,
    verboseLogs, darkMode, debugMode, lastServerMsg,
    isWaiting, isRunning, hasPendingCard, hasReview,
    setPhase, setAutoMode,
  };
});
```

### 2.7 Mutation Surface — Single Store, Two Callers

> **Peer finding (DeepSeek):** The design says "applyServerMessage is the
> only mutation point for phase" but then lists client-side optimistic
> transitions in `chatApi`. That's a contradiction — `chatApi.sendInput`
> mutating phase means there are TWO mutation points. Resolution: expose
> `setPhase` / `setAutoMode` as store actions. Both `applyServerMessage`
> (server-driven) and `chatApi` (client-initiated) call these store actions.
> The store is the single mutation surface; there are two callers but one
> mutation API.

> **Peer finding (glm-5.3-flash):** Keep `applyServerMessage(state, msg, ctx)`
> as the DOM-free pure transition brain and unit-test seam. The Pinia store
> holds the reactive state and passes it in. Do NOT move transitions into
> store action closures — that would break the node-environment Vitest suite
> (`src/tests/web/message-dispatch.test.ts`) and the debug seam
> (`window.__myccDebug.inject`) which share the same path.

---

## 3. The Steering Race Fix

### 3.1 Change

Remove the `drainSteering()` call AND its justification comment from
`stop.ts`. The drain call is inside the neglection block (verify exact line
range when implementing — the comment block above it documents the
now-removed behavior and should also go).

> **Peer finding (DeepSeek):** In the current `stop.ts`, the
> `drainSteering` try/catch is at approximately lines 62-70 inside the
> neglection block, with a comment block above it (approximately lines
> 55-61). Both the call and the comment should be removed — the comment is
> the only remaining justification for the bug.

> **Peer finding (glm-5.3-flash):** The bug bites only for notes queued
> AFTER the last COLLECT drain (COLLECT step 2c runs before the hint round,
> so notes queued before it were already consumed as REMINDER). The
> realistic window is the final LLM call / hint generation / TOOL execution
> — exactly the long stretches where users steer.

### 3.2 Why It Works

After the fix, when ESC fires during a hint round with notes buffered:

1. `stop.ts` turns auto OFF (line 78-82) and returns `PROMPT`
2. `stop.ts` does NOT call `drainSteering()` → notes stay in backend queue + frontend buffer
3. `web-input-provider.ts:43` broadcasts `prompt`
4. Frontend `message-dispatch.ts:81-86` finds `steeringBuffer` non-empty → moves notes to `pendingSteeringReview` → review card surfaces
5. User can send/discard via the card, or type a fresh query (triggers `prompt.ts:~380` `synthesizeWithSteering` since `hub.getSteeringNotes()` is still non-empty)

The existing code at `message-dispatch.ts:81-86` and `prompt.ts:~380` already
handles "notes still in queue at PROMPT time" correctly. The bug was that
`stop.ts` drained them *before* PROMPT could see them.

### 3.3 Tight-Loop Safety

The pitfall from `await-steering-reentry.test.ts` documents a tight-loop
scenario where notes linger and AWAIT re-wakes on them. After this fix:

- `stop.ts` turns auto OFF on ESC → the loop goes to `PROMPT`, not `AWAIT`
- Auto re-engagement requires `streak >= threshold` (default 3) LLM stages in
  a turn — impossible at PROMPT (streak was just reset to 0)
- If the user explicitly clicks auto with notes in queue: AWAIT re-wakes →
  COLLECT drains the note (one cycle) → queue empty → AWAIT blocks. **One
  cycle, not a tight loop.**

### 3.4 DeepSeek Peer Confirmation

Peer `26eec3c3` (DeepSeek) independently traced `stop.ts` and confirmed:
> stop.ts calls setAuto(false) → onAutoChange → broadcasts 'auto off' BEFORE
> returning PROMPT, so by the time the frontend receives the prompt broadcast,
> auto mode is already off — the review card path (non-auto) will fire
> correctly.

---

## 4. Chaos-Monkey Test Harness

### 4.1 Purpose

Prove that the webui never blocks (no deadlock, no lost steering notes) across
all event permutations. Pure-data tests in Vitest — no DOM, no
`@vue/test-utils`, no Playwright.

### 4.2 The 4 Invariants

**Invariant 1 — No-deadlock:**
After any finite event sequence, the store reaches a state where the input box
is enabled (`phase === 'prompt'` OR `phase === 'await'` OR `phase === 'card'`
OR `phase === 'submitted'`). The `idle` phase may appear transiently but must
never persist — the next event must resolve it.

> **Peer finding (DeepSeek):** Gate this invariant on
> `connectionStatus === 'connected'`. When disconnected, the input box
> cannot send anyway, so asserting no-deadlock while disconnected would
> produce false failures.

**Invariant 2 — No-lost-notes:**
Every `steer-echo` note is eventually:
- Consumed by the agent (`steer-flush` — drained at COLLECT/PROMPT), OR
- Surfaced as a review card (`pendingSteeringReview` populated at `prompt`), OR
- Explicitly discarded by the user (`steer-resolve` with partial/empty `sendIds`), OR
- Abandoned by auto-mode entry (acceptable loss)

No note vanishes silently.

**Invariant 3 — Dual-buffer sync (with auto-abandon exception):**
After every event, `backend.steeringQueue.length === frontend.steeringBuffer.length`,
**EXCEPT** during the auto-abandon window: when `prompt` arrives in auto
mode, the frontend clears `steeringBuffer` (abandon) but the backend queue
still holds the notes until COLLECT drains them. So the invariant is:

> `backend.length >= frontend.length`, and they converge after the next
> `steer-flush` (COLLECT drain) or `steer-resolve`.

> **Peer finding (DeepSeek):** Without this exception, the harness would
> produce false failures in the auto-abandon case.

**Invariant 4 — Review-card-only-in-prompt:**
`pendingSteeringReview.length > 0` implies `phase === 'prompt'`. The review
card is PROMPT-gated (`message-dispatch.ts:81-86` only populates it on
`prompt`). Asserting this catches regressions where a card surfaces in
`working`/`await`/`card` — a real bug.

> **Peer finding (DeepSeek):** Do NOT add a phase-monotonicity invariant.
> Phases legitimately go backward (`working→prompt→working` on retry,
> `await→prompt→await` on auto toggle). Monotonicity would be wrong.

### 4.3 Harness Design

```
src/tests/web/chaos-monkey.test.ts

Setup:
  - setActivePinia(createPinia()) in beforeEach
  - backend model: { steeringQueue: SteeringNote[], idCounter: number }
  - applyEvent(event): mutates both backend model and Pinia store in lockstep

Event types (11):
  - steer-echo, steer-flush, prompt, running:on, running:off,
    auto:on, auto:off, card, card-response, steer-resolve, disconnect/reconnect

Test suites:
  1. Exhaustive 2-event permutations (11 events × 11 = 121 sequences)
  2. Focused race sequences (from both peer reviews, priority order):
     P1. [steer-echo, interrupt→running:off+auto:off+prompt]
         — clear-before-review race (Section 3 fix regression)
     P2. [running:off, prompt] vs [prompt, running:off]
         — reconnect reordering: assert phase stays 'prompt' in both orders
     P3. [steer-echo, auto:on, prompt]
         — auto abandons review; AWAIT wakes → COLLECT drains → settles
         — assert no unbounded cycling, buffer/review eventually empty
     P4. [steer-echo, prompt (idle PROMPT with queued notes, abortInput→null)]
         — COLLECT drains as REMINDER (in-flight semantics)
         — assert steer-flush AFTER prompt does NOT clear review card
     P5. [steer-echo, disconnect, reconnect]
         — history restores buffer from getSteeringNotes peek
         — re-sent prompt → card re-populated
         — stale-resurface: resolveSteering on empty queue = silent no-op
     P6. [prompt, prompt] (double prompt from reconnect re-send)
         — first moves buffer→review; second sees empty buffer → no dup card
     P7. [card, steer-echo, card-response]
         — card with concurrent steering; card-response → working
     P8. [steer-echo, running:on, running:off, prompt]
         — full work cycle with notes buffered
  3. Random walks: 20 random events, 1000 iterations, assert after each step

Assertions (after each event in every sequence):
  - assertNoDeadlock(store)          — phase must not be 'idle' at sequence end
                                       (gated on connectionStatus === 'connected')
  - assertNoLostNotes(backend, store) — note accounting
  - assertDualBufferSync(backend, store) — backend.length >= frontend.length,
                                            converge after flush/resolve
  - assertReviewOnlyInPrompt(store)   — pendingSteeringReview.length > 0
                                         implies phase === 'prompt'
```

> **Peer finding (glm-5.3-flash):** Keep the `lastServerMsg` diagnostic hook
> and the vacuum stage ('空窗·疑似失同步') in the migrated store.
> `phase === 'idle' && !auto && connected && stale-lastServerMsg` is what
> makes desync visible. A naive phase enum makes `idle` look legitimate and
> silently destroys this diagnostic. The harness should NOT assert against
> the diagnostic — it should assert the phase invariants, and the diagnostic
> is a separate observability layer.

---

## 5. Files Changed

### Section 3 — Steering Race Fix

| File | Change |
|------|--------|
| `src/loop/states/stop.ts` | Delete the `drainSteering()` try/catch block AND its justification comment inside the neglection block (verify exact lines during implementation — approx 55-70) |
| `src/tests/loop/states/stop-steering-surface.test.ts` | NEW: ESC + notes → review card regression |

### Section 2 — Pinia Phase Store

| File | Change |
|------|--------|
| `package.json` | Add `pinia` dependency (`^2.2.0`) |
| `src/web/src/stores/chat-store.ts` | NEW: Pinia store, 6-phase enum as source of truth, `isAutoMode` as orthogonal boolean, derived getters (`isWaiting` includes `card`), store actions (`setPhase`, `setAutoMode`) as single mutation surface |
| `src/web/src/types.ts` | Remove loose flags from `ChatState`, add `phase: WebuiPhase`, keep `isAutoMode` as orthogonal field |
| `src/web/src/message-dispatch.ts` | Rewrite to call `store.setPhase()` / `store.setAutoMode()` with transition table; `running:off` is NO-OP unless `phase==='working'` or `'submitted'`; keep as pure DOM-free function |
| `src/web/src/main.ts` | Replace `reactive()` with `createPinia()` + `useChatStore()`; `chatApi` optimistic transitions call `store.setPhase('submitted'/'working')`; keep `applyServerMessage(store, msg, ctx)` as the dispatch path |
| `src/web/src/components/ChatInput.vue` | Use store getters; replace stage cascade with `store.phase`; keep `justSubmitted` latch as `submitted` phase with 15s expiry; audit all `isWaiting` consumers |
| `src/web/src/components/ChatLog.vue` | Use store getters |
| `src/web/src/components/SteeringReviewCard.vue` | Parent passes `store.pendingSteeringReview` |
| `src/web/src/components/DebugPanel.vue` | Use store getters |
| `src/web/src/debug.ts` | Update debug seam to inject into store |

### Section 4 — Chaos-Monkey Harness

| File | Change |
|------|--------|
| `src/tests/web/chaos-monkey.test.ts` | NEW: event permutation harness |
| `src/tests/web/chat-store.test.ts` | NEW: Pinia store unit tests |
| `src/tests/web/message-dispatch.test.ts` | UPDATE: adapt to store-based signature + race regression |

---

## 6. Execution Order

```
Section 3 (fix stop.ts)
  → Section 2 (Pinia store refactor)
    → Section 4 (chaos-monkey harness)
```

The fix must land first so the harness can verify it. The Pinia store must
land before the harness imports it.

---

## 7. Peer Review Status

| Peer | Model | Status | Key Findings |
|------|-------|--------|--------------|
| `26eec3c3` | DeepSeek | ✅ Approved with 3 changes + 2 harness additions | (a) Remove phantom `esc` column — no esc wire message exists; (b) `card-response → working` always; (c) Resolve two-mutation-point contradiction via store actions; (d) Add 4th invariant (review-card-only-in-prompt); (e) Fix Invariant 3 for auto-abandon window; (f) Keep `justSubmitted` latch semantics; (g) Gate no-deadlock on `connectionStatus === 'connected'`; (h) Verify exact line range in stop.ts |
| `51b87cc7` | glm-5.3-flash | ✅ Approved with 4 findings | (a) 6 phases not 5 — add `submitted` for send→running gap; (b) Keep `isAutoMode` as orthogonal boolean, not derived from `phase==='await'`; (c) `isWaiting` getter must be `phase==='prompt' \|\| phase==='card'`; (d) `running:off` must be NO-OP unless `phase==='working'` (reconnect ordering); (e) Keep `applyServerMessage` as pure function; (f) 8 concrete chaos targets; (g) Keep `lastServerMsg` diagnostic and vacuum stage |

---

## 8. Pitfall Wiki Constraints Applied

Three relevant pitfalls were checked before finalizing this plan:

1. **Neglection wrap-up must be centralized in STOP** (hash `3ce8cc9a`):
   The fix removes a call from STOP, not adds one. STOP remains the single
   choke point for neglection wrap-up. ✅ No violation.

2. **WebUI 空窗 two-cause** (hash `861a9673`):
   The `idle` phase explicitly represents the "真空窗" (vacuum window).
   The chaos-monkey harness tests that `idle` never persists. The
   "良性间隙" (benign gap) is the send→running optimistic transition
   (`prompt → working` on `sendInput`). ✅ Addressed.

3. **Expose state before debugging** (hash `8ed42cfa`):
   The phase enum itself IS the state exposure — it makes the implicit
   state machine explicit and observable. The diagnostic chip row in
   ChatInput.vue now shows `phase` directly instead of inferring from
   flags. ✅ Addressed.