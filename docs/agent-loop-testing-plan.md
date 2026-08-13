# Agent-Loop Testing Plan

> **Goal**: Enhance agent-loop observability, build a maintainable mock harness, and exhaustively test all state transition paths for streak x=1,2,3 using a parametric test generator.
>
> **Status:** Implemented. All planned files exist: `src/loop/loop-events.ts`, `src/tests/loop/loop-events-helper.ts`, `src/tests/loop/mock-harness.ts`, `src/tests/loop/console-capture.ts`, `src/tests/loop/path-generator.ts`, `src/tests/loop/states/paths-x1.test.ts`, `paths-x2.test.ts`, `paths-x3.test.ts`. All 10 events and 53 paths are implemented.

---

## Background

The agent-loop uses an explicit state machine (`src/loop/state-machine.ts`) with 8 states: PROMPT, SLASH, COLLECT, LLM, HOOK, TOOL, STOP, WAIT. Three data tiers (MachineEnv, TurnVars, PassData) manage state lifetime. The LLM call surface is `retryChat()` / `forkChat()` in `src/engine/chat-provider.ts`.

Existing tests (13 files in `src/tests/loop/states/`) focus on ESC scenarios. The test infrastructure (vitest, `mock-context.ts`, `esc-test-helpers.ts`) is solid but lacks structured observability, a centralized mock layer, and systematic path coverage.

---

## Topological Analysis: State Transition Paths

### The Cyclic Structure

The agent loop is cyclic. One **cycle** = PROMPT → ... → PROMPT. The **streak** x = number of LLM calls in one cycle. For daily usage, x ∈ {1, 2, 3} covers all practical scenarios (larger x decomposes into combinations of smaller x).

### Bridge vs Exit Alphabet

Each LLM call enters `LLM → HOOK`. From HOOK (and from LLM/TOOL/COLLECT), the transition is either a **bridge** (loop continues → COLLECT) or an **exit** (loop terminates → PROMPT).

**Bridges (continue the loop):**

| Symbol | Path | Meaning |
|--------|------|---------|
| **T** | HOOK→TOOL→COLLECT | Tool calls executed, normal tool round |
| **H** | HOOK→COLLECT | Hook-blocked / deferred messages / crossroad / checkpoint / recap → re-enter COLLECT |
| **W** | HOOK→STOP→COLLECT | No tools + team question/mail/timeout → STOP awaits → COLLECT |

**Exits (end the loop):**

| Symbol | Path | Meaning |
|--------|------|---------|
| **E** | LLM→PROMPT | ESC during LLM, empty retries exhausted, or transient error user-declined |
| **X** | HOOK→PROMPT | ESC during recap, or HOOK catch error |
| **P** | HOOK→TOOL→PROMPT | ESC during tool execution |
| **S** | HOOK→STOP→PROMPT | No tools + all-done / no teammates / neglected wrap-up |
| **CE** | COLLECT→PROMPT | ESC during hint round in COLLECT, or COLLECT catch error (zero-LLM exit) |

### Counting Formula

A path of streak x consists of:
- **(x−1) bridges** — each independently chosen from {T, H, W} → 3 choices each
- **1 exit** — chosen from {E, X, P, S} → 4 choices (CE is a zero-LLM exit, only counts for x=1 as an independent path)

**Special case:** CE (COLLECT→PROMPT) is a zero-LLM exit — it fires before any LLM call. It only forms an independent path at x=1 (streak=0 technically, but grouped with x=1 as "single-turn exits"). For x≥2, a CE would mean fewer actual LLM calls, belonging to a smaller streak.

**Formula:**
```
M(1) = 4 (exits E,X,P,S) + 1 (CE) = 5
M(2) = 3 (bridge) × 4 (exit)     = 12
M(3) = 3² (bridges) × 4 (exit)   = 36

Total = 5 + 12 + 36 = 53  (well under 100)
```

### Complete Path Enumeration

#### x=1: 5 paths (single LLM call, no bridges)

