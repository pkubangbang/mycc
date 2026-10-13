# SteeringManager refactor — design plan

Status: approved (counterwork review converged 7/7 — OVERALL GO; amendments A1–A6 co-endorsed by both advocates).
Review record: team issue #1 (counterwork review: SteeringManager refactor plan), session crossroad records under
`.mycc/sessions/38077ec8-4d18-4525-bf21-bfdfab9fc90e/`.

## 1. Problem

WebUI steering (mid-task direction notes sent while the agent is working) is owned by `ServeHub` as an incidental
field (`steeringQueue` in `serve-hub.ts:76-77`). Four defects follow from that placement:

1. **停止-button race (root cause):** `ServeHub.stop()` wipes the queue (`serve-hub.ts:452`). A note sent in the
   stop window (user pressed 停止, loop transitions STOP → wrap-up → PROMPT) is silently destroyed; the frontend
   buffer keeps showing it but the backend can never deliver it ("second 停止 dead" vacuum).
2. **Latent T1 boundary defect:** the loop consumes steering via `getServeHub()` (side-effect-instantiating lazy
   singleton) from inside `src/loop/**` — collect.ts:233, prompt.ts:376+, team.ts:496, bg.ts:364/416. Loop reading
   serve-registry for steering is the wrong dependency direction and instantiates a hub in non-serve runs.
3. **`/history` payload type mismatch (C6):** hub serializes `steeringBuffer` as `string[]`
   (`getSteeringNotes(): string[]`) while the frontend types it `SteeringNote[] {id,text}` (main.ts:258, types.ts:83)
   — ids are lost on reconnect.
4. **Frontend phase flip (C5):** the wrap-up letterbox path broadcasts `'result'` while the frontend phase is
   `prompt`; the dispatch default branch flips `prompt → working`, killing the send button and stranding the
   parked-prompt turn.

Structural vacuum: a parked PROMPT loop cannot poll for notes — `waitForInput` is a blocking IPC wait with no
executor between arm and the next inbound event. Notes arriving while parked are only reachable by being *pushed
through the wait itself*.

## 2. Architecture

**One loop-homed manager, hub sole writer, loop reads directly.**

- `src/loop/steering-manager.ts` — module-scope lazy singleton (pattern: `src/loop/auto-state.ts`). Pure state +
  policy; imports nothing from `serve/`; zero ports, no callback registration.
- **Ownership:** only `ServeHub` writes (`addNote`, `resolveBoomerang`, `clear`); loop states are readers
  (`peekNotes`/`peekTexts`/`drainNotes`/`isNonEmpty`). Serve → loop imports are allowed; loop → serve-registry for
  steering consumption is banned (A6).
- `src/serve/steering-queue.ts` is **deleted** (not shimmed) — helpers move verbatim into the manager
  (A4 duplicate-id contract preserved). Its unit test moves to `src/tests/loop/steering-manager.test.ts`
  with expectations unmodified.
- Wrap-up state extracted to `src/loop/wrap-up-state.ts` so the hub can *pull* `isWrapUpInFlight()`
  (serve → loop) without the cycle `serve-hub → esc-wrap-up → serve-registry → serve-hub` (A5).

## 3. Manager API

```ts
export interface SteeringNote { id: number; text: string }

getSteeringManager(): SteeringManager        // lazy singleton
addNote(text: string): SteeringNote          // hub-only; mints monotonic id (never resets)
resolveBoomerang(sendIds: number[]): { selected: SteeringNote[]; discarded: SteeringNote[] }
                                             // hub-only; filter-by-id semantics — NO dedupe of duplicate ids (A4)
peekNotes(): SteeringNote[]                  // {id,text}[] copy — /history payload + frontend type finally agree
peekTexts(): string[]                        // synthesis peek
drainNotes(): SteeringNote[]                 // atomic take-all
isNonEmpty(): boolean                       // wait-peek flag (team.ts, bg.ts)
takeForDelivery(isParked: boolean, wrapUpInFlight: boolean): SteeringNote[] | null
clear(): void                                // lifecycle wipe
```

### `takeForDelivery` decision matrix (pure booleans)

