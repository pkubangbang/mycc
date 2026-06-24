# Plan: Fix Teammate Termination Without Results

## Problem

When mycc spawns teammates to collaborate, most of the time the teammates
get terminated with no result. The lead agent sees that the teammate is
"done" but no work was actually produced.

## Root Cause Analysis

### Root Cause 1: `child.disconnect()` kills teammates prematurely (CRITICAL)

**File:** `src/context/parent/team.ts` — `removeTeammate()` and `dismissTeam()`

The soft shutdown path sends the `shutdown` IPC message then immediately
calls `child.disconnect()`:

```typescript
child.send({ type: 'shutdown' } as ParentMessage);
child.disconnect();  // <-- KILLS THE CHILD IMMEDIATELY
```

On the child side:
```typescript
process.on('disconnect', () => {
  sendStatus('shutdown');
  process.exit(0);
});
```

The child exits before it can finish work, send results, or close issues.

**Affected callers:** `tm_remove` (non-force), `dismissTeam(false)`, SIGINT/SIGTERM handlers.

### Root Cause 2: "No tool calls = done" assumption (MAJOR)

**File:** `src/context/teammate-worker.ts`

```typescript
if (!toolCalls || toolCalls.length === 0) {
    ctx.team.mailTo('lead', 'task done', ...);
    const result = await enterIdleState(triologue);
    ...
}
```

A text-only "I understand" from the LLM triggers "task done" immediately.

### Root Causes 3-5: (MODERATE)

- **No init handshake**: `createTeammate()` returns before child is ready
- **No structured results**: "task done" mail is unstructured
- **Fixed 60s timeout**: Too short, triggers premature kill

---

## Proposed Fixes

### Fix 1: Remove `child.disconnect()` from soft shutdown

**File:** `src/context/parent/team.ts`

Send `shutdown` IPC but keep the channel open. Child exits
cooperatively via `shutdownRequested` checks. Same for `dismissTeam()`.

### Fix 3: Wait for `teammate_ready`

**File:** `src/context/parent/team.ts` — `createTeammate()`

After spawning, wait for child's `teammate_ready` IPC (30s timeout).

---

## The Protocol: Budget Negotiation via `mail_to`

### The flow (6 steps)

```
 Lead                          Teammate
 ────                          ────────
 1. tm_create(A,prompt) ────► handleSpawn()
                                 load tools
 2.                     ◄──── IPC: ready
    waits for ready

 3.                     ◄──── mail_to(eta=<abs_ts>)
    stores eta                   "Here's my plan, ETA: <time>"
                         ◄──── IPC: eta_update{eta, sender}
    stores deadline

 4. tm_await(A) ──────────►   works...
    polls deadline              ├── heartbeats every 30s
    extends on new eta          ├── time reminders per round
                                └── extension via mail_to(new eta)

 5.                     ◄──── IPC: idle
    await resolves              [COMPLETE] mail sent

 6. [on timeout] lead's LLM decides: wait more or shutdown
```

### Key design points