| # | Path | Symbol |
|---|------|--------|
| 1 | PROMPT→COLLECT→LLM→HOOK→TOOL→COLLECT→... | T (bridge, not a complete cycle — only counted at x≥2) |
| — | **Exits:** | |
| 1 | PROMPT→COLLECT→LLM→PROMPT | E |
| 2 | PROMPT→COLLECT→LLM→HOOK→PROMPT | X |
| 3 | PROMPT→COLLECT→LLM→HOOK→TOOL→PROMPT | P |
| 4 | PROMPT→COLLECT→LLM→HOOK→STOP→PROMPT | S |
| 5 | PROMPT→COLLECT→PROMPT | CE |

#### x=2: 12 paths (1 bridge + 1 exit)

| # | Bridge | Exit | Full Path |
|---|--------|------|-----------|
| 1 | T | E | P→C→L→H→T(o)→C→L→P |
| 2 | T | X | P→C→L→H→T(o)→C→L→H→P |
| 3 | T | P | P→C→L→H→T(o)→C→L→H→T→P |
| 4 | T | S | P→C→L→H→T(o)→C→L→H→S→P |
| 5 | H | E | P→C→L→H→C→L→P |
| 6 | H | X | P→C→L→H→C→L→H→P |
| 7 | H | P | P→C→L→H→C→L→H→T→P |
| 8 | H | S | P→C→L→H→C→L→H→S→P |
| 9 | W | E | P→C→L→H→S→C→L→P |
| 10 | W | X | P→C→L→H→S→C→L→H→P |
| 11 | W | P | P→C→L→H→S→C→L→H→T→P |
| 12 | W | S | P→C→L→H→S→C→L→H→S→P |

*(P=PROMPT, C=COLLECT, L=LLM, H=HOOK, T=TOOL, S=STOP, o=tool execution→COLLECT)*

#### x=3: 36 paths (2 bridges + 1 exit)

Each of the 9 bridge combinations (TT, TH, TW, HT, HH, HW, WT, WH, WW) × 4 exits = 36 paths. The full table is mechanically generated — see the parametric generator below.

### How x≥4 Decomposes

A streak of x=4 (e.g., T-T-T-S) is simply three tool rounds then a stop — it's the composition of x=1 paths repeated. Testing x=1,2,3 covers all atomic transition types; longer streaks are compositions and need not be individually tested.

---

## Workstream 1: Observability Enhancement

### Problem

No structured event log exists. State transitions, tool execution results, hook decisions, confusion index changes, and triologue events are invisible to tests.

### Design

Create a lightweight **LoopEventEmitter** — a no-op singleton when no listeners are attached (zero production overhead). Tests subscribe to collect assertions.

### Files to Create

| File | Purpose |
|------|---------|
| `src/loop/loop-events.ts` | **LoopEventEmitter** singleton. Events: `state_transition`, `tool_executed`, `tool_error`, `hook_result`, `compact_triggered`, `confusion_score`, `triologue_event`, `llm_call`, `llm_empty`, `esc_interrupt`. |
| `src/tests/loop/loop-events-helper.ts` | `captureLoopEvents()` → `{ trace, cleanup }`. `getStateSequence(trace)` → `AgentState[]`. |

### Files to Modify (instrumentation)

| File | Instrumentation |
|------|-----------------|
| `src/loop/state-machine.ts` | Emit `state_transition` after each handler: `{ from, to }` |
| `src/loop/states/llm.ts` | Emit `llm_call`, `llm_empty`, `compact_triggered`, `esc_interrupt` |
| `src/loop/states/tool.ts` | Emit `tool_executed`, `tool_error`, `esc_interrupt` |
| `src/loop/states/hook.ts` | Emit `hook_result: { blocked, compactRequested }` |
| `src/loop/states/collect.ts` | Emit `confusion_score` |
| `src/loop/triologue.ts` | Emit `triologue_event` on `onCompact`/`onMisorder`/`onToolMisalign` |

### Acceptance Criteria

- [ ] Emitter is silent when no listeners attached (no production impact)
- [ ] `state_transition` events capture full state sequence
- [ ] `tool_executed` / `tool_error` events capture tool outcomes
- [ ] `compact_triggered` fires on auto-compact
- [ ] All existing tests pass
- [ ] `pnpm typecheck` passes

---

## Workstream 2: Centralized Mock Harness + Console Capture

### Problem