| isParked | wrapUpInFlight | queue    | result                              |
|----------|----------------|----------|-------------------------------------|
| –        | –              | empty    | `null` (nothing to deliver)          |
| false    | false          | non-empty| `null` (hold — loop busy; turn drains will collect) |
| false    | true           | non-empty| `null` (hold — wrap-up window; rollback hazard) |
| true     | false          | non-empty| notes (drain + deliver)              |
| true     | true           | non-empty| `null` (hold — deliver at wake seam) |

Hold-during-wrapup justification: submitting an input while the wrap-up promise is in flight risks
`evaluateWrapUp` → rollback, whose wrap-up-mark truncation would delete the just-appended query message — so the
wake seam is not redundant with the write-point seam.

## 4. Wrap-up state extraction (`src/loop/wrap-up-state.ts`)

Moves the W-state singleton from `esc-wrap-up.ts:38-45` (`promise, content, completedAt, shown, triologue`) plus
`getWrapUpState()` / `hasPendingWrapUp()` / `markWrapUpShown()` / `clearWrapUp()` and adds `isWrapUpInFlight()`
(= `promise !== null`). `esc-wrap-up.ts` keeps LLM orchestration and imports the state module. **A5 facet
separation:** the wrap-up state module holds no queue logic; the manager holds no wrap-up logic.

## 5. ServeHub rewrite (sole writer + facade, zero queue state)

- **`pushSteer` (write-point):** `addNote(text)` → `journalUserSubmission(text, 'steer')` → broadcast
  `steer-echo {content, steerId}` → `takeForDelivery(isInputBlocked(), isWrapUpInFlight())` — non-null →
  broadcast `steer-flush` + `submitInput(joinSteeringNotes(notes))`. WS `'steer'`/`'steer-resolve'` protocol and
  `HubHandler` stay byte-identical.
- **`resolveSteering`:** `resolveBoomerang(sendIds)`; the discarded-ids verbose log (`serve-hub.ts:593-601`) is
  preserved verbatim; atomic drain BEFORE submit; broadcast `steer-flush`; submit joined selected text.
  Duplicate ids select both notes (no dedupe, A4). This path stays live while notes are *held* during the
  wrap-up window (A1 seam test).
- **Arm-point:** when `waitForInput` arms (inputResolver set), re-run the same delivery check → immediate
  `steer-flush` + `submitInput` resolving the just-armed wait.
- **Wake (A1):** `esc-wrap-up.startWrapUp()` marks in-flight; the wrap-up promise settle path marks settled and
  calls `getServeHub().onWrapUpSettled()` (gated on `isRunning()`, direct call — no callback registration) →
  hub re-runs the arm-point check, handing wrap-up-window notes to the just-armed PROMPT wait.
- **Lifecycle (A2):** `stop()` no longer wipes notes. `manager.clear()` runs only on *terminal* teardown —
  `stop()` outside `restartServe` (graceful shutdown) and the WebInputProvider terminal-fallback branch.
  `restartServe()` preserves notes exactly as it preserves the input-resolver.
- **`/history`:** ETag still folds queue length; payload `steeringBuffer` becomes `peekNotes()` → `{id,text}[]`
  (fix located in hub serialization; frontend typing unchanged).

## 6. Loop consumption (4 files / 5 call sites — 4 pre-existing surfaces re-pointed, no new semantics)

| Group | Touch point | New? | Mechanism |
|---|---|---|---|
| A. Turn-internal drains | collect.ts step-2c drain | no — re-point (`drainNotes()`, `isRunning()` guard dropped — empty manager is a natural no-op since only the hub writes) | transcript `[REMINDER]` injection |
| | prompt.ts synthesis peek+drain | no — re-point (hub kept only for file uploads) | fresh-query text |
| B. Park-time delivery | hub delivery routine at 3 instants: write-point, arm-point, wake | **YES — the plan's only real addition** | `takeForDelivery(isParked, wrapUpInFlight)` → steer-flush + `submitInput` |
| C. Wait-peeks | team.ts awaitTeammates peek → `isNonEmpty()` | no — re-point | 1s poll flag (flag only — must NOT submit an input) |
| | bg.ts peek | no — re-point | 1s poll flag |

