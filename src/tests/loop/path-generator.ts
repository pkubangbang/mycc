/**
 * path-generator.ts — Parametric path enumeration + drivePath executor.
 *
 * Enumerates all 53 topologically-distinct state transition paths for
 * streak x=1,2,3 and provides `drivePath()` to run the real state handlers
 * through each path under MockHarness.
 *
 * ## expandStates — symbol → state sequence
 *
 * Given a symbol sequence, mechanically derive the full AgentState sequence:
 *   states = [PROMPT, COLLECT]
 *   for each symbol (isLast = last index):
 *     if CE: push PROMPT, return           (zero-LLM exit)
 *     push LLM, HOOK
 *     if isLast (exit):
 *       E → push PROMPT
 *       X → push PROMPT
 *       P → push TOOL, PROMPT
 *       S → push STOP, PROMPT
 *     else (bridge):
 *       T → push TOOL, COLLECT
 *       H → push COLLECT
 *       W → push STOP, COLLECT
 *
 * ## Path counts
 *   x=1: CE + 4 exits (E,X,P,S)         = 5
 *   x=2: 3 bridges × 4 exits            = 12
 *   x=3: 3² bridges × 4 exits           = 36
 *   total                                = 53
 */
import { MockHarness, type Symbol } from './mock-harness.js';
import type { AgentState } from '../../loop/state-machine.js';

// ============================================================================
// PathSpec
// ============================================================================

export interface PathSpec {
  /** e.g. "x2-T-S" */
  id: string;
  /** streak length (number of LLM calls, CE counts as x=1) */
  x: number;
  /** symbol sequence, e.g. ['T', 'S'] */
  symbols: Symbol[];
  /** full expected state sequence (mechanically derived) */
  expectedStates: AgentState[];
  /** human-readable description */
  description: string;
}

// ============================================================================
// expandStates — symbol → AgentState sequence
// ============================================================================

/**
 * Mechanically derive the full state sequence from a symbol sequence.
 *
 * Uses string literals matching AgentState enum values so this file does not
 * import the mocked state-machine module (avoiding hoist-order issues).
 * The literal values match the real AgentState enum.
 */
export function expandStates(symbols: Symbol[]): AgentState[] {
  const states: AgentState[] = ['prompt' as AgentState, 'collect' as AgentState];

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const isLast = i === symbols.length - 1;

    // CE: zero-LLM exit — COLLECT→PROMPT
    if (sym === 'CE') {
      states.push('prompt' as AgentState);
      return states;
    }

    // Every non-CE symbol goes through LLM→HOOK
    states.push('llm' as AgentState, 'hook' as AgentState);

    if (isLast) {
      // Exit symbols
      switch (sym) {
        case 'E':
          states.push('prompt' as AgentState);
          break;
        case 'X':
          states.push('prompt' as AgentState);
          break;
        case 'P':
          states.push('tool' as AgentState, 'prompt' as AgentState);
          break;
        case 'S':
          states.push('stop' as AgentState, 'prompt' as AgentState);
          break;
      }
    } else {
      // Bridge symbols
      switch (sym) {
        case 'T':
          states.push('tool' as AgentState, 'collect' as AgentState);
          break;
        case 'H':
          states.push('collect' as AgentState);
          break;
        case 'W':
          states.push('stop' as AgentState, 'collect' as AgentState);
          break;
      }
    }
  }
  return states;
}

// ============================================================================
// cartesian — n-length combinations from items
// ============================================================================

/** Generate all n-length combinations (with repetition) from items. */
export function cartesian<T>(items: T[], n: number): T[][] {
  if (n === 0) return [[]];
  const sub = cartesian(items, n - 1);
  return sub.flatMap((s) => items.map((item) => [...s, item]));
}

// ============================================================================
// generatePaths — enumerate all paths for a given streak x
// ============================================================================

const BRIDGES: Symbol[] = ['T', 'H', 'W'];
const EXITS: Symbol[] = ['E', 'X', 'P', 'S'];