Every test file has 10+ `vi.mock()` blocks with hardcoded paths. Any import path refactor breaks them all. LLM responses are hand-assembled per test. No console output capture.

### Design

**MockHarness** centralizes all `vi.mock` setup into one file. LLM responses and tool results are driven by a **path descriptor** (the bridge/exit symbol sequence) rather than hand-written per test. **ConsoleCapture** intercepts console output.

### Files to Create

| File | Purpose |
|------|---------|
| `src/tests/loop/mock-harness.ts` | **MockHarness** — centralizes ALL vi.mock for agent-loop tests. One `install()` call replaces 10+ scattered mock blocks. Driven by a `PathDescriptor` (bridge/exit symbols) that auto-generates the correct LLM response sequence. |
| `src/tests/loop/console-capture.ts` | **ConsoleCapture** — `start()/stop()/getOutput()/filter()`. Intercepts `console.log/warn/error`. |

### MockHarness Core Design

```typescript
// src/tests/loop/mock-harness.ts

/** A bridge or exit symbol from the topological alphabet */
export type Symbol = 'T' | 'H' | 'W' | 'E' | 'X' | 'P' | 'S' | 'CE';

/** Describes a path by its symbol sequence, e.g. ['T', 'S'] = x=2 tool-then-stop */
export interface PathDescriptor {
  symbols: Symbol[];       // e.g. ['T', 'S'] for x=2
  userQuery?: string;      // initial user input
  toolResults?: string[];  // outputs for T bridges (defaults to 'ok')
}

export class MockHarness {
  constructor(private desc: PathDescriptor) {}

  install(): void {
    // ALL vi.mock blocks centralized here — test files have ZERO vi.mock
    vi.mock('../../../engine/chat-provider.js', () => ({
      retryChat: vi.fn(async () => this.nextLlmResponse()),
      forkChat: vi.fn(async () => ({ message: { role: 'assistant', content: 'fork' }, done: true })),
      MODEL: 'test-model',
    }));
    vi.mock('../../../loop/agent-io.js', () => { /* ... */ });
    vi.mock('../../../loop/esc-wrap-up.js', () => ({ /* ... */ }));
    vi.mock('../../../loop/crossroad.js', () => ({ /* ... */ }));
    vi.mock('../../../engine/chat-helpers.js', () => ({ /* ... */ }));
    vi.mock('../../../loop/agent-prompts.js', () => ({ /* ... */ }));
    vi.mock('../../../context/shared/loader.js', () => ({
      loader: {
        getToolsForScope: vi.fn(() => [{ function: { name: 'bash' } }]),
        execute: vi.fn(async () => this.nextToolResult()),
      },
    }));
    vi.mock('../../../loop/triologue.js', () => { /* ... */ });
    vi.mock('../../../loop/state-machine.js', () => ({ /* ... */ }));
  }

  /** Generate the correct LLM response for the current symbol */
  private nextLlmResponse(): unknown {
    const sym = this.consumeSymbol();
    // Bridges (T,H,W): LLM produces tool calls (T) or triggers hook-block (H) or no-tools (W)
    // Exits (E,X,P,S): E=ESC during LLM, X/P/S=LLM succeeds then exit fires downstream
    switch (sym) {
      case 'T': return createMockChatResponse({ toolCalls: [createMockToolCall('bash')] });
      case 'H': return createMockChatResponse({ toolCalls: [createMockToolCall('checkpoint')] }); // triggers HOOK→COLLECT
      case 'W': return createMockChatResponse({ content: 'text only' }); // no tools → STOP awaits → COLLECT
      case 'E': throw new Error('ESC'); // simulates ESC during LLM
      case 'X': return createMockChatResponse({ content: 'text' }); // HOOK catch will fire
      case 'P': return createMockChatResponse({ toolCalls: [createMockToolCall('bash')] }); // TOOL ESC fires
      case 'S': return createMockChatResponse({ content: 'final answer' }); // no tools → STOP → PROMPT
      default:  return createMockChatResponse({ content: 'ok' });
    }
  }
}
```

### Acceptance Criteria

