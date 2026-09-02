# Plan: Event-driven teammate-wait (heartbeat-pumped polling replaces one-shot await)

- **Status**: planned, awaiting implementation
- **Date**: 2026-09-02
- **Scope**: `src/loop/states/stop.ts` (primary), tests (secondary)
- **Direction**: dir-1 (agent-loop-state-machine) — reopened after "fully retired"

## Background — two reproductions, same root cause

### Reproduction 1 (deadline-passed, WebUI snapshot)

A peer at `C:\Proj\bydos-func` hung. The WebUI showed:
- `isWaiting=false`, `isRunning=false` (orchestrator idle)
- "awaiting teammate(s)" banner + "怀疑失同步" sync-warning chip
- An amber scratchpad message: "Deadline 15:01:37 passed. Use tm_await to wait longer, tm_remove to terminate."
- The loop did NOT self-resume; the operator had to toggle auto mode (bliz icon) to pump it.

**Trace:** `awaitTeammate`'s poll loop resolved via the deadline-passed path
(team.ts:495-499 — `resolve(); return;` WITHOUT changing the teammate's status).
The teammate stayed 'working'. `awaitTeam` then checked the final state — only
looked for 'holding', not 'working' — returned 'all done'. STOP routed to PROMPT.
`waitForInput()` blocked. The loop parked.

**Why the UI showed "等待回复中…" (not "agent >>"):** The state machine DID reach
PROMPT (`isRunning` went false on the PROMPT transition). A `'prompt'` broadcast
set `isWaiting=true` briefly, but a teammate message arrived moments later
(scratchpad was still working) and hit the default case in `message-dispatch.ts`
(`state.isWaiting = false`), resetting it. The "vacuum state"
(`isWaiting=false`, `isRunning=false`) was a secondary desync symptom of the
primary bug.

**Why auto mode unblocked it:** `enterAutoProvider` (serve-wiring.ts) calls
`getServeHub().rejectInput()`, which rejects the blocked `waitForInput()` Promise
with `PromptAbortError`. PROMPT's Layer B catch returns AWAIT → COLLECT → LLM.
The toggle broke the PROMPT wait, not the awaitTeam wait.

### Reproduction 2 (missed idle transition, terminal snapshot)

The teammate went idle (IPC `status: idle` sent), but the lead was still waiting.
Terminal showed both teammates idle, no `agent >>` prompt at the bottom.

**Trace:** The teammate sent its idle IPC *before* `awaitTeammate` was called
(the IPC handler `handleChildMessage` runs on the Node event loop between STOP's
`presentResult()` and the `await ctx.team.awaitTeam()` call). By the time
`awaitTeammate` reads `this.statuses.get(name)`, the status was already 'idle'.
`awaitTeammate` took the **phase-1 path** (subscribe for *start-working*
transition), but the teammate never started working again — it's idle and
waiting for mail. The phase-1 subscriber never resolves. Eventually the
timeout poll resolves (1s tick), `awaitTeammate` returns, `Promise.all` completes,
`awaitTeam` reads the final state — teammates are idle, `finalHolding` is false,
returns 'all done' → PROMPT → park.

### Root cause convergence

Both reproductions converge on the same conclusion: `awaitTeam`'s one-shot
architecture (snapshot → subscribe → resolve → route based on a single return
value) is fundamentally fragile. It can:
1. Miss transitions (snapshot-vs-event mismatch — reproduction 2)
2. Misreport 'all done' (deadline-passed resolve while teammate still working — reproduction 1)
3. Park the lead at PROMPT indefinitely (no self-resume mechanism)

## The deeper insight (event-driven redesign)

The teammate worker already emits a rich event stream:

| Event source | What it emits | Where (teammate-worker.ts) |
|---|---|---|
| **Status transitions** | `working`/`idle`/`holding`/`shutdown` via IPC `status` messages | `sendStatus('working')` (line 278), `enterIdleState` (line 632) |
| **Heartbeat** | 30s `[PROGRESS] Ns elapsed, still working.` mail to lead | lines 425-431 |
| **Watchdog report** | `WARNING: <name> stuck` mail on LLM-turn timeout | `reportStuckTurn()` (line 131) |
| **Circuit breaker** | `WARNING: <name> network failures` mail + idle transition | lines 580-605 |

The **AWAIT state** (`wait.ts`) already polls this event stream via `eventPending()`:

```ts
function eventPending(env: MachineEnv): boolean {
  if (env.ctx.mail.hasNewMails()) return true;
  const teammates = env.ctx.team.listTeammates();
  if (teammates.some((t) => t.status === 'holding' || t.status === 'working')) return true;
  if (getServeHub().isRunning() && getServeHub().getSteeringNotes().length > 0) return true;
  return false;
}
```

This is the correct pattern: **re-read live status on every poll tick** instead
of trusting a single snapshot. The flaw is that AWAIT is gated on
`autoState.getAuto()` — it exits to PROMPT if auto is off, so manual mode never
uses this event-driven path.

## The fix: STOP polls for teammate events instead of blocking on awaitTeam

### Section 1 — Replace STOP's blocking `awaitTeam()` with an event-polling wait

**File:** `src/loop/states/stop.ts`

**BEFORE** (current, lines ~85-122):
```ts
presentResult(triologue);

const teammates = ctx.team.listTeammates();
if (teammates.some((t) => t.status === 'working')) {
  agentIO.log(chalk.yellow('awaiting teammate(s) — use /team to check status, or ESC to interrupt'));
}

const { result } = await ctx.team.awaitTeam();

const steerPending =
  getServeHub().isRunning() && getServeHub().getSteeringNotes().length > 0;

if (result === 'got question' || ctx.mail.hasNewMails() || steerPending) {
  return AgentState.COLLECT;
}
if (result === 'timeout') {
  const teamInfo = ctx.team.printTeam();
  triologue.note(
    'SYSTEM',
    `Timeout waiting for teammates.\n${teamInfo}\n\nUse tm_await to wait longer, or tm_remove to terminate.`,
  );
  return AgentState.COLLECT;
}
return AgentState.PROMPT;
```

**AFTER:**
```ts
presentResult(triologue);

// Event-polling wait: re-read live teammate status + mailbox + steering on
// every tick, instead of blocking on a one-shot awaitTeam() that can miss
// transitions or misreport 'all done'. This mirrors AWAIT's eventPending()
// pattern but works in manual mode (not gated on autoState).
// The teammate's heartbeat (30s progress mail), status transitions (IPC),
// and watchdog reports ARE the event stream that pumps this loop.
const TEAM_POLL_MS = 1000;
let firstWait = true;

while (true) {
  // ESC pressed — return to PROMPT so the user can intervene.
  if (agentIO.isNeglectedMode()) {
    return AgentState.PROMPT;
  }

  // Re-read live teammate status every tick (not a snapshot).
  const teammates = ctx.team.listTeammates();
  const hasWorking = teammates.some((t) => t.status === 'working');
  const hasHolding = teammates.some((t) => t.status === 'holding');

  if (firstWait && hasWorking) {
    agentIO.log(chalk.yellow('awaiting teammate(s) — use /team to check status, or ESC to interrupt'));
    firstWait = false;
  }

  // Event 1: a teammate is holding (has a question for the lead).
  if (hasHolding) {
    return AgentState.COLLECT;
  }

  // Event 2: no working teammates AND no holding → all done.
  // (Idle/shutdown teammates are not events; they are the resting state.)
  if (!hasWorking) {
    return AgentState.PROMPT;
  }

  // Event 3: new mail arrived (teammate heartbeat, watchdog report, etc.).
  if (ctx.mail.hasNewMails()) {
    return AgentState.COLLECT;
  }

  // Event 4: WebUI steering note queued by the user.
  const steerPending =
    getServeHub().isRunning() && getServeHub().getSteeringNotes().length > 0;
  if (steerPending) {
    return AgentState.COLLECT;
  }

  // No event yet — sleep briefly and re-check. The 1s poll keeps the wait
  // responsive to teammate transitions without busy-spinning. Teammate
  // heartbeats (30s) and status IPCs are picked up on the next tick.
  await new Promise((resolve) => setTimeout(resolve, TEAM_POLL_MS));
}
```

**Why this works:**
- **No one-shot awaitTeam**: the loop re-reads `ctx.team.listTeammates()` on every tick, so it can never miss a transition (the snapshot-vs-event mismatch that caused reproduction 2 is eliminated).
- **No 'all done' misreport**: the loop only returns PROMPT when `!hasWorking` — i.e. genuinely no working teammates. If a teammate is still working (even with a passed deadline), the loop keeps polling, and the LLM never gets a chance to park at PROMPT.
- **Heartbeat-pumped**: teammate heartbeats (30s progress mails) trigger `ctx.mail.hasNewMails()` → COLLECT, letting the LLM see the progress and decide. Watchdog reports (stuck teammate) also trigger COLLECT. The lead is now *reactive to teammate events*, not blind after a one-shot.
- **ESC-respecting**: `agentIO.isNeglectedMode()` is checked every tick, so the user can interrupt at any point (same as AWAIT).
- **No auto-mode coupling**: this works in manual mode. The loop doesn't touch `autoState` at all.

**Design review notes:**
- *Scope:* This replaces the entire `awaitTeam()` call site in STOP. `awaitTeam()` and `awaitTeammate()` in team.ts become unused by STOP, but `tm_await` tool still calls them directly (tm_await.ts:39,47). They are NOT removed — only decoupled from STOP's main path. This is a single-file change (stop.ts).
- *Correlation:* The `awaitTeam()` return-value routing ('timeout' → COLLECT, 'all done' → PROMPT, 'got question' → COLLECT) is replaced by inline checks. The existing `stop-team-await.test.ts` tests mock `awaitTeam` — they will need updating (Section 3). No contract shift for `tm_await` (it calls `awaitTeammate`/`awaitTeam` directly, unchanged).

**Pitfall constraint respected:** No changes to `teammateEta`, no phase-subscriber mechanism changes. The pitfall wiki's "do NOT clear teammateEta on IDLE→WORK" constraint (hash 969d2f65) is irrelevant here — we don't touch `teammateEta` at all.

### Section 2 — Add a unit test for STOP's event-polling wait

**File (new):** `src/tests/loop/states/stop-team-event-poll.test.ts`

The existing `stop-team-await.test.ts` mocks `awaitTeam` — it can't test the new polling loop.

**Test cases:**
1. **Teammate idle at entry → returns PROMPT immediately** (no working teammates, no events). Verifies the `!hasWorking` short-circuit.
2. **Teammate working, then goes idle mid-poll → returns PROMPT**. Mock `listTeammates()` to return 'working' on first call, 'idle' on second. Verifies the re-read catches the transition.
3. **Teammate working, mail arrives → returns COLLECT**. Mock `hasNewMails()` to return true after first tick. Verifies the heartbeat event path.
4. **Teammate holding → returns COLLECT** immediately. Regression guard for the question path.
5. **ESC pressed during wait → returns PROMPT**. Mock `isNeglectedMode()` to return true on second tick.
6. **Steering note arrives during wait → returns COLLECT**. Mock serve hub steering notes.
7. **Teammate working with passed deadline (stale ETA) → keeps polling, does NOT return PROMPT**. This is the reproduction-1 guard: the old code returned 'all done' → PROMPT; the new code keeps polling until the teammate goes idle or mail arrives.

**Mock strategy:** Mock `ctx.team.listTeammates()` (return different statuses on sequential calls), `ctx.mail.hasNewMails()`, `agentIO.isNeglectedMode()`, `getServeHub()`. Use `vi.useFakeTimers()` to control the `setTimeout` poll ticks without real delays.

**Design review notes:**
- *Scope:* This replaces (not extends) `stop-team-await.test.ts` — the old tests mock `awaitTeam` which is no longer called. The old test file should be deleted or its tests moved to test `tm_await`'s consumption of `awaitTeam` instead.

### Section 3 — Update existing tests and code-review backlog

**Files:**
- `src/tests/loop/states/stop-team-await.test.ts` — either delete (the `awaitTeam` mock-based tests are obsolete) or repurpose to test that `tm_await` still works with `awaitTeam` (the tool path is unchanged). The letter-box ordering test (presentResult before wait) stays valid and moves to the new test file.
- `src/tests/loop/states/stop-esc.test.ts` — the "normal-mode branch (awaitTeam)" test (line 258-273) mocks `awaitTeam`; update to match the new polling loop or remove if redundant with the new test file.
- `.mycc/code-review/SUMMARY-of-unfixed-issues.md` — update dir-1 entry to "FIXED" after commit.
- `.mycc/code-review/2026-09-02-1644-agent-loop-teammate-wait-stall.md` — append resolution note.

**Design review notes:**
- *Correlation:* `stop-esc.test.ts` and `stop-team-await.test.ts` both mock `state-machine.js` and `agent-io.js` — the new test file reuses the same mock pattern. No ordering dependency between them.

### Section 4 — Follow-up: deprecate awaitTeam/awaitTeammate phase-subscriber mechanism (NOT part of this fix)

The phase-1/phase-2 subscriber mechanism in `awaitTeammate` (the `promise` half
of `Promise.race`) is now bypassed by STOP's polling loop. It remains used only
by `tm_await` (the LLM-callable tool). The subscriber mechanism is the source
of the snapshot-vs-event race (reproduction 2) — a future cleanup could replace
`awaitTeammate`'s subscriber with the same poll-based approach (re-read status
on every tick), unifying the two wait patterns. This is a follow-up, not part
of this fix — `tm_await` is a rarely-used tool and its one-shot await is
acceptable for interactive use.