Why not one merged consumer: consumption semantics genuinely differ per loop state (transcript injection vs query
text vs flag-only wake vs full IPC submit), and a parked PROMPT loop cannot be reached by polling at all — a
merged consumer would re-derive loop state, i.e. a state machine smuggled into the manager. The three instants of
B cannot collapse to fewer: they are the same check re-run after whichever of `{note-arrival, park-arm,
wrap-up-settle}` lands last. `steer-flush` stays broadcast at the two loop drain sites (both already import
`getServeHub()` for other duties).

## 7. Frontend (A3)

- `message-dispatch` default branch: `'result'` while `phase !== 'working'` and manual mode → **no phase flip**
  (kills the wrap-up-letterbox flip trace: result-at-idle/prompt arriving after the prompt broadcast). Flip
  behavior preserved under auto mode and at `working`/`submitted`.
- `/history` `steeringBuffer` arrives as `{id,text}[]` — reconnect restores ids, so per-note resolve keeps
  targeting notes minted before the disconnect.
- Late-arrival ordering test pins the result-vs-prompt ordering.

## 8. Binding gates (A1–A6 from the counterwork review)

| Gate | Binding statement |
|---|---|
| **A1** | Wrap-up wake seam: startWrapUp marks in-flight; promise settle marks settled; `onWrapUpSettled` re-runs the arm-point check → steer-flush + submitInput; steer-resolve stays live during holds (seam test). |
| **A2** | Restart preservation: notes survive `restartServe()`; `manager.clear()` only on terminal `stop()`/input fallback (root cause of the 停止 race was `stop()` wiping the queue at serve-hub.ts:452). |
| **A3** | `/history` payload `{id,text}[]` + `result` no-flip guard for manual mode + late-arrival ordering test. |
| **A4** | Duplicate-id contract kept verbatim: no dedupe — all notes sharing a sent id are selected; single-note targeting by id (not text); implicit discard of unselected; boomerang preserved via `resolveBoomerang`. |
| **A5** | Facet separation: `wrap-up-state.ts` holds no queue logic; manager holds no wrap-up logic; hub pulls `isWrapUpInFlight()`. |
| **A6** | Import boundary: no `src/loop/**` steering consumer imports `serve-registry` (guard test, with explicit allowlist for non-steering lifecycle wiring: agent-repl.ts, serve-wiring.ts, signal-handlers.ts, esc-wrap-up.ts wake/display gate). Steering reads/drains in loop code must go through the manager, not hub steering methods. |

## 9. Pitfall deltas (Δ1–Δ3)

- **Δ1** — after each rollout step, grep/re-read the exact lines the step claims to touch before running the
  suite; green tests do not prove an edit landed.
- **Δ2** — the E2E respawn must run with `--skip-healthcheck`.
- **Δ3** — singleton pitfall: `getServeHub()` side-effect-instantiates; removing it from steering paths is
  justified because consumption sites need a pure read, and the manager is the always-there base component.

## 10. Rollout order + verification

1. this doc → 2. manager + moved tests (+ takeForDelivery matrix) → 3. wrap-up-state extraction →
4. hub re-point + delete `src/serve/steering-queue.ts` same change-set → 5. seams (write/arm/wake) →
6. loop consumers + frontend + /history → 7. A6 guard + A2 unit tests → 8. tsc + full suite green →
9. tmux E2E (mycc-online-hotfix rules; respawn with `--skip-healthcheck`; 停止 → note delivered at parked prompt
   as a new turn without second submit; note survives `restartServe()`; held note discardable during the wrap-up
   window; stage row shows PROMPT, not vacuum-working) → 10. commit.

L1s run against the singleton directly (reset via `clear()`, `takeForDelivery` with plain booleans — zero
registration stubs). Hub seam tests use the REAL manager singleton (no manager mocks). New:
`src/tests/loop/await-steering-reentry.test.ts` (A1 seam), `src/tests/loop/bg-await-steering.test.ts`,
`src/tests/web/message-dispatch-result.test.ts` (A3). Moved: `src/tests/serve/steering-queue.test.ts` →
`src/tests/loop/steering-manager.test.ts` (imports re-pointed, expectations unmodified).

## 11. Non-goals

- No change to the WS steer protocol, `HubHandler` shape, journal 'steer' record, or steer-echo payload.
- No callback registration API (user directive); the wake rides a direct gated hub call.
- File-upload queuing stays hub-owned.
- stop.ts bounded-await reconciliation and centralized neglection wrap-up in STOP are untouched (pitfall
  constraints #1/#2).