- [ ] `MockHarness.install()` replaces all scattered vi.mock blocks
- [ ] `PathDescriptor` drives LLM response generation from symbol sequence
- [ ] Test files contain ZERO `vi.mock()` calls
- [ ] `ConsoleCapture` captures console.log/warn/error
- [ ] `ConsoleCapture.stop()` fully restores originals
- [ ] All existing tests pass
- [ ] `pnpm typecheck` passes

---

## Workstream 3: Parametric Path Test Generator

### Problem

53 paths is too many to hand-write individual tests. But the paths are mechanically generated from the bridge/exit alphabet — a **parametric test generator** can produce all 53 tests from a compact specification.

### Design

A single `path-generator.ts` enumerates all valid symbol sequences for x=1,2,3, and a data-driven `it.each()` block runs one test per path. Each test:
1. Creates a `MockHarness` from the path's `PathDescriptor`
2. Drives the state handlers through the path
3. Asserts the `state_transition` event trace matches the expected sequence
4. Verifies `ConsoleCapture` output where applicable

### Files to Create

| File | Purpose |
|------|---------|
| `src/tests/loop/path-generator.ts` | Enumerates all 53 paths as `PathSpec[]`. Each spec: `{ id, x, symbols, expectedStates, description }`. Also provides `drivePath(spec, harness)` — runs the state handlers through the path. |
| `src/tests/loop/states/paths-x1.test.ts` | Data-driven tests for all 5 x=1 paths via `it.each(pathGenerator.x1())`. |
| `src/tests/loop/states/paths-x2.test.ts` | Data-driven tests for all 12 x=2 paths. |
| `src/tests/loop/states/paths-x3.test.ts` | Data-driven tests for all 36 x=3 paths. Split into 2 files if >300 lines. |

### path-generator.ts Design

```typescript
// src/tests/loop/path-generator.ts

import type { Symbol } from '../mock-harness.js';
import { AgentState } from '../../../loop/state-machine.js';

export interface PathSpec {
  id: string;           // e.g. "x2-T-S"
  x: number;            // streak length
  symbols: Symbol[];    // e.g. ['T', 'S']
  expectedStates: AgentState[];  // full state sequence
  description: string;
}

const BRIDGES: Symbol[] = ['T', 'H', 'W'];
const EXITS: Symbol[] = ['E', 'X', 'P', 'S'];

/** Expand symbols into the full state sequence */
function expandStates(symbols: Symbol[]): AgentState[] {
  const states: AgentState[] = [AgentState.PROMPT, AgentState.COLLECT];
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const isLast = i === symbols.length - 1;
    // LLM always runs (except CE which exits before LLM)
    if (sym === 'CE') {
      states.push(AgentState.PROMPT);
      return states;
    }
    states.push(AgentState.LLM, AgentState.HOOK);
    if (isLast) {
      // Exit symbol
      switch (sym) {
        case 'E': states.push(AgentState.PROMPT); break;
        case 'X': states.push(AgentState.PROMPT); break;
        case 'P': states.push(AgentState.TOOL, AgentState.PROMPT); break;
        case 'S': states.push(AgentState.STOP, AgentState.PROMPT); break;
      }
    } else {
      // Bridge symbol
      switch (sym) {
        case 'T': states.push(AgentState.TOOL, AgentState.COLLECT); break;
        case 'H': states.push(AgentState.COLLECT); break;
        case 'W': states.push(AgentState.STOP, AgentState.COLLECT); break;
      }
    }
  }
  return states;
}

/** Generate all paths for streak x */
function generatePaths(x: number): PathSpec[] {
  const paths: PathSpec[] = [];
  if (x === 1) {
    // CE: zero-LLM exit
    paths.push({ id: 'x1-CE', x: 1, symbols: ['CE'],
      expectedStates: expandStates(['CE']), description: 'COLLECT→PROMPT (ESC/error in COLLECT)' });
    // Single exit after 1 LLM call
    for (const exit of EXITS) {
      paths.push({ id: `x1-${exit}`, x: 1, symbols: [exit],
        expectedStates: expandStates([exit]), description: `Exit ${exit} after 1 LLM` });
    }
  } else {
    // (x-1) bridges + 1 exit
    const bridgeCombos = cartesian(BRIDGES, x - 1);
    for (const bridges of bridgeCombos) {
      for (const exit of EXITS) {
        const symbols = [...bridges, exit];
        paths.push({
          id: `x${x}-${bridges.join('')}-${exit}`,
          x, symbols,
          expectedStates: expandStates(symbols),
          description: `Bridges ${bridges.join('')} then exit ${exit}`,
        });
      }
    }
  }
  return paths;
}

function cartesian<T>(items: T[], n: number): T[][] {
  if (n === 0) return [[]];
  const sub = cartesian(items, n - 1);
  return sub.flatMap(s => items.map(i => [...s, i]));
}

export const pathGenerator = {
  x1: () => generatePaths(1),  // 5 paths
  x2: () => generatePaths(2),  // 12 paths
  x3: () => generatePaths(3),  // 36 paths
  all: () => [...generatePaths(1), ...generatePaths(2), ...generatePaths(3)],  // 53 paths
};
```