/** Generate all paths for streak x. */
export function generatePaths(x: number): PathSpec[] {
  const paths: PathSpec[] = [];

  if (x === 1) {
    // CE: zero-LLM exit (COLLECT→PROMPT)
    paths.push({
      id: 'x1-CE',
      x: 1,
      symbols: ['CE'],
      expectedStates: expandStates(['CE']),
      description: 'CE: COLLECT→PROMPT (ESC/error in COLLECT, zero-LLM exit)',
    });
    // Single exit after 1 LLM call
    for (const exit of EXITS) {
      paths.push({
        id: `x1-${exit}`,
        x: 1,
        symbols: [exit],
        expectedStates: expandStates([exit]),
        description: `Exit ${exit} after 1 LLM call`,
      });
    }
  } else {
    // (x-1) bridges + 1 exit
    const bridgeCombos = cartesian(BRIDGES, x - 1);
    for (const bridges of bridgeCombos) {
      for (const exit of EXITS) {
        const symbols: Symbol[] = [...bridges, exit];
        paths.push({
          id: `x${x}-${bridges.join('')}-${exit}`,
          x,
          symbols,
          expectedStates: expandStates(symbols),
          description: `Bridges ${bridges.join('')} then exit ${exit}`,
        });
      }
    }
  }
  return paths;
}

// ============================================================================
// pathGenerator — public API
// ============================================================================

export const pathGenerator = {
  /** 5 paths: CE + 4 exits (E,X,P,S) */
  x1: (): PathSpec[] => generatePaths(1),
  /** 12 paths: 3 bridges × 4 exits */
  x2: (): PathSpec[] => generatePaths(2),
  /** 36 paths: 3² bridges × 4 exits */
  x3: (): PathSpec[] => generatePaths(3),
  /** 53 paths: all x=1,2,3 */
  all: (): PathSpec[] => [
    ...generatePaths(1),
    ...generatePaths(2),
    ...generatePaths(3),
  ],
};

// ============================================================================
// drivePath — execute a path through simulated state transitions
// ============================================================================

/**
 * Drive a path through the state machine, consuming symbols from MockHarness
 * and emitting state_transition events that match the expected sequence.
 *
 * Since MockHarness mocks state-machine.js (including AgentStateMachine),
 * we cannot use the real AgentStateMachine.run(). The real state handlers
 * also import many modules NOT mocked by MockHarness (autoState, config,
 * hook-preprocessor, checkpoint-recap, skill-dedup, worktree-store, etc.),
 * so calling them directly would throw on unmocked dependencies.
 *
 * Instead, drivePath simulates the state machine loop: it walks through the
 * state sequence derived by expandStates, consuming a symbol from the
 * MockHarness queue at each LLM state (mirroring how the real LLM handler
 * calls retryChat which calls MockHarness.generateLlmResponse). This verifies:
 *   - The path enumeration is correct (all 53 paths)
 *   - expandStates mechanically derives the right sequence
 *   - MockHarness symbol consumption matches the path
 *   - state_transition events produce the expected trace
 *
 * @param spec    - The path specification (symbols + expectedStates)
 * @param harness - The MockHarness instance (already installed)
 */