## Summary of changes

1. **Edit** `src/loop/states/stop.ts` — replace blocking `awaitTeam()` call with an event-polling loop that re-reads teammate status + mailbox + steering on every 1s tick (~40 lines replacing ~20)
2. **Create** `src/tests/loop/states/stop-team-event-poll.test.ts` — 7 test cases using fake timers + sequential `listTeammates` mocks
3. **Update/Delete** `src/tests/loop/states/stop-team-await.test.ts` + `stop-esc.test.ts` — remove obsolete `awaitTeam`-mock tests, keep letter-box ordering test
4. **Document** the phase-subscriber deprecation as a follow-up; update code-review backlog after commit

No changes to `team.ts` (awaitTeam/awaitTeammate preserved for `tm_await`).
No changes to `wait.ts` (AWAIT unchanged).
No changes to `prompt.ts`, `auto-state.ts`, or the frontend.
The fix is localized to STOP's teammate-wait path.

## Resources consulted

- `src/context/parent/team.ts` (awaitTeam, awaitTeammate, phase subscribers, handleChildMessage) — IN USE
- `src/context/teammate-worker.ts` (heartbeat, watchdog, circuit breaker, status IPC) — IN USE
- `src/loop/states/stop.ts` (STOP handler, awaitTeam consumption) — IN USE
- `src/loop/states/wait.ts` (AWAIT, eventPending, poll pattern) — IN USE
- `src/loop/states/prompt.ts` (PROMPT, auto gate, Layer B catch) — IN USE
- `src/loop/state-machine.ts` (state transitions, presentResult) — IN USE
- `src/serve/serve-hub.ts` (waitForInput, rejectInput, steering) — IN USE
- `src/serve/web-input-provider.ts` (getInput → waitForInput) — IN USE
- `src/loop/serve-wiring.ts` (enterAutoProvider, rejectInput) — IN USE
- `src/web/src/message-dispatch.ts` (isWaiting/isRunning flag transitions) — IN USE
- `src/tools/tm_await.ts` (awaitTeammate/awaitTeam consumer) — IN USE
- `src/tests/loop/states/stop-team-await.test.ts` (existing test coverage) — IN USE
- Pitfall wiki (hash 969d2f65 — stale ETA constraint) — IN USE
- Counterwork teammate verdict (line-by-line verification) — IN USE