### Test File Pattern (paths-x1.test.ts)

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pathGenerator, type PathSpec } from '../path-generator.js';
import { MockHarness } from '../mock-harness.js';
import { captureLoopEvents, getStateSequence } from '../loop-events-helper.js';
import { ConsoleCapture } from '../console-capture.js';

describe.each(pathGenerator.x1())('x=1 path: $id', (spec: PathSpec) => {
  let consoleCap: ConsoleCapture;
  let eventCap: ReturnType<typeof captureLoopEvents>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleCap = new ConsoleCapture();
    consoleCap.start();
    eventCap = captureLoopEvents();
  });

  afterEach(() => {
    consoleCap.stop();
    eventCap.cleanup();
  });

  it(`should match expected state sequence for ${spec.description}`, async () => {
    const harness = new MockHarness({ symbols: spec.symbols, userQuery: 'test' });
    harness.install();

    // Dynamically import after mock install
    const { drivePath } = await import('../path-generator.js');
    await drivePath(spec, harness);

    // Assert state transition trace
    const actualStates = getStateSequence(eventCap.trace);
    expect(actualStates).toEqual(spec.expectedStates);
  });
});
```

### Acceptance Criteria

- [ ] `pathGenerator.x1()` returns exactly 5 paths
- [ ] `pathGenerator.x2()` returns exactly 12 paths
- [ ] `pathGenerator.x3()` returns exactly 36 paths
- [ ] `pathGenerator.all()` returns exactly 53 paths
- [ ] Each path's `expectedStates` is mechanically derived from `symbols`
- [ ] Every test passes: actual state trace === expected state trace
- [ ] `drivePath()` correctly simulates each bridge/exit symbol
- [ ] All test files under 300 lines
- [ ] `pnpm test` passes
- [ ] `pnpm typecheck` passes

---

## Team Structure (Divide-and-Conquer / Wheel)

```
     observability
          |
harness — LEAD — scenarios
```

- **LEAD** (me): Create issues, spawn teammates, relay context, integrate, verify.
- **observability**: WS1 — LoopEventEmitter + instrumentation.
- **harness**: WS2 — MockHarness + ConsoleCapture.
- **scenarios**: WS3 — path-generator + data-driven tests. **Blocked by WS1 + WS2.**

### Dependencies

```
WS1 (observability) ──┐
                       ├──► WS3 (scenarios)
WS2 (harness) ────────┘
```

### Execution Order

1. Create 3 issues (WS3 blockedBy WS1 + WS2).
2. Spawn `observability` and `harness` in parallel.
3. When WS1 + WS2 complete, spawn `scenarios`.
4. Integrate, run full test suite, verify all 53 paths pass.

---

## Key Files Reference

| File | Role |
|------|------|
| `src/loop/state-machine.ts` | State machine runner — instrument for state_transition |
| `src/loop/states/*.ts` | 8 state handlers — instrument for specific events |
| `src/loop/triologue.ts` | Message management — instrument for compact/misorder |
| `src/engine/chat-provider.ts` | LLM facade — mock target for MockHarness |
| `src/tests/loop/esc-test-helpers.ts` | Existing helpers — reused by MockHarness |
| `src/tests/test-utils/mock-context.ts` | AgentContext mocks — used by MockHarness |
| `src/tests/test-utils/TESTING_STANDARDS.md` | Testing conventions |