- `eta` is **optional** in JSON Schema (lead doesn't need it)
- **Handler enforces**: child→lead MUST have positive `eta` (absolute Unix timestamp)
- `eta=0` or omitted → normal mail, no budget tracking
- IPC `eta_update` carries the numeric timestamp for parent's `TeamManager`
- `eta=0` or omitted is used for non-budget mails (progress updates, lead responses)

---

### Fix 2a: Update `mail_to` tool

**File:** `src/tools/mail_to.ts`

**JSON Schema** — `eta` is optional in schema, enforced by handler:

```typescript
input_schema: {
    type: 'object',
    properties: {
        name: { type: 'string', description: 'Target name (teammate or "lead")' },
        title: { type: 'string', description: 'Message title/subject' },
        content: { type: 'string', description: 'Message body content' },
        eta: {
            type: 'number',
            description: 'MANDATORY when a teammate sends the first (or extension) ' +
                'mail to lead to set a time budget. Optional otherwise. ' +
                'An absolute Unix timestamp in seconds. ' +
                'The lead will wait until this deadline. ' +
                'Use Math.floor(Date.now()/1000) + N for N seconds from now. ' +
                'Set to 0 or omit for non-budget messages.',
        },
    },
    required: ['name', 'title', 'content'],
}
```

**Handler logic:**

```typescript
handler: (ctx, args) => {
    const name = args.name as string;
    const title = args.title as string;
    const content = args.content as string;
    const eta = args.eta as number | undefined;

    const senderName = ctx.core.getName();
    const isTeammateToLead = name === 'lead' && senderName !== 'lead';
    const now = Math.floor(Date.now() / 1000);

    // === Conditional enforcement: child→lead requires positive eta ===
    if (isTeammateToLead) {
        if (eta === undefined) {
            return 'Error: eta (absolute Unix timestamp) is required when ' +
                   'sending to lead. Example: eta=' + (now + 120);
        }
        if (typeof eta !== 'number' || !Number.isInteger(eta) || eta <= 0) {
            return 'Error: eta must be a positive integer Unix timestamp.';
        }

        // Send IPC to parent so TeamManager knows the deadline
        try {
            const { ipc } = require('../context/child/ipc-helpers.js');
            ipc.sendNotification('eta_update', { eta, sender: senderName });
        } catch { /* not a child process */ }

        ctx.team.mailTo(name, title, content);
        return `OK. Budget sent to lead. ETA: ${eta} (${Math.max(0, eta - now)}s from now).`;
    }

    // === Lead→anyone or child→other: eta is optional ===
    ctx.team.mailTo(name, title, content);
    return 'OK';
}
```

**Behavior summary:**

| Scenario | `eta` | Effect |
|----------|-------|--------|
| child → lead | REQUIRED (positive) | Budget tracked + IPC sent |
| child → lead, extension | REQUIRED (positive) | Deadline updated |
| child → lead, status | can omit or 0 | Normal mail |
| lead → anyone | optional | Normal mail |
| child → teammate | optional | Normal mail |

---

### Fix 2b: Minimal changes in teammate-worker

**File:** `src/context/teammate-worker.ts`

No phase machine needed. Just track whether the ETA budget was set,
with two additions:

**1. Budget tracking state:**

```typescript
// Minimal budget tracking
let budgetSent = false;
let deadlineMs = 0;
let startTime = 0;
let lastHeartbeatTime = Date.now();
let nextTimeNudge = 3;
let hasDoneWork = false;
```

**2. Detect when `mail_to(eta>0)` was called, by checking the tool result:**

```typescript
// After executing each tool:
if (tc.function.name === 'mail_to' && !budgetSent) {
    const eta = tc.function.arguments?.eta as number;
    if (eta > 0) {
        budgetSent = true;
        deadlineMs = eta * 1000;
        startTime = Date.now();
        lastHeartbeatTime = Date.now();
    }
}

// Track work done (action tools only, not exploration)
if (!EXPLORATION_TOOLS.has(toolName)) {
    hasDoneWork = true;
}
```

**3. No-tool-calls guard (prevents false "done"):**

```typescript
if (!toolCalls || toolCalls.length === 0) {
    triologue.agent(content, undefined, reasoning);

    if (!budgetSent) {
        // Never started any work — re-prompt instead of idle
        triologue.note('CONTINUE',
            'Request budget via mail_to(name="lead", eta=..., ...).');
        continue;
    }

    if (hasDoneWork) {
        // Actually did work and LLM finished — enter idle
        sendCompletionMail();
        const result = await enterIdleState(triologue);
        if (result === 'shutdown') process.exit(0);
        continue;
    }

    // Has budget but no work done — re-prompt to use tools
    triologue.note('CONTINUE', 'Use tools to make progress on the task.');
    continue;
}
```

**4. Time reminder (every 3 rounds):**

```typescript
if (budgetSent && (phase === 'working')) {
    const remaining = Math.max(0, Math.round((deadlineMs - Date.now()) / 1000));
    nextTimeNudge--;
    if (nextTimeNudge <= 0) {
        triologue.note('TIME_REMINDER',
            `Deadline: ${new Date(deadlineMs).toISOString()}` +
            ` (~${remaining}s left). ` +
            (remaining < 30
                ? `Send mail_to with new eta to extend.`
                : `Keep working.`));
        nextTimeNudge = 3;
    }
}
```

**5. Heartbeat every 30s (in main loop, after tool execution):**

```typescript
if (budgetSent && (Date.now() - lastHeartbeatTime >= 30000)) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const remaining = Math.max(0, Math.round((deadlineMs - Date.now()) / 1000));
    ctx.team.mailTo('lead', `Progress: ${ctx.core.getName()}`,
        `[PROGRESS] ${elapsed}s elapsed, ~${remaining}s remaining\n` +
        `Deadline: ${new Date(deadlineMs).toISOString()}`);
    lastHeartbeatTime = Date.now();
}
```

**6. Completion mail:**

```typescript
function sendCompletionMail(): void {
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    ctx.team.mailTo('lead', `Results: ${ctx.core.getName()}`,
        `[COMPLETE] ${ctx.core.getName()} finished in ${elapsedSec}s\n` +
        `**Summary:** Task completed.\n`);
}
```

---

### Fix 5: Timer tracking in TeamManager

**File:** `src/context/parent/team.ts`

ETA is an **absolute Unix timestamp** (seconds). The lead stores it
as an absolute deadline in milliseconds:

```
deadlineMs = eta * 1000
remaining  = max(0, deadlineMs - Date.now())
```

**State:**

```typescript
private teammateEta: Map<string, {
    deadlineMs: number;     // Absolute deadline in ms
    updatedAt: number;      // When this ETA was last set
}> = new Map();
```

**IPC handler** (in `handleChildMessage`):

```typescript
if (msg.type === 'eta_update') {
    const { eta, sender } = msg as { eta: number; sender: string };
    const deadlineMs = eta * 1000;
    this.teammateEta.set(sender, { deadlineMs, updatedAt: Date.now() });
    ctx.core.brief('info', 'eta_update',
        `${sender}: deadline ${new Date(deadlineMs).toISOString()}`);
    return;
}
```

**Modified `awaitTeammate()`:**

```typescript
async awaitTeammate(name, defaultTimeout = 300000) {
    const stored = this.teammateEta.get(name);
    let timeout = defaultTimeout;
    if (stored) {
        const remaining = Math.max(0, stored.deadlineMs - Date.now());
        if (remaining > 0) timeout = remaining;
    }

    // Existing subscriber logic...
    const promise = new Promise<void>((resolve) => {
        const status = this.statuses.get(name);
        if (status === 'holding') resolve();
        else if (status === 'working') {
            const phase2 = this.phase2Subscribers.get(name) ?? new Set();
            phase2.add(resolve);
            this.phase2Subscribers.set(name, phase2);
        } else {
            const phase1 = this.phase1Subscribers.get(name) ?? new Set();
            phase1.add(resolve);
            this.phase1Subscribers.set(name, phase1);
        }
    });

    // Dynamic timeout with poll-based deadline tracking
    const timeoutPromise = new Promise<void>((resolve) => {
        let lastCheck = 0;
        const poll = () => {
            const status = this.statuses.get(name);
            if (status === 'idle' || status === 'shutdown') {
                resolve(); return;
            }

            const eta = this.teammateEta.get(name);
            if (eta) {
                if (eta.updatedAt > lastCheck) {
                    lastCheck = eta.updatedAt; // deadline extended
                }
                if (Date.now() >= eta.deadlineMs) {
                    resolve(); return; // deadline passed
                }
            } else if (lastCheck === 0) {
                lastCheck = Date.now(); // start default timeout
            } else if (Date.now() - lastCheck >= defaultTimeout) {
                resolve(); return; // default timeout
            }

            setTimeout(poll, 1000);
        };
        poll();
    });

    await Promise.race([promise, timeoutPromise]);
    return { waited: true };
}
```

**Cleanup:**

```typescript
removeTeammate(name, force) {
    this.teammateEta.delete(name);
    // ... existing logic (without child.disconnect()) ...
}
```

---

### Fix 6: Timeout handling in STOP state

**File:** `src/loop/states/stop.ts`

Update the timeout message to include team status:

```typescript
if (result === 'timeout') {
    const teamInfo = ctx.team.printTeam();
    triologue.note('TIMEOUT',
        `Timeout waiting for teammates.\n${teamInfo}\n\n` +
        `Use tm_await to wait longer, or tm_remove to terminate.`);
}
```

---

### Fix 7: Lead-side timer visibility

The lead LLM needs to know each teammate's deadline. Three channels:

#### 7a. `tm_print` shows deadline + remaining

**File:** `src/context/parent/team.ts` — `printTeam()`

```typescript
printTeam(): string {
    const teammates = this.listTeammates();
    if (teammates.length === 0) return 'No teammates.';

    const lines = ['Team:'];
    for (const t of teammates) {
        let info = `  ${t.name} (${t.role}): ${t.status}`;
        const eta = this.teammateEta.get(t.name);
        if (eta && t.status === 'working') {
            const remaining = Math.max(0,
                Math.round((eta.deadlineMs - Date.now()) / 1000));
            const deadlineStr = new Date(eta.deadlineMs).toLocaleTimeString();
            info += `, deadline ${deadlineStr} (${remaining}s remaining)`;
        }
        lines.push(info);
    }
    return lines.join('\n');
}
```

**Output:** `coder (developer): working, deadline 14:30:00 (85s remaining)`

#### 7b. COLLECT state injects `TEAM_STATUS` note

**File:** `src/loop/states/collect.ts`

After processing mail, inject team status so the lead sees deadlines
without calling `tm_print`:

```typescript
// After existing mail processing (step 2):
if (mails.length > 0) {
    // ... existing mail injection ...
}

// Always inject team status if teammates exist
const teamStatus = ctx.team.printTeam();
if (teamStatus !== 'No teammates.') {
    triologue.note('TEAM_STATUS', teamStatus);
}
```

Every turn, the lead sees:
```
[TEAM_STATUS]
Team:
  coder (developer): working, deadline 14:30:00 (85s remaining)
```

#### 7c. `tm_await` timeout brief includes deadline info

**File:** `src/context/parent/team.ts` — timeout poll

When deadline passes, brief the lead with actionable info:

```typescript
if (Date.now() >= eta.deadlineMs) {
    ctx.core.brief('warn', name,
        `Deadline ${new Date(eta.deadlineMs).toLocaleTimeString()} passed. ` +
        `Use tm_await to wait longer, tm_remove to terminate.`);
    resolve();
    return;
}
```

---

## Implementation Order

1. **Fix 1** — Remove `child.disconnect()` from `removeTeammate()` / `dismissTeam()`
2. **Fix 3** — Make `createTeammate()` wait for `teammate_ready` (30s timeout)
3. **Fix 2a** — Add `eta` to `mail_to` schema (`required` array), handler logic, IPC
4. **Fix 2b** — Minimal worker changes in `teammate-worker.ts` (budgetSent tracking, no-tool-calls guard, reminders, heartbeats, completion mail)
5. **Fix 5** — Timer tracking in `TeamManager` (ETA map, IPC handler, poll-based await)
6. **Fix 6** — Update STOP state timeout message

## Files to Modify

| File | Changes |
|------|---------|
| `src/tools/mail_to.ts` | Add `eta` param, handler validates child→lead, sends IPC `eta_update` |
| `src/context/parent/team.ts` | Fix 1 (no disconnect), Fix 3 (ready wait), Fix 5 (ETA map + poll await), Fix 7a (printTeam with deadline) |
| `src/context/teammate-worker.ts` | Fix 2b: budgetSent tracking, no-tool-calls guard, time reminders, heartbeats, completion |
| `src/loop/states/stop.ts` | Fix 6: enhanced timeout message |
| `src/loop/states/collect.ts` | Fix 7b: inject TEAM_STATUS note each turn |
| `src/context/parent-context.ts` | Register `eta_update` IPC handler |
| `src/tools/tm_print.ts` | Fix 7a: update description to mention deadline info |

## Testing

1. **Unit**: `mail_to` rejects non-integer `eta`, accepts valid `eta`
2. **Unit**: `createTeammate` waits for `teammate_ready`
3. **Unit**: `awaitTeammate` polls deadline, extends on new ETA
4. **Integration**: spawn teammate, mail_to has `eta` in schema → LLM always provides it
5. **Integration**: spawn with `mail_to(eta=now+30)` → works ~30s then deadline expires
6. **Integration**: spawn + extension `mail_to(eta=now+60)` → works ~60s total
7. **Edge**: `force=true` kills immediately
8. **Edge**: child crashes during init → parent timeout error

## Acceptance Criteria

- [ ] `mail_to` has `eta` as optional in schema, handler enforces child→lead requires it
- [ ] `mail_to` from child→lead with `eta>0` → budget tracked + IPC sent
- [ ] `mail_to` from child→lead with `eta=0` → normal mail, no budget
- [ ] Text-only LLM response before budget sent → re-prompt, NOT idle
- [ ] Lead's `awaitTeammate` uses child's ETA as dynamic deadline
- [ ] Child sends progress heartbeats every ~30s
- [ ] Child gets time-remaining reminders every 3 LLM rounds
- [ ] Child can extend by sending `mail_to` with new `eta`
- [ ] `awaitTeammate` deadline extends when new ETA arrives
- [ ] On timeout: lead's LLM informed with team status
- [ ] `tm_remove` without force → child finishes gracefully
- [ ] No orphan processes when lead exits