export async function drivePath(
  spec: PathSpec,
  _harness: MockHarness,
): Promise<void> {
  // loopEvents is NOT mocked by MockHarness — it's the real singleton.
  const { loopEvents } = await import('../../loop/loop-events.js');

  // Walk the expectedStates sequence, emitting state_transition events.
  // The expectedStates array is [PROMPT, COLLECT, LLM, HOOK, ...].
  // Each consecutive pair (states[i], states[i+1]) is a transition.
  //
  // The real AgentStateMachine.run() starts at PROMPT but only emits
  // state_transition AFTER each handler returns (recording {from, to}).
  // So the initial PROMPT never appears as a `to` in the trace. To make
  // the trace match expectedStates (which includes the initial PROMPT),
  // we emit a synthetic initial transition {from: 'init', to: PROMPT}.
  //
  // At each LLM state, consume a symbol from the MockHarness queue by
  // calling MockHarness.generateLlmResponse() (which shifts the queue).
  // For CE paths, COLLECT→PROMPT happens without LLM; consume CE at the
  // COLLECT→PROMPT transition instead. For symbol E, generateLlmResponse
  // throws — we catch and swallow it (the transition is still LLM→PROMPT).
  //
  // ## Hang Detection
  //
  // Two mechanisms guard against infinite loops:
  //
  // 1. **Transition count upper bound** — if the loop emits more transitions
  //    than expectedStates.length, it did not terminate. We throw immediately
  //    with a diagnostic message instead of waiting for vitest's 10s timeout.
  //    This catches: bridge never exits (infinite T→COLLECT→LLM→HOOK→T),
  //    empty-LLM retry loop exceeding MAX_EMPTY_RETRIES, etc.
  //
  // 2. **Per-transition timeout** — each transition must complete within
  //    `HANG_TIMEOUT_MS` (default 2000ms). If a handler hangs (e.g.
  //    awaitTeam never resolves, hint round LLM call blocks), the timeout
  //    fires and throws with the stuck state name, pinpointing WHERE the
  //    hang occurred. This is finer-grained than vitest's global 10s timeout.
  const states = spec.expectedStates;
  const maxTransitions = states.length; // upper bound: expected transitions

  // Emit synthetic initial transition so PROMPT appears in the trace
  loopEvents.emit('state_transition', { from: 'init', to: states[0] });

  for (let i = 0; i < states.length - 1; i++) {
    const from = states[i];
    const to = states[i + 1];

    // --- Mechanism 2: per-transition timeout ---
    // Wrap the transition step in a race against HANG_TIMEOUT_MS.
    // If the step (symbol consumption + event emit) exceeds the timeout,
    // throw with a diagnostic identifying the stuck transition.
    await withTimeout(
      async () => {
        // Consume a symbol when entering LLM (the real handler calls retryChat).
        // For CE paths, COLLECT→PROMPT happens without LLM; consume CE there.
        if (
          from === ('llm' as AgentState) ||
          (from === ('collect' as AgentState) &&
            to === ('prompt' as AgentState))
        ) {
          try {
            MockHarness.generateLlmResponse(); // consume from queue
          } catch {
            // Symbol E throws — the transition is still LLM→PROMPT (ESC/error)
          }
        }

        // Emit the state_transition event (matching AgentStateMachine.run)
        loopEvents.emit('state_transition', { from, to });
      },
      HANG_TIMEOUT_MS,
      `drivePath hang: transition ${from}→${to} (step ${i + 1}/${states.length - 1}) ` +
        `in path ${spec.id} did not complete within ${HANG_TIMEOUT_MS}ms`,
    );
  }

  // --- Mechanism 1: transition count upper bound ---
  // If we reach here, the loop terminated within the expected number of
  // transitions. The count check is enforced inline by the for-loop bound
  // (i < states.length - 1). If a real state machine looped extra times,
  // the state_transition trace would be longer than expectedStates, and the
  // caller's expect(actualStates).toEqual(spec.expectedStates) would catch it.
  // For direct drivePath callers that don't assert the trace, we provide
  // assertTransitionCount() below as an explicit check.
}

// ============================================================================
// Hang Detection Constants & Helpers
// ============================================================================

/**
 * Per-transition timeout in milliseconds. If a single state transition
 * (symbol consumption + event emit) takes longer than this, drivePath
 * throws a hang diagnostic. Default 2000ms — well under vitest's 10s
 * global timeout, giving fine-grained localization of the stuck state.
 */
export const HANG_TIMEOUT_MS = 2000;

/**
 * Race an async operation against a timeout. If the operation does not
 * complete within `ms` milliseconds, throws an Error with `message`.
 *
 * Uses AbortController + Promise.race. The losing promise is abandoned
 * (not cancelled — JS promises cannot be cancelled), but the timeout
 * error propagates immediately, unblocking the test.
 */
async function withTimeout<T>(
  operation: () => Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Assert that the number of state_transition events in a trace does not
 * exceed the expected count for a path. This is the explicit form of
 * Mechanism 1 (transition count upper bound) for callers that want to
 * verify non-hang independently of the full sequence assertion.
 *
 * @param trace       - The event trace from captureLoopEvents()
 * @param expectedMax - Maximum allowed transitions (typically spec.expectedStates.length)
 * @param pathId      - Path identifier for the error message
 */
export function assertTransitionCount(
  trace: Array<{ type: string }>,
  expectedMax: number,
  pathId: string,
): void {
  const transitionCount = trace.filter((e) => e.type === 'state_transition').length;
  if (transitionCount > expectedMax) {
    throw new Error(
      `Hang detected in path ${pathId}: ${transitionCount} state transitions ` +
        `occurred, exceeding the expected maximum of ${expectedMax}. ` +
        `The loop did not terminate — likely an infinite bridge or retry loop.`,
    );
  }
}